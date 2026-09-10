import "server-only";

import { listJobsByClientAndAgent } from "@/lib/data";
import { estimateRunCreditsFromJobs, type RunEstimate } from "@/lib/credit-reporting";
import { isCreditsPlanV2Enabled } from "@/lib/credits";
import type { Job } from "@/lib/types";

/**
 * The server half of the self-calibrating run estimate (credits rework,
 * 2026-09) — the read; `estimateRunCreditsFromJobs` in `credit-reporting.ts`
 * owns the arithmetic and stays pure.
 *
 * WHY A PRICE IS NOW MEASURED AT ALL. Every run price in this product used to be
 * a constant or an admin-typed number, and a client was charged exactly that.
 * Under settle-to-actual the charge is reconciled to what the run cost us, so
 * the number quoted BEFORE the run is only a quote — and a quote that never
 * moves is one that drifts from the bill it precedes.
 *
 * ONE LADDER, TWO RUNGS, SHARED WITH THE PAGE. This client's own measured
 * median, then the constant. There is deliberately no cross-client rung: it
 * would need a read of the whole `jobs` collection, which the surfaces that
 * QUOTE the price cannot afford, and a ladder only one side can climb is how the
 * quote and the hold came apart in the first place. A brand-new client is quoted
 * the constant, settles to actual on their first run, and is measured from their
 * fourth.
 *
 * THE SAMPLE CAP IS NOT HERE. It lives inside `recentRunCostsUsd`, after the
 * filter it caps — this used to slice the client's newest 50 jobs across ALL
 * agents before filtering by agent, so a client running six agents could hand
 * this function a sample of nothing while the card that quotes the same price
 * had ten. That is the divergence in miniature, and moving the cap is what makes
 * "the same function over the same rows" true rather than aspirational.
 */

/**
 * Credits to hold, and to quote, for one run of one agent.
 *
 * NEVER THROWS. A read failure returns the fallback: quoting the constant is a
 * mildly stale price, and failing a submit because the PRICING LOOKUP fell over
 * would take the product down to protect a rounding difference.
 *
 * Returns the fallback outright while `CREDITS_PLAN_V2_ENABLED` is off, so the
 * hold is the price it has always been and no client sees a number move before
 * the rework is deliberately switched on.
 */
export async function estimateAgentRunCredits(input: {
  clientId: string;
  customAgentId: string;
  /** agent.creditCost ?? the family default ?? CREDIT_COSTS.customAgentRun. */
  fallbackCredits: number;
  /** Already-loaded jobs for this client, when the caller has them. */
  clientJobs?: readonly Job[];
}): Promise<RunEstimate> {
  const fallback: RunEstimate = { credits: input.fallbackCredits, fallback: true, samples: 0 };
  if (!isCreditsPlanV2Enabled()) return fallback;
  try {
    // NARROWED AT THE DATABASE. This read `listJobs({ clientId })` — every job
    // the client has ever run, on every submit — to find at most ten numbers
    // about ONE agent. Two equality filters and a limit need no composite index
    // (see listJobsByClientAndAgent), and the cap that matters is now inside
    // `recentRunCostsUsd`, so this and the quoting surfaces run the identical
    // function over the same rows.
    const jobs =
      input.clientJobs ??
      (await listJobsByClientAndAgent(input.clientId, input.customAgentId));
    return estimateRunCreditsFromJobs(jobs, {
      clientId: input.clientId,
      customAgentId: input.customAgentId,
      fallbackCredits: input.fallbackCredits,
    });
  } catch (e) {
    console.error("[credit-estimate] falling back to the constant price:", e);
    return fallback;
  }
}
