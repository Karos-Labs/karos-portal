import { Icon } from "@/components/icon";
import { cn } from "@/lib/utils";
import { fmtCost, fmtTokens } from "@/lib/data-analytics";
import type { DynamicAgentRunReport, DynamicAgentRunStep, JobStatus, JobStepBreakdownEntry } from "@/lib/types";

function formatCostLine(step: { inputTokens?: number; outputTokens?: number; costUsd?: number }): string | null {
  const parts: string[] = [];
  if (step.inputTokens !== undefined) parts.push(`${fmtTokens(step.inputTokens)} in`);
  if (step.outputTokens !== undefined) parts.push(`${fmtTokens(step.outputTokens)} out`);
  if (step.costUsd !== undefined) parts.push(fmtCost(step.costUsd));
  return parts.length > 0 ? parts.join(" · ") : null;
}

type StepTone = "done" | "active" | "failed" | "skipped" | "idle";

const TONE_LABEL: Record<StepTone, string> = {
  done: "Completed",
  active: "Working",
  failed: "Failed",
  skipped: "Not reached",
  idle: "Not started",
};

const TONE_ICON: Record<StepTone, string> = {
  done: "CircleCheckBig",
  active: "Bot",
  failed: "CircleAlert",
  skipped: "CircleDashed",
  idle: "Circle",
};

const TONE_CHIP: Record<StepTone, string> = {
  done: "border-success/40 bg-success/10 text-success",
  active: "border-info/40 bg-info/10 text-info",
  failed: "border-danger/40 bg-danger/10 text-danger",
  skipped: "border-border bg-surface-2 text-muted-2",
  idle: "border-border bg-surface-2 text-muted-2",
};

const TYPE_ICON: Record<DynamicAgentRunStep["type"], string> = {
  ai: "Sparkles",
  code: "Code",
};

/**
 * Step-by-step progress for a Dynamic Agent Studio run — one row per step of
 * the spec's pipeline, each coloured by its OWN recorded status.
 *
 * This is the dynamic-agent counterpart of CampaignStepProgress (which does the
 * same job for a campaign's dependency-wired tasks), and it deliberately copies
 * that component's two rules:
 *
 *  1. Pure render. Everything comes from the `dynamicRun` report the caller
 *     already fetched off the job; there is no data fetching here.
 *  2. The stored per-step `error` is a raw engine diagnostic and has ZERO
 *     client-facing text readers — the tone decides the sentence, and the
 *     sentence is fixed. A model refusal or a script stack fragment must never
 *     reach a client's screen, so `step.error` is not printed. Staff read it
 *     from the run's internal trace artifact.
 *
 * `steps` in the report only contains steps that actually EXECUTED, because a
 * run stops at its first failure. `plannedSteps` (from the spec snapshot, when
 * the caller has it) lets the bar also show the steps that were never reached,
 * which is the difference between "the run is 2 steps long" and "the run was 5
 * steps long and died at 2".
 *
 * `currentStepId`/`completedStepIds` (from the job.step_progress webhook, see
 * Job.currentStepId/Job.completedStepIds) are the AUTHORITATIVE live-progress
 * signal when present — updated WHILE the run is still in flight, before any
 * `report` exists at all. `report` is therefore optional: the caller mounts
 * this component the moment a run starts (see jobs/[id]/page.tsx, gated on
 * `job.dynamicAgentSpecId` rather than `job.dynamicRun`), and only gets a
 * `report` once the run reaches a terminal state and the completion webhook
 * writes `Job.dynamicRun`. Absent `currentStepId` (a legacy job mid-flight
 * before this shipped, or once the run is terminal and the completion
 * webhook has cleared it) falls back to the old heuristic (first
 * not-yet-executed row of an in-flight job).
 */
export function DynamicAgentStepProgress({
  report,
  jobStatus,
  plannedSteps,
  currentStepId,
  completedStepIds,
  stepBreakdown,
}: {
  report?: DynamicAgentRunReport;
  jobStatus: JobStatus;
  plannedSteps?: Array<{ id: string; label: string; type: DynamicAgentRunStep["type"] }>;
  currentStepId?: string | null;
  completedStepIds?: string[];
  stepBreakdown?: JobStepBreakdownEntry[];
}) {
  const steps = report?.steps ?? [];
  const executed = new Map(steps.map((s) => [s.stepId, s]));
  const liveDone = new Set(completedStepIds ?? []);
  const cost = new Map((stepBreakdown ?? []).map((s) => [s.stepId, s]));
  const rows: Array<{
    key: string;
    label: string;
    type: DynamicAgentRunStep["type"];
    tone: StepTone;
    model?: string;
    durationMs?: number;
    costLine?: string;
  }> = (plannedSteps && plannedSteps.length > 0
      ? plannedSteps
      : steps.map((s) => ({ id: s.stepId, label: s.label, type: s.type }))
    ).map((planned) => {
      const run = executed.get(planned.id);
      let tone: StepTone;
      // A step can be "done" two ways: the terminal report says so, or —
      // while the run is still in flight and no report exists yet — the
      // live job.step_progress channel already marked it complete. Without
      // this second check, every step that finished before the run's FIRST
      // webhook delivery would show as "idle"/"not started" for the whole
      // remainder of the run, which is exactly backwards.
      if (run?.status === "failed") tone = "failed";
      else if (run?.status === "done" || liveDone.has(planned.id)) tone = "done";
      else if (currentStepId ? currentStepId === planned.id : jobStatus === "running" || jobStatus === "queued") {
        tone = "active";
      } else tone = report?.failedStepId ? "skipped" : "idle";
      const costEntry = cost.get(planned.id);
      const costLine = costEntry ? formatCostLine(costEntry) : null;
      return {
        key: planned.id,
        label: planned.label || planned.id,
        type: planned.type,
        tone,
        ...(run?.model ? { model: run.model } : {}),
        ...(run?.durationMs !== undefined ? { durationMs: run.durationMs } : {}),
        ...(costLine ? { costLine } : {}),
      };
    });

  // Only the FIRST not-yet-run step of an in-flight job is "Working"; the ones
  // after it are still waiting, and saying three steps are working at once
  // would be a lie the client can see. Skipped entirely once `currentStepId`
  // names the active row directly — at most one row can ever match it.
  if (!currentStepId) {
    const firstPending = rows.findIndex((r) => r.tone === "active");
    if (firstPending !== -1) {
      rows.forEach((row, i) => {
        if (row.tone === "active" && i !== firstPending) row.tone = "idle";
      });
    }
  }

  return (
    <div className="mb-6 space-y-2 rounded-[var(--radius)] border border-border bg-surface p-4">
      {report?.failedStepId && report?.hasPartialOutput ? (
        <p className="mb-2 rounded-md border border-warning/40 bg-warning/10 px-3 py-2 text-xs text-warning">
          This run stopped partway through. The work the earlier steps finished is included below and is
          incomplete.
        </p>
      ) : null}

      {rows.map((row, i) => (
        <div key={row.key} className="flex items-start gap-3">
          <div className="flex flex-col items-center">
            <div
              className={cn(
                "flex h-8 w-8 shrink-0 items-center justify-center rounded-full border",
                TONE_CHIP[row.tone],
              )}
            >
              <Icon
                name={row.tone === "idle" || row.tone === "skipped" ? TYPE_ICON[row.type] : TONE_ICON[row.tone]}
                className={cn("h-4 w-4", row.tone === "active" && "animate-pulse")}
              />
            </div>
            {i < rows.length - 1 && <div className="my-1 h-6 w-px bg-border" />}
          </div>
          <div className="min-w-0 flex-1 pb-2">
            <div className="flex flex-wrap items-center gap-2">
              <p className="truncate text-sm font-medium text-foreground">{row.label}</p>
              <span
                className={cn(
                  "shrink-0 rounded-[4px] border px-1.5 py-0.5 font-mono text-[10px] uppercase tracking-[0.08em]",
                  TONE_CHIP[row.tone],
                )}
              >
                {TONE_LABEL[row.tone]}
              </span>
            </div>
            {/* The stored per-step error is a raw engine diagnostic with no
                client-facing readers — the tone carries the meaning and the
                sentence is fixed, exactly as in CampaignStepProgress. */}
            {row.tone === "failed" && (
              <p className="mt-0.5 truncate text-xs text-danger">
                This step hit a problem. Your Karos team is on it.
              </p>
            )}
            {row.costLine && <p className="mt-0.5 truncate text-xs text-muted-2">{row.costLine}</p>}
          </div>
        </div>
      ))}
    </div>
  );
}
