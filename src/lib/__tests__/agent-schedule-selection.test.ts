import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it, vi } from "vitest";
import {
  firingWeekdays,
  isLiveAgentSchedule,
  isRecurringCadence,
  selectAgentSchedule,
  selectAgentSchedules,
  weeklyFireDays,
} from "@/lib/agent-schedule-selection";
import { slotScheduleFor } from "@/lib/slot-plan";
import { rosterStatus } from "@/lib/client-agents";
import { buildDailyFinderView, finderDays } from "@/lib/agent-detail-archetypes";
import type { PlannedRunCadence, PlannedScheduledRun } from "@/lib/types";

vi.mock("server-only", () => ({}));
vi.mock("@/lib/data", () => ({ getAsset: vi.fn(), listPlannedScheduledRuns: vi.fn() }));
vi.mock("@/lib/data-client-agents", () => ({ listClientAgentFeedback: vi.fn() }));
vi.mock("@/lib/client-agent-slots", () => ({ upcomingSlots: vi.fn() }));
vi.mock("@/lib/agent-service/x-agent-context", () => ({ hasXAgentIntake: vi.fn() }));
vi.mock("@/lib/agent-service/linkedin-agent-context", () => ({ hasLinkedInAgentIntake: vi.fn() }));
vi.mock("@/lib/agent-service/reddit-agent-context", () => ({ hasRedditAgentIntake: vi.fn() }));

const { toScheduleRows } = await import("@/lib/client-agent-rows");

/**
 * A SCHEDULE THAT IS INVISIBLE, DUPLICATED, OR LYING ABOUT ITS STATE.
 *
 * Three defects, one root each:
 *
 *  #63 five separate `cadence === "weekly"` filters dropped a DAILY schedule
 *      that was firing and billing, so the client's card offered "Start
 *      posting" for an agent already posting every day.
 *  #64 two live rows for one client and agent, each surface picking a
 *      different one — or the same one by accident, until `nextRunAt` moved.
 *  #65 the Reddit panel derived "is it running?" twice and printed both
 *      answers: "Not looking yet" above chips dated tomorrow.
 *
 * Every assertion below has been mutation-checked: the exact edit it must
 * catch was made against the source, the test confirmed RED, and the edit
 * reverted. The mutations are named in the campaign report.
 */

const NOW = Date.UTC(2026, 6, 28, 12, 0, 0); // 2026-07-28T12:00:00Z, a Tuesday
const DAY = 24 * 60 * 60 * 1000;
const ZONE = "UTC";
const REPO = path.resolve(__dirname, "../..", "..");
const source = (rel: string) => readFileSync(path.join(REPO, rel), "utf8");

function run(overrides: Partial<PlannedScheduledRun> = {}): PlannedScheduledRun {
  return {
    id: "sched_1",
    clientId: "client_1",
    customAgentId: "ca_reddit",
    agentName: "Reddit Agent",
    agentIcon: "Search",
    agentColor: "#fff",
    prompt: "Find a thread.",
    cadence: "weekly",
    hour: 9,
    minute: 0,
    weekdays: [1, 2, 3, 4, 5],
    timeZone: ZONE,
    nextRunAt: NOW + DAY,
    status: "active",
    createdBy: "uid_staff",
    createdAt: NOW - 30 * DAY,
    updatedAt: NOW - DAY,
    ...overrides,
  };
}

/* ═══════════════ #63 · the rule that dropped a daily schedule ═══════════ */

describe("which schedules govern an agent's surfaces", () => {
  /**
   * Exhaustive over the cadence union AND the status union — 12 cells, so a
   * fifth cadence or a fourth status cannot be added without this failing to
   * compile. `once` is out because it fires and completes (a booking, not a
   * pace); `completed` is out at every cadence.
   */
  const ADMITTED: Record<PlannedRunCadence, Record<PlannedScheduledRun["status"], boolean>> = {
    once: { active: false, paused: false, completed: false },
    daily: { active: true, paused: true, completed: false },
    weekly: { active: true, paused: true, completed: false },
    monthly: { active: true, paused: true, completed: false },
  };

  it.each(Object.keys(ADMITTED) as PlannedRunCadence[])(
    "admits %s at each status exactly as the table says",
    (cadence) => {
      for (const status of ["active", "paused", "completed"] as const) {
        expect({ cadence, status, admitted: isLiveAgentSchedule({ cadence, status }) }).toEqual({
          cadence,
          status,
          admitted: ADMITTED[cadence][status],
        });
      }
    },
  );

  it("counts a one-off out of the recurring set and the other three in", () => {
    expect(isRecurringCadence("once")).toBe(false);
    expect(["daily", "weekly", "monthly"].map(isRecurringCadence as (c: string) => boolean)).toEqual(
      [true, true, true],
    );
  });

  it("reads a daily row as all seven weekdays, which is what daily means", () => {
    // The defect in one line: a daily row stores NO `weekdays` array (the cron
    // does not need one), so every weekday-based projection read it as "no
    // firing days" and produced an empty week for the one agent that works
    // every day.
    expect(firingWeekdays({ cadence: "daily" })).toEqual([0, 1, 2, 3, 4, 5, 6]);
    expect(weeklyFireDays({ cadence: "daily" })).toBe(7);
  });

  it("keeps a weekly row's own days, deduped, validated and ordered", () => {
    expect(firingWeekdays({ cadence: "weekly", weekdays: [5, 1, 5, 3] })).toEqual([1, 3, 5]);
    expect(weeklyFireDays({ cadence: "weekly", weekdays: [5, 1, 5, 3] })).toBe(3);
    // Written before `weekdays` existed: the single `weekday` field is the row.
    expect(firingWeekdays({ cadence: "weekly", weekday: 4 })).toEqual([4]);
    // Out-of-range days are dropped, and a row left with none is not a weekly
    // grid at all rather than an empty one.
    expect(firingWeekdays({ cadence: "weekly", weekdays: [9, -1] })).toBeNull();
    // A weekly row that names no day at all still quotes one fire a week — the
    // legacy shape the card has always counted as 1.
    expect(weeklyFireDays({ cadence: "weekly" })).toBe(1);
  });

  it("refuses to give monthly or once a posts-per-week figure", () => {
    // The stated residual, pinned so it cannot be "fixed" by defaulting to 1:
    // the pace dialog multiplies this by the run cost to price the week, so
    // calling a monthly schedule one-a-week overstates its cost by over 4x.
    for (const cadence of ["monthly", "once"] as const) {
      expect({ cadence, week: weeklyFireDays({ cadence }), days: firingWeekdays({ cadence }) }).toEqual(
        { cadence, week: null, days: null },
      );
    }
  });

  it("plans slots for a daily umbrella instead of leaving its calendar empty", () => {
    const daily = slotScheduleFor({ cadence: "daily", status: "active" }, "Asia/Jerusalem");
    expect(daily).toEqual({
      weekdays: [0, 1, 2, 3, 4, 5, 6],
      timeZone: "Asia/Jerusalem",
      status: "active",
    });
    // Same call, monthly: still nothing a weekday grid can hold.
    expect(slotScheduleFor({ cadence: "monthly", status: "active" }, "UTC")).toBeNull();
  });

  it("puts a daily schedule's pace, next fire and Pause on the client's card", () => {
    // The whole client-visible symptom of #63, through the real projection:
    // the card got `schedule: null` for a schedule that was firing and billing,
    // so it showed no pace, no next run, no Pause — and a "Start posting"
    // button, which is how the second schedule got created (#64).
    const rows = toScheduleRows([run({ cadence: "daily", weekdays: undefined })], true);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      agentId: "ca_reddit",
      status: "active",
      postsPerWeek: 7,
      nextRunAt: NOW + DAY,
    });
  });
});

/* ═════════════════ #64 · two live rows, one governing row ═══════════════ */

describe("picking one schedule when a client has two for the same agent", () => {
  const soonest = run({ id: "sched_soonest", nextRunAt: NOW + DAY, createdAt: NOW - 2 * DAY });
  const later = run({ id: "sched_later", nextRunAt: NOW + 3 * DAY, createdAt: NOW - 40 * DAY });

  it("returns one governing row and hands back the ones it did not pick", () => {
    const selection = selectAgentSchedule([later, soonest], "ca_reddit");
    expect(selection?.schedule.id).toBe("sched_soonest");
    expect(selection?.duplicates.map((d) => d.id)).toEqual(["sched_later"]);
  });

  it("gives the same answer whatever order the rows arrive in", () => {
    // The bug was ORDER-DEPENDENCE, not the choice: `toScheduleRows` fed a Map
    // so the LAST row won, while the detail page and the configure action took
    // the FIRST of a list the data layer sorts by nextRunAt. The card could
    // show one schedule while Save rewrote the other.
    const orders = [
      [soonest, later],
      [later, soonest],
    ];
    const picked = orders.map((rows) => selectAgentSchedule(rows, "ca_reddit")?.schedule.id);
    expect(picked).toEqual(["sched_soonest", "sched_soonest"]);
  });

  it("breaks a nextRunAt tie by createdAt and then by id, so the order is total", () => {
    const tieA = run({ id: "sched_b", nextRunAt: NOW + DAY, createdAt: NOW - 5 * DAY });
    const tieB = run({ id: "sched_a", nextRunAt: NOW + DAY, createdAt: NOW - 5 * DAY });
    const tieOlder = run({ id: "sched_z", nextRunAt: NOW + DAY, createdAt: NOW - 9 * DAY });
    // createdAt decides first…
    expect(selectAgentSchedule([tieA, tieB, tieOlder], "ca_reddit")?.schedule.id).toBe("sched_z");
    // …and with createdAt equal too, the id does, in both input orders.
    expect(selectAgentSchedule([tieA, tieB], "ca_reddit")?.schedule.id).toBe("sched_a");
    expect(selectAgentSchedule([tieB, tieA], "ca_reddit")?.schedule.id).toBe("sched_a");
  });

  it("names the row Save will actually write, even when another fires sooner", () => {
    // A MONEY RULE, not a taste one. `configureClientAgentScheduleAction` — the
    // action behind the client's pace dialog — still matches weekly only. Order
    // by nextRunAt alone and a client with one daily row and one weekly row is
    // shown the DAILY row's seven-days-a-week pace, prefilled into a dialog
    // whose Save rewrites the WEEKLY row: one press with nothing touched pushes
    // that weekly row from its own pace up to seven. Weekly-first keeps the
    // mixed case behaving exactly as it did when daily rows were invisible.
    const dailySooner = run({ id: "sched_daily", cadence: "daily", nextRunAt: NOW + DAY });
    const weeklyLater = run({ id: "sched_weekly", cadence: "weekly", nextRunAt: NOW + 4 * DAY });
    const selection = selectAgentSchedule([dailySooner, weeklyLater], "ca_reddit");
    expect(selection?.schedule.id).toBe("sched_weekly");
    expect(selection?.duplicates.map((d) => d.id)).toEqual(["sched_daily"]);
    // …and the client's card quotes that row's pace, not the daily row's 7.
    expect(toScheduleRows([dailySooner, weeklyLater], true)).toMatchObject([
      { id: "sched_weekly", postsPerWeek: 5 },
    ]);
  });

  it("does not let an active row jump ahead of a paused one that fires sooner", () => {
    // Deliberate, and the reason is written on compareSchedules: preferring an
    // active row would read better and would point the card at a DIFFERENT row
    // from the one `configureClientAgentScheduleAction` edits (it takes the
    // first match of a nextRunAt-sorted list). A card that displays A while
    // Save writes B is worse than a card showing a paused schedule.
    const pausedSooner = run({ id: "sched_paused", status: "paused", nextRunAt: NOW + DAY });
    const activeLater = run({ id: "sched_active", status: "active", nextRunAt: NOW + 5 * DAY });
    expect(selectAgentSchedule([activeLater, pausedSooner], "ca_reddit")?.schedule.id).toBe(
      "sched_paused",
    );
  });

  it("never picks or reports a retired schedule", () => {
    const done = run({ id: "sched_done", status: "completed", nextRunAt: NOW - DAY });
    const selection = selectAgentSchedule([done, soonest], "ca_reddit");
    expect(selection?.schedule.id).toBe("sched_soonest");
    expect(selection?.duplicates).toEqual([]);
    expect(selectAgentSchedule([done], "ca_reddit")).toBeNull();
  });

  it("keeps each agent's rows to itself", () => {
    const other = run({ id: "sched_other", customAgentId: "ca_x", nextRunAt: NOW });
    const index = selectAgentSchedules([other, soonest, later]);
    expect([...index.keys()].sort()).toEqual(["ca_reddit", "ca_x"]);
    expect(index.get("ca_x")?.duplicates).toEqual([]);
  });

  it("makes the client's card and the detail page name the same schedule row", () => {
    // The cross-surface property, asserted across the two real projections
    // rather than inside one of them: `toScheduleRows` builds the card, and
    // `selectAgentSchedule` is what the detail route resolves `plannedRun`
    // with. One row out of the card, and it is that row.
    const rows = toScheduleRows([later, soonest], true);
    expect(rows.map((r) => r.id)).toEqual([
      selectAgentSchedule([later, soonest], "ca_reddit")!.schedule.id,
    ]);
  });
});

/* ═════════════ #65 · one panel, one answer to "is it running?" ══════════ */

describe("a paused schedule does not project days it will not fire on", () => {
  const paused = run({ status: "paused" });

  it("stops dating the next four fires of a schedule that will not fire", () => {
    // `finderDays` early-returned only for a missing or completed run, so a
    // PAUSED run fell through to projectRunOccurrences — which knows nothing
    // about status — and the strip printed chips for tomorrow and after under
    // a header reading "Not looking yet".
    expect(finderDays({ run: paused, now: NOW, zone: ZONE })).toEqual([]);
    // The active row it was built from still projects, so the empty list above
    // is the pause and not a broken projection.
    expect(finderDays({ run: run(), now: NOW, zone: ZONE }).length).toBeGreaterThan(0);
  });

  it("gives the panel ONE schedule state, and the strip agrees with it", () => {
    const view = (r: PlannedScheduledRun | null) =>
      buildDailyFinderView({
        assets: [],
        jobs: [],
        run: r,
        viewerIsClient: true,
        now: NOW,
        zone: ZONE,
      });
    // The three states, each with the days that state implies. Asserted as one
    // object per case so a state that stopped matching its own strip fails
    // here rather than passing two separate half-assertions.
    expect([null, paused, run()].map((r) => {
      const v = view(r);
      return { state: v.scheduleState, hasDays: v.days.length > 0 };
    })).toEqual([
      { state: "none", hasDays: false },
      { state: "paused", hasDays: false },
      { state: "active", hasDays: true },
    ]);
  });

  it("keeps 'paused' distinct from 'no schedule' in the panel's own copy", () => {
    // The remedy this fix could have taken with it: an empty strip used to mean
    // exactly one thing ("nobody has scheduled this"), and routing a paused
    // schedule into that same branch would tell a client there is no schedule
    // when there is one and it is theirs to resume.
    const panel = source("src/components/client-agents/daily-finder-panel.tsx");
    expect(panel).toContain('state === "paused"');
    expect(panel).toContain("No schedule yet");
    // And the page no longer derives the answer a second time to hand in.
    // Scoped to the ELEMENT, not to the file: `emptyHint` is also ClipGallery's
    // prop three sections up, and a guard keyed to a string another component
    // owns fails for reasons that have nothing to do with the finder.
    const element = /<DailyFinderPanel[\s\S]*?\/>/.exec(
      source("src/app/(app)/clients/[id]/agents/[agentId]/page.tsx"),
    );
    expect(element).not.toBeNull();
    expect(element![0]).not.toContain("scheduleActive");
    expect(element![0]).not.toContain("emptyHint");
  });
});

/* ════════════ #69 · a refusal that a pause already answered ═════════════ */

describe("a paused schedule's refusal stops badging the agent", () => {
  it("drops the refusal rung for a paused schedule and keeps it for an active one", () => {
    const refusal = {
      launchState: "live" as const,
      scheduleRefusal: "This agent could not start on its last scheduled run.",
      scheduleRefusalAt: NOW - 60 * 60 * 1000,
      now: NOW,
    };
    expect(rosterStatus({ ...refusal, scheduleActive: false })).toEqual({
      tone: "live",
      label: "Live",
    });
    expect(rosterStatus({ ...refusal, scheduleActive: true })).toEqual({
      tone: "attention",
      label: "Needs attention",
    });
  });

  it("still raises a refusal it cannot place, rather than silencing it", () => {
    // `=== false`, not falsy: a caller that does not know whether the schedule
    // is paused gets the alarm. An unanswerable question must not mute one.
    expect(
      rosterStatus({
        launchState: "live",
        scheduleRefusal: "Turned away.",
        scheduleRefusalAt: NOW,
        now: NOW,
      }),
    ).toMatchObject({ tone: "attention" });
  });

  it("leaves no call site deciding the pause rule for itself", () => {
    // Rule: the blocker is always one rule written more than once. Three pages
    // each carried `schedule?.status === "active" ? schedule.lastError : null`
    // in their rosterStatus arguments; the rule lives in refusalIsCurrent now,
    // and these files must not grow their own copy back.
    for (const rel of [
      "src/app/(app)/clients/[id]/agents/page.tsx",
      "src/app/(app)/clients/[id]/agents/[agentId]/page.tsx",
    ]) {
      expect({ rel, reDerived: source(rel).includes('status === "active" ? schedule.lastError') })
        .toEqual({ rel, reDerived: false });
    }
    expect(source("src/lib/client-agents.ts")).toContain("input.scheduleActive === false");
  });
});

/* ══════════ the tripwire: no module may grow a sixth private filter ═════ */

describe("the weekly-only filter exists in one place", () => {
  /**
   * The five sites that each held a copy, named individually so this asserts
   * about the file it names rather than grepping the tree with exemptions.
   * `planned-run-actions.ts` is DELIBERATELY absent — it holds the sixth copy,
   * inside `configureClientAgentScheduleAction`, and is owned by another pass;
   * listing it here would make this test fail for work this change did not do.
   * That handoff is recorded in the campaign report, not asserted here.
   */
  const CONSOLIDATED = [
    "src/lib/client-agent-rows.ts",
    "src/lib/client-agent-slots.ts",
    "src/lib/slot-plan.ts",
    "src/app/(app)/clients/[id]/agents/[agentId]/page.tsx",
  ];

  it.each(CONSOLIDATED)("%s tests the cadence through the shared rule, not inline", (rel) => {
    const src = source(rel);
    // Comments are stripped first: every one of these files EXPLAINS the old
    // filter in prose, and a guard that trips on its own explanation is a guard
    // nobody can document around.
    const code = src
      .replace(/\/\*[\s\S]*?\*\//g, "")
      .split("\n")
      .filter((line) => !line.trim().startsWith("//"))
      .join("\n");
    expect({ rel, inlineCadenceTest: /cadence\s*[!=]==\s*"weekly"/.test(code) }).toEqual({
      rel,
      inlineCadenceTest: false,
    });
    expect(src).toContain("agent-schedule-selection");
  });
});
