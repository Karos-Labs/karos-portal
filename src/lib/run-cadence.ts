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

/** UTC epoch millis for a wall-clock (Y/M/D h:m) interpreted in `timezone`. */
export function zonedWallToUtc(
  y: number,
  mo: number,
  d: number,
  hour: number,
  minute: number,
  timezone: string,
): number {
  const naiveUtc = Date.UTC(y, mo - 1, d, hour, minute, 0);
  // Two passes converge even across a DST boundary: the first offset is an
  // approximation at the naive instant, the second re-measures at the corrected
  // instant and wins when the two straddle a transition.
  const off1 = offsetMsAt(timezone, naiveUtc);
  let utc = naiveUtc - off1;
  const off2 = offsetMsAt(timezone, utc);
  if (off2 !== off1) utc = naiveUtc - off2;
  return utc;
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
