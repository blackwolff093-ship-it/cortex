import { listSkills, getSkillByName, importFromGithub, importFromFolder, rescanSkills } from "./skills";
import { runTypeCheck, verifyDiffApplied } from './build-gate';
// CORTEX — embedded HTTP server (REST + MCP + SSE + static UI)
// Runs inside the Electron main process.
import express from 'express';
import { dispatchTask } from './agentapi';
import type { Request, Response, NextFunction } from 'express';
import type { Server } from 'node:http';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { mountHttpMcp } from './mcp-tools';
import { moveOrchTaskManually, moveOrchTaskProject, setOrchTaskAgents } from './db';
import { stopOrchTask } from './dispatcher';
import {
  dbBackend,
  dbEvents,
  getDbPath,
  getSettings,
  setSetting,
  listNotes,
  readNote,
  writeNote,
  appendNote,
  deleteNote,
  deleteFolder,
  renameNote,
  searchNotes,
  getGraph,
  getOrchTask,
  getTasks,
  addTask,
  updateTask,
  deleteTask,
  getProtocol,
  addProtocol,
  updateProtocol,
  deleteProtocol,
  getActivity,
  logActivity,
  mirrorSync,
  getPipelineConfig,
  updatePipelineRole,
  listOrchTasks,
  orchTaskBrief,
  createOrchTask,
  deleteOrchTask,
  isTaskDispatchActive,
  claimOrchTask,
  claimOrchTaskById,
  submitOrchWork,
  reviewOrchTask,
  releaseOrchGate,
  requeueOrchTask,
  retryOrchTask,
  heartbeatOrchTask,
  rolesForAgent,
  conn,
} from './db';
import {
  chatOnce,
  decryptApiKey,
  downloadModel,
  encryptApiKey,
  getAiStatus,
  reloadModel,
  setAiConfig,
  type AiSettings,
  type ChatMessage,
} from './ai';
import {
  findDuplicates,
  findSimilar,
  gatherForTopic,
  getIndexStatus,
  hybridSearch,
  rebuildIndex,
  similarChunkPairs,
} from './semantic';
import {
  composeDocs,
  generateMockData,
  generatePlan,
  judgeConflict,
  rollupContext,
  scanPending,
  scanText,
} from './librarian';

/** Uniform error-message extraction for the async (non-`handle`) routes. */
function errMsg(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

export interface StartServerOpts {
  port: number;
  distDir: string;
  rootDir: string;
  stdioPath: string;
  packaged: boolean;
}

const SSE_DEBOUNCE_MS = 250;
const SSE_HEARTBEAT_MS = 25_000;

/** Max stored length of an agent identity. Anything longer is truncated rather
 *  than rejected: the identity is only a label, but it is written to the
 *  `activity` log on every single call, so an unbounded value lets one agent
 *  bloat the database (and every ACTIVITY render) with a megabyte-long name. */
const MAX_AGENT_NAME = 32;

/** Agent identity for a request: body.agent || query.agent || X-Agent header || "user". */
function agentOf(req: Request): string {
  const body = (req.body ?? {}) as Record<string, unknown>;
  const fromBody = typeof body.agent === 'string' ? body.agent : '';
  const fromQuery = typeof req.query.agent === 'string' ? req.query.agent : '';
  let fromHeader = req.header('x-agent') ?? '';
  // The stdio proxy percent-encodes the header so non-Latin1 names (e.g. Arabic) survive fetch.
  try {
    fromHeader = decodeURIComponent(fromHeader);
  } catch {
    /* keep raw value */
  }
  const raw = (fromBody || fromQuery || fromHeader || 'user').trim() || 'user';
  // Strip control characters too — the name lands in log lines and the UI.
  // eslint-disable-next-line no-control-regex
  const clean = raw.replace(/[\u0000-\u001f\u007f]/g, '').trim();
  if (clean === '') return 'user';
  // Slice by code points, not UTF-16 units, so a 32-char cut never splits an
  // Arabic grapheme or an emoji into an invalid half.
  return [...clean].slice(0, MAX_AGENT_NAME).join('');
}

function qs(req: Request, name: string): string {
  const v = req.query[name];
  return typeof v === 'string' ? v : '';
}

/** Wrap a sync handler with JSON error responses ({error} 400/404/500). */
function handle(fn: (req: Request, res: Response) => void) {
  return (req: Request, res: Response) => {
    try {
      fn(req, res);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      const status = /not found/i.test(msg) ? 404 : 400;
      res.status(status).json({ error: msg });
    }
  };
}

export function startServer(opts: StartServerOpts): Promise<Server> {
  const app = express();
  const startedAt = Date.now();

  // --- Local-only access control -------------------------------------------
  // The server binds to 127.0.0.1 and additionally rejects requests whose Host
  // is not a local one (blocks DNS-rebinding) and browser requests from foreign
  // origins (a hostile web page must not be able to read or mutate the vault).
  // Non-browser clients (MCP CLIs, curl, the Electron shell) send no Origin.
  const localHost = new RegExp(`^(localhost|127\\.0\\.0\\.1|\\[::1\\])(:${opts.port})?$`, 'i');
  const okOrigin = (origin: string): boolean => {
    const m = /^http:\/\/(localhost|127\.0\.0\.1|\[::1\]):(\d+)$/i.exec(origin);
    if (!m) return false;
    const p = Number(m[2]);
    return p === opts.port || p === 5173;
  };
  app.use((req: Request, res: Response, next: NextFunction) => {
    if (!localHost.test(req.headers.host ?? '')) {
      res.status(403).json({ error: 'forbidden host' });
      return;
    }
    const origin = req.headers.origin;
    if (typeof origin === 'string' && origin !== 'null' && !okOrigin(origin)) {
      res.status(403).json({ error: 'forbidden origin' });
      return;
    }
    if (typeof origin === 'string' && okOrigin(origin)) {
      res.setHeader('Access-Control-Allow-Origin', origin);
      res.setHeader('Vary', 'Origin');
      res.setHeader(
        'Access-Control-Allow-Headers',
        'Content-Type,X-Agent,mcp-session-id,mcp-protocol-version'
      );
      res.setHeader('Access-Control-Allow-Methods', 'GET,POST,PUT,PATCH,DELETE,OPTIONS');
    }
    if (req.method === 'OPTIONS') {
      res.status(204).end();
      return;
    }
    next();
  });

  // --- MCP first (raw body stream — no json parser on /mcp) ---------------
  // findSimilar is grafted on here rather than inside db.ts: it needs
  // semantic.ts, and db.ts must not import semantic.ts (cycle).
  mountHttpMcp(app, {
    ...dbBackend,
    findSimilar: (p: string) => findSimilar(p, 6),
    search: (q: string) => hybridSearch(q).catch(() => searchNotes(q)),
    listSkills: () => listSkills(),
    getSkill: (name: string) => getSkillByName(name),
  });

  // --- REST API ------------------------------------------------------------
  app.use('/api', express.json({ limit: '10mb' }));

  app.get(
    '/api/status',
    handle((_req, res) => {
      res.json({
        name: 'CORTEX',
        version: '1.0.0',
        port: opts.port,
        db: getDbPath(),
        root: opts.rootDir,
        stdioPath: opts.stdioPath,
        packaged: opts.packaged,
        noteCount: listNotes().length,
        uptime: Math.floor((Date.now() - startedAt) / 1000),
        mirror: getSettings(),
      });
    })
  );

  // Notes
  app.get(
    '/api/notes',
    handle((_req, res) => {
      res.json(listNotes());
    })
  );

  app.get(
    '/api/note',
    handle((req, res) => {
      const note = readNote(qs(req, 'path'));
      if (!note) {
        res.status(404).json({ error: 'note not found' });
        return;
      }
      res.json(note);
    })
  );

  app.put(
    '/api/note',
    handle((req, res) => {
      const body = (req.body ?? {}) as { content?: unknown };
      if (typeof body.content !== 'string') {
        res.status(400).json({
          error: 'body must be JSON {"content": "..."} with Content-Type: application/json',
        });
        return;
      }
      res.json(writeNote(qs(req, 'path'), body.content, agentOf(req)));
    })
  );

  app.post(
    '/api/note/append',
    handle((req, res) => {
      const body = (req.body ?? {}) as { content?: unknown };
      if (typeof body.content !== 'string') {
        res.status(400).json({
          error: 'body must be JSON {"content": "..."} with Content-Type: application/json',
        });
        return;
      }
      res.json(appendNote(qs(req, 'path'), body.content, agentOf(req)));
    })
  );

  app.delete(
    '/api/note',
    handle((req, res) => {
      const deleted = deleteNote(qs(req, 'path'), agentOf(req));
      if (!deleted) {
        res.status(404).json({ error: 'note not found' });
        return;
      }
      res.json({ ok: true });
    })
  );

  app.delete(
    '/api/notes/folder',
    handle((req, res) => {
      const folderPath = qs(req, 'path');
      if (!folderPath) {
        res.status(400).json({ error: 'path is required' });
        return;
      }
      res.json(deleteFolder(folderPath, agentOf(req)));
    })
  );

  app.post(
    '/api/note/rename',
    handle((req, res) => {
      const body = (req.body ?? {}) as { from?: unknown; to?: unknown };
      if (typeof body.from !== 'string' || typeof body.to !== 'string') {
        res.status(400).json({ error: 'from and to are required' });
        return;
      }
      res.json(renameNote(body.from, body.to, agentOf(req)));
    })
  );

  // mode=hybrid (default) fuses FTS5 + semantic via RRF; keyword = old behaviour.
  app.get('/api/search', (req: Request, res: Response) => {
    const q = qs(req, 'q');
    const mode = qs(req, 'mode') || 'hybrid';
    if (mode === 'keyword') {
      res.json(searchNotes(q));
      return;
    }
    void hybridSearch(q, mode === 'semantic' ? 'semantic' : 'hybrid')
      .then((rows) => res.json(rows))
      // Semantic needs a loaded embedding model; degrade to keyword instead of
      // failing the user's search outright.
      .catch(() => res.json(searchNotes(q)));
  });

  app.get(
    '/api/graph',
    handle((_req, res) => {
      res.json(getGraph());
    })
  );

  // Tasks
  app.get(
    '/api/tasks',
    handle((_req, res) => {
      res.json(getTasks());
    })
  );

  app.get(
    '/api/tasks/unified',
    handle((_req, res) => {
      const kanban = getTasks().columns;
      const orchTasks = listOrchTasks(1000);

      type UnifiedTask = {
        id: string; text: string; assignee: string | null; status: string;
        position: number; created: number; updated: number; project: string | null;
        source: 'kanban' | 'pipeline';
        orch_id?: number; current_role?: string; orch_status?: string;
        claimed_by?: string | null; assigned_agent?: string; reject_count?: number;
        dispatch_status?: string | null; dispatch_conv_id?: string | null; dispatch_launched_at?: number | null; auto_blocked?: boolean;
        seq?: number | null; dispatch_error?: string | null;
      };

      const mapped: Record<string, UnifiedTask[]> = {
        'TODO': kanban['TODO'].map((t) => ({ ...t, source: 'kanban' as const })),
        'IN PROGRESS': kanban['IN PROGRESS'].map((t) => ({ ...t, source: 'kanban' as const })),
        'REVIEW': kanban['REVIEW'].map((t) => ({ ...t, source: 'kanban' as const })),
        'DONE': kanban['DONE'].map((t) => ({ ...t, source: 'kanban' as const }))
      };

      for (const t of orchTasks) {
        let col = 'TODO';
        if (t.status === 'IN_PROGRESS') col = 'IN PROGRESS';
        else if (t.status === 'SECURITY_REVIEW' || t.status === 'QA_REVIEW' || t.status === 'FINAL_REVIEW') col = 'REVIEW';
        else if (t.status === 'COMPLETED' || t.status === 'FAILED') col = 'DONE';

        mapped[col].push({
          id: String(t.id),
          text: t.title,
          assignee: t.claimed_by || t.assigned_agent || null,
          status: col,
          position: 0,
          created: t.created_at,
          updated: t.updated_at,
          project: t.project,
          source: 'pipeline',
          orch_id: t.id,
          current_role: t.current_role,
          orch_status: t.status,
          claimed_by: t.claimed_by,
          assigned_agent: t.assigned_agent,
          reject_count: t.reject_count,
          dispatch_status: t.dispatch_status,
          dispatch_conv_id: t.dispatch_conv_id,
          dispatch_launched_at: t.dispatch_launched_at,
          seq: t.seq,
          auto_blocked: t.auto_blocked
        });
      }

      res.json({ columns: mapped });
    })
  );

  app.post(
    '/api/tasks',
    handle((req, res) => {
      const body = (req.body ?? {}) as { text?: unknown; assignee?: unknown; status?: unknown; project?: unknown };
      if (typeof body.text !== 'string' || !body.text.trim()) {
        res.status(400).json({ error: 'text is required' });
        return;
      }
      res.json(
        addTask({
          text: body.text,
          assignee: typeof body.assignee === 'string' ? body.assignee : undefined,
          status: typeof body.status === 'string' ? body.status : undefined,
          project: typeof body.project === 'string' ? body.project : undefined,
          agent: agentOf(req),
        })
      );
    })
  );

  app.patch(
    '/api/task',
    handle((req, res) => {
      const id = qs(req, 'id');
      if (!id) {
        res.status(400).json({ error: 'id is required' });
        return;
      }
      const body = (req.body ?? {}) as { status?: unknown; assignee?: unknown; text?: unknown; project?: unknown };
      const patch: { status?: string; assignee?: string | null; text?: string; project?: string | null } = {};
      if (typeof body.status === 'string') patch.status = body.status;
      if (typeof body.assignee === 'string' || body.assignee === null) patch.assignee = body.assignee || null;
      if (typeof body.text === 'string') patch.text = body.text;
      if (typeof body.project === 'string' || body.project === null) patch.project = body.project || null;
      res.json(updateTask(id, patch, agentOf(req)));
    })
  );

  app.delete(
    '/api/task',
    handle((req, res) => {
      const id = qs(req, 'id');
      if (!id) {
        res.status(400).json({ error: 'id is required' });
        return;
      }
      if (!deleteTask(id, agentOf(req))) {
        res.status(404).json({ error: 'task not found' });
        return;
      }
      res.json({ ok: true });
    })
  );

  // Protocol (rules + skills)
  app.get(
    '/api/protocol',
    handle((_req, res) => {
      res.json(getProtocol());
    })
  );

  app.post(
    '/api/protocol',
    handle((req, res) => {
      const body = (req.body ?? {}) as { kind?: unknown; title?: unknown; body?: unknown; enabled?: unknown };
      if (body.kind !== 'rule' && body.kind !== 'skill' && body.kind !== 'template') {
        res.status(400).json({ error: 'kind must be "rule", "skill", or "template"' });
        return;
      }
      if (typeof body.title !== 'string' || !body.title.trim()) {
        res.status(400).json({ error: 'title is required' });
        return;
      }
      res.json(
        addProtocol({
          kind: body.kind,
          title: body.title,
          body: typeof body.body === 'string' ? body.body : '',
          enabled: body.enabled === undefined ? undefined : body.enabled !== false,
          agent: agentOf(req),
        })
      );
    })
  );

  app.patch(
    '/api/protocol',
    handle((req, res) => {
      const id = qs(req, 'id');
      if (!id) {
        res.status(400).json({ error: 'id is required' });
        return;
      }
      const body = (req.body ?? {}) as { kind?: unknown; title?: unknown; body?: unknown; enabled?: unknown };
      const patch: { kind?: string; title?: string; body?: string; enabled?: boolean } = {};
      if (body.kind === 'rule' || body.kind === 'skill' || body.kind === 'template') patch.kind = body.kind;
      if (typeof body.title === 'string') patch.title = body.title;
      if (typeof body.body === 'string') patch.body = body.body;
      if (typeof body.enabled === 'boolean') patch.enabled = body.enabled;
      res.json(updateProtocol(id, patch, agentOf(req)));
    })
  );

  app.delete(
    '/api/protocol',
    handle((req, res) => {
      const id = qs(req, 'id');
      if (!id) {
        res.status(400).json({ error: 'id is required' });
        return;
      }
      if (!deleteProtocol(id, agentOf(req))) {
        res.status(404).json({ error: 'protocol item not found' });
        return;
      }
      res.json({ ok: true });
    })
  );

  // Activity
  app.get(
    '/api/activity',
    handle((req, res) => {
      const limit = Number(qs(req, 'limit')) || 100;
      res.json(getActivity(limit));
    })
  );

  app.post(
    '/api/log',
    handle((req, res) => {
      const body = (req.body ?? {}) as { message?: unknown };
      const message = typeof body.message === 'string' ? body.message : '';
      logActivity({ agent: agentOf(req), action: 'log', detail: message });
      res.json({ ok: true });
    })
  );

  // Settings + mirror
  app.get(
    '/api/settings',
    handle((_req, res) => {
      res.json(getSettings());
    })
  );

  app.put(
    '/api/settings',
    handle((req, res) => {
      const body = (req.body ?? {}) as { mirror_enabled?: unknown; mirror_path?: unknown; active_project?: unknown };
      if (typeof body.active_project === 'string') {
        setSetting('active_project', body.active_project);
      }
      if (body.mirror_enabled !== undefined) {
        const on =
          body.mirror_enabled === true || body.mirror_enabled === '1' || body.mirror_enabled === 'true';
        setSetting('mirror_enabled', on ? '1' : '0');
      }
      if (body.mirror_path !== undefined) {
        const raw = typeof body.mirror_path === 'string' ? body.mirror_path.trim() : '';
        if (raw !== '') {
          const resolved = path.resolve(raw);
          const home = os.homedir();
          const parent = path.dirname(resolved);
          if (!path.isAbsolute(raw) || resolved === '/' || resolved === home) {
            res.status(400).json({ error: 'mirror_path must be an absolute folder path (not / or the home folder itself)' });
            return;
          }
          if (!fs.existsSync(resolved) && !fs.existsSync(parent)) {
            res.status(400).json({ error: 'mirror_path parent folder does not exist' });
            return;
          }
          if (fs.existsSync(resolved) && !fs.statSync(resolved).isDirectory()) {
            res.status(400).json({ error: 'mirror_path must be a folder' });
            return;
          }
          setSetting('mirror_path', resolved);
        } else {
          setSetting('mirror_path', '');
        }
      }
      res.json(getSettings());
    })
  );

  app.post(
    '/api/mirror/sync',
    handle((_req, res) => {
      res.json(mirrorSync());
    })
  );

  // --- Local AI — fully in-process, no external server ---------------------
  // Generation runs embedded (node-llama-cpp in a utilityProcess) or against a
  // cloud endpoint with the user's own key. Embeddings are ALWAYS embedded.
  const aiSettingsOf = (): AiSettings => {
    const s = getSettings();
    // ai.ts holds no DB reference (that would be an import cycle), so push the
    // current model paths to it on every read — cheap, and always in sync.
    setAiConfig({ genPath: s.ai_gen_model_path, embedPath: s.ai_embed_model_path });
    return {
      provider: s.ai_provider,
      gen_model_path: s.ai_gen_model_path,
      embed_model_path: s.ai_embed_model_path,
      cloud_base_url: s.ai_cloud_base_url,
      cloud_model: s.ai_cloud_model,
      apiKey: decryptApiKey(s.ai_cloud_api_key_enc),
    };
  };

  /** Public shape — never leaks the API key, only whether one is stored. */
  const publicAiSettings = () => {
    const s = aiSettingsOf();
    return {
      provider: s.provider,
      gen_model_path: s.gen_model_path,
      embed_model_path: s.embed_model_path,
      cloud_base_url: s.cloud_base_url,
      cloud_model: s.cloud_model,
      has_api_key: Boolean(s.apiKey),
    };
  };

  app.get(
    '/api/ai/settings',
    handle((_req, res) => {
      res.json(publicAiSettings());
    })
  );

  app.put(
    '/api/ai/settings',
    handle((req, res) => {
      const b = (req.body ?? {}) as Record<string, unknown>;
      if (b.provider === 'embedded' || b.provider === 'cloud') setSetting('ai_provider', b.provider);
      if (typeof b.cloud_base_url === 'string' && b.cloud_base_url.trim()) {
        setSetting('ai_cloud_base_url', b.cloud_base_url.trim());
      }
      if (typeof b.cloud_model === 'string') setSetting('ai_cloud_model', b.cloud_model.trim());
      // The key arrives in plaintext once, is encrypted at rest (safeStorage /
      // Keychain), and is never read back out to the renderer.
      if (typeof b.api_key === 'string') {
        setSetting('ai_cloud_api_key_enc', b.api_key.trim() === '' ? '' : encryptApiKey(b.api_key));
      }
      for (const [field, key] of [
        ['gen_model_path', 'ai_gen_model_path'],
        ['embed_model_path', 'ai_embed_model_path'],
      ] as const) {
        const v = b[field];
        if (typeof v !== 'string') continue;
        const p = v.trim();
        if (p !== '') {
          if (!fs.existsSync(p)) {
            res.status(400).json({ error: `model file not found: ${p}` });
            return;
          }
          if (!/\.gguf$/i.test(p)) {
            res.status(400).json({ error: 'model must be a .gguf file' });
            return;
          }
        }
        setSetting(key, p);
        // Refresh ai.ts's cached paths BEFORE reloading, or it reloads the
        // previous (possibly empty) path and effectively unloads the model.
        aiSettingsOf();
        void reloadModel(field === 'gen_model_path' ? 'gen' : 'embed');
      }
      res.json(publicAiSettings());
    })
  );

  app.get('/api/ai/status', (_req: Request, res: Response) => {
    aiSettingsOf(); // sync model paths into ai.ts before asking for status
    void getAiStatus()
      .then((st) => res.json(st))
      .catch((err: unknown) => res.status(500).json({ error: errMsg(err) }));
  });

  app.post('/api/ai/download-model', (req: Request, res: Response) => {
    const kind = (req.body ?? {}).kind === 'gen' ? 'gen' : 'embed';
    res.writeHead(200, {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache',
      Connection: 'keep-alive',
    });
    void downloadModel(kind, (pct, mb, totalMb) => {
      res.write(`event: progress\ndata: ${JSON.stringify({ pct, mb, totalMb })}\n\n`);
    })
      .then((modelPath) => {
        setSetting(kind === 'gen' ? 'ai_gen_model_path' : 'ai_embed_model_path', modelPath);
        aiSettingsOf(); // push the just-saved path into ai.ts before reloading
        return reloadModel(kind).then(() => {
          res.write(`event: done\ndata: ${JSON.stringify({ path: modelPath })}\n\n`);
          res.end();
        });
      })
      .catch((err: unknown) => {
        res.write(`event: error\ndata: ${JSON.stringify({ error: errMsg(err) })}\n\n`);
        res.end();
      });
  });

  // Non-streaming ask — used by the stdio MCP proxy (mcp-stdio.cjs), which has
  // no direct model access and forwards cortex_ask_local_model calls here.
  app.post('/api/ai/ask', (req: Request, res: Response) => {
    void (async () => {
      const body = (req.body ?? {}) as { prompt?: unknown; context?: unknown };
      if (typeof body.prompt !== 'string' || !body.prompt.trim()) {
        res.status(400).json({ error: 'prompt is required' });
        return;
      }
      const messages: ChatMessage[] =
        typeof body.context === 'string' && body.context.trim()
          ? [
              { role: 'system', content: body.context },
              { role: 'user', content: body.prompt },
            ]
          : [{ role: 'user', content: body.prompt }];
      try {
        res.json({ text: await chatOnce(messages, aiSettingsOf()) });
      } catch (err) {
        res.status(502).json({ error: errMsg(err) });
      }
    })();
  });

  app.post('/api/ai/suggest-tags', (req: Request, res: Response) => {
    void (async () => {
      const body = (req.body ?? {}) as { path?: unknown };
      const notePath = typeof body.path === 'string' ? body.path : '';
      const note = notePath ? readNote(notePath) : null;
      if (!note) {
        res.status(404).json({ error: 'note not found' });
        return;
      }
      const messages: ChatMessage[] = [
        {
          role: 'system',
          content:
            'You suggest short, lowercase, single-word-or-hyphenated tags for a personal knowledge base note. Reply with ONLY a JSON array of 3-6 tag strings, no explanation, no markdown fences.',
        },
        { role: 'user', content: `Title: ${note.title}\n\n${note.content.slice(0, 4000)}` },
      ];
      try {
        const text = await chatOnce(messages, aiSettingsOf());
        let tags: string[] = [];
        try {
          const match = text.match(/\[[\s\S]*\]/);
          tags = JSON.parse(match ? match[0] : text);
        } catch {
          tags = [];
        }
        tags = tags.filter((t) => typeof t === 'string' && t.trim()).map((t) => t.trim().toLowerCase());
        res.json({ tags });
      } catch (err) {
        res.status(502).json({ error: errMsg(err) });
      }
    })();
  });

  // --- Orchestrator pipeline ----------------------------------------------
  app.get(
    '/api/orchestrator/config',
    handle((_req, res) => {
      res.json(getPipelineConfig());
    })
  );

  app.patch(
    '/api/orchestrator/config',
    handle((req, res) => {
      const key = qs(req, 'role');
      if (!key) {
        res.status(400).json({ error: 'role is required' });
        return;
      }
      const b = (req.body ?? {}) as Record<string, unknown>;
      const patch: { is_enabled?: boolean; assigned_agent?: string; model?: string; auto_advance?: boolean; auto_dispatch?: boolean } = {};
      if (typeof b.is_enabled === 'boolean') patch.is_enabled = b.is_enabled;
      if (typeof b.assigned_agent === 'string') patch.assigned_agent = b.assigned_agent;
      if (typeof b.model === 'string') patch.model = b.model;
      if (typeof b.auto_advance === 'boolean') patch.auto_advance = b.auto_advance;
      if (typeof b.auto_dispatch === 'boolean') patch.auto_dispatch = b.auto_dispatch;
      res.json(updatePipelineRole(key, patch, agentOf(req)));
    })
  );

  /* Per-task implementer/reviewer choice — called by the picker modal before dispatch.
     Empty = fall back to the global pipeline config. */
  app.patch(
    '/api/orchestrator/task-agents',
    handle((req, res) => {
      const id = Number(qs(req, 'id'));
      if (!Number.isFinite(id)) {
        res.status(400).json({ error: 'id is required' });
        return;
      }
      const b = (req.body ?? {}) as Record<string, unknown>;
      const patch: { coder_agent?: string; coder_model?: string; reviewer_agent?: string; reviewer_model?: string } = {};
      if (typeof b.coder_agent === 'string') patch.coder_agent = b.coder_agent;
      if (typeof b.coder_model === 'string') patch.coder_model = b.coder_model;
      if (typeof b.reviewer_agent === 'string') patch.reviewer_agent = b.reviewer_agent;
      if (typeof b.reviewer_model === 'string') patch.reviewer_model = b.reviewer_model;
      res.json(setOrchTaskAgents(id, patch, agentOf(req)));
    })
  );

  /* The local model refines the user's rough prose into a task spec.
     Async, and returns 502 when the model fails — same shape as /api/ai/ask. */
  app.post('/api/orchestrator/compose', (req: Request, res: Response) => {
    void (async () => {
      const b = (req.body ?? {}) as { text?: unknown };
      if (typeof b.text !== 'string' || !b.text.trim()) {
        res.status(400).json({ error: 'text is required' });
        return;
      }
      const system =
        'You turn a user\'s rough request into a clear engineering task spec for the team.\n' +
        'Write in the same language the user used; keep technical terms in English.\n' +
        'Output exactly this shape and nothing else:\n' +
        'Title: <one short line>\n' +
        'Description:\n<the goal, then a "## Acceptance criteria" section with checkable bullets>';
      try {
        const raw = await chatOnce(
          [{ role: 'system', content: system }, { role: 'user', content: b.text }],
          aiSettingsOf()
        );
        const m = raw.match(/Title:\s*(.+)/i);
        const title = (m ? m[1] : b.text).trim().slice(0, 120);
        const idx = raw.indexOf('Description:');
        const description = (idx >= 0 ? raw.slice(idx + 'Description:'.length) : raw).trim();
        res.json({ title, description, raw });
      } catch (err) {
        res.status(502).json({ error: errMsg(err) });
      }
    })();
  });

  // Identity-aware view: an agent must be able to learn which roles it owns.
  app.get(
    '/api/orchestrator/status',
    handle((req, res) => {
      const who = qs(req, 'for') || agentOf(req);
      res.json({
        you: who,
        your_roles: rolesForAgent(who),
        pipeline: getPipelineConfig(),
        tasks: listOrchTasks(50),
      });
    })
  );

  app.post(
    '/api/orchestrator/heartbeat',
    handle((req, res) => {
      const b = (req.body ?? {}) as Record<string, unknown>;
      res.json(heartbeatOrchTask(Number(b.task_id), agentOf(req)));
    })
  );

  app.get(
    '/api/orchestrator/tasks',
    handle((req, res) => {
      res.json(listOrchTasks(Number(qs(req, 'limit')) || 200));
    })
  );

  app.get(
    '/api/orchestrator/task',
    handle((req, res) => {
      const brief = orchTaskBrief(Number(qs(req, 'id')));
      if (!brief) {
        res.status(404).json({ error: 'task not found' });
        return;
      }
      res.json(brief);
    })
  );

  app.post(
    '/api/orchestrator/tasks',
    handle((req, res) => {
      const b = (req.body ?? {}) as Record<string, unknown>;
      if (typeof b.title !== 'string' || !b.title.trim()) {
        res.status(400).json({ error: 'title is required' });
        return;
      }
      if (typeof b.description !== 'string' || !b.description.trim()) {
        res.status(400).json({ error: 'description is required' });
        return;
      }
      res.json(
        createOrchTask({
          title: b.title,
          description: b.description,
          context_files: Array.isArray(b.context_files) ? (b.context_files as string[]) : [],
          execution_mode: typeof b.execution_mode === 'string' ? b.execution_mode : undefined,
          project: typeof b.project === 'string' && b.project.trim() ? b.project.trim() : null,
          needs_planning: b.needs_planning === true,
          agent: agentOf(req),
        })
      );
    })
  );


  app.patch(
    '/api/orchestrator/task',
    handle((req, res) => {
      const id = Number(qs(req, 'id'));
      if (!Number.isFinite(id)) {
        res.status(400).json({ error: 'id is required' });
        return;
      }
      const b = (req.body ?? {}) as Record<string, unknown>;
      if (!('project' in b)) {
        res.status(400).json({ error: 'project is required' });
        return;
      }
      const proj = b.project;
      if (proj !== null && typeof proj !== 'string') {
        res.status(400).json({ error: 'project must be string or null' });
        return;
      }
      const task = moveOrchTaskProject(id, proj, agentOf(req));
      res.json(task);
    })
  );

  app.delete(
    '/api/orchestrator/task',
    handle((req, res) => {
      const id = Number(qs(req, 'id'));
      if (!Number.isFinite(id)) {
        res.status(400).json({ error: 'id is required' });
        return;
      }
      if (isTaskDispatchActive(id)) {
        stopOrchTask(id, agentOf(req));
      }
      if (!deleteOrchTask(id, agentOf(req))) {
        res.status(404).json({ error: 'task not found' });
        return;
      }
      res.json({ ok: true });
    })
  );

  app.post(
    '/api/orchestrator/claim',
    handle((req, res) => {
      const b = (req.body ?? {}) as Record<string, unknown>;
      const role = typeof b.role_key === 'string' ? b.role_key : '';
      if (!role) {
        res.status(400).json({ error: 'role_key is required' });
        return;
      }
      // Fall back to the request's agent identity so an agent need not repeat it.
      const who = typeof b.agent_name === 'string' && b.agent_name.trim() ? b.agent_name : agentOf(req);
      
      let tid = Number(b.task_id);
      if (b.task_id !== undefined && b.task_id !== null && !Number.isNaN(tid)) {
        try {
          const claimRes = claimOrchTaskById(who, tid);
          if (claimRes.reason !== 'ok') {
            res.status(400).json({ error: claimRes.reason });
            return;
          }
          res.json(claimRes);
        } catch (e: unknown) {
          res.status(400).json({ error: (e as Error).message });
        }
        return;
      }

      const task = claimOrchTask(who, role);
      // 200 with null is deliberate: "nothing to do" is a normal poll result,
      // not an error the agent should treat as a failure.
      res.json(task);
    })
  );

  app.post('/api/orchestrator/wait', (req: Request, res: Response) => {
    void (async () => {
      const b = (req.body ?? {}) as { role_key?: unknown; timeout_seconds?: unknown; agent_name?: unknown };
      const role_key = typeof b.role_key === 'string' ? b.role_key : '';
      if (!role_key) {
        res.status(400).json({ error: 'role_key is required' });
        return;
      }
      const timeoutSec = typeof b.timeout_seconds === 'number' ? Math.max(1, Math.min(b.timeout_seconds, 90)) : 90;
      const agent_name = typeof b.agent_name === 'string' && b.agent_name.trim() ? b.agent_name : agentOf(req);

      try {
        const initial = claimOrchTask(agent_name, role_key);
        if (initial && initial.task) {
          res.json(initial);
          return;
        }
      } catch (err) {
        res.status(500).json({ error: errMsg(err) });
        return;
      }

      let timeoutId: NodeJS.Timeout;
      const onEvent = (ev: any) => {
        if (ev.type === 'orchestrator') {
          try {
            const attempt = claimOrchTask(agent_name, role_key);
            if (attempt && attempt.task) {
              cleanup();
              if (!res.headersSent) {
                res.json(attempt);
              }
            }
          } catch (err) {
            cleanup();
            if (!res.headersSent) {
              res.status(500).json({ error: errMsg(err) });
            }
          }
        }
      };

      const cleanup = () => {
        dbEvents.off('change', onEvent);
        clearTimeout(timeoutId);
      };

      res.on('close', cleanup);
      dbEvents.on('change', onEvent);

      timeoutId = setTimeout(() => {
        cleanup();
        if (!res.headersSent) {
          res.json({ task: null, reason: 'timeout' });
        }
      }, timeoutSec * 1000);
    })();
  });

  app.post(
    '/api/orchestrator/submit',
    handle(async (req, res) => {
      const b = (req.body ?? {}) as Record<string, unknown>;
      const id = Number(b.task_id);
      if (!Number.isFinite(id)) {
        res.status(400).json({ error: 'task_id is required' });
        return;
      }
      const agent = agentOf(req);
      if (agent !== 'user') {
        
        const diffPayload = typeof b.diff_payload === 'string' ? b.diff_payload : '';
        const diffCheck = verifyDiffApplied(opts.rootDir, diffPayload, id);
        if (!diffCheck.ok) {
          res.status(400).json({ error: diffCheck.error });
          return;
        }

        const typecheck = await runTypeCheck(opts.rootDir);
        if (!typecheck.ok) {
          const m = typecheck.errors.match(/^\[(.*?)\]/);
          const p = m ? m[1].toLowerCase() : '';
          const errType = p === 'build' ? 'Build failed' : p === 'typecheck' ? 'Typecheck failed' : p ? p.charAt(0).toUpperCase() + p.slice(1) + ' failed' : 'Verification failed';
          res.status(400).json({ error: errType, details: typecheck.errors });
          return;
        }
      } else {
        logActivity({
          agent: 'user',
          action: 'submit-typecheck-bypass',
          path: null,
          detail: 'User bypassed build gate'
        });
      }
      res.json(
        submitOrchWork(
          id,
          typeof b.diff_payload === 'string' ? b.diff_payload : '',
          typeof b.summary === 'string' ? b.summary : '',
          agent
        )
      );
    })
  );

  app.post(
    '/api/orchestrator/review',
    handle((req, res) => {
      const b = (req.body ?? {}) as Record<string, unknown>;
      const id = Number(b.task_id);
      if (!Number.isFinite(id)) {
        res.status(400).json({ error: 'task_id is required' });
        return;
      }
      res.json(
        reviewOrchTask(
          id,
          typeof b.status === 'string' ? b.status : '',
          typeof b.feedback === 'string' ? b.feedback : '',
          agentOf(req)
        )
      );
    })
  );

  app.post(
    '/api/orchestrator/gate',
    handle((req, res) => {
      const b = (req.body ?? {}) as Record<string, unknown>;
      res.json(releaseOrchGate(Number(b.task_id), agentOf(req)));
    })
  );

  app.post(
    '/api/orchestrator/requeue',
    handle((req, res) => {
      const b = (req.body ?? {}) as { task_id?: unknown; reason?: unknown };
      res.json(
        requeueOrchTask(
          Number(b.task_id),
          agentOf(req),
          typeof b.reason === 'string' ? b.reason : undefined
        )
      );
    })
  );

  app.post(
    '/api/orchestrator/retry',
    handle((req, res) => {
      const b = (req.body ?? {}) as Record<string, unknown>;
      res.json(retryOrchTask(Number(b.task_id), agentOf(req)));
    })
  );

  app.post(
    '/api/orchestrator/dispatch',
    handle(async (req, res) => {
      const b = (req.body ?? {}) as Record<string, unknown>;
      const taskId = Number(b.task_id);
      if (!Number.isFinite(taskId)) {
        res.status(400).json({ error: 'task_id is required' });
        return;
      }
      
      const rootDir = opts.rootDir;
      const task = getOrchTask(taskId);
      if (!task) {
        res.status(404).json({ error: 'Task not found' });
        return;
      }
      
      // Clear manual block on manual dispatch
      conn().prepare('UPDATE orchestrator_tasks SET auto_blocked = 0 WHERE id = ?').run(taskId);

      const result = await dispatchTask(taskId, task.current_role, rootDir, opts.stdioPath);
      if (!result.ok) {
        res.status(400).json(result);
        return;
      }
      res.json(result);
    })
  );

  app.post(
    '/api/orchestrator/resume_auto',
    handle((req, res) => {
      const b = (req.body ?? {}) as Record<string, unknown>;
      const taskId = Number(b.task_id);
      if (!Number.isFinite(taskId)) {
        res.status(400).json({ error: 'task_id is required' });
        return;
      }
      conn().prepare('UPDATE orchestrator_tasks SET auto_blocked = 0 WHERE id = ?').run(taskId);
      dbEvents.emit('change', { type: 'orchestrator' });
      res.json(getOrchTask(taskId));
    })
  );

  // --- Semantic index ------------------------------------------------------
  app.get(
    '/api/ai/index/status',
    handle((_req, res) => {
      res.json(getIndexStatus());
    })
  );

  app.post('/api/ai/index/rebuild', (_req: Request, res: Response) => {
    void rebuildIndex()
      .then(() => res.json({ ok: true }))
      .catch((err: unknown) => res.status(500).json({ error: errMsg(err) }));
  });

  app.get('/api/notes/similar', (req: Request, res: Response) => {
    const p = qs(req, 'path');
    if (!p) {
      res.status(400).json({ error: 'path is required' });
      return;
    }
    void findSimilar(p, 6)
      .then((rows) => res.json(rows))
      .catch((err: unknown) => res.status(500).json({ error: errMsg(err) }));
  });

  app.get('/api/notes/duplicates', (_req: Request, res: Response) => {
    void findDuplicates(0.85)
      .then((rows) => res.json(rows))
      .catch((err: unknown) => res.status(500).json({ error: errMsg(err) }));
  });

  // --- Librarian: AI upkeep on the vault --------------------------------------
  app.get(
    '/api/librarian/pending',
    handle((_req, res) => {
      res.json(scanPending());
    })
  );

  app.post(
    '/api/librarian/scan',
    handle((req, res) => {
      const b = (req.body ?? {}) as { text?: unknown; path?: unknown };
      let text = typeof b.text === 'string' ? b.text : '';
      if (!text && typeof b.path === 'string') text = readNote(b.path)?.content ?? '';
      if (!text) {
        res.status(400).json({ error: 'text or path is required' });
        return;
      }
      res.json(scanText(text));
    })
  );

  app.get('/api/librarian/autolink', (req: Request, res: Response) => {
    const p = qs(req, 'path');
    if (!p) {
      res.status(400).json({ error: 'path is required' });
      return;
    }
    // Only genuinely missing connections are actionable.
    void findSimilar(p, 8)
      .then((rows) => res.json(rows.filter((r) => !r.linked && r.score >= 0.55)))
      .catch((err: unknown) => res.status(500).json({ error: errMsg(err) }));
  });

  app.post('/api/librarian/plan', (req: Request, res: Response) => {
    const p = ((req.body ?? {}) as { path?: string }).path;
    if (!p) {
      res.status(400).json({ error: 'path is required' });
      return;
    }
    void generatePlan(p)
      .then((r) => res.json(r))
      .catch((err: unknown) => res.status(502).json({ error: errMsg(err) }));
  });

  app.post('/api/librarian/mockdata', (req: Request, res: Response) => {
    const p = ((req.body ?? {}) as { path?: string }).path;
    if (!p) {
      res.status(400).json({ error: 'path is required' });
      return;
    }
    void generateMockData(p)
      .then((r) => res.json(r))
      .catch((err: unknown) => res.status(502).json({ error: errMsg(err) }));
  });

  app.post('/api/librarian/rollup', (req: Request, res: Response) => {
    const id = Number(((req.body ?? {}) as { task_id?: number }).task_id);
    const brief = Number.isFinite(id) ? orchTaskBrief(id) : null;
    if (!brief) {
      res.status(404).json({ error: 'task not found' });
      return;
    }
    const events = brief.audit.map(
      (a) => `${a.action} by ${a.agent_name} (${a.role_key})${a.comment ? ': ' + a.comment : ''}`
    );
    const notes = brief.task.context_files
      .map((f) => readNote(f))
      .filter(Boolean)
      .map((n) => `${n!.title}: ${n!.content.slice(0, 1200)}`);
    void rollupContext({ title: brief.task.title, events, notes })
      .then((card) => res.json({ task_id: id, ...card }))
      .catch((err: unknown) => res.status(502).json({ error: errMsg(err) }));
  });

  app.get('/api/librarian/conflicts', (_req: Request, res: Response) => {
    void similarChunkPairs()
      .then(async (pairs) => {
        const out: unknown[] = [];
        // Sequential on purpose: one local model, one context.
        for (const p of pairs.slice(0, 6)) {
          const verdict = await judgeConflict(p.a, p.b);
          if (verdict.conflict) out.push({ ...verdict, a: p.a.path, b: p.b.path, similarity: p.score });
        }
        res.json({ checked: pairs.length, conflicts: out });
      })
      .catch((err: unknown) => res.status(502).json({ error: errMsg(err) }));
  });

  app.post('/api/librarian/docs', (req: Request, res: Response) => {
    const topic = ((req.body ?? {}) as { topic?: string }).topic;
    if (!topic) {
      res.status(400).json({ error: 'topic is required' });
      return;
    }
    void gatherForTopic(topic, 5)
      .then((sources) =>
        sources.length === 0
          ? res.status(404).json({ error: 'no notes matched that topic' })
          : composeDocs(topic, sources).then((r) => res.json(r))
      )
      .catch((err: unknown) => res.status(502).json({ error: errMsg(err) }));
  });

  // --- SSE -----------------------------------------------------------------
  app.get('/api/events', (req: Request, res: Response) => {
    res.writeHead(200, {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache',
      Connection: 'keep-alive',
    });
    res.write(': connected\n\n');

    // Debounce 250ms per event type so bursts collapse into one message.
    const timers = new Map<string, ReturnType<typeof setTimeout>>();
    const onChange = (e: { type: string }): void => {
      const type = e?.type ?? 'vault';
      if (timers.has(type)) return;
      timers.set(
        type,
        setTimeout(() => {
          timers.delete(type);
          res.write(`event: change\ndata: ${JSON.stringify({ type })}\n\n`);
        }, SSE_DEBOUNCE_MS)
      );
    };
    dbEvents.on('change', onChange);

    const heartbeat = setInterval(() => {
      res.write(': ping\n\n');
    }, SSE_HEARTBEAT_MS);

    req.on('close', () => {
      clearInterval(heartbeat);
      for (const t of timers.values()) clearTimeout(t);
      timers.clear();
      dbEvents.off('change', onChange);
    });
  });

  app.post(
    '/api/orchestrator/move',
    handle((req, res) => {
      const b = (req.body ?? {}) as { task_id?: unknown, target_column?: unknown };
      const taskId = Number(b.task_id);
      if (!Number.isFinite(taskId)) {
        res.status(400).json({ error: 'task_id is required' });
        return;
      }
      const targetCol = typeof b.target_column === 'string' ? b.target_column : '';
      if (!targetCol) {
        res.status(400).json({ error: 'target_column is required' });
        return;
      }
      res.json(moveOrchTaskManually(taskId, targetCol, agentOf(req)));
    })
  );

  app.post(
    '/api/orchestrator/stop',
    handle((req, res) => {
      const b = (req.body ?? {}) as { task_id?: unknown };
      const taskId = Number(b.task_id);
      if (!Number.isFinite(taskId)) {
        res.status(400).json({ error: 'task_id is required' });
        return;
      }
      stopOrchTask(taskId, agentOf(req));
      res.json({ ok: true });
    })
  );

  
  app.get('/api/skills/one', handle((req, res) => {
    const name = String(req.query.name || '');
    const sk = getSkillByName(name);
    if (!sk) {
      res.status(404).json({ error: 'not found' });
      return;
    }
    res.json(sk);
  }));

  app.get('/api/skills', handle((req, res) => {
    res.json(listSkills());
  }));

  app.post('/api/skills/import', handle(async (req, res) => {
    const body = (req.body ?? {});
    let result;
    if (body.source_id) {
      result = await importFromGithub(body.source_id);
    } else if (body.local_path) {
      result = importFromFolder(body.local_path);
    } else {
      res.status(400).json({error: "Need source_id or local_path"});
      return;
    }
    res.json({ ok: true, ...result });
  }));

  app.post('/api/skills/rescan', handle((req, res) => {
    const result = rescanSkills();
    res.json({ ok: true, ...result });
  }));

  // --- Static UI last + SPA fallback ---------------------------------------
  app.use(express.static(opts.distDir));
  app.use((req: Request, res: Response, next: NextFunction) => {
    if (req.method !== 'GET') return next();
    if (req.path.startsWith('/api') || req.path.startsWith('/mcp')) return next();
    const indexFile = path.join(opts.distDir, 'index.html');
    if (!fs.existsSync(indexFile)) return next();
    res.sendFile(indexFile);
  });

  return new Promise<Server>((resolve, reject) => {
    const server = app.listen(opts.port, '127.0.0.1');
    server.once('listening', () => resolve(server));
    server.once('error', (err: Error) => reject(err));
  });
}
