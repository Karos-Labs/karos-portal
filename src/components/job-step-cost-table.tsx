import { Card, CardTitle, Badge } from "@/components/ui";
import { cn } from "@/lib/utils";
import { fmtCost, fmtTokens } from "@/lib/data-analytics";
import type { JobStepBreakdownEntry } from "@/lib/types";

const STATUS_LABEL: Record<JobStepBreakdownEntry["status"], string> = {
  completed: "Completed",
  failed: "Failed",
  skipped: "Not reached",
};

/**
 * Per-step token/cost breakdown for a Dynamic Agent Studio run — sorted most
 * expensive first, with the single costliest step called out, so staff can
 * see at a glance which step of the pipeline is worth optimizing. Renders
 * nothing when `stepBreakdown` is empty (every non-dynamic and every legacy
 * job) — this is a purely additive surface, never a replacement for the
 * run-level "Agent run" card beside it.
 */
export function JobStepCostTable({ steps }: { steps: JobStepBreakdownEntry[] }) {
  if (steps.length === 0) return null;

  // Descending by cost, so the costliest step is always sorted[0] — no
  // second scan needed to find it.
  const sorted = [...steps].sort((a, b) => (b.costUsd ?? 0) - (a.costUsd ?? 0));
  const mostExpensiveId = (sorted[0]?.costUsd ?? 0) > 0 ? sorted[0]?.stepId : undefined;

  return (
    <Card>
      <CardTitle className="mb-3">Step cost breakdown</CardTitle>
      <div className="overflow-x-auto">
        <table className="w-full text-sm">
          <thead>
            <tr className="text-left text-xs text-muted-2">
              <th className="pb-2 pr-3 font-normal">Step</th>
              <th className="pb-2 pr-3 font-normal">Model</th>
              <th className="pb-2 pr-3 text-right font-normal">Tokens in / out</th>
              <th className="pb-2 pr-3 text-right font-normal">Cost</th>
              <th className="pb-2 text-right font-normal">Duration</th>
            </tr>
          </thead>
          <tbody>
            {sorted.map((step) => {
              const isMostExpensive = step.stepId === mostExpensiveId;
              return (
                <tr key={step.stepId} className="border-t border-border">
                  <td className="max-w-[160px] truncate py-2 pr-3">
                    <span className={cn(isMostExpensive && "font-medium text-neon")}>{step.stepName}</span>
                    {step.status !== "completed" && (
                      <Badge tone={step.status === "failed" ? "danger" : "neutral"} className="ml-2">
                        {STATUS_LABEL[step.status]}
                      </Badge>
                    )}
                  </td>
                  <td className="py-2 pr-3 text-xs text-muted-2">{step.modelUsed ?? "-"}</td>
                  <td className="py-2 pr-3 text-right text-xs">
                    {step.inputTokens !== undefined
                      ? `${fmtTokens(step.inputTokens)} / ${fmtTokens(step.outputTokens ?? 0)}`
                      : "-"}
                  </td>
                  <td className={cn("py-2 pr-3 text-right text-xs", isMostExpensive && "font-medium text-neon")}>
                    {step.costUsd !== undefined ? fmtCost(step.costUsd) : "-"}
                  </td>
                  <td className="py-2 text-right text-xs text-muted-2">
                    {(step.durationMs / 1000).toFixed(1)}s
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
    </Card>
  );
}
