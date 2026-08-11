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
import { isRedditAgentIdentity, isXAgentV2Identity } from "@/lib/custom-agent-launch";
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
 * ONE POST PER RUN — Daniel's ruling, 2026-08-11: the X agent drafts one post
 * per run and batches do not exist. Pinned rather than clamped, the same way
 * REDDIT_OUTPUTS_PER_RUN is above, and the same shape LinkedIn v2 already
 * ships ("D42: default is ONE post per run" in the lab manifest). The old
 * 5/10/21 batch dial (x-agent-v2-FRAMEWORK.md Revision 2) is retired; the lab
 * repo's SKILL.md still describes it and is stale on this point.
 */
export const X_V2_MAX_OUTPUTS_PER_RUN = 1;

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
  if (isXAgentV2Identity(agentKey)) {
    return { maxRunsPerWeek: MAX_RUNS_PER_WEEK, maxOutputsPerRun: X_V2_MAX_OUTPUTS_PER_RUN };
  }
  return { maxRunsPerWeek: MAX_RUNS_PER_WEEK, maxOutputsPerRun: MAX_OUTPUTS_PER_RUN };
}

/**
 * The plain calendar day an instant falls on, as a comparable number
 * (midnight-UTC of that Y/M/D). Read in `timeZone` when the row carries one,
 * else on the runtime's clock — the same two-branch split computeNextRun
 * itself walks, so a candidate and the last fire are always compared on ONE
 * calendar.
 */
function localDayOrdinal(at: number, timeZone: string | undefined): number {
  if (isValidTimeZone(timeZone)) {
    const { y, mo, d } = localYMD(timeZone, at);
    return Date.UTC(y, mo - 1, d);
  }
  const local = new Date(at);
  return Date.UTC(local.getFullYear(), local.getMonth(), local.getDate());
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
 *
 * ── A DAY THAT ALREADY FIRED IS NOT A CANDIDATE AGAIN (`lastRunAt`) ────────
 * `lastRunAt` is the instant of the schedule's most recent fire, stamped by
 * claimPlannedScheduledRun in the same transaction that advances the cursor.
 * Every recompute site passes it — the cron's advance, a pace edit, a resume —
 * because "strictly after `from`" alone re-admits a day whose post has already
 * been produced AND CHARGED: a client on Mon/Wed/Fri 09:00 opening the pace
 * dialog at 10:00 on a Monday and moving the time to 18:00 got a second post
 * that evening and a second charge for it.
 *
 * The comparison is by DAY, never by instant: the product's unit of "a post" is
 * a calendar day (one slot per day per umbrella), and an instant comparison is
 * exactly what admits the 18:00 slot on an already-posted Monday.
 *
 * DIRECTION, because this decides money: the exclusion only ever REMOVES
 * candidates from the walk, so the instant returned is greater than or equal to
 * the one returned without it. Passing `lastRunAt` cannot make any caller fire
 * more often, only later.
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
  /**
   * Instant of the most recent fire. Candidates on that calendar day, or any
   * earlier one, are refused — see the note above. Omit (or pass null) on a
   * schedule that has never fired.
   */
  lastRunAt?: number | null;
}): number {
  const from = opts.from ?? Date.now();
  const weeklyDays =
    opts.weekdays && opts.weekdays.length > 0
      ? new Set(opts.weekdays)
      : new Set([opts.weekday ?? 1]);
  const firedDay =
    opts.lastRunAt != null ? localDayOrdinal(opts.lastRunAt, opts.timeZone) : null;

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
      if (firedDay != null && Date.UTC(y, mo - 1, d) <= firedDay) continue;

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
    if (firedDay != null && Date.UTC(d.getFullYear(), d.getMonth(), d.getDate()) <= firedDay) {
      continue;
    }

    if (opts.cadence === "daily") return d.getTime();
    if (opts.cadence === "weekly" && weeklyDays.has(d.getDay())) return d.getTime();
    if (opts.cadence === "monthly") {
      const lastDay = new Date(d.getFullYear(), d.getMonth() + 1, 0).getDate();
      const target = Math.min(opts.dayOfMonth ?? 1, lastDay);
      if (d.getDate() === target) return d.getTime();
    }
  }
  // Backstop, not a computed answer. Every WELL-FORMED cadence hits inside the
  // 400-day walk (daily hits tomorrow; a weekly set holds a real weekday; a
  // monthly day-of-month is clamped to the month's length), and excluding one
  // already-fired day cannot exhaust it. A MALFORMED stored row can reach here
  // — `weekdays: [9]` matches no weekday, and nothing re-validates a row on
  // read — so the fallback is deliberately a FUTURE instant: a bad row parks a
  // day out instead of reading as due on every tick. It is not day-filtered,
  // which is safe only because `from + DAY_MS` is a later day than `from` for
  // every real zone offset, and `lastRunAt` is never after `from` at any caller.
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
 *
 * A recurring cadence's stored `nextRunAt` can be STALE — overdue because the
 * cron hasn't advanced it (a stuck/misconfigured cron, an agent-service
 * outage, etc.). Without correcting for that, this walked forward from the
 * frozen past cursor and returned it as the FIRST "occurrence", so a schedule
 * that hasn't fired in two days showed an "UPCOMING · next 9:00 AM" card on
 * the day it was ORIGINALLY due — silently misrepresenting a stuck schedule
 * as an imminent one instead of surfacing that anything was wrong. Occurrences
 * before `opts.from` are skipped by fast-forwarding the cursor first, so this
 * only ever returns genuinely future (or right-now) fire times; whether the
 * underlying schedule is stuck is a separate signal callers compute from the
 * raw stored `nextRunAt` vs "now" (e.g. calendar-body.tsx's `stuck` flag) —
 * this function's job is projecting occurrences, not diagnosing health.
 * "once" is unaffected: it has no next slot to fast-forward to, so an overdue
 * one-off still returns its own (stuck) stored time.
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
  const cadence = run.cadence;
  const next = (from: number) =>
    computeNextRun({
      cadence,
      hour: run.hour,
      minute: run.minute,
      weekday: run.weekday,
      weekdays: run.weekdays,
      dayOfMonth: run.dayOfMonth,
      from,
      // Same clock the stored nextRunAt was computed on, so every occurrence
      // lands on the same wall time as the first.
      ...(opts.timeZone ? { timeZone: opts.timeZone } : {}),
    });
  let cursor = run.nextRunAt;
  while (cursor < opts.from) cursor = next(cursor);
  const occurrences: number[] = [];
  while (cursor <= horizon) {
    occurrences.push(cursor);
    cursor = next(cursor);
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
 * "in 2h 15m" / "in 3d" / "due any moment" — a relative countdown to a
 * schedule's `nextRunAt`, for the Control Room's "Next Scheduled Execution"
 * line. `now` is required (not defaulted to Date.now()) so this stays a pure,
 * directly-testable function, matching every other date helper in this file.
 */
export function nextRunCountdown(nextRunAt: number, now: number): string {
  const ms = nextRunAt - now;
  const minutes = Math.round(ms / 60_000);
  if (minutes < 1) return "due any moment";
  if (minutes < 60) return `in ${minutes}m`;
  const hours = Math.floor(minutes / 60);
  const remMinutes = minutes % 60;
  if (hours < 24) return remMinutes > 0 ? `in ${hours}h ${remMinutes}m` : `in ${hours}h`;
  const days = Math.floor(hours / 24);
  return `in ${days}d`;
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
