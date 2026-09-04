/* Global store: notes cache, status, hash route, SSE live-refresh, errors. */

import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from "react";
import { API, api, isProjectPath, type NoteMeta, type Status } from "./api";

/* ------------------------------------------------------------- routing */

export type Route =
  | { view: "note"; path: string | null }
  | { view: "graph" }
  | { view: "tasks" }
  | { view: "activity" }
  | { view: "protocol" }
  | { view: "connect" }
  | { view: "librarian" };

export function parseHash(hash: string): Route {
  const h = hash.replace(/^#\/?/, "");
  if (h.startsWith("note/")) {
    return { view: "note", path: decodeURIComponent(h.slice(5)) };
  }
  if (h === "graph") return { view: "graph" };
  if (h === "tasks") return { view: "tasks" };
  if (h === "activity") return { view: "activity" };
  if (h === "protocol") return { view: "protocol" };
  if (h === "connect") return { view: "connect" };
  if (h === "orchestrator") return { view: "tasks" };
  if (h === "librarian") return { view: "librarian" };
  return { view: "note", path: null };
}

export function noteHash(path: string): string {
  return "#/note/" + encodeURIComponent(path);
}

/* --------------------------------------------------------------- store */

interface StoreShape {
  notes: NoteMeta[];
  notesLoaded: boolean;
  status: Status | null;
  route: Route;
  navigate: (hash: string) => void;
  openNote: (path: string) => void;
  refreshNotes: () => Promise<void>;
  refreshStatus: () => Promise<void>;
  /* change counters — views subscribe via useEffect deps */
  vaultTick: number;
  tasksTick: number;
  activityTick: number;
  protocolTick: number;
  orchTick: number;
  syncTick: number;
  online: boolean;
  errors: string[];
  pushError: (msg: string) => void;
  dismissError: (i: number) => void;
  resolveNote: (target: string) => NoteMeta | null;
  activeProject: string;
  setActiveProject: (p: string) => void;
}

const StoreCtx = createContext<StoreShape | null>(null);

export function useStore(): StoreShape {
  const ctx = useContext(StoreCtx);
  if (!ctx) throw new Error("useStore outside provider");
  return ctx;
}

export function StoreProvider({ children }: { children: ReactNode }) {
  const [notes, setNotes] = useState<NoteMeta[]>([]);
  const [notesLoaded, setNotesLoaded] = useState(false);
  const [status, setStatus] = useState<Status | null>(null);
  const [route, setRoute] = useState<Route>(() => parseHash(location.hash));
  const [vaultTick, setVaultTick] = useState(0);
  const [tasksTick, setTasksTick] = useState(0);
  const [activityTick, setActivityTick] = useState(0);
  const [protocolTick, setProtocolTick] = useState(0);
  const [orchTick, setOrchTick] = useState(0);
  const [syncTick, setSyncTick] = useState(0);
  const [online, setOnline] = useState(true);
  const [errors, setErrors] = useState<string[]>([]);
  const [activeProject, setActiveProject] = useState<string>("__all__");

  const [settingsLoaded, setSettingsLoaded] = useState(false);
  useEffect(() => {
    if (!notesLoaded || settingsLoaded) return;
    api.settings().then(s => {
      if (s.active_project && notes.some(n => n.path === s.active_project)) {
        setActiveProject(s.active_project);
      } else {
        setActiveProject("__all__");
      }
      setSettingsLoaded(true);
    }).catch(() => { setSettingsLoaded(true); });
  }, [notes, notesLoaded, settingsLoaded]);


  const pushError = useCallback((msg: string) => {
    setErrors((prev) => (prev.includes(msg) ? prev : [...prev, msg]).slice(-4));
  }, []);

  const dismissError = useCallback((i: number) => {
    setErrors((prev) => prev.filter((_, idx) => idx !== i));
  }, []);

  const refreshNotes = useCallback(async () => {
    try {
      const list = await api.listNotes();
      setNotes(list);
      setNotesLoaded(true);
      setOnline(true);
    } catch (e) {
      setOnline(false);
      pushError((e as Error).message);
    }
  }, [pushError]);

  const refreshStatus = useCallback(async () => {
    try {
      setStatus(await api.status());
      setOnline(true);
    } catch (e) {
      setOnline(false);
      pushError((e as Error).message);
    }
  }, [pushError]);

  /* initial load */
  useEffect(() => {
    void refreshNotes();
    void refreshStatus();
  }, [refreshNotes, refreshStatus]);

  /* hash routing */
  useEffect(() => {
    const onHash = () => setRoute(parseHash(location.hash));
    window.addEventListener("hashchange", onHash);
    return () => window.removeEventListener("hashchange", onHash);
  }, []);


  /* default route: Welcome.md, else first note */
  useEffect(() => {
    if (!notesLoaded) return;
    if (route.view === "note" && route.path === null) {
      const welcome = notes.find(
        (n) => n.path.split("/").pop()!.toLowerCase() === "welcome.md"
      );
      const target = welcome ?? notes.find((n) => !isProjectPath(n.path)) ?? notes[0];
      if (target) {
        location.hash = noteHash(target.path);
      }
    }
  }, [notesLoaded, notes, route]);

  const navigate = useCallback((hash: string) => {
    if (location.hash === hash) {
      // re-set to force route recompute even for same hash
      setRoute(parseHash(hash));
    } else {
      location.hash = hash;
    }
  }, []);

  const openNote = useCallback(
    (path: string) => navigate(noteHash(path)),
    [navigate]
  );

  /* --------------------------------------------------------------- SSE */
  const timersRef = useRef<Record<string, ReturnType<typeof setTimeout>>>({});
  useEffect(() => {
    const es = new EventSource(API + "/api/events");
    const timers = timersRef.current;

    const schedule = (type: string, fn: () => void) => {
      clearTimeout(timers[type]);
      timers[type] = setTimeout(fn, 300);
    };

    es.addEventListener("change", (ev) => {
      setOnline(true);
      setSyncTick((t) => t + 1);
      let type = "vault";
      try {
        type = (JSON.parse((ev as MessageEvent).data) as { type?: string }).type ?? "vault";
      } catch {
        /* keep default */
      }
      if (type === "vault") {
        schedule("vault", () => {
          void refreshNotes();
          setVaultTick((t) => t + 1);
        });
      } else if (type === "tasks") {
        schedule("tasks", () => setTasksTick((t) => t + 1));
      } else if (type === "activity") {
        schedule("activity", () => setActivityTick((t) => t + 1));
      } else if (type === "protocol") {
        schedule("protocol", () => setProtocolTick((t) => t + 1));
      } else if (type === "orchestrator") {
        schedule("orchestrator", () => setOrchTick((t) => t + 1));
      }
    });
    es.onopen = () => setOnline(true);
    es.onerror = () => setOnline(false);

    return () => {
      es.close();
      Object.values(timers).forEach(clearTimeout);
    };
  }, [refreshNotes]);

  /* ------------------------------------------------- wiki-link resolver */
  const resolveNote = useCallback(
    (target: string): NoteMeta | null => {
      const t = target.trim();
      const tLower = t.toLowerCase();
      const tMd = tLower.endsWith(".md") ? tLower : tLower + ".md";
      // exact path (with or without .md)
      for (const n of notes) {
        const p = n.path.toLowerCase();
        if (p === tLower || p === tMd) return n;
      }
      // case-insensitive title
      for (const n of notes) {
        if (n.title.toLowerCase() === tLower) return n;
      }
      // case-insensitive filename
      for (const n of notes) {
        const file = n.path.split("/").pop()!.toLowerCase();
        if (file === tMd || file === tLower) return n;
      }
      return null;
    },
    [notes]
  );

  const setProject = useCallback((p: string) => {
    setActiveProject(p);
    void api.saveSettings({ active_project: p }).catch(() => {});
  }, []);

  const value = useMemo<StoreShape>(
    () => ({
      notes,
      notesLoaded,
      status,
      route,
      navigate,
      openNote,
      refreshNotes,
      refreshStatus,
      vaultTick,
      tasksTick,
      activityTick,
      protocolTick,
      orchTick,
      syncTick,
      online,
      errors,
      pushError,
      dismissError,
      resolveNote,
      activeProject,
      setActiveProject: setProject
    }),
    [
      notes,
      notesLoaded,
      status,
      route,
      navigate,
      openNote,
      refreshNotes,
      refreshStatus,
      vaultTick,
      tasksTick,
      activityTick,
      protocolTick,
      orchTick,
      syncTick,
      online,
      errors,
      pushError,
      dismissError,
      resolveNote,
      activeProject,
      setProject,
    ]
  );

  return <StoreCtx.Provider value={value}>{children}</StoreCtx.Provider>;
}
