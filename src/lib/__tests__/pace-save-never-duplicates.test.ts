/* eslint-disable @typescript-eslint/no-explicit-any */
import { beforeEach, describe, expect, it, vi } from "vitest";
vi.mock("server-only", () => ({}));
vi.mock("next/cache", () => ({ revalidatePath: vi.fn() }));
vi.mock("@/lib/data");
vi.mock("@/lib/actions/_shared", async (io) => {
  const a = await io<any>();
  // `requireClientAccess` resolves to the AppUser, not to a { user, client }
  // pair — it returned the pair here, so `user.role` read as undefined and
  // every role branch in the action took its STAFF arm. That was invisible
  // until the assignment fence (`clientAccessRefusal`, real in this file)
  // started reading the role off the same value and refused the shapeless
  // actor. Fixed to a well-formed staff user, ASSIGNED to c1, so the actor's
  // effective behaviour in these four cases is exactly what it has always been
  // — the save path, not the role branches, is what this file is about.
  return {
    ...a,
    logActivity: vi.fn(),
    requireClientAccess: vi.fn(async () => ({
      uid: "u-staff",
      role: "KAROS_EMPLOYEE",
      clientId: null,
      assignedClientIds: ["c1"],
      createdAt: 0,
    })),
  };
});
vi.mock("@/lib/jobs/schedule-gate", () => ({ unfireableScheduleReason: vi.fn(async () => null) }));
import * as data from "@/lib/data";
import { configureClientAgentScheduleAction } from "@/lib/actions/planned-run-actions";

const DAILY = {
  id: "pr_daily", clientId: "c1", customAgentId: "ca1", cadence: "daily",
  status: "active", nextRunAt: Date.now() + 3600_000, createdAt: 1, hour: 9, minute: 0,
  outputsPerRun: 1, prompt: "post something", weekdays: [0,1,2,3,4,5,6], timeZone: "UTC",
};

/**
 * ONE SAVE PRESS MAY NEVER LEAVE A CLIENT WITH TWO LIVE SCHEDULES.
 *
 * The read paths were widened so a DAILY schedule finally appears on the client's
 * pace card (#63 — five weekly-only filters hid a schedule that was firing and
 * billing). The write path was not: `configureClientAgentScheduleAction` still
 * resolved the row it edits with `cadence === "weekly"`.
 *
 * So the card rendered the daily row, the dialog therefore said "Save pace" and
 * prefilled 7, and one press with nothing touched took the CREATE branch: a new
 * ACTIVE weekly row with `billClientCredits: true`, beside a daily row that kept
 * firing. `/api/run-scheduled` drains and bills both — seven billed fires a week
 * become fourteen. The selector then preferred the weekly row, so the runaway
 * daily one dropped off the card and could not even be paused from it.
 *
 * Neither half was wrong on its own; nobody owned the join. That is the second
 * time this campaign has shipped a hole at a file-ownership seam, and it is why
 * this test drives the REAL action against the REAL selector rather than
 * asserting about either side.
 *
 * Verified non-vacuous: against the pre-fix resolution this file is RED, and the
 * probe prints `CREATED: 1 / UPDATED: []`.
 */
describe("the pace dialog edits the schedule the card showed", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(data.listPlannedScheduledRuns).mockResolvedValue([DAILY] as any);
    vi.mocked(data.getCustomAgent).mockResolvedValue({ id: "ca1", key: "k", name: "A", enabled: true, icon: "Bot", color: "#fff" } as any);
    vi.mocked(data.listCustomAgents).mockResolvedValue([{ id: "ca1", key: "k", name: "A", enabled: true }] as any);
    vi.mocked(data.getClient).mockResolvedValue({ id: "c1", name: "Acme", status: "active", createdAt: 0, customAgentIds: ["ca1"] } as any);
    vi.mocked(data.updatePlannedScheduledRun).mockResolvedValue(undefined as any);
    vi.mocked(data.createPlannedScheduledRun).mockResolvedValue("pr_new" as any);
  });

  it("updates a DAILY row instead of creating a weekly one beside it", async () => {
    const res = await configureClientAgentScheduleAction({
      clientId: "c1", customAgentId: "ca1", postsPerWeek: 7,
      outputsPerRun: 1, prompt: "post something", hour: 9, minute: 0, timeZone: "UTC",
    } as any);
    expect(res.error, "the save was refused").toBeUndefined();
    expect(
      data.createPlannedScheduledRun,
      "Save created a SECOND schedule; the daily row is still live and both will bill",
    ).not.toHaveBeenCalled();
    expect(data.updatePlannedScheduledRun).toHaveBeenCalled();
    expect(vi.mocked(data.updatePlannedScheduledRun).mock.calls[0]![0]).toBe("pr_daily");
  });

  it("converts it rather than leaving two cadences live", async () => {
    await configureClientAgentScheduleAction({
      clientId: "c1", customAgentId: "ca1", postsPerWeek: 5,
      outputsPerRun: 1, prompt: "post something", hour: 9, minute: 0, timeZone: "UTC",
    } as any);
    const patch = vi.mocked(data.updatePlannedScheduledRun).mock.calls[0]![1] as any;
    // Weekly is the only pace this dialog can express, so saving through it
    // converts the row. That is strictly fewer fires than the duplicate it
    // replaced, which is the only direction a change here may move.
    expect(patch.cadence).toBe("weekly");
    expect(patch.weekdays.length).toBe(5);
  });

  it("still creates one when the agent genuinely has none", async () => {
    // The other direction: the fix must not turn "no schedule yet" into a silent
    // no-op, which would leave "Start posting" doing nothing at all.
    vi.mocked(data.listPlannedScheduledRuns).mockResolvedValue([] as any);
    await configureClientAgentScheduleAction({
      clientId: "c1", customAgentId: "ca1", postsPerWeek: 3,
      outputsPerRun: 1, prompt: "post something", hour: 9, minute: 0, timeZone: "UTC",
    } as any);
    expect(data.createPlannedScheduledRun).toHaveBeenCalled();
    expect(data.updatePlannedScheduledRun).not.toHaveBeenCalled();
  });

  it("does not touch a COMPLETED row — retired stays retired", async () => {
    vi.mocked(data.listPlannedScheduledRuns).mockResolvedValue([
      { ...DAILY, status: "completed" },
    ] as any);
    await configureClientAgentScheduleAction({
      clientId: "c1", customAgentId: "ca1", postsPerWeek: 3,
      outputsPerRun: 1, prompt: "post something", hour: 9, minute: 0, timeZone: "UTC",
    } as any);
    expect(data.updatePlannedScheduledRun).not.toHaveBeenCalled();
    expect(data.createPlannedScheduledRun).toHaveBeenCalled();
  });
});