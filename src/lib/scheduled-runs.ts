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
import { isRedditAgentIdentity } from "@/lib/custom-agent-launch";
import type { PlannedRunCadence } from "@/lib/types";

const DAY_MS = 24 * 60 * 60 * 1000;

/**
 * The weekly cadence a client may buy from the schedule dialog. Both bounds are
 * shared by the dialog's dropdowns and the server clamp in
 * configureClientAgentScheduleAction, so a stale page or a direct call cannot
 * schedule — and bill — more outputs per fire than the product offers. The
 * scheduler multiplies the credit charge by outputsPerRun, so the server clamp
 * is the load-bearing one.
 */
export const MAX_RUNS_PER_WEEK = 7;
export const MAX_OUTPUTS_PER_RUN = 5;

/**
 * The Reddit agent (e15) is capped harder than the rest, and not for a
 * technical reason: a Reddit reply is a post into someone else's community, and
 * the product is at most one reply a day, five a week. The generic dial offers
 * 7 runs x 5 outputs — 35 replies a week — and BILLS for them
 * (chargeMultiplier = outputsPerRun on every fire), which is both an invoice
 * nobody agreed to and the fastest way to get a client's account banned from
 * the subreddits the agent is meant to build standing in (F27).
 *
 * outputsPerRun is pinned rather than clamped: "5 replies in one run" is not a
 * smaller version of the product, it is a different one — five answers written
 * in a single sitting, to whatever threads happened to be open, which is what
 * automod treats as spam.
 */
export const REDDIT_MAX_RUNS_PER_WEEK = 5;
export const REDDIT_OUTPUTS_PER_RUN = 1;

/**
 * The scheduling ceilings for one agent. Pure and shared so the dialog's
 * dropdowns and the server clamp cannot drift — the server one is the
 * load-bearing half, since hiding an option is not the same as refusing a
 * value.
 */
export function scheduleLimitsFor(agentKey: string): {
  maxRunsPerWeek: number;
  maxOutputsPerRun: number;
} {
  if (isRedditAgentIdentity(agentKey)) {
    return { maxRunsPerWeek: REDDIT_MAX_RUNS_PER_WEEK, maxOutputsPerRun: REDDIT_OUTPUTS_PER_RUN };
  }
  return { maxRunsPerWeek: MAX_RUNS_PER_WEEK, maxOutputsPerRun: MAX_OUTPUTS_PER_RUN };
}

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
 *
 * `timeZone` is the zone the run's wall clock was SET in, and it is not
 * optional in practice: only the FIRST occurrence comes from the stored
 * nextRunAt, which the scheduler computed in that zone. Every later one is
 * recomputed here, so without the zone the projection silently falls back to
 * the runtime's calendar — UTC in production. A Sao Paulo 09:00 schedule then
 * projects 06:00 from its second chip onward, and a Tokyo 22:00 schedule
 * projects onto the previous day, which puts a weekday-only run on a weekend.
 * The stored first fire stays correct throughout, so the calendar disagrees
 * with itself rather than being uniformly wrong (F108).
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
  opts: { from: number; horizonDays?: number; timeZone?: string },
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
      // Same clock the stored nextRunAt was computed on, so occurrence 2
      // onwards lands on the same wall time as occurrence 1.
      ...(opts.timeZone ? { timeZone: opts.timeZone } : {}),
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

/**
 * The CLIENT face of describeCadence — pace, never batch mechanics.
 *
 * The rule (churn D3, A3/A4, and the vocabulary AgentScheduleModal's `paceOnly`
 * branch already settled): a client may be told how often work arrives — posts
 * a week, which days, what time — and never the shape of the fires that produce
 * it. describeCadence is written for staff and states the mechanics twice over:
 * "3× weekly" names RUNS, and a run is not a post. On a schedule storing five
 * outputs per fire that line is also simply wrong as a client reads it — they
 * get fifteen posts a week, not three.
 *
 * So the same two-case split the pace dialog uses: when one output per fire is
 * stored there is no batch to hide and "3 posts a week" is both friendlier and
 * true; when staff have set more, the honest name for the same number is the
 * DAYS. Neither spelling ever multiplies the two out.
 */
export function clientCadenceLabel(run: {
  cadence: PlannedRunCadence;
  hour: number;
  minute: number;
  weekday?: number;
  weekdays?: number[];
  dayOfMonth?: number;
  nextRunAt: number;
  timeZone?: string;
  outputsPerRun?: number;
}): string {
  const zone = isValidTimeZone(run.timeZone) ? ` ${shortZoneLabel(run.timeZone, run.nextRunAt)}` : "";
  const time = `${String(run.hour).padStart(2, "0")}:${String(run.minute).padStart(2, "0")}${zone}`;
  const batched = (run.outputsPerRun ?? 1) > 1;
  switch (run.cadence) {
    case "once":
      return `One-off · ${new Date(run.nextRunAt).toLocaleDateString("en-US", {
        month: "short",
        day: "numeric",
        ...(isValidTimeZone(run.timeZone) ? { timeZone: run.timeZone } : {}),
      })} ${time}`;
    case "daily":
      return `Every day · ${time}`;
    case "weekly": {
      const days =
        run.weekdays && run.weekdays.length > 0
          ? [...run.weekdays]
              .sort((a, b) => ((a + 6) % 7) - ((b + 6) % 7))
              .map((day) => WEEKDAY_LABEL[day])
              .join(", ")
          : WEEKDAY_LABEL[run.weekday ?? 1];
      const count = run.weekdays?.length ?? 1;
      const pace = batched
        ? `${count} posting day${count === 1 ? "" : "s"} a week`
        : `${count} post${count === 1 ? "" : "s"} a week`;
      return `${pace} · ${days} ${time}`;
    }
    case "monthly": {
      const dom = run.dayOfMonth ?? 1;
      const suffix = dom === 1 || dom === 21 || dom === 31 ? "st" : dom === 2 || dom === 22 ? "nd" : dom === 3 || dom === 23 ? "rd" : "th";
      return `Every month · ${dom}${suffix} ${time}`;
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
