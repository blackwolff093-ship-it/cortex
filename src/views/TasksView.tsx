/* Kanban board: 4 columns, HTML5 drag & drop, optimistic PATCH + revert.
   Tasks are tagged with a project (a Projects/*.md path) and the board can be
   filtered to one project — defaulting to whichever project note was opened
   most recently (tracked in settings.active_project by lib/store.tsx). */

import { useCallback, useEffect, useMemo, useState } from "react";
import {
  agentBadgeClass,
  api,
  orchApi,
  isProjectPath,
  projectTitle,
  type Task,
  type TaskColumns,
  type TaskStatus,
  ORCH_AGENTS,
} from "../lib/api";
import { ConfirmModal } from "../components/Modal";
import { useStore } from "../lib/store";
import { PipelineModal, TaskDetail } from "./OrchestratorView";
import { ORCH_MODELS } from "../lib/api";

const ROLE_HOLD_STATUS: Record<string, string> = {
  planner: 'FINAL_REVIEW',
  coder: 'IN_PROGRESS',
  security: 'SECURITY_REVIEW',
  qa: 'QA_REVIEW',
};

/** Special selector values alongside real project paths. */
const ALL = "__all__";
const NONE = "__none__";

const COLUMNS: { status: TaskStatus; accent: string; chip: string }[] = [
  { status: "TODO", accent: "text-muted border-muted/40", chip: "bg-muted/15 text-muted" },
  { status: "IN PROGRESS", accent: "text-cyan border-cyan/40", chip: "bg-cyan/15 text-cyan" },
  { status: "REVIEW", accent: "text-amber border-amber/40", chip: "bg-amber/15 text-amber" },
  { status: "DONE", accent: "text-neon border-neon/40", chip: "bg-neon/15 text-neon" },
];

const ASSIGNEES = ["—", ...ORCH_AGENTS, "user"];

const emptyColumns = (): TaskColumns => ({
  TODO: [],
  "IN PROGRESS": [],
  REVIEW: [],
  DONE: [],
});

function AddForm({
  status,
  project,
  onDone,
}: {
  status: TaskStatus;
  project: string | null;
  onDone: () => void;
}) {
  const { pushError } = useStore();
  const [text, setText] = useState("");
  const [description, setDescription] = useState("");
  const [assignee, setAssignee] = useState("—");
  const [taskType, setTaskType] = useState<"pipeline" | "kanban">("pipeline");

  const submit = async () => {
    const t = text.trim();
    if (!t) return;
    try {
      if (taskType === "pipeline") {
        const desc = description.trim();
        const created = await orchApi.create({
          title: t,
          description: desc ? desc : t,
          needs_planning: !desc,
          ...(project ? { project } : {}),
        });
        if (status !== "TODO") {
          await orchApi.move(created.id, status);
        }
      } else {
        await api.addTask({
          text: t,
          status,
          ...(assignee !== "—" ? { assignee } : {}),
          ...(project ? { project } : {}),
        });
      }
      onDone();
    } catch (e) {
      pushError((e as Error).message);
    }
  };

  return (
    <div className="border border-line-hi bg-panel2 p-2 space-y-2">
      <input
        autoFocus
        dir="auto"
        spellCheck={false}
        value={text}
        onChange={(e) => setText(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === "Enter" && taskType === "kanban") void submit();
          if (e.key === "Escape") onDone();
        }}
        placeholder="task…"
        className="w-full bg-bg2 border border-line focus:border-line-hi outline-none text-xs text-ink h-8 px-2 placeholder:text-faint"
      />
      {taskType === "pipeline" && (
        <textarea
          dir="auto"
          spellCheck={false}
          value={description}
          onChange={(e) => setDescription(e.target.value)}
          placeholder="Task description (optional)…"
          className="w-full bg-bg2 border border-line focus:border-line-hi outline-none text-xs text-ink h-16 px-2 py-1 placeholder:text-faint resize-none"
        />
      )}
      <div className="text-[10px] text-faint mb-2" dir="auto">
        {taskType === "pipeline"
          ? "A pipeline task's implementer comes from its pipeline role, not from an assignee field."
          : "The assignee field applies to manual kanban cards only (it wakes nobody)."}
      </div>
      <div className="flex gap-2 items-center">
        <select
          value={taskType}
          onChange={(e) => setTaskType(e.target.value as "pipeline" | "kanban")}
          className="bg-bg2 border border-line text-xs text-ink h-7 px-1 outline-none focus:border-line-hi"
        >
          <option value="pipeline">Pipeline task</option>
          <option value="kanban">Manual card</option>
        </select>
        {taskType === "kanban" && (
          <select
            value={assignee}
            onChange={(e) => setAssignee(e.target.value)}
            className="flex-1 bg-bg2 border border-line text-xs text-ink h-7 px-1 outline-none focus:border-line-hi"
          >
            {ASSIGNEES.map((a) => (
              <option key={a} value={a}>
                {a === "—" ? "— unassigned" : "@" + a}
              </option>
            ))}
          </select>
        )}
        <span className="flex-1"></span>
        <button
          className="border border-neon-dim text-neon px-3 h-7 text-[11px] hover:bg-neon/10 disabled:opacity-40"
          disabled={!text.trim()}
          title={!text.trim() ? "Please enter some text" : undefined}
          onClick={() => void submit()}
        >
          ADD
        </button>
        <button
          className="border border-line text-muted px-2 h-7 text-[11px] hover:text-ink"
          onClick={onDone}
        >
          ✕
        </button>
      </div>
    </div>
  );
}

function EditForm({ task, onDone }: { task: Task; onDone: () => void }) {
  const { pushError } = useStore();
  const [text, setText] = useState(task.text);
  const [assignee, setAssignee] = useState(task.assignee ?? "—");

  const submit = async () => {
    const t = text.trim();
    if (!t) return;
    try {
      await api.updateTask(task.id, { text: t, assignee: assignee === "—" ? null : assignee });
      onDone();
    } catch (e) {
      pushError((e as Error).message);
    }
  };

  return (
    <div className="border border-line-hi bg-panel2 p-2 space-y-2">
      <input
        autoFocus
        dir="auto"
        spellCheck={false}
        value={text}
        onChange={(e) => setText(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === "Enter") void submit();
          if (e.key === "Escape") onDone();
        }}
        className="w-full bg-bg2 border border-line focus:border-line-hi outline-none text-xs text-ink h-8 px-2"
      />
      <div className="flex gap-2">
        <select
          value={assignee}
          onChange={(e) => setAssignee(e.target.value)}
          className="flex-1 bg-bg2 border border-line text-xs text-ink h-7 px-1 outline-none focus:border-line-hi"
        >
          {ASSIGNEES.map((a) => (
            <option key={a} value={a}>
              {a === "—" ? "— unassigned" : "@" + a}
            </option>
          ))}
        </select>
        <button
          className="border border-neon-dim text-neon px-3 h-7 text-[11px] hover:bg-neon/10 disabled:opacity-40"
          disabled={!text.trim()}
          title={!text.trim() ? "Please enter some text" : undefined}
          onClick={() => void submit()}
        >
          SAVE
        </button>
        <button
          className="border border-line text-muted px-2 h-7 text-[11px] hover:text-ink"
          onClick={onDone}
        >
          ✕
        </button>
      </div>
    </div>
  );
}

export default function TasksView() {
  const { tasksTick, orchTick, notes, pushError, activeProject: selectedProject, setActiveProject: pickProject } = useStore();
  const [columns, setColumns] = useState<TaskColumns>(emptyColumns);
  const [loaded, setLoaded] = useState(false);
  const [dragId, setDragId] = useState<string | null>(null);
  const [dragOver, setDragOver] = useState<TaskStatus | null>(null);
  const [adding, setAdding] = useState<TaskStatus | null>(null);
  const [editingId, setEditingId] = useState<string | null>(null);
  const [confirmDelete, setConfirmDelete] = useState<Task | null>(null);
  
  const [openOrchId, setOpenOrchId] = useState<number | null>(null);
  const [showPipelineModal, setShowPipelineModal] = useState(false);

  const projectNotes = useMemo(
    () => notes.filter((n) => isProjectPath(n.path)).sort((a, b) => a.path.localeCompare(b.path)),
    [notes]
  );

  const refresh = useCallback(async () => {
    try {
      const { columns: cols } = await api.tasksUnified();
      setColumns({ ...emptyColumns(), ...cols });
      setLoaded(true);
    } catch (e) {
      pushError((e as Error).message);
    }
  }, [pushError]);

  useEffect(() => {
    void refresh();
  }, [refresh, tasksTick, orchTick]);


  /* Picker modal: opens when a pipeline card is moved to IN PROGRESS or REVIEW. */
  const [picker, setPicker] = useState<{ orchId: number; to: TaskStatus; title: string } | null>(null);
  const [pickAgent, setPickAgent] = useState("claude");
  const [pickModel, setPickModel] = useState("");
  const [pickBusy, setPickBusy] = useState(false);

  /* Composer: the local model turns rough prose into a task spec. */
  const [rough, setRough] = useState("");
  const [composing, setComposing] = useState(false);
  const [draft, setDraft] = useState<{ title: string; description: string } | null>(null);

  const moveTask = useCallback(
    async (id: string, to: TaskStatus) => {
      let moved: Task | null = null;
      let from: TaskStatus | null = null;
      for (const c of COLUMNS) {
        const hit = columns[c.status].find((t) => t.id === id);
        if (hit) {
          moved = hit;
          from = c.status;
          break;
        }
      }
      if (!moved || !from || from === to) return;

      if (moved.source === 'pipeline') {
        if (moved.dispatch_status === 'active' || moved.dispatch_status === 'launching') {
          pushError("Cannot move task while dispatch is active");
          return;
        }
        // Moving into these two columns asks who implements/reviews first, then completes the move.
        if (to === "IN PROGRESS" || to === "REVIEW") {
          setPicker({ orchId: moved.orch_id!, to, title: moved.text });
          return;
        }
        try {
          await orchApi.move(moved.orch_id!, to);
          await refresh();
        } catch (e) {
          pushError((e as Error).message);
        }
        return;
      }

      const snapshot = columns;
      // optimistic
      setColumns((prev) => ({
        ...prev,
        [from!]: prev[from!].filter((t) => t.id !== id),
        [to]: [...prev[to], { ...moved!, status: to }],
      }));
      try {
        await api.updateTask(id, { status: to });
      } catch (e) {
        setColumns(snapshot); // revert
        pushError((e as Error).message);
      }
    },
    [columns, pushError, refresh]
  );

  const removeTask = useCallback(
    async (id: string) => {
      const snapshot = columns;
      // optimistic remove from whichever column holds it
      setColumns((prev) => {
        const next = { ...prev };
        for (const c of COLUMNS) next[c.status] = prev[c.status].filter((t) => t.id !== id);
        return next;
      });
      try {
        await api.deleteTask(id);
      } catch (e) {
        setColumns(snapshot); // revert
        pushError((e as Error).message);
      }
    },
    [columns, pushError]
  );

  const visible = useMemo(() => {
    if (selectedProject === ALL) return columns;
    const filtered = emptyColumns();
    for (const c of COLUMNS) {
      filtered[c.status] = columns[c.status].filter((t) =>
        selectedProject === NONE ? !t.project : t.project === selectedProject
      );
    }
    return filtered;
  }, [columns, selectedProject]);

  const confirmPick = async () => {
    if (!picker) return;
    setPickBusy(true);
    try {
      const isCoder = picker.to === "IN PROGRESS";
      await orchApi.setAgents(
        picker.orchId,
        isCoder
          ? { coder_agent: pickAgent, coder_model: pickModel }
          : { reviewer_agent: pickAgent, reviewer_model: pickModel }
      );
      await orchApi.move(picker.orchId, picker.to);
      setPicker(null);
      await refresh();
    } catch (e) {
      pushError((e as Error).message);
    } finally {
      setPickBusy(false);
    }
  };

  const composeDraft = async () => {
    if (!rough.trim()) return;
    setComposing(true);
    try {
      const r = await orchApi.compose(rough.trim());
      setDraft({ title: r.title, description: r.description });
    } catch (e) {
      pushError((e as Error).message);
    } finally {
      setComposing(false);
    }
  };

  const createFromDraft = async () => {
    if (!draft) return;
    try {
      await orchApi.create({
        title: draft.title,
        description: draft.description,
        project: addProject,
        agent: "user",
      } as Parameters<typeof orchApi.create>[0]);
      setDraft(null);
      setRough("");
      await refresh();
    } catch (e) {
      pushError((e as Error).message);
    }
  };

  const total = COLUMNS.reduce((n, c) => n + visible[c.status].length, 0);
  const addProject = selectedProject !== ALL && selectedProject !== NONE ? selectedProject : null;

  return (
    <div className="flex-1 min-h-0 flex flex-col">
      <div className="shrink-0 px-6 pt-5 pb-3 flex items-baseline gap-3">
        <h1 className="text-neon glow text-lg font-bold tracking-[.1em]">
          TASK GRID
        </h1>
        <span className="text-[10px] text-muted tracking-[.2em]">
          {total} OPERATIONS
        </span>
        <span className="flex-1" />
        <button
          onClick={() => setShowPipelineModal(true)}
          className="border border-line text-muted px-3 h-7 text-[10px] tracking-[.15em] hover:text-ink hover:border-line-hi"
        >
          ▸ PIPELINE
        </button>
      </div>

      {/* Dropdown, not a button row — a row grows unbounded sideways as
          projects pile up (this vault already has 5+ across two folders);
          a <select> scales to any count with a native scrollable list, and
          typing a letter jumps straight to a match. */}
      {projectNotes.length > 0 && (
        <div className="shrink-0 px-6 pb-3 flex items-center gap-2">
          <span className="text-[10px] tracking-[.2em] text-faint uppercase">
            PROJECT
          </span>
          <select
            value={selectedProject}
            onChange={(e) => pickProject(e.target.value)}
            className="bg-bg2 border border-line text-[11px] text-ink h-7 px-2 outline-none focus:border-line-hi max-w-[280px]"
          >
            <option value={ALL}>ALL PROJECTS ({projectNotes.length})</option>
            {projectNotes.map((n) => (
              <option key={n.path} value={n.path}>
                {projectTitle(n.path)}
              </option>
            ))}
            <option value={NONE}>— NO PROJECT —</option>
          </select>
        </div>
      )}

      {/* Composer: you write loosely; the in-app local model refines it into a task spec. */}
      <div className="shrink-0 px-6 pb-3">
        <div className="border border-line bg-panel/40 p-2 space-y-2">
          <div className="flex items-center gap-2">
            <input
              value={rough}
              onChange={(e) => setRough(e.target.value)}
              onKeyDown={(e) => { if (e.key === "Enter" && !composing) void composeDraft(); }}
              placeholder="Describe what you want — the local model turns it into a task spec"
              dir="auto"
              className="flex-1 bg-bg2 border border-line text-[12px] text-ink h-8 px-2 outline-none focus:border-line-hi placeholder:text-faint"
            />
            <button
              onClick={() => void composeDraft()}
              disabled={composing || !rough.trim()}
              className="border border-neon-dim text-neon px-3 h-8 text-[10px] tracking-[.15em] hover:bg-neon/10 disabled:opacity-40"
            >
              {composing ? "REFINING…" : "REFINE"}
            </button>
          </div>

          {draft && (
            <div className="border border-neon-dim/50 bg-bg2/60 p-2 space-y-2">
              <input
                value={draft.title}
                onChange={(e) => setDraft({ ...draft, title: e.target.value })}
                dir="auto"
                className="w-full bg-bg2 border border-line text-[12px] text-ink h-7 px-2 outline-none focus:border-line-hi"
              />
              <textarea
                value={draft.description}
                onChange={(e) => setDraft({ ...draft, description: e.target.value })}
                dir="auto"
                rows={10}
                className="w-full bg-bg2 border border-line text-[11px] text-ink p-2 outline-none focus:border-line-hi resize-y"
              />
              <div className="flex items-center gap-2">
                <span className="text-[9px] text-faint flex-1">Edit the draft if you want, then create the task</span>
                <button
                  onClick={() => setDraft(null)}
                  className="border border-line text-muted px-3 h-7 text-[10px] tracking-[.15em] hover:text-ink"
                >
                  Cancel
                </button>
                <button
                  onClick={() => void createFromDraft()}
                  className="border border-neon-dim text-neon px-3 h-7 text-[10px] tracking-[.15em] hover:bg-neon/10"
                >
                  Create task
                </button>
              </div>
            </div>
          )}
        </div>
      </div>

      <div className="flex-1 min-h-0 px-6 pb-6 grid grid-cols-4 gap-4">
        {COLUMNS.map((col) => {
          const list = visible[col.status];
          const isOver = dragOver === col.status && dragId !== null;
          return (
            <div
              key={col.status}
              className={
                "flex flex-col min-h-0 border bg-panel/40 " +
                (isOver ? "border-line-hi bg-panel2/60" : "border-line")
              }
              onDragOver={(e) => {
                e.preventDefault();
                e.dataTransfer.dropEffect = "move";
                setDragOver(col.status);
              }}
              onDragLeave={(e) => {
                if (!e.currentTarget.contains(e.relatedTarget as Node))
                  setDragOver(null);
              }}
              onDrop={(e) => {
                e.preventDefault();
                const id = e.dataTransfer.getData("text/plain") || dragId;
                setDragOver(null);
                setDragId(null);
                if (id) void moveTask(id, col.status);
              }}
            >
              {/* column header */}
              <div
                className={
                  "shrink-0 h-9 px-3 border-b flex items-center gap-2 " +
                  col.accent
                }
              >
                <span className="text-[11px] font-bold tracking-[.15em]">
                  {col.status}
                </span>
                <span
                  className={
                    "text-[10px] px-1.5 leading-4 tabular-nums " + col.chip
                  }
                >
                  {list.length}
                </span>
                <span className="flex-1" />
                <button
                  className="text-muted hover:text-neon text-[11px] tracking-[.1em]"
                  onClick={() =>
                    setAdding(adding === col.status ? null : col.status)
                  }
                >
                  + ADD
                </button>
              </div>

              {/* cards */}
              <div className="flex-1 overflow-y-auto p-2 space-y-2 min-h-0">
                {adding === col.status && (
                  <AddForm
                    status={col.status}
                    project={addProject}
                    onDone={() => {
                      setAdding(null);
                      void refresh();
                    }}
                  />
                )}
                {loaded && list.length === 0 && adding !== col.status && (
                  <div className="text-faint text-[10px] tracking-[.2em] text-center pt-6">
                    NO DATA IN SECTOR ░░░
                  </div>
                )}
                {list.map((t) => {
                  if (t.source === 'pipeline') {
                    return (
                      <div
                        key={`pipe-${t.id}`}
                        draggable
                        onDragStart={(e) => {
                          e.dataTransfer.setData("text/plain", t.id);
                          e.dataTransfer.effectAllowed = "move";
                          setDragId(t.id);
                        }}
                        onDragEnd={() => {
                          setDragId(null);
                          setDragOver(null);
                        }}
                        onClick={() => setOpenOrchId(t.orch_id!)}
                        title={dragId === t.id ? "Moving this task manually will be audited." : ""}
                        className={
                          "group relative border bg-panel p-2 cursor-grab active:cursor-grabbing hover:border-line-hi " +
                          (t.orch_status === "FAILED"
                            ? "border-red/50"
                            : t.orch_status === "COMPLETED"
                              ? "border-neon/30 opacity-70"
                              : "border-cyan/40") +
                          (dragId === t.id ? " opacity-40" : "")
                        }
                      >
                        <div className="text-[11px] text-ink leading-5 pr-4 break-words" dir="auto">
                          {t.text}
                        </div>
                        {selectedProject === ALL && t.project && (
                          <div className="mt-1.5 text-[10px] text-violet truncate" dir="auto">
                            ▸ {projectTitle(t.project)}
                          </div>
                        )}
                        <div className="mt-1.5 flex items-center gap-1.5 flex-wrap">
                          {t.dispatch_status === 'active' && t.claimed_by && t.current_role && t.orch_status === ROLE_HOLD_STATUS[t.current_role] && (
                            <span className="text-[9px] text-cyan border border-cyan/50 px-1 leading-4">
                              🚀 @{t.claimed_by} · {t.dispatch_conv_id?.slice(0, 8)} · {t.dispatch_launched_at ? Math.floor((Date.now() - t.dispatch_launched_at) / 60000) + 'm' : ''}
                            </span>
                          )}
                          {t.dispatch_status === 'launching' && <span className="text-[9px] text-amber border border-amber/50 px-1 leading-4">⏳ LAUNCHING</span>}
                          {t.dispatch_status === 'failed' && t.current_role && t.orch_status === ROLE_HOLD_STATUS[t.current_role] && (
                            <span 
                              className="text-[9px] text-red border border-red/50 px-1 leading-4 cursor-help truncate max-w-[200px]"
                              title={t.dispatch_error || 'An older launch failed with no recorded reason'}
                            >
                              ❌ {t.dispatch_error && t.dispatch_error.includes('[typecheck]') ? `TYPECHECK FAILED: ${t.dispatch_error.split('\n').find(l => l.trim().length > 0)?.replace('[typecheck]', '').trim() || ''}` : 'FAILED'}
                            </span>
                          )}
                          {t.auto_blocked && (
                            <span className="text-[9px] text-amber border border-amber/50 px-1 leading-4 flex items-center gap-1">
                              ✋ AUTO BLOCKED
                              <button
                                onClick={(e) => {
                                  e.stopPropagation();
                                  void orchApi.resumeAuto(Number(t.id)).then(() => refresh());
                                }}
                                className="hover:text-neon ml-1"
                                title="Clear the auto-wake block"
                              >
                                ↻ RESUME AUTO
                              </button>
                            </span>
                          )}
                          <span className="text-[9px] border px-1 leading-4 text-faint uppercase">
                            {t.current_role}
                          </span>
                          <span className="text-[9px] text-faint bg-bg/50 px-1 leading-4 uppercase">
                            {t.orch_status}
                          </span>
                          <span
                            className={"text-[9px] border px-1 leading-4 " + agentBadgeClass(t.assigned_agent ?? '')}
                          >
                            @{t.assigned_agent}
                          </span>
                          {t.reject_count! > 0 && (
                            <span className="text-[9px] text-red">↺{t.reject_count}</span>
                          )}
                          <span className="flex-1" />
                          <span className="text-[9px] text-faint tabular-nums" title={`ID: ${t.id}`}>#{t.seq !== null ? t.seq : '—'}</span>
                        </div>
                      </div>
                    );
                  }
                  
                  return editingId === t.id ? (
                    <EditForm key={t.id} task={t} onDone={() => { setEditingId(null); void refresh(); }} />
                  ) : (
                    <div
                      key={t.id}
                      draggable
                      onDragStart={(e) => {
                        e.dataTransfer.setData("text/plain", t.id);
                        e.dataTransfer.effectAllowed = "move";
                        setDragId(t.id);
                      }}
                      onDragEnd={() => {
                        setDragId(null);
                        setDragOver(null);
                      }}
                      className={
                        "group relative border border-line bg-panel p-3 cursor-grab active:cursor-grabbing hover:border-line-hi " +
                        (t.status === "DONE" ? "opacity-60 " : "") +
                        (dragId === t.id ? "opacity-40" : "")
                      }
                    >
                      <div className="absolute top-1 right-1 flex gap-1 opacity-0 group-hover:opacity-100 transition-opacity">
                        <button
                          title="EDIT TASK"
                          className="w-4 h-4 leading-none text-faint hover:text-cyan"
                          onClick={(e) => {
                            e.stopPropagation();
                            setEditingId(t.id);
                          }}
                        >
                          ✎
                        </button>
                        <button
                          title="DELETE TASK"
                          className="w-4 h-4 leading-none text-faint hover:text-red"
                          onClick={(e) => {
                            e.stopPropagation();
                            setConfirmDelete(t);
                          }}
                        >
                          ×
                        </button>
                      </div>
                      <div
                        className={
                          "text-xs text-ink leading-5 break-words pr-8 " +
                          (t.status === "DONE" ? "line-through" : "")
                        }
                        dir="auto"
                      >
                        {t.text}
                      </div>
                      {selectedProject === ALL && t.project && (
                        <div className="mt-1.5 text-[10px] text-violet truncate" dir="auto">
                          ▸ {projectTitle(t.project)}
                        </div>
                      )}

                      {t.assignee && t.assignee !== 'user' && t.assignee !== '—' && (t.status === 'REVIEW' || t.status === 'IN PROGRESS') && !t.text.includes('[converted]') && (
                        <div className="mt-2 text-[10px] bg-amber/10 border border-amber/30 text-amber p-1.5 leading-4 rounded-sm flex flex-col gap-1.5 items-start">
                          <div dir="rtl">Manual card — agents are not woken. Convert it to a pipeline task to dispatch it.</div>
                          <button 
                            onClick={async (e) => {
                              e.stopPropagation();
                              try {
                                const created = await orchApi.create({
                                  title: t.text,
                                  description: "",
                                  ...(t.project ? { project: t.project } : {})
                                });
                                await orchApi.move(created.id, t.status);
                                await api.updateTask(t.id, { text: t.text + " [converted]" });
                                void refresh();
                              } catch(err) {
                                pushError((err as Error).message);
                              }
                            }}
                            className="bg-amber/20 hover:bg-amber/30 text-amber px-2 py-0.5 rounded-sm uppercase tracking-wider"
                          >
                            Convert
                          </button>
                        </div>
                      )}

                      <div className="mt-2 flex items-center justify-between gap-2">
                        <div className="flex items-center gap-1.5 flex-wrap">
                          <span className="text-[10px] text-faint bg-bg/50 px-1 leading-4">● manual</span>
                          {t.assignee ? (
                            <span
                              className={
                                "text-[10px] border px-1.5 leading-4 " +
                                agentBadgeClass(t.assignee)
                              }
                            >
                              @{t.assignee}
                            </span>
                          ) : (
                            <span className="text-[10px] text-faint">—</span>
                          )}
                        </div>
                        <span className="text-[10px] text-faint tabular-nums">
                          {t.id}
                        </span>
                      </div>
                    </div>
                  );
                })}
              </div>
            </div>
          );
        })}
      </div>

      {confirmDelete && (
        <ConfirmModal
          title="PURGE TASK"
          danger
          confirmLabel="PURGE"
          message={
            <>
              Permanently delete task <span className="text-red" dir="auto">{confirmDelete.text}</span>. This
              cannot be undone.
            </>
          }
          onConfirm={() => {
            void removeTask(confirmDelete.id);
            setConfirmDelete(null);
          }}
          onCancel={() => setConfirmDelete(null)}
        />
      )}
      
      {picker && (() => {
        const isCoder = picker.to === "IN PROGRESS";
        // The local model reviews only, it does not write code — a settled product decision.
        const choices = isCoder ? ["claude", "opencode"] : ["claude", "opencode", "local_model"];
        const models = ORCH_MODELS[pickAgent];
        return (
          <div className="fixed inset-0 z-50 bg-black/70 flex items-center justify-center p-6">
            <div className="border border-line bg-panel w-[440px] max-w-full p-4 space-y-3">
              <div className="text-[11px] text-ink font-bold tracking-[.1em]">
                {isCoder ? "Who implements this task?" : "Who reviews the code?"}
              </div>
              <div className="text-[10px] text-faint line-clamp-2" dir="auto">{picker.title}</div>

              <div className="flex items-center gap-2">
                <span className="text-[9px] text-faint w-12 shrink-0">TOOL</span>
                <select
                  value={pickAgent}
                  onChange={(e) => { setPickAgent(e.target.value); setPickModel(""); }}
                  className="flex-1 bg-bg2 border border-line text-[11px] text-ink h-7 px-1 outline-none focus:border-line-hi"
                >
                  {choices.map((a) => (
                    <option key={a} value={a}>
                      {a === "local_model" ? "Local model (in-app)" : a}
                    </option>
                  ))}
                </select>
              </div>

              <div className="flex items-center gap-2">
                <span className="text-[9px] text-faint w-12 shrink-0">MODEL</span>
                {models ? (
                  <>
                    <input
                      dir="ltr"
                      list="picker-models"
                      value={pickModel}
                      onChange={(e) => setPickModel(e.target.value)}
                      placeholder={models.find((m) => m.value === "")?.label ?? ""}
                      className="flex-1 bg-bg2 border border-line text-[11px] text-ink h-7 px-1 outline-none focus:border-line-hi placeholder:text-faint"
                    />
                    <datalist id="picker-models">
                      {models.filter((m) => m.value !== "").map((m) => (
                        <option key={m.value} value={m.value}>{m.label}</option>
                      ))}
                    </datalist>
                  </>
                ) : (
                  <input
                    disabled
                    placeholder="The local model loaded in the app"
                    className="flex-1 bg-bg2/30 border border-line/50 text-[11px] text-faint h-7 px-1 outline-none placeholder:text-faint"
                  />
                )}
              </div>

              <div className="flex items-center gap-2 pt-1">
                <span className="flex-1" />
                <button
                  onClick={() => setPicker(null)}
                  className="border border-line text-muted px-3 h-7 text-[10px] tracking-[.15em] hover:text-ink"
                >
                  Cancel
                </button>
                <button
                  onClick={() => void confirmPick()}
                  disabled={pickBusy}
                  className="border border-neon-dim text-neon px-3 h-7 text-[10px] tracking-[.15em] hover:bg-neon/10 disabled:opacity-40"
                >
                  {pickBusy ? "…" : "START"}
                </button>
              </div>
            </div>
          </div>
        );
      })()}

      {showPipelineModal && <PipelineModal onClose={() => setShowPipelineModal(false)} />}
      {openOrchId !== null && <TaskDetail id={openOrchId} onClose={() => setOpenOrchId(null)} onChanged={refresh} />}
    </div>
  );
}
