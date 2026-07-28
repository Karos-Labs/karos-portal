/**
 * Pure scheduling maths for planned agent runs (ScheduledRun). Client-safe — no
 * server-only imports — so the schedule form can preview the next fire time and
 * the /api/run-scheduled cron can advance a recurring run with identical logic.
 *
 * All times are computed in the server's local timezone, matching how the
 * datetime-local form interprets times for staff (see lib/scheduling.ts).
 */

import type { PlannedRunCadence } from "@/lib/types";

const DAY_MS = 24 * 60 * 60 * 1000;

/**
 * Next fire time (epoch millis) strictly after `from` for a recurring cadence.
 *
 * Not used for "once" — a one-off run stores its explicit target time directly.
 * Scans forward day by day (bounded) so month-length clamping and skipped
 * weekdays fall out naturally.
 */
export function computeNextRun(opts: {
  cadence: Exclude<PlannedRunCadence, "once">;
  hour: number;
  minute: number;
  weekday?: number;
  weekdays?: number[];
  dayOfMonth?: number;
  from?: number;
}): number {
  const from = opts.from ?? Date.now();
  const weeklyDays =
    opts.weekdays && opts.weekdays.length > 0
      ? new Set(opts.weekdays)
      : new Set([opts.weekday ?? 1]);

  for (let i = 0; i < 400; i++) {
    const d = new Date(from);
    d.setDate(d.getDate() + i);
    d.setHours(opts.hour, opts.minute, 0, 0);
    if (d.getTime() <= from) continue;

    if (opts.cadence === "daily") return d.getTime();
    if (opts.cadence === "weekly" && weeklyDays.has(d.getDay())) return d.getTime();
    if (opts.cadence === "monthly") {
      const lastDay = new Date(d.getFullYear(), d.getMonth() + 1, 0).getDate();
      const target = Math.min(opts.dayOfMonth ?? 1, lastDay);
      if (d.getDate() === target) return d.getTime();
    }
  }
  // Unreachable in practice (400-day horizon covers every cadence).
  return from + DAY_MS;
}

/** How far ahead the calendar projects a recurring run's future fire days. */
export const SCHEDULE_PROJECTION_DAYS = 90;

/**
 * Every upcoming fire time for a recurring run within `horizonDays` of
 * `opts.from` — bounded, since a calendar can't render an infinite recurrence.
 * "once" always yields just its single stored `nextRunAt` (nothing recurs).
 * Otherwise walks forward from the run's already-computed next fire using
 * computeNextRun, each step starting strictly after the last, so a "weekly ·
 * Mon–Fri" run yields one timestamp per weekday rather than the single next
 * occurrence a calendar would otherwise show.
 */
export function projectRunOccurrences(
  run: {
    cadence: PlannedRunCadence;
    hour: number;
    minute: number;
    weekday?: number;
    weekdays?: number[];
    dayOfMonth?: number;
    nextRunAt: number;
  },
  opts: { from: number; horizonDays?: number },
): number[] {
  const horizon = opts.from + (opts.horizonDays ?? SCHEDULE_PROJECTION_DAYS) * DAY_MS;
  if (run.cadence === "once") {
    return run.nextRunAt <= horizon ? [run.nextRunAt] : [];
  }
  const occurrences: number[] = [];
  let cursor = run.nextRunAt;
  while (cursor <= horizon) {
    occurrences.push(cursor);
    cursor = computeNextRun({
      cadence: run.cadence,
      hour: run.hour,
      minute: run.minute,
      weekday: run.weekday,
      weekdays: run.weekdays,
      dayOfMonth: run.dayOfMonth,
      from: cursor,
    });
  }
  return occurrences;
}

const CADENCE_LABEL: Record<PlannedRunCadence, string> = {
  once: "One-off",
  daily: "Daily",
  weekly: "Weekly",
  monthly: "Monthly",
};

const WEEKDAY_LABEL = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];

/** Human summary of a run's cadence, e.g. "Weekly · Mon 09:00" or "One-off". */
export function describeCadence(run: {
  cadence: PlannedRunCadence;
  hour: number;
  minute: number;
  weekday?: number;
  weekdays?: number[];
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
      if (run.weekdays && run.weekdays.length > 1) {
        const days = [...run.weekdays]
          .sort((a, b) => ((a + 6) % 7) - ((b + 6) % 7))
          .map((day) => WEEKDAY_LABEL[day])
          .join(", ");
        return `${run.weekdays.length}× weekly · ${days} ${time}`;
      }
      return `Weekly · ${WEEKDAY_LABEL[run.weekday ?? 1]} ${time}`;
    case "monthly": {
      const dom = run.dayOfMonth ?? 1;
      const suffix = dom === 1 || dom === 21 || dom === 31 ? "st" : dom === 2 || dom === 22 ? "nd" : dom === 3 || dom === 23 ? "rd" : "th";
      return `Monthly · ${dom}${suffix} ${time}`;
    }
  }
}

/** Balanced publishing days for a requested 1–7 posts per week. */
export function weeklyCadenceDays(postsPerWeek: number): number[] {
  const count = Math.max(1, Math.min(7, Math.round(postsPerWeek)));
  const presets: Record<number, number[]> = {
    1: [2],
    2: [2, 4],
    3: [1, 3, 5],
    4: [1, 2, 4, 5],
    5: [1, 2, 3, 4, 5],
    6: [1, 2, 3, 4, 5, 6],
    7: [0, 1, 2, 3, 4, 5, 6],
  };
  return presets[count]!;
}

export { CADENCE_LABEL };
