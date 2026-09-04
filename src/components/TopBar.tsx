/* Top chrome bar: brand, sync indicator, note count, live clock. */

import { useEffect, useRef, useState } from "react";
import { useStore } from "../lib/store";
import { projectTitle } from "../lib/api";

function useClock(): string {
  const [now, setNow] = useState(() => new Date());
  useEffect(() => {
    const t = setInterval(() => setNow(new Date()), 1000);
    return () => clearInterval(t);
  }, []);
  const p = (n: number) => String(n).padStart(2, "0");
  return `${p(now.getHours())}:${p(now.getMinutes())}:${p(now.getSeconds())}`;
}

export default function TopBar() {
  const { notes, syncTick, online, activeProject } = useStore();
  const clock = useClock();
  const [pulse, setPulse] = useState(false);
  const firstRef = useRef(true);

  useEffect(() => {
    if (firstRef.current) {
      firstRef.current = false;
      return;
    }
    setPulse(true);
    const t = setTimeout(() => setPulse(false), 850);
    return () => clearTimeout(t);
  }, [syncTick]);

  const mem = String(notes.length).padStart(3, "0");

  return (
    <header className="h-12 shrink-0 border-b border-line bg-panel/60 flex items-center justify-between px-4 select-none">
      <div className="flex items-baseline gap-4 min-w-0">
        <span className="text-neon glow text-sm font-bold tracking-wide whitespace-nowrap">
          ▓▒░ CORTEX_<span className="blink">▊</span>
        </span>
        <span className="text-[10px] tracking-[.2em] text-muted uppercase hidden sm:inline whitespace-nowrap">
          SHARED AI MEMORY
        </span>
        <span className="text-[10px] tracking-[.2em] text-cyan uppercase hidden sm:inline whitespace-nowrap">
          {activeProject === "__all__" ? "ALL PROJECTS" : activeProject === "__none__" ? "NO PROJECT" : projectTitle(activeProject)}
        </span>
      </div>
      <div className="flex items-center gap-6 text-xs whitespace-nowrap">
        <span className="flex items-center gap-2" title={online ? "link up" : "link down"}>
          <span
            className={
              "inline-block w-2 h-2 rounded-full " +
              (online ? "bg-neon-dim " : "bg-red ") +
              (pulse ? "sync-pulse" : "")
            }
          />
          <span className={"tracking-[.15em] " + (online ? "text-muted" : "text-red")}>
            {online ? "SYNC" : "LINK↓"}
          </span>
        </span>
        <span className="text-muted tracking-[.1em]">
          MEM <span className="text-ink">{mem}</span>
        </span>
        <span className="text-cyan glow-cyan tracking-[.1em] tabular-nums">{clock}</span>
      </div>
    </header>
  );
}
