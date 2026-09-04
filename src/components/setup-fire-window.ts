"use client";

import { useEffect, useState } from "react";

/**
 * How long a "Set it up" press is believed on the strength of the press alone.
 *
 * WHY A WINDOW AT ALL. The band has two sources for "a setup run is happening":
 * the press the reader just made, which is instant but local, and the server's
 * own `runInFlight` (`anyRunInFlight`, off the unfiltered job scan), which is
 * authoritative but arrives one render late — `submitCustomAgentJob` writes the
 * job, the action returns, and only the NEXT server render carries it. Trusting
 * the press alone forever is the defect this file exists to fix (below);
 * trusting the server alone would flicker the button back for the second
 * between the press and the refresh, which is a second in which a client can
 * press it again and buy a second stand-up.
 *
 * WHAT WENT WRONG WITHOUT IT (flow audit follow-up, 2026-09). The first cut of
 * R1 held `fired` as a boolean that was never reset, so `running = fired ||
 * runInFlight` pinned the page for the rest of the session: a run that FAILED —
 * or was refused before it ever started — left "Setup is running. This page
 * updates itself when it finishes." on screen with no button under it, and left
 * `AutoRefresh` doing a full `router.refresh()` every four seconds forever. The
 * failure state is exactly when a client most needs the control back.
 *
 * 15 SECONDS is the handover, not an estimate of the run: the job document is
 * created before dispatch, so one poll tick (4s) already carries it, and this is
 * several ticks of slack for a cold container. Past it, the server's answer is
 * the only one that counts.
 */
export const SETUP_FIRE_GRACE_MS = 15_000;

/**
 * Has a press stopped counting? Pure, so the rule is unit-tested rather than
 * inferred from a component's behaviour.
 *
 * A press expires only when BOTH are true: enough time has passed for a server
 * render to have seen it, and the server says nothing is running. A run still in
 * flight keeps the press alive however long it takes — the whole point is that
 * the server's fact takes over from the press, not that it competes with it.
 */
export function fireWindowExpired(args: {
  firedAt: number | null;
  runInFlight: boolean;
  now: number;
}): boolean {
  if (args.firedAt === null) return false;
  if (args.runInFlight) return false;
  return args.now - args.firedAt >= SETUP_FIRE_GRACE_MS;
}

/**
 * The press half of a setup band's "is it running" answer.
 *
 * `firedAt` is non-null while this session's own press still counts; `markFired`
 * records one. Callers combine it with the server's fact themselves, because the
 * two surfaces that use this combine it differently and the difference matters:
 *
 *  · A SETUP BAND says running on `runInFlight || fired`. It only renders while
 *    the family is not set up, and no writer run can start before the stand-up,
 *    so an in-flight run there IS this run — including for a client who reloaded
 *    mid-run and has no press of their own.
 *  · A SEAT's voice build says running on `fired` alone. Its family IS set up,
 *    so an in-flight run may be an ordinary post run, and reading that as "we
 *    are building this person's voice" would be a sentence about someone else's
 *    work. The server's fact still decides how long the press lasts.
 */
export function useSetupFireWindow(runInFlight: boolean): {
  fired: boolean;
  markFired: () => void;
} {
  const [firedAt, setFiredAt] = useState<number | null>(null);

  useEffect(() => {
    // Nothing to expire, or the server says the run this press started is still
    // going — a press is held for as long as its run runs, however long that is.
    // `runInFlight` is a dependency, so the render that reports the run finished
    // re-runs this and schedules the expiry immediately (`remaining` is already
    // 0 by then).
    if (firedAt === null || runInFlight) return;
    const remaining = Math.max(SETUP_FIRE_GRACE_MS - (Date.now() - firedAt), 0);
    const t = setTimeout(() => {
      // The predicate decides, not the timer: the timer only says "look again
      // now". Re-asked at the moment it fires, against the same rule the unit
      // tests pin, and through a functional update so a press made while this
      // was pending cannot be cleared by a stale one.
      setFiredAt((at) =>
        at !== null && fireWindowExpired({ firedAt: at, runInFlight, now: Date.now() }) ? null : at,
      );
    }, remaining);
    return () => clearTimeout(t);
  }, [firedAt, runInFlight]);

  return { fired: firedAt !== null, markFired: () => setFiredAt(Date.now()) };
}
