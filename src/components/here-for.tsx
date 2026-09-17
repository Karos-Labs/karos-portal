"use client";

import { Icon } from "@/components/icon";
import { cn } from "@/lib/utils";

/**
 * "YOU'RE HERE TO …" — the one landing band (portal feedback round 6, §2.8).
 *
 * Albert's complaint about the setup ladder was not only that one row had a
 * button: it was that pressing it "lands on Account Center → Profile with no
 * indication of what to do". No surface knew it had been reached from the
 * ladder, so the client arrived beside the field rather than on it, and nothing
 * said which field, or why.
 *
 * This is that missing sentence, rendered at the top of the landed section
 * whenever the URL carries `?for=<stepId>` (lib/setup-ladder.ts's
 * `SETUP_LANDING_KEYS`). Two clauses and no more: the action, in the same words
 * the ladder's own control used, and ONE reason the field matters. Both come
 * from `SETUP_LANDING_COPY`, so the button and the band cannot say two
 * different things.
 *
 * ── THE RULES IT KEEPS ───────────────────────────────────────────────────
 *
 *  · INFO TONE, never accent. It is guidance, not a status and not a CTA; the
 *    judgment scale owns tone and orange never signals either (Ember §7).
 *  · `role="status"`. It appears without the reader moving — the navigation
 *    delivered it — so a screen reader is told, politely, that it is there.
 *  · NOTHING IS PERSISTED. It clears on the first successful save or on "Got
 *    it", and the caller drops the query params with it. The ladder itself is
 *    the memory: if the step is still outstanding the row is still there, and
 *    the band comes back the next time the client is sent here on purpose.
 *  · ONE PRIMITIVE, not four. N17's "first-visit tips" are the same shape, so
 *    when those land they mount this rather than growing a second band.
 *
 * NN/g on onboarding: contextual help at the moment of need, dismissible, and
 * gone once the work is done.
 */
export function HereFor({
  action,
  reason,
  onDismiss,
  className,
}: {
  /**
   * The verb phrase, lowercase and without a full stop: "add a short
   * description". It is rendered inside "You're here to {action}." so a
   * sentence-cased value would read as a second sentence starting mid-line.
   */
  action: string;
  /** ONE sentence saying why this field matters. Full stop included. */
  reason: string;
  /** Clears the band and the `for=` params. Also what the caller calls on save. */
  onDismiss: () => void;
  className?: string;
}) {
  return (
    <div
      role="status"
      className={cn(
        "flex flex-wrap items-start gap-x-3 gap-y-1.5 rounded-md border border-info/30 bg-info/10 px-3 py-2.5",
        className,
      )}
    >
      <Icon name="Info" className="mt-0.5 h-3.5 w-3.5 shrink-0 text-info" />
      <p className="min-w-0 flex-1 text-xs leading-relaxed text-foreground">
        You&apos;re here to {action}. <span className="text-muted">{reason}</span>
      </p>
      {/* Quiet, because dismissing is not the thing the client came to do. */}
      <button
        type="button"
        onClick={onDismiss}
        className="focus-ring shrink-0 rounded-md text-xs font-medium text-muted underline-offset-2 transition-colors hover:text-foreground hover:underline"
      >
        Got it
      </button>
    </div>
  );
}
