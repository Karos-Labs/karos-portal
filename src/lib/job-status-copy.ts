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
 * The rendered label for one run state, defensively falling back the way
 * JobStatusBadge already does (Firestore holds strings the union does not, which
 * is why the parameter is `string`).
 *
 * There is ONE fallback, here, so a status missing from the map cannot resolve
 * one way on a badge and another way in a model prompt.
 */
export function jobStatusLabel(status: string): string {
  return JOB_STATUS_META[status as JobStatus]?.label ?? JOB_STATUS_META.queued.label;
}
