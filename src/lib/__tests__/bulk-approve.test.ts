/* eslint-disable @typescript-eslint/no-explicit-any */
import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * A BULK APPROVAL IS N SINGLE APPROVALS, AND THE PLAN IS SHOWN FIRST.
 *
 * Two rules carry this feature and both are about what it must NOT become.
 *
 * It must not become a second approval path: `approveAssetAction` is where the
 * Test Run fence lives, where auto-publish is refused unless the client opted
 * in and the integration is usable, where the producing job is closed. A bulk
 * path with its own `updateAsset` would have none of that.
 *
 * And it must not become a second scheduler: the slots come from
 * `planBulkSchedule`, the pace-aware, weekend-skipping planner the clip
 * uploader already uses. "Every two hours" would have been easy and would have
 * contradicted how much the product says a client publishes in a day.
 *
 * The third rule is the one a reviewer feels: ONE FAILURE DOES NOT COST THE
 * BATCH. Seven good approvals thrown away because the eighth was a Test Run is
 * the shape this repo refuses everywhere else.
 */

const { approveMock, listAssetsMock, getClientMock, requireStaffMock, planMock } = vi.hoisted(() => ({
  approveMock: vi.fn(),
  listAssetsMock: vi.fn(),
  getClientMock: vi.fn(),
  requireStaffMock: vi.fn(),
  planMock: vi.fn(),
}));

vi.mock("server-only", () => ({}));
vi.mock("next/cache", () => ({ revalidatePath: vi.fn() }));
vi.mock("@/lib/data", () => ({ listAssets: listAssetsMock, getClient: getClientMock }));
vi.mock("@/lib/actions/_shared", () => ({ requireStaff: requireStaffMock }));
vi.mock("@/lib/actions/asset-actions", () => ({ approveAssetAction: approveMock }));
vi.mock("@/lib/bulk-schedule", async (importOriginal) => {
  const actual = await importOriginal<Record<string, unknown>>();
  return { ...actual, planBulkSchedule: planMock };
});

import { bulkApproveAssetsAction, previewBulkApproveAction } from "@/lib/actions/bulk-approve-actions";
import { MAX_BULK_APPROVE } from "@/lib/bulk-approve-limits";

const DAY = 24 * 60 * 60 * 1000;
const START = new Date("2026-09-28T00:00:00.000Z").getTime();

function asset(id: string, over: Record<string, any> = {}) {
  return { id, clientId: "c1", title: `Draft ${id}`, type: "social_post", status: "draft", createdAt: 1, channels: ["linkedin"], ...over } as any;
}

beforeEach(() => {
  vi.clearAllMocks();
  requireStaffMock.mockResolvedValue({ uid: "u1" });
  getClientMock.mockResolvedValue({ id: "c1", dailyPace: undefined });
  // The real planner is exercised by `daily-pace.test.ts`; here it is mocked so
  // these cases are about the ACTION, and so a change to the pace rules cannot
  // silently rewrite what this file claims.
  planMock.mockImplementation((ids: string[]) => ids.map((id, i) => ({ id, scheduledAt: START + i * DAY })));
});

describe("what the reviewer is shown before anything is written", () => {
  it("plans every selected draft, in slot order, and writes nothing", async () => {
    listAssetsMock.mockResolvedValue([asset("a"), asset("b"), asset("c")]);
    const preview = await previewBulkApproveAction(["a", "b", "c"], START);

    expect(preview.rows.map((r) => r.id)).toEqual(["a", "b", "c"]);
    expect(preview.rows.map((r) => r.scheduledAt)).toEqual([START, START + DAY, START + 2 * DAY]);
    expect(preview.rows[0]!.platform).toBe("linkedin");
    expect(approveMock).not.toHaveBeenCalled();
  });

  it("says why, in a sentence, when the batch is too big to review", async () => {
    const ids = Array.from({ length: MAX_BULK_APPROVE + 1 }, (_, i) => `a${i}`);
    listAssetsMock.mockResolvedValue(ids.map((id) => asset(id)));
    const preview = await previewBulkApproveAction(ids, START);
    expect(preview.rows).toEqual([]);
    expect(preview.refusal).toMatch(/most one approval may cover/);
  });

  it("says so rather than showing an empty list when nothing is selected", async () => {
    expect((await previewBulkApproveAction([], START)).refusal).toMatch(/Nothing is selected/);
  });
});

describe("what the approval does", () => {
  it("goes through the single-asset approval, with the slot the summary showed", async () => {
    listAssetsMock.mockResolvedValue([asset("a"), asset("b")]);
    const result = await bulkApproveAssetsAction(["a", "b"], START);

    expect(approveMock).toHaveBeenCalledTimes(2);
    expect(approveMock.mock.calls[0]![0]).toBe("a");
    expect(approveMock.mock.calls[0]![1]).toMatchObject({ scheduledAt: START, publishMode: "manual", platforms: ["linkedin"] });
    expect(result.results.every((r) => r.error === undefined)).toBe(true);
  });

  it("keeps the rest of the batch when one row is refused", async () => {
    // The case that names itself: a Test Run in the selection. The single
    // approval throws for it, and seven other posts must still land.
    listAssetsMock.mockResolvedValue([asset("a"), asset("b"), asset("c")]);
    approveMock.mockImplementation(async (id: string) => {
      if (id === "b") throw new Error("This is a Test Run draft. Use Promote instead of Approve.");
    });

    const result = await bulkApproveAssetsAction(["a", "b", "c"], START);
    expect(result.results.filter((r) => r.error === undefined).map((r) => r.id)).toEqual(["a", "c"]);
    expect(result.results.find((r) => r.id === "b")!.error).toMatch(/Test Run/);
  });

  it("approves one at a time, never as a fan-out", async () => {
    // A batch of 25 against one client's rate limits is how a bulk button
    // becomes a bulk outage. Proven by watching the overlap, not by reading
    // the code: each call must finish before the next begins.
    listAssetsMock.mockResolvedValue([asset("a"), asset("b"), asset("c")]);
    let inFlight = 0;
    let maxInFlight = 0;
    approveMock.mockImplementation(async () => {
      inFlight += 1;
      maxInFlight = Math.max(maxInFlight, inFlight);
      await new Promise((resolve) => setTimeout(resolve, 5));
      inFlight -= 1;
    });

    await bulkApproveAssetsAction(["a", "b", "c"], START);
    expect(maxInFlight).toBe(1);
  });

  it("writes nothing at all when the plan refused", async () => {
    const ids = Array.from({ length: MAX_BULK_APPROVE + 1 }, (_, i) => `a${i}`);
    listAssetsMock.mockResolvedValue(ids.map((id) => asset(id)));
    const result = await bulkApproveAssetsAction(ids, START);
    expect(approveMock).not.toHaveBeenCalled();
    expect(result.refusal).toMatch(/most one approval may cover/);
  });

  it("asks each client's own planner, so one client's days are not booked against another's", async () => {
    listAssetsMock.mockImplementation(async (filter: any) =>
      filter?.clientId === undefined
        ? [asset("a"), asset("b", { clientId: "c2" })]
        : [asset(filter.clientId === "c1" ? "a" : "b", { clientId: filter.clientId })],
    );
    await previewBulkApproveAction(["a", "b"], START);
    expect(planMock).toHaveBeenCalledTimes(2);
    expect(planMock.mock.calls.map((c) => (c[0] as string[]).length)).toEqual([1, 1]);
  });
});
