/* PROTOCOL: standing team RULES + SKILLS. Enabled rules are auto-injected into
   every AI session (MCP instructions), so the user never repeats their stack. */

import { useCallback, useEffect, useMemo, useState } from "react";
import { marked } from "marked";
import { api, type Protocol, type ProtocolItem, type ProtocolKind } from "../lib/api";
import { useStore } from "../lib/store";
import { ConfirmModal, Modal } from "../components/Modal";

marked.setOptions({ gfm: true, breaks: true, async: false });

const EMPTY: Protocol = { rules: [], skills: [], templates: [] };

type Editing =
  | { mode: "add"; kind: ProtocolKind }
  | { mode: "edit"; item: ProtocolItem }
  | null;

export default function ProtocolView() {
  const { protocolTick, pushError } = useStore();
  const [data, setData] = useState<Protocol>(EMPTY);
  const [loaded, setLoaded] = useState(false);
  const [editing, setEditing] = useState<Editing>(null);
  const [confirmDel, setConfirmDel] = useState<ProtocolItem | null>(null);

  const refresh = useCallback(async () => {
    try {
      setData(await api.protocol());
      setLoaded(true);
    } catch (e) {
      pushError((e as Error).message);
    }
  }, [pushError]);

  useEffect(() => {
    void refresh();
  }, [refresh, protocolTick]);

  const toggle = useCallback(
    async (item: ProtocolItem) => {
      // optimistic
      setData((prev) => ({
        rules: prev.rules.map((r) => (r.id === item.id ? { ...r, enabled: !r.enabled } : r)),
        skills: prev.skills,
        templates: prev.templates,
      }));
      try {
        await api.updateProtocol(item.id, { enabled: !item.enabled });
      } catch (e) {
        pushError((e as Error).message);
        void refresh();
      }
    },
    [pushError, refresh]
  );

  const remove = useCallback(
    async (item: ProtocolItem) => {
      setConfirmDel(null);
      setData((prev) => ({
        rules: prev.rules.filter((r) => r.id !== item.id),
        skills: prev.skills.filter((s) => s.id !== item.id),
        templates: prev.templates.filter((t) => t.id !== item.id),
      }));
      try {
        await api.deleteProtocol(item.id);
      } catch (e) {
        pushError((e as Error).message);
        void refresh();
      }
    },
    [pushError, refresh]
  );

  const activeRules = data.rules.filter((r) => r.enabled).length;

  return (
    <div className="flex-1 min-h-0 flex flex-col">
      {/* header */}
      <div className="shrink-0 px-6 pt-5 pb-3">
        <div className="flex items-baseline gap-3">
          <h1 className="text-neon glow text-lg font-bold tracking-[.1em]">PROTOCOL</h1>
          <span className="text-[10px] text-muted tracking-[.2em]">RULES &amp; SKILLS</span>
        </div>
        <p className="mt-1 text-[11px] text-muted leading-5 max-w-3xl" dir="auto">
          Enabled RULES ({activeRules}) are injected automatically into every agent's instructions (Claude / ChatGPT)
          as soon as it connects — so you never repeat your stack or conventions. SKILLS are reference playbooks an agent pulls in on demand.
        </p>
      </div>

      <div className="flex-1 min-h-0 overflow-y-auto px-6 pb-8 space-y-6">
        <Section
          label="RULES"
          arabic="RULES"
          hint="Applied before any work — injected automatically"
          accent="text-neon"
          items={data.rules}
          loaded={loaded}
          showToggle
          onAdd={() => setEditing({ mode: "add", kind: "rule" })}
          onEdit={(item) => setEditing({ mode: "edit", item })}
          onDelete={(item) => setConfirmDel(item)}
          onToggle={toggle}
        />
        <Section
          label="SKILLS"
          arabic="SKILLS"
          hint="A reference/playbook pulled in on demand"
          accent="text-cyan"
          items={data.skills}
          loaded={loaded}
          showToggle={false}
          onAdd={() => setEditing({ mode: "add", kind: "skill" })}
          onEdit={(item) => setEditing({ mode: "edit", item })}
          onDelete={(item) => setConfirmDel(item)}
          onToggle={toggle}
        />
        <Section
          label="PROJECT TYPES"
          arabic="PROJECT TYPES"
          hint="Templates offered when you create a new project"
          accent="text-amber"
          items={data.templates}
          loaded={loaded}
          showToggle={false}
          onAdd={() => setEditing({ mode: "add", kind: "template" })}
          onEdit={(item) => setEditing({ mode: "edit", item })}
          onDelete={(item) => setConfirmDel(item)}
          onToggle={toggle}
        />
      </div>

      {editing && (
        <ProtocolEditor
          editing={editing}
          onClose={() => setEditing(null)}
          onSaved={() => {
            setEditing(null);
            void refresh();
          }}
          onError={pushError}
        />
      )}
      {confirmDel && (
        <ConfirmModal
          title="DELETE"
          danger
          confirmLabel="DELETE"
          message={
            <>
              Delete{" "}
              {confirmDel.kind === "rule"
                ? "Rule"
                : confirmDel.kind === "template"
                  ? "Project type"
                  : "Skill"}
              : <b>{confirmDel.title}</b>?
            </>
          }
          onConfirm={() => void remove(confirmDel)}
          onCancel={() => setConfirmDel(null)}
        />
      )}
    </div>
  );
}

/* ------------------------------------------------------------- section */

function Section({
  label,
  arabic,
  hint,
  accent,
  items,
  loaded,
  showToggle,
  onAdd,
  onEdit,
  onDelete,
  onToggle,
}: {
  label: string;
  arabic: string;
  hint: string;
  accent: string;
  items: ProtocolItem[];
  loaded: boolean;
  showToggle: boolean;
  onAdd: () => void;
  onEdit: (i: ProtocolItem) => void;
  onDelete: (i: ProtocolItem) => void;
  onToggle: (i: ProtocolItem) => void;
}) {
  return (
    <section>
      <div className="flex items-center gap-3 border-b border-line pb-2 mb-3">
        <span className={"text-xs font-bold tracking-[.2em] glow " + accent}>▸ {label}</span>
        <span className="text-[10px] text-muted tracking-[.15em]">{arabic}</span>
        <span className="text-[10px] text-faint">░ {hint}</span>
        <span className="text-[10px] text-faint tabular-nums">[{items.length}]</span>
        <span className="flex-1" />
        <button
          className="text-[11px] tracking-[.1em] text-muted hover:text-neon border border-line hover:border-line-hi px-2 h-6"
          onClick={onAdd}
        >
          + ADD {label === "RULES" ? "RULE" : label === "SKILLS" ? "SKILL" : "TYPE"}
        </button>
      </div>

      {loaded && items.length === 0 && (
        <div className="text-faint text-[10px] tracking-[.2em] py-6 text-center">
          NO DATA IN SECTOR ░░░
        </div>
      )}

      <div className="grid grid-cols-1 lg:grid-cols-2 gap-3">
        {items.map((item) => (
          <ProtocolCard
            key={item.id}
            item={item}
            showToggle={showToggle}
            onEdit={() => onEdit(item)}
            onDelete={() => onDelete(item)}
            onToggle={() => onToggle(item)}
          />
        ))}
      </div>
    </section>
  );
}

/* ---------------------------------------------------------------- card */

function ProtocolCard({
  item,
  showToggle,
  onEdit,
  onDelete,
  onToggle,
}: {
  item: ProtocolItem;
  showToggle: boolean;
  onEdit: () => void;
  onDelete: () => void;
  onToggle: () => void;
}) {
  const html = useMemo(() => marked.parse(item.body || "") as string, [item.body]);
  const off = showToggle && !item.enabled;

  return (
    <div
      className={
        "group relative border bg-panel/50 p-4 flex flex-col " +
        (off ? "border-line/60 opacity-55" : "border-line hover:border-line-hi")
      }
    >
      <div className="flex items-start gap-2 mb-2">
        <h3 className="flex-1 text-sm text-ink font-bold leading-6 break-words" dir="auto">
          {item.title}
        </h3>
        {showToggle && (
          <button
            title={item.enabled ? "Enabled — injected into agents" : "Disabled"}
            className={
              "shrink-0 text-[9px] tracking-[.15em] border px-1.5 h-5 leading-4 " +
              (item.enabled
                ? "border-neon-dim text-neon"
                : "border-line text-faint hover:text-muted")
            }
            onClick={onToggle}
          >
            {item.enabled ? "◉ ON" : "○ OFF"}
          </button>
        )}
      </div>

      {item.body.trim() ? (
        <div
          className="prose-fui text-xs leading-6 min-w-0 [&_*]:!my-1"
          dir="auto"
          dangerouslySetInnerHTML={{ __html: html }}
        />
      ) : (
        <div className="text-faint text-[10px]">—</div>
      )}

      <div className="mt-3 pt-2 border-t border-line/50 flex items-center gap-2 opacity-0 group-hover:opacity-100 transition-opacity">
        <button className="text-[10px] tracking-[.1em] text-muted hover:text-cyan" onClick={onEdit}>
          EDIT
        </button>
        <span className="text-faint">·</span>
        <button className="text-[10px] tracking-[.1em] text-muted hover:text-red" onClick={onDelete}>
          DELETE
        </button>
        <span className="flex-1" />
        <span className="text-[9px] text-faint tabular-nums">{item.id}</span>
      </div>
    </div>
  );
}

/* -------------------------------------------------------------- editor */

function ProtocolEditor({
  editing,
  onClose,
  onSaved,
  onError,
}: {
  editing: Exclude<Editing, null>;
  onClose: () => void;
  onSaved: () => void;
  onError: (msg: string) => void;
}) {
  const isEdit = editing.mode === "edit";
  const kind: ProtocolKind = isEdit ? editing.item.kind : editing.kind;
  const [title, setTitle] = useState(isEdit ? editing.item.title : "");
  const [body, setBody] = useState(isEdit ? editing.item.body : "");
  const [saving, setSaving] = useState(false);

  const kindLabel = kind === "rule" ? "Rule" : kind === "template" ? "Project type" : "Skill";
  const kindUpper = kind === "rule" ? "RULE" : kind === "template" ? "TYPE" : "SKILL";

  const save = useCallback(async () => {
    if (!title.trim() || saving) return;
    setSaving(true);
    try {
      if (isEdit) {
        await api.updateProtocol(editing.item.id, { title, body });
      } else {
        await api.addProtocol({ kind, title, body });
      }
      onSaved();
    } catch (e) {
      onError((e as Error).message);
      setSaving(false);
    }
  }, [title, body, saving, isEdit, editing, kind, onSaved, onError]);

  return (
    <Modal title={`${isEdit ? "EDIT" : "NEW"} ${kindUpper}`} onClose={onClose}>
      <div className="w-[520px] max-w-full">
        <label className="block text-[10px] tracking-[.15em] text-muted mb-1">Title ({kindLabel})</label>
        <input
          autoFocus
          value={title}
          onChange={(e) => setTitle(e.target.value)}
          dir="auto"
          spellCheck={false}
          className="w-full bg-bg2 border border-line focus:border-line-hi text-ink text-sm px-2 h-9 outline-none mb-3"
        />
        <label className="block text-[10px] tracking-[.15em] text-muted mb-1">
          Content (Markdown supported)
        </label>
        <textarea
          value={body}
          onChange={(e) => setBody(e.target.value)}
          dir="auto"
          spellCheck={false}
          rows={10}
          onKeyDown={(e) => {
            if ((e.metaKey || e.ctrlKey) && e.key === "Enter") void save();
          }}
          className="w-full bg-bg2 border border-line focus:border-line-hi text-ink text-xs font-mono leading-6 p-2 outline-none resize-y"
        />
        <div className="mt-4 flex justify-end gap-2">
          <button
            className="border border-line px-4 h-8 text-xs text-muted hover:text-ink hover:border-line-hi"
            onClick={onClose}
          >
            CANCEL
          </button>
          <button
            disabled={!title.trim() || saving}
            className="border border-neon-dim text-neon px-4 h-8 text-xs hover:bg-neon/10 disabled:opacity-40"
            onClick={() => void save()}
          >
            {saving ? "…" : "SAVE"}
          </button>
        </div>
      </div>
    </Modal>
  );
}
