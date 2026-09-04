/* NEW PROJECT wizard: pick a project TYPE (template from PROTOCOL), name it,
   and CORTEX scaffolds a project note pre-filled with that type's stack — so the
   user never re-types their stack, and every AI agent reads it from the note. */

import { useEffect, useMemo, useState } from "react";
import { api, type ProtocolItem } from "../lib/api";
import { useStore } from "../lib/store";
import { Modal } from "./Modal";

/** strip frontmatter + leading # heading, collapse to a short preview line */
function preview(body: string): string {
  let s = body.replace(/\{\{name\}\}/g, "PROJECT").replace(/\{\{date\}\}/g, "Today");
  if (s.startsWith("---")) {
    const end = s.indexOf("\n---", 3);
    if (end !== -1) s = s.slice(s.indexOf("\n", end + 1) + 1);
  }
  return s
    .split("\n")
    .filter((l) => l.trim() && !l.trim().startsWith("#"))
    .slice(0, 3)
    .join(" · ")
    .replace(/[*_`>[\]]/g, "")
    .slice(0, 120);
}

function todayISO(): string {
  const d = new Date();
  const p = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
}

const BLANK: ProtocolItem = {
  id: "__blank__",
  kind: "template",
  title: "Blank project",
  body: "---\ntitle: {{name}}\ntags: [project]\n---\n\n# {{name}}\n\n- **Status:** 🆕 new\n- **Date:** {{date}}\n\n## 🎯 Goal\n> \n",
  enabled: true,
  position: 999,
  created: 0,
  updated: 0,
};

export default function NewProjectModal({ onClose }: { onClose: () => void }) {
  const { notes, openNote, pushError } = useStore();
  const [templates, setTemplates] = useState<ProtocolItem[]>([]);
  const [picked, setPicked] = useState<string | null>(null);
  const [name, setName] = useState("");
  const [creating, setCreating] = useState(false);

  useEffect(() => {
    let alive = true;
    (async () => {
      try {
        const p = await api.protocol();
        if (!alive) return;
        const list = p.templates.length ? p.templates : [];
        setTemplates(list);
        setPicked(list[0]?.id ?? BLANK.id);
      } catch (e) {
        pushError((e as Error).message);
        setPicked(BLANK.id);
      }
    })();
    return () => {
      alive = false;
    };
  }, [pushError]);

  const options = useMemo(() => (templates.length ? templates : [BLANK]), [templates]);
  // NFC + per-segment trim to mirror the server's normalizePath, so the collision
  // check, the write, and openNote all use the exact path the DB will store.
  const cleanName = useMemo(() => name.trim().normalize("NFC"), [name]);
  const path = useMemo(() => `Projects/${cleanName}/${cleanName}.md`, [cleanName]);
  const collision = useMemo(
    () => notes.some((n) => n.path.normalize("NFC").toLowerCase() === path.toLowerCase()),
    [notes, path]
  );
  const canCreate = cleanName.length > 0 && !!picked && !collision && !creating;

  const create = async () => {
    if (!canCreate) return;
    const tpl = options.find((t) => t.id === picked) ?? BLANK;
    // Replacement FUNCTIONS so "$"-sequences in the name aren't treated as
    // String.replace special patterns ($&, $$, …) and corrupt the note.
    const date = todayISO();
    const body = tpl.body.replace(/\{\{name\}\}/g, () => cleanName).replace(/\{\{date\}\}/g, () => date);
    setCreating(true);
    try {
      await api.writeNote(path, body, "user");
      openNote(path);
      onClose();
    } catch (e) {
      pushError((e as Error).message);
      setCreating(false);
    }
  };

  return (
    <Modal title="NEW PROJECT" onClose={onClose}>
      <div className="w-[560px] max-w-full">
        <div className="text-[10px] tracking-[.15em] text-muted mb-2">Choose a project type</div>
        <div className="grid grid-cols-2 gap-2 max-h-[46vh] overflow-y-auto pr-1">
          {options.map((t) => {
            const active = picked === t.id;
            return (
              <button
                key={t.id}
                onClick={() => setPicked(t.id)}
                className={
                  "text-right border p-3 flex flex-col gap-1 transition-colors " +
                  (active
                    ? "border-neon bg-neon/5 shadow-[0_0_16px_rgba(0,255,102,0.12)]"
                    : "border-line hover:border-line-hi bg-bg2/40")
                }
              >
                <div className="flex items-center gap-2">
                  <span className={active ? "text-neon" : "text-muted"}>{active ? "◉" : "○"}</span>
                  <span className="flex-1 text-xs font-bold text-ink leading-5" dir="auto">
                    {t.title}
                  </span>
                </div>
                <div className="text-[10px] text-faint leading-5 line-clamp-2" dir="auto">
                  {preview(t.body) || "Blank template"}
                </div>
              </button>
            );
          })}
        </div>

        <div className="mt-4">
          <label className="block text-[10px] tracking-[.15em] text-muted mb-1">Project name</label>
          <input
            autoFocus
            value={name}
            onChange={(e) => setName(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter") void create();
            }}
            dir="auto"
            spellCheck={false}
            placeholder="e.g. Storefront app"
            className="w-full bg-bg2 border border-line focus:border-line-hi text-ink text-sm px-2 h-9 outline-none"
          />
          <div className="mt-1 flex items-center justify-between">
            <span className="text-[10px] text-faint" dir="ltr">
              {name.trim() ? path : "Projects/…/…"}
            </span>
            {collision && <span className="text-[10px] text-red">A project with this name already exists</span>}
          </div>
        </div>

        <div className="mt-5 flex justify-end gap-2">
          <button
            className="border border-line px-4 h-8 text-xs text-muted hover:text-ink hover:border-line-hi"
            onClick={onClose}
          >
            CANCEL
          </button>
          <button
            disabled={!canCreate}
            className="border border-neon-dim text-neon px-4 h-8 text-xs hover:bg-neon/10 disabled:opacity-40"
            onClick={() => void create()}
          >
            {creating ? "…" : "CREATE ▸"}
          </button>
        </div>
      </div>
    </Modal>
  );
}
