import { describe, expect, it } from "vitest";
import { computeNextRun } from "@/lib/scheduled-runs";
import { computeNextIntelScheduleRun } from "@/lib/intel-schedule";

/**
 * TWO CLOSED QUESTIONS ABOUT A SCHEDULING CURSOR, ASKED OF THE MATHS ITSELF.
 *
 *   1. Can a schedule fire twice for the same slot?
 *   2. Can an advance hand back a cursor that is already in the past?
 *
 * Both cost money. A recurring agent fire charges the client's credits
 * (outputsPerRun included), and an Intel Report regeneration is the most
 * expensive pipeline in the product — so "it fired twice" and "it is due again
 * the moment it finished" are invoices, not glitches.
 *
 * DERIVED, NOT ENUMERATED. There are no expected timestamps below. Each test
 * SIMULATES the loop the production caller runs — fire, advance from the
 * instant of that fire, repeat — over a matrix of cadences and zones, and
 * asserts a property of the resulting sequence. A cadence added to either
 * scheduler is covered by adding one row to a table; a fix that happens to suit
 * one example date is not covered at all.
 *
 * WHAT THIS FILE CANNOT SEE: whether the production call sites actually pass
 * the arguments these invariants depend on. A pure function cannot know its
 * callers. schedule-double-fire.test.ts drives the real cron route and the real
 * pace-edit action for exactly that reason, and neither file is sufficient
 * alone.
 *
 * WHICH TESTS BELOW ARE TRIPWIRES, MEASURED RATHER THAN ASSUMED. Deleting both
 * `lastRunAt` skips from computeNextRun fails exactly two of the tests in this
 * file — "holds when the wall clock is moved LATER" and "holds for a CATCH-UP
 * fire". The cadence × zone tables around them keep passing, because a drain
 * that never changes its wall clock and never runs late cannot land twice on a
 * day by accident. They are regression cover for the walk (and the thing that
 * makes a NEW cadence cheap to cover), not evidence for this fix; the two named
 * tests are the evidence. Deleting the `after` walk from
 * computeNextIntelScheduleRun fails two more, one of them the burst itself.
 */

/* ────────────────────────────── shared helpers ──────────────────────────── */

/**
 * "YYYY-MM-DD" of an instant on a given clock — deliberately a SECOND
 * implementation (Intl "en-CA" / the runtime Date), not the localYMD the
 * scheduler walks with. A day-identity bug shared by the function and its test
 * is invisible; two implementations disagreeing is the point.
 */
function dayKey(at: number, zone?: string): string {
  if (zone) {
    return new Intl.DateTimeFormat("en-CA", {
      timeZone: zone,
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
    }).format(new Date(at));
  }
  const d = new Date(at);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(
    d.getDate(),
  ).padStart(2, "0")}`;
}

/** How late a cron tick actually drains a due slot. Well under any midnight. */
const TICK_LAG_MS = 7 * 60_000;

type Cadence = Parameters<typeof computeNextRun>[0];

/** Every cadence shape the two writers can store, one row each. */
const CADENCES: Array<{ label: string; opts: Omit<Cadence, "from" | "timeZone" | "lastRunAt"> }> = [
  { label: "daily 09:00", opts: { cadence: "daily", hour: 9, minute: 0 } },
  { label: "daily 23:30", opts: { cadence: "daily", hour: 23, minute: 30 } },
  { label: "daily 00:15", opts: { cadence: "daily", hour: 0, minute: 15 } },
  { label: "weekly Mon", opts: { cadence: "weekly", weekday: 1, hour: 9, minute: 0 } },
  { label: "weekly Mon/Wed/Fri", opts: { cadence: "weekly", weekdays: [1, 3, 5], hour: 9, minute: 0 } },
  {
    label: "weekly all seven",
    opts: { cadence: "weekly", weekdays: [0, 1, 2, 3, 4, 5, 6], hour: 18, minute: 45 },
  },
  { label: "monthly 1st", opts: { cadence: "monthly", dayOfMonth: 1, hour: 9, minute: 0 } },
  { label: "monthly 31st", opts: { cadence: "monthly", dayOfMonth: 31, hour: 9, minute: 0 } },
];

/**
 * The zones a schedule is actually set in, plus the legacy no-zone row (rows
 * written before timeZone existed walk the runtime's calendar). Chosen to
 * straddle the two ways a day boundary can bite: a UTC+ zone whose local day
 * starts before the container's, and DST on both hemispheres' schedules.
 */
const ZONES: Array<string | undefined> = [
  undefined,
  "UTC",
  "America/Sao_Paulo",
  "America/New_York",
  "Asia/Kolkata",
  "Pacific/Auckland",
];

/** 2026-01-01T00:00:00Z — a Thursday, before both hemispheres' DST switches. */
const START = Date.UTC(2026, 0, 1);

/**
 * Drain a schedule the way /api/run-scheduled does: fire the due slot, then
 * advance from the instant of that fire, telling the maths what just fired.
 * Returns the local day of every fire, in order.
 */
function drain(
  opts: Omit<Cadence, "from" | "timeZone" | "lastRunAt">,
  zone: string | undefined,
  fires: number,
  onEachAdvance?: (from: number, cursor: number) => void,
): string[] {
  const zoned = zone ? { timeZone: zone } : {};
  let cursor = computeNextRun({ ...opts, ...zoned, from: START });
  const days: string[] = [];
  for (let i = 0; i < fires; i++) {
    const firedAt = cursor + TICK_LAG_MS;
    days.push(dayKey(firedAt, zone));
    const next = computeNextRun({ ...opts, ...zoned, from: firedAt, lastRunAt: firedAt });
    onEachAdvance?.(firedAt, next);
    cursor = next;
  }
  return days;
}

/* ─────────── invariant 1: a schedule never fires twice for one day ───────── */

describe("a recurring schedule fires at most once on any calendar day", () => {
  for (const { label, opts } of CADENCES) {
    for (const zone of ZONES) {
      it(`${label} · ${zone ?? "runtime clock"}`, () => {
        // 40 fires covers more than a year of a monthly cadence and six weeks
        // of a daily one, so every table row crosses at least one month end and
        // the daily/weekly rows cross both DST transitions in both hemispheres.
        const days = drain(opts, zone, 40);
        expect(new Set(days).size).toBe(days.length);
        for (let i = 1; i < days.length; i++) {
          expect(days[i] > days[i - 1], `${days[i - 1]} → ${days[i]}`).toBe(true);
        }
      });
    }
  }

  it("holds when the wall clock is moved LATER on a day that already fired", () => {
    // #61 in one line of maths: a client on Mon/Wed/Fri 09:00 opens the pace
    // dialog at 10:00 on a Monday — after that morning's post — and moves the
    // time to 18:00. Recomputed from `now` alone, 18:00 TODAY is a valid future
    // slot, so the agent posts again that evening and charges again for it.
    for (const zone of ZONES) {
      const zoned = zone ? { timeZone: zone } : {};
      const base = { cadence: "weekly" as const, weekdays: [1, 3, 5], minute: 0 };
      const fired = computeNextRun({ ...base, hour: 9, ...zoned, from: START }) + TICK_LAG_MS;
      const editedAt = fired + 60 * 60_000;
      const rearmed = computeNextRun({
        ...base,
        hour: 18,
        ...zoned,
        from: editedAt,
        lastRunAt: fired,
      });
      expect(rearmed).toBeGreaterThan(editedAt);
      expect(dayKey(rearmed, zone), `zone ${zone ?? "runtime"}`).not.toBe(dayKey(fired, zone));
    }
  });

  it("holds for a CATCH-UP fire, where today's slot is still ahead of the clock", () => {
    // The backlog shape: the cursor is stranded on last Friday and the cron
    // drains it at 08:00 on a Monday. Today's own 09:00 slot is genuinely in the
    // future, so an advance that only asks "is it after now?" arms it and the
    // client gets two posts an hour apart out of one outage.
    for (const zone of ZONES) {
      const zoned = zone ? { timeZone: zone } : {};
      const opts = { cadence: "weekly" as const, weekdays: [1, 3, 5], hour: 9, minute: 0 };
      // A Monday 08:00 on whichever clock the row uses.
      const monday8 =
        computeNextRun({ ...opts, ...zoned, hour: 8, from: START, weekdays: [1] });
      const next = computeNextRun({ ...opts, ...zoned, from: monday8, lastRunAt: monday8 });
      expect(next).toBeGreaterThan(monday8);
      expect(dayKey(next, zone), `zone ${zone ?? "runtime"}`).not.toBe(dayKey(monday8, zone));
    }
  });
});

/* ──────────── invariant 2: a cursor is never handed back in the past ─────── */

describe("every advance lands strictly in the future", () => {
  for (const { label, opts } of CADENCES) {
    for (const zone of ZONES) {
      it(`${label} · ${zone ?? "runtime clock"}`, () => {
        let checked = 0;
        drain(opts, zone, 20, (from, cursor) => {
          expect(cursor, `advance from ${new Date(from).toISOString()}`).toBeGreaterThan(from);
          checked += 1;
        });
        // The assertion above is only worth its name if it ran: a `drain` that
        // silently produced nothing would pass a callback-only test.
        expect(checked).toBe(20);
      });
    }
  }
});

/* ───────── invariant 3: knowing what fired can only move a cursor on ─────── */

describe("passing lastRunAt can never make a schedule fire sooner", () => {
  // The money direction, stated mechanically rather than in a comment: the
  // exclusion removes candidates from the walk, so every result is >= the
  // result without it. If this ever inverted, a "safety" argument would be
  // moving fires EARLIER — the failure mode nobody would look for.
  for (const { label, opts } of CADENCES) {
    for (const zone of ZONES) {
      it(`${label} · ${zone ?? "runtime clock"}`, () => {
        const zoned = zone ? { timeZone: zone } : {};
        let from = START;
        for (let i = 0; i < 20; i++) {
          const blind = computeNextRun({ ...opts, ...zoned, from });
          const informed = computeNextRun({ ...opts, ...zoned, from, lastRunAt: from });
          expect(informed).toBeGreaterThanOrEqual(blind);
          from = blind + TICK_LAG_MS;
        }
      });
    }
  }

  it("changes nothing at all for a schedule that has never fired", () => {
    for (const { opts } of CADENCES) {
      for (const zone of ZONES) {
        const zoned = zone ? { timeZone: zone } : {};
        expect(computeNextRun({ ...opts, ...zoned, from: START, lastRunAt: null })).toBe(
          computeNextRun({ ...opts, ...zoned, from: START }),
        );
      }
    }
  });
});

/* ────────── the same two invariants for the intel regeneration grid ─────── */

describe("the intel regeneration cursor", () => {
  const INTERVALS = [1, 2, 3, 6, 12];
  const DAYS_OF_MONTH = [1, 15, 28];

  it("never lands in the past, at any interval or day of month", () => {
    for (const intervalMonths of INTERVALS) {
      for (const dayOfMonth of DAYS_OF_MONTH) {
        let dueAt = START;
        for (let i = 0; i < 24; i++) {
          const now = dueAt + 3 * 60_000; // the tick that drained it
          const next = computeNextIntelScheduleRun({ intervalMonths, dayOfMonth, from: dueAt, after: now });
          expect(next, `${intervalMonths}mo/${dayOfMonth} from ${new Date(dueAt).toISOString()}`)
            .toBeGreaterThan(now);
          dueAt = next;
        }
      }
    }
  });

  it("turns a three-month outage into ONE regeneration, not three", () => {
    // #72. The cron ticks roughly every fifteen minutes. Advancing a single
    // interval from the slot that just fired lands the cursor back in the past
    // whenever the backlog is deeper than one interval, so the row is due again
    // on the next tick — three missed months became three full Intel Report +
    // SEO/GEO pipelines inside an hour, each overwriting the last.
    const TICK = 15 * 60_000;
    const intervalMonths = 1;
    const dayOfMonth = 1;
    let cursor = computeNextIntelScheduleRun({ intervalMonths, dayOfMonth, from: START });
    const outageStart = Date.UTC(2026, 1, 15);
    const outageEnd = Date.UTC(2026, 4, 15); // three monthly slots missed
    const ranAt: number[] = [];

    for (let now = START; now < Date.UTC(2026, 7, 1); now += TICK) {
      if (now >= outageStart && now < outageEnd) continue; // the cron is down
      if (cursor > now) continue;
      ranAt.push(now);
      cursor = computeNextIntelScheduleRun({ intervalMonths, dayOfMonth, from: cursor, after: now });
    }

    // No two runs share a day, and specifically none share the recovery day.
    const days = ranAt.map((at) => dayKey(at, "UTC"));
    expect(new Set(days).size).toBe(days.length);
    // The recovery tick catches up exactly once, then the grid resumes: Feb 1
    // fired before the outage; Mar/Apr/May 1 were missed; recovery is the first
    // tick after the outage ends, and the next run is June 1 on the grid.
    const recovery = ranAt.filter((at) => at >= outageEnd && at < outageEnd + 24 * 3_600_000);
    expect(recovery).toHaveLength(1);
    expect(dayKey(cursor, "UTC") > dayKey(outageEnd, "UTC")).toBe(true);
  });

  it("keeps the admin's calendar grid — catching up does not re-phase the day of month", () => {
    // The reason the anchor is the fired slot and not `now`: "every 2 months on
    // the 15th" must stay on the 15th even when the catch-up itself happens on
    // the 23rd.
    const next = computeNextIntelScheduleRun({
      intervalMonths: 2,
      dayOfMonth: 15,
      from: new Date(2026, 0, 15, 9).getTime(),
      after: new Date(2026, 5, 23, 11).getTime(),
    });
    expect(new Date(next).getDate()).toBe(15);
    expect(next).toBeGreaterThan(new Date(2026, 5, 23, 11).getTime());
  });

  it("still advances a single interval when nothing is overdue", () => {
    // The un-regressed case: one missed tick is what the fixed grid is FOR, and
    // the walk must not skip a slot that is merely imminent.
    const dueAt = new Date(2026, 0, 1, 9).getTime();
    const bare = computeNextIntelScheduleRun({ intervalMonths: 1, dayOfMonth: 1, from: dueAt });
    const guarded = computeNextIntelScheduleRun({
      intervalMonths: 1,
      dayOfMonth: 1,
      from: dueAt,
      after: dueAt + 60_000,
    });
    expect(guarded).toBe(bare);
  });
});
