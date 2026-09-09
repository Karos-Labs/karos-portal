import "server-only";

/**
 * Output de-duplication — the history half (docs/dynamic-agent-guardrails.md).
 *
 * Assembles the deliverables this SAME dynamic agent already produced for this
 * client, so a run that opted into `dedupeAgainstHistory` can be told what not
 * to repeat.
 *
 * // DECISION: this mirrors the EXISTING `priorBatchFiles` pattern the X /
 * LinkedIn / Reddit agents already use (see x-agent-context.ts) rather than
 * inventing a second way to read a client's back catalogue — list the client's
 * jobs, keep the ones from this agent that reached a reviewed terminal state
 * and produced an asset, newest first, take the most recent few, read each
 * one's asset content. The one deliberate improvement: those agents must key
 * off `agentName` because a hardcoded agent carries no spec id, so renaming
 * one orphans its history. A dynamic run carries `dynamicAgentSpecId`, which
 * is stable across renames, so this keys off that instead.
 */

import { getAsset, listJobs } from "@/lib/data";
import type { DynamicAgentHistoryItem, JobStatus } from "@/lib/types";

/**
 * How many prior runs a de-duplicating agent is shown.
 *
 * Five is enough for the model to recognise "I keep opening the same way"
 * across a month of weekly output, and bounded enough that the injected block
 * cannot dominate the final step's prompt. Both caps are load-bearing: the
 * history travels inline on the brief, so the product of these two numbers is
 * the worst case it can add to a payload (~20KB).
 */
export const DYNAMIC_AGENT_HISTORY_RUNS = 5;
export const DYNAMIC_AGENT_HISTORY_EXCERPT_CHARS = 4_000;

/**
 * Only these statuses count as "this was really produced".
 *
 * A queued/running job has no output yet, and a failed or cancelled one
 * produced nothing worth avoiding repetition of. The same three the prior-batch
 * readers use.
 */
const DELIVERED_STATUSES: JobStatus[] = ["review", "approved", "delivered"];

/**
 * Prior deliverables for (spec, client), newest first.
 *
 * Returns [] — never throws — when there is no history, so the caller can
 * attach it unconditionally: an agent with the flag on and nothing produced
 * yet just runs normally with nothing injected.
 */
export async function buildDynamicAgentHistory(
  specId: string,
  clientId: string,
): Promise<DynamicAgentHistoryItem[]> {
  const jobs = (await listJobs({ clientId }))
    .filter(
      (job) =>
        job.dynamicAgentSpecId === specId &&
        DELIVERED_STATUSES.includes(job.status) &&
        job.assetIds.length > 0,
    )
    .sort((a, b) => b.createdAt - a.createdAt)
    .slice(0, DYNAMIC_AGENT_HISTORY_RUNS);

  // Read the prior deliverables in PARALLEL (review, 2026-09): this runs inside
  // the submit action, and each sequential read was wall-clock the person
  // launching the run sat through. Mapping preserves order (newest first).
  const items = await Promise.all(
    jobs.map(async (job): Promise<DynamicAgentHistoryItem | null> => {
      // The run's primary deliverable is its first asset — the same join
      // (job.assetIds[0] -> getAsset) the prior-batch readers and the job detail
      // page both use. A dynamic run creates exactly one asset.
      const assetId = job.assetIds[0];
      if (!assetId) return null;
      const asset = await getAsset(assetId);
      const content = asset?.content?.trim();
      if (!content) return null;
      return {
        jobId: job.id,
        createdAt: job.createdAt,
        excerpt: content.slice(0, DYNAMIC_AGENT_HISTORY_EXCERPT_CHARS),
      };
    }),
  );
  return items.filter((i): i is DynamicAgentHistoryItem => i !== null);
}
