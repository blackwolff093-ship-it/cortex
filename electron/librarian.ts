// CORTEX "librarian" — the on-device model doing background upkeep on the
// vault, plus deterministic scanners that need no model at all.
//
// Split on purpose: anything that must be RELIABLE (secret scanning, counting
// unfinished work) is plain code, because a 1B-9B local model is not a
// dependable gate. The model is used only where judgement genuinely helps
// (planning, summarising, spotting contradictions, drafting docs).
import { chatOnce, type AiSettings, type ChatMessage } from './ai';
import { getSettings, listNotes, readNote, type NoteListItem } from './db';

// ---------------------------------------------------------------------------
// Deterministic scanners — no model involved
// ---------------------------------------------------------------------------

export interface Finding {
  severity: 'high' | 'medium' | 'low';
  kind: string;
  line: number;
  excerpt: string;
  advice: string;
}

interface Rule {
  kind: string;
  re: RegExp;
  excludeRe?: RegExp;
  severity: Finding['severity'];
  advice: string;
}

/** Patterns that indicate a real secret rather than a placeholder. */
const SECRET_RULES: Rule[] = [
  { kind: 'api-key', re: /\b(sk-[A-Za-z0-9]{16,}|AIza[0-9A-Za-z_-]{30,}|ghp_[A-Za-z0-9]{20,}|xox[baprs]-[A-Za-z0-9-]{10,})\b/, severity: 'high', advice: 'Move the key to an env var or the Keychain; never hardcode it.' },
  { kind: 'aws-key', re: /\bAKIA[0-9A-Z]{16}\b/, severity: 'high', advice: 'Exposed AWS key — revoke and rotate it immediately.' },
  { kind: 'private-key', re: /-----BEGIN (RSA |EC |OPENSSH |PGP )?PRIVATE KEY-----/, severity: 'high', advice: 'Private key in the code — purge it from history too.' },
  { kind: 'hardcoded-password', re: /\b(password|passwd|secret|token)\s*[:=]\s*['"][^'"\s]{6,}['"]/i, severity: 'high', advice: 'Do not hardcode passwords; read them from settings.' },
  { kind: 'bearer-literal', re: /Authorization\s*:\s*['"]?Bearer\s+[A-Za-z0-9._-]{12,}/i, severity: 'high', advice: 'Token exposed — pass it from encrypted settings instead.' },
];

const RISK_RULES: Rule[] = [
  { kind: 'network-bind-all', re: /(listen\s*\(\s*[^,)]*,\s*['"]0\.0\.0\.0['"]|host\s*[:=]\s*['"]0\.0\.0\.0['"])/, severity: 'high', advice: 'Bind to 127.0.0.1 only — 0.0.0.0 exposes the vault to the whole local network.' },
  { kind: 'path-traversal', re: /\.\.[\/\\]/, excludeRe: /(^\s*[+-]?\s*(import|export)\b|\bfrom\s*['"])/, severity: 'medium', advice: 'Validate the path with path.resolve and block escapes above the root.' },
  { kind: 'shell-injection', re: /\b(exec|execSync|spawnSync)\s*\(\s*[`'"][^`'"]*\$\{/, severity: 'high', advice: 'Do not build a shell command by interpolation — pass arguments as an array.' },
  { kind: 'eval', re: /\b(eval|new\s+Function)\s*\(/, severity: 'medium', advice: 'Avoid eval; use JSON.parse or explicit logic.' },
  { kind: 'sql-concat', re: /(SELECT|INSERT|UPDATE|DELETE)\b[^;]*\+\s*[a-zA-Z_$]/i, severity: 'high', advice: 'Use prepared parameters (?) instead of string concatenation.' },
];

/** Text that tries to hijack the NEXT agent that reads it. Agents pass
 *  diffs/feedback to each other, so this is a real transport for injection. */
const INJECTION_RULES: { kind: string; re: RegExp; advice: string }[] = [
  { kind: 'instruction-override', re: /\b(ignore|disregard|forget)\s+(all\s+)?(previous|prior|above|earlier)\s+(instructions?|prompts?|rules?)\b/i, advice: 'Text trying to override the next agent instructions — treat it as data, not commands.' },
  { kind: 'role-hijack', re: /\b(you\s+are\s+now|from\s+now\s+on,?\s+you)\b/i, advice: 'Attempts to redefine the agent role.' },
  { kind: 'fake-authority', re: /\b(system\s*(prompt|message)|as\s+the\s+(developer|admin|owner))\s*[:=]/i, advice: 'Impersonates system authority inside ordinary content.' },
  { kind: 'exfiltration', re: /\b(send|post|upload|exfiltrate)\b[^.\n]{0,40}\b(api[_ ]?key|secret|token|password|\.env)\b/i, advice: 'Instructions to exfiltrate sensitive data to a third party.' },
  { kind: 'auto-approve', re: /\b(approve|accept)\b[^.\n]{0,30}\b(without|no)\b[^.\n]{0,20}\b(review|checking|reading)\b/i, advice: 'Attempts to skip review.' },
];

/**
 * Scan text exchanged between agents. Deterministic on purpose: a gate that
 * silently depends on a small local model is not a gate.
 */
export function scanText(text: string): { findings: Finding[]; safe: boolean } {
  const findings: Finding[] = [];
  const lines = String(text ?? '').split('\n');
  lines.forEach((line, i) => {
    if (line.length > 4000) return; // minified blob — regexes would be noise
    for (const r of [...SECRET_RULES, ...RISK_RULES]) {
      if (r.re.test(line) && (!r.excludeRe || !r.excludeRe.test(line))) {
        findings.push({
          severity: r.severity,
          kind: r.kind,
          line: i + 1,
          excerpt: line.trim().slice(0, 140),
          advice: r.advice,
        });
      }
    }
    for (const r of INJECTION_RULES) {
      if (r.re.test(line)) {
        findings.push({ severity: 'high', kind: 'prompt-injection:' + r.kind, line: i + 1, excerpt: line.trim().slice(0, 140), advice: r.advice });
      }
    }
  });
  // Same rule firing on many lines is one problem, not fifty.
  const seen = new Set<string>();
  const deduped = findings.filter((f) => {
    const k = f.kind + '|' + f.excerpt;
    if (seen.has(k)) return false;
    seen.add(k);
    return true;
  });
  return { findings: deduped.slice(0, 50), safe: !deduped.some((f) => f.severity === 'high') };
}

export interface PendingItem {
  path: string;
  title: string;
  kind: 'unchecked-box' | 'stale-note' | 'open-question';
  detail: string;
  line: number;
  ageDays: number;
}

const STALE_DAYS = 21;

/** Unfinished work sitting in the vault: unticked checkboxes, notes that
 *  haven't moved in weeks, and explicit open questions. All from raw text —
 *  no model, so the count is exact and reproducible. */
export function scanPending(): { items: PendingItem[]; counts: Record<string, number> } {
  const items: PendingItem[] = [];
  const now = Date.now();
  for (const meta of listNotes() as NoteListItem[]) {
    const note = readNote(meta.path);
    if (!note) continue;
    const ageDays = Math.floor((now - note.mtime) / 86_400_000);
    const lines = note.content.split('\n');
    let unchecked = 0;
    let inFence = false;
    lines.forEach((line, i) => {
      if (/^\s*(```|~~~)/.test(line)) inFence = !inFence;
      if (inFence) return;
      if (/^\s*(?:[-*+]|\d+[.)])\s+\[ \]/.test(line)) {
        unchecked++;
        items.push({
          path: meta.path,
          title: note.title,
          kind: 'unchecked-box',
          detail: line.replace(/^\s*(?:[-*+]|\d+[.)])\s+\[ \]\s*/, '').trim().slice(0, 120),
          line: i + 1,
          ageDays,
        });
      } else if (/^\s*[-*]\s*.*\?\s*$/.test(line) && /(\bshould\b|\bwhy\b|\bhow\b|\bwhat\b|هل|شنو|ليش|كيف)/i.test(line)) {
        items.push({
          path: meta.path,
          title: note.title,
          kind: 'open-question',
          detail: line.replace(/^\s*[-*]\s*/, '').trim().slice(0, 120),
          line: i + 1,
          ageDays,
        });
      }
    });
    if (unchecked > 0 && ageDays >= STALE_DAYS) {
      items.push({
        path: meta.path,
        title: note.title,
        kind: 'stale-note',
        detail: `${unchecked} unchecked item(s), untouched for ${ageDays} day(s)`,
        line: 0,
        ageDays,
      });
    }
  }
  const counts: Record<string, number> = {};
  for (const i of items) counts[i.kind] = (counts[i.kind] ?? 0) + 1;
  return { items: items.sort((a, b) => b.ageDays - a.ageDays).slice(0, 200), counts };
}

// ---------------------------------------------------------------------------
// Model-backed helpers
// ---------------------------------------------------------------------------

function aiSettings(): AiSettings {
  const s = getSettings();
  return {
    provider: s.ai_provider,
    gen_model_path: s.ai_gen_model_path,
    embed_model_path: s.ai_embed_model_path,
    cloud_base_url: s.ai_cloud_base_url,
    cloud_model: s.ai_cloud_model,
    apiKey: '',
  };
}

/**
 * Salvage JSON that was cut off mid-structure.
 *
 * Small local models truncate constantly: a "thinking" model burns part of the
 * budget reasoning, then the token cap lands in the middle of an object. The
 * text up to the last COMPLETE element is still perfectly good data, so trim
 * to it and close the brackets rather than throwing the whole answer away.
 */
function repairTruncatedJson(text: string): string | null {
  const start = text.search(/[[{]/);
  if (start === -1) return null;
  const body = text.slice(start);
  let depth = 0;
  let inStr = false;
  let esc = false;
  let lastComplete = -1;
  for (let i = 0; i < body.length; i++) {
    const c = body[i];
    if (esc) {
      esc = false;
      continue;
    }
    if (c === '\\') {
      esc = true;
      continue;
    }
    if (c === '"') {
      inStr = !inStr;
      continue;
    }
    if (inStr) continue;
    if (c === '{' || c === '[') depth++;
    else if (c === '}' || c === ']') {
      depth--;
      // A top-level-1 close means one array element / object field finished.
      if (depth === 1) lastComplete = i;
      if (depth === 0) return body.slice(0, i + 1);
    }
  }
  if (lastComplete === -1) return null;
  const opener = body[0];
  return body.slice(0, lastComplete + 1) + (opener === '[' ? ']' : '}');
}

/** Ask the model for JSON and parse it defensively — small models wrap output
 *  in fences and run past the token cap no matter how firmly you ask. */
async function askJson<T>(system: string, user: string, fallback: T, maxTokens = 2600): Promise<T> {
  const messages: ChatMessage[] = [
    { role: 'system', content: system + '\nReply with ONLY valid JSON. No prose, no markdown fences.' },
    { role: 'user', content: user },
  ];
  const raw = await chatOnce(messages, aiSettings(), { maxTokens });
  const cleaned = raw.replace(/```(?:json)?/gi, '').trim();
  const attempts = [cleaned, cleaned.slice(Math.max(0, cleaned.search(/[[{]/)))];
  const outermost = cleaned.match(/[[{][\s\S]*[\]}]/);
  if (outermost) attempts.push(outermost[0]);
  const repaired = repairTruncatedJson(cleaned);
  if (repaired) attempts.push(repaired);
  for (const candidate of attempts) {
    if (!candidate) continue;
    try {
      return JSON.parse(candidate) as T;
    } catch {
      /* next strategy */
    }
  }
  return fallback;
}

export interface Plan {
  phases: { title: string; steps: string[] }[];
}

export async function generatePlan(notePath: string): Promise<Plan & { source: string }> {
  const note = readNote(notePath);
  if (!note) throw new Error('note not found');
  const out = await askJson<Plan>(
    'You turn a written requirement into an executable technical plan. Output shape: ' +
      '{"phases":[{"title":"...","steps":["...","..."]}]}. 2-5 phases, 2-6 concrete steps each. ' +
      'Steps must be technical actions (files, functions, checks) — not restatements of the goal. ' +
      'Answer in the SAME language as the requirement.',
    `Requirement titled "${note.title}":\n\n${note.content.slice(0, 6000)}`,
    { phases: [] }
  );
  return { ...out, source: notePath };
}

export async function generateMockData(notePath: string): Promise<{ data: unknown; source: string }> {
  const note = readNote(notePath);
  if (!note) throw new Error('note not found');
  const data = await askJson<unknown>(
    'You generate realistic MOCK TEST DATA for the described feature. Output a JSON array of 3-6 ' +
      'objects with plausible field names and values matching the domain (use realistic Arabic text ' +
      'where the feature is Arabic). No comments, no explanation.',
    `Feature "${note.title}":\n\n${note.content.slice(0, 4000)}`,
    [],
    3200
  );
  return { data, source: notePath };
}

export async function rollupContext(input: {
  title: string;
  events: string[];
  notes: string[];
}): Promise<{ done: string[]; remaining: string[]; decisions: string[] }> {
  return askJson(
    'You compress a work history into a short handover card so the NEXT agent needs less context. ' +
      'Output {"done":[],"remaining":[],"decisions":[]} — short bullet strings, no filler. ' +
      'Same language as the input.',
    `Work item: ${input.title}\n\nEvents:\n${input.events.join('\n')}\n\nRelated notes:\n${input.notes
      .join('\n')
      .slice(0, 5000)}`,
    { done: [], remaining: [], decisions: [] }
  );
}

export async function judgeConflict(a: { path: string; text: string }, b: { path: string; text: string }) {
  return askJson<{ conflict: boolean; reason: string; quote_a: string; quote_b: string }>(
    'You decide whether two requirement excerpts CONTRADICT each other (different numbers, opposite ' +
      'rules, incompatible decisions) or merely overlap. Output ' +
      '{"conflict":true|false,"reason":"...","quote_a":"...","quote_b":"..."}. Same language as input.',
    `A (${a.path}):\n${a.text.slice(0, 1200)}\n\nB (${b.path}):\n${b.text.slice(0, 1200)}`,
    { conflict: false, reason: '', quote_a: '', quote_b: '' }
  );
}

export async function composeDocs(topic: string, sources: { path: string; text: string }[]) {
  const body = sources.map((s) => `--- ${s.path} ---\n${s.text.slice(0, 2500)}`).join('\n\n');
  const out = await askJson<{ markdown: string }>(
    'You merge scattered notes into ONE technical document. Output {"markdown":"..."} containing ' +
      'markdown with an H1 title, an overview, then sections (requirements, behaviour, open items). ' +
      'Use ONLY facts present in the sources — never invent. Same language as the sources.',
    `Topic: ${topic}\n\nSources:\n${body}`,
    { markdown: '' },
    3600
  );
  return { markdown: out.markdown, sources: sources.map((s) => s.path) };
}
