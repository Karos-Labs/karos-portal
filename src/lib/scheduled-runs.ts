/**
 * Pure scheduling maths for planned agent runs (PlannedScheduledRun).
 * Client-safe — no server-only imports — so the schedule form can preview the
 * next fire time and the /api/run-scheduled cron can advance a recurring run
 * with identical logic.
 *
 * ── Timezone contract ────────────────────────────────────────────────────
 * A schedule's INTENT is a wall clock: "weekly, Monday, 09:00". That intent is
 * only meaningful paired with a zone, so PlannedScheduledRun carries
 * `timeZone` (IANA) alongside hour/minute/weekday/dayOfMonth, and `nextRunAt`
 * stays a DERIVED epoch-millis instant (repo convention: all timestamps are
 * epoch millis).
 *
 * Every recompute site — create, cron advance, resume — must pass the stored
 * zone, or the browser's preview and the server's stored instant disagree by
 * the offset between the two runtimes (a hosted container is UTC; the team is
 * not). Rows written before this field existed have no zone; they fall back to
 * the runtime's local timezone, which is exactly the old behaviour.
 */

import { localYMD, isValidTimeZone, weekdayOf, zonedWallToUtc } from "@/lib/run-cadence";
import type { PlannedRunCadence } from "@/lib/types";

const DAY_MS = 24 * 60 * 60 * 1000;

/**
 * Next fire time (epoch millis) strictly after `from` for a recurring cadence.
 *
 * Not used for "once" — a one-off run stores its explicit target time directly.
 * Scans forward day by day (bounded) so month-length clamping and skipped
 * weekdays fall out naturally.
 *
 * With `timeZone` the walk happens over that zone's calendar days and each
 * candidate wall clock is converted through the DST-correct helper shared with
 * the other scheduler; without it the walk uses the runtime's local calendar
 * (legacy rows only).
 */
export function computeNextRun(opts: {
  cadence: Exclude<PlannedRunCadence, "once">;
  hour: number;
  minute: number;
  weekday?: number;
  weekdays?: number[];
  dayOfMonth?: number;
  from?: number;
  /** IANA zone the hour/minute are expressed in. */
  timeZone?: string;
}): number {
  const from = opts.from ?? Date.now();
  const weeklyDays =
    opts.weekdays && opts.weekdays.length > 0
      ? new Set(opts.weekdays)
      : new Set([opts.weekday ?? 1]);

  if (isValidTimeZone(opts.timeZone)) {
    const zone = opts.timeZone;
    const start = localYMD(zone, from);
    for (let i = 0; i < 400; i++) {
      // Walk plain calendar dates. Date.UTC + i days never skips or repeats a
      // date the way a local-time walk does across a DST transition.
      const cursor = new Date(Date.UTC(start.y, start.mo - 1, start.d) + i * DAY_MS);
      const y = cursor.getUTCFullYear();
      const mo = cursor.getUTCMonth() + 1;
      const d = cursor.getUTCDate();

      if (opts.cadence === "weekly" && !weeklyDays.has(weekdayOf(y, mo, d))) continue;
      if (opts.cadence === "monthly") {
        const lastDay = new Date(Date.UTC(y, mo, 0)).getUTCDate();
        if (d !== Math.min(opts.dayOfMonth ?? 1, lastDay)) continue;
      }

      const at = zonedWallToUtc(y, mo, d, opts.hour, opts.minute, zone);
      if (at > from) return at;
    }
    return from + DAY_MS;
  }

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

const CADENCE_LABEL: Record<PlannedRunCadence, string> = {
  once: "One-off",
  daily: "Daily",
  weekly: "Weekly",
  monthly: "Monthly",
};

const WEEKDAY_LABEL = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];

/**
 * Short label for a zone, e.g. "GMT-3" — what goes next to a wall-clock time so
 * a preview and a stored schedule can never silently disagree about which
 * clock they mean. Falls back to the raw IANA id if the runtime can't abbreviate.
 */
export function shortZoneLabel(timeZone: string | undefined, at: number = Date.now()): string {
  if (!isValidTimeZone(timeZone)) return "";
  const part = new Intl.DateTimeFormat("en-US", { timeZone, timeZoneName: "short" })
    .formatToParts(new Date(at))
    .find((p) => p.type === "timeZoneName");
  return part?.value ?? timeZone;
}

/**
 * Human summary of a run's cadence, e.g. "Weekly · Mon 09:00 GMT-3" or "One-off".
 * The wall clock is printed verbatim from the stored intent; the zone suffix is
 * what makes it readable by someone in a different one.
 */
export function describeCadence(run: {
  cadence: PlannedRunCadence;
  hour: number;
  minute: number;
  weekday?: number;
  weekdays?: number[];
  dayOfMonth?: number;
  nextRunAt: number;
  timeZone?: string;
}): string {
  const zone = isValidTimeZone(run.timeZone) ? ` ${shortZoneLabel(run.timeZone, run.nextRunAt)}` : "";
  const time = `${String(run.hour).padStart(2, "0")}:${String(run.minute).padStart(2, "0")}${zone}`;
  switch (run.cadence) {
    case "once":
      return `One-off · ${new Date(run.nextRunAt).toLocaleDateString("en-US", {
        month: "short",
        day: "numeric",
        ...(isValidTimeZone(run.timeZone) ? { timeZone: run.timeZone } : {}),
      })} ${time}`;
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
