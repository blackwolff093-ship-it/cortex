/* Note reading/editing view: markdown render, wiki-links, clickable
   checkboxes, backlinks, edit/new/delete, full Arabic (dir=auto) support. */

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { marked } from "marked";
import { api, type Note, type SimilarNote } from "../lib/api";
import { useStore } from "../lib/store";
import { ConfirmModal, Modal } from "../components/Modal";

marked.setOptions({ gfm: true, breaks: true, async: false });

/* When set, NoteView opens the editor as soon as this path loads
   (used after creating a note from a broken wiki-link / NEW). */
let pendingEditPath: string | null = null;

/* ------------------------------------------------------------ md helpers */

function escapeHtml(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

const WIKI_RE = /\[\[([^\]|]+)(?:\|([^\]]*))?\]\]/g;
const CODE_SPLIT_RE = /(```[\s\S]*?(?:```|$)|~~~[\s\S]*?(?:~~~|$)|`[^`\n]*`)/g;

/** Replace [[Target]] / [[Target|alias]] with anchors, skipping code spans. */
function injectWikiLinks(
  src: string,
  resolve: (t: string) => { path: string } | null
): string {
  return src
    .split(CODE_SPLIT_RE)
    .map((seg, i) => {
      if (i % 2 === 1) return seg; // code segment — untouched
      return seg.replace(WIKI_RE, (_m, target: string, alias?: string) => {
        const label = escapeHtml((alias ?? target).trim() || target.trim());
        const hit = resolve(target);
        if (hit) {
          return `<a class="wikilink" data-path="${escapeHtml(hit.path)}">${label}</a>`;
        }
        return `<a class="wikilink-broken" data-title="${escapeHtml(target.trim())}">${label}</a>`;
      });
    })
    .join("");
}

/** Strip a leading --- frontmatter block for display. */
function stripFrontmatter(src: string): string {
  if (!src.startsWith("---")) return src;
  const end = src.indexOf("\n---", 3);
  if (end === -1) return src;
  const after = src.indexOf("\n", end + 1);
  return after === -1 ? "" : src.slice(after + 1);
}

const TASK_LINE_RE = /^(\s*(?:[-*+]|\d+[.)])\s+)\[( |x|X)\]/;

/** Toggle the nth task-checkbox line in the raw source; returns new source. */
function toggleTaskLine(src: string, n: number): string {
  const lines = src.split("\n");
  let seen = 0;
  let inFence = false;
  for (let i = 0; i < lines.length; i++) {
    if (/^\s*(```|~~~)/.test(lines[i])) inFence = !inFence;
    if (inFence) continue;
    const m = lines[i].match(TASK_LINE_RE);
    if (m) {
      if (seen === n) {
        const box = m[2] === " " ? "[x]" : "[ ]";
        lines[i] = lines[i].replace(TASK_LINE_RE, `$1${box}`);
        return lines.join("\n");
      }
      seen++;
    }
  }
  return src;
}

function fmtTime(ms: number): string {
  if (!ms) return "—";
  const d = new Date(ms);
  const p = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}`;
}

/* --------------------------------------------------------------- editor */

function Editor({
  initial,
  onSave,
  onCancel,
}: {
  initial: string;
  onSave: (content: string) => void;
  onCancel: () => void;
}) {
  const [draft, setDraft] = useState(initial);
  const draftRef = useRef(draft);
  draftRef.current = draft;

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === "s") {
        e.preventDefault();
        onSave(draftRef.current);
      }
      if (e.key === "Escape") onCancel();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onSave, onCancel]);

  return (
    <div className="flex-1 flex flex-col min-h-0 px-6 pb-6">
      <div className="flex items-center gap-2 h-10 shrink-0 text-[10px] tracking-[.2em] text-faint uppercase">
        <span className="text-amber">▸ EDIT MODE</span>
        <span>— CTRL+S TO COMMIT</span>
        <span className="flex-1" />
        <button
          className="border border-neon-dim text-neon px-4 h-7 text-xs hover:bg-neon/10"
          onClick={() => onSave(draft)}
        >
          SAVE
        </button>
        <button
          className="border border-line text-muted px-4 h-7 text-xs hover:text-ink hover:border-line-hi"
          onClick={onCancel}
        >
          CANCEL
        </button>
      </div>
      <textarea
        autoFocus
        dir="auto"
        spellCheck={false}
        value={draft}
        onChange={(e) => setDraft(e.target.value)}
        className="flex-1 min-h-0 w-full resize-none bg-bg2 border border-line focus:border-line-hi outline-none text-ink font-mono text-[13px] leading-6 p-4"
      />
    </div>
  );
}

/* ------------------------------------------------------------- new note */

function NewNoteModal({
  onCreate,
  onClose,
}: {
  onCreate: (path: string) => void;
  onClose: () => void;
}) {
  const [path, setPath] = useState("");
  const submit = () => {
    const p = path.trim();
    if (p) onCreate(p.endsWith(".md") ? p : p + ".md");
  };
  return (
    <Modal title="NEW MEMORY SECTOR" onClose={onClose}>
      <div className="text-[11px] text-muted mb-2 tracking-[.1em]">
        PATH (e.g. Projects/Idea.md)
      </div>
      <input
        autoFocus
        dir="auto"
        spellCheck={false}
        value={path}
        onChange={(e) => setPath(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === "Enter") submit();
        }}
        placeholder="Projects/idea.md"
        className="w-full bg-bg2 border border-line focus:border-line-hi outline-none text-ink text-xs h-9 px-3 placeholder:text-faint"
      />
      <div className="flex justify-end gap-2 mt-4">
        <button
          className="border border-line px-4 h-8 text-xs text-muted hover:text-ink hover:border-line-hi"
          onClick={onClose}
        >
          CANCEL
        </button>
        <button
          className="border border-neon-dim text-neon px-4 h-8 text-xs hover:bg-neon/10 disabled:opacity-40"
          disabled={!path.trim()}
          onClick={submit}
        >
          CREATE
        </button>
      </div>
    </Modal>
  );
}

/* ---------------------------------------------------------------- rename */

function RenameModal({
  current,
  onRename,
  onClose,
}: {
  current: string;
  onRename: (to: string) => void;
  onClose: () => void;
}) {
  const { notes } = useStore();
  const [path, setPath] = useState(current);
  const cleanPath = path.trim();
  const target = cleanPath.endsWith(".md") ? cleanPath : cleanPath + ".md";
  const collision =
    target.normalize("NFC").toLowerCase() !== current.normalize("NFC").toLowerCase() &&
    notes.some((n) => n.path.normalize("NFC").toLowerCase() === target.normalize("NFC").toLowerCase());
  const canRename = cleanPath.length > 0 && !collision && target !== current;

  const submit = () => {
    if (canRename) onRename(target);
  };

  return (
    <Modal title="RENAME / MOVE SECTOR" onClose={onClose}>
      <div className="text-[11px] text-muted mb-2 tracking-[.1em]">
        NEW PATH — updates [[wiki-links]] in every other note automatically
      </div>
      <input
        autoFocus
        dir="auto"
        spellCheck={false}
        value={path}
        onChange={(e) => setPath(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === "Enter") submit();
        }}
        placeholder="Projects/idea.md"
        className="w-full bg-bg2 border border-line focus:border-line-hi outline-none text-ink text-xs h-9 px-3 placeholder:text-faint"
      />
      {collision && (
        <div className="mt-1 text-[10px] text-red">A note already exists at this path</div>
      )}
      <div className="flex justify-end gap-2 mt-4">
        <button
          className="border border-line px-4 h-8 text-xs text-muted hover:text-ink hover:border-line-hi"
          onClick={onClose}
        >
          CANCEL
        </button>
        <button
          className="border border-neon-dim text-neon px-4 h-8 text-xs hover:bg-neon/10 disabled:opacity-40"
          disabled={!canRename}
          onClick={submit}
        >
          RENAME
        </button>
      </div>
    </Modal>
  );
}

/* ------------------------------------------------------------ main view */

export default function NoteView({ path }: { path: string }) {
  const { notes, notesLoaded, vaultTick, openNote, pushError, resolveNote } =
    useStore();
  const [note, setNote] = useState<Note | null>(null);
  const [missing, setMissing] = useState(false);
  const [editing, setEditing] = useState(false);
  const [showDelete, setShowDelete] = useState(false);
  const [showNew, setShowNew] = useState(false);
  const [showRename, setShowRename] = useState(false);
  const [suggestedTags, setSuggestedTags] = useState<string[] | null>(null);
  const [tagsLoading, setTagsLoading] = useState(false);
  const [similar, setSimilar] = useState<SimilarNote[] | null>(null);
  const bodyRef = useRef<HTMLDivElement>(null);
  const editingRef = useRef(editing);
  editingRef.current = editing;

  /* fetch note */
  useEffect(() => {
    let alive = true;
    (async () => {
      try {
        const n = await api.readNote(path);
        if (!alive) return;
        /* never clobber an open editor draft with an SSE refresh */
        if (editingRef.current) return;
        setNote(n);
        setMissing(false);
        if (pendingEditPath === path) {
          pendingEditPath = null;
          setEditing(true);
        }
      } catch (e) {
        if (!alive) return;
        const msg = (e as Error).message;
        if (/not found|404/i.test(msg)) {
          setNote(null);
          setMissing(true);
        } else {
          pushError(msg);
        }
      }
    })();
    return () => {
      alive = false;
    };
  }, [path, vaultTick, pushError]);

  /* reset edit state when navigating to another note */
  useEffect(() => {
    setEditing(false);
    setShowDelete(false);
    setSuggestedTags(null);
  }, [path]);

  /* Semantically related notes. Silent on failure: with no embedding model
     installed yet this is simply unavailable, not an error worth a banner. */
  useEffect(() => {
    let alive = true;
    setSimilar(null);
    api
      .similarNotes(path)
      .then((rows) => {
        if (alive) setSimilar(rows.filter((r) => r.score >= 0.5));
      })
      .catch(() => {});
    return () => {
      alive = false;
    };
  }, [path, vaultTick]);

  const askAiTags = useCallback(async () => {
    setTagsLoading(true);
    try {
      const { tags } = await api.aiSuggestTags(path);
      const existing = new Set((note?.tags ?? []).map((t) => t.toLowerCase()));
      setSuggestedTags(tags.filter((t) => !existing.has(t.toLowerCase())));
    } catch (e) {
      pushError((e as Error).message);
    } finally {
      setTagsLoading(false);
    }
  }, [path, note, pushError]);

  /* render markdown */
  const html = useMemo(() => {
    if (!note) return "";
    const pre = injectWikiLinks(stripFrontmatter(note.content), resolveNote);
    return marked.parse(pre) as string;
  }, [note, resolveNote]);

  /* post-render DOM pass: dir=auto for Arabic + enable checkboxes */
  useEffect(() => {
    const el = bodyRef.current;
    if (!el) return;
    el.querySelectorAll("p,li,h1,h2,h3,h4,h5,h6,blockquote,td,th").forEach((b) =>
      b.setAttribute("dir", "auto")
    );
    el.querySelectorAll<HTMLInputElement>('input[type="checkbox"]').forEach(
      (cb) => {
        cb.disabled = false;
        cb.closest("li")?.classList.add("task-li");
      }
    );
  }, [html]);

  const save = useCallback(
    async (content: string, stay = false) => {
      try {
        const updated = await api.writeNote(path, content, "user");
        setNote(updated);
        if (!stay) setEditing(false);
      } catch (e) {
        pushError((e as Error).message);
      }
    },
    [path, pushError]
  );

  const applyTag = useCallback(
    (tag: string) => {
      if (!note) return;
      // Tags come from inline #hashtags in the body (or YAML frontmatter) via
      // extractTags() in db.ts — appending an inline tag is the simplest way
      // to add one without risking a mismatched frontmatter rewrite.
      const sep = note.content.endsWith("\n") ? "" : "\n";
      const content = note.content + sep + `#${tag}\n`;
      void save(content, true);
      setSuggestedTags((prev) => prev?.filter((t) => t !== tag) ?? null);
    },
    [note, save]
  );

  const applyLink = useCallback(
    (target: SimilarNote) => {
      if (!note) return;
      const sep = note.content.endsWith("\n") ? "" : "\n";
      const content = note.content + sep + `Links: [[${target.title}]]\n`;
      void save(content, true);
      setSimilar((prev) =>
        prev ? prev.map((s) => (s.path === target.path ? { ...s, linked: true } : s)) : null
      );
    },
    [note, save]
  );

  /* click delegation: wiki-links + checkboxes */
  const onBodyClick = useCallback(
    async (e: React.MouseEvent<HTMLDivElement>) => {
      const t = e.target as HTMLElement;

      const live = t.closest("a.wikilink") as HTMLElement | null;
      if (live?.dataset.path) {
        e.preventDefault();
        openNote(live.dataset.path);
        return;
      }

      const broken = t.closest("a.wikilink-broken") as HTMLElement | null;
      if (broken?.dataset.title) {
        e.preventDefault();
        const title = broken.dataset.title;
        const newPath = title.endsWith(".md") ? title : title + ".md";
        try {
          await api.writeNote(newPath, "# " + title + "\n", "user");
          pendingEditPath = newPath;
          openNote(newPath);
        } catch (err) {
          pushError((err as Error).message);
        }
        return;
      }

      if (t instanceof HTMLInputElement && t.type === "checkbox" && note) {
        const el = bodyRef.current!;
        const all = Array.from(
          el.querySelectorAll<HTMLInputElement>('input[type="checkbox"]')
        );
        const idx = all.indexOf(t);
        if (idx >= 0) {
          const next = toggleTaskLine(note.content, idx);
          if (next !== note.content) {
            setNote({ ...note, content: next }); // optimistic
            void save(next, true);
          }
        }
      }
    },
    [note, openNote, pushError, save]
  );

  const doDelete = useCallback(async () => {
    setShowDelete(false);
    try {
      await api.deleteNote(path);
      const rest = notes.filter((n) => n.path !== path);
      if (rest[0]) openNote(rest[0].path);
      else location.hash = "#/note/";
    } catch (e) {
      pushError((e as Error).message);
    }
  }, [path, notes, openNote, pushError]);

  const createNote = useCallback(
    async (p: string) => {
      setShowNew(false);
      try {
        await api.writeNote(p, "", "user");
        pendingEditPath = p;
        openNote(p);
      } catch (e) {
        pushError((e as Error).message);
      }
    },
    [openNote, pushError]
  );

  const doRename = useCallback(
    async (to: string) => {
      setShowRename(false);
      try {
        await api.renameNote(path, to);
        openNote(to);
      } catch (e) {
        pushError((e as Error).message);
      }
    },
    [path, openNote, pushError]
  );

  /* ---------------------------------------------------------- missing */
  if (missing) {
    return (
      <div className="flex-1 flex flex-col items-center justify-center gap-4 text-center p-8">
        <div className="text-faint text-lg tracking-[.25em]">
          NO DATA IN SECTOR ░░░
        </div>
        <div className="text-muted text-xs" dir="auto">
          {path}
        </div>
        {notesLoaded && (
          <button
            className="border border-neon-dim text-neon px-6 h-9 text-xs hover:bg-neon/10 tracking-[.15em]"
            onClick={() => createNote(path)}
          >
            + MATERIALIZE SECTOR
          </button>
        )}
      </div>
    );
  }

  if (!note) {
    return (
      <div className="flex-1 flex items-center justify-center text-faint text-xs tracking-[.3em]">
        ACCESSING MEMORY ░ ░ ░
      </div>
    );
  }

  const backlinkNotes = note.backlinks.map((p) => ({
    path: p,
    title: resolveNote(p)?.title ?? p.replace(/\.md$/i, "").split("/").pop()!,
  }));

  return (
    <div className="flex-1 flex flex-col min-h-0">
      {/* header */}
      <div className="shrink-0 px-6 pt-5 pb-4 border-b border-line">
        <div className="flex items-start gap-4">
          <div className="flex-1 min-w-0">
            <h1 className="text-neon glow text-xl font-bold truncate" dir="auto">
              {note.title}
            </h1>
            <div className="mt-1 flex items-center gap-3 text-[10px] text-muted tracking-[.1em] flex-wrap">
              <span className="truncate">{note.path}</span>
              <span className="text-faint">MOD {fmtTime(note.mtime)}</span>
              {note.tags.map((tag) => (
                <span
                  key={tag}
                  className="border border-line-hi/60 text-neon-dim px-1.5 leading-4"
                  dir="auto"
                >
                  #{tag}
                </span>
              ))}
            </div>
          </div>
          {!editing && (
            <div className="flex gap-2 shrink-0">
              <button
                disabled={tagsLoading}
                className="border border-line text-ink px-3 h-7 text-[11px] tracking-[.1em] hover:border-violet/60 hover:text-violet disabled:opacity-40"
                onClick={() => void askAiTags()}
                title="Suggest tags with the local AI model"
              >
                {tagsLoading ? "…" : "✨ AI TAGS"}
              </button>
              <button
                className="border border-line text-ink px-3 h-7 text-[11px] tracking-[.1em] hover:border-neon-dim hover:text-neon"
                onClick={() => setEditing(true)}
              >
                EDIT
              </button>
              <button
                className="border border-line text-ink px-3 h-7 text-[11px] tracking-[.1em] hover:border-amber/60 hover:text-amber"
                onClick={() => setShowRename(true)}
              >
                RENAME
              </button>
              <button
                className="border border-line text-ink px-3 h-7 text-[11px] tracking-[.1em] hover:border-cyan/60 hover:text-cyan"
                onClick={() => setShowNew(true)}
              >
                NEW
              </button>
              <button
                className="border border-line text-muted px-3 h-7 text-[11px] tracking-[.1em] hover:border-red/60 hover:text-red"
                onClick={() => setShowDelete(true)}
              >
                DELETE
              </button>
            </div>
          )}
        </div>
        {suggestedTags && suggestedTags.length > 0 && (
          <div className="mt-3 flex items-center gap-2 flex-wrap">
            <span className="text-[10px] text-faint tracking-[.15em]">✨ SUGGESTED —</span>
            {suggestedTags.map((tag) => (
              <button
                key={tag}
                onClick={() => applyTag(tag)}
                className="border border-violet/50 text-violet px-2 h-6 text-[11px] hover:bg-violet/10"
                dir="auto"
              >
                +#{tag}
              </button>
            ))}
            <button
              onClick={() => setSuggestedTags(null)}
              className="text-[10px] text-muted hover:text-ink"
            >
              ✕
            </button>
          </div>
        )}
        {suggestedTags && suggestedTags.length === 0 && (
          <div className="mt-3 text-[10px] text-faint tracking-[.1em]">
            No new tags suggested — the important ones are already there.
          </div>
        )}
      </div>

      {/* body */}
      {editing ? (
        <div className="flex-1 flex flex-col min-h-0 pt-2">
          <Editor
            key={note.path + ":" + note.mtime}
            initial={note.content}
            onSave={(c) => void save(c)}
            onCancel={() => setEditing(false)}
          />
        </div>
      ) : (
        <div className="flex-1 overflow-y-auto min-h-0">
          <div
            ref={bodyRef}
            className="prose-fui max-w-3xl px-6 py-6 text-[13px]"
            onClick={onBodyClick}
            dangerouslySetInnerHTML={{ __html: html }}
          />
          {note.content.trim() === "" && (
            <div className="px-6 text-faint text-xs tracking-[.2em]">
              EMPTY SECTOR — PRESS EDIT TO WRITE ░░░
            </div>
          )}
          {backlinkNotes.length > 0 && (
            <div className="max-w-3xl mx-0 px-6 pb-8">
              <div className="border-t border-line pt-4 mt-4">
                <div className="text-[10px] tracking-[.2em] text-muted mb-2">
                  ◂ LINKED FROM
                </div>
                <div className="flex flex-wrap gap-2">
                  {backlinkNotes.map((b) => (
                    <button
                      key={b.path}
                      className="border border-line bg-panel px-2.5 h-7 text-[11px] text-ink hover:border-neon-dim hover:text-neon"
                      onClick={() => openNote(b.path)}
                      title={b.path}
                      dir="auto"
                    >
                      {b.title}
                    </button>
                  ))}
                </div>
              </div>
            </div>
          )}
          {/* Meaning-based neighbours, from the on-device embedding index.
              Unlinked ones are the actionable part: a missing [[link]]. */}
          {similar && similar.length > 0 && (
            <div className="max-w-3xl mx-0 px-6 pb-8">
              <div className="border-t border-line pt-4">
                <div className="text-[10px] tracking-[.2em] text-muted mb-2">
                  ≈ RELATED BY MEANING
                </div>
                <div className="flex flex-wrap gap-2">
                  {similar.map((r) =>
                    r.linked ? (
                      <button
                        key={r.path}
                        className="border border-line bg-panel px-2.5 h-7 text-[11px] text-muted hover:border-neon-dim hover:text-neon"
                        onClick={() => openNote(r.path)}
                        title={`${r.path} — ${(r.score * 100).toFixed(0)}% (linked)`}
                        dir="auto"
                      >
                        {r.title}
                      </button>
                    ) : (
                      <div
                        key={r.path}
                        className="inline-flex items-stretch border border-violet/50 bg-panel text-[11px] text-violet"
                        title={`${r.path} — ${(r.score * 100).toFixed(0)}% (not linked yet)`}
                      >
                        <button
                          className="px-2.5 h-7 hover:bg-violet/10 hover:text-neon flex items-center"
                          onClick={() => openNote(r.path)}
                          dir="auto"
                        >
                          {r.title}
                        </button>
                        <button
                          className="border-s border-violet/30 px-2 h-7 hover:bg-violet/20 hover:text-neon flex items-center justify-center font-bold text-xs"
                          onClick={(e) => {
                            e.stopPropagation();
                            applyLink(r);
                          }}
                          title={`Links: [[${r.title}]]`}
                        >
                          +
                        </button>
                      </div>
                    )
                  )}
                </div>
              </div>
            </div>
          )}
        </div>
      )}

      {showDelete && (
        <ConfirmModal
          title="PURGE SECTOR"
          danger
          confirmLabel="PURGE"
          message={
            <>
              Erase <span className="text-red">{note.path}</span> from the memory
              core? Wiki-links pointing here will break.
            </>
          }
          onConfirm={() => void doDelete()}
          onCancel={() => setShowDelete(false)}
        />
      )}
      {showNew && (
        <NewNoteModal onCreate={createNote} onClose={() => setShowNew(false)} />
      )}
      {showRename && (
        <RenameModal current={path} onRename={(to) => void doRename(to)} onClose={() => setShowRename(false)} />
      )}
    </div>
  );
}
