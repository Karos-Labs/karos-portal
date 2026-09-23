"use client";

import { useState, useTransition, type ReactNode } from "react";

import { Icon } from "@/components/icon";
import { Button, Spinner } from "@/components/ui";
import { cn } from "@/lib/utils";

/**
 * "Are you sure?" in the product's own voice, instead of the browser's.
 *
 * ## What it replaces
 *
 * Four destructive actions called `window.confirm()`. That dialog cannot be
 * styled, ignores the theme entirely, and — the part that matters most here —
 * renders its buttons in the BROWSER's language while the surface behind it may
 * be in Hebrew. A product that just taught every content field to lay itself
 * out right-to-left should not ask the most consequential question of the
 * session in whatever language Chrome was installed in.
 *
 * It also cannot say WHAT the action does. `confirm()` takes one string, so the
 * question and its consequence had to be crammed into a single line and then
 * read as a system alert rather than as part of the page.
 *
 * ## The shape is the one the product already uses
 *
 * `client-seat-remove.tsx` had arrived at the right pattern independently: the
 * trigger swaps IN PLACE for a small danger block naming the thing, its
 * consequence, and two buttons. Nothing overlays, nothing traps focus, and the
 * row keeps its position — so the reader's eye does not have to re-find where
 * they were. This is that pattern, extracted rather than invented, so the
 * fourth caller does not reinvent it a fourth way.
 *
 * ## Two rules it enforces
 *
 * The confirming button carries the VERB, never "OK" — `confirm()`'s buttons
 * say OK and Cancel, which read identically for "delete this run" and "publish
 * this post". And the error from a failed action lands beside the trigger
 * rather than in another alert, because the second alert is the one nobody
 * reads.
 */
export function ConfirmAction({
  trigger,
  question,
  detail,
  confirmLabel,
  onConfirm,
  className,
}: {
  /** The resting state — usually a button or an icon button. It is given the click handler. */
  trigger: (props: { onClick: () => void; disabled: boolean }) => ReactNode;
  /** "Remove this seat?" — names the specific thing, not the category. */
  question: string;
  /** What actually happens, including what is kept. The half `confirm()` had no room for. */
  detail?: ReactNode;
  /** The verb, never "OK": "Delete run", "Remove seat". */
  confirmLabel: string;
  /** Returns an error message to show, or nothing on success. */
  onConfirm: () => Promise<string | undefined | void>;
  className?: string;
}) {
  const [confirming, setConfirming] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [pending, startTransition] = useTransition();

  if (!confirming) {
    return (
      <div className={cn("space-y-1", className)}>
        {trigger({
          onClick: () => {
            setError(null);
            setConfirming(true);
          },
          disabled: pending,
        })}
        {/* Beside the trigger, not in a second alert: the second alert is the
            one nobody reads, and this one has to survive the block closing. */}
        {error && <p className="text-xs text-danger">{error}</p>}
      </div>
    );
  }

  return (
    <div
      className={cn(
        "flex items-start gap-2 rounded-md border border-danger/40 bg-danger/10 p-3",
        className,
      )}
    >
      <Icon name="TriangleAlert" className="mt-0.5 h-4 w-4 shrink-0 text-danger" aria-hidden="true" />
      <div className="min-w-0 space-y-1.5">
        <p className="text-xs font-medium text-foreground">{question}</p>
        {detail && <p className="text-xs text-muted">{detail}</p>}
        {error && <p className="text-xs text-danger">{error}</p>}
        <div className="flex items-center gap-2 pt-0.5">
          <Button
            variant="danger"
            disabled={pending}
            onClick={() =>
              startTransition(async () => {
                const message = await onConfirm();
                if (message) {
                  setError(message);
                  return;
                }
                // Only on success: a failed action keeps the block open with the
                // reason in it, so the reader is not returned to a trigger that
                // looks untouched.
                setConfirming(false);
              })
            }
          >
            {pending ? <Spinner className="h-4 w-4" /> : confirmLabel}
          </Button>
          <button
            type="button"
            disabled={pending}
            onClick={() => {
              setError(null);
              setConfirming(false);
            }}
            className="text-xs text-muted-2 transition-colors hover:text-foreground disabled:opacity-40"
          >
            Cancel
          </button>
        </div>
      </div>
    </div>
  );
}
