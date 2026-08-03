/**
 * Copy for a RUN's state — the job-status register (pure, client-safe: this
 * module imports nothing but the type, so any surface may import it, including
 * a server-only one).
 *
 * WHY IT MOVED HERE from components/job-status.tsx: that file's own docstring
 * already claimed to be "the one place a raw job status becomes words a client
 * may read", and it was not, because it could not be. It is a `.tsx` that
 * imports `Badge`, so the copilot's system-prompt builder — `server-only`, and
 * the surface with no render to gate — could not reach it and interpolated
 * `job.status` raw instead. A register a whole class of caller cannot import is
 * a register that gets copied. The words live in a pure module now; the badge
 * that paints them stays a component.
 *
 * ONE lookup, not two: `tone` travels with `label` because both consumers want
 * the pair (JobStatusBadge paints it, run-calendar reads both for its run
 * chips), and splitting them would make "what do we call this state" two
 * questions again.
 *
 * SCOPE — stated, not counted. This module owns the `JobStatus` → words map.
 * It does NOT own the asset-status registers (`asset-status-copy.ts`, a
 * different key domain: `draft`/`scheduled` there are publish states of a
 * deliverable, not states of a run) or the calendar's chip-kind vocabulary
 * (`calendar-kind.ts`). Three domains, three accessors, and a word shared
 * between two of them ("approved", "delivered") is a coincidence of English
 * rather than a shared rule — ask the accessor for the domain you are in.
 */

import type { JobStatus } from "@/lib/types";

export const JOB_STATUS_META: Record<
  JobStatus,
  { tone: "neutral" | "neon" | "warning" | "danger" | "info"; label: string }
> = {
  queued: { tone: "neutral", label: "Queued" },
  running: { tone: "info", label: "Running" },
  review: { tone: "warning", label: "In review" },
  approved: { tone: "neon", label: "Approved" },
  delivered: { tone: "neon", label: "Delivered" },
  failed: { tone: "danger", label: "Failed" },
  cancelled: { tone: "neutral", label: "Cancelled" },
};

/**
 * The tone/label PAIR for one run state — the one read of the map above, and
 * therefore the one fallback for a status the union has never heard of
 * (Firestore holds strings it does not, which is why the parameter is `string`).
 *
 * WHY IT EXISTS. The note here used to say there were TWO answers for an unknown
 * status, and it was right: the map was read with its own `??` at three sites.
 * Two agreed (this module and `JobStatusBadge`, both landing on
 * `JOB_STATUS_META.queued`) and one did not — run-calendar's past-run card fell
 * back to `{ tone: "neutral", label: "Done" }`, so one stored value read "Done"
 * on a calendar chip and "Queued" everywhere else. Agreement is what made the
 * duplicate look harmless; the disagreement is what it actually cost.
 *
 * All three now ask this function, so the `??` is written once. What that buys is
 * narrow and worth stating exactly: every caller that has a status VALUE resolves
 * it here. It says nothing about a caller with NO status at all — run-calendar's
 * card takes an optional `jobStatus`, and the absence of a run state is a
 * different question from an unrecognised one, answered in that file with its own
 * named constant rather than folded in here (a past run is not "Queued").
 */
export function jobStatusMeta(status: string): (typeof JOB_STATUS_META)[JobStatus] {
  return JOB_STATUS_META[status as JobStatus] ?? JOB_STATUS_META.queued;
}

/**
 * The rendered label for one run state. Shorthand for a caller that paints its
 * own tone (the copilot's prompt builder has no tone at all).
 */
export function jobStatusLabel(status: string): string {
  return jobStatusMeta(status).label;
}
