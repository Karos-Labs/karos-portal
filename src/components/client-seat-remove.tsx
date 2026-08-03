"use client";

/**
 * The remove gesture for a seat, on the surfaces where a client CREATES seats.
 *
 * #84: `AddSeatForm` on the X and LinkedIn intake pages minted ClientSeat rows
 * and no delete existed anywhere. A typo, a duplicate ("Dan" and "Daniel
 * Herbert"), or someone who has left became a permanent card on the client's own
 * page — and by design a seat with no intake document still gets a row in the
 * agent page's "What it runs on" band, so a dead seat permanently painted an
 * "Empty" badge and permanently inflated that band's "n of m still empty" line.
 *
 * The GESTURE already existed in the product, on the LinkedIn employee-seat
 * roster in settings (linkedin-seats-workspace.tsx): two steps, the first click
 * never the destructive one, the result read rather than discarded, and the
 * failure written into the row instead of vanishing. This is that pattern, once,
 * for both intake pages — a second copy of a two-step confirm is how one of them
 * ends up one-step.
 *
 * ONE COMPONENT FOR BOTH PAGES ON PURPOSE. Removing a seat removes the person
 * from every agent (see removeClientSeatAction), so the two pages cannot be
 * allowed to explain the same act differently.
 */

import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { Button } from "@/components/ui";
import { Icon } from "@/components/icon";
import { cn } from "@/lib/utils";
import { INTAKE_ACTION_FAILED, intakeSave } from "@/lib/intake-save";
import { removeClientSeatAction } from "@/lib/actions/client-seat-actions";

export function ClientSeatRemove({
  clientId,
  seatId,
  seatName,
  /**
   * A run of THIS agent is queued or working. The portal has no recall channel
   * once a run is submitted — the agent service already holds its own copy of
   * the payload — so the confirm says so rather than implying the removal
   * reaches back into work already in flight.
   *
   * ANSWERED ON THE SERVER, from the unfiltered job scan (`anyRunInFlight` in
   * lib/agent-intake-views.ts) — never from the run rows the surrounding page
   * displays. A client's rows are collapsed to one per calendar day, so a run
   * queued at 09:00 leaves that list as soon as a later run the same day lands,
   * and a warning derived from it reached staff and skipped the client who is
   * the one pressing Remove.
   */
  runInFlight,
  initiallyConfirming = false,
}: {
  clientId: string;
  seatId: string;
  seatName: string;
  runInFlight: boolean;
  /**
   * TEST SEAM. The confirm opens on a click, and a server render cannot
   * click — so the panel would be unreachable to the one kind of test that
   * can tell a conditional sentence from an unconditional one. Defaults to
   * false, so no caller's behaviour depends on it.
   */
  initiallyConfirming?: boolean;
}) {
  const router = useRouter();
  const [confirming, setConfirming] = useState(initiallyConfirming);
  const [error, setError] = useState<string | null>(null);
  const [pending, start] = useTransition();

  function remove() {
    setError(null);
    start(async () => {
      // Through the funnel, like every other write on these pages: an
      // authorization failure THROWS out of requireClientAccess, and a throw
      // inside a transition produces no result to read — which on the employee
      // roster meant the row refreshed back into place with no message at all.
      // `INTAKE_ACTION_FAILED`, not the funnel's save default: nothing is being
      // saved here and there are no answers on screen, so the save sentence's
      // instruction points at a form that does not exist.
      const result = await intakeSave(
        () => removeClientSeatAction({ clientId, seatId }),
        INTAKE_ACTION_FAILED,
      );
      if (result.error) {
        setError(result.error);
        return;
      }
      setConfirming(false);
      router.refresh();
    });
  }

  if (!confirming) {
    return (
      <div className="mt-4 border-t border-border pt-4">
        <button
          type="button"
          onClick={() => {
            setError(null);
            setConfirming(true);
          }}
          disabled={pending}
          className={cn(
            "inline-flex items-center gap-1.5 text-xs text-muted-2 transition-colors",
            "hover:text-danger disabled:opacity-40",
          )}
        >
          <Icon name="Trash2" className="h-3.5 w-3.5" />
          Remove this seat
        </button>
      </div>
    );
  }

  return (
    <div className="mt-4 flex items-start gap-2 rounded-md border border-danger/40 bg-danger/10 p-3">
      <Icon name="TriangleAlert" className="mt-0.5 h-4 w-4 shrink-0 text-danger" />
      <div className="min-w-0 space-y-1.5">
        <p className="text-xs font-medium text-foreground">Remove {seatName}?</p>
        <p className="text-xs text-muted">
          A seat is one person, shared by every agent we run for them. So this removes their
          answers everywhere, including anything attached to their seat. It cannot be undone.
        </p>
        {runInFlight ? (
          <p className="text-xs text-muted">
            A run is working right now and already has their details, so it may still come back with
            drafts for them. Your Karos team reads everything before you see it.
          </p>
        ) : null}
        <p className="text-[11px] text-muted-2">
          You can add them again later, but you would be filling their answers in from scratch.
        </p>
        <div className="flex flex-wrap gap-2 pt-0.5">
          <Button size="sm" variant="danger" onClick={remove} loading={pending} disabled={pending}>
            Yes, remove seat
          </Button>
          <Button
            size="sm"
            variant="ghost"
            onClick={() => {
              setConfirming(false);
              setError(null);
            }}
            disabled={pending}
          >
            Keep it
          </Button>
        </div>
        {error ? <p className="text-xs text-danger">{error}</p> : null}
      </div>
    </div>
  );
}
