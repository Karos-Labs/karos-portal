import { describe, expect, it } from "vitest";

import {
  ALL_JOB_BUCKETS,
  type JobBucket,
  jobBucketLabel,
  jobBucketOf,
  jobBucketTone,
  jobInBucket,
  statusesInBucket,
} from "@/lib/job-list-buckets";
import { JOB_STATUS_META } from "@/components/job-status";
import { jobStatusLabel } from "@/lib/job-status-copy";
import type { JobStatus } from "@/lib/types";

/**
 * #109's module, asked the question its own extraction was about.
 *
 * `COMPLETED_STATUSES` was a `Set<JobStatus>` that held `review`, so the staff
 * chip row read "Completed 14" over fourteen rows badged "In review". The module
 * inverted that into a total `Record<JobStatus, JobBucket | null>` so every state
 * has to be placed by hand.
 *
 * WHY THIS FILE EXISTS. The inversion left two ways back in, and both were found
 * by mutation rather than by reading:
 *
 *  1. `jobBucketLabel` and `jobBucketTone` ended in `bucket === "active" ? … : …`,
 *     so EVERY bucket that was not `active` and did not hold exactly one state
 *     answered "Completed" / neon-green — including a bucket holding none.
 *  2. `ALL_JOB_BUCKETS` was a hand-typed array beside the map, which is a second
 *     answer to "which buckets exist". Setting `failed: null` in the map while
 *     "failed" stayed in the list rendered TWO chips both reading "Completed",
 *     and the whole suite stayed green.
 *
 * So the assertions below are about TOTALITY and UNIQUENESS rather than about
 * today's four buckets: the defect was never a wrong bucket, it was a fallthrough
 * that had somewhere to fall.
 *
 * WHAT THESE ASSERTIONS DO NOT COVER, stated because a guard that overstates its
 * reach is worse than one that admits a gap. Six mutations were run against this
 * file; four go red:
 *
 *   red    `review` folded back into `completed` (the original #109 defect)
 *   red    the hand-typed bucket list restored alongside an emptied bucket
 *   red    a single-state bucket inventing its own word instead of the register's
 *   red    the chip's COUNT and the list's FILTER disagreeing
 *   GREEN  the `bucket === "active" ? … : …` fallthrough restored on the label
 *   GREEN  the same fallthrough restored on the tone
 *
 * The last two cannot be caught from outside the module while every non-composite
 * bucket holds exactly ONE state: such a bucket takes the register path and never
 * reaches the fallthrough, so restoring it is behaviourally identical today. It is
 * a latent trap rather than a live defect, and what is catchable is its
 * CONSEQUENCE — a duplicate label or an empty bucket — which the red cases above
 * do catch. If a third composite bucket is ever added, these two mutations become
 * catchable and this paragraph should be deleted rather than reworded.
 */

const ALL_STATUSES = Object.keys(JOB_STATUS_META) as JobStatus[];

describe("no chip can fall through to another bucket's word", () => {
  it("gives every rendered bucket a label of its own", () => {
    // The closed question. Two chips reading the same word IS the #109 defect,
    // whatever produced it — a fallthrough, a duplicate entry, or a bucket that
    // stopped holding the state it was named for.
    const labels = ALL_JOB_BUCKETS.map(jobBucketLabel);
    expect(new Set(labels).size, `duplicate chip labels: ${labels.join(" | ")}`).toBe(
      labels.length,
    );
  });

  it("renders no bucket that counts nothing", () => {
    for (const bucket of ALL_JOB_BUCKETS) {
      expect(
        statusesInBucket(bucket).length,
        `${bucket} has a chip but holds no run state — it would count 0 for ever`,
      ).toBeGreaterThan(0);
    }
  });

  it("gives every rendered bucket a tone that reads as pressable", () => {
    // `neutral` is the register's tone for a state with nothing to say; a chip is
    // a control, so the mapping to `info` has to survive for every bucket rather
    // than only for the single-state ones.
    for (const bucket of ALL_JOB_BUCKETS) {
      expect(["info", "warning", "danger", "neon"]).toContain(jobBucketTone(bucket));
    }
  });
});

describe("a bucket never renames the state it holds", () => {
  /**
   * The original defect in its purest form: a bucket holding exactly one state
   * must use that state's sanctioned name. Derived from the map, so moving a
   * state between buckets moves this expectation with it.
   */
  const singles = ALL_JOB_BUCKETS.map((b) => [b, statusesInBucket(b)] as const).filter(
    ([, s]) => s.length === 1,
  );

  it("finds the single-state buckets it is about to check", () => {
    // Without this the loop below passes by looking at nothing — which is how the
    // sibling scan in this campaign passed over a guard that had been deleted.
    expect(singles.length).toBeGreaterThan(0);
  });

  for (const [bucket, states] of singles) {
    it(`${bucket} reads exactly as ${states[0]} does elsewhere`, () => {
      expect(jobBucketLabel(bucket as JobBucket)).toBe(jobStatusLabel(states[0]!));
    });
  }
});

describe("every run state is placed, and placed once", () => {
  it("routes each status to at most one bucket", () => {
    for (const status of ALL_STATUSES) {
      const holding = ALL_JOB_BUCKETS.filter((b) => jobInBucket(status, b));
      expect(holding.length, `${status} is in ${holding.length} buckets`).toBeLessThanOrEqual(1);
    }
  });

  it("keeps the chip's COUNT and the list's FILTER asking one question", () => {
    // `jobBucketOf` drives the count, `jobInBucket` drives the filter. If they
    // ever disagree, a chip reports a number the list it filters to cannot show —
    // which is the same class of defect as the label, one layer down.
    for (const status of ALL_STATUSES) {
      const bucket = jobBucketOf(status);
      for (const candidate of ALL_JOB_BUCKETS) {
        expect(jobInBucket(status, candidate)).toBe(bucket === candidate);
      }
    }
  });

  /**
   * `review` is the state the whole review queue is built around, so the one
   * grouping this module must never make again gets named outright.
   */
  it("never counts a run awaiting a human decision as completed", () => {
    expect(jobInBucket("review", "completed")).toBe(false);
    expect(statusesInBucket("completed")).not.toContain("review");
  });
});
