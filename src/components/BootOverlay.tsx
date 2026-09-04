/* One-time-per-session terminal boot sequence. Click to skip. */

import { useEffect, useRef, useState } from "react";

const LINES = [
  "CORTEX MAINFRAME v1.0 — SHARED AI MEMORY",
  "MOUNTING MEMORY CORE ............ OK",
  "INDEXING VAULT SECTORS .......... OK",
  "LINK: CLAUDE / CHATGPT . OK",
  "MCP ENDPOINT :7777/mcp .......... LIVE",
  "SYNC BUS (SSE) .................. LIVE",
  "ACCESS LEVEL: OPERATOR",
  "> WELCOME, OPERATOR_",
];

const STEP_MS = 230; // 8 lines ≈ 1.85s

export default function BootOverlay() {
  const [done, setDone] = useState<boolean>(
    () => sessionStorage.getItem("cortex-booted") === "1"
  );
  const [shown, setShown] = useState(0);
  const [exiting, setExiting] = useState(false);
  const exitTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(() => {
    if (done || exiting) return;
    if (shown >= LINES.length) {
      finish();
      return;
    }
    const t = setTimeout(() => setShown((s) => s + 1), STEP_MS);
    return () => clearTimeout(t);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [shown, done, exiting]);

  function finish() {
    sessionStorage.setItem("cortex-booted", "1");
    setExiting(true);
    exitTimer.current = setTimeout(() => setDone(true), 500);
  }

  useEffect(
    () => () => {
      if (exitTimer.current) clearTimeout(exitTimer.current);
    },
    []
  );

  if (done) return null;

  return (
    <div
      className={
        "fixed inset-0 z-[60] flex items-center justify-center bg-bg cursor-pointer select-none " +
        (exiting ? "boot-exit" : "")
      }
      onClick={finish}
      title="click to skip"
    >
      <div className="w-[440px] max-w-[90vw]">
        <div className="border border-line bg-panel p-6">
          <div className="text-neon glow text-sm mb-4 tracking-[.15em]">
            ▓▒░ CORTEX_BOOT
          </div>
          <div className="space-y-1 text-xs leading-5 min-h-[160px]">
            {LINES.slice(0, shown).map((l, i) => (
              <div
                key={i}
                className={
                  "boot-line whitespace-pre " +
                  (l.startsWith(">")
                    ? "text-neon glow"
                    : l.includes("LIVE")
                      ? "text-cyan"
                      : "text-ink")
                }
              >
                {l}
                {i === shown - 1 && !exiting && (
                  <span className="blink text-neon">▊</span>
                )}
              </div>
            ))}
          </div>
          <div className="mt-4 text-[10px] text-faint tracking-[.2em] uppercase">
            [ click anywhere to skip ]
          </div>
        </div>
      </div>
    </div>
  );
}
