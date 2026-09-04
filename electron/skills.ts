import { app } from "electron";
import * as path from "path";
import * as fs from "fs";
import * as crypto from "crypto";
import { conn } from "./db";
import * as zlib from "zlib";

function computeHash(buffer: Buffer) {
  return crypto.createHash('sha256').update(buffer).digest('hex');
}

export function skillsDir() {
  return path.join(app.getPath("userData"), "skills");
}

function safeJoin(base: string, target: string) {
  if (target.includes('..') || path.isAbsolute(target)) throw new Error("Invalid path");
  const joined = path.join(base, target);
  if (!joined.startsWith(base)) throw new Error("Path escape");
  return joined;
}

function parseTar(buffer: Buffer) {
  const files: { name: string; content: Buffer }[] = [];
  let offset = 0;
  let totalBytes = 0;
  while (offset < buffer.length) {
    if (offset + 512 > buffer.length) break;
    const header = buffer.subarray(offset, offset + 512);
    if (header[0] === 0) {
      offset += 512;
      continue;
    }
    const nameStr = header.subarray(0, 100).toString('utf8').replace(/\0.*$/, '');
    const sizeStr = header.subarray(124, 136).toString('utf8').replace(/\0.*$/, '').trim();
    const typeFlag = header.subarray(156, 157).toString('utf8');
    const size = parseInt(sizeStr, 8);
    offset += 512;
    if (isNaN(size)) break;
    if (typeFlag === '0' || typeFlag === '\0') {
      if (size > 256 * 1024) throw new Error("File too large");
      totalBytes += size;
      if (totalBytes > 8 * 1024 * 1024) throw new Error("Total size too large");
      if (offset + size <= buffer.length) {
        files.push({ name: nameStr, content: buffer.subarray(offset, offset + size) });
      }
    }
    offset += Math.ceil(size / 512) * 512;
  }
  return files;
}

export async function importFromGithub(sourceId: string) {
  if (sourceId !== 'mattpocock-skills') throw new Error("Only mattpocock-skills is supported");
  const url = 'https://codeload.github.com/mattpocock/skills/tar.gz/refs/heads/main';
  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), 30000);
  let res;
  try {
    res = await fetch(url, { signal: controller.signal });
  } finally {
    clearTimeout(timeoutId);
  }
  if (!res.ok) throw new Error("Fetch failed");
  const arrayBuffer = await res.arrayBuffer();
  const decompressed = zlib.gunzipSync(Buffer.from(arrayBuffer));
  const rawFiles = parseTar(decompressed);
  
  const files = rawFiles.map(f => {
    const parts = f.name.split('/');
    parts.shift();
    return { name: parts.join('/'), content: f.content };
  }).filter(f => f.name.length > 0);

  const rejected = writeFilesToDisk(sourceId, files);
  
  const licenseFile = files.find(f => f.name.toUpperCase().startsWith('LICENSE') && !f.name.includes('/'));
  const licenseText = licenseFile ? licenseFile.content.toString('utf8').replace(/\0/g, '') : '';
  
  const pluginFile = files.find(f => f.name === '.claude-plugin/plugin.json');
  const pluginJsonText = pluginFile ? pluginFile.content.toString('utf8').replace(/\0/g, '') : '';
  
  conn().transaction(() => {
    conn().prepare(`
      INSERT INTO skill_sources(id, kind, repo, ref, local_path, license, license_text, plugin_json, author, imported_at, builtin)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(id) DO UPDATE SET
      kind=excluded.kind, repo=excluded.repo, ref=excluded.ref, local_path=excluded.local_path,
      license_text=excluded.license_text, plugin_json=excluded.plugin_json, author=excluded.author, builtin=excluded.builtin
    `).run(sourceId, 'github', url, 'main', '', 'MIT', licenseText, pluginJsonText, 'Matt Pocock', Date.now(), 1);
  })();

  const scanResult = rescanSkills();
  return { rejected, ...scanResult };
}

export function importFromFolder(absPath: string) {
  // Read files from folder recursively
  const files: {name: string, content: Buffer}[] = [];
  let totalBytes = 0;
  
  function scan(dir: string, rel: string) {
    const entries = fs.readdirSync(dir, { withFileTypes: true });
    for (const ent of entries) {
      const p = path.join(dir, ent.name);
      const r = rel ? rel + '/' + ent.name : ent.name;
      if (ent.isDirectory()) {
        scan(p, r);
      } else if (ent.isFile()) {
        const stats = fs.statSync(p);
        if (stats.size > 256 * 1024) throw new Error("File too large");
        totalBytes += stats.size;
        if (totalBytes > 8 * 1024 * 1024) throw new Error("Total size too large");
        files.push({ name: r, content: fs.readFileSync(p) });
      }
    }
  }
  scan(absPath, '');
  
  const sourceId = path.basename(absPath);
  const rejected = writeFilesToDisk(sourceId, files);
  
  const licenseFile = files.find(f => f.name.toUpperCase().startsWith('LICENSE') && !f.name.includes('/'));
  const licenseText = licenseFile ? licenseFile.content.toString('utf8').replace(/\0/g, '') : '';
  
  const pluginFile = files.find(f => f.name === '.claude-plugin/plugin.json');
  const pluginJsonText = pluginFile ? pluginFile.content.toString('utf8').replace(/\0/g, '') : '';
  
  conn().transaction(() => {
    conn().prepare(`
      INSERT INTO skill_sources(id, kind, repo, ref, local_path, license, license_text, plugin_json, author, imported_at, builtin)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(id) DO UPDATE SET
      kind=excluded.kind, repo=excluded.repo, ref=excluded.ref, local_path=excluded.local_path,
      license_text=excluded.license_text, plugin_json=excluded.plugin_json, author=excluded.author, builtin=excluded.builtin
    `).run(sourceId, 'folder', '', '', absPath, '', licenseText, pluginJsonText, '', Date.now(), 0);
  })();

  const scanResult = rescanSkills();
  return { rejected, ...scanResult };
}

function writeFilesToDisk(sourceId: string, files: {name: string, content: Buffer}[]) {
  const baseDir = safeJoin(skillsDir(), sourceId);
  fs.mkdirSync(baseDir, { recursive: true });
  const rejected: string[] = [];
  
  // Note: category README files (e.g. skills/engineering/README.md) are not stored in the DB by design.
  // We write them to disk here, but they won't be recovered during self-healing, which is acceptable.

  for (const f of files) {
    if (!f.name.startsWith('skills/') && f.name !== 'LICENSE' && f.name !== '.claude-plugin/plugin.json') {
      continue;
    }
    if (f.name.includes('..') || path.isAbsolute(f.name)) {
      rejected.push(`Invalid path (contains .. or absolute): ${f.name}`);
      continue;
    }
    
    try {
      const dest = safeJoin(baseDir, f.name);
      fs.mkdirSync(path.dirname(dest), { recursive: true });
      fs.writeFileSync(dest, f.content);
    } catch (e: any) {
      rejected.push(`Error writing ${f.name}: ${e.message}`);
    }
  }
  return rejected;
}

export function initSkills() {
  try {
    rescanSkills();
  } catch (err) {
    console.error("Failed to initialize skills:", err);
  }
}

export function rescanSkills() {
  const base = skillsDir();
  let imported = 0, updated = 0, skipped = 0;
  
  if (!fs.existsSync(base)) {
      fs.mkdirSync(base, { recursive: true });
  }

  const allSources = conn().prepare(`SELECT id, license_text, plugin_json FROM skill_sources`).all() as any[];
  for (const src of allSources) {
    const srcDir = path.join(base, src.id);
    if (src.license_text && src.license_text.length > 0) {
      const dest = path.join(srcDir, 'LICENSE');
      if (!fs.existsSync(dest)) {
        fs.mkdirSync(srcDir, { recursive: true });
        fs.writeFileSync(dest, src.license_text);
      }
    }
    if (src.plugin_json && src.plugin_json.length > 0) {
      const dest = path.join(srcDir, '.claude-plugin', 'plugin.json');
      if (!fs.existsSync(dest)) {
        fs.mkdirSync(path.dirname(dest), { recursive: true });
        fs.writeFileSync(dest, src.plugin_json);
      }
    }
  }

  const allSkills = conn().prepare(`SELECT id, source_id, rel_dir FROM skills`).all() as any[];
  for (const sk of allSkills) {
    const srcDir = path.join(base, sk.source_id);
    const fullRelDir = path.join(srcDir, sk.rel_dir);
    if (!fs.existsSync(fullRelDir)) {
      const dbFiles = conn().prepare(`SELECT rel_path, content FROM skill_files WHERE skill_id=?`).all(sk.id) as any[];
      if (dbFiles.length > 0) {
        fs.mkdirSync(fullRelDir, { recursive: true });
        for (const dbf of dbFiles) {
          const dest = safeJoin(fullRelDir, dbf.rel_path);
          fs.mkdirSync(path.dirname(dest), { recursive: true });
          fs.writeFileSync(dest, dbf.content);
        }
      }
    }
  }

  const sources = fs.readdirSync(base, { withFileTypes: true });
  conn().transaction(() => {
    for (const src of sources) {
      if (!src.isDirectory()) continue;
      const sourceId = src.name;
      const srcDir = path.join(base, sourceId);
      
      const pluginJsonPath = path.join(srcDir, '.claude-plugin/plugin.json');
      let approvedSkills: string[] | null = null;
      if (fs.existsSync(pluginJsonPath)) {
        try {
          const pluginJson = JSON.parse(fs.readFileSync(pluginJsonPath, 'utf8'));
          if (pluginJson && Array.isArray(pluginJson.skills)) {
            approvedSkills = pluginJson.skills.map((s: string) => s.startsWith('./skills/') ? s.substring(9) : s);
          }
        } catch(e) { }
      }

      const skillsBaseDir = path.join(srcDir, 'skills');
      if (!fs.existsSync(skillsBaseDir)) continue;

      const skillDirsToScan = [];
      const cats = fs.readdirSync(skillsBaseDir, { withFileTypes: true });
      for (const cat of cats) {
        if (!cat.isDirectory()) continue;
        const catDir = path.join(skillsBaseDir, cat.name);
        const sks = fs.readdirSync(catDir, { withFileTypes: true });
        for (const sk of sks) {
          if (!sk.isDirectory()) continue;
          skillDirsToScan.push({ relDir: `skills/${cat.name}/${sk.name}`, name: sk.name, fullRel: `${cat.name}/${sk.name}` });
        }
      }

      for (const { relDir, name: skillName, fullRel } of skillDirsToScan) {
        const fullRelDir = path.join(srcDir, relDir);
        if (!fs.existsSync(fullRelDir)) continue;
        
        let description = '';
        let bodyHash = '';
        const skillMdPath = path.join(fullRelDir, 'SKILL.md');
        if (fs.existsSync(skillMdPath)) {
          const content = fs.readFileSync(skillMdPath);
          bodyHash = computeHash(content);
          const descMatch = content.toString('utf8').match(/description:\s*(.+)/);
          if (descMatch) description = descMatch[1].trim();
        } else {
          bodyHash = computeHash(Buffer.from([]));
        }
        
        let bytes = 0;
        const filesToProcess: {relPath: string, content: Buffer}[] = [];
        function gather(dir: string, rel: string) {
          const entries = fs.readdirSync(dir, { withFileTypes: true });
          for (const ent of entries) {
            const p = path.join(dir, ent.name);
            const r = rel ? rel + '/' + ent.name : ent.name;
            if (ent.isDirectory()) gather(p, r);
            else if (ent.isFile()) {
              const content = fs.readFileSync(p);
              filesToProcess.push({ relPath: r, content });
              bytes += content.length;
            }
          }
        }
        gather(fullRelDir, '');
        
        const existing = conn().prepare(`SELECT * FROM skills WHERE source_id=? AND name=?`).get(sourceId, skillName) as any;
        const skillId = existing ? existing.id : crypto.randomUUID();
        
        let enabled = 1;
        if (existing) {
          enabled = existing.enabled;
        } else if (approvedSkills !== null) {
          enabled = approvedSkills.includes(fullRel) ? 1 : 0;
        }

        if (!existing) {
          conn().prepare(`
            INSERT INTO skills(id, source_id, name, description, rel_dir, body_hash, bytes, enabled, updated)
            VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
          `).run(skillId, sourceId, skillName, description, relDir, bodyHash, bytes, enabled, Date.now());
          imported++;
        } else if (existing.body_hash !== bodyHash || existing.bytes !== bytes || existing.description !== description || existing.rel_dir !== relDir) {
          conn().prepare(`
            UPDATE skills SET description=?, rel_dir=?, body_hash=?, bytes=?, updated=? WHERE id=?
          `).run(description, relDir, bodyHash, bytes, Date.now(), skillId);
          updated++;
        } else {
          skipped++;
        }
        
        for (const f of filesToProcess) {
          const hash = computeHash(f.content);
          const exFile = conn().prepare(`SELECT version, hash, content FROM skill_files WHERE skill_id=? AND rel_path=?`).get(skillId, f.relPath) as any;
          
          if (!exFile) {
            conn().prepare(`
              INSERT INTO skill_files(skill_id, rel_path, content, bytes, hash, version, updated)
              VALUES (?, ?, ?, ?, ?, ?, ?)
            `).run(skillId, f.relPath, f.content, f.content.length, hash, 1, Date.now());
          } else if (exFile.hash !== hash) {
            conn().prepare(`
              INSERT INTO skill_file_versions(skill_id, rel_path, version, content, hash, created)
              VALUES (?, ?, ?, ?, ?, ?)
            `).run(skillId, f.relPath, exFile.version, exFile.content, exFile.hash, Date.now());
            
            conn().prepare(`
              UPDATE skill_files SET content=?, bytes=?, hash=?, version=version+1, updated=?
              WHERE skill_id=? AND rel_path=?
            `).run(f.content, f.content.length, hash, Date.now(), skillId, f.relPath);
          }
        }
        
        const dbFiles = conn().prepare(`SELECT rel_path, content FROM skill_files WHERE skill_id=?`).all(skillId) as any[];
        for (const dbf of dbFiles) {
          const dest = safeJoin(fullRelDir, dbf.rel_path);
          if (!fs.existsSync(dest)) {
            fs.mkdirSync(path.dirname(dest), { recursive: true });
            fs.writeFileSync(dest, dbf.content);
          }
        }
      }
    }
  })();
  
  return { imported, updated, skipped };
}
export function listSkills() {
  return conn().prepare(`SELECT * FROM skills`).all();
}

export function readSkill(id: string) {
  return conn().prepare(`SELECT * FROM skills WHERE id=?`).get(id);
}

export function getSkillByName(name: string) {
  const sk = conn().prepare(`SELECT id FROM skills WHERE name=?`).get(name) as any;
  if (!sk) return null;
  const full = readSkill(sk.id) as any;
  const files = conn().prepare(`SELECT rel_path FROM skill_files WHERE skill_id=?`).all(sk.id) as any[];
  let body = "";
  try {
    body = readSkillFile(sk.id, "SKILL.md")?.toString("utf-8") || "";
  } catch (e) {
    // ignore if SKILL.md missing
  }
  return { ...full, files: files.map((f: any) => f.rel_path), body };
}

export function readSkillFile(id: string, relPath: string) {
  const sk = readSkill(id) as any;
  if (!sk) throw new Error("Skill not found");
  const dest = safeJoin(skillsDir(), path.join(sk.source_id, sk.rel_dir, relPath));
  if (fs.existsSync(dest)) {
    return fs.readFileSync(dest);
  }
  // fallback to DB (it will be healed on next rescan)
  const dbf = conn().prepare(`SELECT content FROM skill_files WHERE skill_id=? AND rel_path=?`).get(id, relPath) as any;
  if (!dbf) throw new Error("File not found");
  // heal now
  fs.mkdirSync(path.dirname(dest), { recursive: true });
  fs.writeFileSync(dest, dbf.content);
  return dbf.content;
}
