/**
 * Pure scheduling maths for the recurring Intel Report + SEO/GEO regeneration
 * (Client.intelSchedule* fields, configured from the admin Schedule modal in
 * client-documents.tsx). Client-safe — no server-only import — so the modal
 * can preview the next fire date before saving; /api/intel-report-schedule
 * uses the same functions to advance the cron's fixed grid.
 */

import type { Client } from "@/lib/types";

/** Admin-configured recurring regeneration schedule, read from the Client doc. */
export interface IntelScheduleInfo {
  enabled: boolean;
  intervalMonths: number;
  dayOfMonth: number;
  nextRunAt: number | null;
  lastIntelReportAt: number | null;
}

/**
 * The five fields this projection actually reads.
 *
 * Named as a Pick rather than taking the whole `Client` so a caller holding a
 * narrowed staff/portal projection can ask without carrying a full client
 * document just to satisfy the signature — the shells deliberately ship less
 * than a document now (see StaffShellClientView).
 */
export type ClientIntelScheduleFields = Pick<
  Client,
  | "intelScheduleEnabled"
  | "intelScheduleIntervalMonths"
  | "intelScheduleDayOfMonth"
  | "intelScheduleNextRunAt"
  | "lastIntelReportAt"
>;

/** Project a Client doc's flat schedule fields into the shape the Schedule modal expects. */
export function clientIntelSchedule(client: ClientIntelScheduleFields): IntelScheduleInfo {
  return {
    enabled: client.intelScheduleEnabled ?? false,
    intervalMonths: client.intelScheduleIntervalMonths ?? MIN_INTERVAL_MONTHS,
    dayOfMonth: client.intelScheduleDayOfMonth ?? MIN_DAY_OF_MONTH,
    nextRunAt: client.intelScheduleNextRunAt ?? null,
    lastIntelReportAt: client.lastIntelReportAt ?? null,
  };
}

function clampDayOfMonth(year: number, month0: number, day: number): number {
  const lastDay = new Date(year, month0 + 1, 0).getDate();
  return Math.min(day, lastDay);
}

/**
 * The next occurrence of `dayOfMonth` strictly after `from` — used when a
 * schedule is enabled or its day/interval is edited, so the preview always
 * reflects "the next time this day comes up" rather than jumping a full
 * interval ahead.
 */
export function computeFirstIntelScheduleRun(dayOfMonth: number, from: number = Date.now()): number {
  const d = new Date(from);
  d.setHours(9, 0, 0, 0);
  d.setDate(clampDayOfMonth(d.getFullYear(), d.getMonth(), dayOfMonth));
  if (d.getTime() <= from) {
    d.setDate(1);
    d.setMonth(d.getMonth() + 1);
    d.setDate(clampDayOfMonth(d.getFullYear(), d.getMonth(), dayOfMonth));
  }
  return d.getTime();
}

/**
 * Advance to the next run, `intervalMonths` after `from` (the slot that just
 * fired), pinned to `dayOfMonth`. Anchoring from the previous slot (not "now")
 * keeps the cadence on a fixed grid — e.g. every 2 months on the 1st always
 * lands on Jan/Mar/May 1st, regardless of an unrelated manual regenerate or
 * cron processing delay.
 */
export function computeNextIntelScheduleRun(opts: {
  intervalMonths: number;
  dayOfMonth: number;
  from?: number;
}): number {
  const from = opts.from ?? Date.now();
  const d = new Date(from);
  d.setDate(1); // avoid month-overflow when the current day doesn't exist in the target month
  d.setMonth(d.getMonth() + opts.intervalMonths);
  d.setDate(clampDayOfMonth(d.getFullYear(), d.getMonth(), opts.dayOfMonth));
  d.setHours(9, 0, 0, 0);
  return d.getTime();
}

function ordinal(n: number): string {
  const s = ["th", "st", "nd", "rd"];
  const v = n % 100;
  return `${n}${s[(v - 20) % 10] ?? s[v] ?? s[0]}`;
}

/** Human summary for the modal, e.g. "Every 2 months, on the 1st". */
export function describeIntelSchedule(opts: { intervalMonths: number; dayOfMonth: number }): string {
  const cadence = opts.intervalMonths === 1 ? "Every month" : `Every ${opts.intervalMonths} months`;
  return `${cadence}, on the ${ordinal(opts.dayOfMonth)}`;
}

export const MIN_INTERVAL_MONTHS = 1;
export const MAX_INTERVAL_MONTHS = 24;
export const MIN_DAY_OF_MONTH = 1;
export const MAX_DAY_OF_MONTH = 28;

export function clampIntervalMonths(n: number): number {
  return Math.max(MIN_INTERVAL_MONTHS, Math.min(MAX_INTERVAL_MONTHS, Math.round(n) || MIN_INTERVAL_MONTHS));
}

export function clampScheduleDayOfMonth(n: number): number {
  return Math.max(MIN_DAY_OF_MONTH, Math.min(MAX_DAY_OF_MONTH, Math.round(n) || MIN_DAY_OF_MONTH));
}
