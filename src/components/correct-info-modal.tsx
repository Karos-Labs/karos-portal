"use client";

import { useEffect, useRef, useState, useTransition } from "react";
import { applyTargetedDocCorrectionAction } from "@/lib/actions";
import { Icon } from "@/components/icon";
import { Modal } from "@/components/modal";
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
   * only when the viewer is actually billable - staff and admins in "View as
   * Client" pass nothing and see no price, because they are not charged.
   * `blockReason` is the server's own refusal line (creditBlockReason) when the
   * cost does not fit, so this modal names the same limit the charge would.
   */
  correctionPricing?: { cost: number; blockReason?: string };
  open: boolean;
  onClose: () => void;
  /**
   * Called with the correction the client actually typed (flow audit 2026-09,
   * R13). The caller keeps the document open and shows what was asked for; the
   * action itself returns no diff, so this text is the most specific true thing
   * there is to put on screen.
   */
  onSuccess: (correction: string) => void;
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

  // Credits won't cover it - the server would refuse the charge before the model
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
        onSuccess(trimmed);
      } catch (e) {
        setError(e instanceof Error ? e.message : "Failed to apply correction. Please try again.");
      }
    });
  }

  /**
   * Escape and a backdrop click are ignored while the correction is in flight
   * — the charge and the model call have already been committed, so dismissing
   * the dialog would only hide the outcome. A no-op `onClose` is how that is
   * expressed to the shared shell, which owns both gestures.
   */
  const close = pending ? () => {} : onClose;

  return (
    /* THE SHARED DIALOG SHELL (flow audit 2026-09, R13 follow-up).
       This was a hand-rolled portal: a fixed backdrop and a panel, with no
       `role="dialog"`, no `aria-modal`, no focus trap and no scroll lock. It
       got away with it while it was stacked on DocOverlay, which locked the
       body itself and was the layer keyboard focus was already confined to.
       Turning the document reader into an ordinary panel took all three of
       those away, and this dialog is now the only overlay in the flow — so it
       goes through components/modal.tsx, which provides them, rather than
       re-implementing them here. */
    <Modal
      open={open}
      onClose={close}
      title="Correct information"
      description={`Only the ${docLabel} document will be updated.`}
      closeOnBackdrop={!pending}
      footer={
        <div className="flex items-center justify-end gap-3">
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
      }
    >
      <div className="space-y-3">
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
            the price only by watching the rail drop by 2 - or, if they were
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
          <div
            role="status"
            className="flex items-center gap-2 rounded-lg border border-neon/20 bg-neon/5 px-3 py-2.5"
          >
            <Icon name="Loader" className="h-4 w-4 shrink-0 animate-spin text-neon" />
            <p className="text-sm text-muted">Applying correction to {docLabel}…</p>
          </div>
        )}
      </div>
    </Modal>
  );
}
