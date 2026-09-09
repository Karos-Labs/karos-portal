/**
 * What a client is told about how long ONE agent run takes.
 *
 * ── WHY THIS IS NO LONGER "30 minutes" ───────────────────────────────────────
 *
 * It said `about 30 minutes`, everywhere, for every agent (Daniel's call,
 * 2026-08-09), and the reasoning at the time was sound: one number in one
 * place, because the flow had previously quoted "10–20 minutes" on the run
 * band, "10–20 minutes" again in the status strip and "~20–40 min" in the
 * dialog footer, so a client could read two answers to one question before
 * pressing a single button.
 *
 * The number itself was never measured. Measured now, against this project's
 * own records:
 *
 *  • `agentEngineRuns` — the engine's own run records, which stop the clock
 *    when the AGENT is done — completed in 0.2, 1.8, 1.9 and 5.9 minutes.
 *  • `jobs` — createdAt→updatedAt across 14 terminal runs — read 1.8, 6.8,
 *    7.0, 7.0, 14.1, 16.2, 18.0, 22.3, 24.3, 26.3, 31.3, 33.5, 99.1 and 104.5
 *    minutes.
 *
 * Those two are not the same measurement, and the gap between them is the
 * whole problem with the old sentence. A job's `updatedAt` moves again when a
 * human reviews or approves it, so the job figures are AGENT TIME PLUS QUEUE
 * PLUS HUMAN REVIEW. The engine figures are the agent alone, and the agent
 * alone is minutes.
 *
 * So "about 30 minutes" was wrong in both directions at once: far too long as
 * a description of the work, and too short as a description of when a client
 * can expect the deliverable, because the wait is dominated by a human step it
 * never mentioned. Four of fourteen runs blew straight past it.
 *
 * A SMALL SAMPLE, and it is quoted above rather than summarised so the next
 * reader can weigh it. It is enough to retire a number nothing supported; it
 * is not enough to mint a precise replacement, which is why the replacement is
 * deliberately imprecise and why the real answer is not a constant at all — it
 * is the live step progress the run surfaces now render. A promise you can
 * watch being kept does not need a number attached.
 *
 * NOT the launch/stand-up estimate — that is a different, one-time operation
 * and keeps its own constant (`LAUNCH_ESTIMATE` in client-agents.ts), which
 * has not been measured and is not covered by any of the above.
 */

/**
 * Dialog-footer form, beside the credit cost: "a few minutes".
 *
 * Says the shape of the answer rather than a figure to plan around. A client
 * who wants the figure now watches the steps.
 */
export const RUN_ESTIMATE = "a few minutes";

/** Prose form, mid-sentence: "It takes a few minutes, and your Karos team…". */
export const RUN_ESTIMATE_SENTENCE = "a few minutes";

/**
 * What actually decides when a deliverable ARRIVES, for the surfaces that used
 * to fold agent time and review time into one number.
 *
 * Kept separate from the two above on purpose: they describe the run, this
 * describes the wait, and the old copy's central mistake was pretending those
 * are one quantity.
 */
export const REVIEW_WAIT_SENTENCE = "your Karos team reviews it before it reaches you";
