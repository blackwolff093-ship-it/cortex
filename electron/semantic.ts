// CORTEX — semantic layer: chunking, background indexing, vector search,
// similarity and duplicate detection, plus hybrid (keyword + semantic) fusion.
//
// Import direction is one-way: semantic.ts -> {db, ai}. db.ts never imports
// this file; it only emits `dbEvents`, which we subscribe to. That keeps db.ts
// fully synchronous (no async plumbing through writeNote) and avoids a cycle.
import { embed, embedIndexKey, ensureEmbedModelLoaded, setAiConfig } from './ai';
import {
  allEmbeddings,
  clearEmbeddings,
  dbEvents,
  deleteEmbeddings,
  embeddingCounts,
  getSettings,
  linkedPathsOf,
  listNotes,
  noteTitleOf,
  notesForIndexing,
  readNote,
  replaceEmbeddings,
  searchNotes,
  staleEmbeddingPaths,
  type EmbeddingRow,
  type SearchResult,
} from './db';

/** ai.ts deliberately holds no DB reference (import cycle), so anything that
 *  reaches it outside an HTTP route must push the current paths first. */
function syncAiConfig(): void {
  const s = getSettings();
  setAiConfig({ genPath: s.ai_gen_model_path, embedPath: s.ai_embed_model_path });
}

const MAX_CHUNK_CHARS = 900;
const RRF_K = 60;

export interface SimilarNote {
  path: string;
  title: string;
  score: number;
  linked: boolean;
}

export interface DuplicatePair {
  a: string;
  b: string;
  titleA: string;
  titleB: string;
  score: number;
}

// ---------------------------------------------------------------------------
// Chunking — a long note as one vector loses meaning, so split on headings and
// blank lines, then hard-wrap anything still oversized.
// ---------------------------------------------------------------------------

export function chunkNote(title: string, content: string): string[] {
  const body = content
    .replace(/^---[\s\S]*?\n---\n/, '') // frontmatter
    .replace(/```[\s\S]*?```/g, ' ')    // code fences carry little semantics
    .trim();

  const sections: string[] = [];
  let current = '';
  for (const line of body.split('\n')) {
    const isHeading = /^#{1,6}\s/.test(line);
    if ((isHeading || line.trim() === '') && current.trim().length > 0) {
      if (isHeading || current.length > MAX_CHUNK_CHARS * 0.6) {
        sections.push(current.trim());
        current = '';
      }
    }
    current += line + '\n';
  }
  if (current.trim()) sections.push(current.trim());

  const out: string[] = [];
  for (const s of sections) {
    if (s.length <= MAX_CHUNK_CHARS) {
      out.push(s);
      continue;
    }
    for (let i = 0; i < s.length; i += MAX_CHUNK_CHARS) out.push(s.slice(i, i + MAX_CHUNK_CHARS));
  }
  // Title is prepended to every chunk: it is the strongest signal a chunk has
  // about what it belongs to, and mid-note chunks otherwise lose that context.
  const prefixed = out.filter((c) => c.trim()).map((c) => `${title}\n${c}`);
  return prefixed.length > 0 ? prefixed : [title];
}

// ---------------------------------------------------------------------------
// Background index queue
// ---------------------------------------------------------------------------

let running = false;
let queued = false;
let building = false;

/** Index every stale note, a few at a time. Never throws into the caller. */
async function drain(): Promise<void> {
  if (running) {
    queued = true;
    return;
  }
  running = true;
  try {
    const model = embedIndexKey();
    for (;;) {
      const stale = staleEmbeddingPaths(model);
      if (stale.length === 0) break;
      syncAiConfig();
      await ensureEmbedModelLoaded();
      // Small batches keep each await short and let deletes/edits interleave.
      for (const note of notesForIndexing(stale.slice(0, 4))) {
        const chunks = chunkNote(note.title, note.content);
        const vecs = await embed(chunks, 'doc');
        replaceEmbeddings(
          note.path,
          model,
          chunks.map((snippet, i) => ({ snippet: snippet.slice(0, 300), vec: vecs[i] })),
          note.mtime
        );
      }
    }
    // Drop vectors for notes that no longer exist.
    const live = new Set(listNotes().map((n) => n.path));
    for (const row of allEmbeddings(model)) {
      if (!live.has(row.path)) deleteEmbeddings(row.path);
    }
  } catch (err) {
    // No embedding model yet is the normal first-run state, not an error worth
    // crashing the app over — the CONNECT tab surfaces it.
    console.error('[cortex-semantic] indexing paused:', err instanceof Error ? err.message : err);
  } finally {
    running = false;
    if (queued) {
      queued = false;
      void drain();
    }
  }
}

let debounce: ReturnType<typeof setTimeout> | null = null;

/** Subscribe to vault changes and keep the index warm. Call once at startup. */
export function initSemantic(): void {
  dbEvents.on('change', (e: { type?: string }) => {
    if (e?.type !== 'vault') return;
    if (debounce) clearTimeout(debounce);
    debounce = setTimeout(() => {
      debounce = null;
      void drain();
    }, 1500);
  });
  // Kick off an initial pass shortly after boot (non-blocking).
  setTimeout(() => void drain(), 2000);
}

export function getIndexStatus(): {
  indexed: number;
  pending: number;
  totalNotes: number;
  model: string;
  building: boolean;
} {
  const model = embedIndexKey();
  const { indexedNotes, totalNotes } = embeddingCounts(model);
  return {
    indexed: indexedNotes,
    pending: staleEmbeddingPaths(model).length,
    totalNotes,
    model,
    building: running || building,
  };
}

export async function rebuildIndex(): Promise<void> {
  building = true;
  try {
    clearEmbeddings();
    await drain();
  } finally {
    building = false;
  }
}

// ---------------------------------------------------------------------------
// Vector math + search
// ---------------------------------------------------------------------------

function cosine(a: Float32Array, b: Float32Array): number {
  const n = Math.min(a.length, b.length);
  let dot = 0;
  let na = 0;
  let nb = 0;
  for (let i = 0; i < n; i++) {
    dot += a[i] * b[i];
    na += a[i] * a[i];
    nb += b[i] * b[i];
  }
  if (na === 0 || nb === 0) return 0;
  return dot / (Math.sqrt(na) * Math.sqrt(nb));
}

/** Best-scoring chunk per note, ranked. */
function rankNotes(
  rows: EmbeddingRow[],
  queryVec: Float32Array,
  exclude?: string
): { path: string; score: number; snippet: string }[] {
  const best = new Map<string, { score: number; snippet: string }>();
  for (const r of rows) {
    if (exclude && r.path === exclude) continue;
    const score = cosine(queryVec, r.vec);
    const prev = best.get(r.path);
    if (!prev || score > prev.score) best.set(r.path, { score, snippet: r.snippet });
  }
  return [...best.entries()]
    .map(([path, v]) => ({ path, score: v.score, snippet: v.snippet }))
    .sort((x, y) => y.score - x.score);
}

async function semanticRank(query: string): Promise<{ path: string; score: number; snippet: string }[]> {
  const q = query.trim();
  if (!q) return [];
  syncAiConfig();
  await ensureEmbedModelLoaded();
  const rows = allEmbeddings(embedIndexKey());
  if (rows.length === 0) return [];
  const [qv] = await embed([q], 'query');
  return rankNotes(rows, qv);
}

function toSearchResults(
  ranked: { path: string; score: number; snippet: string }[],
  limit: number
): SearchResult[] {
  return ranked.slice(0, limit).map((r) => ({
    path: r.path,
    title: noteTitleOf(r.path) ?? r.path.replace(/\.md$/i, '').split('/').pop()!,
    // line 0 marks "semantic match" — no single source line produced it.
    matches: [{ line: 0, text: r.snippet.replace(/\s+/g, ' ').slice(0, 160) }],
  }));
}

/**
 * Hybrid search via Reciprocal Rank Fusion.
 *
 * BM25 (FTS5) and cosine are not on comparable scales, so blending raw scores
 * distorts the ranking. RRF fuses by RANK instead: score(d) = Σ 1/(k + rank).
 */
export async function hybridSearch(query: string, mode: 'hybrid' | 'semantic' = 'hybrid'): Promise<SearchResult[]> {
  const semantic = await semanticRank(query);
  if (mode === 'semantic') return toSearchResults(semantic, 20);

  const keyword = searchNotes(query);
  const fused = new Map<string, { rrf: number; result?: SearchResult; snippet?: string }>();

  keyword.forEach((r, i) => {
    const e = fused.get(r.path) ?? { rrf: 0 };
    e.rrf += 1 / (RRF_K + i + 1);
    e.result = r; // keyword hits carry real line numbers — prefer them
    fused.set(r.path, e);
  });
  semantic.forEach((r, i) => {
    const e = fused.get(r.path) ?? { rrf: 0 };
    e.rrf += 1 / (RRF_K + i + 1);
    e.snippet = r.snippet;
    fused.set(r.path, e);
  });

  return [...fused.entries()]
    .sort((a, b) => b[1].rrf - a[1].rrf)
    .slice(0, 20)
    .map(([path, e]) =>
      e.result ??
      ({
        path,
        title: noteTitleOf(path) ?? path.replace(/\.md$/i, '').split('/').pop()!,
        matches: [{ line: 0, text: (e.snippet ?? '').replace(/\s+/g, ' ').slice(0, 160) }],
      } as SearchResult)
    );
}

/** Notes semantically closest to the given one, flagged if already linked. */
export async function findSimilar(notePath: string, limit = 6): Promise<SimilarNote[]> {
  syncAiConfig();
  await ensureEmbedModelLoaded();
  const model = embedIndexKey();
  const rows = allEmbeddings(model);
  const own = rows.filter((r) => r.path === notePath);
  if (own.length === 0) return [];
  const linked = linkedPathsOf(notePath);

  // Compare against the note's own chunks, keeping each candidate's best match.
  const best = new Map<string, number>();
  for (const mine of own) {
    for (const r of rankNotes(rows, mine.vec, notePath)) {
      const prev = best.get(r.path);
      if (prev === undefined || r.score > prev) best.set(r.path, r.score);
    }
  }
  return [...best.entries()]
    .map(([p, score]) => ({
      path: p,
      title: noteTitleOf(p) ?? p.replace(/\.md$/i, '').split('/').pop()!,
      score,
      linked: linked.has(p),
    }))
    .sort((a, b) => b.score - a.score)
    .slice(0, limit);
}

/** Chunk pairs that talk about the SAME thing across DIFFERENT notes — the
 *  candidate set a conflict detector should actually judge. Near-identical
 *  duplicates are excluded: those are duplication, not contradiction. */
export async function similarChunkPairs(
  lo = 0.62,
  hi = 0.97,
  limit = 12
): Promise<{ a: { path: string; text: string }; b: { path: string; text: string }; score: number }[]> {
  syncAiConfig();
  await ensureEmbedModelLoaded();
  const rows = allEmbeddings(embedIndexKey());
  const out: { a: { path: string; text: string }; b: { path: string; text: string }; score: number }[] = [];
  for (let i = 0; i < rows.length; i++) {
    for (let j = i + 1; j < rows.length; j++) {
      if (rows[i].path === rows[j].path) continue;
      const score = cosine(rows[i].vec, rows[j].vec);
      if (score < lo || score > hi) continue;
      out.push({
        a: { path: rows[i].path, text: rows[i].snippet },
        b: { path: rows[j].path, text: rows[j].snippet },
        score,
      });
    }
  }
  // Keep the strongest pair per note-pair so one topic is judged once.
  const best = new Map<string, (typeof out)[number]>();
  for (const p of out) {
    const k = [p.a.path, p.b.path].sort().join('|');
    const prev = best.get(k);
    if (!prev || p.score > prev.score) best.set(k, p);
  }
  return [...best.values()].sort((x, y) => y.score - x.score).slice(0, limit);
}

/** Full text of the notes most relevant to a topic — the gather step for
 *  auto-documentation. */
export async function gatherForTopic(topic: string, limit = 5): Promise<{ path: string; text: string }[]> {
  const ranked = await semanticRank(topic);
  const out: { path: string; text: string }[] = [];
  for (const r of ranked.slice(0, limit)) {
    const note = readNote(r.path);
    if (note) out.push({ path: note.path, text: note.content });
  }
  return out;
}

/** Near-duplicate note pairs above `threshold` similarity. */
export async function findDuplicates(threshold = 0.85): Promise<DuplicatePair[]> {
  syncAiConfig();
  await ensureEmbedModelLoaded();
  const rows = allEmbeddings(embedIndexKey());
  // One representative vector per note (its first chunk) keeps this O(n²) over
  // notes rather than over chunks.
  const byNote = new Map<string, Float32Array>();
  for (const r of rows) if (!byNote.has(r.path)) byNote.set(r.path, r.vec);

  const entries = [...byNote.entries()];
  const out: DuplicatePair[] = [];
  for (let i = 0; i < entries.length; i++) {
    for (let j = i + 1; j < entries.length; j++) {
      const score = cosine(entries[i][1], entries[j][1]);
      if (score < threshold) continue;
      out.push({
        a: entries[i][0],
        b: entries[j][0],
        titleA: noteTitleOf(entries[i][0]) ?? entries[i][0],
        titleB: noteTitleOf(entries[j][0]) ?? entries[j][0],
        score,
      });
    }
  }
  return out.sort((x, y) => y.score - x.score);
}
