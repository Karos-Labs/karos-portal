/**
 * Pure scheduling maths for planned agent runs (ScheduledRun). Client-safe — no
 * server-only imports — so the schedule form can preview the next fire time and
 * the /api/run-scheduled cron can advance a recurring run with identical logic.
 *
 * All times are computed in the server's local timezone, matching how the
 * datetime-local form interprets times for staff (see lib/scheduling.ts).
 */

import type { RunCadence } from "@/lib/types";

const DAY_MS = 24 * 60 * 60 * 1000;

/**
 * Next fire time (epoch millis) strictly after `from` for a recurring cadence.
 *
 * Not used for "once" — a one-off run stores its explicit target time directly.
 * Scans forward day by day (bounded) so month-length clamping and skipped
 * weekdays fall out naturally.
 */
export function computeNextRun(opts: {
  cadence: Exclude<RunCadence, "once">;
  hour: number;
  minute: number;
  weekday?: number;
  dayOfMonth?: number;
  from?: number;
}): number {
  const from = opts.from ?? Date.now();

  for (let i = 0; i < 400; i++) {
    const d = new Date(from);
    d.setDate(d.getDate() + i);
    d.setHours(opts.hour, opts.minute, 0, 0);
    if (d.getTime() <= from) continue;

    if (opts.cadence === "daily") return d.getTime();
    if (opts.cadence === "weekly" && d.getDay() === opts.weekday) return d.getTime();
    if (opts.cadence === "monthly") {
      const lastDay = new Date(d.getFullYear(), d.getMonth() + 1, 0).getDate();
      const target = Math.min(opts.dayOfMonth ?? 1, lastDay);
      if (d.getDate() === target) return d.getTime();
    }
  }
  // Unreachable in practice (400-day horizon covers every cadence).
  return from + DAY_MS;
}

const CADENCE_LABEL: Record<RunCadence, string> = {
  once: "One-off",
  daily: "Daily",
  weekly: "Weekly",
  monthly: "Monthly",
};

const WEEKDAY_LABEL = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];

/** Human summary of a run's cadence, e.g. "Weekly · Mon 09:00" or "One-off". */
export function describeCadence(run: {
  cadence: RunCadence;
  hour: number;
  minute: number;
  weekday?: number;
  dayOfMonth?: number;
  nextRunAt: number;
}): string {
  const time = `${String(run.hour).padStart(2, "0")}:${String(run.minute).padStart(2, "0")}`;
  switch (run.cadence) {
    case "once":
      return `One-off · ${new Date(run.nextRunAt).toLocaleDateString([], { month: "short", day: "numeric" })} ${time}`;
    case "daily":
      return `Daily · ${time}`;
    case "weekly":
      return `Weekly · ${WEEKDAY_LABEL[run.weekday ?? 1]} ${time}`;
    case "monthly": {
      const dom = run.dayOfMonth ?? 1;
      const suffix = dom === 1 || dom === 21 || dom === 31 ? "st" : dom === 2 || dom === 22 ? "nd" : dom === 3 || dom === 23 ? "rd" : "th";
      return `Monthly · ${dom}${suffix} ${time}`;
    }
  }
}

export { CADENCE_LABEL };
