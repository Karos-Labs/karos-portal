import { Icon } from "@/components/icon";
import { cn } from "@/lib/utils";

/**
 * What a run is doing RIGHT NOW, for the person who pressed the button.
 *
 * ── WHY THIS EXISTS ──────────────────────────────────────────────────────────
 *
 * Pressing Run used to produce a dialog that said the work would be ready in
 * about 30 minutes and invited you to close the page. Three things were wrong
 * with that at once. The number was never measured and is not true (see
 * `lib/run-estimate.ts`, which now carries the measurements). A modal that
 * tells you to go away is a dead end — it has nothing to return to. And the
 * portal already KNEW what the run was doing: `job.currentStepName` and
 * `agentEngineRuns.currentStepId` are both written live, and
 * `DynamicAgentStepProgress` has rendered them since the day they shipped —
 * but only on `/jobs/[id]`, which is `requireUser(["KAROS_ADMIN",
 * "KAROS_EMPLOYEE"])`. The client could not reach the one screen that answered
 * their question.
 *
 * So this is the client's half of that screen, and it is deliberately NOT a
 * second copy of the staff one. The staff bar carries model, cost and
 * per-step duration, because a staff reader is auditing the run. A client is
 * asking one question — is it working, and how far along — so this shows the
 * step it is on, the ones behind it, and a bar.
 *
 * ── THE BAR IS DETERMINATE ONLY WHEN THE TOTAL IS KNOWN ──────────────────────
 *
 * A percentage is a claim. Dynamic Agent Studio runs carry a planned step list
 * in the spec snapshot, so "4 of 9" is a fact and the bar can fill to it.
 * agent-engine writes its steps as they execute (`agentEngineRuns/{id}/steps`)
 * with no plan up front, so there is no honest denominator, and a bar that
 * invents one would be the "30 minutes" mistake in a new shape. Those runs get
 * a sweep instead: motion that says working, with no number attached.
 *
 * Server component: it renders what it is given. Nothing here polls — the
 * surfaces that mount it refresh on their own cadence, which keeps the refresh
 * decision (and its cost) with the page that owns the job.
 */

export type RunStepState = "done" | "active" | "pending" | "failed";

export interface RunProgressStep {
  id: string;
  /** Client-facing. Never a raw step id — see `runStepLabel`. */
  label: string;
  state: RunStepState;
}

const STATE_CHIP: Record<RunStepState, string> = {
  done: "border-success/40 bg-success/10 text-success",
  active: "border-neon/50 bg-neon/10 text-neon",
  pending: "border-border bg-surface-2 text-muted-3",
  failed: "border-danger/40 bg-danger/10 text-danger",
};

const STATE_ICON: Record<RunStepState, string> = {
  done: "Check",
  active: "LoaderCircle",
  pending: "Circle",
  failed: "X",
};

export function AgentRunProgress({
  steps,
  headline,
  done,
  total,
  finished = false,
}: {
  /** In order. Empty is legitimate: a run that has not reported a step yet. */
  steps: RunProgressStep[];
  /**
   * The one line that answers "what is it doing". The step name when the run
   * has reported one, and a plain fallback when it has not — never blank,
   * because an empty headline over a moving bar is the dead end again.
   */
  headline: string;
  /** Steps finished. Always known: it is a count of what already happened. */
  done: number;
  /**
   * Expected total, when the run declared a plan. Null means no honest
   * denominator exists and the bar sweeps instead of filling.
   */
  total: number | null;
  /** Terminal runs keep the list but stop animating and stop claiming to work. */
  finished?: boolean;
}) {
  const determinate = total != null && total > 0;
  const pct = determinate ? Math.min(100, Math.round((done / total!) * 100)) : null;

  return (
    <div className="rounded-[var(--radius)] border border-border bg-surface-2 p-4">
      <div className="flex items-center gap-2.5">
        {!finished && (
          <span
            className="h-2 w-2 shrink-0 rounded-full bg-neon animate-pulse-neon"
            aria-hidden="true"
          />
        )}
        <p className="min-w-0 flex-1 truncate text-sm font-medium text-foreground">{headline}</p>
        {/* The count, only when it is a real fraction. `done` alone ("4 steps
            done") is true but reads as a total to someone skimming, which is
            the false-denominator problem wearing a different hat. */}
        {determinate && (
          <span className="shrink-0 tabular text-xs text-muted-2">
            {done} of {total}
          </span>
        )}
      </div>

      {/* THE BAR. Orange fill on an orange track at low alpha — a run bar is
          data, and the accent ration governs controls (Albert, 2026-09-06). */}
      <div
        className="mt-3 h-1.5 overflow-hidden rounded-full bg-neon/15"
        role="progressbar"
        aria-label="Run progress"
        {...(determinate
          ? { "aria-valuenow": pct as number, "aria-valuemin": 0, "aria-valuemax": 100 }
          : {})}
      >
        {/* THREE CASES, AND ALL BUT THE LAST ONE MOVE. A determinate fill alone
            is indistinguishable from a fill that has STOPPED — the first
            screenshot of this component showed 17% and nothing else, which
            reads as a stalled run rather than a working one. So a live fill
            carries a sweep INSIDE itself: the width stays the honest number and
            the motion says the number is still going up. */}
        {finished ? (
          <div className="h-full w-full rounded-full bg-neon" />
        ) : determinate && pct! > 0 ? (
          <div
            className="relative h-full overflow-hidden rounded-full bg-neon transition-[width] duration-500"
            style={{ width: `${pct}%` }}
          >
            <div className="absolute inset-y-0 w-1/3 bg-accent-ink/25 animate-run-bar-sweep" />
          </div>
        ) : (
          // No fill to put motion inside: either the run has reported nothing
          // yet (0%), or it never declared a total. A quarter-width segment
          // sweeps the empty track instead. With reduced motion the sweep stops
          // and this stays put as a visible segment, so the bar still reads as
          // a bar rather than as an empty track.
          <div className="h-full w-1/4 rounded-full bg-neon animate-run-bar-sweep" />
        )}
      </div>

      {steps.length > 0 && (
        <ol className="mt-4 space-y-2">
          {steps.map((step) => (
            <li key={step.id} className="flex items-center gap-2.5">
              <span
                className={cn(
                  "flex h-5 w-5 shrink-0 items-center justify-center rounded-full border",
                  STATE_CHIP[step.state],
                )}
              >
                <Icon
                  name={STATE_ICON[step.state]}
                  className={cn("h-3 w-3", step.state === "active" && "animate-spin-slow")}
                  aria-hidden="true"
                />
              </span>
              <span
                className={cn(
                  "min-w-0 flex-1 truncate text-xs",
                  step.state === "pending" ? "text-muted-3" : "text-muted",
                  step.state === "active" && "font-medium text-foreground",
                )}
              >
                {step.label}
              </span>
            </li>
          ))}
        </ol>
      )}
    </div>
  );
}
