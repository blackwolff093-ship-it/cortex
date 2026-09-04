// CORTEX — on-device AI. Runs entirely inside the app: no Ollama, no
// llama-server, no local HTTP port. GGUF weights are loaded by node-llama-cpp
// in a SEPARATE utilityProcess (see ai-worker.cjs) so that model loading,
// token generation and embedding never block Electron's main thread — and so a
// native OOM/crash in llama.cpp cannot take the whole app down.
//
// Generation may instead go to a cloud endpoint with the user's own API key.
// Embeddings are ALWAYS on-device: they run over the whole vault in batches,
// are privacy-critical, and must cost nothing.
import { app, safeStorage, utilityProcess, type UtilityProcess } from 'electron';
import * as fs from 'node:fs';
import * as path from 'node:path';

export type AiProvider = 'embedded' | 'cloud';

export interface AiSettings {
  provider: AiProvider;
  gen_model_path: string;
  embed_model_path: string;
  cloud_base_url: string;
  cloud_model: string;
  /** Decrypted only in the main process, only at call time. */
  apiKey: string;
}

export interface ChatMessage {
  role: 'system' | 'user' | 'assistant';
  content: string;
}

export interface ModelStatus {
  path: string;
  exists: boolean;
  size: number | null;
  loaded: boolean;
}

export interface AiStatus {
  gen: ModelStatus;
  embed: ModelStatus;
  gpu: string | null;
}

/**
 * Default on-device embedding model.
 *
 * Chosen by measurement, not reputation: on Arabic probes drawn from a real
 * vault it scored 4/4 with a 0.170 separation margin — matching
 * Qwen3-Embedding-0.6B (0.177) at a quarter of the size and a smaller vector.
 * multilingual-e5-small was rejected outright (2/4, 0.009 margin — its GGUF
 * conversions are broken), and bge-m3-Q8 was too weak (0.087).
 *
 * Prefixes are per-model config, NOT constants: E5 wants `passage:`/`query:`,
 * nomic wants `search_document:`/`search_query:`, and this model wants the
 * pair below. They are folded into the index's `model` key so that changing
 * either the model or its prefixes invalidates stale vectors automatically.
 */
export const EMBED_MODEL = {
  uri: 'hf:ggml-org/embeddinggemma-300M-GGUF/embeddinggemma-300M-Q8_0.gguf',
  id: 'embeddinggemma-300M-Q8',
  docPrefix: 'title: none | text: ',
  queryPrefix: 'task: search result | query: ',
} as const;

/** A modest default so users without a big GGUF still get generation features. */
export const GEN_MODEL_URI = 'hf:ggml-org/gemma-3-1b-it-GGUF/gemma-3-1b-it-Q8_0.gguf';

/** Identifies the vector space in the DB (model + prefix together). */
export function embedIndexKey(): string {
  return `${EMBED_MODEL.id}|${EMBED_MODEL.docPrefix}`;
}

export function modelsDir(): string {
  const dir = path.join(app.getPath('userData'), 'models');
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}

// ---------------------------------------------------------------------------
// API key at rest — encrypted via safeStorage (Keychain on macOS)
// ---------------------------------------------------------------------------

export function encryptApiKey(plain: string): string {
  const t = plain.trim();
  if (t === '') return '';
  if (!safeStorage.isEncryptionAvailable()) {
    throw new Error('OS keychain unavailable — cannot store the API key securely');
  }
  return safeStorage.encryptString(t).toString('base64');
}

export function decryptApiKey(enc: string): string {
  if (!enc) return '';
  try {
    return safeStorage.decryptString(Buffer.from(enc, 'base64'));
  } catch {
    return '';
  }
}

// ---------------------------------------------------------------------------
// Worker plumbing
// ---------------------------------------------------------------------------

/** Request payloads (the `id` is added by `call`). Kept as a union without
 *  `id` so TypeScript narrows each variant correctly at the call sites. */
type WorkerReq =
  | { op: 'status' }
  | { op: 'load'; kind: 'gen' | 'embed'; modelPath: string }
  | { op: 'unload'; kind: 'gen' | 'embed' }
  | { op: 'embed'; texts: string[] }
  | { op: 'generate'; messages: ChatMessage[]; maxTokens: number }
  | { op: 'download'; kind: 'gen' | 'embed'; uri: string; dirPath: string };

interface Pending {
  resolve: (v: any) => void;
  reject: (e: Error) => void;
  onProgress?: (pct: number, mb: number, totalMb: number) => void;
}

let worker: UtilityProcess | null = null;
let seq = 0;
const pending = new Map<number, Pending>();
let workerReady: Promise<void> | null = null;

/**
 * Configured model paths.
 *
 * Deliberately held here rather than read from db.ts: db.ts imports this module
 * (for `chatOnce`), so reading settings from here would create an import cycle.
 * server.ts owns the settings and pushes them in via `setAiConfig`.
 */
const config: { genPath: string; embedPath: string } = { genPath: '', embedPath: '' };

export function setAiConfig(c: { genPath: string; embedPath: string }): void {
  config.genPath = c.genPath;
  config.embedPath = c.embedPath;
}

function workerPath(): string {
  // Bundled next to main.cjs by esbuild (see package.json build:main).
  return path.join(__dirname, 'ai-worker.cjs');
}

function spawnWorker(): Promise<void> {
  worker = utilityProcess.fork(workerPath(), [], { stdio: 'inherit' });
  worker.on('message', (msg: any) => {
    if (msg?.op === 'progress') {
      pending.get(msg.id)?.onProgress?.(msg.pct, msg.mb, msg.totalMb);
      return;
    }
    const p = pending.get(msg?.id);
    if (!p) return;
    pending.delete(msg.id);
    if (msg.error) p.reject(new Error(msg.error));
    else p.resolve(msg.result);
  });
  worker.on('exit', () => {
    // Fail everything in flight; the next call re-forks a fresh worker.
    for (const [, p] of pending) p.reject(new Error('AI worker exited'));
    pending.clear();
    worker = null;
    workerReady = null;
  });
  return new Promise((resolve) => worker!.once('spawn', () => resolve()));
}

function ensureWorker(): Promise<void> {
  if (!workerReady) workerReady = spawnWorker();
  return workerReady;
}

async function call<T>(req: WorkerReq, onProgress?: Pending['onProgress']): Promise<T> {
  await ensureWorker();
  const id = ++seq;
  return new Promise<T>((resolve, reject) => {
    pending.set(id, { resolve, reject, onProgress });
    worker!.postMessage({ ...req, id });
  });
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

function statOf(p: string, loaded: boolean): ModelStatus {
  const exists = Boolean(p) && fs.existsSync(p);
  return { path: p, exists, size: exists ? fs.statSync(p).size : null, loaded };
}

/** Load (or reload) a model in the worker to match the configured path. */
export async function reloadModel(kind: 'gen' | 'embed'): Promise<void> {
  const p = kind === 'gen' ? config.genPath : config.embedPath;
  if (!p) {
    await call({ op: 'unload', kind }).catch(() => {});
    return;
  }
  await call({ op: 'load', kind, modelPath: p });
}

export async function getAiStatus(): Promise<AiStatus> {
  let loaded = { gen: false, embed: false, gpu: null as string | null };
  try {
    loaded = await call<typeof loaded>({ op: 'status' });
  } catch {
    /* worker down — report paths only */
  }
  return {
    gen: statOf(config.genPath, loaded.gen),
    embed: statOf(config.embedPath, loaded.embed),
    gpu: loaded.gpu,
  };
}

export function downloadModel(
  kind: 'gen' | 'embed',
  onProgress: (pct: number, mb: number, totalMb: number) => void
): Promise<string> {
  return call<string>(
    {
      op: 'download',
      kind,
      uri: kind === 'embed' ? EMBED_MODEL.uri : GEN_MODEL_URI,
      dirPath: modelsDir(),
    },
    onProgress
  );
}

/** Embed texts with the on-device model. `kind` selects the model's prefix —
 *  documents and queries must be prefixed differently (see EMBED_MODEL). */
export async function embed(texts: string[], kind: 'doc' | 'query'): Promise<Float32Array[]> {
  if (texts.length === 0) return [];
  const prefix = kind === 'doc' ? EMBED_MODEL.docPrefix : EMBED_MODEL.queryPrefix;
  const out = await call<number[][]>({ op: 'embed', texts: texts.map((t) => prefix + t) });
  return out.map((v) => Float32Array.from(v));
}

export async function ensureEmbedModelLoaded(): Promise<void> {
  const st = await getAiStatus();
  if (st.embed.loaded) return;
  if (!st.embed.exists) {
    throw new Error(
      'No embedding model — download it from the CONNECT tab.'
    );
  }
  await reloadModel('embed');
}

async function cloudChat(messages: ChatMessage[], s: AiSettings): Promise<string> {
  if (!s.apiKey) throw new Error('No API key stored.');
  const base = s.cloud_base_url.replace(/\/+$/, '');
  let res: Response;
  try {
    res = await fetch(base + '/chat/completions', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${s.apiKey}`,
      },
      body: JSON.stringify({ model: s.cloud_model, messages, stream: false }),
    });
  } catch (err) {
    throw new Error(`Could not reach the cloud provider. (${String(err)})`);
  }
  if (!res.ok) {
    const body = await res.text().catch(() => '');
    throw new Error(`${res.status} ${res.statusText}: ${body.slice(0, 200)}`);
  }
  const json = (await res.json()) as { choices?: Array<{ message?: { content?: string } }> };
  return json.choices?.[0]?.message?.content ?? '';
}

/** One-shot generation. Embedded by default; cloud when configured. */
export async function chatOnce(
  messages: ChatMessage[],
  s: AiSettings,
  opts: { maxTokens?: number } = {}
): Promise<string> {
  if (s.provider === 'cloud') return cloudChat(messages, s);
  if (!s.gen_model_path) {
    throw new Error(
      'No generation model — set or download one in the CONNECT tab.'
    );
  }
  const st = await getAiStatus();
  if (!st.gen.loaded) await reloadModel('gen');
  // Thinking-style models (e.g. Ornith) burn the budget on reasoning before
  // emitting any content, so keep this generous — a 40-token cap returned "".
  return call<string>({ op: 'generate', messages, maxTokens: opts.maxTokens ?? 512 });
}

/** Free RAM/VRAM. Disposal order matters (context before model) and is handled
 *  inside the worker; without it the memory stays held until app exit. */
export async function unloadGenModel(): Promise<void> {
  await call({ op: 'unload', kind: 'gen' }).catch(() => {});
}

export function shutdownAi(): void {
  worker?.kill();
  worker = null;
  workerReady = null;
}

