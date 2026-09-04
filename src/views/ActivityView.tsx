/* Live terminal activity log with agent filters and auto-stick scrolling. */

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { agentTextClass, api, type ActivityRow } from "../lib/api";
import { useStore } from "../lib/store";

const FILTERS = ["ALL", "claude", "chatgpt", "user", "system"];

function tsClock(iso: string): string {
  const d = new Date(iso);
  if (isNaN(d.getTime())) return "--:--:--";
  const p = (n: number) => String(n).padStart(2, "0");
  return `${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}`;
}

export default function ActivityView() {
  const { activityTick, notes, openNote, pushError } = useStore();
  const [rows, setRows] = useState<ActivityRow[]>([]);
  const [loaded, setLoaded] = useState(false);
  const [filter, setFilter] = useState("ALL");
  const scrollRef = useRef<HTMLDivElement>(null);
  const stickRef = useRef(true);

  const notePaths = useMemo(() => new Set(notes.map((n) => n.path)), [notes]);

  const refresh = useCallback(async () => {
    try {
      const list = await api.activity(200);
      setRows(list.slice().reverse()); // oldest → newest for terminal flow
      setLoaded(true);
    } catch (e) {
      pushError((e as Error).message);
    }
  }, [pushError]);

  useEffect(() => {
    void refresh();
  }, [refresh, activityTick]);

  /* auto-stick to bottom unless the user scrolled up */
  useEffect(() => {
    const el = scrollRef.current;
    if (el && stickRef.current) el.scrollTop = el.scrollHeight;
  }, [rows, filter]);

  const onScroll = () => {
    const el = scrollRef.current;
    if (!el) return;
    stickRef.current = el.scrollHeight - el.scrollTop - el.clientHeight < 40;
  };

  const visible = useMemo(
    () =>
      filter === "ALL"
        ? rows
        : rows.filter((r) => {
            const a = (r.agent || "").toLowerCase();
            return filter === "system"
              ? !["claude", "chatgpt", "user"].includes(a)
              : a === filter;
          }),
    [rows, filter]
  );

  return (
    <div className="flex-1 min-h-0 flex flex-col">
      <div className="shrink-0 px-6 pt-5 pb-3 flex items-center gap-3 flex-wrap">
        <h1 className="text-neon glow text-lg font-bold tracking-[.1em]">
          ACTIVITY BUS
        </h1>
        <span className="flex-1" />
        {FILTERS.map((f) => (
          <button
            key={f}
            onClick={() => setFilter(f)}
            className={
              "text-[10px] tracking-[.15em] px-2 h-6 border uppercase " +
              (filter === f
                ? "border-neon-dim text-neon bg-neon/5"
                : "border-line text-muted hover:text-ink hover:border-line-hi")
            }
          >
            {f === "ALL" ? "ALL" : "@" + f}
          </button>
        ))}
      </div>

      <div
        ref={scrollRef}
        onScroll={onScroll}
        className="flex-1 min-h-0 overflow-y-auto mx-6 mb-6 border border-line bg-bg2/70 p-3 font-mono text-[11.5px] leading-6"
      >
        {loaded && visible.length === 0 && (
          <div className="text-faint tracking-[.25em] text-center pt-10">
            NO DATA IN SECTOR ░░░
          </div>
        )}
        {visible.map((r, i) => {
          const agent = (r.agent || "system").toLowerCase();
          const pathLive = r.path && notePaths.has(r.path);
          return (
            <div key={i} className="whitespace-nowrap overflow-hidden text-ellipsis">
              <span className="text-faint">[{tsClock(r.ts)}]</span>{" "}
              <span className={agentTextClass(agent) + " inline-block w-[76px]"}>
                {agent.toUpperCase().slice(0, 8).padEnd(8, "─")}
              </span>
              <span className="text-ink">{r.action}</span>
              {r.path &&
                (pathLive ? (
                  <button
                    className="text-cyan hover:glow-cyan underline decoration-cyan/40 underline-offset-2 ml-2"
                    onClick={() => openNote(r.path!)}
                    dir="ltr"
                  >
                    {r.path}
                  </button>
                ) : (
                  <span className="text-muted ml-2" dir="ltr">
                    {r.path}
                  </span>
                ))}
              {r.detail && (
                <span className="text-muted ml-2" dir="auto">
                  {r.detail}
                </span>
              )}
            </div>
          );
        })}
        {visible.length > 0 && (
          <div className="text-neon-dim">
            <span className="blink">▊</span>
          </div>
        )}
      </div>
    </div>
  );
}
