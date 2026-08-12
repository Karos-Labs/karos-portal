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
