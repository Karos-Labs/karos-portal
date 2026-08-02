/**
 * Recurring-cadence math for ScheduledRun (see /api/scheduler).
 *
 * A cadence is a weekly set of days + a wall-clock time, local to an IANA
 * timezone. We compute the next fire instant using Intl only (the repo has no
 * date library) so the result is correct across DST transitions — e.g. if
 * Brazil ever reinstates summer time, a 09:00 America/Sao_Paulo slot keeps
 * landing at local 09:00 rather than drifting with a hardcoded UTC offset.
 */

import type { RunCadence } from "@/lib/types";

const DAY_MS = 24 * 60 * 60 * 1000;
const DAY_LABELS = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];

/**
 * Calendar Y/M/D of `atUtcMs` as observed in `timezone`.
 *
 * Exported so the planned-run scheduler (lib/scheduled-runs.ts) and the calendar
 * share ONE implementation of the zone maths rather than growing a second,
 * subtly different one.
 */
export function localYMD(timezone: string, atUtcMs: number): { y: number; mo: number; d: number } {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone: timezone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).formatToParts(new Date(atUtcMs));
  const get = (t: string) => Number(parts.find((p) => p.type === t)?.value);
  return { y: get("year"), mo: get("month"), d: get("day") };
}

/** Offset (ms east of UTC) that `timezone` observes at the instant `atUtcMs`. */
function offsetMsAt(timezone: string, atUtcMs: number): number {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone: timezone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    hour12: false,
  }).formatToParts(new Date(atUtcMs));
  const get = (t: string) => Number(parts.find((p) => p.type === t)?.value);
  let hour = get("hour");
  if (hour === 24) hour = 0; // some engines emit "24" for midnight
  const asUtc = Date.UTC(get("year"), get("month") - 1, get("day"), hour, get("minute"), get("second"));
  return asUtc - atUtcMs;
}

/**
 * UTC epoch millis for a wall-clock (Y/M/D h:m) interpreted in `timezone`.
 *
 * ── THE RULE, one sentence: the EARLIEST instant at which `timezone` shows the
 * requested wall clock; and when it never shows it, the requested time shifted
 * later by the length of the gap. ──
 *
 * Most days that is one instant and there is nothing to decide. Twice a year
 * there is, and the two cases pull opposite ways:
 *
 * AMBIGUOUS (fall back). 01:30 America/New_York happens twice on the day the
 * clocks go back. "Earliest" picks the first one, so a daily schedule fires
 * once, at the earlier of the two, and never skips the hour.
 *
 * NONEXISTENT (spring forward). 02:30 America/New_York does not happen at all
 * on the day the clocks go forward. There is no "earliest instant showing it",
 * so the intent is shifted later by the gap: 02:30 becomes 03:30. Later, never
 * earlier — a post that goes out an hour EARLY is out at a time the client did
 * not pick and cannot take back, while an hour late is the same day's post at
 * the same distance past the transition. This also matches what the rest of the
 * ecosystem does with a nonexistent wall clock (Temporal's default
 * disambiguation, java.time's ZonedDateTime.of, RFC 5545), so nobody has to
 * learn a rule specific to this product.
 *
 * WHAT THIS REPLACES, because the shape is instructive. The old body measured
 * the offset at the naive instant and re-measured at the corrected one. Which
 * side of a transition that first sample lands on depends on the SIGN of the
 * zone's offset, so the two DST cases came out differently in the two
 * hemispheres of the map: west of UTC a spring-forward 02:30 resolved to
 * 01:30 — BEFORE the gap, an hour early, the direction that costs a client a
 * post at the wrong time — while east of UTC the same input already shifted
 * forward correctly; and the fall-back case picked the earlier occurrence west
 * of UTC and the later one east of it, though the comment claimed "the earlier
 * occurrence" flatly. Sampling on both sides of the wall time instead of once
 * near it is what makes the answer independent of the zone's sign.
 *
 * The three-line residual: this returns an instant, and `computeNextRunAt` /
 * `computeNextRun` pick the DAY. A gap shift can therefore carry a wall clock
 * over midnight into the following day in a zone whose transition is at
 * midnight (a 23:30 slot becoming 00:30) — one fire, on the next day, once in
 * the years such a transition falls on a scheduled day.
 */
export function zonedWallToUtc(
  y: number,
  mo: number,
  d: number,
  hour: number,
  minute: number,
  timezone: string,
): number {
  const naiveUtc = Date.UTC(y, mo - 1, d, hour, minute, 0);
  // The two offsets that can be in force at this wall clock: the one a day
  // before it and the one a day after. Sampling BOTH sides is the point — a
  // single sample near the target lands on whichever side the zone's offset
  // sign happens to put it on.
  const offBefore = offsetMsAt(timezone, naiveUtc - DAY_MS);
  const offAfter = offsetMsAt(timezone, naiveUtc + DAY_MS);
  const candBefore = naiveUtc - offBefore;
  const candAfter = naiveUtc - offAfter;
  if (offBefore === offAfter) return candBefore; // no transition in range

  // A candidate is real only if the zone actually SHOWS the requested wall
  // clock at it: local(t) === requested ⟺ offset(t) === naiveUtc - t.
  const shows = (t: number) => offsetMsAt(timezone, t) === naiveUtc - t;
  const real = [candBefore, candAfter].filter(shows);
  if (real.length > 0) return Math.min(...real); // ambiguous → earliest occurrence
  // Neither is real: the wall clock is inside a gap. The two candidates are the
  // same instant read with the two offsets, so they are exactly one gap apart —
  // the later one IS "shifted forward by the gap".
  return Math.max(candBefore, candAfter);
}

/** Weekday (0=Sun..6=Sat) of a plain calendar date — timezone-independent as a label. */
export function weekdayOf(y: number, mo: number, d: number): number {
  return new Date(Date.UTC(y, mo - 1, d)).getUTCDay();
}

/** Is this a timezone id the runtime's Intl can actually resolve? */
export function isValidTimeZone(timezone: string | undefined | null): timezone is string {
  if (!timezone) return false;
  try {
    new Intl.DateTimeFormat("en-US", { timeZone: timezone });
    return true;
  } catch {
    return false;
  }
}

/**
 * The zone this runtime is running in. On a hosted container that is almost
 * always UTC while the team is not — which is exactly why a schedule must carry
 * its own zone rather than inherit this one implicitly.
 */
export function runtimeTimeZone(): string {
  return Intl.DateTimeFormat().resolvedOptions().timeZone || "UTC";
}

export function isValidCadence(cadence: RunCadence): boolean {
  if (!Array.isArray(cadence.daysOfWeek) || cadence.daysOfWeek.length === 0) return false;
  if (!cadence.daysOfWeek.every((n) => Number.isInteger(n) && n >= 0 && n <= 6)) return false;
  if (!Number.isInteger(cadence.hour) || cadence.hour < 0 || cadence.hour > 23) return false;
  if (!Number.isInteger(cadence.minute) || cadence.minute < 0 || cadence.minute > 59) return false;
  if (!cadence.timezone) return false;
  try {
    new Intl.DateTimeFormat("en-US", { timeZone: cadence.timezone });
  } catch {
    return false;
  }
  return true;
}

/**
 * The first fire instant strictly after `from`.
 *
 * KNOWN RESIDUAL, stated because the sibling scheduler no longer has it. This
 * function has no "and not on a day that already fired" exclusion, while
 * `computeNextRun` (lib/scheduled-runs.ts, the PlannedScheduledRun scheduler)
 * takes `lastRunAt` for exactly that. The gap shows up on a CATCH-UP: a cursor
 * stranded on Friday, drained at 08:00 on a Monday, advances to Monday 09:00
 * and fires again an hour later — two outputs on one calendar day out of one
 * outage. `ScheduledRun` carries `lastRunAt`, so closing it is the same shape:
 * exclude candidates whose local day is on or before the last fire's, and pass
 * the field from /api/scheduler and setScheduledRunEnabledAction.
 *
 * Why it is a residual and not an emergency: those fires are system fires
 * (`/api/scheduler` submits with `charge: null` — "system-fired runs never bill
 * the client"), so the cost is a duplicate draft rather than a duplicate
 * invoice. It is still a duplicate draft.
 *
 * @param from reference "now" (epoch millis); injectable for tests.
 * @throws if the cadence is invalid (callers validate first).
 */
export function computeNextRunAt(cadence: RunCadence, from: number = Date.now()): number {
  if (!isValidCadence(cadence)) throw new Error("Invalid cadence");
  const days = new Set(cadence.daysOfWeek);
  const start = localYMD(cadence.timezone, from);
  // Walk local calendar days forward. 8 days covers any weekly cadence even when
  // today's slot has already passed (roll to the same weekday next week at worst).
  for (let i = 0; i <= 8; i++) {
    const base = Date.UTC(start.y, start.mo - 1, start.d) + i * DAY_MS;
    const cand = new Date(base);
    const y = cand.getUTCFullYear();
    const mo = cand.getUTCMonth() + 1;
    const d = cand.getUTCDate();
    if (!days.has(weekdayOf(y, mo, d))) continue;
    const utc = zonedWallToUtc(y, mo, d, cadence.hour, cadence.minute, cadence.timezone);
    if (utc > from) return utc;
  }
  // Unreachable for a valid non-empty cadence within an 8-day window.
  return from + 7 * DAY_MS;
}

/** Human-readable one-liner for the UI, e.g. "Tue, Wed, Thu · 09:00 America/Sao_Paulo". */
export function describeCadence(cadence: RunCadence): string {
  const days = [...cadence.daysOfWeek].sort((a, b) => a - b).map((n) => DAY_LABELS[n] ?? "?").join(", ");
  const hh = String(cadence.hour).padStart(2, "0");
  const mm = String(cadence.minute).padStart(2, "0");
  return `${days} · ${hh}:${mm} ${cadence.timezone}`;
}
