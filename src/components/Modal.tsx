/* Styled confirm/dialog modal — never window.confirm. Esc closes. */

import { useEffect, type ReactNode } from "react";

export function Modal({
  title,
  children,
  onClose,
}: {
  title: string;
  children: ReactNode;
  onClose: () => void;
}) {
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        e.stopPropagation();
        onClose();
      }
    };
    window.addEventListener("keydown", onKey, true);
    return () => window.removeEventListener("keydown", onKey, true);
  }, [onClose]);

  return (
    <div
      className="fixed inset-0 z-[55] flex items-center justify-center bg-black/70"
      onMouseDown={(e) => {
        if (e.target === e.currentTarget) onClose();
      }}
    >
      <div className="modal-in w-fit min-w-[min(420px,92vw)] max-w-[92vw] max-h-[85vh] flex flex-col overflow-hidden border border-line-hi bg-panel shadow-[0_0_40px_rgba(0,255,102,0.08)]">
        <div className="flex items-center justify-between border-b border-line px-4 h-10 shrink-0">
          <span className="text-neon glow text-xs tracking-[.15em] uppercase">
            ▸ {title}
          </span>
          <button
            className="text-muted hover:text-red text-xs px-1"
            onClick={onClose}
          >
            [ESC]
          </button>
        </div>
        <div className="p-4 overflow-y-auto">{children}</div>
      </div>
    </div>
  );
}

export function ConfirmModal({
  title,
  message,
  confirmLabel = "CONFIRM",
  danger = false,
  onConfirm,
  onCancel,
}: {
  title: string;
  message: ReactNode;
  confirmLabel?: string;
  danger?: boolean;
  onConfirm: () => void;
  onCancel: () => void;
}) {
  return (
    <Modal title={title} onClose={onCancel}>
      <div className="text-ink text-xs leading-6 mb-4" dir="auto">
        {message}
      </div>
      <div className="flex justify-end gap-2">
        <button
          className="border border-line px-4 h-8 text-xs text-muted hover:text-ink hover:border-line-hi"
          onClick={onCancel}
        >
          CANCEL
        </button>
        <button
          autoFocus
          className={
            "border px-4 h-8 text-xs " +
            (danger
              ? "border-red/60 text-red hover:bg-red/10"
              : "border-neon-dim text-neon hover:bg-neon/10")
          }
          onClick={onConfirm}
        >
          {confirmLabel}
        </button>
      </div>
    </Modal>
  );
}
