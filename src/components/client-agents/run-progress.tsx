"use client";

import { useEffect, useState } from "react";

import type { RunOutcome } from "@/lib/run-progress";

/**
 * A run's progress: one line saying what it is doing, over a bar.
 *
 * HOW LONG, NOT HOW FAR. The line carries the elapsed time beside what the run
 * is doing, and still no percentage. A denominator would have to come from the
 * seeded stage count, and that count has been wrong in production — the catalog
 * said instagram had 16 stages while the engine ran 122. A bar built on a stale
 * total is not a measurement, it is a promise. "Writing the copy · 6 min" is
 * true whatever the run turns out to cost.
 *
 * Working: the bar sweeps — motion that says "working" without a percentage,
 * because engine runs declare no plan and a made-up fraction would be the old
 * "ready in 30 minutes" in a new shape. Landed: the bar fills and stops, and
 * the line says "Done". Stopped: nothing — the outcome sentence beside it says
 * what happened. Orange on an orange track: a progress bar is data, and the
 * accent ration governs controls (Albert, 2026-09-06).
 */
/** `6 min`, `1 hr 12 min`. Minutes, because a run is measured in them and a ticking second-hand is noise. */
function elapsedLabel(startedAt: number, now: number): string | undefined {
  const minutes = Math.floor((now - startedAt) / 60_000);
  // Under a minute says nothing a reader does not already know, and "0 min"
  // beside a spinner reads like a stall.
  if (minutes < 1) return undefined;
  if (minutes < 60) return `${minutes} min`;
  const hours = Math.floor(minutes / 60);
  const rest = minutes % 60;
  return rest === 0 ? `${hours} hr` : `${hours} hr ${rest} min`;
}

export function AgentRunProgress({
  outcome,
  headline,
  startedAt,
}: {
  outcome: RunOutcome;
  headline?: string;
  /** When the engine picked the run up, for the elapsed label. */
  startedAt?: number;
}) {
  const working = outcome === "working";
  // Its own clock, because the dock only re-renders when the SERVER's answer
  // changes — which is the point of the watch, and would leave the elapsed
  // label frozen between changes. Thirty seconds is twice the resolution the
  // label has, and stops with the run.
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    if (!working || startedAt === undefined) return;
    const t = setInterval(() => setNow(Date.now()), 30_000);
    return () => clearInterval(t);
  }, [working, startedAt]);

  if (outcome === "stopped") return null;
  const elapsed = working && startedAt !== undefined ? elapsedLabel(startedAt, now) : undefined;
  const line = working ? (headline ?? "Starting the run") : "Done";
  return (
    <div className="rounded-[var(--radius)] border border-border bg-surface-2 p-4">
      <div className="flex items-center gap-2.5">
        {working && (
          <span className="h-2 w-2 shrink-0 rounded-full bg-neon animate-pulse-neon" aria-hidden="true" />
        )}
        <p className="min-w-0 flex-1 truncate text-sm font-medium text-foreground">{line}</p>
        {elapsed && (
          <span className="shrink-0 text-xs tabular-nums text-muted" aria-label={`Running for ${elapsed}`}>
            {elapsed}
          </span>
        )}
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
