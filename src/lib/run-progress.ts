/**
 * What a client is told while a run they started is still going (pure,
 * client-safe: imports nothing but the type).
 *
 * WHAT WAS THERE. The run dialog's `if (started)` branch: a green tick, the
 * word "started", the 30-minute estimate, and a Done button. Staff also got an
 * "Open the run" link; a client got nothing to look at. Lola's note is exactly
 * the gap - "I got the 30-minute popup, but how do I know where it goes, if it
 * worked, etc." An estimate is a PROMISE, and a promise with no progress beside
 * it is the one piece of information a reader cannot check.
 *
 * WHY A THREE-WAY OUTCOME AND NOT `inProgress`. A boolean answers "is it still
 * going" and leaves the reader's real question - did it work - to be inferred
 * from a spinner stopping. There are three states a reader can act on: it is
 * WORKING (wait, and here is the stage), it LANDED (go look, here is where), or
 * it STOPPED (nothing is coming, here is what to do). `stopped` covers `held`
 * as well as `failed`, because from the reader's side a run that a guardrail
 * held produced nothing either - what differs is the sentence, not the class.
 *
 * The map is a `Record<JobStatus, …>`, so a seventh run state is a compile
 * error here rather than a status that silently reads as "working" forever.
 */

import type { JobStatus } from "@/lib/types";

/** What the reader should do about this run, which is not the same as its status. */
export type RunOutcome = "working" | "landed" | "stopped";

const RUN_OUTCOME: Record<JobStatus, RunOutcome> = {
  queued: "working",
  running: "working",
  // `review` IS the landing. The deliverables exist from this point; what is
  // outstanding is a human looking at them, which the copy names rather than
  // dressing up as the run still running.
  review: "landed",
  approved: "landed",
  delivered: "landed",
  failed: "stopped",
  cancelled: "stopped",
  held: "stopped",
};

/**
 * The reader's question, answered from the stored status.
 *
 * `string` rather than `JobStatus` for the same reason `jobStatusMeta` takes
 * one: Firestore holds values the union has not heard of, and this is read from
 * a JSON response. An unknown status reads as still WORKING - the honest
 * default, because the alternative is telling a reader their run is finished or
 * dead on the strength of a word nothing recognises.
 */
export function runOutcome(status: string): RunOutcome {
  return RUN_OUTCOME[status as JobStatus] ?? "working";
}

/** Every status this register answers for, for the tests. */
export const ALL_RUN_OUTCOME_KEYS = Object.keys(RUN_OUTCOME) as JobStatus[];

/**
 * The wire shape of the progress endpoint, and the only thing that crosses.
 *
 * `status` is a STORED ENUM and travels as data, never as copy: every reader
 * paints it through `jobStatusLabel` / `ManagedJobProgress`, the same way
 * `JobStatusBadge` has always taken one. Nothing else about the job crosses -
 * not the error string, not the agent-engine run id, not the deliverable ids.
 */
export interface RunProgressView {
  status: string;
  /** The run has not reached a terminal state. Computed server-side. */
  inProgress: boolean;
}

/** The endpoint one run's progress is polled from. One spelling, two readers. */
export function runProgressUrl(jobId: string): string {
  return `/api/runs/${jobId}/progress`;
}

/**
 * The sentence under the progress strip, per outcome and per viewer.
 *
 * TWO VIEWERS, because the client's sentence is a machine telling the Karos
 * team to wait for themselves (the AF-9 split the `started` panel already
 * made). Kept here rather than in the component so the copy channels sweep it
 * and so the dock and the dialog cannot say two different things about one run.
 */
const RUN_OUTCOME_COPY: Record<RunOutcome, { client: string; staff: string }> = {
  working: {
    client: "Still working. This page updates on its own, and closing this does not stop it.",
    staff: "Still working. This updates on its own, and closing it does not stop the run.",
  },
  landed: {
    // NO DESTINATION IN THIS SENTENCE, and that is deliberate. A client has
    // nowhere to look at a deliverable in `review`: the archive holds APPROVED
    // work only (F149), so pointing them there sends them to an empty page -
    // the same defect as the phantom "review queue" this epic removed. The
    // dock offers a link only when whoever started the run had a real one.
    client: "It landed. Your Karos team reviews it next.",
    staff: "It landed. The deliverables are on the run.",
  },
  stopped: {
    client: "Nothing came out of this one. You were not charged for work that did not arrive, and you can start another or ask us about it.",
    staff: "This run produced nothing. Open it to see why.",
  },
};

export function runOutcomeSentence(outcome: RunOutcome, viewerIsClient: boolean): string {
  const pair = RUN_OUTCOME_COPY[outcome];
  return viewerIsClient ? pair.client : pair.staff;
}

/** Every outcome the sentence register answers for, for the tests. */
export const ALL_RUN_OUTCOMES = Object.keys(RUN_OUTCOME_COPY) as RunOutcome[];
