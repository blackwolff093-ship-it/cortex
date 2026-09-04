/**
 * CORTEX AI worker — the ONLY place node-llama-cpp is touched.
 *
 * Runs as an Electron `utilityProcess` (its own OS process) so that model
 * loading, token generation and embedding never block the main thread's event
 * loop, and a native crash/OOM inside llama.cpp cannot bring down the app.
 *
 * Communicates with electron/ai.ts over postMessage: {id, op, ...} in,
 * {id, result | error} out, plus {id, op:'progress'} during downloads.
 *
 * node-llama-cpp is ESM-only while this file is bundled to CJS — verified that
 * `await import()` loads it fine under Electron 37, so it is imported lazily.
 * It must stay --external in the esbuild step (native bindings).
 */

type Kind = 'gen' | 'embed';

interface Loaded {
  modelPath: string;
  model: any;
  /** Generation: a chat context. Embedding: an embedding context. */
  ctx: any;
  /** Generation only: one reusable sequence for the context's lifetime. */
  sequence?: any;
}

let llama: any = null;
const loaded: Partial<Record<Kind, Loaded>> = {};

async function getLlama() {
  if (!llama) {
    const mod = await import('node-llama-cpp');
    llama = await mod.getLlama();
  }
  return llama;
}

/** Dispose in the right order — session, then context, then model. Skipping
 *  this leaves RAM/VRAM held until process exit. */
async function unload(kind: Kind): Promise<void> {
  const l = loaded[kind];
  if (!l) return;
  delete loaded[kind];
  try {
    l.sequence?.dispose?.();
    l.sequence = undefined;
    await l.ctx?.dispose?.();
    await l.model?.dispose?.();
  } catch {
    /* already gone */
  }
}

async function load(kind: Kind, modelPath: string): Promise<void> {
  if (loaded[kind]?.modelPath === modelPath) return;
  await unload(kind);
  const l = await getLlama();
  const model = await l.loadModel({ modelPath });
  if (kind === 'embed') {
    const ctx = await model.createEmbeddingContext({ contextSize: 512 });
    loaded.embed = { modelPath, model, ctx };
  } else {
    const ctx = await model.createContext({ contextSize: 4096 });
    loaded.gen = { modelPath, model, ctx };
  }
}

async function embedTexts(texts: string[]): Promise<number[][]> {
  const l = loaded.embed;
  if (!l) throw new Error('embedding model not loaded');
  const out: number[][] = [];
  for (const t of texts) {
    const e = await l.ctx.getEmbeddingFor(t);
    out.push(Array.from(e.vector as Iterable<number>));
  }
  return out;
}

async function generate(messages: { role: string; content: string }[], maxTokens: number): Promise<string> {
  const l = loaded.gen;
  if (!l) throw new Error('generation model not loaded');
  const mod = await import('node-llama-cpp');
  // ONE sequence reused for the context's lifetime. getSequence() draws from a
  // fixed pool (default size 1), so allocating a fresh one per request throws
  // "No sequences left" on the second call. Clearing history instead keeps each
  // request independent without leaking a slot.
  if (!l.sequence) l.sequence = l.ctx.getSequence();
  try {
    await l.sequence.clearHistory();
  } catch {
    /* a fresh sequence has nothing to clear */
  }
  const session = new mod.LlamaChatSession({
    contextSequence: l.sequence,
    systemPrompt: messages.find((m) => m.role === 'system')?.content,
  });
  const lastUser = [...messages].reverse().find((m) => m.role === 'user');
  try {
    return await session.prompt(lastUser?.content ?? '', { maxTokens });
  } finally {
    session.dispose?.();
  }
}

async function download(
  kind: Kind,
  uri: string,
  dirPath: string,
  report: (pct: number, mb: number, totalMb: number) => void
): Promise<string> {
  const mod = await import('node-llama-cpp');
  const downloader = await mod.createModelDownloader({
    modelUri: uri,
    dirPath,
    onProgress: ({ totalSize, downloadedSize }: { totalSize: number; downloadedSize: number }) => {
      const pct = totalSize > 0 ? Math.round((downloadedSize / totalSize) * 100) : 0;
      report(pct, downloadedSize / 1e6, totalSize / 1e6);
    },
  });
  const modelPath = await downloader.download();
  await load(kind, modelPath);
  return modelPath;
}

process.parentPort?.on('message', (e: { data: any }) => {
  const msg = e.data;
  const reply = (patch: Record<string, unknown>) => process.parentPort!.postMessage({ id: msg.id, ...patch });

  void (async () => {
    try {
      switch (msg.op) {
        case 'status': {
          reply({
            result: {
              gen: Boolean(loaded.gen),
              embed: Boolean(loaded.embed),
              gpu: llama ? llama.gpu ?? null : null,
            },
          });
          break;
        }
        case 'load':
          await load(msg.kind, msg.modelPath);
          reply({ result: true });
          break;
        case 'unload':
          await unload(msg.kind);
          reply({ result: true });
          break;
        case 'embed':
          reply({ result: await embedTexts(msg.texts) });
          break;
        case 'generate':
          reply({ result: await generate(msg.messages, msg.maxTokens) });
          break;
        case 'download':
          reply({
            result: await download(msg.kind, msg.uri, msg.dirPath, (pct, mb, totalMb) =>
              process.parentPort!.postMessage({ id: msg.id, op: 'progress', pct, mb, totalMb })
            ),
          });
          break;
        default:
          reply({ error: `unknown op: ${String(msg.op)}` });
      }
    } catch (err) {
      reply({ error: err instanceof Error ? err.message : String(err) });
    }
  })();
});
