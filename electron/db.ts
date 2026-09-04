import { isProjectPath } from "../shared/project-path";
export { isProjectPath };

// CORTEX — better-sqlite3 data layer (runs inside Electron main process ONLY)
import Database from 'better-sqlite3';
import { EventEmitter } from 'node:events';
import { randomBytes } from 'node:crypto';
import * as fs from 'node:fs';
import * as path from 'node:path';
import type { CortexBackend } from './mcp-tools';
import { chatOnce, decryptApiKey } from './ai';
import { scanText } from './librarian';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface NoteListItem {
  path: string;
  title: string;
  tags: string[];
  mtime: number;
  size: number;
}

export interface NoteFull {
  path: string;
  title: string;
  content: string;
  tags: string[];
  links: string[];
  backlinks: string[];
  mtime: number;
  ctime: number;
}

export interface Task {
  id: string;
  text: string;
  assignee: string | null;
  status: string;
  position: number;
  created: number;
  updated: number;
  /** Vault-relative path of a Projects/*.md note this task belongs to, or null. */
  project: string | null;
}

export interface SearchMatch {
  line: number;
  text: string;
}

export interface SearchResult {
  path: string;
  title: string;
  matches: SearchMatch[];
}

export interface ActivityRow {
  ts: string;
  agent: string;
  action: string;
  path: string | null;
  detail: string | null;
}

interface NoteRow {
  path: string;
  title: string;
  content: string;
  tags: string;
  ctime: number;
  mtime: number;
}

const TASK_STATUSES = ['TODO', 'IN PROGRESS', 'REVIEW', 'DONE'] as const;

// ---------------------------------------------------------------------------
// Module state
// ---------------------------------------------------------------------------

export const dbEvents = new EventEmitter();

let db: Database.Database | null = null;
let dbPath = '';
let ftsAvailable = false;

export function conn(): Database.Database {
  if (!db) throw new Error('database not initialized');
  return db;
}

export function getDbPath(): string {
  return dbPath;
}

export function emitChange(type: 'vault' | 'tasks' | 'activity' | 'protocol' | 'orchestrator'): void {
  dbEvents.emit('change', { type });
}

// ---------------------------------------------------------------------------
// initDb
// ---------------------------------------------------------------------------

export function initDb(filePath: string, seedDir: string | null): void {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  db = new Database(filePath);
  dbPath = filePath;
  db.pragma('journal_mode = WAL');
  // Required for orchestrator_audit_log's ON DELETE CASCADE to actually fire:
  // SQLite defaults this OFF, so without it deleting a task orphans its audit
  // rows. Verified safe — no other table declares a foreign key.
  db.pragma('foreign_keys = ON');

  db.exec(`
    CREATE TABLE IF NOT EXISTS notes(
      path TEXT PRIMARY KEY,
      title TEXT NOT NULL,
      content TEXT NOT NULL DEFAULT '',
      tags TEXT NOT NULL DEFAULT '[]',
      ctime INTEGER,
      mtime INTEGER
    );
    CREATE TABLE IF NOT EXISTS links(
      src TEXT,
      dst TEXT,
      PRIMARY KEY(src, dst)
    );
    CREATE TABLE IF NOT EXISTS tasks(
      id TEXT PRIMARY KEY,
      text TEXT,
      assignee TEXT,
      status TEXT,
      position INTEGER,
      created INTEGER,
      updated INTEGER,
      project TEXT
    );
    CREATE TABLE IF NOT EXISTS activity(
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      ts INTEGER,
      agent TEXT,
      action TEXT,
      path TEXT,
      detail TEXT
    );
    CREATE TABLE IF NOT EXISTS settings(
      key TEXT PRIMARY KEY,
      value TEXT
    );
    CREATE TABLE IF NOT EXISTS protocol(
      id TEXT PRIMARY KEY,
      kind TEXT NOT NULL,
      title TEXT NOT NULL,
      body TEXT NOT NULL DEFAULT '',
      enabled INTEGER NOT NULL DEFAULT 1,
      position INTEGER,
      created INTEGER,
      updated INTEGER
    );
    -- Semantic search index: one row per note CHUNK (a whole long note as a
    -- single vector loses meaning). \`model\` records which embedding model +
    -- prefix produced the vector, so changing models invalidates stale rows.
    CREATE TABLE IF NOT EXISTS embeddings(
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      path TEXT NOT NULL,
      chunk_idx INTEGER NOT NULL,
      snippet TEXT NOT NULL,
      vec BLOB NOT NULL,
      dim INTEGER NOT NULL,
      model TEXT NOT NULL,
      mtime INTEGER NOT NULL
    );
    CREATE INDEX IF NOT EXISTS embeddings_path ON embeddings(path);

    -- ---------------------------------------------------------------------
    -- Multi-agent orchestrator pipeline: a task flows planner -> coder ->
    -- [security] -> [qa] -> planner(final review), each hop handled by a
    -- (possibly different) external AI agent claiming work over MCP.
    -- ---------------------------------------------------------------------
    CREATE TABLE IF NOT EXISTS orchestrator_pipeline_config(
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      role_key TEXT NOT NULL UNIQUE,
      display_name TEXT NOT NULL,
      is_required INTEGER NOT NULL DEFAULT 0,
      is_enabled INTEGER NOT NULL DEFAULT 1,
      assigned_agent TEXT NOT NULL,
      model TEXT NOT NULL DEFAULT '',
      auto_advance INTEGER NOT NULL DEFAULT 1,
      position INTEGER NOT NULL DEFAULT 0,
      default_skills TEXT NOT NULL DEFAULT '[]'
    );
    CREATE TABLE IF NOT EXISTS orchestrator_tasks(
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      title TEXT NOT NULL,
      description TEXT NOT NULL,
      current_role TEXT NOT NULL DEFAULT 'planner',
      status TEXT NOT NULL DEFAULT 'PLANNING',
      assigned_agent TEXT NOT NULL,
      context_files TEXT,
      diff_payload TEXT,
      feedback TEXT,
      execution_mode TEXT NOT NULL DEFAULT 'auto',
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL,
      -- Additive columns (not in the original spec) that the state machine
      -- cannot work without; see the notes on each below.
      claimed_by TEXT,          -- which agent instance holds it (double-claim guard)
      claimed_at INTEGER,       -- for detecting an agent that claimed and died
      gate_pending INTEGER NOT NULL DEFAULT 0, -- manual gate: needs a human click to advance
      pending_role TEXT,        -- the role the gate would release it to
      pending_status TEXT,      -- the status the gate would release it to
      reject_count INTEGER NOT NULL DEFAULT 0, -- bounds coder<->reviewer ping-pong
      project TEXT,             -- optional link to a Projects/*.md note
      auto_blocked INTEGER NOT NULL DEFAULT 0, -- 1 if auto-wakeup was cancelled
      skills TEXT NOT NULL DEFAULT '[]',
      coder_agent TEXT NOT NULL DEFAULT '',
      coder_model TEXT NOT NULL DEFAULT '',
      reviewer_agent TEXT NOT NULL DEFAULT '',
      reviewer_model TEXT NOT NULL DEFAULT ''
    );
    CREATE INDEX IF NOT EXISTS orch_tasks_role_status
      ON orchestrator_tasks(current_role, status);
    CREATE TABLE IF NOT EXISTS orchestrator_audit_log(
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      task_id INTEGER NOT NULL,
      role_key TEXT NOT NULL,
      agent_name TEXT NOT NULL,
      action TEXT NOT NULL,
      comment TEXT,
      timestamp INTEGER NOT NULL,
      FOREIGN KEY (task_id) REFERENCES orchestrator_tasks(id) ON DELETE CASCADE
    );
    CREATE INDEX IF NOT EXISTS orch_audit_task ON orchestrator_audit_log(task_id);
    
    CREATE TABLE IF NOT EXISTS skill_sources(
      id TEXT PRIMARY KEY, kind TEXT NOT NULL, repo TEXT NOT NULL DEFAULT '',
      ref TEXT NOT NULL DEFAULT '', local_path TEXT NOT NULL DEFAULT '',
      license TEXT NOT NULL DEFAULT '', license_text TEXT NOT NULL DEFAULT '',
      plugin_json TEXT NOT NULL DEFAULT '', author TEXT NOT NULL DEFAULT '',
      imported_at INTEGER, builtin INTEGER NOT NULL DEFAULT 0);

    CREATE TABLE IF NOT EXISTS skills(
      id TEXT PRIMARY KEY, source_id TEXT NOT NULL, name TEXT NOT NULL,
      description TEXT NOT NULL, rel_dir TEXT NOT NULL, body_hash TEXT NOT NULL,
      bytes INTEGER NOT NULL, enabled INTEGER NOT NULL DEFAULT 1,
      pinned_role TEXT NOT NULL DEFAULT '', position INTEGER, updated INTEGER);
    CREATE UNIQUE INDEX IF NOT EXISTS skills_src_name ON skills(source_id, name);

    CREATE TABLE IF NOT EXISTS skill_files(
      skill_id TEXT NOT NULL, rel_path TEXT NOT NULL, content BLOB NOT NULL,
      bytes INTEGER NOT NULL, hash TEXT NOT NULL, version INTEGER NOT NULL DEFAULT 1,
      updated INTEGER, PRIMARY KEY(skill_id, rel_path));

    CREATE TABLE IF NOT EXISTS skill_file_versions(
      skill_id TEXT NOT NULL, rel_path TEXT NOT NULL, version INTEGER NOT NULL,
      content BLOB NOT NULL, hash TEXT NOT NULL, created INTEGER,
      PRIMARY KEY(skill_id, rel_path, version));

    CREATE TABLE IF NOT EXISTS dispatch_launches(
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      task_id INTEGER NOT NULL,
      conversation_id TEXT,
      role_key TEXT NOT NULL,
      launched_at INTEGER NOT NULL,
      status TEXT NOT NULL,
      FOREIGN KEY (task_id) REFERENCES orchestrator_tasks(id) ON DELETE CASCADE
    );
  `);

  // Migration: existing DBs predate the tasks.project column — add it in place.
  const taskCols = db.prepare('PRAGMA table_info(tasks)').all() as { name: string }[];
  if (!taskCols.some((c) => c.name === 'project')) {
    db.exec('ALTER TABLE tasks ADD COLUMN project TEXT');
  }

  // Same pattern for the orchestrator's additive columns, so a DB created by an
  // earlier build of this feature upgrades in place.
  const orchCols = new Set(
    (db.prepare('PRAGMA table_info(orchestrator_tasks)').all() as { name: string }[]).map((c) => c.name)
  );
  for (const [col, decl] of [
    ['claimed_by', 'TEXT'],
    ['claimed_at', 'INTEGER'],
    ['gate_pending', 'INTEGER NOT NULL DEFAULT 0'],
    ['pending_role', 'TEXT'],
    ['pending_status', 'TEXT'],
    ['reject_count', 'INTEGER NOT NULL DEFAULT 0'],
    ['project', 'TEXT'],
    ['auto_blocked', 'INTEGER NOT NULL DEFAULT 0'],
    ['seq', 'INTEGER'],
    ['skills', "TEXT NOT NULL DEFAULT '[]'"],
    // Per-task user choice; overrides the global pipeline config.
    ['coder_agent', "TEXT NOT NULL DEFAULT ''"],
    ['coder_model', "TEXT NOT NULL DEFAULT ''"],
    ['reviewer_agent', "TEXT NOT NULL DEFAULT ''"],
    ['reviewer_model', "TEXT NOT NULL DEFAULT ''"],
  ] as const) {
    if (orchCols.size > 0 && !orchCols.has(col)) {
      db.exec(`ALTER TABLE orchestrator_tasks ADD COLUMN ${col} ${decl}`);
    }
  }

  const dlCols = new Set(
    (db.prepare('PRAGMA table_info(dispatch_launches)').all() as { name: string }[]).map((c) => c.name)
  );
  if (dlCols.size > 0 && !dlCols.has('error')) {
    db.exec('ALTER TABLE dispatch_launches ADD COLUMN error TEXT');
  }

  const cfgCols = new Set(
    (db.prepare('PRAGMA table_info(orchestrator_pipeline_config)').all() as { name: string }[]).map((c) => c.name)
  );
  if (cfgCols.size > 0 && !cfgCols.has('position')) {
    db.exec('ALTER TABLE orchestrator_pipeline_config ADD COLUMN position INTEGER NOT NULL DEFAULT 0');
  }
  if (cfgCols.size > 0 && !cfgCols.has('auto_dispatch')) {
    db.exec('ALTER TABLE orchestrator_pipeline_config ADD COLUMN auto_dispatch INTEGER NOT NULL DEFAULT 1');
  }
  if (cfgCols.size > 0 && !cfgCols.has('default_skills')) {
    db.exec("ALTER TABLE orchestrator_pipeline_config ADD COLUMN default_skills TEXT NOT NULL DEFAULT '[]'");
  }
  if (cfgCols.size > 0 && !cfgCols.has('model')) {
    db.exec("ALTER TABLE orchestrator_pipeline_config ADD COLUMN model TEXT NOT NULL DEFAULT ''");
  }


  const skillSourcesCols = new Set(
    (db.prepare('PRAGMA table_info(skill_sources)').all() as { name: string }[]).map((c) => c.name)
  );
  for (const [col, decl] of [
    ['plugin_json', "TEXT NOT NULL DEFAULT ''"],
    ['author', "TEXT NOT NULL DEFAULT ''"],
    ['builtin', 'INTEGER NOT NULL DEFAULT 0'],
    ['imported_at', 'INTEGER']
  ] as const) {
    if (skillSourcesCols.size > 0 && !skillSourcesCols.has(col)) {
      db.exec(`ALTER TABLE skill_sources ADD COLUMN ${col} ${decl}`);
    }
  }

  const skillsCols = new Set(
    (db.prepare('PRAGMA table_info(skills)').all() as { name: string }[]).map((c) => c.name)
  );
  for (const [col, decl] of [
    ['enabled', 'INTEGER NOT NULL DEFAULT 1'],
    ['pinned_role', "TEXT NOT NULL DEFAULT ''"],
    ['position', 'INTEGER'],
    ['updated', 'INTEGER']
  ] as const) {
    if (skillsCols.size > 0 && !skillsCols.has(col)) {
      db.exec(`ALTER TABLE skills ADD COLUMN ${col} ${decl}`);
    }
  }

  const skillFilesCols = new Set(
    (db.prepare('PRAGMA table_info(skill_files)').all() as { name: string }[]).map((c) => c.name)
  );
  if (skillFilesCols.size > 0 && !skillFilesCols.has('updated')) {
    db.exec('ALTER TABLE skill_files ADD COLUMN updated INTEGER');
  }

  const m39Guard = db.prepare("SELECT value FROM settings WHERE key = 'migration_39_run'").get() as {value: string} | undefined;
  if (!m39Guard || m39Guard.value !== '1') {
    const flatNotes = db.prepare("SELECT path FROM notes WHERE path LIKE 'Projects/%' AND path NOT LIKE 'Projects/%/%'").all() as {path: string}[];
    for (const note of flatNotes) {
      const oldPath = note.path;
      if (!oldPath.endsWith('.md')) continue;
      const nameWithExt = oldPath.substring(9);
      const name = nameWithExt.substring(0, nameWithExt.length - 3);
      let x = name;
      let y = name;
      if (name.includes(' - ')) {
        const parts = name.split(' - ');
        x = parts[0];
        y = parts.slice(1).join(' - ');
      }
      const newPath = `Projects/${x}/${y}.md`;
      if (oldPath === newPath) continue;
      
      try {
        renameNote(oldPath, newPath, 'system');
        db.prepare("UPDATE settings SET value = ? WHERE key = 'active_project' AND value = ?").run(newPath, oldPath);
        db.prepare("UPDATE tasks SET project = ? WHERE project = ?").run(newPath, oldPath);
        db.prepare("UPDATE orchestrator_tasks SET project = ? WHERE project = ?").run(newPath, oldPath);
        db.prepare("INSERT INTO activity (ts, agent, action, path, detail) VALUES (?, ?, ?, ?, ?)").run(
          Date.now(), 'system', 'migrate_project_path', newPath, `Migrated ${oldPath} to ${newPath}`
        );
      } catch (e) {
        db.prepare("INSERT INTO activity (ts, agent, action, path, detail) VALUES (?, ?, ?, ?, ?)").run(
          Date.now(), 'system', 'migrate_project_path_error', oldPath, `Conflict or error migrating to ${newPath}: ${(e as Error).message}`
        );
      }
    }

    const vulpinePath = 'Projects/vulpine/vulpine.md';
    const vulpineExists = db.prepare("SELECT path FROM notes WHERE path = ?").get(vulpinePath);
    if (!vulpineExists) {
      db.prepare("INSERT INTO notes (path, title, content, tags, ctime, mtime) VALUES (?, ?, ?, ?, ?, ?)").run(
        vulpinePath, 'vulpine', 'Migrated project gateway.', '[]', Date.now(), Date.now()
      );
    }
    
    // Assign orphan tasks
    const vulpineTasks = db.prepare("SELECT id, created FROM tasks WHERE project = '' OR project IS NULL").all() as {id: string, created: number}[];
    let migratedCount = 0;
    for (const t of vulpineTasks) {
       const d = new Date(t.created);
       const dateStr = `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, '0')}-${String(d.getUTCDate()).padStart(2, '0')}`;
       if (dateStr === '2026-07-11') {
          db.prepare("UPDATE tasks SET project = ? WHERE id = ?").run(vulpinePath, t.id);
          migratedCount++;
       }
    }
    db.prepare("INSERT INTO activity (ts, agent, action, path, detail) VALUES (?, ?, ?, ?, ?)").run(
      Date.now(), 'system', 'migrate_orphan_tasks', vulpinePath, `Assigned ${migratedCount} orphan tasks to vulpine`
    );
    
    db.prepare("INSERT OR REPLACE INTO settings (key, value) VALUES ('migration_39_run', '1')").run();
  }
  
  const m79Guard = db.prepare("SELECT value FROM settings WHERE key = 'migration_79_run'").get() as {value: string} | undefined;
  if (!m79Guard || m79Guard.value !== '1') {
    const completedTasks = db.prepare("SELECT id FROM orchestrator_tasks WHERE status = 'COMPLETED' ORDER BY created_at ASC, id ASC").all() as {id: number}[];
    const updateSeq = db.prepare("UPDATE orchestrator_tasks SET seq = ? WHERE id = ?");
    const txn = db.transaction(() => {
      let currentSeq = 1;
      for (const t of completedTasks) {
        updateSeq.run(currentSeq++, t.id);
      }
      db!.prepare("INSERT OR REPLACE INTO settings (key, value) VALUES ('migration_79_run', '1')").run();
    });
    txn();
  }

  const m99Guard = db.prepare("SELECT value FROM settings WHERE key = 'migration_99_run'").get() as {value: string} | undefined;
  if (!m99Guard || m99Guard.value !== '1') {
    const txn = db.transaction(() => {
      const updateDef = db!.prepare("UPDATE orchestrator_pipeline_config SET default_skills = ? WHERE role_key = ?");
      updateDef.run(JSON.stringify(["implement", "tdd"]), 'coder');
      updateDef.run(JSON.stringify(["code-review"]), 'security');
      updateDef.run(JSON.stringify(["to-spec"]), 'planner');
      updateDef.run(JSON.stringify([]), 'qa');
      db!.prepare("INSERT OR REPLACE INTO settings (key, value) VALUES ('migration_99_run', '1')").run();
    });
    txn();
  }

  seedPipelineConfig();

  // FTS5 full-text index over title + content, kept in sync via triggers.
  // path is UNINDEXED (identifier only) so folder names don't cause false matches.
  try {
    const ftsDef = db
      .prepare("SELECT sql FROM sqlite_master WHERE type='table' AND name='notes_fts'")
      .get() as { sql?: string } | undefined;
    const rebuild = Boolean(ftsDef?.sql && !/path\s+UNINDEXED/i.test(ftsDef.sql));
    if (rebuild) {
      db.exec(`
        DROP TRIGGER IF EXISTS notes_fts_ai;
        DROP TRIGGER IF EXISTS notes_fts_ad;
        DROP TRIGGER IF EXISTS notes_fts_au;
        DROP TABLE IF EXISTS notes_fts;
      `);
    }
    db.exec(`
      CREATE VIRTUAL TABLE IF NOT EXISTS notes_fts USING fts5(path UNINDEXED, title, content);
      CREATE TRIGGER IF NOT EXISTS notes_fts_ai AFTER INSERT ON notes BEGIN
        INSERT INTO notes_fts(path, title, content) VALUES (new.path, new.title, new.content);
      END;
      CREATE TRIGGER IF NOT EXISTS notes_fts_ad AFTER DELETE ON notes BEGIN
        DELETE FROM notes_fts WHERE path = old.path;
      END;
      CREATE TRIGGER IF NOT EXISTS notes_fts_au AFTER UPDATE ON notes BEGIN
        DELETE FROM notes_fts WHERE path = old.path;
        INSERT INTO notes_fts(path, title, content) VALUES (new.path, new.title, new.content);
      END;
    `);
    if (rebuild) {
      db.exec('INSERT INTO notes_fts(path, title, content) SELECT path, title, content FROM notes;');
    }
    ftsAvailable = true;
  } catch (err) {
    ftsAvailable = false;
    console.error('[cortex] FTS5 unavailable, falling back to LIKE search:', err);
  }

  // Seed on first run only.
  try {
    seed(seedDir);
  } catch (err) {
    console.error('[cortex] seeding failed (continuing to boot):', err);
  }
}

function seed(seedDir: string | null): void {
  if (!seedDir || !fs.existsSync(seedDir)) return;
  const d = conn();

  /* A note count of zero is the wrong test: the orphan-task migration inserts a
     placeholder note before this runs, so on a genuinely fresh install the count
     was already 1 and the whole starter vault silently never seeded. Track the
     seeding itself instead. */
  const seededGuard = d
    .prepare("SELECT value FROM settings WHERE key = 'vault_seeded'")
    .get() as { value: string } | undefined;
  if (seededGuard?.value !== '1') {
    const files: string[] = [];
    const walk = (dir: string): void => {
      for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
        const full = path.join(dir, entry.name);
        if (entry.isDirectory()) walk(full);
        else if (entry.isFile() && entry.name.toLowerCase().endsWith('.md')) files.push(full);
      }
    };
    walk(seedDir);
    files.sort();
    for (const file of files) {
      try {
        const rel = path.relative(seedDir, file).split(path.sep).join('/');
        const content = fs.readFileSync(file, 'utf8');
        writeNote(rel, content, 'system');
      } catch (err) {
        console.error('[cortex] failed to seed note:', file, err);
      }
    }
    recomputeAllLinks();
    d.prepare("INSERT OR REPLACE INTO settings (key, value) VALUES ('vault_seeded', '1')").run();
  }

  const taskCount = (d.prepare('SELECT COUNT(*) AS n FROM tasks').get() as { n: number }).n;
  const tasksFile = path.join(seedDir, 'tasks.json');
  if (taskCount === 0 && fs.existsSync(tasksFile)) {
    try {
      const parsed = JSON.parse(fs.readFileSync(tasksFile, 'utf8'));
      if (Array.isArray(parsed)) {
        for (const t of parsed) {
          if (t && typeof t.text === 'string') {
            addTask({ text: t.text, assignee: t.assignee, status: t.status, agent: 'system' });
          }
        }
      }
    } catch (err) {
      console.error('[cortex] failed to seed tasks:', err);
    }
  }

  const protoCount = (d.prepare('SELECT COUNT(*) AS n FROM protocol').get() as { n: number }).n;
  const templateCount = (d.prepare("SELECT COUNT(*) AS n FROM protocol WHERE kind = 'template'").get() as {
    n: number;
  }).n;
  const protoFile = path.join(seedDir, 'protocol.json');
  if (fs.existsSync(protoFile)) {
    try {
      const parsed = JSON.parse(fs.readFileSync(protoFile, 'utf8'));
      if (Array.isArray(parsed)) {
        for (const p of parsed) {
          if (!p || typeof p.title !== 'string') continue;
          if (p.kind !== 'rule' && p.kind !== 'skill' && p.kind !== 'template') continue;
          // Rules/skills seed only on a fresh table; templates backfill whenever
          // none exist yet (so upgrades that predate templates still get them).
          const shouldSeed = p.kind === 'template' ? templateCount === 0 : protoCount === 0;
          if (!shouldSeed) continue;
          addProtocol({
            kind: p.kind,
            title: p.title,
            body: typeof p.body === 'string' ? p.body : '',
            enabled: p.enabled !== false,
            agent: 'system',
          });
        }
      }
    } catch (err) {
      console.error('[cortex] failed to seed protocol:', err);
    }
  }
}

// ---------------------------------------------------------------------------
// Path / frontmatter / tag / link helpers
// ---------------------------------------------------------------------------

function normalizePath(p: string): string {
  // NFC so composed/decomposed Arabic (and other) forms map to one canonical row.
  let out = String(p ?? '').trim().normalize('NFC').replace(/\\/g, '/');
  if (out.length === 0 || out.startsWith('/')) throw new Error('invalid path');
  const segments = out.split('/').filter((s) => s.trim() !== '' && s !== '.');
  if (segments.length === 0 || segments.some((s) => s === '..')) {
    throw new Error('invalid path');
  }
  out = segments.map((s) => s.trim()).join('/');
  if (!out.toLowerCase().endsWith('.md')) out += '.md';
  return out;
}

function stripQuotes(s: string): string {
  const t = s.trim();
  if (t.length >= 2 && ((t.startsWith('"') && t.endsWith('"')) || (t.startsWith("'") && t.endsWith("'")))) {
    return t.slice(1, -1).trim();
  }
  return t;
}

interface Frontmatter {
  title: string | null;
  tags: string[];
  body: string;
}

function parseFrontmatter(content: string): Frontmatter {
  const result: Frontmatter = { title: null, tags: [], body: content };
  const lines = content.split(/\r?\n/);
  if (lines.length === 0 || lines[0].trim() !== '---') return result;

  let end = -1;
  for (let i = 1; i < lines.length; i++) {
    if (lines[i].trim() === '---') { end = i; break; }
  }
  if (end === -1) return result;

  const fm = lines.slice(1, end);
  result.body = lines.slice(end + 1).join('\n');

  for (let i = 0; i < fm.length; i++) {
    const line = fm[i];
    const titleMatch = line.match(/^title:\s*(.*)$/);
    if (titleMatch && result.title === null) {
      const v = stripQuotes(titleMatch[1]);
      if (v.length > 0) result.title = v;
      continue;
    }
    const tagsMatch = line.match(/^tags:\s*(.*)$/);
    if (tagsMatch) {
      const rest = tagsMatch[1].trim();
      if (rest.startsWith('[')) {
        // YAML inline list: tags: [a, b, "c, with comma"] — quote-aware split.
        const inner = rest.replace(/^\[/, '').replace(/\]\s*$/, '');
        const items = inner.match(/"[^"]*"|'[^']*'|[^,]+/g) ?? [];
        for (const part of items) {
          const tag = stripQuotes(part).replace(/^#/, '');
          if (tag) result.tags.push(tag);
        }
      } else if (rest.length === 0) {
        // YAML dash list on following lines
        for (let j = i + 1; j < fm.length; j++) {
          const dash = fm[j].match(/^\s*-\s*(.+)$/);
          if (!dash) break;
          const tag = stripQuotes(dash[1]).replace(/^#/, '');
          if (tag) result.tags.push(tag);
        }
      } else {
        // comma-separated string
        for (const part of rest.split(',')) {
          const tag = stripQuotes(part).replace(/^#/, '');
          if (tag) result.tags.push(tag);
        }
      }
    }
  }
  return result;
}

// Fenced ``` blocks and inline `code` are stripped before scanning for inline
// tags, matching Obsidian (which never tags inside code). Hex color codes like
// #FFB300 / #34f5c5 are excluded, and a real tag must contain a non-digit
// (so #10 or #333 are not tags) — again matching Obsidian's tag rules.
function stripCode(text: string): string {
  return text
    .replace(/```[\s\S]*?```/g, ' ')
    .replace(/~~~[\s\S]*?~~~/g, ' ')
    .replace(/`[^`]*`/g, ' ');
}

function isHexColor(tok: string): boolean {
  return /^[0-9a-fA-F]{3}$/.test(tok) || /^[0-9a-fA-F]{4}$/.test(tok) ||
    /^[0-9a-fA-F]{6}$/.test(tok) || /^[0-9a-fA-F]{8}$/.test(tok);
}

function extractTags(content: string): string[] {
  const fm = parseFrontmatter(content);
  const tags = [...fm.tags];
  const body = stripCode(fm.body);
  const inlineRe = /(^|\s)#([\p{L}\p{N}_-]{2,})/gu;
  let m: RegExpExecArray | null;
  while ((m = inlineRe.exec(body)) !== null) {
    const tok = m[2];
    if (isHexColor(tok)) continue; // #FFB300, #333 → color, not a tag
    if (!/[\p{L}_-]/u.test(tok)) continue; // must have a non-digit char
    tags.push(tok);
  }
  const seen = new Set<string>();
  const out: string[] = [];
  for (const t of tags) {
    const key = t.toLowerCase();
    if (!seen.has(key)) { seen.add(key); out.push(t); }
  }
  return out;
}

function deriveTitle(notePath: string, content: string): string {
  const fm = parseFrontmatter(content);
  if (fm.title) return fm.title;
  const base = notePath.split('/').pop() ?? notePath;
  return base.replace(/\.md$/i, '');
}

function extractWikiTargets(content: string): string[] {
  const re = /\[\[([^\]|]+)(?:\|[^\]]*)?\]\]/g;
  const out: string[] = [];
  let m: RegExpExecArray | null;
  while ((m = re.exec(content)) !== null) {
    const t = m[1].trim();
    if (t) out.push(t);
  }
  return out;
}

/** Resolve a wiki-link target to an existing note path, or null. */
function resolveTarget(
  target: string,
  pathSet: Set<string>,
  byTitle: Map<string, string>,
  byFilename: Map<string, string>
): string | null {
  const t = target.replace(/\\/g, '/').trim();
  if (pathSet.has(t)) return t;
  if (pathSet.has(t + '.md')) return t + '.md';
  const lower = t.toLowerCase();
  const byT = byTitle.get(lower);
  if (byT) return byT;
  const byF = byFilename.get(lower.replace(/\.md$/, ''));
  if (byF) return byF;
  return null;
}

function buildResolutionMaps(): {
  pathSet: Set<string>;
  byTitle: Map<string, string>;
  byFilename: Map<string, string>;
} {
  const rows = conn().prepare('SELECT path, title FROM notes').all() as { path: string; title: string }[];
  const pathSet = new Set<string>();
  const byTitle = new Map<string, string>();
  const byFilename = new Map<string, string>();
  for (const r of rows) {
    pathSet.add(r.path);
    const tKey = r.title.toLowerCase();
    if (!byTitle.has(tKey)) byTitle.set(tKey, r.path);
    const fname = (r.path.split('/').pop() ?? r.path).replace(/\.md$/i, '').toLowerCase();
    if (!byFilename.has(fname)) byFilename.set(fname, r.path);
  }
  return { pathSet, byTitle, byFilename };
}

function recomputeLinksFor(notePath: string, content: string): void {
  const d = conn();
  const maps = buildResolutionMaps();
  d.prepare('DELETE FROM links WHERE src = ?').run(notePath);
  const ins = d.prepare('INSERT OR IGNORE INTO links(src, dst) VALUES (?, ?)');
  for (const target of extractWikiTargets(content)) {
    const dst = resolveTarget(target, maps.pathSet, maps.byTitle, maps.byFilename);
    if (dst && dst !== notePath) ins.run(notePath, dst);
  }
}

function recomputeAllLinks(): void {
  const d = conn();
  const maps = buildResolutionMaps();
  d.prepare('DELETE FROM links').run();
  const ins = d.prepare('INSERT OR IGNORE INTO links(src, dst) VALUES (?, ?)');
  const rows = d.prepare('SELECT path, content FROM notes').all() as { path: string; content: string }[];
  for (const row of rows) {
    for (const target of extractWikiTargets(row.content)) {
      const dst = resolveTarget(target, maps.pathSet, maps.byTitle, maps.byFilename);
      if (dst && dst !== row.path) ins.run(row.path, dst);
    }
  }
}

// ---------------------------------------------------------------------------
// Mirror (Obsidian-readable copy of the vault)
// ---------------------------------------------------------------------------

function mirrorSettings(): { enabled: boolean; dir: string } {
  const s = getSettings();
  return { enabled: s.mirror_enabled, dir: s.mirror_path };
}

function mirrorWriteFile(dir: string, notePath: string, content: string): void {
  const full = path.join(dir, ...notePath.split('/'));
  fs.mkdirSync(path.dirname(full), { recursive: true });
  fs.writeFileSync(full, content, 'utf8');
}

function mirrorAfterWrite(notePath: string, content: string): void {
  try {
    const { enabled, dir } = mirrorSettings();
    if (enabled && dir) mirrorWriteFile(dir, notePath, content);
  } catch (err) {
    console.error('[cortex] mirror write failed:', err);
  }
}

function mirrorAfterDelete(notePath: string): void {
  try {
    const { enabled, dir } = mirrorSettings();
    if (!enabled || !dir) return;
    const full = path.join(dir, ...notePath.split('/'));
    if (fs.existsSync(full)) fs.unlinkSync(full);
  } catch (err) {
    console.error('[cortex] mirror delete failed:', err);
  }
}

export function mirrorSync(): { exported: number; path: string } {
  const s = getSettings();
  if (!s.mirror_enabled || !s.mirror_path) return { exported: 0, path: s.mirror_path };
  let exported = 0;
  const rows = conn().prepare('SELECT path, content FROM notes').all() as { path: string; content: string }[];
  for (const row of rows) {
    try {
      mirrorWriteFile(s.mirror_path, row.path, row.content);
      exported++;
    } catch (err) {
      console.error('[cortex] mirror sync failed for', row.path, err);
    }
  }
  return { exported, path: s.mirror_path };
}

// ---------------------------------------------------------------------------
// Notes
// ---------------------------------------------------------------------------

export function listNotes(): NoteListItem[] {
  const rows = conn()
    .prepare('SELECT path, title, content, tags, mtime FROM notes ORDER BY mtime DESC')
    .all() as NoteRow[];
  return rows.map((r) => ({
    path: r.path,
    title: r.title,
    tags: safeParseTags(r.tags),
    mtime: r.mtime,
    size: Buffer.byteLength(r.content, 'utf8'),
  }));
}

function safeParseTags(json: string): string[] {
  try {
    const v = JSON.parse(json);
    return Array.isArray(v) ? v.map(String) : [];
  } catch {
    return [];
  }
}

export function readNote(p: string): NoteFull | null {
  const notePath = normalizePath(p);
  const d = conn();
  const row = d.prepare('SELECT * FROM notes WHERE path = ?').get(notePath) as NoteRow | undefined;
  if (!row) return null;
  const links = (d.prepare('SELECT dst FROM links WHERE src = ? ORDER BY dst').all(notePath) as { dst: string }[])
    .map((r) => r.dst);
  const backlinks = (d.prepare('SELECT src FROM links WHERE dst = ? ORDER BY src').all(notePath) as { src: string }[])
    .map((r) => r.src);
  return {
    path: row.path,
    title: row.title,
    content: row.content,
    tags: safeParseTags(row.tags),
    links,
    backlinks,
    mtime: row.mtime,
    ctime: row.ctime,
  };
}

export function writeNote(p: string, content: string, agent: string): NoteFull {
  const notePath = normalizePath(p);
  const body = typeof content === 'string' ? content : String(content ?? '');
  const d = conn();
  const now = Date.now();
  const title = deriveTitle(notePath, body);
  const tags = JSON.stringify(extractTags(body));

  const isNew = !d.prepare('SELECT path FROM notes WHERE path = ?').get(notePath);
  const tx = d.transaction(() => {
    d.prepare(
      `INSERT INTO notes(path, title, content, tags, ctime, mtime)
       VALUES (@path, @title, @content, @tags, @now, @now)
       ON CONFLICT(path) DO UPDATE SET
         title = @title, content = @content, tags = @tags, mtime = @now`
    ).run({ path: notePath, title, content: body, tags, now });
    // A brand-new note can resolve [[links]] other notes already contain.
    if (isNew) recomputeAllLinks();
    else recomputeLinksFor(notePath, body);
  });
  tx();

  mirrorAfterWrite(notePath, body);
  logActivity({ agent, action: 'write', path: notePath });
  emitChange('vault');
  return readNote(notePath) as NoteFull;
}

export function appendNote(p: string, content: string, agent: string): NoteFull {
  const notePath = normalizePath(p);
  const appended = typeof content === 'string' ? content : String(content ?? '');
  const d = conn();
  const existing = d.prepare('SELECT content FROM notes WHERE path = ?').get(notePath) as
    | { content: string }
    | undefined;
  const newContent = existing ? existing.content + '\n' + appended : appended;

  const now = Date.now();
  const title = deriveTitle(notePath, newContent);
  const tags = JSON.stringify(extractTags(newContent));
  const tx = d.transaction(() => {
    d.prepare(
      `INSERT INTO notes(path, title, content, tags, ctime, mtime)
       VALUES (@path, @title, @content, @tags, @now, @now)
       ON CONFLICT(path) DO UPDATE SET
         title = @title, content = @content, tags = @tags, mtime = @now`
    ).run({ path: notePath, title, content: newContent, tags, now });
    if (existing) recomputeLinksFor(notePath, newContent);
    else recomputeAllLinks();
  });
  tx();

  mirrorAfterWrite(notePath, newContent);
  logActivity({ agent, action: 'append', path: notePath });
  emitChange('vault');
  return readNote(notePath) as NoteFull;
}

export function deleteNote(p: string, agent: string): boolean {
  const notePath = normalizePath(p);
  const d = conn();
  const existed = !!d.prepare('SELECT path FROM notes WHERE path = ?').get(notePath);
  if (!existed) return false;

  const tx = d.transaction(() => {
    d.prepare('DELETE FROM notes WHERE path = ?').run(notePath);
    // Links to the deleted note may re-resolve to another note with the same
    // title (and its own links must go) — recompute the whole small table.
    recomputeAllLinks();
  });
  tx();

  mirrorAfterDelete(notePath);
  logActivity({ agent, action: 'delete', path: notePath });
  emitChange('vault');
  return true;
}

function normalizeFolderPrefix(p: string): string {
  let out = String(p ?? '').trim().normalize('NFC').replace(/\\/g, '/');
  out = out.replace(/^\/+|\/+$/g, '');
  if (!out) throw new Error('invalid folder path');
  const segments = out.split('/').filter((s) => s.trim() !== '' && s !== '.');
  if (segments.length === 0 || segments.some((s) => s === '..')) {
    throw new Error('invalid folder path');
  }
  return segments.map((s) => s.trim()).join('/');
}

/** Folders are virtual (derived from note paths) — deleting one deletes every
 *  note whose path starts with it, in one transaction, then recomputes links
 *  once (not per note, unlike deleteNote — this can be dozens of notes). */
export function deleteFolder(folderPath: string, agent: string): { deleted: number; paths: string[] } {
  const prefix = normalizeFolderPrefix(folderPath);
  const d = conn();
  const escaped = prefix.replace(/[%_\\]/g, (c) => '\\' + c);
  const rows = d
    .prepare(`SELECT path FROM notes WHERE path LIKE ? ESCAPE '\\'`)
    .all(escaped + '/%') as { path: string }[];
  const paths = rows.map((r) => r.path);
  if (paths.length === 0) return { deleted: 0, paths: [] };

  const tx = d.transaction(() => {
    const stmt = d.prepare('DELETE FROM notes WHERE path = ?');
    for (const p of paths) stmt.run(p);
    recomputeAllLinks();
  });
  tx();

  for (const p of paths) mirrorAfterDelete(p);
  logActivity({ agent, action: 'delete-folder', path: prefix, detail: `${paths.length} note(s)` });
  emitChange('vault');
  return { deleted: paths.length, paths };
}

/** Rewrite [[oldTitle]] / [[oldPath]] / [[oldFilename]] wiki-link targets to
 *  [[newTitle]] across every OTHER note's raw content, so prose stays a live
 *  link after a rename instead of turning into wikilink-broken text (the
 *  `links` table already re-resolves via recomputeAllLinks, but that table
 *  doesn't fix what's literally written in other notes). Alias text, if any,
 *  is preserved. Returns how many notes were touched. */
function renameWikilinkReferences(oldTitle: string, oldPath: string, newTitle: string): number {
  const d = conn();
  const oldPathNoExt = oldPath.replace(/\.md$/i, '');
  const oldFileNoExt = (oldPath.split('/').pop() ?? oldPath).replace(/\.md$/i, '');
  const oldIds = new Set([oldTitle, oldPathNoExt, oldFileNoExt].map((s) => s.toLowerCase()));
  const re = /\[\[([^\]|]+)(\|[^\]]*)?\]\]/g;
  const rows = d.prepare('SELECT path, content FROM notes').all() as { path: string; content: string }[];
  const upd = d.prepare('UPDATE notes SET content = ? WHERE path = ?');
  let changed = 0;
  for (const row of rows) {
    let touched = false;
    const next = row.content.replace(re, (whole: string, target: string, aliasPart?: string) => {
      const bare = target.trim().replace(/\.md$/i, '');
      if (oldIds.has(bare.toLowerCase())) {
        touched = true;
        return `[[${newTitle}${aliasPart ?? ''}]]`;
      }
      return whole;
    });
    if (touched) {
      upd.run(next, row.path);
      mirrorAfterWrite(row.path, next);
      changed++;
    }
  }
  return changed;
}

export function renameNote(from: string, to: string, agent: string): NoteFull {
  const src = normalizePath(from);
  const dst = normalizePath(to);
  const d = conn();
  const row = d.prepare('SELECT * FROM notes WHERE path = ?').get(src) as NoteRow | undefined;
  if (!row) throw new Error('note not found');
  if (src !== dst && d.prepare('SELECT path FROM notes WHERE path = ?').get(dst)) {
    throw new Error('destination already exists');
  }

  const oldTitle = row.title;
  const title = deriveTitle(dst, row.content);
  let relinked = 0;
  const tx = d.transaction(() => {
    d.prepare('UPDATE notes SET path = ?, title = ?, mtime = ? WHERE path = ?').run(
      dst,
      title,
      Date.now(),
      src
    );
    if (oldTitle !== title || src !== dst) {
      relinked = renameWikilinkReferences(oldTitle, src, title);
    }
    // Note count is small: recompute every link so anything pointing at the
    // old path/title re-resolves against the new one.
    recomputeAllLinks();
  });
  tx();

  mirrorAfterDelete(src);
  mirrorAfterWrite(dst, row.content);
  logActivity({
    agent,
    action: 'rename',
    path: dst,
    detail: `${src} → ${dst}` + (relinked > 0 ? ` (${relinked} note(s) relinked)` : ''),
  });
  emitChange('vault');
  return readNote(dst) as NoteFull;
}

// ---------------------------------------------------------------------------
// Search
// ---------------------------------------------------------------------------

const MAX_SEARCH_NOTES = 50;
const MAX_MATCHES_PER_NOTE = 5;

/**
 * @param mode 'and' (default) requires every term to match — good for short keyword
 *   searches (the sidebar box, cortex_search). 'or' matches any term — needed for
 *   RAG context lookup, where the input is a full natural-language question that
 *   will almost never appear verbatim in a note.
 */
export function searchNotes(q: string, mode: 'and' | 'or' = 'and'): SearchResult[] {
  const query = String(q ?? '').trim();
  if (!query) return [];
  const d = conn();
  const lq = query.toLowerCase();
  const terms = lq
    .split(/\s+/)
    .map((t) => t.replace(/[؟?!.,،؛:؛"'()[\]{}]/g, ''))
    .filter((t) => t.length > 1);

  // Candidate note paths, in relevance-ish order (FTS first, then LIKE extras).
  const candidates: string[] = [];
  const seen = new Set<string>();
  const push = (p: string): void => {
    if (!seen.has(p)) { seen.add(p); candidates.push(p); }
  };

  if (ftsAvailable && terms.length > 0) {
    try {
      const match = terms.map((t) => `"${t.replace(/"/g, '""')}"`).join(mode === 'or' ? ' OR ' : ' ');
      const rows = d
        .prepare('SELECT path FROM notes_fts WHERE notes_fts MATCH ? LIMIT ?')
        .all(match, MAX_SEARCH_NOTES) as { path: string }[];
      for (const r of rows) push(r.path);
    } catch {
      // FTS syntax error → LIKE fallback below covers it
    }
  }

  const like = `%${lq.replace(/[%_\\]/g, (c) => '\\' + c)}%`;
  const likeRows = d
    .prepare(
      `SELECT path FROM notes
       WHERE lower(title) LIKE ? ESCAPE '\\'
          OR lower(content) LIKE ? ESCAPE '\\'
          OR lower(tags) LIKE ? ESCAPE '\\'
       ORDER BY mtime DESC LIMIT ?`
    )
    .all(like, like, like, MAX_SEARCH_NOTES) as { path: string }[];
  for (const r of likeRows) push(r.path);

  const results: SearchResult[] = [];
  const getNote = d.prepare('SELECT path, title, content, tags FROM notes WHERE path = ?');
  for (const p of candidates) {
    if (results.length >= MAX_SEARCH_NOTES) break;
    const row = getNote.get(p) as NoteRow | undefined;
    if (!row) continue;

    const matches: SearchMatch[] = [];
    const lines = row.content.split('\n');
    for (let i = 0; i < lines.length && matches.length < MAX_MATCHES_PER_NOTE; i++) {
      const lower = lines[i].toLowerCase();
      if (lower.includes(lq) || terms.some((t) => lower.includes(t))) {
        matches.push({ line: i + 1, text: lines[i].trim() });
      }
    }
    if (matches.length === 0) {
      // Title / tag hit with no content hit
      matches.push({ line: 0, text: row.title });
    }
    results.push({ path: row.path, title: row.title, matches });
  }
  return results;
}

// ---------------------------------------------------------------------------
// Graph
// ---------------------------------------------------------------------------

export function getGraph(): {
  nodes: { id: string; title: string; tags: string[]; size: number }[];
  edges: { source: string; target: string }[];
} {
  const d = conn();
  const notes = d.prepare('SELECT path, title, tags FROM notes').all() as {
    path: string;
    title: string;
    tags: string;
  }[];
  const links = d.prepare('SELECT src, dst FROM links').all() as { src: string; dst: string }[];

  const degree = new Map<string, number>();
  for (const l of links) {
    degree.set(l.src, (degree.get(l.src) ?? 0) + 1);
    degree.set(l.dst, (degree.get(l.dst) ?? 0) + 1);
  }

  return {
    nodes: notes.map((n) => ({
      id: n.path,
      title: n.title,
      tags: safeParseTags(n.tags),
      size: degree.get(n.path) ?? 0,
    })),
    edges: links.map((l) => ({ source: l.src, target: l.dst })),
  };
}

// ---------------------------------------------------------------------------
// Tasks
// ---------------------------------------------------------------------------

function rowToTask(r: any): Task {
  return {
    id: r.id,
    text: r.text,
    assignee: r.assignee ?? null,
    status: r.status,
    position: r.position,
    created: r.created,
    updated: r.updated,
    project: r.project ?? null,
  };
}

export function getTasks(): { columns: Record<string, Task[]> } {
  const rows = conn()
    .prepare('SELECT * FROM tasks ORDER BY position ASC, created ASC')
    .all() as any[];
  const columns: Record<string, Task[]> = {};
  for (const s of TASK_STATUSES) columns[s] = [];
  
  const unknownStatuses = new Set<string>();
  let unknownCount = 0;

  for (const r of rows) {
    const task = rowToTask(r);
    if (!columns[task.status]) {
      unknownStatuses.add(task.status);
      unknownCount++;
      task.status = 'TODO';
      columns['TODO'].push(task);
    } else {
      columns[task.status].push(task);
    }
  }

  if (unknownCount > 0) {
    logActivity({
      agent: 'system',
      action: 'auto-fix',
      detail: `Mapped ${unknownCount} task(s) with unknown statuses (${Array.from(unknownStatuses).join(', ')}) to TODO`
    });
  }

  return { columns };
}

function randomTaskId(): string {
  const bytes = randomBytes(6);
  let out = '';
  for (let i = 0; i < 6; i++) out += (bytes[i] % 36).toString(36);
  return out;
}

export function addTask(t: {
  text: string;
  assignee?: string | null;
  status?: string;
  project?: string | null;
  agent: string;
}): Task {
  const d = conn();
  const text = String(t.text ?? '').trim();
  if (!text) throw new Error('task text required');
  const status = t.status && (TASK_STATUSES as readonly string[]).includes(t.status) ? t.status : 'TODO';
  const assignee = t.assignee ? String(t.assignee) : null;
  const project = t.project ? String(t.project) : null;

  let id = randomTaskId();
  while (d.prepare('SELECT id FROM tasks WHERE id = ?').get(id)) id = randomTaskId();

  const now = Date.now();
  const maxPos = (d.prepare('SELECT COALESCE(MAX(position), 0) AS m FROM tasks WHERE status = ?').get(status) as {
    m: number;
  }).m;
  d.prepare(
    'INSERT INTO tasks(id, text, assignee, status, position, created, updated, project) VALUES (?, ?, ?, ?, ?, ?, ?, ?)'
  ).run(id, text, assignee, status, maxPos + 1, now, now, project);

  logActivity({ agent: t.agent, action: 'task-add', detail: `${id}: ${text}` });
  emitChange('tasks');
  return rowToTask(d.prepare('SELECT * FROM tasks WHERE id = ?').get(id));
}

export function updateTask(
  id: string,
  patch: { status?: string; assignee?: string | null; text?: string; project?: string | null },
  agent: string
): Task {
  const d = conn();
  const row = d.prepare('SELECT * FROM tasks WHERE id = ?').get(id) as any;
  if (!row) throw new Error('task not found');

  const changes: string[] = [];
  let status: string = row.status;
  let position: number = row.position;

  if (patch.status !== undefined && patch.status !== row.status) {
    if (!(TASK_STATUSES as readonly string[]).includes(patch.status)) {
      throw new Error('invalid status');
    }
    status = patch.status;
    const maxPos = (d
      .prepare('SELECT COALESCE(MAX(position), 0) AS m FROM tasks WHERE status = ?')
      .get(status) as { m: number }).m;
    position = maxPos + 1;
    changes.push(`status → ${status}`);
  }
  const text = patch.text !== undefined ? String(patch.text) : row.text;
  if (patch.text !== undefined && patch.text !== row.text) changes.push('text updated');
  const assignee = patch.assignee !== undefined ? (patch.assignee ? String(patch.assignee) : null) : row.assignee;
  if (patch.assignee !== undefined && patch.assignee !== row.assignee) {
    changes.push(`assignee → ${assignee ?? '—'}`);
  }
  const project = patch.project !== undefined ? (patch.project ? String(patch.project) : null) : row.project;
  if (patch.project !== undefined && patch.project !== row.project) {
    if (project !== null) {
      if (!isProjectPath(project)) {
        throw new Error('invalid project path');
      }
      const res = d.prepare('SELECT 1 FROM notes WHERE path = ?').get(project);
      if (!res) {
        throw new Error('project note does not exist');
      }
    }
    changes.push(`project → ${project ?? '—'}`);
  }

  d.prepare(
    'UPDATE tasks SET text = ?, assignee = ?, status = ?, position = ?, updated = ?, project = ? WHERE id = ?'
  ).run(text, assignee, status, position, Date.now(), project, id);

  logActivity({ agent, action: 'task-update', detail: `${id}: ${changes.join(', ') || 'no change'}` });
  emitChange('tasks');
  return rowToTask(d.prepare('SELECT * FROM tasks WHERE id = ?').get(id));
}

export function deleteTask(id: string, agent: string): boolean {
  const d = conn();
  const row = d.prepare('SELECT text FROM tasks WHERE id = ?').get(id) as { text: string } | undefined;
  if (!row) return false;
  d.prepare('DELETE FROM tasks WHERE id = ?').run(id);
  logActivity({ agent, action: 'task-delete', detail: `${id}: ${row.text.slice(0, 60)}` });
  emitChange('tasks');
  return true;
}

// ---------------------------------------------------------------------------
// Protocol — standing team rules + skills (auto-fed to every agent session)
// ---------------------------------------------------------------------------

export type ProtocolKind = 'rule' | 'skill' | 'template';

export interface ProtocolItem {
  id: string;
  kind: ProtocolKind;
  title: string;
  body: string;
  enabled: boolean;
  position: number;
  created: number;
  updated: number;
}

function normKind(k: unknown): ProtocolKind {
  return k === 'skill' ? 'skill' : k === 'template' ? 'template' : 'rule';
}

function rowToProtocol(r: any): ProtocolItem {
  return {
    id: r.id,
    kind: normKind(r.kind),
    title: r.title,
    body: r.body ?? '',
    enabled: !!r.enabled,
    position: r.position ?? 0,
    created: r.created ?? 0,
    updated: r.updated ?? 0,
  };
}

export function getProtocol(): {
  rules: ProtocolItem[];
  skills: ProtocolItem[];
  templates: ProtocolItem[];
} {
  const rows = conn()
    .prepare('SELECT * FROM protocol ORDER BY position ASC, created ASC')
    .all() as any[];
  const rules: ProtocolItem[] = [];
  const skills: ProtocolItem[] = [];
  const templates: ProtocolItem[] = [];
  for (const r of rows) {
    const item = rowToProtocol(r);
    if (item.kind === 'skill') skills.push(item);
    else if (item.kind === 'template') templates.push(item);
    else rules.push(item);
  }
  return { rules, skills, templates };
}

export function addProtocol(t: {
  kind: string;
  title: string;
  body?: string;
  enabled?: boolean;
  agent: string;
}): ProtocolItem {
  const d = conn();
  const kind = normKind(t.kind);
  const title = String(t.title ?? '').trim();
  if (!title) throw new Error('title required');
  const body = typeof t.body === 'string' ? t.body : '';
  const enabled = t.enabled === false ? 0 : 1;

  let id = randomTaskId();
  while (d.prepare('SELECT id FROM protocol WHERE id = ?').get(id)) id = randomTaskId();

  const now = Date.now();
  const maxPos = (d.prepare('SELECT COALESCE(MAX(position), 0) AS m FROM protocol WHERE kind = ?').get(kind) as {
    m: number;
  }).m;
  d.prepare(
    'INSERT INTO protocol(id, kind, title, body, enabled, position, created, updated) VALUES (?, ?, ?, ?, ?, ?, ?, ?)'
  ).run(id, kind, title, body, enabled, maxPos + 1, now, now);

  logActivity({ agent: t.agent, action: 'protocol-add', detail: `${kind} ${id}: ${title}` });
  emitChange('protocol');
  return rowToProtocol(d.prepare('SELECT * FROM protocol WHERE id = ?').get(id));
}

export function updateProtocol(
  id: string,
  patch: { kind?: string; title?: string; body?: string; enabled?: boolean },
  agent: string
): ProtocolItem {
  const d = conn();
  const row = d.prepare('SELECT * FROM protocol WHERE id = ?').get(id) as any;
  if (!row) throw new Error('protocol item not found');

  const kind = patch.kind === 'rule' || patch.kind === 'skill' || patch.kind === 'template' ? patch.kind : row.kind;
  const title = patch.title !== undefined ? String(patch.title).trim() || row.title : row.title;
  const body = patch.body !== undefined ? String(patch.body) : row.body;
  const enabled = patch.enabled !== undefined ? (patch.enabled ? 1 : 0) : row.enabled;
  // Moving to a different kind: append to the end of that kind so positions don't collide.
  let position = row.position;
  if (kind !== row.kind) {
    position = (d.prepare('SELECT COALESCE(MAX(position), 0) AS m FROM protocol WHERE kind = ?').get(kind) as {
      m: number;
    }).m + 1;
  }

  d.prepare('UPDATE protocol SET kind = ?, title = ?, body = ?, enabled = ?, position = ?, updated = ? WHERE id = ?').run(
    kind,
    title,
    body,
    enabled,
    position,
    Date.now(),
    id
  );
  logActivity({ agent, action: 'protocol-update', detail: `${id}: ${title}` });
  emitChange('protocol');
  return rowToProtocol(d.prepare('SELECT * FROM protocol WHERE id = ?').get(id));
}

export function deleteProtocol(id: string, agent: string): boolean {
  const d = conn();
  const row = d.prepare('SELECT title FROM protocol WHERE id = ?').get(id) as { title: string } | undefined;
  if (!row) return false;
  d.prepare('DELETE FROM protocol WHERE id = ?').run(id);
  logActivity({ agent, action: 'protocol-delete', detail: `${id}: ${row.title.slice(0, 60)}` });
  emitChange('protocol');
  return true;
}

// ---------------------------------------------------------------------------
// Activity
// ---------------------------------------------------------------------------

export function logActivity(entry: {
  agent: string;
  action: string;
  path?: string | null;
  detail?: string | null;
}): void {
  conn()
    .prepare('INSERT INTO activity(ts, agent, action, path, detail) VALUES (?, ?, ?, ?, ?)')
    .run(Date.now(), entry.agent || 'user', entry.action, entry.path ?? null, entry.detail ?? null);
  emitChange('activity');
}

export function getActivity(limit = 100): ActivityRow[] {
  const n = Math.max(1, Math.min(1000, Math.floor(Number(limit) || 100)));
  const rows = conn()
    .prepare('SELECT ts, agent, action, path, detail FROM activity ORDER BY id DESC LIMIT ?')
    .all(n) as { ts: number; agent: string; action: string; path: string | null; detail: string | null }[];
  return rows.map((r) => ({
    ts: new Date(r.ts).toISOString(),
    agent: r.agent,
    action: r.action,
    path: r.path,
    detail: r.detail,
  }));
}

// ---------------------------------------------------------------------------
// Settings
// ---------------------------------------------------------------------------

export function getSettings(): {
  mirror_enabled: boolean;
  mirror_path: string;
  /** Where GENERATION runs. Embeddings are always embedded/on-device. */
  ai_provider: 'embedded' | 'cloud';
  ai_gen_model_path: string;
  ai_embed_model_path: string;
  ai_cloud_base_url: string;
  ai_cloud_model: string;
  /** Encrypted blob (safeStorage). Never send this to the renderer. */
  ai_cloud_api_key_enc: string;
  /** Path of the Projects/*.md note last opened — TasksView defaults to it. */
  active_project: string;
} {
  const rows = conn().prepare('SELECT key, value FROM settings').all() as { key: string; value: string }[];
  const map = new Map(rows.map((r) => [r.key, r.value]));
  return {
    mirror_enabled: map.get('mirror_enabled') === '1',
    mirror_path: map.get('mirror_path') ?? '',
    ai_provider: map.get('ai_provider') === 'cloud' ? 'cloud' : 'embedded',
    ai_gen_model_path: map.get('ai_gen_model_path') ?? '',
    ai_embed_model_path: map.get('ai_embed_model_path') ?? '',
    ai_cloud_base_url: map.get('ai_cloud_base_url') || 'https://api.openai.com/v1',
    ai_cloud_model: map.get('ai_cloud_model') || 'gpt-4o-mini',
    ai_cloud_api_key_enc: map.get('ai_cloud_api_key_enc') ?? '',
    active_project: map.get('active_project') ?? '',
  };
}

const SETTABLE_KEYS = new Set([
  'mirror_enabled',
  'mirror_path',
  'ai_provider',
  'ai_gen_model_path',
  'ai_embed_model_path',
  'ai_cloud_base_url',
  'ai_cloud_model',
  'ai_cloud_api_key_enc',
  'active_project',
]);

export function setSetting(key: string, value: string): void {
  if (!SETTABLE_KEYS.has(key)) {
    throw new Error('unknown setting: ' + key);
  }
  const v = key === 'mirror_enabled' ? (value === '1' || value === 'true' ? '1' : '0') : String(value ?? '');
  conn()
    .prepare('INSERT INTO settings(key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value')
    .run(key, v);
}

// ---------------------------------------------------------------------------
// Semantic index storage (vectors live here; the math lives in semantic.ts)
// ---------------------------------------------------------------------------

export interface EmbeddingRow {
  path: string;
  chunk_idx: number;
  snippet: string;
  vec: Float32Array;
  mtime: number;
}

/** Float32Array <-> BLOB. Copies into a fresh buffer so the stored bytes never
 *  alias a larger backing ArrayBuffer. */
function vecToBlob(v: Float32Array): Buffer {
  return Buffer.from(v.buffer, v.byteOffset, v.byteLength);
}

function blobToVec(b: Buffer): Float32Array {
  const copy = new ArrayBuffer(b.byteLength);
  Buffer.from(copy).set(b);
  return new Float32Array(copy);
}

export function replaceEmbeddings(
  notePath: string,
  model: string,
  chunks: { snippet: string; vec: Float32Array }[],
  mtime: number
): void {
  const d = conn();
  const tx = d.transaction(() => {
    d.prepare('DELETE FROM embeddings WHERE path = ?').run(notePath);
    const ins = d.prepare(
      'INSERT INTO embeddings(path, chunk_idx, snippet, vec, dim, model, mtime) VALUES (?, ?, ?, ?, ?, ?, ?)'
    );
    chunks.forEach((c, i) => {
      ins.run(notePath, i, c.snippet, vecToBlob(c.vec), c.vec.length, model, mtime);
    });
  });
  tx();
}

export function deleteEmbeddings(notePath: string): void {
  conn().prepare('DELETE FROM embeddings WHERE path = ?').run(notePath);
}

export function clearEmbeddings(): void {
  conn().prepare('DELETE FROM embeddings').run();
}

/** Every stored chunk vector for the given model (the whole index is small
 *  enough to brute-force in JS — no vector index needed at vault scale). */
export function allEmbeddings(model: string): EmbeddingRow[] {
  const rows = conn()
    .prepare('SELECT path, chunk_idx, snippet, vec, mtime FROM embeddings WHERE model = ?')
    .all(model) as { path: string; chunk_idx: number; snippet: string; vec: Buffer; mtime: number }[];
  return rows.map((r) => ({
    path: r.path,
    chunk_idx: r.chunk_idx,
    snippet: r.snippet,
    vec: blobToVec(r.vec),
    mtime: r.mtime,
  }));
}

/** Which notes still need embedding: missing rows, a stale mtime, or indexed
 *  under a different model/prefix than the one now configured. */
export function staleEmbeddingPaths(model: string): string[] {
  const rows = conn()
    .prepare(
      `SELECT n.path AS path FROM notes n
       LEFT JOIN (
         SELECT path, MAX(mtime) AS mtime, model FROM embeddings GROUP BY path
       ) e ON e.path = n.path
       WHERE e.path IS NULL OR e.model != ? OR e.mtime != n.mtime`
    )
    .all(model) as { path: string }[];
  return rows.map((r) => r.path);
}

export function embeddingCounts(model: string): { indexedNotes: number; totalNotes: number } {
  const d = conn();
  const indexedNotes = (
    d.prepare('SELECT COUNT(DISTINCT path) AS c FROM embeddings WHERE model = ?').get(model) as { c: number }
  ).c;
  const totalNotes = (d.prepare('SELECT COUNT(*) AS c FROM notes').get() as { c: number }).c;
  return { indexedNotes, totalNotes };
}

/** Note content for indexing, plus its mtime for staleness checks. */
export function notesForIndexing(paths: string[]): { path: string; title: string; content: string; mtime: number }[] {
  if (paths.length === 0) return [];
  const d = conn();
  const stmt = d.prepare('SELECT path, title, content, mtime FROM notes WHERE path = ?');
  const out: { path: string; title: string; content: string; mtime: number }[] = [];
  for (const p of paths) {
    const row = stmt.get(p) as { path: string; title: string; content: string; mtime: number } | undefined;
    if (row) out.push(row);
  }
  return out;
}

export function noteTitleOf(notePath: string): string | null {
  const row = conn().prepare('SELECT title FROM notes WHERE path = ?').get(notePath) as
    | { title: string }
    | undefined;
  return row?.title ?? null;
}

/** Outgoing link targets for a note — used to mark which similar notes are
 *  already linked (so we only suggest genuinely missing connections). */
export function linkedPathsOf(notePath: string): Set<string> {
  const rows = conn().prepare('SELECT dst FROM links WHERE src = ?').all(notePath) as { dst: string }[];
  return new Set(rows.map((r) => r.dst));
}

// ---------------------------------------------------------------------------
// Orchestrator pipeline — roles, lifecycle, audit
// ---------------------------------------------------------------------------

export type RoleKey = 'planner' | 'coder' | 'security' | 'qa';

export const ORCH_STATUSES = [
  'PLANNING',
  'QUEUED',
  'IN_PROGRESS',
  'SECURITY_REVIEW',
  'QA_REVIEW',
  'FINAL_REVIEW',
  'COMPLETED',
  'FAILED',
] as const;
export type OrchStatus = (typeof ORCH_STATUSES)[number];

/** How many times a task may be sent back to the coder before it is FAILED.
 *  Without a bound, a coder and a reviewer can reject each other forever. */
export const MAX_REJECTS = 5;

/** A claim older than this is treated as abandoned (the agent died mid-task)
 *  and the task becomes claimable again. */
export const CLAIM_STALE_MS = 30 * 60 * 1000;

export interface PipelineRole {
  role_key: RoleKey;
  display_name: string;
  is_required: boolean;
  is_enabled: boolean;
  assigned_agent: string;
  model: string;
  auto_advance: boolean;
  auto_dispatch: boolean;
  position: number;
}

export interface OrchTask {
  id: number;
  title: string;
  description: string;
  current_role: RoleKey;
  status: OrchStatus;
  assigned_agent: string;
  context_files: string[];
  diff_payload: string | null;
  feedback: string | null;
  execution_mode: 'auto' | 'manual';
  created_at: number;
  updated_at: number;
  claimed_by: string | null;
  claimed_at: number | null;
  gate_pending: boolean;
  pending_role: RoleKey | null;
  pending_status: OrchStatus | null;
  reject_count: number;
  project: string | null;
  auto_blocked: boolean;
  dispatch_status?: string | null;
  dispatch_error?: string | null;
  dispatch_conv_id?: string | null;
  dispatch_launched_at?: number | null;
  seq: number | null;
  skills?: string;
  /** Per-task choice; empty = follow the global pipeline config. */
  coder_agent?: string;
  coder_model?: string;
  reviewer_agent?: string;
  reviewer_model?: string;
}

export interface OrchAuditRow {
  id: number;
  task_id: number;
  role_key: string;
  agent_name: string;
  action: string;
  comment: string | null;
  timestamp: number;
}

const DEFAULT_ROLES: PipelineRole[] = [
  { role_key: 'planner',  display_name: 'Planner / Reviewer', is_required: true,  is_enabled: true, assigned_agent: 'claude',      model: '', auto_advance: true, auto_dispatch: true, position: 0 },
  { role_key: 'coder',    display_name: 'Coder / Implementer', is_required: true,  is_enabled: true, assigned_agent: 'antigravity', model: '', auto_advance: true, auto_dispatch: true, position: 1 },
  { role_key: 'security', display_name: 'Security Sentinel',   is_required: false, is_enabled: true,  assigned_agent: 'claude',     model: '', auto_advance: true, auto_dispatch: true, position: 2 },
  { role_key: 'qa',       display_name: 'QA / Test Runner',    is_required: false, is_enabled: true,  assigned_agent: 'opencode',   model: '', auto_advance: true, auto_dispatch: true, position: 3 },
];

/** Insert the four pipeline roles once. Existing rows are left untouched so a
 *  user's agent assignments and toggles survive every restart. */
function seedPipelineConfig(): void {
  const d = conn();
  const ins = d.prepare(
    `INSERT OR IGNORE INTO orchestrator_pipeline_config
       (role_key, display_name, is_required, is_enabled, assigned_agent, model, auto_advance, position)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
  );
  const tx = d.transaction(() => {
    for (const r of DEFAULT_ROLES) {
      ins.run(
        r.role_key,
        r.display_name,
        r.is_required ? 1 : 0,
        r.is_enabled ? 1 : 0,
        r.assigned_agent,
        r.model,
        r.auto_advance ? 1 : 0,
        r.position
      );
    }
  });
  tx();
}

function rowToRole(r: any): PipelineRole {
  return {
    role_key: r.role_key,
    display_name: r.display_name,
    is_required: !!r.is_required,
    is_enabled: !!r.is_enabled,
    assigned_agent: r.assigned_agent,
    model: r.model ?? '',
    auto_advance: !!r.auto_advance,
    position: r.position ?? 0,
    auto_dispatch: !!r.auto_dispatch,
  };
}

function rowToOrchTask(r: any): OrchTask {
  let files: string[] = [];
  try {
    const parsed = r.context_files ? JSON.parse(r.context_files) : [];
    if (Array.isArray(parsed)) files = parsed.filter((x: unknown) => typeof x === 'string');
  } catch {
    files = [];
  }
  return {
    id: r.id,
    title: r.title,
    description: r.description,
    current_role: r.current_role,
    status: r.status,
    assigned_agent: r.assigned_agent,
    context_files: files,
    diff_payload: r.diff_payload ?? null,
    feedback: r.feedback ?? null,
    execution_mode: r.execution_mode === 'manual' ? 'manual' : 'auto',
    created_at: r.created_at,
    updated_at: r.updated_at,
    claimed_by: r.claimed_by ?? null,
    claimed_at: r.claimed_at ?? null,
    gate_pending: !!r.gate_pending,
    pending_role: r.pending_role ?? null,
    pending_status: r.pending_status ?? null,
    reject_count: r.reject_count ?? 0,
    project: r.project ?? null,
    auto_blocked: !!r.auto_blocked,
    coder_agent: r.coder_agent ?? '',
    coder_model: r.coder_model ?? '',
    reviewer_agent: r.reviewer_agent ?? '',
    reviewer_model: r.reviewer_model ?? '',
    seq: r.seq ?? null,
    dispatch_status: r.dispatch_status ?? null,
    dispatch_conv_id: r.dispatch_conv_id ?? null,
    dispatch_launched_at: r.dispatch_launched_at ?? null,
  };
}

export function getPipelineConfig(): PipelineRole[] {
  return (
    conn()
      .prepare('SELECT * FROM orchestrator_pipeline_config ORDER BY position ASC, id ASC')
      .all() as any[]
  ).map(rowToRole);
}

export function roleOf(key: RoleKey): PipelineRole {
  const row = conn()
    .prepare('SELECT * FROM orchestrator_pipeline_config WHERE role_key = ?')
    .get(key) as any;
  if (!row) throw new Error('unknown role: ' + key);
  return rowToRole(row);
}

/** A per-task choice overrides the global pipeline config.
 *  The coder role reads coder_*, review roles read reviewer_*. Empty = fall back to the global config. */
export function effectiveAgentFor(taskId: number, roleKey: RoleKey): { agent: string; model: string } {
  const role = roleOf(roleKey);
  const task = getOrchTask(taskId);
  const isCoder = roleKey === 'coder';
  const a = (isCoder ? task?.coder_agent : task?.reviewer_agent) ?? '';
  const m = (isCoder ? task?.coder_model : task?.reviewer_model) ?? '';
  return { agent: a.trim() || role.assigned_agent, model: m.trim() || role.model || '' };
}

/** Called by the picker modal before dispatch. */
export function setOrchTaskAgents(
  taskId: number,
  patch: { coder_agent?: string; coder_model?: string; reviewer_agent?: string; reviewer_model?: string },
  agent: string
): OrchTask {
  const task = getOrchTask(taskId);
  if (!task) throw new Error('task not found');
  const next = {
    coder_agent: patch.coder_agent !== undefined ? patch.coder_agent.trim() : (task.coder_agent ?? ''),
    coder_model: patch.coder_model !== undefined ? patch.coder_model.trim() : (task.coder_model ?? ''),
    reviewer_agent: patch.reviewer_agent !== undefined ? patch.reviewer_agent.trim() : (task.reviewer_agent ?? ''),
    reviewer_model: patch.reviewer_model !== undefined ? patch.reviewer_model.trim() : (task.reviewer_model ?? ''),
  };
  conn().prepare(
    `UPDATE orchestrator_tasks
        SET coder_agent = ?, coder_model = ?, reviewer_agent = ?, reviewer_model = ?, updated_at = ?
      WHERE id = ?`
  ).run(next.coder_agent, next.coder_model, next.reviewer_agent, next.reviewer_model, Date.now(), taskId);
  logActivity({
    agent,
    action: 'orch-agents-set',
    path: null,
    detail: `Task ${taskId}: coder=${next.coder_agent || '(global)'}/${next.coder_model || '(default)'} · reviewer=${next.reviewer_agent || '(global)'}/${next.reviewer_model || '(default)'}`,
  });
  emitChange('orchestrator');
  return getOrchTask(taskId)!;
}

export function updatePipelineRole(
  key: string,
  patch: { is_enabled?: boolean; assigned_agent?: string; model?: string; auto_advance?: boolean; auto_dispatch?: boolean },
  agent: string
): PipelineRole {
  const role = roleOf(key as RoleKey);
  // planner and coder are structural: the pipeline has no meaning without them.
  if (patch.is_enabled === false && role.is_required) {
    throw new Error(`role "${key}" is required and cannot be disabled`);
  }
  const nextAgent =
    patch.assigned_agent !== undefined && patch.assigned_agent.trim()
      ? patch.assigned_agent.trim()
      : role.assigned_agent;
  const next = {
    is_enabled: patch.is_enabled ?? role.is_enabled,
    assigned_agent: nextAgent,
    // A model name is one agent's CLI vocabulary ('opus' means nothing to
    // opencode), so it cannot survive a swap of the agent that would run it:
    // drop it unless the same patch names a replacement.
    model:
      patch.model !== undefined
        ? patch.model.trim()
        : nextAgent === role.assigned_agent
          ? role.model
          : '',
    auto_advance: patch.auto_advance ?? role.auto_advance,
    auto_dispatch: patch.auto_dispatch ?? role.auto_dispatch,
  };
  const d = conn();
  let rehomed = 0;
  d.transaction(() => {
    d.prepare(
      `UPDATE orchestrator_pipeline_config
         SET is_enabled = ?, assigned_agent = ?, model = ?, auto_advance = ?, auto_dispatch = ? WHERE role_key = ?`
    ).run(next.is_enabled ? 1 : 0, next.assigned_agent, next.model, next.auto_advance ? 1 : 0, next.auto_dispatch ? 1 : 0, key);

    // Turning a role OFF would otherwise strand every task sitting in it:
    // claimOrchTask refuses disabled roles, so nothing could ever pick them up
    // again. Push them to the next enabled stage instead.
    if (role.is_enabled && !next.is_enabled) {
      const to = nextHop(key as RoleKey);
      const stuck = d
        .prepare(
          `SELECT id FROM orchestrator_tasks
            WHERE current_role = ? AND status NOT IN ('COMPLETED','FAILED')`
        )
        .all(key) as { id: number }[];
      const upd = d.prepare(
        `UPDATE orchestrator_tasks
            SET current_role = ?, status = ?, assigned_agent = ?, claimed_by = NULL,
                claimed_at = NULL, gate_pending = 0, pending_role = NULL,
                pending_status = NULL, updated_at = ? WHERE id = ?`
      );
      for (const row of stuck) {
        upd.run(to.role, to.status, next.assigned_agent, Date.now(), row.id);
        rehomed++;
      }
    }
    // Reassigning a role should also retarget its unclaimed tasks, otherwise
    // assigned_agent keeps naming an agent that no longer holds the role.
    if (next.assigned_agent !== role.assigned_agent) {
      d.prepare(
        `UPDATE orchestrator_tasks SET assigned_agent = ?, updated_at = ?
          WHERE current_role = ? AND claimed_by IS NULL
            AND status NOT IN ('COMPLETED','FAILED')`
      ).run(next.assigned_agent, Date.now(), key);
    }
  })();

  logActivity({
    agent,
    action: 'orch-config',
    detail: `${key}: ${JSON.stringify(next)}${rehomed ? ` · re-homed ${rehomed} task(s)` : ''}`,
  });
  emitChange('orchestrator');
  return roleOf(key as RoleKey);
}

// --- state machine ---------------------------------------------------------

/**
 * Statuses each role can claim from. The planner has TWO inboxes: PLANNING
 * (a raw goal the user dropped in, waiting to be broken down and dispatched)
 * and FINAL_REVIEW (finished work waiting for sign-off).
 */
const ROLE_INBOX: Record<RoleKey, OrchStatus[]> = {
  planner: ['PLANNING', 'FINAL_REVIEW'],
  coder: ['QUEUED'],
  security: ['SECURITY_REVIEW'],
  qa: ['QA_REVIEW'],
};

/**
 * Statuses a role may CLAIM from — its inbox plus, for the coder, the status of
 * an abandoned claim. Without IN_PROGRESS here, a coder that claimed and then
 * crashed leaves the task unreachable forever and CLAIM_STALE_MS is dead code.
 */
export const ROLE_CLAIMABLE: Record<RoleKey, OrchStatus[]> = {
  planner: ['PLANNING', 'FINAL_REVIEW'],
  coder: ['QUEUED', 'IN_PROGRESS'],
  security: ['SECURITY_REVIEW'],
  qa: ['QA_REVIEW'],
};

/** Where a role parks a task it is holding but has not finished. */
const ROLE_HOLD_STATUS: Record<RoleKey, OrchStatus> = {
  planner: 'FINAL_REVIEW',
  coder: 'IN_PROGRESS',
  security: 'SECURITY_REVIEW',
  qa: 'QA_REVIEW',
};

function orchAudit(
  taskId: number,
  roleKey: string,
  agentName: string,
  action: string,
  comment?: string | null
): void {
  conn()
    .prepare(
      `INSERT INTO orchestrator_audit_log(task_id, role_key, agent_name, action, comment, timestamp)
       VALUES (?, ?, ?, ?, ?, ?)`
    )
    .run(taskId, roleKey, agentName, action, comment ?? null, Date.now());
}

/**
 * Where does a task go after the current role finishes successfully?
 * Mirrors the spec: coder -> security? -> qa? -> planner(FINAL_REVIEW),
 * and reviews that pass walk the same chain from their own position.
 * Disabled roles are skipped. NOTE: this only applies at hand-off time, so it
 * does NOT rescue a task already parked inside a role that gets disabled —
 * updatePipelineRole() re-homes those explicitly.
 */
function nextHop(from: RoleKey): { role: RoleKey; status: OrchStatus } {
  const enabled = new Set(getPipelineConfig().filter((r) => r.is_enabled).map((r) => r.role_key));
  const chain: RoleKey[] = ['security', 'qa'];
  const startAt = from === 'coder' ? 0 : from === 'security' ? 1 : 2;
  for (let i = startAt; i < chain.length; i++) {
    const r = chain[i];
    if (enabled.has(r)) return { role: r, status: ROLE_HOLD_STATUS[r] };
  }
  return { role: 'planner', status: 'FINAL_REVIEW' };
}

/** True when handing off out of `from` must wait for a human click. */
function needsGate(task: OrchTask, from: RoleKey): boolean {
  // Per-task manual mode is the stronger statement of intent: a task explicitly
  // marked manual is gated at every hop regardless of role defaults.
  if (task.execution_mode === 'manual') return true;
  return !roleOf(from).auto_advance;
}

function applyHop(
  taskId: number,
  from: RoleKey,
  to: { role: RoleKey; status: OrchStatus },
  gated: boolean
): void {
  const d = conn();
  if (gated) {
    // No PAUSED status exists in the specified enum, so a gated task KEEPS its
    // current status and records where it would go in pending_role/status.
    // gate_pending=1 is what makes it invisible to claim_task.
    d.prepare(
      `UPDATE orchestrator_tasks
         SET gate_pending = 1, pending_role = ?, pending_status = ?, claimed_by = NULL,
             claimed_at = NULL, updated_at = ? WHERE id = ?`
    ).run(to.role, to.status, Date.now(), taskId);
    return;
  }
  d.prepare(
    `UPDATE orchestrator_tasks
       SET current_role = ?, status = ?, assigned_agent = ?, gate_pending = 0,
           pending_role = NULL, pending_status = NULL, claimed_by = NULL, claimed_at = NULL,
           updated_at = ? WHERE id = ?`
  ).run(to.role, to.status, roleOf(to.role).assigned_agent, Date.now(), taskId);
}

export function getOrchTask(id: number): OrchTask | null {
  const row = conn().prepare(`
    SELECT t.*,
           (SELECT status FROM dispatch_launches d WHERE d.task_id = t.id ORDER BY d.launched_at DESC LIMIT 1) as dispatch_status,
           (SELECT conversation_id FROM dispatch_launches d WHERE d.task_id = t.id ORDER BY d.launched_at DESC LIMIT 1) as dispatch_conv_id,
           (SELECT launched_at FROM dispatch_launches d WHERE d.task_id = t.id ORDER BY d.launched_at DESC LIMIT 1) as dispatch_launched_at,
           (SELECT error FROM dispatch_launches d WHERE d.task_id = t.id ORDER BY d.launched_at DESC LIMIT 1) as dispatch_error
    FROM orchestrator_tasks t
    WHERE t.id = ?
  `).get(id) as any;
  return row ? rowToOrchTask(row) : null;
}

export function listOrchTasks(limit = 200): OrchTask[] {
  return (
    conn()
      .prepare(`
        SELECT t.*,
               (SELECT status FROM dispatch_launches d WHERE d.task_id = t.id ORDER BY d.launched_at DESC LIMIT 1) as dispatch_status,
               (SELECT conversation_id FROM dispatch_launches d WHERE d.task_id = t.id ORDER BY d.launched_at DESC LIMIT 1) as dispatch_conv_id,
               (SELECT launched_at FROM dispatch_launches d WHERE d.task_id = t.id ORDER BY d.launched_at DESC LIMIT 1) as dispatch_launched_at
        FROM orchestrator_tasks t
        ORDER BY t.updated_at DESC
        LIMIT ?
      `)
      .all(Math.max(1, Math.min(500, limit))) as any[]
  ).map(rowToOrchTask);
}

export function getOrchAudit(taskId: number): OrchAuditRow[] {
  return conn()
    .prepare('SELECT * FROM orchestrator_audit_log WHERE task_id = ? ORDER BY id ASC')
    .all(taskId) as OrchAuditRow[];
}

export function createOrchTask(t: {
  title: string;
  description: string;
  context_files?: string[];
  execution_mode?: string;
  project?: string | null;
  /** true = park at planner/PLANNING for breakdown; false/absent = straight to coder. */
  needs_planning?: boolean;
  agent: string;
}): OrchTask {
  const title = String(t.title ?? '').trim();
  if (!title) throw new Error('title is required');
  const description = String(t.description ?? '').trim();
  if (!description) throw new Error('description is required');
  const files = Array.isArray(t.context_files)
    ? t.context_files.filter((f) => typeof f === 'string' && f.trim()).slice(0, 100)
    : [];
  const mode = t.execution_mode === 'manual' ? 'manual' : 'auto';
  const now = Date.now();
  // Two entry points:
  //  - an AGENT acting as planner has already done the breakdown, so its task
  //    goes straight to the coder (the spec's "planner sets QUEUED");
  //  - a raw goal from the user (needs_planning) parks at planner/PLANNING so
  //    the planner claims it, refines it, then dispatches by APPROVING it.
  const needsPlanning = t.needs_planning === true;
  const target = needsPlanning ? roleOf('planner') : roleOf('coder');
  const info = conn()
    .prepare(
      `INSERT INTO orchestrator_tasks
         (title, description, current_role, status, assigned_agent, context_files,
          execution_mode, created_at, updated_at, project)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
    )
    .run(
      title,
      description,
      needsPlanning ? 'planner' : 'coder',
      needsPlanning ? 'PLANNING' : 'QUEUED',
      target.assigned_agent,
      JSON.stringify(files),
      mode,
      now,
      now,
      t.project ?? null
    );
  const id = Number(info.lastInsertRowid);

  orchAudit(id, 'planner', t.agent, 'CREATED', title);
  logActivity({ agent: t.agent, action: 'orch-create', detail: `#${id}: ${title}` });
  emitChange('orchestrator');
  return getOrchTask(id)!;
}

export function deleteOrchTask(id: number, agent: string): boolean {
  const existed = !!conn().prepare('SELECT id FROM orchestrator_tasks WHERE id = ?').get(id);
  if (!existed) return false;
  // audit rows follow via ON DELETE CASCADE (foreign_keys pragma is ON).
  conn().prepare('DELETE FROM orchestrator_tasks WHERE id = ?').run(id);
  logActivity({ agent, action: 'orch-delete', detail: `#${id}` });
  emitChange('orchestrator');
  return true;
}

/**
 * Hand the next available task for `roleKey` to `agentName`, atomically.
 *
 * The UPDATE ... WHERE carries every precondition, so two agents polling
 * simultaneously cannot both win: SQLite serializes the writes and the loser's
 * `changes` is 0. Selecting first and updating after would double-claim.
 */
export interface ClaimResult {
  task: OrchTask | null;
  /** 'ok' | 'empty' (nothing waiting) | 'contended' (lost a race, retry now) */
  reason: 'ok' | 'empty' | 'contended';
  /** How many tasks are waiting for this role right now. */
  queued: number;
  /** Wall-clock ms after which an idle claim may be taken by another agent. */
  claim_expires_at?: number;
}


function assignSeqIfNeeded(d: any, taskId: number) {
  const row = d.prepare('SELECT seq FROM orchestrator_tasks WHERE id = ?').get(taskId) as { seq: number | null } | undefined;
  if (row && row.seq === null) {
    d.prepare(`
      UPDATE orchestrator_tasks 
      SET seq = (SELECT COALESCE(MAX(seq), 0) + 1 FROM orchestrator_tasks) 
      WHERE id = ?
    `).run(taskId);
  }
}

export function claimOrchTask(agentName: string, roleKey: string): ClaimResult {
  const who = String(agentName ?? '').trim();
  if (!who) throw new Error('agent_name is required');
  const role = roleOf(roleKey as RoleKey);
  if (!role.is_enabled) throw new Error(`role "${roleKey}" is disabled`);
  if (role.assigned_agent !== who) {
    throw new Error(
      `role "${roleKey}" is assigned to "${role.assigned_agent}", not "${who}" — ` +
        `either claim your own role or reassign it in the CORTEX Pipeline tab`
    );
  }
  const d = conn();
  const inbox = ROLE_INBOX[role.role_key];
  const claimable = ROLE_CLAIMABLE[role.role_key];
  const placeholders = claimable.map(() => '?').join(',');
  const inboxPlaceholders = inbox.map(() => '?').join(',');
  const staleBefore = Date.now() - CLAIM_STALE_MS;

  const queued = (
    d
      .prepare(
        `SELECT COUNT(*) AS c FROM orchestrator_tasks
          WHERE current_role = ? AND status IN (${inboxPlaceholders}) AND gate_pending = 0`
      )
      .get(role.role_key, ...inbox) as { c: number }
  ).c;

  const claimedId = d.transaction(() => {
    const row = d
      .prepare(
        `SELECT id, status FROM orchestrator_tasks
          WHERE current_role = ? AND status IN (${placeholders}) AND gate_pending = 0
            AND (claimed_by IS NULL OR claimed_at IS NULL OR claimed_at < ?)
          ORDER BY created_at ASC, id ASC LIMIT 1`
      )
      .get(role.role_key, ...claimable, staleBefore) as { id: number; status: OrchStatus } | undefined;
    if (!row) return null;

    // Every precondition rides on the UPDATE, so two agents polling at once
    // cannot both win: SQLite serializes the writes and the loser sees
    // changes === 0. A SELECT-then-UPDATE would double-claim.
    const newStatus = row.status === 'PLANNING' ? 'PLANNING' : ROLE_HOLD_STATUS[role.role_key];
    const res = d
      .prepare(
        `UPDATE orchestrator_tasks
            SET claimed_by = ?, claimed_at = ?, status = ?, updated_at = ?
          WHERE id = ? AND current_role = ? AND status = ? AND gate_pending = 0
            AND (claimed_by IS NULL OR claimed_at IS NULL OR claimed_at < ?)`
      )
      .run(
        who,
        Date.now(),
        newStatus,
        Date.now(),
        row.id,
        role.role_key,
        row.status,
        staleBefore
      );
    if (res.changes === 0) return null;
    if (newStatus === 'IN_PROGRESS') assignSeqIfNeeded(d, row.id);
    return row.id;
  })();

  if (claimedId === null) {
    // Nothing matched at all vs. matched-but-someone-else-took-it: the agent
    // should retry immediately in the second case, back off in the first.
    return { task: null, reason: queued > 0 ? 'contended' : 'empty', queued };
  }
  orchAudit(claimedId, role.role_key, who, 'CLAIMED');
  logActivity({ agent: who, action: 'orch-claim', detail: `#${claimedId} as ${role.role_key}` });
  emitChange('orchestrator');
  return {
    task: getOrchTask(claimedId),
    reason: 'ok',
    queued: Math.max(0, queued - 1),
    claim_expires_at: Date.now() + CLAIM_STALE_MS,
  };
}

export function claimOrchTaskById(agentName: string, taskId: number): ClaimResult {
  const who = String(agentName ?? '').trim();
  if (!who) throw new Error('agent_name is required');
  const d = conn();
  const taskRow = d.prepare('SELECT current_role FROM orchestrator_tasks WHERE id = ?').get(taskId) as { current_role: string } | undefined;
  if (!taskRow) throw new Error(`Task #${taskId} not found`);
  
  const role = roleOf(taskRow.current_role as RoleKey);
  if (!role.is_enabled) throw new Error(`role "${role.role_key}" is disabled`);
  if (role.assigned_agent !== who) {
    throw new Error(
      `role "${role.role_key}" is assigned to "${role.assigned_agent}", not "${who}" — ` +
        `either claim your own role or reassign it in the CORTEX Pipeline tab`
    );
  }

  const inbox = ROLE_INBOX[role.role_key];
  const claimable = ROLE_CLAIMABLE[role.role_key];
  const placeholders = claimable.map(() => '?').join(',');
  const inboxPlaceholders = inbox.map(() => '?').join(',');
  const staleBefore = Date.now() - CLAIM_STALE_MS;

  const queued = (
    d
      .prepare(
        `SELECT COUNT(*) AS c FROM orchestrator_tasks
          WHERE current_role = ? AND status IN (${inboxPlaceholders}) AND gate_pending = 0`
      )
      .get(role.role_key, ...inbox) as { c: number }
  ).c;

  const claimedId = d.transaction(() => {
    const row = d
      .prepare(
        `SELECT id, status FROM orchestrator_tasks
          WHERE id = ? AND current_role = ? AND status IN (${placeholders}) AND gate_pending = 0
            AND (claimed_by IS NULL OR claimed_at IS NULL OR claimed_at < ?)`
      )
      .get(taskId, role.role_key, ...claimable, staleBefore) as { id: number; status: OrchStatus } | undefined;
    if (!row) return null;

    const newStatus = row.status === 'PLANNING' ? 'PLANNING' : ROLE_HOLD_STATUS[role.role_key];
    const res = d
      .prepare(
        `UPDATE orchestrator_tasks
            SET claimed_by = ?, claimed_at = ?, status = ?, updated_at = ?
          WHERE id = ? AND current_role = ? AND status = ? AND gate_pending = 0
            AND (claimed_by IS NULL OR claimed_at IS NULL OR claimed_at < ?)`
      )
      .run(
        who,
        Date.now(),
        newStatus,
        Date.now(),
        row.id,
        role.role_key,
        row.status,
        staleBefore
      );
    if (res.changes === 0) return null;
    if (newStatus === 'IN_PROGRESS') assignSeqIfNeeded(d, row.id);
    return row.id;
  })();

  if (claimedId === null) {
    return { task: null, reason: 'contended', queued };
  }
  orchAudit(claimedId, role.role_key, who, 'CLAIMED');
  logActivity({ agent: who, action: 'orch-claim', detail: `#${claimedId} as ${role.role_key}` });
  emitChange('orchestrator');
  return {
    task: getOrchTask(claimedId),
    reason: 'ok',
    queued: Math.max(0, queued - 1),
    claim_expires_at: Date.now() + CLAIM_STALE_MS,
  };
}

/** Refresh a claim so a long-running agent does not lose its task to the lease. */
export function heartbeatOrchTask(taskId: number, agent: string): { ok: boolean; claim_expires_at: number } {
  const res = conn()
    .prepare('UPDATE orchestrator_tasks SET claimed_at = ? WHERE id = ? AND claimed_by = ?')
    .run(Date.now(), taskId, agent);
  if (res.changes === 0) {
    throw new Error(
      `task #${taskId} is not claimed by "${agent}" — re-claim it before continuing`
    );
  }
  return { ok: true, claim_expires_at: Date.now() + CLAIM_STALE_MS };
}

/**
 * Shared guard for the two "act on a task you hold" tools.
 *
 * Without this, ANY agent could submit as the coder or approve as the planner:
 * checking only current_role lets an unrelated agent skip a review stage,
 * clobber another agent's diff, or write a false audit row under its own name.
 */
function assertHolder(task: OrchTask, agent: string, expectedRole: RoleKey): void {
  // The human operator overrides everything: they drive manual pipelines from
  // the UI, which has no way to "claim" a task. Still audited as 'user'.
  if (agent === 'user') return;
  if (task.status === 'COMPLETED' || task.status === 'FAILED') {
    throw new Error(`task #${task.id} is ${task.status} and accepts no more work`);
  }
  if (task.gate_pending) {
    throw new Error(
      `task #${task.id} is waiting for the user to release a manual gate — do not act on it yet`
    );
  }
  if (task.current_role !== expectedRole) {
    throw new Error(
      `task #${task.id} is at role "${task.current_role}", not "${expectedRole}"` +
        (task.current_role === 'coder'
          ? ' — use cortex_orchestrator_submit_work'
          : ' — use cortex_orchestrator_review_task')
    );
  }
  const owner = roleOf(expectedRole).assigned_agent;
  if (task.claimed_by !== agent && agent !== owner) {
    throw new Error(
      `task #${task.id} is held by "${task.claimed_by ?? 'nobody'}" and role "${expectedRole}" ` +
        `belongs to "${owner}" — claim it first with cortex_orchestrator_claim_task`
    );
  }
}

/** Coder submits its work; the pipeline advances (or stops at a manual gate). */
export function submitOrchWork(
  taskId: number,
  diffPayload: string,
  summary: string,
  agent: string
): OrchTask {
  const task = getOrchTask(taskId);
  if (!task) throw new Error('task not found');
  assertHolder(task, agent, 'coder');
  const diff = String(diffPayload ?? '');
  // Loopback-only server, but an agent can still stream something enormous into
  // SQLite; cap it rather than bloating the DB.
  if (diff.length > 400_000) throw new Error('diff_payload too large (max 400000 chars)');

  // Deterministic security gate on EVERY hand-off: agents pass diffs and
  // feedback to each other, so this is the transport an injected instruction
  // or a leaked secret would travel on. Findings are attached rather than
  // blocking — the reviewer decides, but never unknowingly.
  const scan = scanText(diff + '\n' + (summary ?? ''));
  const scanNote =
    scan.findings.length > 0
      ? '\n\n[GUARDRAIL] ' +
        scan.findings
          .slice(0, 8)
          .map((f) => `${f.severity.toUpperCase()} ${f.kind} (line ${f.line}): ${f.advice}`)
          .join('\n')
      : '';
  conn()
    .prepare('UPDATE orchestrator_tasks SET diff_payload = ?, feedback = ?, updated_at = ? WHERE id = ?')
    .run(diff, (task.feedback ?? '') + scanNote, Date.now(), taskId);
  if (scan.findings.length > 0) {
    orchAudit(
      taskId,
      'security',
      'cortex-guardrail',
      'REJECTED',
      `Automated scan: ${scan.findings.length} finding(s) (${scan.findings.filter((f) => f.severity === 'high').length} high severity)`
    );
  }

  const to = nextHop('coder');
  const gated = needsGate(task, 'coder');
  applyHop(taskId, 'coder', to, gated);

  orchAudit(taskId, 'coder', agent, 'SUBMITTED', summary || null);
  logActivity({
    agent,
    action: 'orch-submit',
    detail: `#${taskId} → ${gated ? `gate(${to.role})` : to.role}`,
  });
  emitChange('orchestrator');
  return getOrchTask(taskId)!;
}

/** Security / QA / planner verdict. APPROVED advances, REJECTED returns to coder. */
export function reviewOrchTask(
  taskId: number,
  verdict: string,
  feedback: string,
  agent: string
): OrchTask {
  const task = getOrchTask(taskId);
  if (!task) throw new Error('task not found');
  if (task.current_role === 'coder') {
    throw new Error(
      `task #${taskId} is with the coder — use cortex_orchestrator_submit_work, not review_task`
    );
  }
  assertHolder(task, agent, task.current_role);
  const v = String(verdict ?? '').toUpperCase();
  if (v !== 'APPROVED' && v !== 'REJECTED') {
    throw new Error('status must be "APPROVED" or "REJECTED"');
  }
  const from = task.current_role;
  const now = Date.now();

  if (v === 'REJECTED') {
    if (!feedback || !feedback.trim()) {
      throw new Error('feedback is required when rejecting — the coder needs to know what to fix');
    }
    const rejects = task.reject_count + 1;
    if (rejects >= MAX_REJECTS) {
      // Bound the coder<->reviewer loop instead of cycling forever.
      conn()
        .prepare(
          `UPDATE orchestrator_tasks
             SET status = 'FAILED', feedback = ?, reject_count = ?, claimed_by = NULL,
                 claimed_at = NULL, gate_pending = 0, pending_role = NULL, pending_status = NULL,
                 updated_at = ? WHERE id = ?`
        )
        .run(
          `${feedback}\n\n[CORTEX] failed after ${rejects} rejections — needs human intervention.`,
          rejects,
          now,
          taskId
        );
      orchAudit(taskId, from, agent, 'REJECTED', feedback);
      logActivity({ agent, action: 'orch-failed', detail: `#${taskId} after ${rejects} rejections` });
      emitChange('orchestrator');
      return getOrchTask(taskId)!;
    }
    const autoBlocked = agent.trim().toLowerCase() === 'user' ? 1 : 0;
    conn()
      .prepare(
        `UPDATE orchestrator_tasks
           SET current_role = 'coder', status = 'QUEUED', assigned_agent = ?, feedback = ?,
               reject_count = ?, claimed_by = NULL, claimed_at = NULL, gate_pending = 0,
               pending_role = NULL, pending_status = NULL, auto_blocked = ?, updated_at = ? WHERE id = ?`
      )
      .run(roleOf('coder').assigned_agent, feedback, rejects, autoBlocked, now, taskId);
    orchAudit(taskId, from, agent, 'REJECTED', feedback);
    logActivity({ agent, action: 'orch-reject', detail: `#${taskId} back to coder (${rejects}/${MAX_REJECTS})` });
    emitChange('orchestrator');
    return getOrchTask(taskId)!;
  }

  // APPROVED
  if (from === 'planner' && task.status === 'PLANNING') {
    // The planner finished breaking the goal down — dispatch to the coder.
    // This is the spec's "Planner sets status to QUEUED, advances to coder".
    const coder = roleOf('coder');
    conn()
      .prepare(
        `UPDATE orchestrator_tasks
           SET current_role = 'coder', status = 'QUEUED', assigned_agent = ?, feedback = ?,
               claimed_by = NULL, claimed_at = NULL, updated_at = ? WHERE id = ?`
      )
      .run(coder.assigned_agent, feedback || null, now, taskId);
    orchAudit(taskId, 'planner', agent, 'APPROVED', feedback || 'dispatched to coder');
    logActivity({ agent, action: 'orch-dispatch', detail: `#${taskId} → coder` });
    emitChange('orchestrator');
    return getOrchTask(taskId)!;
  }
  if (from === 'planner') {
    conn()
      .prepare(
        `UPDATE orchestrator_tasks
           SET status = 'COMPLETED', feedback = ?, claimed_by = NULL, claimed_at = NULL,
               gate_pending = 0, pending_role = NULL, pending_status = NULL, updated_at = ?
         WHERE id = ?`
      )
      .run(feedback || null, now, taskId);
    orchAudit(taskId, from, agent, 'APPROVED', feedback || null);
    logActivity({ agent, action: 'orch-complete', detail: `#${taskId}: ${task.title}` });
    emitChange('orchestrator');
    return getOrchTask(taskId)!;
  }

  const to = nextHop(from);
  const gated = needsGate(task, from);
  conn().prepare('UPDATE orchestrator_tasks SET feedback = ? WHERE id = ?').run(feedback || null, taskId);
  applyHop(taskId, from, to, gated);
  orchAudit(taskId, from, agent, 'APPROVED', feedback || null);
  logActivity({
    agent,
    action: 'orch-approve',
    detail: `#${taskId} → ${gated ? `gate(${to.role})` : to.role}`,
  });
  emitChange('orchestrator');
  return getOrchTask(taskId)!;
}

/** Human releases a manual gate: apply the hop that was held back. */
export function releaseOrchGate(taskId: number, agent: string): OrchTask {
  const task = getOrchTask(taskId);
  if (!task) throw new Error('task not found');
  if (!task.gate_pending || !task.pending_role || !task.pending_status) {
    throw new Error(`task #${taskId} is not waiting at a gate`);
  }
  // pending_role is a display hint, not routing truth: the user may have
  // disabled that role while the task sat at the gate.
  const to = roleOf(task.pending_role).is_enabled
    ? { role: task.pending_role, status: task.pending_status }
    : nextHop(task.current_role);
  conn()
    .prepare(
      `UPDATE orchestrator_tasks
         SET current_role = ?, status = ?, assigned_agent = ?, gate_pending = 0,
             pending_role = NULL, pending_status = NULL, claimed_by = NULL,
             claimed_at = NULL, updated_at = ? WHERE id = ?`
    )
    .run(to.role, to.status, roleOf(to.role).assigned_agent, Date.now(), taskId);
  orchAudit(taskId, task.current_role, agent, 'APPROVED', `gate released → ${to.role}`);
  logActivity({ agent, action: 'orch-gate', detail: `#${taskId} → ${to.role}` });
  emitChange('orchestrator');
  return getOrchTask(taskId)!;
}

/**
 * Release a task back to its role's inbox: clears the claim so anyone assigned
 * to that role can pick it up again. The escape hatch for a claim taken by the
 * wrong agent, or an agent that stopped without submitting — without it the
 * only recovery is waiting out the 30-minute lease or deleting the task.
 */
export function requeueOrchTask(taskId: number, agent: string, reason?: string): OrchTask {
  const task = getOrchTask(taskId);
  if (!task) throw new Error('task not found');
  if (task.status === 'COMPLETED') throw new Error(`task #${taskId} is COMPLETED`);
  const inbox = ROLE_INBOX[task.current_role][0];
  conn()
    .prepare(
      `UPDATE orchestrator_tasks
         SET status = ?, claimed_by = NULL, claimed_at = NULL, gate_pending = 0,
             pending_role = NULL, pending_status = NULL,
             reject_count = CASE WHEN status = 'FAILED' THEN 0 ELSE reject_count END,
             updated_at = ? WHERE id = ?`
    )
    .run(inbox, Date.now(), taskId);
  orchAudit(taskId, task.current_role, agent, 'CREATED', reason || 'requeued');
  logActivity({ agent, action: 'orch-requeue', detail: `#${taskId} → ${task.current_role}/${inbox}` });
  emitChange('orchestrator');
  return getOrchTask(taskId)!;
}

/** Put a FAILED task back in front of the coder (reset the rejection budget). */
export function retryOrchTask(taskId: number, agent: string): OrchTask {
  const task = getOrchTask(taskId);
  if (!task) throw new Error('task not found');
  if (task.status !== 'FAILED') throw new Error(`task #${taskId} is not FAILED`);
  conn()
    .prepare(
      `UPDATE orchestrator_tasks
         SET current_role = 'coder', status = 'QUEUED', assigned_agent = ?, reject_count = 0,
             claimed_by = NULL, claimed_at = NULL, updated_at = ? WHERE id = ?`
    )
    .run(roleOf('coder').assigned_agent, Date.now(), taskId);
  orchAudit(taskId, 'coder', agent, 'CREATED', 'retried after FAILED');
  logActivity({ agent, action: 'orch-retry', detail: `#${taskId}` });
  emitChange('orchestrator');
  return getOrchTask(taskId)!;
}

/** Everything an agent needs to act on a task it holds, in one call. */
export function orchTaskBrief(taskId: number): {
  task: OrchTask;
  audit: OrchAuditRow[];
  pipeline: PipelineRole[];
  /** Every verdict ever given on this task, oldest first. `task.feedback` only
   *  holds the newest one, so a reviewer would otherwise never see the history
   *  of what was already asked for and (not) fixed. */
  feedback_history: { role_key: string; agent_name: string; action: string; comment: string; timestamp: number }[];
  active_dispatch_task?: { task_id: number; title?: string };
} | null {
  const task = getOrchTask(taskId);
  if (!task) return null;
  const audit = getOrchAudit(taskId);
  return {
    task,
    audit,
    pipeline: getPipelineConfig(),
    active_dispatch_task: getActiveDispatchTask(),
    feedback_history: audit
      .filter((a) => (a.action === 'REJECTED' || a.action === 'APPROVED') && a.comment)
      .map((a) => ({
        role_key: a.role_key,
        agent_name: a.agent_name,
        action: a.action,
        comment: a.comment as string,
        timestamp: a.timestamp,
      })),
  };
}

/** Which roles a given agent name is allowed to act as. */
export function rolesForAgent(agentName: string): RoleKey[] {
  return getPipelineConfig()
    .filter((r) => r.is_enabled && r.assigned_agent === agentName)
    .map((r) => r.role_key);
}

export function startDispatchLaunch(taskId: number, roleKey: string): number {
  return conn()
    .prepare('INSERT INTO dispatch_launches(task_id, role_key, launched_at, status) VALUES (?, ?, ?, ?)')
    .run(taskId, roleKey, Date.now(), 'launching').lastInsertRowid as number;
}

export function completeDispatchLaunch(launchId: number, status: string, conversationId?: string, errorStr?: string): void {
  conn()
    .prepare('UPDATE dispatch_launches SET status = ?, conversation_id = ?, error = ? WHERE id = ?')
    .run(status, conversationId || null, errorStr || null, launchId);
}

export function isTaskDispatchActive(taskId: number): boolean {
  const row = conn()
    .prepare('SELECT launched_at FROM dispatch_launches WHERE task_id = ? AND status IN (?, ?) ORDER BY launched_at DESC LIMIT 1')
    .get(taskId, 'launching', 'active') as { launched_at: number } | undefined;
  if (!row) return false;
  return (Date.now() - row.launched_at) < 15 * 60 * 1000;
}


export const MAX_CONCURRENT_DISPATCH = 1;

export function getActiveDispatchTask(): { task_id: number, title?: string } | undefined {
  const row = conn()
    .prepare("SELECT task_id FROM dispatch_launches WHERE status IN ('launching', 'active') ORDER BY launched_at DESC LIMIT 1")
    .get() as { task_id: number } | undefined;
  if (!row) return undefined;
  
  const taskRow = conn()
    .prepare("SELECT title FROM orchestrator_tasks WHERE id = ?")
    .get(row.task_id) as { title: string } | undefined;
    
  return { task_id: row.task_id, title: taskRow?.title };
}

export function getActiveDispatchLaunchesCount(): number {

  const row = conn()
    .prepare("SELECT COUNT(*) AS count FROM dispatch_launches WHERE status IN ('launching', 'active')")
    .get() as { count: number };
  return row.count;
}

export function closeTaskDispatchLaunches(taskId: number, status: string, errorStr?: string): void {
  if (errorStr) {
    conn()
      .prepare("UPDATE dispatch_launches SET status = ?, error = ? WHERE task_id = ? AND status IN ('launching', 'active')")
      .run(status, errorStr, taskId);
  } else {
    conn()
      .prepare("UPDATE dispatch_launches SET status = ? WHERE task_id = ? AND status IN ('launching', 'active')")
      .run(status, taskId);
  }
}

export function cleanupAbandonedDispatchLaunches(timeoutMs: number): { taskId: number, agent: string | null, held: boolean }[] {
  const cutoff = Date.now() - timeoutMs;
  const abandoned = conn().prepare(`
    SELECT d.id as launch_id, d.task_id, t.claimed_by, t.status as task_status, t.current_role
    FROM dispatch_launches d
    JOIN orchestrator_tasks t ON t.id = d.task_id
    WHERE d.status IN ('launching', 'active') AND d.launched_at < ?
  `).all(cutoff) as { launch_id: number, task_id: number, claimed_by: string | null, task_status: string, current_role: RoleKey }[];
  
  if (abandoned.length > 0) {
    const updateStmt = conn().prepare("UPDATE dispatch_launches SET status = 'abandoned' WHERE id = ?");
    for (const r of abandoned) {
      updateStmt.run(r.launch_id);
    }
  }
  
  return abandoned.map(r => ({
    taskId: r.task_id,
    agent: r.claimed_by,
    held: r.claimed_by !== null && r.task_status === ROLE_HOLD_STATUS[r.current_role]
  }));
}

// ---------------------------------------------------------------------------
// Backend wiring for MCP tools
// ---------------------------------------------------------------------------

export const dbBackend: Omit<CortexBackend, 'findSimilar' | 'listSkills' | 'getSkill'> = {
  listNotes: () => listNotes(),
  readNote: (p: string) => readNote(p),
  writeNote: (p: string, c: string, agent: string) => writeNote(p, c, agent),
  appendNote: (p: string, c: string, agent: string) => appendNote(p, c, agent),
  // Boolean end-to-end so cortex_delete_note reports missing notes truthfully.
  deleteNote: (p: string, agent: string) => deleteNote(p, agent),
  search: (q: string) => searchNotes(q),
  getTasks: () => getTasks(),
  addTask: (t: { text: string; assignee?: string; status?: string; project?: string; agent: string }) => addTask(t),
  updateTask: (
    id: string,
    patch: { status?: string; assignee?: string; text?: string; project?: string | null },
    agent: string
  ) => updateTask(id, patch, agent),
  deleteTask: (id: string, agent: string) => deleteTask(id, agent),
  getProtocol: () => getProtocol(),
  addProtocol: (t: { kind: string; title: string; body?: string; agent: string }) => addProtocol(t),
  getActivity: (limit?: number) => getActivity(limit ?? 100),
  log: (message: string, agent: string) => {
    logActivity({ agent, action: 'log', detail: message });
    return { ok: true };
  },
  orchCreateTask: (t: {
    title: string;
    description: string;
    context_files?: string[];
    execution_mode?: string;
    project?: string;
    agent: string;
  }) => createOrchTask(t),
  orchClaimTask: (agentName: string, roleKey: string) => claimOrchTask(agentName, roleKey),
  orchWaitForTask: async (agentName: string, roleKey: string, timeoutSeconds: number) => {
    const tSec = Math.max(1, Math.min(timeoutSeconds, 90));
    const attempt = claimOrchTask(agentName, roleKey);
    if (attempt && attempt.task) return attempt;
    return new Promise((resolve, reject) => {
      let timeoutId: NodeJS.Timeout;
      const onEvent = (ev: {type?: string}) => {
        if (ev.type === 'orchestrator') {
          try {
            const res = claimOrchTask(agentName, roleKey);
            if (res && res.task) {
              cleanup();
              resolve(res);
            }
          } catch (e) {
            cleanup();
            reject(e);
          }
        }
      };
      const cleanup = () => {
        clearTimeout(timeoutId);
        dbEvents.off('change', onEvent);
      };
      timeoutId = setTimeout(() => {
        cleanup();
        resolve({ task: null, reason: 'timeout' });
      }, tSec * 1000);
      dbEvents.on('change', onEvent);
    });
  },
  orchSubmitWork: (taskId: number, diff: string, summary: string, agent: string) =>
    submitOrchWork(taskId, diff, summary, agent),
  orchReviewTask: (taskId: number, verdict: string, feedback: string, agent: string) =>
    reviewOrchTask(taskId, verdict, feedback, agent),
  orchStatus: (agentName: string) => ({
    // Without `you`/`your_roles` an agent cannot discover its own role_key and
    // has to guess it, which claim_task then rejects.
    you: agentName,
    your_roles: rolesForAgent(agentName),
    pipeline: getPipelineConfig(),
    tasks: listOrchTasks(50),
  }),
  orchGetTask: (taskId: number) => orchTaskBrief(taskId),
  orchHeartbeat: (taskId: number, agent: string) => heartbeatOrchTask(taskId, agent),
  askLocalModel: async (prompt: string, context?: string) => {
    const s = getSettings();
    const messages = context
      ? [
          { role: 'system' as const, content: context },
          { role: 'user' as const, content: prompt },
        ]
      : [{ role: 'user' as const, content: prompt }];
    return chatOnce(messages, {
      provider: s.ai_provider,
      gen_model_path: s.ai_gen_model_path,
      embed_model_path: s.ai_embed_model_path,
      cloud_base_url: s.ai_cloud_base_url,
      cloud_model: s.ai_cloud_model,
      apiKey: decryptApiKey(s.ai_cloud_api_key_enc),
    });
  },
};

export function getConsecutiveFailures(taskId: number): number {
  const launches = conn()
    .prepare('SELECT status FROM dispatch_launches WHERE task_id = ? ORDER BY launched_at DESC LIMIT 2')
    .all(taskId) as { status: string }[];
  let fails = 0;
  for (const l of launches) {
    if (l.status === 'failed') fails++;
    else break;
  }
  return fails;
}

export function getTaskCooldownTime(taskId: number): number {
  const row = conn()
    .prepare("SELECT launched_at FROM dispatch_launches WHERE task_id = ? AND status IN ('failed', 'cancelled', 'abandoned') ORDER BY launched_at DESC LIMIT 1")
    .get(taskId) as { launched_at: number } | undefined;
  if (!row) return 0;
  return row.launched_at;
}

export function moveOrchTaskManually(taskId: number, targetColumn: string, agent: string): OrchTask {
  const task = getOrchTask(taskId);
  if (!task) throw new Error('task not found');

  if (isTaskDispatchActive(taskId)) {
    throw new Error('Cannot move task while dispatch is active');
  }

  let newStatus: OrchStatus;
  let newRole: RoleKey = task.current_role;

  if (targetColumn === 'TODO') {
    newStatus = 'QUEUED';
    newRole = 'coder';
  } else if (targetColumn === 'IN_PROGRESS' || targetColumn === 'IN PROGRESS') {
    newStatus = 'IN_PROGRESS';
    newRole = 'coder';
  } else if (targetColumn === 'REVIEW') {
    const pipeline = getPipelineConfig();
    const securityActive = pipeline.find(r => r.role_key === 'security')?.is_enabled;
    const qaActive = pipeline.find(r => r.role_key === 'qa')?.is_enabled;
    if (securityActive) {
      newStatus = 'SECURITY_REVIEW';
      newRole = 'security';
    } else if (qaActive) {
      newStatus = 'QA_REVIEW';
      newRole = 'qa';
    } else {
      newStatus = 'FINAL_REVIEW';
      newRole = 'planner';
    }
  } else if (targetColumn === 'DONE') {
    newStatus = 'COMPLETED';
    newRole = 'planner';
  } else {
    throw new Error('unknown target column');
  }

  conn().transaction(() => {
    conn()
      .prepare(
        `UPDATE orchestrator_tasks
         SET status = ?, current_role = ?, claimed_by = NULL, claimed_at = NULL,
             gate_pending = 0, pending_role = NULL, pending_status = NULL,
             updated_at = ?
         WHERE id = ?`
      )
      .run(newStatus, newRole, Date.now(), taskId);
    if (newStatus === 'IN_PROGRESS') {
      assignSeqIfNeeded(conn(), taskId);
    }
  })();

  logActivity({
    agent,
    action: 'orch-moved-manually',
    path: null,
    detail: `Manually moved task #${taskId} to ${targetColumn}`
  });

  orchAudit(taskId, newRole, agent, 'MOVED_MANUALLY', `Moved to ${targetColumn}`);
  
  emitChange('orchestrator');
  return getOrchTask(taskId)!;
}




export function moveOrchTaskProject(taskId: number, project: string | null, agent: string): OrchTask {
  const task = getOrchTask(taskId);
  if (!task) throw new Error('task not found');

  if (project !== null) {
    if (!isProjectPath(project)) {
      throw new Error('invalid project path');
    }
    const res = conn().prepare('SELECT 1 FROM notes WHERE path = ?').get(project);
    if (!res) {
      throw new Error('project note does not exist');
    }
  }

  const oldProject = task.project;
  
  conn()
    .prepare('UPDATE orchestrator_tasks SET project = ?, updated_at = ? WHERE id = ?')
    .run(project, Date.now(), taskId);

  logActivity({
    agent,
    action: 'orch-moved-project',
    path: null,
    detail: `Moved task #${taskId} from ${oldProject || 'No Project'} to ${project || 'No Project'}`
  });

  emitChange('orchestrator');
  return getOrchTask(taskId)!;
}
