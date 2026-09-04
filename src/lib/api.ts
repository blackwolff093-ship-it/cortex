export { isProjectPath, projectTitle } from "../../shared/project-path";

/* REST client + shared types. All renderer data flows through here. */

export const API = location.port === "5173" ? "http://localhost:7777" : "";

export interface NoteMeta {
  path: string;
  title: string;
  tags: string[];
  mtime: number;
  size: number;
}

export interface Note {
  path: string;
  title: string;
  content: string;
  tags: string[];
  links: string[];
  backlinks: string[];
  mtime: number;
  ctime: number;
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

export type TaskStatus = "TODO" | "IN PROGRESS" | "REVIEW" | "DONE";

export interface Task {
  id: string;
  text: string;
  assignee: string | null;
  status: TaskStatus;
  position: number;
  created: number;
  updated: number;
  /** Vault path of the Projects/*.md note this task belongs to, or null. */
  project: string | null;
  source?: 'kanban' | 'pipeline';
  orch_id?: number;
  current_role?: string;
  orch_status?: string;
  claimed_by?: string | null;
  assigned_agent?: string;
  reject_count?: number;
  dispatch_status?: string | null;
  dispatch_conv_id?: string | null;
  dispatch_launched_at?: number | null;
  dispatch_error?: string | null;
  auto_blocked?: boolean;
  seq?: number | null;
}

export type TaskColumns = Record<TaskStatus, Task[]>;

export interface ActivityRow {
  ts: string;
  agent: string;
  action: string;
  path: string | null;
  detail: string | null;
}

export interface GraphNode {
  id: string;
  title: string;
  tags: string[];
  size: number;
}

export interface GraphEdge {
  source: string;
  target: string;
}

export interface GraphData {
  nodes: GraphNode[];
  edges: GraphEdge[];
}

export interface MirrorSettings {
  mirror_enabled: boolean;
  mirror_path: string;
  /** Path of the Projects/*.md note last opened — TasksView defaults to it. */
  active_project: string;
}

/** A note counts as a "project" if its immediate parent folder is named
 *  "projects" (case-insensitive), at any depth — matches both top-level
 *  Projects/*.md and archived collections like vulpine-memory/projects/*.md.
 *  Single source of truth: TasksView's project list and the "last project
 *  worked on" tracker in lib/store.tsx both use this. */


export type ProtocolKind = "rule" | "skill" | "template";

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

export interface Protocol {
  rules: ProtocolItem[];
  skills: ProtocolItem[];
  templates: ProtocolItem[];
}

/** Where TEXT GENERATION runs. Embeddings are always local/embedded — they are
 *  privacy-critical, run over the whole vault in batches, and must be free. */
export type AiProvider = "embedded" | "cloud";

export interface AiSettings {
  provider: AiProvider;
  /** GGUF path for the on-device generation model ("" = none loaded). */
  gen_model_path: string;
  /** GGUF path for the on-device embedding model (semantic search). */
  embed_model_path: string;
  cloud_base_url: string;
  cloud_model: string;
  /** The key itself is never returned to the renderer — only whether one exists. */
  has_api_key: boolean;
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

export interface IndexStatus {
  indexed: number;
  pending: number;
  totalNotes: number;
  model: string;
  building: boolean;
}

export interface Status {
  name: string;
  version: string;
  port: number;
  db: string;
  root: string;
  stdioPath: string;
  packaged: boolean;
  noteCount: number;
  uptime: number;
  mirror: MirrorSettings;
}

async function jfetch<T>(path: string, init?: RequestInit): Promise<T> {
  let res: Response;
  try {
    res = await fetch(API + path, init);
  } catch {
    throw new Error("LINK DOWN — cannot reach CORTEX core on " + (API || "this host"));
  }
  let body: unknown = null;
  const text = await res.text();
  try {
    body = text ? JSON.parse(text) : null;
  } catch {
    body = text;
  }
  if (!res.ok) {
    const msg =
      body && typeof body === "object" && "error" in (body as Record<string, unknown>)
        ? String((body as Record<string, unknown>).error)
        : res.status + " " + res.statusText;
    throw new Error(msg);
  }
  return body as T;
}

function j(method: string, payload: unknown): RequestInit {
  return {
    method,
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(payload),
  };
}

const enc = encodeURIComponent;

export const api = {
  status: () => jfetch<Status>("/api/status"),
  listNotes: () => jfetch<NoteMeta[]>("/api/notes"),
  readNote: (path: string) => jfetch<Note>("/api/note?path=" + enc(path)),
  writeNote: (path: string, content: string, agent = "user") =>
    jfetch<Note>("/api/note?path=" + enc(path), j("PUT", { content, agent })),
  deleteNote: (path: string) =>
    jfetch<{ ok?: boolean }>("/api/note?path=" + enc(path) + "&agent=user", {
      method: "DELETE",
    }),
  renameNote: (from: string, to: string) =>
    jfetch<Note>("/api/note/rename", j("POST", { from, to, agent: "user" })),
  deleteFolder: (path: string) =>
    jfetch<{ deleted: number; paths: string[] }>(
      "/api/notes/folder?path=" + enc(path) + "&agent=user",
      { method: "DELETE" }
    ),
  search: (q: string) => jfetch<SearchResult[]>("/api/search?q=" + enc(q)),
  graph: () => jfetch<GraphData>("/api/graph"),
  tasks: () => jfetch<{ columns: TaskColumns }>("/api/tasks"),
  tasksUnified: () => jfetch<{ columns: TaskColumns }>("/api/tasks/unified"),
  addTask: (t: { text: string; assignee?: string; status?: string; project?: string }) =>
    jfetch<Task>("/api/tasks", j("POST", { ...t, agent: "user" })),
  updateTask: (
    id: string,
    patch: { status?: string; assignee?: string | null; text?: string; project?: string | null }
  ) => jfetch<Task>("/api/task?id=" + enc(id), j("PATCH", { ...patch, agent: "user" })),
  deleteTask: (id: string) =>
    jfetch<{ ok: boolean }>("/api/task?id=" + enc(id) + "&agent=user", { method: "DELETE" }),
  protocol: () => jfetch<Protocol>("/api/protocol"),
  addProtocol: (t: { kind: ProtocolKind; title: string; body?: string; enabled?: boolean }) =>
    jfetch<ProtocolItem>("/api/protocol", j("POST", { ...t, agent: "user" })),
  updateProtocol: (
    id: string,
    patch: { kind?: ProtocolKind; title?: string; body?: string; enabled?: boolean }
  ) => jfetch<ProtocolItem>("/api/protocol?id=" + enc(id), j("PATCH", { ...patch, agent: "user" })),
  deleteProtocol: (id: string) =>
    jfetch<{ ok: boolean }>("/api/protocol?id=" + enc(id) + "&agent=user", { method: "DELETE" }),
  activity: (limit = 200) => jfetch<ActivityRow[]>("/api/activity?limit=" + limit),
  settings: () => jfetch<MirrorSettings>("/api/settings"),
  saveSettings: (s: Partial<MirrorSettings>) =>
    jfetch<MirrorSettings>("/api/settings", j("PUT", { ...s, agent: "user" })),
  mirrorSync: () => jfetch<{ exported: number; path: string }>("/api/mirror/sync", { method: "POST" }),

  aiSettings: () => jfetch<AiSettings>("/api/ai/settings"),
  saveAiSettings: (s: Partial<AiSettings> & { api_key?: string }) =>
    jfetch<AiSettings>("/api/ai/settings", j("PUT", s)),
  aiStatus: () => jfetch<AiStatus>("/api/ai/status"),
  aiSuggestTags: (path: string) =>
    jfetch<{ tags: string[] }>("/api/ai/suggest-tags", j("POST", { path })),

  /* semantic index */
  indexStatus: () => jfetch<IndexStatus>("/api/ai/index/status"),
  rebuildIndex: () => jfetch<{ ok: boolean }>("/api/ai/index/rebuild", { method: "POST" }),
  similarNotes: (path: string) =>
    jfetch<SimilarNote[]>("/api/notes/similar?path=" + enc(path)),
  duplicateNotes: () => jfetch<DuplicatePair[]>("/api/notes/duplicates"),
};

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

/** Read an SSE stream from a POST endpoint (EventSource is GET-only).
 *  Used for long model downloads that report progress. */
export async function sseStream<T>(
  path: string,
  body: unknown,
  onEvent: (event: string, data: T) => void
): Promise<void> {
  let res: Response;
  try {
    res = await fetch(API + path, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });
  } catch {
    throw new Error("LINK DOWN — cannot reach CORTEX core on " + (API || "this host"));
  }
  if (!res.ok || !res.body) {
    let msg = res.status + " " + res.statusText;
    try {
      const b = (await res.json()) as { error?: string };
      if (b?.error) msg = b.error;
    } catch {
      /* non-JSON error body */
    }
    throw new Error(msg);
  }
  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let buf = "";
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    buf += decoder.decode(value, { stream: true });
    let idx: number;
    while ((idx = buf.indexOf("\n\n")) >= 0) {
      const chunk = buf.slice(0, idx);
      buf = buf.slice(idx + 2);
      const lines = chunk.split("\n");
      const ev = lines.find((l) => l.startsWith("event:"))?.slice(6).trim() ?? "message";
      const raw = lines.find((l) => l.startsWith("data:"))?.slice(5).trim() ?? "";
      if (!raw) continue;
      let parsed: T;
      try {
        parsed = JSON.parse(raw) as T;
      } catch {
        continue;
      }
      if (ev === "error") {
        throw new Error((parsed as { error?: string }).error || "stream error");
      }
      onEvent(ev, parsed);
      if (ev === "done") return;
    }
  }
}

/** Download a model into the app's own models dir, reporting progress. */
export function downloadModel(
  kind: "embed" | "gen",
  onProgress: (pct: number, mb: number, totalMb: number) => void
): Promise<void> {
  return sseStream<{ pct?: number; mb?: number; totalMb?: number }>(
    "/api/ai/download-model",
    { kind },
    (ev, d) => {
      if (ev === "progress" && typeof d.pct === "number") {
        onProgress(d.pct, d.mb ?? 0, d.totalMb ?? 0);
      }
    }
  );
}

/* ------------------------------------------------ orchestrator pipeline */

export type RoleKey = "planner" | "coder" | "security" | "qa";

export type OrchStatus =
  | "PLANNING"
  | "QUEUED"
  | "IN_PROGRESS"
  | "SECURITY_REVIEW"
  | "QA_REVIEW"
  | "FINAL_REVIEW"
  | "COMPLETED"
  | "FAILED";

export interface PipelineRole {
  role_key: RoleKey;
  display_name: string;
  is_required: boolean;
  is_enabled: boolean;
  assigned_agent: string;
  model: string;
  auto_advance: boolean; auto_dispatch: boolean;
  position: number;
}

export interface OrchTask {
  id: number;
  title: string;
  description: string; needs_planning?: boolean;
  current_role: RoleKey;
  status: OrchStatus;
  assigned_agent: string;
  context_files: string[];
  diff_payload: string | null;
  feedback: string | null;
  execution_mode: "auto" | "manual";
  created_at: number;
  updated_at: number;
  claimed_by: string | null;
  claimed_at: number | null;
  gate_pending: boolean;
  pending_role: RoleKey | null;
  pending_status: OrchStatus | null;
  reject_count: number;
  project: string | null;
  dispatch_status?: string | null;
  dispatch_conv_id?: string | null;
  dispatch_launched_at?: number | null;
  dispatch_error?: string | null;
  auto_blocked?: boolean;
  seq?: number | null;
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

export interface OrchBrief {
  task: OrchTask;
  audit: OrchAuditRow[];
  pipeline: PipelineRole[];
  active_dispatch_task?: { task_id: number; title?: string };
  global_active_dispatch?: { id: number; title: string } | null;
}

/** The agents a role can be assigned to. `local_model` is the app's own
 *  on-device GGUF, driven through cortex_ask_local_model. */
export const ORCH_AGENTS = ["claude", "antigravity", "opencode", "chatgpt", "local_model"] as const;

/** The models a role can run on, keyed by agent: a model name is only meaningful
 *  to its own CLI (`opus` says nothing to opencode), so each agent carries its own
 *  list. The `""` entry means "leave it to the launcher's built-in default".
 *  `chatgpt` and `local_model` have no launcher, so they have no list. */
export const ORCH_MODELS: Record<string, readonly { value: string; label: string }[]> = {
  claude: [
    { value: "", label: "default (opus)" },
    { value: "opus", label: "opus — strong and balanced" },
    { value: "sonnet", label: "sonnet — faster and cheaper" },
    { value: "haiku", label: "haiku — fastest and cheapest" },
    { value: "fable", label: "fable — most capable" },
  ],
  antigravity: [
    { value: "", label: "default (pro)" },
    { value: "pro", label: "pro — most capable" },
    { value: "flash", label: "flash — faster and cheaper" },
    { value: "flash_lite", label: "flash_lite — fastest and cheapest" },
  ],
  opencode: [
    { value: "", label: "default (nemotron-3.5-lightning-free)" },
    { value: "opencode/big-pickle", label: "opencode/big-pickle" },
    { value: "opencode/hy3-free", label: "opencode/hy3-free · free" },
    { value: "opencode/mimo-v2.5-free", label: "opencode/mimo-v2.5-free · free" },
    { value: "opencode/muse-spark-1.2-contributor-free", label: "opencode/muse-spark-1.2-contributor-free · free" },
    { value: "opencode/nemotron-3-ultra-free", label: "opencode/nemotron-3-ultra-free · free" },
    { value: "opencode/nemotron-3.5-lightning-free", label: "opencode/nemotron-3.5-lightning-free · free" },
    { value: "opencode/x-preview-f-free", label: "opencode/x-preview-f-free · free" },
    { value: "cloudflare-workers-ai/@cf/aisingapore/gemma-sea-lion-v4-27b-it", label: "cloudflare-workers-ai/@cf/aisingapore/gemma-sea-lion-v4-27b-it" },
    { value: "cloudflare-workers-ai/@cf/deepseek-ai/deepseek-r1-distill-qwen-32b", label: "cloudflare-workers-ai/@cf/deepseek-ai/deepseek-r1-distill-qwen-32b" },
    { value: "cloudflare-workers-ai/@cf/deepseek-ai/deepseek-v4-flash-0731", label: "cloudflare-workers-ai/@cf/deepseek-ai/deepseek-v4-flash-0731" },
    { value: "cloudflare-workers-ai/@cf/deepseek-ai/deepseek-v4-pro-0813", label: "cloudflare-workers-ai/@cf/deepseek-ai/deepseek-v4-pro-0813" },
    { value: "cloudflare-workers-ai/@cf/google/gemma-4-26b-a4b-it", label: "cloudflare-workers-ai/@cf/google/gemma-4-26b-a4b-it" },
    { value: "cloudflare-workers-ai/@cf/ibm-granite/granite-4.0-h-micro", label: "cloudflare-workers-ai/@cf/ibm-granite/granite-4.0-h-micro" },
    { value: "cloudflare-workers-ai/@cf/meta/llama-3.1-8b-instruct-fp8", label: "cloudflare-workers-ai/@cf/meta/llama-3.1-8b-instruct-fp8" },
    { value: "cloudflare-workers-ai/@cf/meta/llama-3.2-11b-vision-instruct", label: "cloudflare-workers-ai/@cf/meta/llama-3.2-11b-vision-instruct" },
    { value: "cloudflare-workers-ai/@cf/meta/llama-3.2-1b-instruct", label: "cloudflare-workers-ai/@cf/meta/llama-3.2-1b-instruct" },
    { value: "cloudflare-workers-ai/@cf/meta/llama-3.2-3b-instruct", label: "cloudflare-workers-ai/@cf/meta/llama-3.2-3b-instruct" },
    { value: "cloudflare-workers-ai/@cf/meta/llama-3.3-70b-instruct-fp8-fast", label: "cloudflare-workers-ai/@cf/meta/llama-3.3-70b-instruct-fp8-fast" },
    { value: "cloudflare-workers-ai/@cf/meta/llama-4-scout-17b-16e-instruct", label: "cloudflare-workers-ai/@cf/meta/llama-4-scout-17b-16e-instruct" },
    { value: "cloudflare-workers-ai/@cf/meta/llama-guard-3-8b", label: "cloudflare-workers-ai/@cf/meta/llama-guard-3-8b" },
    { value: "cloudflare-workers-ai/@cf/mistralai/mistral-small-3.1-24b-instruct", label: "cloudflare-workers-ai/@cf/mistralai/mistral-small-3.1-24b-instruct" },
    { value: "cloudflare-workers-ai/@cf/moonshotai/kimi-k2.6", label: "cloudflare-workers-ai/@cf/moonshotai/kimi-k2.6" },
    { value: "cloudflare-workers-ai/@cf/moonshotai/kimi-k2.7-code", label: "cloudflare-workers-ai/@cf/moonshotai/kimi-k2.7-code" },
    { value: "cloudflare-workers-ai/@cf/nvidia/nemotron-3-120b-a12b", label: "cloudflare-workers-ai/@cf/nvidia/nemotron-3-120b-a12b" },
    { value: "cloudflare-workers-ai/@cf/openai/gpt-oss-120b", label: "cloudflare-workers-ai/@cf/openai/gpt-oss-120b" },
    { value: "cloudflare-workers-ai/@cf/openai/gpt-oss-20b", label: "cloudflare-workers-ai/@cf/openai/gpt-oss-20b" },
    { value: "cloudflare-workers-ai/@cf/qwen/qwen2.5-coder-32b-instruct", label: "cloudflare-workers-ai/@cf/qwen/qwen2.5-coder-32b-instruct" },
    { value: "cloudflare-workers-ai/@cf/qwen/qwen3-30b-a3b-fp8", label: "cloudflare-workers-ai/@cf/qwen/qwen3-30b-a3b-fp8" },
    { value: "cloudflare-workers-ai/@cf/qwen/qwen3.8-27b", label: "cloudflare-workers-ai/@cf/qwen/qwen3.8-27b" },
    { value: "cloudflare-workers-ai/@cf/qwen/qwq-32b", label: "cloudflare-workers-ai/@cf/qwen/qwq-32b" },
    { value: "cloudflare-workers-ai/@cf/zai-org/glm-4.7-flash", label: "cloudflare-workers-ai/@cf/zai-org/glm-4.7-flash" },
    { value: "cloudflare-workers-ai/@cf/zai-org/glm-5.2", label: "cloudflare-workers-ai/@cf/zai-org/glm-5.2" },
    { value: "lmstudio/openai/gpt-oss-20b", label: "lmstudio/openai/gpt-oss-20b · local" },
    { value: "lmstudio/qwen/qwen3-30b-a3b-2507", label: "lmstudio/qwen/qwen3-30b-a3b-2507 · local" },
    { value: "lmstudio/qwen/qwen3-coder-30b", label: "lmstudio/qwen/qwen3-coder-30b · local" },
    { value: "ollama-cloud/deepseek-v4-flash", label: "ollama-cloud/deepseek-v4-flash" },
    { value: "ollama-cloud/deepseek-v4-flash:0731", label: "ollama-cloud/deepseek-v4-flash:0731" },
    { value: "ollama-cloud/deepseek-v4-pro", label: "ollama-cloud/deepseek-v4-pro" },
    { value: "ollama-cloud/gemma4:31b", label: "ollama-cloud/gemma4:31b" },
    { value: "ollama-cloud/glm-5.1", label: "ollama-cloud/glm-5.1" },
    { value: "ollama-cloud/glm-5.2", label: "ollama-cloud/glm-5.2" },
    { value: "ollama-cloud/gpt-oss:120b", label: "ollama-cloud/gpt-oss:120b" },
    { value: "ollama-cloud/gpt-oss:20b", label: "ollama-cloud/gpt-oss:20b" },
    { value: "ollama-cloud/kimi-k2.5", label: "ollama-cloud/kimi-k2.5" },
    { value: "ollama-cloud/kimi-k2.6", label: "ollama-cloud/kimi-k2.6" },
    { value: "ollama-cloud/kimi-k2.7-code", label: "ollama-cloud/kimi-k2.7-code" },
    { value: "ollama-cloud/kimi-k3", label: "ollama-cloud/kimi-k3" },
    { value: "ollama-cloud/minimax-m2.5", label: "ollama-cloud/minimax-m2.5" },
    { value: "ollama-cloud/minimax-m2.7", label: "ollama-cloud/minimax-m2.7" },
    { value: "ollama-cloud/minimax-m3", label: "ollama-cloud/minimax-m3" },
    { value: "ollama-cloud/mistral-large-3:675b", label: "ollama-cloud/mistral-large-3:675b" },
    { value: "ollama-cloud/nemotron-3-nano:30b", label: "ollama-cloud/nemotron-3-nano:30b" },
    { value: "ollama-cloud/nemotron-3-super", label: "ollama-cloud/nemotron-3-super" },
    { value: "ollama-cloud/nemotron-3-ultra", label: "ollama-cloud/nemotron-3-ultra" },
    { value: "ollama-cloud/qwen3.5:397b", label: "ollama-cloud/qwen3.5:397b" },
  ],
};

export const orchApi = {
  config: () => jfetch<PipelineRole[]>("/api/orchestrator/config"),
  saveRole: (
    role: RoleKey,
    patch: { is_enabled?: boolean; assigned_agent?: string; model?: string; auto_advance?: boolean; auto_dispatch?: boolean }
  ) =>
    jfetch<PipelineRole>(
      "/api/orchestrator/config?role=" + enc(role),
      j("PATCH", { ...patch, agent: "user" })
    ),
  tasks: () => jfetch<OrchTask[]>("/api/orchestrator/tasks"),
  /** The local model refines the user's prose into a task spec. Slow (seconds) — show a pending state. */
  compose: (text: string) =>
    jfetch<{ title: string; description: string; raw: string }>(
      "/api/orchestrator/compose",
      j("POST", { text })
    ),
  /** Per-task implementer/reviewer choice. Empty = fall back to the global pipeline config. */
  setAgents: (
    id: number,
    patch: { coder_agent?: string; coder_model?: string; reviewer_agent?: string; reviewer_model?: string }
  ) =>
    jfetch<OrchTask>(
      "/api/orchestrator/task-agents?id=" + id,
      j("PATCH", { ...patch, agent: "user" })
    ),
  brief: (id: number) => jfetch<OrchBrief>("/api/orchestrator/task?id=" + id),
  create: (t: {
    title: string;
    description: string; needs_planning?: boolean;
    context_files?: string[];
    execution_mode?: "auto" | "manual";
    project?: string;
  }) => jfetch<OrchTask>("/api/orchestrator/tasks", j("POST", { ...t, agent: "user" })),
  updateTask: (id: number, patch: { project?: string | null }) =>
    jfetch<OrchTask>("/api/orchestrator/task?id=" + id, j("PATCH", { ...patch, agent: "user" })),

  remove: (id: number) =>
    jfetch<{ ok: boolean }>("/api/orchestrator/task?id=" + id + "&agent=user", { method: "DELETE" }),
  dispatch: (taskId: number) =>
    jfetch<{ ok: boolean; conversation_id?: string; error?: string }>("/api/orchestrator/dispatch", j("POST", { task_id: taskId, agent: "user" })),
  releaseGate: (id: number) =>
    jfetch<OrchTask>("/api/orchestrator/gate", j("POST", { task_id: id, agent: "user" })),
  retry: (id: number) =>
    jfetch<OrchTask>("/api/orchestrator/retry", j("POST", { task_id: id, agent: "user" })),
  requeue: (id: number, reason?: string) =>
    jfetch<OrchTask>("/api/orchestrator/requeue", j("POST", { task_id: id, reason, agent: "user" })),
  /** Lets the user act as a reviewer from the UI (manual pipelines). */
  review: (id: number, status: "APPROVED" | "REJECTED", feedback: string) =>
    jfetch<OrchTask>(
      "/api/orchestrator/review",
      j("POST", { task_id: id, status, feedback, agent: "user" })
    ),
  stop: (id: number) =>
    jfetch<OrchTask>("/api/orchestrator/stop", j("POST", { task_id: id, agent: "user" })),
  resumeAuto: (id: number) =>
    jfetch<OrchTask>("/api/orchestrator/resume_auto", j("POST", { task_id: id, agent: "user" })),
  move: (id: number, target_column: string) =>
    jfetch<OrchTask>("/api/orchestrator/move", j("POST", { task_id: id, target_column, agent: "user" })),
};

/* ------------------------------------------------------ librarian (AI upkeep) */

export interface Finding {
  severity: "high" | "medium" | "low";
  kind: string;
  line: number;
  excerpt: string;
  advice: string;
}

export interface PendingItem {
  path: string;
  title: string;
  kind: "unchecked-box" | "stale-note" | "open-question";
  detail: string;
  line: number;
  ageDays: number;
}

export interface Plan {
  phases: { title: string; steps: string[] }[];
  source: string;
}

export interface ConflictReport {
  checked: number;
  conflicts: {
    a: string;
    b: string;
    reason: string;
    quote_a: string;
    quote_b: string;
    similarity: number;
  }[];
}

export interface RollupCard {
  task_id: number;
  done: string[];
  remaining: string[];
  decisions: string[];
}

export const librarian = {
  pending: () => jfetch<{ items: PendingItem[]; counts: Record<string, number> }>("/api/librarian/pending"),
  scan: (body: { text?: string; path?: string }) =>
    jfetch<{ findings: Finding[]; safe: boolean }>("/api/librarian/scan", j("POST", body)),
  autolink: (path: string) => jfetch<SimilarNote[]>("/api/librarian/autolink?path=" + enc(path)),
  plan: (path: string) => jfetch<Plan>("/api/librarian/plan", j("POST", { path })),
  mockdata: (path: string) => jfetch<{ data: unknown; source: string }>("/api/librarian/mockdata", j("POST", { path })),
  rollup: (taskId: number) => jfetch<RollupCard>("/api/librarian/rollup", j("POST", { task_id: taskId })),
  conflicts: () => jfetch<ConflictReport>("/api/librarian/conflicts"),
  docs: (topic: string) =>
    jfetch<{ markdown: string; sources: string[] }>("/api/librarian/docs", j("POST", { topic })),
};

/* -------------------------------------------------- agent color system */

export type AgentName = "claude" | "chatgpt" | "user" | string;

export function agentTextClass(agent: string): string {
  switch ((agent || "").toLowerCase()) {
    case "claude":
      return "text-amber";
    case "chatgpt":
      return "text-violet";
    case "user":
      return "text-neon";
    default:
      return "text-muted";
  }
}

export function agentHex(agent: string): string {
  switch ((agent || "").toLowerCase()) {
    case "claude":
      return "#ffb300";
    case "chatgpt":
      return "#b388ff";
    case "user":
      return "#00ff66";
    default:
      return "#4e8064";
  }
}

export function agentBadgeClass(agent: string): string {
  switch ((agent || "").toLowerCase()) {
    case "claude":
      return "text-amber border-amber/40 bg-amber/10";
    case "chatgpt":
      return "text-violet border-violet/40 bg-violet/10";
    case "user":
      return "text-neon border-neon/40 bg-neon/10";
    default:
      return "text-muted border-line bg-panel";
  }
}


