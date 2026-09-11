import type { RunOutcome } from "@/lib/run-progress";

/**
 * A run's progress: one line saying what it is doing, over a bar.
 *
 * Working: the bar sweeps — motion that says "working" without a percentage,
 * because engine runs declare no plan and a made-up fraction would be the old
 * "ready in 30 minutes" in a new shape. Landed: the bar fills and stops, and
 * the line says "Done". Stopped: nothing — the outcome sentence beside it says
 * what happened. Orange on an orange track: a progress bar is data, and the
 * accent ration governs controls (Albert, 2026-09-06).
 */
export function AgentRunProgress({ outcome, headline }: { outcome: RunOutcome; headline?: string }) {
  if (outcome === "stopped") return null;
  const working = outcome === "working";
  const line = working ? (headline ?? "Starting the run") : "Done";
  return (
    <div className="rounded-[var(--radius)] border border-border bg-surface-2 p-4">
      <div className="flex items-center gap-2.5">
        {working && (
          <span className="h-2 w-2 shrink-0 rounded-full bg-neon animate-pulse-neon" aria-hidden="true" />
        )}
        <p className="min-w-0 flex-1 truncate text-sm font-medium text-foreground">{line}</p>
      </div>
      <div
        className="mt-3 h-1.5 overflow-hidden rounded-full bg-neon/15"
        role="progressbar"
        aria-label={line}
        {...(working ? {} : { "aria-valuenow": 100, "aria-valuemin": 0, "aria-valuemax": 100 })}
      >
        {/* With reduced motion the sweep stops and the segment stays visible,
            so the bar still reads as a bar. */}
        <div
          className={
            working
              ? "h-full w-1/4 rounded-full bg-neon animate-run-bar-sweep"
              : "h-full w-full rounded-full bg-neon"
          }
        />
      </div>
    </div>
  );
}
