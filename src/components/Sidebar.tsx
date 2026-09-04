/* Left sidebar: search (Ctrl+K, dropdown results), nav, folder tree. */

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { api, type NoteMeta, type SearchResult } from "../lib/api";
import { noteHash, useStore, type Route } from "../lib/store";
import { ConfirmModal } from "./Modal";
import NewProjectModal from "./NewProjectModal";

/* ------------------------------------------------------------- nav def */

const NAV: { key: string; label: string; hash: string; match: (r: Route) => boolean }[] = [
  { key: "notes", label: "NOTES", hash: "#/note/", match: (r) => r.view === "note" },
  { key: "graph", label: "GRAPH", hash: "#/graph", match: (r) => r.view === "graph" },
  { key: "tasks", label: "TASKS", hash: "#/tasks", match: (r) => r.view === "tasks" },
  { key: "librarian", label: "LIBRARIAN", hash: "#/librarian", match: (r) => r.view === "librarian" },
  { key: "activity", label: "ACTIVITY", hash: "#/activity", match: (r) => r.view === "activity" },
  { key: "protocol", label: "PROTOCOL", hash: "#/protocol", match: (r) => r.view === "protocol" },
  { key: "connect", label: "CONNECT", hash: "#/connect", match: (r) => r.view === "connect" },
];

/* ---------------------------------------------------------- folder tree */

interface Folder {
  name: string;
  path: string; // "Projects" or "Projects/Sub"
  folders: Folder[];
  notes: NoteMeta[];
}

function buildTree(notes: NoteMeta[]): Folder {
  const root: Folder = { name: "", path: "", folders: [], notes: [] };
  const dirIndex = new Map<string, Folder>([["", root]]);

  const getDir = (path: string): Folder => {
    const hit = dirIndex.get(path);
    if (hit) return hit;
    const segs = path.split("/");
    const parent = getDir(segs.slice(0, -1).join("/"));
    const f: Folder = { name: segs[segs.length - 1], path, folders: [], notes: [] };
    parent.folders.push(f);
    dirIndex.set(path, f);
    return f;
  };

  for (const n of notes) {
    const segs = n.path.split("/");
    getDir(segs.slice(0, -1).join("/")).notes.push(n);
  }

  const sortRec = (f: Folder) => {
    f.folders.sort((a, b) => a.name.localeCompare(b.name));
    f.notes.sort((a, b) => a.path.localeCompare(b.path));
    f.folders.forEach(sortRec);
  };
  sortRec(root);
  return root;
}

function FolderRow({
  folder,
  depth,
  collapsed,
  toggle,
  activePath,
  openNote,
  onDeleteFolder,
  onDeleteNote,
}: {
  folder: Folder;
  depth: number;
  collapsed: Set<string>;
  toggle: (p: string) => void;
  activePath: string | null;
  openNote: (p: string) => void;
  onDeleteFolder: (folder: Folder) => void;
  onDeleteNote: (note: NoteMeta) => void;
}) {
  const isCollapsed = collapsed.has(folder.path);
  return (
    <div className="group/folder">
      <div
        className="w-full flex items-center gap-1.5 h-7 text-xs text-muted hover:text-ink"
        style={{ paddingInlineStart: depth * 14 + 8 }}
      >
        <button
          className="flex-1 min-w-0 text-left flex items-center gap-1.5 truncate"
          onClick={() => toggle(folder.path)}
        >
          <span className="text-faint w-3 shrink-0">{isCollapsed ? "▸" : "▾"}</span>
          <span className="truncate uppercase tracking-[.08em]" dir="auto">
            {folder.name}
          </span>
        </button>
        <button
          className="shrink-0 pr-2 opacity-0 group-hover/folder:opacity-100 text-faint hover:text-red"
          title="Delete folder (all notes inside)"
          onClick={(e) => {
            e.stopPropagation();
            onDeleteFolder(folder);
          }}
        >
          🗑
        </button>
      </div>
      {!isCollapsed && (
        <TreeChildren
          folder={folder}
          depth={depth + 1}
          collapsed={collapsed}
          toggle={toggle}
          activePath={activePath}
          openNote={openNote}
          onDeleteFolder={onDeleteFolder}
          onDeleteNote={onDeleteNote}
        />
      )}
    </div>
  );
}

function TreeChildren({
  folder,
  depth,
  collapsed,
  toggle,
  activePath,
  openNote,
  onDeleteFolder,
  onDeleteNote,
}: {
  folder: Folder;
  depth: number;
  collapsed: Set<string>;
  toggle: (p: string) => void;
  activePath: string | null;
  openNote: (p: string) => void;
  onDeleteFolder: (folder: Folder) => void;
  onDeleteNote: (note: NoteMeta) => void;
}) {
  return (
    <>
      {folder.folders.map((f) => (
        <FolderRow
          key={f.path}
          folder={f}
          depth={depth}
          collapsed={collapsed}
          toggle={toggle}
          activePath={activePath}
          openNote={openNote}
          onDeleteFolder={onDeleteFolder}
          onDeleteNote={onDeleteNote}
        />
      ))}
      {folder.notes.map((n) => {
        const active = activePath === n.path;
        const file = n.path.split("/").pop()!.replace(/\.md$/i, "");
        return (
          <div key={n.path} className="group/note flex items-center">
            <button
              className={
                "flex-1 min-w-0 text-left flex items-center gap-1.5 h-7 text-xs truncate border-l-2 " +
                (active
                  ? "text-neon glow border-neon bg-neon/5"
                  : "text-ink/80 border-transparent hover:text-ink hover:bg-panel2/60")
              }
              style={{ paddingInlineStart: depth * 14 + 8 }}
              onClick={() => openNote(n.path)}
              title={n.path}
            >
              <span className={"w-3 shrink-0 " + (active ? "text-neon" : "text-faint")}>
                {active ? "▸" : "·"}
              </span>
              <span className="truncate" dir="auto">
                {file}
              </span>
            </button>
            <button
              className="shrink-0 pr-2 opacity-0 group-hover/note:opacity-100 text-faint hover:text-red"
              title="Delete note"
              onClick={(e) => {
                e.stopPropagation();
                onDeleteNote(n);
              }}
            >
              🗑
            </button>
          </div>
        );
      })}
    </>
  );
}

/* ---------------------------------------------------------------- search */

function SearchBox() {
  const { openNote } = useStore();
  const [q, setQ] = useState("");
  const [results, setResults] = useState<SearchResult[] | null>(null);
  const [open, setOpen] = useState(false);
  const inputRef = useRef<HTMLInputElement>(null);
  const boxRef = useRef<HTMLDivElement>(null);
  const seqRef = useRef(0);

  /* Ctrl/Cmd+K global focus */
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === "k") {
        e.preventDefault();
        inputRef.current?.focus();
        inputRef.current?.select();
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);

  /* debounced search */
  useEffect(() => {
    const query = q.trim();
    if (!query) {
      setResults(null);
      setOpen(false);
      return;
    }
    const seq = ++seqRef.current;
    const t = setTimeout(async () => {
      try {
        const r = await api.search(query);
        if (seqRef.current === seq) {
          setResults(r);
          setOpen(true);
        }
      } catch {
        /* search failures are silent — banner would be noisy while typing */
      }
    }, 200);
    return () => clearTimeout(t);
  }, [q]);

  /* click outside closes */
  useEffect(() => {
    const onDown = (e: MouseEvent) => {
      if (boxRef.current && !boxRef.current.contains(e.target as Node)) setOpen(false);
    };
    window.addEventListener("mousedown", onDown);
    return () => window.removeEventListener("mousedown", onDown);
  }, []);

  const pick = useCallback(
    (path: string) => {
      openNote(path);
      setOpen(false);
      inputRef.current?.blur();
    },
    [openNote]
  );

  return (
    <div className="relative p-2 border-b border-line" ref={boxRef}>
      <div className="flex items-center border border-line bg-bg2 h-8 px-2 gap-1 focus-within:border-line-hi">
        <span className="text-neon-dim text-xs shrink-0">&gt;</span>
        <input
          ref={inputRef}
          value={q}
          dir="auto"
          spellCheck={false}
          onChange={(e) => setQ(e.target.value)}
          onFocus={() => {
            if (results) setOpen(true);
          }}
          onKeyDown={(e) => {
            if (e.key === "Escape") {
              setOpen(false);
              (e.target as HTMLInputElement).blur();
            }
            if (e.key === "Enter" && results && results.length > 0) {
              pick(results[0].path);
            }
          }}
          placeholder="SEARCH_"
          className="flex-1 min-w-0 bg-transparent outline-none text-xs text-ink placeholder:text-faint tracking-[.1em]"
        />
        <span className="text-faint text-[9px] shrink-0 border border-faint px-1 leading-4">⌘K</span>
      </div>
      {open && results && (
        <div className="absolute left-2 right-2 top-full z-40 max-h-80 overflow-y-auto border border-line-hi bg-panel shadow-[0_8px_30px_rgba(0,0,0,0.6)]">
          {results.length === 0 && (
            <div className="p-3 text-xs text-faint tracking-[.15em]">NO DATA IN SECTOR ░░░</div>
          )}
          {results.map((r) => (
            <button
              key={r.path}
              className="w-full text-left px-3 py-2 border-b border-line/60 last:border-b-0 hover:bg-panel2 group"
              onClick={() => pick(r.path)}
            >
              <div className="text-xs text-neon group-hover:glow truncate" dir="auto">
                {r.title}
              </div>
              <div className="text-[10px] text-faint truncate">{r.path}</div>
              {r.matches[0] && (
                <div className="text-[11px] text-muted truncate mt-0.5" dir="auto">
                  {r.matches[0].line > 0 && (
                    <span className="text-faint">{r.matches[0].line}: </span>
                  )}
                  {r.matches[0].text.trim().slice(0, 120)}
                </div>
              )}
            </button>
          ))}
        </div>
      )}
    </div>
  );
}

/* --------------------------------------------------------------- sidebar */

function countNotes(folder: Folder): number {
  return folder.notes.length + folder.folders.reduce((sum, f) => sum + countNotes(f), 0);
}

export default function Sidebar() {
  const { notes, notesLoaded, route, navigate, openNote, refreshNotes, pushError } = useStore();
  const [collapsed, setCollapsed] = useState<Set<string>>(() => new Set());
  const [newProject, setNewProject] = useState(false);
  const [deleteTarget, setDeleteTarget] = useState<Folder | null>(null);
  const [deletingFolder, setDeletingFolder] = useState(false);
  const [deleteNoteTarget, setDeleteNoteTarget] = useState<NoteMeta | null>(null);
  const [deletingNote, setDeletingNote] = useState(false);

  const tree = useMemo(() => buildTree(notes), [notes]);
  const activePath = route.view === "note" ? route.path : null;

  const doDeleteFolder = async () => {
    if (!deleteTarget) return;
    setDeletingFolder(true);
    try {
      await api.deleteFolder(deleteTarget.path);
      await refreshNotes();
      setDeleteTarget(null);
    } catch (e) {
      pushError((e as Error).message);
    } finally {
      setDeletingFolder(false);
    }
  };

  const doDeleteNote = async () => {
    if (!deleteNoteTarget) return;
    const path = deleteNoteTarget.path;
    setDeletingNote(true);
    try {
      await api.deleteNote(path);
      await refreshNotes();
      setDeleteNoteTarget(null);
      // If the deleted note was open, navigate away from it.
      if (activePath === path) {
        const rest = notes.filter((n) => n.path !== path);
        if (rest[0]) openNote(rest[0].path);
        else navigate("#/note/");
      }
    } catch (e) {
      pushError((e as Error).message);
    } finally {
      setDeletingNote(false);
    }
  };

  const toggle = useCallback((p: string) => {
    setCollapsed((prev) => {
      const next = new Set(prev);
      if (next.has(p)) next.delete(p);
      else next.add(p);
      return next;
    });
  }, []);

  const goNav = (item: (typeof NAV)[number]) => {
    if (item.key === "notes") {
      if (activePath) return; // already on a note
      const first = notes[0];
      navigate(first ? noteHash(first.path) : "#/note/");
    } else {
      navigate(item.hash);
    }
  };

  return (
    <aside className="w-64 shrink-0 border-r border-line bg-panel/40 flex flex-col min-h-0">
      <SearchBox />

      <nav className="py-2 border-b border-line">
        {NAV.map((item) => {
          const active = item.match(route);
          return (
            <button
              key={item.key}
              onClick={() => goNav(item)}
              className={
                "w-full text-left h-8 px-3 text-xs tracking-[.2em] flex items-center gap-2 border-l-2 " +
                (active
                  ? "text-neon glow border-neon bg-neon/5"
                  : "text-muted border-transparent hover:text-ink hover:bg-panel2/60")
              }
            >
              <span className="w-3">{active ? "▸" : ""}</span>
              {item.label}
            </button>
          );
        })}
      </nav>

      <div className="px-3 pt-3">
        <button
          onClick={() => setNewProject(true)}
          className="w-full h-8 border border-neon-dim/60 text-neon text-[11px] tracking-[.18em] hover:bg-neon/10 hover:border-neon flex items-center justify-center gap-2 glow"
        >
          <span className="text-sm leading-none">＋</span> NEW PROJECT
        </button>
      </div>

      <div className="px-3 pt-3 pb-1 text-[10px] tracking-[.2em] text-faint uppercase flex items-center justify-between">
        <span>VAULT</span>
        <span>{notes.length}</span>
      </div>

      <div className="flex-1 overflow-y-auto pb-4 min-h-0">
        {notesLoaded && notes.length === 0 ? (
          <div className="p-4 text-xs text-faint tracking-[.15em]">
            NO DATA IN SECTOR ░░░
          </div>
        ) : (
          <TreeChildren
            folder={tree}
            depth={0}
            collapsed={collapsed}
            toggle={toggle}
            activePath={activePath}
            openNote={openNote}
            onDeleteFolder={setDeleteTarget}
            onDeleteNote={setDeleteNoteTarget}
          />
        )}
      </div>

      {newProject && <NewProjectModal onClose={() => setNewProject(false)} />}

      {deleteTarget && (
        <ConfirmModal
          title="PURGE FOLDER"
          danger
          confirmLabel={deletingFolder ? "PURGING…" : "PURGE ALL"}
          message={
            <>
              Permanently delete the folder <span className="text-red" dir="auto">{deleteTarget.name}</span> — this
              will erase <b>{countNotes(deleteTarget)}</b> notes inside it (and any subfolders). This cannot be undone.
            </>
          }
          onConfirm={() => void doDeleteFolder()}
          onCancel={() => setDeleteTarget(null)}
        />
      )}

      {deleteNoteTarget && (
        <ConfirmModal
          title="PURGE SECTOR"
          danger
          confirmLabel={deletingNote ? "PURGING…" : "PURGE"}
          message={
            <>
              Permanently delete the note <span className="text-red" dir="auto">{deleteNoteTarget.title}</span> —
              any [[wiki-links]] pointing to it from other notes will break. This cannot be undone.
            </>
          }
          onConfirm={() => void doDeleteNote()}
          onCancel={() => setDeleteNoteTarget(null)}
        />
      )}
    </aside>
  );
}
