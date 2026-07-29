"use client";

import { useEffect, useRef, useState, useTransition } from "react";
import { createPortal } from "react-dom";
import { applyTargetedDocCorrectionAction } from "@/lib/actions";
import { Icon } from "@/components/icon";
import { Button, Textarea } from "@/components/ui";

export function CorrectInfoModal({
  documentId,
  docLabel,
  correctionPricing,
  open,
  onClose,
  onSuccess,
}: {
  documentId: string;
  docLabel: string;
  /**
   * What this correction will cost the viewer, resolved on the server. Present
   * only when the viewer is actually billable — staff and admins in "View as
   * Client" pass nothing and see no price, because they are not charged.
   * `blockReason` is the server's own refusal line (creditBlockReason) when the
   * cost does not fit, so this modal names the same limit the charge would.
   */
  correctionPricing?: { cost: number; blockReason?: string };
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

  // Credits won't cover it — the server would refuse the charge before the model
  // runs, so don't let the client spend a keystroke on the attempt.
  const shortfall = correctionPricing?.blockReason != null;

  function handleSubmit() {
    const trimmed = corrections.trim();
    if (!trimmed || pending || shortfall) return;
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
              'e.g. "Our pricing is $49/mo, not $99/mo" or\n"Our head office is in Tel Aviv, not London"'
            }
            rows={5}
            disabled={pending}
            className="resize-none"
          />
          {/* The charge happens before the model call, so a client used to learn
              the price only by watching the rail drop by 2 — or, if they were
              short, by a red error after committing. Every other billable action
              states its cost up front ("Costs N credits." on the run dialog);
              this surface was the one that stayed silent. */}
          <p className="text-[11px] text-muted-2">
            Be specific. Only the facts you name will change. Everything else stays identical.
            Tip: {"⌘"}Enter to submit.
            {correctionPricing && (
              <span className="ml-1 text-muted">Costs {correctionPricing.cost} credits.</span>
            )}
          </p>

          {shortfall && (
            <div className="flex items-start gap-2 rounded-lg border border-warning/30 bg-warning/10 px-3 py-2.5">
              <Icon name="Lock" className="mt-0.5 h-4 w-4 shrink-0 text-warning" />
              <p className="text-sm text-muted">{correctionPricing?.blockReason}</p>
            </div>
          )}

          {error && (
            <div className="flex items-start gap-2 rounded-lg border border-danger/30 bg-danger/10 px-3 py-2.5">
              <Icon name="CircleAlert" className="mt-0.5 h-4 w-4 shrink-0 text-danger" />
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
            disabled={!corrections.trim() || pending || shortfall}
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
