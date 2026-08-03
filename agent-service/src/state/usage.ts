import type { JobUsage, ModelTokenUsage } from "../types.js";

function addOptional(a: number | undefined, b: number | undefined): number | undefined {
  if (a === undefined && b === undefined) return undefined;
  return (a ?? 0) + (b ?? 0);
}

function addModelUsage(a: ModelTokenUsage, b: ModelTokenUsage): ModelTokenUsage {
  const usage: ModelTokenUsage = {
    inputTokens: a.inputTokens + b.inputTokens,
    outputTokens: a.outputTokens + b.outputTokens,
    cacheReadInputTokens: a.cacheReadInputTokens + b.cacheReadInputTokens,
    cacheCreationInputTokens: a.cacheCreationInputTokens + b.cacheCreationInputTokens,
  };
  const costUsd = addOptional(a.costUsd, b.costUsd);
  if (costUsd !== undefined) usage.costUsd = costUsd;
  return usage;
}

/**
 * Sums usage across job attempts. A transient failure requeues the whole job
 * (see queue/worker.ts), and each attempt re-runs the SDK loop from scratch —
 * every attempt burns real Anthropic tokens even if only the last one
 * succeeds. Without this, `/internal/jobs/:id/complete` overwrote `usage` per
 * attempt, so the webhook (and therefore usageLogs/cost-to-date) only ever
 * reflected the final attempt while Anthropic billed for all of them.
 */
export function mergeJobUsage(prev: JobUsage | undefined, next: JobUsage | undefined): JobUsage | undefined {
  if (!next) return prev;
  if (!prev) return next;
  const models: Record<string, ModelTokenUsage> = { ...prev.models };
  for (const [model, usage] of Object.entries(next.models)) {
    const existing = models[model];
    models[model] = existing ? addModelUsage(existing, usage) : usage;
  }
  const usage: JobUsage = { models };
  const totalCostUsd = addOptional(prev.totalCostUsd, next.totalCostUsd);
  if (totalCostUsd !== undefined) usage.totalCostUsd = totalCostUsd;
  const numTurns = addOptional(prev.numTurns, next.numTurns);
  if (numTurns !== undefined) usage.numTurns = numTurns;
  return usage;
}
