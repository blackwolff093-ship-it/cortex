/* Agent connection guide (Arabic explanations) + mirror settings. */

import { useCallback, useEffect, useMemo, useState } from "react";
import {
  api,
  downloadModel,
  type AiProvider,
  type AiSettings,
  type AiStatus,
  type IndexStatus,
  type MirrorSettings,
} from "../lib/api";
import { useStore } from "../lib/store";

function mb(bytes: number | null): string {
  return bytes === null ? "—" : (bytes / 1e6).toFixed(0) + "MB";
}

const TABS = [
  "CLAUDE CODE",
  "CLAUDE DESKTOP",
  
  "CHATGPT",
  "REST API",
] as const;
type Tab = (typeof TABS)[number];

function CodeBlock({ label, code }: { label?: string; code: string }) {
  const [copied, setCopied] = useState(false);
  const copy = async () => {
    try {
      await navigator.clipboard.writeText(code);
      setCopied(true);
      setTimeout(() => setCopied(false), 1400);
    } catch {
      /* clipboard unavailable */
    }
  };
  return (
    <div className="border border-line bg-panel2">
      <div className="flex items-center justify-between h-7 px-3 border-b border-line/70">
        <span className="text-[10px] tracking-[.2em] text-muted uppercase">
          {label ?? "SHELL"}
        </span>
        <button
          onClick={() => void copy()}
          className={
            "text-[10px] tracking-[.15em] px-2 leading-5 border " +
            (copied
              ? "border-neon-dim text-neon"
              : "border-line text-muted hover:text-cyan hover:border-cyan/50")
          }
        >
          {copied ? "✓ COPIED" : "COPY"}
        </button>
      </div>
      <pre className="p-3 overflow-x-auto text-[11.5px] leading-5 text-cyan whitespace-pre" dir="ltr">
        {code}
      </pre>
    </div>
  );
}

function Explain({ children }: { children: string }) {
  return (
    <p dir="auto" className="text-[12.5px] text-ink leading-7">
      {children}
    </p>
  );
}

export default function ConnectView() {
  const { status, refreshStatus, pushError } = useStore();
  const [tab, setTab] = useState<Tab>("CLAUDE CODE");
  const [mirror, setMirror] = useState<MirrorSettings | null>(null);
  const [syncMsg, setSyncMsg] = useState<string | null>(null);
  const [pathDraft, setPathDraft] = useState("");
  const [ai, setAi] = useState<AiSettings | null>(null);
  const [aiStatus, setAiStatus] = useState<AiStatus | null>(null);
  const [index, setIndex] = useState<IndexStatus | null>(null);
  const [genDraft, setGenDraft] = useState("");
  const [keyDraft, setKeyDraft] = useState("");
  const [cloudUrlDraft, setCloudUrlDraft] = useState("");
  const [cloudModelDraft, setCloudModelDraft] = useState("");
  const [dl, setDl] = useState<{ kind: string; pct: number; mb: number; total: number } | null>(null);

  const refreshAi = useCallback(() => {
    api.aiSettings()
      .then((s) => {
        setAi(s);
        setGenDraft(s.gen_model_path);
        setCloudUrlDraft(s.cloud_base_url);
        setCloudModelDraft(s.cloud_model);
      })
      .catch((e) => pushError((e as Error).message));
    api.aiStatus().then(setAiStatus).catch(() => setAiStatus(null));
    api.indexStatus().then(setIndex).catch(() => setIndex(null));
  }, [pushError]);

  useEffect(() => {
    void refreshStatus();
    api
      .settings()
      .then((s) => {
        setMirror(s);
        setPathDraft(s.mirror_path);
      })
      .catch((e) => pushError((e as Error).message));
    refreshAi();
  }, [refreshStatus, pushError, refreshAi]);

  /* Indexing runs in the background — poll while it has work left. */
  useEffect(() => {
    if (!index || (index.pending === 0 && !index.building)) return;
    const t = setTimeout(() => {
      api.indexStatus().then(setIndex).catch(() => {});
    }, 2000);
    return () => clearTimeout(t);
  }, [index]);

  const saveAi = async (patch: Partial<AiSettings> & { api_key?: string }) => {
    try {
      const s = await api.saveAiSettings(patch);
      setAi(s);
      setGenDraft(s.gen_model_path);
      api.aiStatus().then(setAiStatus).catch(() => {});
      api.indexStatus().then(setIndex).catch(() => {});
    } catch (e) {
      pushError((e as Error).message);
    }
  };

  const runDownload = async (kind: "embed" | "gen") => {
    setDl({ kind, pct: 0, mb: 0, total: 0 });
    try {
      await downloadModel(kind, (pct, mb, total) => setDl({ kind, pct, mb, total }));
      refreshAi();
    } catch (e) {
      pushError((e as Error).message);
    } finally {
      setDl(null);
    }
  };

  const port = status?.port ?? 7777;
  const stdio = status?.stdioPath ?? "<CORTEX>/dist-electron/mcp-stdio.cjs";
  const mcpUrl = `http://localhost:${port}/mcp`;

  const blocks = useMemo(() => {
    switch (tab) {
      case "CLAUDE CODE":
        return (
          <>
            <Explain>
              Run this in your terminal so Claude Code can read and write the shared
              CORTEX memory (notes + tasks):
            </Explain>
            <CodeBlock
              label="TERMINAL — stdio"
              code={`claude mcp add cortex -- node ${stdio} --agent claude`}
            />
            <Explain>Or over plain HTTP (the app must be running):</Explain>
            <CodeBlock
              label="TERMINAL — http"
              code={`claude mcp add --transport http cortex ${mcpUrl}`}
            />
          </>
        );
      case "CLAUDE DESKTOP":
        return (
          <>
            <Explain>
              Add this to claude_desktop_config.json, then restart
              Claude Desktop:
            </Explain>
            <CodeBlock
              label="claude_desktop_config.json"
              code={JSON.stringify(
                {
                  mcpServers: {
                    cortex: {
                      command: "node",
                      args: [stdio, "--agent", "claude"],
                    },
                  },
                },
                null,
                2
              )}
            />
          </>
        );
        return (
          <>
            <Explain>
              In ChatGPT enable Developer mode in settings, then add a new Connector
              pointing at this URL (it only works while the app is open on the same machine):
            </Explain>
            <CodeBlock label="MCP CONNECTOR URL" code={mcpUrl} />
            <Explain>
              And if MCP is not available to you, use the REST API directly — see the
              REST API.
            </Explain>
          </>
        );
      case "REST API":
        return (
          <>
            <Explain>
              Any tool that can send HTTP can talk to the memory directly. Pass the agent
              identity via X-Agent:
            </Explain>
            <CodeBlock
              label="curl"
              code={[
                `# list notes`,
                `curl -s http://localhost:${port}/api/notes -H "X-Agent: claude"`,
                ``,
                `# read a note`,
                `curl -s "http://localhost:${port}/api/note?path=Welcome.md" -H "X-Agent: claude"`,
                ``,
                `# write / update a note`,
                `curl -s -X PUT "http://localhost:${port}/api/note?path=Ideas/plan.md" \\`,
                `  -H "Content-Type: application/json" -H "X-Agent: claude" \\`,
                `  -d '{"content":"# Plan\\n- step one"}'`,
                ``,
                `# search`,
                `curl -s "http://localhost:${port}/api/search?q=plan" -H "X-Agent: claude"`,
                ``,
                `# kanban tasks`,
                `curl -s http://localhost:${port}/api/tasks -H "X-Agent: claude"`,
                `curl -s -X POST http://localhost:${port}/api/tasks \\`,
                `  -H "Content-Type: application/json" -H "X-Agent: claude" \\`,
                `  -d '{"text":"review the plan","assignee":"claude"}'`,
              ].join("\n")}
            />
          </>
        );
    }
  }, [tab, stdio, mcpUrl, port]);

  const saveMirror = async (patch: Partial<MirrorSettings>) => {
    try {
      const s = await api.saveSettings(patch);
      setMirror(s);
      setPathDraft(s.mirror_path);
    } catch (e) {
      pushError((e as Error).message);
    }
  };

  const syncNow = async () => {
    setSyncMsg(null);
    try {
      const r = await api.mirrorSync();
      setSyncMsg(`EXPORTED ${r.exported} → ${r.path}`);
    } catch (e) {
      pushError((e as Error).message);
    }
  };

  return (
    <div className="flex-1 min-h-0 overflow-y-auto">
      <div className="max-w-3xl px-6 py-5 space-y-6">
        <div>
          <h1 className="text-neon glow text-lg font-bold tracking-[.1em]">
            UPLINK PROTOCOLS
          </h1>
          <p dir="auto" className="text-[12.5px] text-muted leading-7 mt-1">
            Connect your AI agents to the shared CORTEX memory — every agent shows up
            in its own color across the log, the notes and the tasks.
          </p>
          {status && (
            <div className="mt-2 text-[10px] text-faint tracking-[.1em] break-all">
              CORE v{status.version} · PORT {status.port} · DB {status.db}
            </div>
          )}
        </div>

        {/* tabs */}
        <div className="flex flex-wrap gap-2 border-b border-line pb-3">
          {TABS.map((t) => (
            <button
              key={t}
              onClick={() => setTab(t)}
              className={
                "text-[10px] tracking-[.15em] px-3 h-7 border " +
                (tab === t
                  ? "border-neon-dim text-neon bg-neon/5 glow"
                  : "border-line text-muted hover:text-ink hover:border-line-hi")
              }
            >
              {t}
            </button>
          ))}
        </div>

        <div className="space-y-3">{blocks}</div>

        <div
          dir="auto"
          className="border border-amber/40 bg-amber/5 text-amber text-[12px] leading-6 px-3 py-2"
        >
          ⚠ The app must be running for the tools to work — agents connect to the core
          on port {port}.
        </div>

        {/* mirror settings */}
        <div className="border border-line bg-panel/50">
          <div className="h-9 px-3 border-b border-line flex items-center gap-2">
            <span className="text-[11px] tracking-[.2em] text-neon">
              ▸ OBSIDIAN MIRROR
            </span>
            <span className="flex-1" />
            <button
              onClick={() =>
                void saveMirror({ mirror_enabled: !mirror?.mirror_enabled })
              }
              className={
                "text-[10px] tracking-[.15em] px-2 h-6 border " +
                (mirror?.mirror_enabled
                  ? "border-neon-dim text-neon bg-neon/10"
                  : "border-line text-muted hover:text-ink")
              }
            >
              {mirror?.mirror_enabled ? "◉ ENABLED" : "○ DISABLED"}
            </button>
          </div>
          <div className="p-3 space-y-3">
            <p dir="auto" className="text-[12px] text-muted leading-6">
              Mirrors every note as a .md file into an external folder after each edit — open
              that folder in Obsidian as a live read-only copy.
            </p>
            <div className="flex gap-2">
              <input
                dir="ltr"
                spellCheck={false}
                value={pathDraft}
                onChange={(e) => setPathDraft(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === "Enter")
                    void saveMirror({ mirror_path: pathDraft.trim() });
                }}
                placeholder="/Users/you/CortexMirror"
                className="flex-1 bg-bg2 border border-line focus:border-line-hi outline-none text-xs text-ink h-8 px-2 placeholder:text-faint"
              />
              <button
                className="border border-line text-ink px-3 h-8 text-[11px] hover:border-neon-dim hover:text-neon disabled:opacity-40"
                disabled={!mirror || pathDraft.trim() === mirror.mirror_path}
                onClick={() => void saveMirror({ mirror_path: pathDraft.trim() })}
              >
                SAVE
              </button>
              <button
                className="border border-cyan/50 text-cyan px-3 h-8 text-[11px] hover:bg-cyan/10 disabled:opacity-40"
                disabled={!mirror?.mirror_path}
                onClick={() => void syncNow()}
              >
                SYNC NOW
              </button>
            </div>
            {syncMsg && (
              <div className="text-[11px] text-neon-dim break-all">✓ {syncMsg}</div>
            )}
          </div>
        </div>

        {/* on-device AI — no external server, no local port */}
        <div className="border border-line bg-panel/50">
          <div className="h-9 px-3 border-b border-line flex items-center gap-2">
            <span className="text-[11px] tracking-[.2em] text-neon">▸ ON-DEVICE AI</span>
            <span className="flex-1" />
            <span className="text-[10px] text-faint tracking-[.1em]">
              {aiStatus?.gpu ? `GPU: ${aiStatus.gpu.toUpperCase()}` : "100% local"}
            </span>
          </div>
          <div className="p-3 space-y-4">
            <p dir="auto" className="text-[12px] text-muted leading-6">
              The AI is embedded in the app — it runs GGUF weights inside the app's own process,
              with no Ollama, no server and no network port. It powers semantic search, tag and link suggestions,
              and the <code className="text-cyan">cortex_ask_local_model</code> tool for agents.
            </p>

            {/* --- embedding model (semantic search) --- */}
            <div className="border border-line/70 bg-bg2/40 p-3 space-y-2">
              <div className="flex items-center gap-2">
                <span className="text-[10px] tracking-[.2em] text-neon-dim">◈ SEARCH MODEL</span>
                <span className="flex-1" />
                <span className="text-[10px] text-faint">
                  {aiStatus?.embed.exists
                    ? `${mb(aiStatus.embed.size)} · ${aiStatus.embed.loaded ? "loaded" : "Ready"}`
                    : "not installed"}
                </span>
              </div>
              <p dir="auto" className="text-[11px] text-faint leading-5">
                A small model (~334MB) for meaning-based search and similarity. Required for semantic search.
              </p>
              {aiStatus?.embed.exists ? (
                <div className="text-[10px] text-neon-dim break-all" dir="ltr">
                  ✓ {aiStatus.embed.path}
                </div>
              ) : (
                <button
                  disabled={dl !== null}
                  onClick={() => void runDownload("embed")}
                  className="border border-neon-dim text-neon px-3 h-7 text-[11px] hover:bg-neon/10 disabled:opacity-40"
                >
                  {dl?.kind === "embed" ? `⇩ ${dl.pct}%` : "⇩ Download the search model"}
                </button>
              )}
              {dl?.kind === "embed" && (
                <div className="h-1 bg-line">
                  <div className="h-1 bg-neon transition-all" style={{ width: `${dl.pct}%` }} />
                </div>
              )}

              {/* index status */}
              <div className="flex items-center gap-2 pt-1">
                <span className="text-[10px] text-faint tracking-[.1em]">INDEX</span>
                <span className="text-[11px] text-ink tabular-nums">
                  {index ? `${index.indexed}/${index.totalNotes}` : "—"}
                </span>
                {index && index.pending > 0 && (
                  <span className="text-[10px] text-amber">{index.pending} pending…</span>
                )}
                {index?.building && <span className="text-[10px] text-cyan animate-pulse">Indexing…</span>}
                <span className="flex-1" />
                <button
                  onClick={() => {
                    void api.rebuildIndex()
                      .then(() => api.indexStatus().then(setIndex))
                      .catch((e) => pushError((e as Error).message));
                  }}
                  className="border border-line text-muted px-2 h-6 text-[10px] hover:text-cyan hover:border-cyan/50"
                >
                  ⟳ Reindex
                </button>
              </div>
            </div>

            {/* --- generation: embedded or cloud --- */}
            <div className="border border-line/70 bg-bg2/40 p-3 space-y-2">
              <div className="flex items-center gap-2 flex-wrap">
                <span className="text-[10px] tracking-[.2em] text-neon-dim">◈ WRITING MODEL</span>
                <span className="flex-1" />
                {(["embedded", "cloud"] as AiProvider[]).map((p) => (
                  <button
                    key={p}
                    onClick={() => void saveAi({ provider: p })}
                    className={
                      "text-[10px] tracking-[.15em] px-2 h-6 border " +
                      (ai?.provider === p
                        ? "border-neon-dim text-neon bg-neon/10"
                        : "border-line text-muted hover:text-ink")
                    }
                  >
                    {p === "embedded" ? "Local model" : "API key"}
                  </button>
                ))}
              </div>
              <p dir="auto" className="text-[11px] text-faint leading-5">
                For tag suggestions, summarising and agent task delegation. Optional — search works without it.
              </p>

              {ai?.provider === "cloud" ? (
                <div className="space-y-2">
                  <input
                    dir="ltr"
                    spellCheck={false}
                    value={cloudUrlDraft}
                    onChange={(e) => setCloudUrlDraft(e.target.value)}
                    placeholder="https://api.openai.com/v1"
                    className="w-full bg-bg2 border border-line focus:border-line-hi outline-none text-xs text-ink h-8 px-2 placeholder:text-faint"
                  />
                  <input
                    dir="ltr"
                    spellCheck={false}
                    value={cloudModelDraft}
                    onChange={(e) => setCloudModelDraft(e.target.value)}
                    placeholder="gpt-4o-mini"
                    className="w-full bg-bg2 border border-line focus:border-line-hi outline-none text-xs text-ink h-8 px-2 placeholder:text-faint"
                  />
                  <div className="flex gap-2">
                    <input
                      dir="ltr"
                      type="password"
                      spellCheck={false}
                      value={keyDraft}
                      onChange={(e) => setKeyDraft(e.target.value)}
                      placeholder={ai.has_api_key ? "•••••••• saved — type a new key to replace it" : "sk-…"}
                      className="flex-1 bg-bg2 border border-line focus:border-line-hi outline-none text-xs text-ink h-8 px-2 placeholder:text-faint"
                    />
                    <button
                      onClick={() => {
                        void saveAi({
                          cloud_base_url: cloudUrlDraft.trim(),
                          cloud_model: cloudModelDraft.trim(),
                          ...(keyDraft.trim() ? { api_key: keyDraft.trim() } : {}),
                        }).then(() => setKeyDraft(""));
                      }}
                      className="border border-line text-ink px-3 h-8 text-[11px] hover:border-neon-dim hover:text-neon"
                    >
                      SAVE
                    </button>
                  </div>
                  <p dir="auto" className="text-[10px] text-faint leading-5">
                    🔒 The key is encrypted with the system Keychain and never read back into the UI.
                  </p>
                </div>
              ) : (
                <div className="space-y-2">
                  <div className="flex gap-2">
                    <input
                      dir="ltr"
                      spellCheck={false}
                      value={genDraft}
                      onChange={(e) => setGenDraft(e.target.value)}
                      onKeyDown={(e) => {
                        if (e.key === "Enter") void saveAi({ gen_model_path: genDraft.trim() });
                      }}
                      placeholder="/path/to/model.gguf"
                      className="flex-1 bg-bg2 border border-line focus:border-line-hi outline-none text-xs text-ink h-8 px-2 placeholder:text-faint"
                    />
                    <button
                      disabled={!ai || genDraft.trim() === ai.gen_model_path}
                      onClick={() => void saveAi({ gen_model_path: genDraft.trim() })}
                      className="border border-line text-ink px-3 h-8 text-[11px] hover:border-neon-dim hover:text-neon disabled:opacity-40"
                    >
                      LOAD
                    </button>
                  </div>
                  <div className="flex items-center gap-2">
                    <span className="text-[10px] text-faint">
                      {aiStatus?.gen.exists
                        ? `✓ ${mb(aiStatus.gen.size)} · ${aiStatus.gen.loaded ? "loaded" : "Ready"}`
                        : "No model"}
                    </span>
                    <span className="flex-1" />
                    <button
                      disabled={dl !== null}
                      onClick={() => void runDownload("gen")}
                      className="border border-line text-muted px-2 h-6 text-[10px] hover:text-cyan hover:border-cyan/50 disabled:opacity-40"
                    >
                      {dl?.kind === "gen" ? `⇩ ${dl.pct}%` : "⇩ Download a small model"}
                    </button>
                  </div>
                  {dl?.kind === "gen" && (
                    <div className="h-1 bg-line">
                      <div className="h-1 bg-cyan transition-all" style={{ width: `${dl.pct}%` }} />
                    </div>
                  )}
                </div>
              )}
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}
