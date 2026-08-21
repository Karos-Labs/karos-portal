import { Card, CardTitle, Badge } from "@/components/ui";
import { fmtCost } from "@/lib/data-analytics";
import { AgentEngineGateApproval } from "@/components/agent-engine-gate-approval";
import type { AgentEngineRunView } from "@/lib/agent-engine/read-run";
import { isArchivedOutput, totalStepCostUsd } from "@/lib/agent-engine/read-run";

const RUN_STATUS_TONE: Record<AgentEngineRunView["run"]["status"], "neutral" | "success" | "warning" | "danger" | "info"> = {
  running: "info",
  completed: "success",
  failed: "danger",
  degraded: "warning",
  awaiting_gate: "warning",
  held: "neutral",
  blocked_intake: "warning",
};

const RUN_STATUS_LABEL: Record<AgentEngineRunView["run"]["status"], string> = {
  running: "Running",
  completed: "Completed",
  failed: "Failed",
  degraded: "Degraded",
  awaiting_gate: "Awaiting approval",
  held: "Held — nothing to deliver",
  blocked_intake: "Blocked — missing client input",
};

/**
 * Task 3's Job-view panel for a run dispatched through agent-engine: live
 * stage progress, per-step latency/cost, and a human-approval action when
 * the run is paused at a gate — read straight from `agentEngineRuns/{runId}`
 * and its `steps` subcollection (`read-run.ts`), not from `job.status`/
 * `job.dynamicRun` (nothing updates those for this dispatch path yet — see
 * `ExternalJobInfo`'s own doc comment). Purely additive: this card sits
 * alongside the job's existing legacy status badge/step UI, never replaces
 * it, and the caller only renders it at all when `job.agentEngineRunId` is
 * set.
 */
export function AgentEngineRunPanel({ jobId, view }: { jobId: string; view: AgentEngineRunView }) {
  const { run, steps, pendingGate } = view;
  const totalCostUsd = run.totalCostUsd ?? totalStepCostUsd(steps);

  return (
    <Card>
      <div className="mb-3 flex items-center justify-between">
        <CardTitle>Agent engine run</CardTitle>
        <Badge tone={RUN_STATUS_TONE[run.status]}>{RUN_STATUS_LABEL[run.status]}</Badge>
      </div>

      <div className="mb-3 flex flex-wrap gap-4 text-xs text-muted-2">
        <span>Product: {run.productId}</span>
        <span>Total cost: {fmtCost(totalCostUsd)}</span>
        {(run.failureReason ?? run.reason) && <span className="text-danger">{run.failureReason ?? run.reason}</span>}
      </div>

      {pendingGate && <AgentEngineGateApproval jobId={jobId} gateId={pendingGate.gateId} />}

      <div className="mt-3 overflow-x-auto">
        <table className="w-full text-sm">
          <thead>
            <tr className="text-left text-xs text-muted-2">
              <th className="pb-2 pr-3 font-normal">Step</th>
              <th className="pb-2 pr-3 font-normal">Status</th>
              <th className="pb-2 pr-3 text-right font-normal">Cost</th>
              <th className="pb-2 text-right font-normal">Duration</th>
            </tr>
          </thead>
          <tbody>
            {steps.map((step) => (
              <tr key={step.stepId} className={`border-t border-border ${step.stepId === run.currentStepId && step.status === "running" ? "bg-info/5" : ""}`}>
                <td className="max-w-[220px] truncate py-2 pr-3">
                  {step.stepId}
                  {step.kind === "agent" && <Badge tone="neutral" className="ml-2">ai</Badge>}
                </td>
                <td className="py-2 pr-3">
                  {step.status === "running" ? (
                    <Badge tone="info">Running…</Badge>
                  ) : step.status === "completed" ? (
                    <Badge tone="success">Done</Badge>
                  ) : (
                    <Badge tone="danger">{step.error ?? "Failed"}</Badge>
                  )}
                </td>
                <td className="py-2 pr-3 text-right text-xs">{step.costUsd !== undefined ? fmtCost(step.costUsd) : "—"}</td>
                <td className="py-2 text-right text-xs text-muted-2">{step.durationMs !== undefined ? `${(step.durationMs / 1000).toFixed(1)}s` : "—"}</td>
              </tr>
            ))}
            {steps.length === 0 && (
              <tr>
                <td colSpan={4} className="py-3 text-center text-xs text-muted-2">
                  No steps recorded yet.
                </td>
              </tr>
            )}
          </tbody>
        </table>
      </div>
      {steps.some((s) => isArchivedOutput(s.output)) && (
        <p className="mt-2 text-xs text-muted-2">
          One or more steps produced output too large for Firestore — the full payload is archived to GCS; this view shows its size only.
        </p>
      )}
    </Card>
  );
}
