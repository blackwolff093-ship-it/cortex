/* Multi-agent orchestrator: configure which agent holds each pipeline role,
   watch tasks flow across stages, and inspect diffs / audit history.
   Live-updates from the SSE 'orchestrator' change type via orchTick. */

import { useCallback, useEffect, useMemo, useState, useRef } from "react";
import {
  ORCH_AGENTS,
  ORCH_MODELS,
  agentBadgeClass,
  orchApi,
  type OrchBrief,
  isProjectPath,
  projectTitle,
  type OrchStatus,
  type OrchTask,
  type PipelineRole,
  type RoleKey,
} from "../lib/api";
import { ConfirmModal, Modal } from "../components/Modal";
import { useStore } from "../lib/store";

/* Board columns. A task's column is derived from (current_role, status) rather
   than status alone, because the planner owns two different stages. */
const STAGES: { key: string; label: string; accent: string; chip: string; match: (t: OrchTask) => boolean }[] = [
  {
    key: "queued",
    label: "QUEUED → CODER",
    accent: "text-muted border-muted/40",
    chip: "bg-muted/15 text-muted",
    match: (t) => t.current_role === "coder" && t.status === "QUEUED",
  },
  {
    key: "coding",
    label: "IN PROGRESS",
    accent: "text-cyan border-cyan/40",
    chip: "bg-cyan/15 text-cyan",
    match: (t) => t.current_role === "coder" && t.status === "IN_PROGRESS",
  },
  {
    key: "security",
    label: "SECURITY",
    accent: "text-red border-red/40",
    chip: "bg-red/15 text-red",
    match: (t) => t.current_role === "security",
  },
  {
    key: "qa",
    label: "QA",
    accent: "text-violet border-violet/40",
    chip: "bg-violet/15 text-violet",
    match: (t) => t.current_role === "qa",
  },
  {
    key: "review",
    label: "FINAL REVIEW",
    accent: "text-amber border-amber/40",
    chip: "bg-amber/15 text-amber",
    match: (t) => t.current_role === "planner" && t.status === "FINAL_REVIEW",
  },
  {
    key: "done",
    label: "DONE / FAILED",
    accent: "text-neon border-neon/40",
    chip: "bg-neon/15 text-neon",
    match: (t) => t.status === "COMPLETED" || t.status === "FAILED",
  },
];

const ROLE_CLAIMABLE: Record<string, string[]> = {
  planner: ['PLANNING', 'FINAL_REVIEW'],
  coder: ['QUEUED', 'IN_PROGRESS'],
  security: ['SECURITY_REVIEW'],
  qa: ['QA_REVIEW'],
};

function fmt(ms: number): string {
  if (!ms) return "—";
  const d = new Date(ms);
  const p = (n: number) => String(n).padStart(2, "0");
  return `${p(d.getHours())}:${p(d.getMinutes())} ${p(d.getDate())}/${p(d.getMonth() + 1)}`;
}

function statusClass(s: OrchStatus): string {
  if (s === "COMPLETED") return "text-neon";
  if (s === "FAILED") return "text-red";
  if (s === "IN_PROGRESS") return "text-cyan";
  return "text-amber";
}

/* ------------------------------------------------------------ role config */

/* Agents that have a launcher registered in dispatchTask (electron/agentapi.ts).
 * This used to be antigravity-only, which left claude tasks with no dispatch/stop buttons. */
const DISPATCHABLE_AGENTS = ['antigravity', 'claude', 'opencode'];

export function RoleCard({
  role,
  onSave,
}: {
  role: PipelineRole;
  onSave: (patch: { is_enabled?: boolean; assigned_agent?: string; model?: string; auto_advance?: boolean; auto_dispatch?: boolean }) => void;
}) {
  /* Model list of the agent currently holding the role. Undefined = no launcher. */
  const models = ORCH_MODELS[role.assigned_agent];
  const defaultLabel = models?.find((m) => m.value === "")?.label ?? "";
  const listId = "orch-models-" + role.role_key;
  const [modelDraft, setModelDraft] = useState(role.model);

  /* Re-sync after a save or after the agent switch wiped the model server-side. */
  useEffect(() => setModelDraft(role.model), [role.model]);

  /* Each save is a network PATCH, so commit on blur / Enter — not per keystroke. */
  const commitModel = () => {
    const next = modelDraft.trim();
    setModelDraft(next);
    if (next !== role.model) onSave({ model: next });
  };

  return (
    <div
      className={
        "border p-3 space-y-2 " +
        (role.is_enabled ? "border-line bg-panel/60" : "border-line/50 bg-bg2/30 opacity-60")
      }
    >
      <div className="flex items-center gap-2">
        <span className="text-[11px] text-ink font-bold tracking-[.1em] flex-1 truncate">
          {role.display_name}
        </span>
        {role.is_required ? (
          <span className="text-[9px] text-faint border border-line px-1 leading-4">REQUIRED</span>
        ) : (
          <button
            onClick={() => onSave({ is_enabled: !role.is_enabled })}
            className={
              "text-[9px] tracking-[.1em] px-2 leading-5 border " +
              (role.is_enabled
                ? "border-neon-dim text-neon bg-neon/10"
                : "border-line text-muted hover:text-ink")
            }
          >
            {role.is_enabled ? "◉ ON" : "○ OFF"}
          </button>
        )}
      </div>
      <div className="text-[9px] text-faint tracking-[.15em]">{role.role_key}</div>

      <div className="flex items-center gap-2">
        <span className="text-[9px] text-faint w-10 shrink-0">AGENT</span>
        <select
          value={role.assigned_agent}
          onChange={(e) => onSave({ assigned_agent: e.target.value })}
          className="flex-1 bg-bg2 border border-line text-[11px] text-ink h-7 px-1 outline-none focus:border-line-hi"
        >
          {(ORCH_AGENTS as readonly string[]).includes(role.assigned_agent) ? null : (
            <option value={role.assigned_agent}>{role.assigned_agent}</option>
          )}
          {ORCH_AGENTS.map((a) => (
            <option key={a} value={a}>
              {a === "local_model" ? "Local GGUF (on-device)" : a}
            </option>
          ))}
        </select>
      </div>

      <div className="flex items-center gap-2">
        <span className="text-[9px] text-faint w-10 shrink-0">MODEL</span>
        {models ? (
          <>
            <input
              dir="ltr"
              list={listId}
              value={modelDraft}
              onChange={(e) => setModelDraft(e.target.value)}
              onBlur={commitModel}
              onKeyDown={(e) => {
                if (e.key === "Enter") e.currentTarget.blur();
              }}
              placeholder={defaultLabel}
              title="Leave empty for the default, or type any model name this agent accepts"
              className="flex-1 bg-bg2 border border-line text-[11px] text-ink h-7 px-1 outline-none focus:border-line-hi placeholder:text-faint"
            />
            <datalist id={listId}>
              {models
                .filter((m) => m.value !== "")
                .map((m) => (
                  <option key={m.value} value={m.value}>
                    {m.label}
                  </option>
                ))}
            </datalist>
          </>
        ) : (
          <input
            dir="auto"
            disabled
            placeholder="No launcher registered for this agent"
            className="flex-1 bg-bg2/30 border border-line/50 text-[11px] text-faint h-7 px-1 outline-none placeholder:text-faint"
          />
        )}
      </div>

      <div className="flex items-center gap-2">
        <span className="text-[9px] text-faint w-10 shrink-0">HAND-OFF</span>
        <button
          onClick={() => onSave({ auto_advance: !role.auto_advance })}
          className={
            "flex-1 text-[10px] tracking-[.1em] h-7 border " +
            (role.auto_advance
              ? "border-neon-dim/60 text-neon hover:bg-neon/10"
              : "border-amber/60 text-amber hover:bg-amber/10")
          }
          title={
            role.auto_advance
              ? "Hands off to the next role automatically"
              : "Stops and waits for your click before handing off"
          }
        >
          {role.auto_advance ? "AUTO ▸" : "✋ MANUAL GATE"}
        </button>
      </div>
      
      <div className="flex items-center gap-2">
        <span className="text-[9px] text-faint w-10 shrink-0">WAKEUP</span>
        <button
          onClick={() => onSave({ auto_dispatch: !role.auto_dispatch })}
          className={
            "flex-1 text-[10px] tracking-[.1em] h-7 border " +
            (role.auto_dispatch
              ? "border-neon-dim/60 text-neon hover:bg-neon/10"
              : "border-amber/60 text-amber hover:bg-amber/10")
          }
          title={
            role.auto_dispatch
              ? "Wakes the agent automatically"
              : "Does not wake the agent (manual wake required)"
          }
        >
          {role.auto_dispatch ? "AUTO-LAUNCH 🚀" : "✋ MANUAL WAKEUP"}
        </button>
      </div>
    </div>
  );
}

/* --------------------------------------------------------- task detail */

export function TaskDetail({
  id,
  onClose,
  onChanged,
}: {
  id: number;
  onClose: () => void;
  onChanged: () => void;
}) {
  const { pushError, notes } = useStore();
  const [brief, setBrief] = useState<OrchBrief | null>(null);
  
  const projectNotes = useMemo(() => notes.filter(n => isProjectPath(n.path)), [notes]);
  const [feedback, setFeedback] = useState("");
  const [busy, setBusy] = useState(false);
  const [dispatchMsg, setDispatchMsg] = useState("");
  const [showDeleteConfirm, setShowDeleteConfirm] = useState(false);
  const [rejectError, setRejectError] = useState(false);
  const feedbackRef = useRef<HTMLTextAreaElement>(null);

  const load = useCallback(() => {
    orchApi
      .brief(id)
      .then(setBrief)
      .catch((e) => pushError((e as Error).message));
  }, [id, pushError]);

  useEffect(load, [load]);

  const act = async (fn: () => Promise<unknown>) => {
    setBusy(true);
    try {
      await fn();
      load();
      onChanged();
    } catch (e) {
      pushError((e as Error).message);
    } finally {
      setBusy(false);
    }
  };

  const t = brief?.task;
  const isReviewStage =
    !!t && t.current_role !== "coder" && t.status !== "COMPLETED" && t.status !== "FAILED";

  return (
    <Modal title={t ? `TASK #${t.seq !== null ? t.seq : '—'} (ID: ${t.id})` : "TASK"} onClose={onClose}>
      <div className="w-[720px] max-w-full space-y-3">
        {!t && <div className="text-faint text-xs tracking-[.2em]">LOADING ░ ░ ░</div>}
        {t && (
          <>
            <div>
              <div className="flex justify-between items-start">
                <div className="flex-1">
                  <div className="text-neon text-sm font-bold leading-6" dir="auto">
                    {t.title}
                  </div>
                  <select
                    value={t.project ?? "__none__"}
                    onChange={(e) => {
                      const val = e.target.value === "__none__" ? null : e.target.value;
                      act(async () => orchApi.updateTask(id, { project: val }));

                    }}
                    className="mt-2 bg-bg2 border border-line focus:border-line-hi outline-none text-cyan text-xs h-7 px-2 uppercase max-w-[280px]"
                  >
                    <option value="__none__">— NO PROJECT —</option>
                    {projectNotes.map(n => (
                      <option key={n.path} value={n.path}>{projectTitle(n.path)}</option>
                    ))}
                  </select>
                </div>
                <button
                  className="w-6 h-6 leading-none text-faint hover:text-red border border-transparent hover:border-red/30 flex items-center justify-center shrink-0"
                  onClick={() => {
                    setShowDeleteConfirm(true);
                  }}
                  title="Delete task"
                >
                  ×
                </button>
              </div>
              <div className="mt-1 flex items-center gap-2 flex-wrap text-[10px]">
                <span className={statusClass(t.status) + " tracking-[.1em]"}>{t.status}</span>
                <span className="text-faint">@</span>
                <span className={"border px-1.5 leading-4 " + agentBadgeClass(t.assigned_agent)}>
                  {t.current_role} · {t.assigned_agent}
                </span>
                {t.execution_mode === "manual" && (
                  <span className="border border-amber/50 text-amber px-1.5 leading-4">✋ MANUAL</span>
                )}
                {t.reject_count > 0 && (
                  <span className="border border-red/50 text-red px-1.5 leading-4">
                    ↺ {t.reject_count} rejections
                  </span>
                )}
                <span className="text-faint">MOD {fmt(t.updated_at)}</span>
              </div>
            </div>

            <div className="border border-line bg-bg2/40 p-2">
              <div className="text-[9px] tracking-[.2em] text-faint mb-1">DESCRIPTION</div>
              <div className="text-[12px] text-ink leading-6 whitespace-pre-wrap" dir="auto">
                {t.description}
              </div>
            </div>

            {t.context_files.length > 0 && (
              <div className="flex flex-wrap gap-1.5">
                {t.context_files.map((f) => (
                  <span
                    key={f}
                    className="border border-line text-[10px] text-cyan px-1.5 leading-5"
                    dir="ltr"
                  >
                    {f}
                  </span>
                ))}
              </div>
            )}

            {t.gate_pending && (
              <div className="border border-amber/50 bg-amber/5 p-2 flex items-center gap-2">
                <span className="text-[11px] text-amber flex-1" dir="auto">
                  ✋ Held at a manual gate — next: {t.pending_role}
                </span>
                <button
                  disabled={busy}
                  onClick={() => void act(() => orchApi.releaseGate(t.id))}
                  className="border border-neon-dim text-neon px-3 h-7 text-[11px] hover:bg-neon/10 disabled:opacity-40"
                >
                  ▸ Open the gate
                </button>
              </div>
            )}

            {t.claimed_by && t.status !== "COMPLETED" && (
              <div className="border border-line bg-bg2/40 p-2 flex items-center gap-2">
                <span className="text-[11px] text-muted flex-1" dir="auto">
                  Claimed by @{t.claimed_by} — if it stalled, requeue it
                </span>
                <button
                  disabled={busy}
                  onClick={() => void act(() => orchApi.requeue(t.id, "Requeued manually"))}
                  className="border border-line text-muted px-3 h-7 text-[11px] hover:text-cyan hover:border-cyan/50 disabled:opacity-40"
                >
                  ↺ Requeue
                </button>
              </div>
            )}

            {t.status === "FAILED" && (
              <div className="border border-red/50 bg-red/5 p-2 flex items-center gap-2">
                <span className="text-[11px] text-red flex-1" dir="auto">
                  Failed after {t.reject_count} rejections — needs you
                </span>
                <button
                  disabled={busy}
                  onClick={() => void act(() => orchApi.retry(t.id))}
                  className="border border-cyan/60 text-cyan px-3 h-7 text-[11px] hover:bg-cyan/10 disabled:opacity-40"
                >
                  ↺ Back to implementer
                </button>
              </div>
            )}

            {ROLE_CLAIMABLE[t.current_role]?.includes(t.status) && DISPATCHABLE_AGENTS.includes(t.assigned_agent) && (
              <div className="border border-neon/30 bg-neon/5 p-2 flex flex-col gap-2">
                <div className="flex items-center gap-2">
                  <span className="text-[11px] text-neon flex-1" dir="auto">
                    {dispatchMsg || (t.dispatch_status === 'active' ? `Running (session: ${t.dispatch_conv_id})` : t.dispatch_status === 'launching' ? 'Launching…' : t.dispatch_status === 'failed' ? 'Launch failed' : 'Ready')}
                  </span>
                  {t.dispatch_status === 'active' || t.dispatch_status === 'launching' ? (
                    <button
                      disabled={busy}
                      onClick={() => {
                        if (confirm("Stopping the task makes it claimable again, but the external agent may keep working in the background. Are you sure?")) {
                          void act(() => orchApi.stop(t.id));
                        }
                      }}
                      className="border border-red/60 text-red px-3 h-7 text-[11px] hover:bg-red/10 disabled:opacity-40"
                    >
                      STOP ✕
                    </button>
                  ) : (
                    <button
                      disabled={busy || !!(brief.active_dispatch_task && brief.active_dispatch_task.task_id !== t.id)}
                      title={brief.active_dispatch_task && brief.active_dispatch_task.task_id !== t.id ? `The dispatch slot is busy with task #${brief.active_dispatch_task.task_id}: ${brief.active_dispatch_task.title || ''}` : undefined}
                      onClick={async () => {
                        setBusy(true);
                        setDispatchMsg('Launching…');
                        try {
                          const res = await orchApi.dispatch(t.id);
                          if (res.conversation_id) {
                            setDispatchMsg(`Running (session: ${res.conversation_id})`);
                          } else {
                            setDispatchMsg(`Launch failed: ${res.error}`);
                          }
                          load();
                          onChanged();
                        } catch (e) {
                          setDispatchMsg((e as Error).message);
                        } finally {
                          setBusy(false);
                        }
                      }}
                      className="border border-neon-dim text-neon px-3 h-7 text-[11px] hover:bg-neon/10 disabled:opacity-40"
                    >
                      DISPATCH ▸
                    </button>
                  )}
                </div>
                {(t.dispatch_status === 'active' || t.dispatch_status === 'launching') && (
                  <div className="text-[10px] text-faint">
                    Note: The external agent session might continue in the background if it is already running.
                  </div>
                )}
              </div>
            )}

            {t.auto_blocked && (
              <div className="border border-amber/50 bg-amber/5 p-2 flex items-center gap-2">
                <span className="text-[11px] text-amber flex-1" dir="auto">
                  ✋ Auto-wake is blocked because it was stopped manually.
                </span>
                <button
                  disabled={busy}
                  onClick={() => void act(() => orchApi.resumeAuto(t.id))}
                  className="border border-amber/60 text-amber px-3 h-7 text-[11px] hover:bg-amber/10 disabled:opacity-40"
                >
                  ↻ RESUME AUTO
                </button>
              </div>
            )}

            {t.feedback && (
              <div className="border border-amber/40 bg-amber/5 p-2">
                <div className="text-[9px] tracking-[.2em] text-amber mb-1">LAST FEEDBACK</div>
                <div className="text-[12px] text-ink leading-6 whitespace-pre-wrap" dir="auto">
                  {t.feedback}
                </div>
              </div>
            )}

            {/* Diff viewer: no diff library is bundled, so colour unified-diff
                lines directly — enough to review a patch, zero dependencies. */}
            {t.diff_payload && (
              <div className="border border-line">
                <div className="text-[9px] tracking-[.2em] text-faint px-2 h-6 flex items-center border-b border-line">
                  SUBMITTED WORK
                </div>
                <pre
                  className="p-2 overflow-x-auto text-[11px] leading-5 max-h-64 overflow-y-auto"
                  dir="ltr"
                >
                  {t.diff_payload.split("\n").map((line, i) => (
                    <div
                      key={i}
                      className={
                        line.startsWith("+") && !line.startsWith("+++")
                          ? "text-neon"
                          : line.startsWith("-") && !line.startsWith("---")
                            ? "text-red"
                            : line.startsWith("@@")
                              ? "text-cyan"
                              : "text-muted"
                      }
                    >
                      {line || " "}
                    </div>
                  ))}
                </pre>
              </div>
            )}

            {/* The user can stand in for a reviewer role from the UI. */}
            {isReviewStage && (
              <div className="border border-line bg-panel/40 p-2 space-y-2">
                <div className="text-[9px] tracking-[.2em] text-faint">
                  REVIEW AS {t.current_role.toUpperCase()}
                </div>
                <textarea
                  ref={feedbackRef}
                  dir="auto"
                  rows={2}
                  value={feedback}
                  onChange={(e) => {
                    setFeedback(e.target.value);
                    if (rejectError) setRejectError(false);
                  }}
                  placeholder="Notes (required when rejecting)"
                  className={
                    "w-full resize-none bg-bg2 border outline-none text-[12px] text-ink p-2 " +
                    (rejectError ? "border-red focus:border-red" : "border-line focus:border-line-hi")
                  }
                />
                {rejectError && (
                  <div className="text-[10px] text-red mt-1">Rejecting requires a note — say exactly why</div>
                )}
                <div className="text-[10px] text-faint mt-1">Approving needs no note · rejecting does</div>
                <div className="flex gap-2 justify-end">
                  <button
                    disabled={busy}
                    onClick={() => {
                      if (!feedback.trim()) {
                        setRejectError(true);
                        feedbackRef.current?.focus();
                        return;
                      }
                      void act(() => orchApi.review(t.id, "REJECTED", feedback)).then(() =>
                        setFeedback("")
                      );
                    }}
                    className="border border-red/60 text-red px-3 h-7 text-[11px] hover:bg-red/10 disabled:opacity-40"
                  >
                    ✕ REJECT
                  </button>
                  <button
                    disabled={busy}
                    onClick={() =>
                      void act(() => orchApi.review(t.id, "APPROVED", feedback)).then(() =>
                        setFeedback("")
                      )
                    }
                    className="border border-neon-dim text-neon px-3 h-7 text-[11px] hover:bg-neon/10 disabled:opacity-40"
                  >
                    ✓ APPROVE
                  </button>
                </div>
              </div>
            )}

            <div className="border-t border-line pt-2">
              <div className="text-[9px] tracking-[.2em] text-faint mb-1">AUDIT TRAIL</div>
              <div className="space-y-1">
                {brief!.audit.map((a) => (
                  <div key={a.id} className="flex items-start gap-2 text-[10px]">
                    <span className="text-faint tabular-nums shrink-0">{fmt(a.timestamp)}</span>
                    <span
                      className={
                        "shrink-0 w-16 " +
                        (a.action === "REJECTED"
                          ? "text-red"
                          : a.action === "APPROVED"
                            ? "text-neon"
                            : "text-cyan")
                      }
                    >
                      {a.action}
                    </span>
                    <span className="text-muted shrink-0">{a.role_key}</span>
                    <span className={agentBadgeClass(a.agent_name).split(" ")[0]}>{a.agent_name}</span>
                    {a.comment && (
                      <span className="text-ink/70 truncate" dir="auto">
                        {a.comment}
                      </span>
                    )}
                  </div>
                ))}
              </div>
            </div>
          </>
        )}
      </div>
      {showDeleteConfirm && (
        <ConfirmModal
          title="DELETE TASK"
          message={
            t?.dispatch_status === 'active' || t?.dispatch_status === 'launching'
              ? "Delete this task permanently? Warning: it has a running dispatch that will be cancelled immediately. This cannot be undone."
              : "Delete this task permanently? This cannot be undone."
          }
          onConfirm={() => {
            setShowDeleteConfirm(false);
            act(() => orchApi.remove(t!.id)).then(() => onClose());
          }}
          onCancel={() => setShowDeleteConfirm(false)}
        />
      )}
    </Modal>
  );
}

/* -------------------------------------------------------------- new task */

export function NewTaskModal({ onClose, onCreated }: { onClose: () => void; onCreated: () => void }) {
  const { pushError, activeProject, notes } = useStore();
  const [title, setTitle] = useState("");
  const [description, setDescription] = useState("");
  const [files, setFiles] = useState("");
  const [manual, setManual] = useState(false);
  const [busy, setBusy] = useState(false);
  
  const projectNotes = useMemo(() => notes.filter(n => isProjectPath(n.path)), [notes]);
  const defaultProj = (activeProject !== "__all__" && activeProject !== "__none__" && projectNotes.some(n => n.path === activeProject)) ? activeProject : null;
  const [project, setProject] = useState<string | null>(defaultProj);

  const submit = async () => {
    if (!title.trim() || !description.trim()) return;
    setBusy(true);
    try {
      await orchApi.create({
        title: title.trim(),
        description: description.trim(),
        context_files: files
          .split(/[\n,]/)
          .map((f) => f.trim())
          .filter(Boolean),
        execution_mode: manual ? "manual" : "auto",
        project: project === "__none__" ? undefined : (project || undefined),
      });
      onCreated();
      onClose();
    } catch (e) {
      pushError((e as Error).message);
      setBusy(false);
    }
  };

  return (
    <Modal title="NEW PIPELINE TASK" onClose={onClose}>
      <div className="w-[560px] max-w-full space-y-3">
        <input
          autoFocus
          dir="auto"
          value={title}
          onChange={(e) => setTitle(e.target.value)}
          placeholder="Task title"
          className="w-full bg-bg2 border border-line focus:border-line-hi outline-none text-ink text-sm h-9 px-2"
        />
        <textarea
          dir="auto"
          rows={4}
          value={description}
          onChange={(e) => setDescription(e.target.value)}
          placeholder="Description and acceptance criteria — this is all the implementer sees"
          className="w-full resize-none bg-bg2 border border-line focus:border-line-hi outline-none text-ink text-[13px] p-2"
        />
        <input
          dir="ltr"
          value={files}
          onChange={(e) => setFiles(e.target.value)}
          placeholder="Context files (one per line or comma-separated): electron/server.ts"
          className="w-full bg-bg2 border border-line focus:border-line-hi outline-none text-ink text-xs h-8 px-2 placeholder:text-faint"
        />
        <select
          value={project ?? "__none__"}
          onChange={(e) => setProject(e.target.value === "__none__" ? null : e.target.value)}
          className="w-full bg-bg2 border border-line focus:border-line-hi outline-none text-cyan text-xs h-8 px-2 uppercase"
        >
          <option value="__none__">— NO PROJECT —</option>
          {projectNotes.map(n => (
            <option key={n.path} value={n.path}>{projectTitle(n.path)}</option>
          ))}
        </select>
        <button
          onClick={() => setManual((m) => !m)}
          className={
            "w-full h-8 text-[11px] tracking-[.1em] border " +
            (manual
              ? "border-amber/60 text-amber bg-amber/5"
              : "border-neon-dim/60 text-neon hover:bg-neon/5")
          }
        >
          {manual ? "✋ Manual gate at every step" : "▸ Automatic between roles"}
        </button>
        <div className="flex justify-end gap-2">
          <button
            onClick={onClose}
            className="border border-line px-4 h-8 text-xs text-muted hover:text-ink hover:border-line-hi"
          >
            CANCEL
          </button>
          <button
            disabled={busy || !title.trim() || !description.trim()}
            title={(!title.trim() || !description.trim()) ? "Please fill in the title and description" : undefined}
            onClick={() => void submit()}
            className="border border-neon-dim text-neon px-4 h-8 text-xs hover:bg-neon/10 disabled:opacity-40"
          >
            {busy ? "…" : "CREATE ▸"}
          </button>
        </div>
      </div>
    </Modal>
  );
}

/* ------------------------------------------------------------- main view */

export function PipelineModal({ onClose }: { onClose: () => void }) {
  const { orchTick, pushError } = useStore();
  const [roles, setRoles] = useState<PipelineRole[]>([]);
  const [creating, setCreating] = useState(false);

  const refresh = useCallback(() => {
    orchApi.config().then(setRoles).catch((e) => pushError((e as Error).message));
  }, [pushError]);

  useEffect(refresh, [refresh, orchTick]);

  const saveRole = async (
    key: RoleKey,
    patch: { is_enabled?: boolean; assigned_agent?: string; model?: string; auto_advance?: boolean; auto_dispatch?: boolean }
  ) => {
    try {
      await orchApi.saveRole(key, patch);
      refresh();
    } catch (e) {
      pushError((e as Error).message);
    }
  };

  return (
    <Modal title="PIPELINE CONFIG" onClose={onClose}>
      <div className="w-[600px] max-w-full space-y-4">
        <div className="flex justify-between items-center">
          <h2 className="text-neon glow text-sm tracking-[.1em]">ROLES</h2>
          <button
            onClick={() => setCreating(true)}
            className="border border-neon-dim text-neon px-3 h-7 text-[10px] tracking-[.15em] hover:bg-neon/10 glow"
          >
            ＋ NEW TASK
          </button>
        </div>
        <div className="grid grid-cols-2 gap-2">
          {roles.map((r) => (
            <RoleCard key={r.role_key} role={r} onSave={(p) => void saveRole(r.role_key, p)} />
          ))}
        </div>
        <p dir="auto" className="text-[10px] text-faint leading-5 mt-2">
          A task flows: planner creates → coder writes → security (if enabled) → QA (if enabled) → planner
          reviews last. Any role set to "manual gate" holds the task until you release it.
        </p>
      </div>
      {creating && <NewTaskModal onClose={() => setCreating(false)} onCreated={refresh} />}
    </Modal>
  );
}
