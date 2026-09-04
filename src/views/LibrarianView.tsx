/* LIBRARIAN — the on-device model doing upkeep on the vault.
   Deterministic scanners (pending work, guardrails) run instantly; the
   model-backed panels are on-demand because a local GGUF takes seconds. */

import { useCallback, useEffect, useState } from "react";
import {
  librarian,
  type ConflictReport,
  type Finding,
  type PendingItem,
  type Plan,
} from "../lib/api";
import { useStore } from "../lib/store";

function Panel({
  title,
  hint,
  action,
  busy,
  children,
}: {
  title: string;
  hint: string;
  action?: { label: string; onClick: () => void };
  busy?: boolean;
  children?: React.ReactNode;
}) {
  return (
    <div className="border border-line bg-panel/50">
      <div className="h-9 px-3 border-b border-line flex items-center gap-2">
        <span className="text-[11px] tracking-[.2em] text-neon">▸ {title}</span>
        <span className="flex-1" />
        {action && (
          <button
            disabled={busy}
            onClick={action.onClick}
            className="border border-line text-muted px-2 h-6 text-[10px] tracking-[.1em] hover:text-cyan hover:border-cyan/50 disabled:opacity-40"
          >
            {busy ? "…" : action.label}
          </button>
        )}
      </div>
      <div className="p-3 space-y-2">
        <p dir="auto" className="text-[11px] text-faint leading-5">
          {hint}
        </p>
        {children}
      </div>
    </div>
  );
}

const KIND_LABEL: Record<PendingItem["kind"], string> = {
  "unchecked-box": "Unfinished item",
  "stale-note": "Stalled note",
  "open-question": "Open question",
};

export default function LibrarianView() {
  const { notes, openNote, pushError, vaultTick } = useStore();
  const [pending, setPending] = useState<{ items: PendingItem[]; counts: Record<string, number> } | null>(null);
  const [conflicts, setConflicts] = useState<ConflictReport | null>(null);
  const [plan, setPlan] = useState<Plan | null>(null);
  const [mock, setMock] = useState<string | null>(null);
  const [docs, setDocs] = useState<{ markdown: string; sources: string[] } | null>(null);
  const [scan, setScan] = useState<{ findings: Finding[]; safe: boolean } | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [notePath, setNotePath] = useState("");
  const [topic, setTopic] = useState("");
  const [scanText, setScanText] = useState("");

  const loadPending = useCallback(() => {
    librarian
      .pending()
      .then(setPending)
      .catch((e) => pushError((e as Error).message));
  }, [pushError]);

  useEffect(loadPending, [loadPending, vaultTick]);

  useEffect(() => {
    if (!notePath && notes.length > 0) setNotePath(notes[0].path);
  }, [notes, notePath]);

  const run = async (key: string, fn: () => Promise<void>) => {
    setBusy(key);
    try {
      await fn();
    } catch (e) {
      pushError((e as Error).message);
    } finally {
      setBusy(null);
    }
  };

  const notePicker = (
    <select
      value={notePath}
      onChange={(e) => setNotePath(e.target.value)}
      className="w-full bg-bg2 border border-line text-[11px] text-ink h-7 px-2 outline-none focus:border-line-hi"
    >
      {notes.map((n) => (
        <option key={n.path} value={n.path}>
          {n.path}
        </option>
      ))}
    </select>
  );

  return (
    <div className="flex-1 min-h-0 overflow-y-auto">
      <div className="max-w-5xl px-6 py-5 space-y-4">
        <div>
          <h1 className="text-neon glow text-lg font-bold tracking-[.1em]">LIBRARIAN</h1>
          <p dir="auto" className="text-[12px] text-muted leading-6 mt-1">
            The local model maintains the memory: it finds stalled work and contradictions, generates plans, test data and documentation,
            and security-scans everything the agents exchange. All on-device.
          </p>
        </div>

        {/* deterministic — always fresh */}
        <Panel
          title="Stalled work"
          hint="Deterministic scanner (no model): unchecked items, stalled notes, open questions."
          action={{ label: "⟳ Scan", onClick: loadPending }}
        >
          {pending && (
            <>
              <div className="flex gap-2 flex-wrap">
                {Object.entries(pending.counts).map(([k, v]) => (
                  <span key={k} className="border border-amber/50 text-amber text-[10px] px-2 leading-5">
                    {KIND_LABEL[k as PendingItem["kind"]] ?? k}: {v}
                  </span>
                ))}
                {Object.keys(pending.counts).length === 0 && (
                  <span className="text-[11px] text-neon">✓ Nothing stalled</span>
                )}
              </div>
              <div className="max-h-56 overflow-y-auto space-y-1">
                {pending.items.map((i, idx) => (
                  <button
                    key={idx}
                    onClick={() => openNote(i.path)}
                    className="w-full text-right flex items-center gap-2 text-[11px] hover:bg-panel2/60 px-1 py-0.5"
                  >
                    <span className="text-faint shrink-0 w-3">·</span>
                    <span className="text-ink flex-1 truncate" dir="auto">
                      {i.detail}
                    </span>
                    <span className="text-faint text-[9px] shrink-0">{i.title.slice(0, 18)}</span>
                  </button>
                ))}
              </div>
            </>
          )}
        </Panel>

        <Panel
          title="Contradiction finder"
          hint="Compares semantically similar passages across notes; the model judges whether it is a real contradiction or a duplicate."
          busy={busy === "conflicts"}
          action={{
            label: "▸ Find contradictions",
            onClick: () => void run("conflicts", async () => setConflicts(await librarian.conflicts())),
          }}
        >
          {conflicts && (
            <div className="space-y-2">
              <div className="text-[10px] text-faint">
                {conflicts.checked} pairs checked · {conflicts.conflicts.length} found
              </div>
              {conflicts.conflicts.map((c, i) => (
                <div key={i} className="border border-red/40 bg-red/5 p-2 space-y-1">
                  <div className="flex items-center gap-2 text-[10px]">
                    <button onClick={() => openNote(c.a)} className="text-cyan hover:underline" dir="auto">
                      {c.a.split("/").pop()}
                    </button>
                    <span className="text-faint">⟷</span>
                    <button onClick={() => openNote(c.b)} className="text-cyan hover:underline" dir="auto">
                      {c.b.split("/").pop()}
                    </button>
                    <span className="text-faint">{(c.similarity * 100).toFixed(0)}% similar</span>
                  </div>
                  <div className="text-[11px] text-ink leading-5" dir="auto">
                    {c.reason}
                  </div>
                  {c.quote_a && (
                    <div className="text-[10px] text-amber leading-4" dir="auto">
                      A: {c.quote_a.slice(0, 120)}
                    </div>
                  )}
                  {c.quote_b && (
                    <div className="text-[10px] text-violet leading-4" dir="auto">
                      B: {c.quote_b.slice(0, 120)}
                    </div>
                  )}
                </div>
              ))}
              {conflicts.conflicts.length === 0 && (
                <div className="text-[11px] text-neon">✓ No contradictions</div>
              )}
            </div>
          )}
        </Panel>

        <div className="grid grid-cols-2 gap-4">
          <Panel
            title="Implementation-plan generator"
            hint="Turns a requirements note into phases and technical steps."
            busy={busy === "plan"}
            action={{
              label: "▸ Generate plan",
              onClick: () => void run("plan", async () => setPlan(await librarian.plan(notePath))),
            }}
          >
            {notePicker}
            {plan && (
              <div className="max-h-64 overflow-y-auto space-y-2 mt-1">
                {plan.phases.map((ph, i) => (
                  <div key={i}>
                    <div className="text-[11px] text-neon-dim" dir="auto">
                      ▸ {ph.title}
                    </div>
                    {ph.steps.map((s, j) => (
                      <div key={j} className="text-[10.5px] text-ink/80 leading-5 pl-3" dir="auto">
                        - {s}
                      </div>
                    ))}
                  </div>
                ))}
              </div>
            )}
          </Panel>

          <Panel
            title="Test-data generator"
            hint="Reads a feature description and generates test-ready JSON."
            busy={busy === "mock"}
            action={{
              label: "▸ Generate JSON",
              onClick: () =>
                void run("mock", async () => {
                  const r = await librarian.mockdata(notePath);
                  setMock(JSON.stringify(r.data, null, 2));
                }),
            }}
          >
            {notePicker}
            {mock && (
              <pre
                className="max-h-64 overflow-auto text-[10px] leading-4 text-cyan border border-line p-2 mt-1"
                dir="ltr"
              >
                {mock}
              </pre>
            )}
          </Panel>
        </div>

        <Panel
          title="Auto-documentation engine"
          hint="Gathers everything written about a topic semantically and turns it into technical documentation."
          busy={busy === "docs"}
          action={{
            label: "▸ Document",
            onClick: () => void run("docs", async () => setDocs(await librarian.docs(topic))),
          }}
        >
          <input
            dir="auto"
            value={topic}
            onChange={(e) => setTopic(e.target.value)}
            placeholder="Topic — e.g. sign-in and security"
            className="w-full bg-bg2 border border-line focus:border-line-hi outline-none text-[12px] text-ink h-8 px-2 placeholder:text-faint"
          />
          {docs && (
            <>
              <div className="text-[10px] text-faint">
                From {docs.sources.length} sources: {docs.sources.map((s) => s.split("/").pop()).join(" · ")}
              </div>
              <pre
                className="max-h-72 overflow-auto text-[11px] leading-5 text-ink border border-line p-2 whitespace-pre-wrap"
                dir="auto"
              >
                {docs.markdown}
              </pre>
            </>
          )}
        </Panel>

        <Panel
          title="Security guardrails"
          hint="Deterministic scan (regex, no model) for exposed secrets, risky code and prompt-injection attempts. Runs automatically on every pipeline submission."
          busy={busy === "scan"}
          action={{
            label: "▸ Scan text",
            onClick: () => void run("scan", async () => setScan(await librarian.scan({ text: scanText }))),
          }}
        >
          <textarea
            dir="ltr"
            rows={3}
            value={scanText}
            onChange={(e) => setScanText(e.target.value)}
            placeholder="Paste a diff or agent-to-agent text to scan…"
            className="w-full resize-none bg-bg2 border border-line focus:border-line-hi outline-none text-[11px] text-ink p-2 placeholder:text-faint"
          />
          {scan && (
            <div className="space-y-1">
              <div className={"text-[11px] " + (scan.safe ? "text-neon" : "text-red")}>
                {scan.safe ? "✓ Clean" : `⚠ ${scan.findings.length} finding(s)`}
              </div>
              {scan.findings.map((f, i) => (
                <div key={i} className="border border-red/30 bg-red/5 px-2 py-1">
                  <div className="text-[10px] text-red">
                    [{f.severity}] {f.kind} — line {f.line}
                  </div>
                  <div className="text-[10px] text-ink/70 truncate" dir="ltr">
                    {f.excerpt}
                  </div>
                  <div className="text-[10px] text-amber" dir="auto">
                    {f.advice}
                  </div>
                </div>
              ))}
            </div>
          )}
        </Panel>
      </div>
    </div>
  );
}
