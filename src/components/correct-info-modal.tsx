"use client";

import { useEffect, useRef, useState, useTransition } from "react";
import { createPortal } from "react-dom";
import { applyTargetedDocCorrectionAction } from "@/lib/actions";
import { Icon } from "@/components/icon";
import { Button, Textarea } from "@/components/ui";

export function CorrectInfoModal({
  documentId,
  docLabel,
  open,
  onClose,
  onSuccess,
}: {
  documentId: string;
  docLabel: string;
  open: boolean;
  onClose: () => void;
  onSuccess: () => void;
}) {
  const [corrections, setCorrections] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [pending, startTransition] = useTransition();
  const textareaRef = useRef<HTMLTextAreaElement>(null);

  useEffect(() => {
    if (open) {
      const t = setTimeout(() => textareaRef.current?.focus(), 60);
      return () => clearTimeout(t);
    } else {
      // eslint-disable-next-line react-hooks/set-state-in-effect
      setCorrections("");
      setError(null);
    }
  }, [open]);

  useEffect(() => {
    if (!open) return;
    function onKey(e: KeyboardEvent) {
      if (e.key === "Escape" && !pending) onClose();
    }
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [open, pending, onClose]);

  function handleSubmit() {
    const trimmed = corrections.trim();
    if (!trimmed || pending) return;
    setError(null);
    startTransition(async () => {
      try {
        const res = await applyTargetedDocCorrectionAction(documentId, trimmed);
        if (res.error) {
          setError(res.error);
          return;
        }
        onSuccess();
      } catch (e) {
        setError(e instanceof Error ? e.message : "Failed to apply correction. Please try again.");
      }
    });
  }

  if (!open) return null;

  return createPortal(
    <div
      className="fixed inset-0 z-[20000] flex items-center justify-center p-4"
      style={{ background: "rgba(0,0,0,0.72)", backdropFilter: "blur(4px)" }}
      onClick={(e) => {
        if (e.target === e.currentTarget && !pending) onClose();
      }}
    >
      <div className="w-full max-w-lg rounded-xl border border-border bg-surface shadow-2xl">
        {/* Header */}
        <div className="flex items-start justify-between gap-3 border-b border-border px-5 py-4">
          <div>
            <p className="font-semibold text-foreground">Correct Information</p>
            <p className="mt-0.5 text-xs text-muted">
              Only the <span className="font-medium text-foreground">{docLabel}</span> document will be updated.
            </p>
          </div>
          <button
            onClick={onClose}
            disabled={pending}
            className="mt-0.5 flex h-7 w-7 shrink-0 items-center justify-center rounded-lg text-muted transition-colors hover:bg-surface-2 hover:text-foreground disabled:pointer-events-none"
            aria-label="Close"
          >
            <Icon name="X" className="h-3.5 w-3.5" />
          </button>
        </div>

        {/* Body */}
        <div className="space-y-3 p-5">
          <label className="block text-sm font-medium text-foreground">
            What needs to be corrected?
          </label>
          <Textarea
            ref={textareaRef}
            value={corrections}
            onChange={(e) => setCorrections(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) handleSubmit();
            }}
            placeholder={
              'e.g. "Our pricing is $49/mo, not $99/mo" or\n"The founder\'s name is Tomer, not John"'
            }
            rows={5}
            disabled={pending}
            className="resize-none"
          />
          <p className="text-[11px] text-muted-2">
            Be specific. Only the facts you name will change. Everything else stays identical.
            Tip: {"⌘"}Enter to submit.
          </p>

          {error && (
            <div className="flex items-start gap-2 rounded-lg border border-danger/30 bg-danger/10 px-3 py-2.5">
              <Icon name="AlertCircle" className="mt-0.5 h-4 w-4 shrink-0 text-danger" />
              <p className="text-sm text-danger">{error}</p>
            </div>
          )}

          {pending && (
            <div className="flex items-center gap-2 rounded-lg border border-neon/20 bg-neon/5 px-3 py-2.5">
              <Icon name="Loader" className="h-4 w-4 shrink-0 animate-spin text-neon" />
              <p className="text-sm text-muted">
                Applying correction to {docLabel}…
              </p>
            </div>
          )}
        </div>

        {/* Footer */}
        <div className="flex items-center justify-end gap-3 border-t border-border px-5 py-4">
          <Button variant="ghost" size="sm" onClick={onClose} disabled={pending}>
            Cancel
          </Button>
          <Button
            size="sm"
            onClick={handleSubmit}
            disabled={!corrections.trim() || pending}
            loading={pending}
          >
            {pending ? "Applying…" : "Apply Correction"}
          </Button>
        </div>
      </div>
    </div>,
    document.body,
  );
}
