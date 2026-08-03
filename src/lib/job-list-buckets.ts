/**
 * How the staff Jobs list GROUPS run states for its summary chips — pure and
 * type-only, so the chips, the filter they drive and a test can all ask the same
 * question.
 *
 * WHY IT IS NOT IN THE COMPONENT ANY MORE. It was a `Set<JobStatus>` named
 * `COMPLETED_STATUSES`, and it held `review`. So the chip row over a staff
 * member's whole queue read "Completed 14" while fourteen rows below it wore the
 * badge "In review" — the one number a staff member reads to decide whether the
 * review queue is clear, telling them the opposite of the truth. A Set says
 * nothing about the states it leaves out, which is what let `review` be dropped
 * into the only bucket that had room.
 *
 * SO IT IS INVERTED. `BUCKET_OF` is a `Record<JobStatus, …>`: every run state has
 * to be placed by hand, and a new member of the union is a COMPILE error here
 * rather than a status that silently lands in whichever bucket a `Set` happens to
 * match. That is the tripwire — the chip labels below are only the fix.
 *
 * RE-SCOPED, NOT RENAMED, and the choice is worth stating because both were open.
 * A rename ("Finished", "Not active") would have kept one bucket over three
 * unrelated states and made it vaguer; the chip is also a FILTER, so the useless
 * grouping would have survived behind a softer word. The question staff actually
 * ask this row is "is the review queue clear?", and that question earns its own
 * chip. `completed` now means what the word means: approved or delivered.
 */

import { jobStatusLabel, jobStatusMeta } from "@/lib/job-status-copy";
import type { JobStatus } from "@/lib/types";

/** The composite buckets the summary chips count and filter by. */
export type JobBucket = "active" | "review" | "completed" | "failed";

/**
 * Which bucket each run state counts toward, or `null` for one that counts
 * toward none.
 *
 * `null` IS A DECISION, not an omission, and that is the whole reason the type
 * admits it. `cancelled` is a staff member stopping a run on purpose: it did not
 * complete, it did not fail, and it is not in flight, so folding it into any of
 * the four would put a third wrong number on the row to fix the first one. It
 * stays reachable through the per-status dropdown beside the chips. Writing it as
 * `null` rather than leaving it out means the next status added has to say which
 * it is.
 */
const BUCKET_OF: Record<JobStatus, JobBucket | null> = {
  queued: "active",
  running: "active",
  review: "review",
  approved: "completed",
  delivered: "completed",
  failed: "failed",
  cancelled: null,
};

/**
 * Lifecycle order. A `Record` rather than a hand-typed array for the same reason
 * `BUCKET_OF` is one: an array can silently omit a bucket, or keep listing one
 * that `BUCKET_OF` no longer maps any state to.
 */
const BUCKET_ORDER: Record<JobBucket, number> = {
  active: 0,
  review: 1,
  completed: 2,
  failed: 3,
};

/**
 * The buckets that render, in lifecycle order — DERIVED, so a bucket holding no
 * states does not get a chip.
 *
 * This was a hand-typed array, and that re-created the defect the module was cut
 * out of from the other direction: setting `failed: null` in `BUCKET_OF` while
 * "failed" stayed in the list rendered TWO chips both reading "Completed", the
 * second one neon-green, and the whole suite stayed green. A list of buckets and
 * a map of states are two answers to "which buckets exist"; only one of them can
 * be the source.
 */
export const ALL_JOB_BUCKETS: readonly JobBucket[] = (
  Object.keys(BUCKET_ORDER) as JobBucket[]
)
  .filter((b) => statusesInBucket(b).length > 0)
  .sort((a, b) => BUCKET_ORDER[a] - BUCKET_ORDER[b]);

/**
 * The word each COMPOSITE bucket uses. Total over `JobBucket` so there is no
 * fallthrough: the old form ended `return bucket === "active" ? "Active" :
 * "Completed"`, which answered "Completed" for every bucket that was not
 * `active` — including a bucket holding nothing, and including `failed` if it
 * ever stopped being a single-state bucket.
 *
 * A single-state bucket never reads from this; it takes its name from the
 * sanctioned register (see below). These are the words for a bucket that names
 * no single state, and each one has to be written down rather than defaulted.
 */
const COMPOSITE_LABEL: Record<JobBucket, string> = {
  active: "Active",
  review: "In review",
  completed: "Completed",
  failed: "Failed",
};

/**
 * The chip's words.
 *
 * A bucket holding exactly ONE state takes that state's name from the sanctioned
 * register rather than inventing a second one — which is the defect this module
 * was cut out of. Today that is `review` and `failed`; `active` and `completed`
 * are the composites. Which is which is not hard-coded here: it follows from
 * `BUCKET_OF`, so moving a state between buckets moves the word with it.
 */
export function jobBucketLabel(bucket: JobBucket): string {
  const only = statusesInBucket(bucket);
  if (only.length === 1) return jobStatusLabel(only[0]!);
  return COMPOSITE_LABEL[bucket];
}

/** The states this bucket counts — derived from the map, never re-listed. */
export function statusesInBucket(bucket: JobBucket): JobStatus[] {
  return (Object.keys(BUCKET_OF) as JobStatus[]).filter((s) => BUCKET_OF[s] === bucket);
}

/** Which bucket this run state counts toward, if any. */
export function jobBucketOf(status: JobStatus): JobBucket | null {
  return BUCKET_OF[status] ?? null;
}

/**
 * Does this run state belong to this bucket? The one test the chip's COUNT and
 * the list's FILTER both ask, so a chip can never report a number the list it
 * filters to does not show.
 */
export function jobInBucket(status: JobStatus, bucket: JobBucket): boolean {
  return BUCKET_OF[status] === bucket;
}

/**
 * The tone each COMPOSITE bucket uses — total, for the same reason
 * `COMPOSITE_LABEL` is. The old fallthrough ended `bucket === "active" ? "info" :
 * "neon"`, so a `failed` bucket that stopped holding exactly one state would have
 * rendered neon green.
 */
const COMPOSITE_TONE: Record<JobBucket, "info" | "warning" | "danger" | "neon"> = {
  active: "info",
  review: "warning",
  completed: "neon",
  failed: "danger",
};

/**
 * The chip's tone, taken from the register for a single-state bucket so the chip
 * and the row's own badge cannot disagree about how urgent the state looks.
 *
 * A composite names no single state, so there is nothing to inherit and it uses
 * its own written-down tone.
 */
export function jobBucketTone(bucket: JobBucket): "info" | "warning" | "danger" | "neon" {
  const only = statusesInBucket(bucket);
  if (only.length === 1) {
    const tone = jobStatusMeta(only[0]!).tone;
    // `neutral` is the register's tone for a state with nothing to say about it,
    // and a chip is never that — it is a control that has to read as pressable.
    // Mapped rather than widened, so this function's return type stays the closed
    // set `jobs-list.tsx`'s own class table is keyed over: widening it there would
    // be a compile error, which is the point.
    return tone === "neutral" ? "info" : tone;
  }
  return COMPOSITE_TONE[bucket];
}
