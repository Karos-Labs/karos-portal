import type { DynamicAgentRunReport, JobStepBreakdownEntry } from "@/lib/types";

/**
 * Reshapes a Dynamic Agent Studio run's per-step report into the Job Control
 * Room's own analytics vocabulary — token sums and a USD cost per step, never
 * a "credits" figure (this codebase never derives credits from tokens
 * anywhere; see JobStepBreakdownEntry's own doc comment).
 *
 * Pure and total: every entry in `report.steps` produces exactly one row,
 * in the same order, so the caller can zip it back against `report.steps`
 * (e.g. to find a step's original label) if it ever needs to.
 */
export function buildStepBreakdown(report: DynamicAgentRunReport): JobStepBreakdownEntry[] {
  return report.steps.map((step) => {
    const models = Object.values(step.usage?.models ?? {});
    const inputTokens = models.reduce((sum, m) => sum + m.inputTokens, 0);
    const outputTokens = models.reduce((sum, m) => sum + m.outputTokens, 0);
    return {
      stepId: step.stepId,
      stepName: step.label || step.stepId,
      stepType: step.type,
      ...(models.length > 0 ? { inputTokens, outputTokens } : {}),
      ...(step.usage?.totalCostUsd !== undefined ? { costUsd: step.usage.totalCostUsd } : {}),
      ...(step.model ? { modelUsed: step.model } : {}),
      durationMs: step.durationMs,
      status: step.status === "done" ? "completed" : "failed",
    };
  });
}

export interface WriteCheckpointLike {
  /** Repo-relative path, matching agent-service's WriteCheckpoint. */
  path: string;
  /** Wall-clock ms since the run started — same basis as `runDurationMs`. */
  atMs: number;
}

/**
 * The leading `NN-`/`NN_` numbered segment of a checkpoint path is the step
 * boundary where a skill follows that convention (linkedin-agent-v2:
 * `01-run.json` ... `12-commit.json`); the file's own basename is the
 * fallback for a skill that doesn't. Either way this collapses MULTIPLE
 * writes into the same conceptual step (e.g. `07-drafts/p01/attempt-1.md`
 * and `07-drafts/p02/attempt-1.md` for two posts in one run) into one row,
 * keyed by whichever write happened first.
 */
function stepKeyFor(relPath: string): string {
  const segments = relPath.split("/").filter(Boolean);
  const numbered = segments.find((s) => /^\d+[-_]/.test(s));
  const raw = numbered ?? segments[segments.length - 1] ?? relPath;
  return raw.replace(/\.[a-zA-Z0-9]+$/, "");
}

/** "06-angles" -> "Angles"; "content-ledger" -> "Content Ledger". */
function humanizeStepKey(key: string): string {
  const spaced = key.replace(/^\d+[-_]/, "").replace(/[-_]+/g, " ").trim();
  return spaced.length > 0 ? spaced.replace(/\b\w/g, (c) => c.toUpperCase()) : key;
}

/**
 * The hardcoded custom-agent path's ESTIMATE of a per-step breakdown — see
 * JobStepBreakdownEntry's doc comment for why this exists and how it differs
 * from `buildStepBreakdown`'s exact Dynamic Agent Studio rows. There is no
 * real per-step usage to read here, only WHEN each checkpoint file was
 * written; the run's total cost/tokens are prorated across the resulting
 * intervals by wall-clock share. `[]` when there are no checkpoints at all
 * (a skill that doesn't checkpoint its progress this way) — the caller
 * should simply not set `Job.stepBreakdown` in that case, same as today.
 */
export function buildStepBreakdownFromCheckpoints(
  checkpoints: WriteCheckpointLike[],
  runDurationMs: number,
  totals: { costUsd?: number; inputTokens: number; outputTokens: number },
  runFailed: boolean,
): JobStepBreakdownEntry[] {
  if (checkpoints.length === 0) return [];

  const firstSeenAt = new Map<string, number>();
  for (const cp of checkpoints) {
    const key = stepKeyFor(cp.path);
    const existing = firstSeenAt.get(key);
    if (existing === undefined || cp.atMs < existing) firstSeenAt.set(key, cp.atMs);
  }
  const ordered = [...firstSeenAt.entries()]
    .map(([key, startMs]) => ({ key, startMs }))
    .sort((a, b) => a.startMs - b.startMs);

  // Guards against a degenerate 0ms/negative duration (a checkpoint firing
  // at the same instant the run "started", or a clock anomaly) rather than
  // dividing by zero or reporting a negative share.
  const denom = Math.max(runDurationMs, 1);

  return ordered.map((group, i) => {
    const nextStart = ordered[i + 1]?.startMs ?? runDurationMs;
    const durationMs = Math.max(nextStart - group.startMs, 0);
    const share = durationMs / denom;
    const isLast = i === ordered.length - 1;
    return {
      stepId: group.key,
      stepName: humanizeStepKey(group.key),
      stepType: "ai",
      inputTokens: Math.round(totals.inputTokens * share),
      outputTokens: Math.round(totals.outputTokens * share),
      ...(totals.costUsd !== undefined ? { costUsd: totals.costUsd * share } : {}),
      durationMs,
      status: isLast && runFailed ? "failed" : "completed",
      estimated: true,
    };
  });
}
