/**
 * How long a client is told ONE agent run takes.
 *
 * ONE number, in one place, because the alternative is what this replaced: the
 * same flow quoted "10–20 minutes" on the run band, "10–20 minutes" again in
 * the status strip, and a different per-agent range ("~20–40 min") in the
 * dialog's footer, so a client could read two answers to one question before
 * pressing a single button. Ranges also invited that drift, since each surface
 * kept its own.
 *
 * 30 minutes, for every agent (Daniel's call, 2026-08-09). It is deliberately
 * not per-product: a client asking "how long will this take" wants a number
 * they can plan around, not a per-agent table, and a run that lands early is a
 * pleasant surprise where one that lands late is a broken promise.
 *
 * NOT the launch/stand-up estimate — that is a different, one-time operation
 * and keeps its own constant (`LAUNCH_ESTIMATE` in client-agents.ts).
 */

/** Dialog-footer form, beside the credit cost: "~30 min". */
export const RUN_ESTIMATE = "~30 min";

/** Prose form, mid-sentence: "It takes about 30 minutes, and your Karos team…". */
export const RUN_ESTIMATE_SENTENCE = "about 30 minutes";
