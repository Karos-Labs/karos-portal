import "server-only";

import { estimateRunCreditsByAgent, estimateRunCreditsFromJobs } from "@/lib/credit-reporting";
import {
  BLOG_RUN_CREDITS,
  CREDIT_COSTS,
  NEWSLETTER_RUN_CREDITS,
  REPUTATION_RUN_CREDITS,
  isCreditsPlanV2Enabled,
} from "@/lib/credits";
import { isBlogAgent } from "@/lib/agent-service/blog-agent-context";
import { isNewsletterAgent } from "@/lib/agent-service/newsletter-agent-context";
import { isReputationAgent } from "@/lib/agent-service/reputation-agent-context";
import type { Job } from "@/lib/types";

/**
 * The ONE price a surface may quote for one run of one agent (review wave,
 * 2026-09).
 *
 * WHY THIS FILE EXISTS. Four surfaces quoted a run — the agent detail page, the
 * two roster branches and the live card's row projection — and all four called
 * `estimateRunCreditsFromJobs` directly with `agent.creditCost ??
 * CREDIT_COSTS.customAgentRun` as the fallback. That reproduced neither half of
 * what `submitCustomAgentJob` actually does, and each half was wrong on its own:
 *
 *  1. THE FLAG. `estimateAgentRunCredits` (credit-estimate.ts) returns the
 *     constant outright while `CREDITS_PLAN_V2_ENABLED` is off — which is the
 *     production default. The pages skipped that gate, so with the rework OFF
 *     they quoted a MEASURED MEDIAN while the server charged the constant: the
 *     exact quote-versus-charge split the shared estimator was written to close,
 *     reintroduced by calling the estimator's inner half.
 *  2. THE CARRIED RUNG. The submit core's fallback has THREE rungs —
 *     `agent.creditCost ?? the family's carried default ?? CREDIT_COSTS
 *     .customAgentRun` — and the pages had two. The newsletter and the blog
 *     carry a 10-credit price from their managed-product days, so a newsletter
 *     run with no admin override was quoted at 25 and charged at 10.
 *
 * So the ladder is written once, here, and the four sites ask this. A quote is
 * still only a quote — settlement reconciles it to what the run cost us — but it
 * is now the same NUMBER the hold will be, resolved by the same rules.
 *
 * PURE, in the sense that matters: no reads. The caller passes the jobs it has
 * already loaded (every one of the four sites holds this client's jobs for other
 * reasons), so the shared number costs no query. `isCreditsPlanV2Enabled()` is a
 * `process.env` read behind `server-only`, which is why this module is
 * server-side and the ANSWER travels to the browser as a boolean prop.
 */

/**
 * The family's CARRIED price, or null when the family carries none.
 *
 * DERIVED FROM THE KEY HERE rather than taken as an argument, and that is the
 * point of the module: a caller-supplied family would be a second answer to a
 * question the submit core already answers one way, and two answers to a pricing
 * question is what this file exists to stop. These are the same three predicates
 * `submitCustomAgentJob` uses — the FAMILY ones (every key in the family,
 * including the setup and manager skills), not the `*AgentIdentity` ones, which
 * are the narrower "who gets the intake surface" question and would leave a
 * setup run quoted at the generic rate the core does not charge it.
 */
function carriedFamilyDefault(agentKey: string): number | null {
  if (isNewsletterAgent(agentKey)) return NEWSLETTER_RUN_CREDITS;
  if (isBlogAgent(agentKey)) return BLOG_RUN_CREDITS;
  if (isReputationAgent(agentKey)) return REPUTATION_RUN_CREDITS;
  return null;
}

export interface RunPriceQuote {
  /** Credits for ONE output of one run — a caller with a batch multiplies it. */
  credits: number;
  /**
   * Whether the figure is a HOLD that settles to real usage rather than the
   * charge itself. Wording only, and it tracks the flag rather than whether a
   * measurement was found: with the rework on, even a constant-priced run
   * settles, so "about" is true for both branches.
   */
  isEstimate: boolean;
  /** True when the constant was quoted rather than a measurement. */
  fallback: boolean;
  /** How many of this client's runs the median was taken over (0 for a constant). */
  samples: number;
}

/**
 * What one run of `agent` will be held at for `clientId`, and how to word it.
 *
 * NEVER THROWS AND NEVER READS, so a pricing question cannot fail a page. The
 * read-and-fall-back version of this is `estimateAgentRunCredits`, which is what
 * the submit core calls; this is the same ladder over jobs the caller already
 * has.
 */
export function resolveRunPriceQuote(input: {
  agent: { id: string; key: string; creditCost?: number | null };
  clientId: string;
  /** This client's jobs, unsorted and unfiltered — the caller already has them. */
  jobs: readonly Job[];
}): RunPriceQuote {
  const fallbackCredits = runPriceFallback(input.agent);
  // The rework is off: the constant IS the charge, so quoting a median would be
  // the quote-versus-charge split pointed the other way, and hedging the wording
  // would tell a client a fixed price might move.
  if (!isCreditsPlanV2Enabled()) {
    return { credits: fallbackCredits, isEstimate: false, fallback: true, samples: 0 };
  }
  const estimate = estimateRunCreditsFromJobs(input.jobs, {
    clientId: input.clientId,
    customAgentId: input.agent.id,
    fallbackCredits,
  });
  return {
    credits: estimate.credits,
    isEstimate: true,
    fallback: estimate.fallback,
    samples: estimate.samples,
  };
}

/** The three-rung constant, alone — the ladder without the measurement. */
function runPriceFallback(agent: { key: string; creditCost?: number | null }): number {
  return agent.creditCost ?? carriedFamilyDefault(agent.key) ?? CREDIT_COSTS.customAgentRun;
}

/**
 * The same quote for a WHOLE ROSTER, walking the job list once.
 *
 * `resolveRunPriceQuote` filters the list per agent, which on a page rendering a
 * dozen cards is a dozen passes over the client's history. This groups first
 * (`estimateRunCreditsByAgent`) and hands back a memoised lookup — the same
 * arithmetic over the same rows, so a card and the dialog it opens cannot quote
 * different numbers because one of them took a shortcut.
 *
 * THE CAP IS NO LONGER APPLIED HERE, and the note that used to stand here said
 * why it had to be: the server sampled the newest N jobs of ANY kind and then
 * filtered to one agent, so this had to cap the same way or quote a different
 * set of runs. That was true of a defect, not of a design — a client running six
 * agents could have every one of their newest 50 jobs belong to a different
 * agent, leaving the server with no sample at all while a card had ten. The cap
 * now lives inside `recentRunCostsUsd`, applied AFTER the agent filter it is a
 * cap on, and the server reads only this client's runs of this agent
 * (`listJobsByClientAndAgent`). Both sides therefore run the identical function
 * over the same rows, which is the property this module exists to hold.
 */
export function runPriceQuotes(input: {
  clientId: string;
  jobs: readonly Job[];
  /** The agent behind an id, for the fallback ladder. Absent ⇒ the generic rate. */
  agentFor: (customAgentId: string) => { key: string; creditCost?: number | null } | undefined;
}): (customAgentId: string) => RunPriceQuote {
  const planV2 = isCreditsPlanV2Enabled();
  const fallbackFor = (id: string) => {
    const agent = input.agentFor(id);
    return agent ? runPriceFallback(agent) : CREDIT_COSTS.customAgentRun;
  };
  if (!planV2) {
    return (id) => ({ credits: fallbackFor(id), isEstimate: false, fallback: true, samples: 0 });
  }
  const estimateFor = estimateRunCreditsByAgent(input.jobs, {
    clientId: input.clientId,
    fallbackCreditsFor: fallbackFor,
  });
  return (id) => {
    const estimate = estimateFor(id);
    return {
      credits: estimate.credits,
      isEstimate: true,
      fallback: estimate.fallback,
      samples: estimate.samples,
    };
  };
}
