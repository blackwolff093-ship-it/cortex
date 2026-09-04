/* Dismissible red error banners at the top of the main area. */

import { useStore } from "../lib/store";

export default function ErrorBanners() {
  const { errors, dismissError } = useStore();
  if (errors.length === 0) return null;
  return (
    <div className="shrink-0 px-4 pt-3 space-y-2">
      {errors.map((msg, i) => (
        <div
          key={msg + i}
          className="flex items-start gap-3 border border-red/60 bg-red/5 px-3 py-2 text-xs"
        >
          <span className="text-red shrink-0 tracking-[.15em]">⚠ FAULT</span>
          <span className="text-ink/90 flex-1 break-words" dir="auto">
            {msg}
          </span>
          <button
            className="text-muted hover:text-red shrink-0"
            onClick={() => dismissError(i)}
            title="dismiss"
          >
            [x]
          </button>
        </div>
      ))}
    </div>
  );
}
