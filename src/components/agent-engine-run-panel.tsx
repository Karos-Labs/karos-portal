import { Card, CardTitle, Badge } from "@/components/ui";
import { fmtCost } from "@/lib/data-analytics";
import { AgentEngineGateApproval } from "@/components/agent-engine-gate-approval";
import { AgentEngineStepOutputs } from "@/components/agent-engine-step-outputs";
import { Icon } from "@/components/icon";
import { formatDateTime } from "@/lib/utils";
import type { AgentEngineGateRecord, AgentEngineRunView } from "@/lib/agent-engine/read-run";
import { autoApproveDeadlineMs, isArchivedOutput, totalStepCostUsd } from "@/lib/agent-engine/read-run";
import { runAgentTranscripts, stepOutputPreviews } from "@/lib/agent-engine/step-transcript";
import { agentEngineStepStatusBadge } from "@/lib/agent-engine/step-status";

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

/** A `gate` step's kind badge, so a human-approval row is distinguishable from the deterministic code steps around it. */
const STEP_KIND_BADGE: Readonly<Record<AgentEngineRunView["steps"][number]["kind"], { label: string; tone: "neutral" | "info" } | undefined>> = {
  code: undefined,
  agent: { label: "ai", tone: "neutral" },
  gate: { label: "human", tone: "info" },
};

/** The engine's own actor string for a decision its timeout made — `GATE_TIMEOUT_ACTOR` in agent-engine's `step-gate.ts`. */
const GATE_TIMEOUT_ACTOR = "system:gate-timeout";

const DECISION_LABEL: Readonly<Record<NonNullable<AgentEngineGateRecord["response"]>["decision"], string>> = {
  approve: "Approved",
  revise: "Changes requested",
  reject: "Rejected",
};

/**
 * A gate the run is parked at that already has its decision: who decided
 * what, when, and that the run is continuing with it. Replaces the approval
 * panel, whose buttons would all meet a 409 here.
 */
function ResolvedGateNotice({ gate }: { gate: AgentEngineGateRecord }) {
  const response = gate.response!;
  const byTimeout = response.actor === GATE_TIMEOUT_ACTOR;
  const note = response.feedback ?? response.reason ?? response.notes;
  return (
    <div className="mt-3 space-y-1.5 rounded-md border border-border bg-surface-2/40 p-3">
      <div className="flex flex-wrap items-center gap-2">
        <Icon name={response.decision === "reject" ? "CircleX" : "CircleCheck"} className="h-4 w-4 shrink-0 text-muted" />
        <span className="text-sm font-medium">
          {byTimeout ? `Approved automatically at ${formatDateTime(response.at)}` : `${DECISION_LABEL[response.decision]} by ${response.actor} at ${formatDateTime(response.at)}`}
        </span>
        <Badge tone="neutral">{gate.gateId}</Badge>
      </div>
      <p className="text-xs text-muted-2">
        {byTimeout
          ? `Nobody decided within its ${gate.timeout?.duration ?? "review"} window, so the draft approved itself. `
          : ""}
        The run is continuing with this decision — there is nothing left to decide on this round. This page follows along as it moves.
      </p>
      {note && <p className="whitespace-pre-wrap text-xs text-muted">“{note}”</p>}
    </div>
  );
}

/**
 * While a gate is still open: when it will stop waiting. An `auto_approve`
 * gate ships the draft itself once its window closes — a reviewer deciding
 * whether to come back after lunch should know that.
 */
function AutoApproveDeadline({ gate, steps }: { gate: AgentEngineGateRecord; steps: AgentEngineRunView["steps"] }) {
  const deadline = autoApproveDeadlineMs(gate, steps);
  if (deadline === undefined) return null;
  // No "overdue" variant: a server component must not read the clock during
  // render (the React compiler rule), and a gate past its window with no
  // decision yet is exactly what the engine's sweep, or the next touch of the
  // run, turns into the resolved notice above — the page follows.
  return (
    <p className="mt-3 text-xs text-muted-2">
      <Icon name="Clock" className="mr-1 inline h-3.5 w-3.5 align-text-bottom" />
      Approves itself at {formatDateTime(deadline)} if nobody decides ({gate.timeout?.duration} window).
    </p>
  );
}

/**
 * Task 3's Job-view panel for a run dispatched through agent-engine: live
 * stage progress, per-step latency/cost, the agent's own reasoning transcript,
 * and a human-approval action when the run is paused at a gate — read straight
 * from `agentEngineRuns/{runId}` and its `steps` subcollection (`read-run.ts`),
 * not from `job.status`/`job.dynamicRun`.
 *
 * THAT PARENTHETICAL USED TO SAY "nothing updates those for this dispatch path
 * yet", and it has been wrong since Task 2 (corrected by SCRUM-404).
 * `syncAgentEngineJobStatusFromView` (`reconcile.ts`) is the reverse completion
 * channel, and describes itself as "the only way `job.status` ever changes for
 * a job dispatched through agent-engine". This panel reads the run record
 * anyway, because it needs per-step progress, per-step cost and the paused
 * gate's payload, none of which `job.status` carries — a different reason from
 * the one that used to be written here. The stale one cost real time: SCRUM-404
 * was filed partly on the belief that a `degraded`/`blocked_intake` status
 * "never arrives", when in fact it arrives FLATTENED, both mapping onto
 * `job.status: "failed"`. Purely
 * additive: this card sits alongside the job's existing legacy status
 * badge/step UI, never replaces it, and the caller only renders it at all when
 * `job.agentEngineRunId` is set.
 *
 * THREE THINGS IT USED TO DROP, all of them already in the records it reads:
 *
 *  • the paused gate's PAYLOAD — the draft being approved. Fetched by
 *    `readAgentEngineRun`, then not passed on: `AgentEngineGateApproval` got
 *    the `gateId` and nothing else, so Approve was pressed on unseen text.
 *  • the agent step's TRANSCRIPT. `step.agent` checkpoints the whole
 *    `AgentExecutionResult` — every thought, tool call and tool result — as
 *    that step's `output`. This table rendered it as a cost and a duration.
 *  • every other step's OUTPUT, including a resolved gate's decision.
 *
 * The table stays what it was (one scannable row per step); everything above
 * hangs off it as collapsed disclosures below, so nothing that was legible
 * became less so.
 */
export function AgentEngineRunPanel({ jobId, view }: { jobId: string; view: AgentEngineRunView }) {
  const { run, steps, pendingGate } = view;
  const totalCostUsd = run.totalCostUsd ?? totalStepCostUsd(steps);
  const transcripts = runAgentTranscripts(steps);
  const previews = stepOutputPreviews(steps);

  return (
    <Card>
      <div className="mb-3 flex items-center justify-between">
        <CardTitle>Agent engine run</CardTitle>
        <Badge tone={RUN_STATUS_TONE[run.status]}>{RUN_STATUS_LABEL[run.status]}</Badge>
      </div>

      <div className="mb-3 flex flex-wrap gap-4 text-xs text-muted-2">
        <span>Product: {run.productId}</span>
        <span>Total cost: {fmtCost(totalCostUsd)}</span>
        {/* `reason` is a held/blocked_intake explanation, NOT a failure — see
            RunRecord's own note on the two being kept apart. Only
            `failureReason` is painted as danger; a reason reads as ordinary
            copy, because "nothing cleared the gates" is an outcome, not a
            breakage. */}
        {run.failureReason && <span className="text-danger">{run.failureReason}</span>}
        {!run.failureReason && run.reason && <span>{run.reason}</span>}
      </div>

      {/* A gate that already carries a decision gets a notice, not buttons.
          Until 2026-09-22 this rendered the approval panel for ANY gate the
          run was parked at, so a reviewer could press "Request changes" on a
          gate that had already been decided (by a person, or by its own
          timeout) and meet a 409 — three times, with the buttons still lit
          and nothing on the page saying why. The engine now applies the
          recorded decision on its own; this is what the person sees meanwhile. */}
      {pendingGate && pendingGate.response && <ResolvedGateNotice gate={pendingGate} />}
      {pendingGate && !pendingGate.response && (
        <>
          <AutoApproveDeadline gate={pendingGate} steps={steps} />
          <AgentEngineGateApproval
            jobId={jobId}
            gateId={pendingGate.gateId}
            kind={pendingGate.kind}
            payload={pendingGate.payload}
            requiredRole={pendingGate.requiredRole}
          />
        </>
      )}

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
            {steps.map((step) => {
              const kindBadge = STEP_KIND_BADGE[step.kind];
              return (
                <tr key={step.stepId} className={`border-t border-border ${step.stepId === run.currentStepId && step.status === "running" ? "bg-info/5" : ""}`}>
                  <td className="max-w-[220px] truncate py-2 pr-3">
                    {step.stepId}
                    {kindBadge && <Badge tone={kindBadge.tone} className="ml-2">{kindBadge.label}</Badge>}
                  </td>
                  <td className="py-2 pr-3">
                    {/* AU68 (SCRUM-366): agent-engine's step status is a
                        seven-value vocabulary, not a tri-state. The mapping —
                        and the argument for which of them are faults — lives in
                        `agentEngineStepStatusBadge` so it can be tested. */}
                    <Badge tone={agentEngineStepStatusBadge(step).tone}>{agentEngineStepStatusBadge(step).label}</Badge>
                  </td>
                  <td className="py-2 pr-3 text-right text-xs">{step.costUsd !== undefined ? fmtCost(step.costUsd) : "—"}</td>
                  <td className="py-2 text-right text-xs text-muted-2">{step.durationMs !== undefined ? `${(step.durationMs / 1000).toFixed(1)}s` : "—"}</td>
                </tr>
              );
            })}
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

      <AgentEngineStepOutputs transcripts={transcripts} previews={previews} />
    </Card>
  );
}
