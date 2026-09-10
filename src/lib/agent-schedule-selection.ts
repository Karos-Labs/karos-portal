import type { PlannedRunCadence, PlannedScheduledRun } from "@/lib/types";

/**
 * WHICH SCHEDULE ROW GOVERNS AN AGENT'S SURFACES — asked once, here.
 *
 * Five separate call sites used to answer it with their own copy of
 * `cadence === "weekly" && status !== "completed"`, and a daily schedule —
 * which the calendar modal offers explicitly and `createPlannedRunAction`
 * stores without complaint — fell through every one of them. The row fired and
 * billed on time (the cron reads `nextRunAt` and nothing else), while the
 * client's AI Agents card showed no pace, no next run and no Pause and offered
 * "Start posting" as though nothing were scheduled, and the Reddit panel read
 * "Not looking yet" beside an agent drafting every day.
 *
 * NOTHING HERE DECIDES WHETHER A FIRE HAPPENS. `/api/run-scheduled` drains
 * `listDuePlannedScheduledRuns` (a `nextRunAt` cursor plus a compare-and-set
 * claim) and consults none of these predicates; slots are calendar INTENT and
 * no code path fires from one. So widening what these read-paths admit can
 * only make an existing schedule visible — it cannot make one fire more often.
 * The one behaviour it does change is in the client's favour: a daily schedule
 * that the card can finally see is a daily schedule the pace dialog EDITS
 * instead of adding a second row beside.
 *
 * THAT LAST SENTENCE WAS FALSE WHEN IT WAS WRITTEN and is true now. The read
 * paths were widened here while `configureClientAgentScheduleAction` still
 * resolved its row by `cadence === "weekly"`, so a daily-only agent took the
 * CREATE branch and one Save press left TWO live rows billing — the exact
 * direction this paragraph promises it cannot move. The action now asks
 * `selectAgentSchedule` too; `pace-save-never-duplicates.test.ts` drives both
 * halves together, because two predicates agreeing today is what failed.
 *
 * Pure and client-safe on purpose (types only, no data layer, no clock): the
 * slot planner is pure and imports from here, and a rule that only the server
 * can evaluate is a rule the two halves get to disagree about.
 */

/**
 * Cadences that keep firing. `once` is not one of them: it fires and completes,
 * so it is a booking rather than a pace, and a card that offered Pause and a
 * posts-per-week figure for it would be describing something the row is not.
 */
const RECURRING_CADENCES: readonly PlannedRunCadence[] = ["daily", "weekly", "monthly"];

export function isRecurringCadence(cadence: PlannedRunCadence): boolean {
  return RECURRING_CADENCES.includes(cadence);
}

/** The fields the rules below read. Widened from `PlannedScheduledRun` so the
 *  pure slot planner can pass its own narrow Pick without importing the row. */
export type ScheduleCadenceFields = Pick<PlannedScheduledRun, "cadence" | "weekdays" | "weekday">;

/**
 * THE RULE. A schedule row governs an agent's surfaces when it is recurring and
 * has not been retired.
 *
 * `completed` is excluded rather than `paused`: a paused row is still this
 * agent's schedule and the client's card is exactly where they resume it.
 */
export function isLiveAgentSchedule(
  run: Pick<PlannedScheduledRun, "cadence" | "status">,
): boolean {
  return run.status !== "completed" && isRecurringCadence(run.cadence);
}

/** Every weekday, Sunday first — what a daily cadence fires on. */
const EVERY_WEEKDAY = [0, 1, 2, 3, 4, 5, 6];

/**
 * The weekdays this schedule fires on, or null when its cadence does not
 * decompose into weekdays.
 *
 * A DAILY row stores no `weekdays` array — the cron does not need one — so
 * every weekday-based projection read it as "no firing days" and produced an
 * empty week. Seven days is not an assumption about a daily row; it is what
 * daily means, and `computeNextRun` advances a daily cadence by exactly one day.
 *
 * MONTHLY returns null rather than a guess: a month does not fit in a week, and
 * the surfaces that ask this question (the slot horizon, the week strip) are
 * weekday grids with nowhere to put it. Callers must handle null; see the
 * residual noted on `weeklyFireDays`.
 */
export function firingWeekdays(run: ScheduleCadenceFields): number[] | null {
  if (run.cadence === "daily") return [...EVERY_WEEKDAY];
  if (run.cadence !== "weekly") return null;
  const raw =
    run.weekdays && run.weekdays.length > 0
      ? run.weekdays
      : run.weekday != null
        ? [run.weekday]
        : [];
  const days = [...new Set(raw)]
    .filter((d) => Number.isInteger(d) && d >= 0 && d <= 6)
    .sort((a, b) => a - b);
  return days.length > 0 ? days : null;
}

/**
 * How many days a week this schedule fires, or null when it has no weekly pace.
 *
 * This number is QUOTED AT A CLIENT — the pace dialog multiplies it by the run
 * cost to price the week — so it is derived, never defaulted. A monthly or
 * one-off row returns null and its caller drops the row rather than calling it
 * one-a-week, which would overstate a monthly schedule's cost by more than 4x.
 *
 * RESIDUAL, stated rather than hidden: that means a MONTHLY schedule is still
 * invisible on the client's AI Agents card. `ClientAgentScheduleRow` has no
 * cadence field to carry "once a month" in and lives in a file this pass does
 * not own; until it does, monthly stays a staff-surfaces-only cadence and the
 * calendar remains where it is managed.
 */
export function weeklyFireDays(run: ScheduleCadenceFields): number | null {
  if (run.cadence === "daily") return 7;
  if (run.cadence !== "weekly") return null;
  return firingWeekdays(run)?.length ?? 1;
}

/** The fields the selector orders on. */
export type SelectableSchedule = Pick<
  PlannedScheduledRun,
  "id" | "customAgentId" | "cadence" | "status" | "nextRunAt" | "createdAt"
>;

export interface AgentScheduleSelection<T> {
  /** The row every surface treats as THIS agent's schedule. */
  schedule: T;
  /**
   * Any further live rows for the same agent. Never empty on a healthy client —
   * a non-empty array is the duplicate-schedule defect, and staff surfaces say
   * so rather than silently rendering one of them.
   */
  duplicates: T[];
}

/**
 * A TOTAL, TIME-STABLE ORDER over one agent's live schedule rows.
 *
 * Two live rows for one client and agent is a real state — nothing refuses to
 * create the second — and until now each surface picked from them differently:
 * `toScheduleRows` fed a Map keyed by agent id, so the LAST row won; the detail
 * page and the configure action each took the FIRST match of a list the data
 * layer happens to sort by `nextRunAt`. So the card could show one schedule
 * while Save rewrote the other.
 *
 * THE CARD MUST NAME THE ROW THAT SAVE WILL WRITE. That is what puts weekly
 * first, and it is a money rule rather than a taste one.
 * The weekly-first rung was written when `configureClientAgentScheduleAction`
 * matched only `cadence === "weekly"`, and its note said to revisit it the
 * moment that action accepted more than weekly. THAT MOMENT CAME: the action
 * now calls `selectAgentSchedule`, so the card and Save read the same row by
 * CONSTRUCTION rather than because two predicates happen to agree.
 *
 * The rung stays anyway, and for a reason that outlived its original one: it
 * makes the order deterministic and puts the cadence the dialog can actually
 * express first, so a mixed daily+weekly client is shown the row whose pace the
 * dialog can round-trip without converting anything. It is no longer load
 * bearing for money — one selector is — so changing it can no longer split the
 * card from Save.
 *
 * `nextRunAt` comes next because it is what `listPlannedScheduledRuns` already
 * sorts on, so among weekly rows this agrees with the first-match sites that
 * have not adopted the selector yet. `createdAt` then `id` break the ties
 * `nextRunAt` leaves, which is what makes the order total: without them two
 * rows sharing a fire time swap places between reads.
 *
 * Status is NOT part of the order. Preferring an active row over a paused one
 * would read better on the card and would point it at a different row from the
 * one the configure action edits — and a card that displays A while Save writes
 * B is worse than a card showing a paused schedule.
 */
function compareSchedules(a: SelectableSchedule, b: SelectableSchedule): number {
  const editable = (r: SelectableSchedule) => (r.cadence === "weekly" ? 0 : 1);
  if (editable(a) !== editable(b)) return editable(a) - editable(b);
  if (a.nextRunAt !== b.nextRunAt) return a.nextRunAt - b.nextRunAt;
  if (a.createdAt !== b.createdAt) return a.createdAt - b.createdAt;
  return a.id < b.id ? -1 : a.id > b.id ? 1 : 0;
}

/**
 * Index a client's schedule rows by custom agent id, one governing row each.
 *
 * Callers get the same answer whatever order they were handed the rows in, and
 * the rows that lost are handed back rather than dropped.
 */
export function selectAgentSchedules<T extends SelectableSchedule>(
  runs: readonly T[],
): Map<string, AgentScheduleSelection<T>> {
  const byAgent = new Map<string, T[]>();
  for (const run of runs) {
    if (!isLiveAgentSchedule(run)) continue;
    const bucket = byAgent.get(run.customAgentId);
    if (bucket) bucket.push(run);
    else byAgent.set(run.customAgentId, [run]);
  }
  const selected = new Map<string, AgentScheduleSelection<T>>();
  for (const [customAgentId, bucket] of byAgent) {
    const [schedule, ...duplicates] = [...bucket].sort(compareSchedules);
    selected.set(customAgentId, { schedule: schedule!, duplicates });
  }
  return selected;
}

/** The one governing row for a single agent, and the live rows beside it. */
export function selectAgentSchedule<T extends SelectableSchedule>(
  runs: readonly T[],
  customAgentId: string,
): AgentScheduleSelection<T> | null {
  return selectAgentSchedules(runs).get(customAgentId) ?? null;
}
