/* eslint-disable @typescript-eslint/no-explicit-any */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import * as data from "@/lib/data";

/**
 * #72 — AN OUTAGE MUST NOT BECOME A BURST OF THE MOST EXPENSIVE OPERATION.
 *
 * The recurring Intel Report + SEO/GEO regeneration is a long multi-agent
 * pipeline, and this cron is one of only three things that can trigger it
 * automatically. It advanced `intelScheduleNextRunAt` one interval on from the
 * slot that just fired — right for a single missed tick, and wrong for a
 * backlog: with three months missed, each advance landed the cursor back in the
 * past, so the client was due again on the next tick fifteen minutes later and
 * got three full pipelines in three quarters of an hour, each overwriting the
 * last.
 *
 * These drive the REAL route over a simulated clock with only the data layer
 * and the pipeline mocked, so the assertion is on how many times
 * runIntelReportPipeline is actually called.
 */

vi.mock("server-only", () => ({}));
vi.mock("@/lib/data");
vi.mock("@/lib/actions/_shared", () => ({
  logActivity: vi.fn().mockResolvedValue(undefined),
  logGenerationFailure: vi.fn().mockResolvedValue(undefined),
}));
vi.mock("@/lib/intel", () => ({
  runIntelReportPipeline: vi.fn().mockResolvedValue(undefined),
}));

const TICK = 15 * 60_000;

let client: Record<string, any>;
let pipeline: any;

function installStore() {
  (data.listClients as any).mockImplementation(async () => [structuredClone(client)]);
  (data.updateClient as any).mockImplementation(async (id: string, patch: Record<string, any>) => {
    if (client.id === id) Object.assign(client, patch);
  });
  (data.tryAcquireAiProcessingLock as any).mockResolvedValue(true);
  (data.releaseAiProcessingLock as any).mockResolvedValue(undefined);
}

async function tick(at: number) {
  vi.setSystemTime(at);
  const { GET } = await import("@/app/api/intel-report-schedule/route");
  const res = await GET(new Request("https://portal.test/api/intel-report-schedule") as any);
  return res.json();
}

beforeEach(async () => {
  vi.clearAllMocks();
  vi.useFakeTimers();
  ({ runIntelReportPipeline: pipeline } = (await import("@/lib/intel")) as any);
  pipeline.mockResolvedValue(undefined);
  client = {
    id: "c1",
    name: "Acme",
    intelScheduleEnabled: true,
    intelScheduleIntervalMonths: 1,
    intelScheduleDayOfMonth: 1,
    // Due since 2026-02-01 09:00 local and never drained — the outage.
    intelScheduleNextRunAt: new Date(2026, 1, 1, 9).getTime(),
  };
  installStore();
});

afterEach(() => {
  vi.useRealTimers();
});

describe("the recurring intel regeneration after an outage", () => {
  it("runs the pipeline ONCE when three monthly slots were missed", async () => {
    // The cron comes back on 2026-05-15 and ticks every fifteen minutes.
    const recovery = new Date(2026, 4, 15, 10, 0).getTime();
    for (let i = 0; i < 6; i++) await tick(recovery + i * TICK);

    expect(pipeline).toHaveBeenCalledTimes(1);
  });

  it("leaves the cursor in the FUTURE, which is what stops the next tick", async () => {
    const recovery = new Date(2026, 4, 15, 10, 0).getTime();
    await tick(recovery);

    expect(client.intelScheduleNextRunAt).toBeGreaterThan(recovery);
  });

  it("keeps the admin's day of month after catching up", async () => {
    // The fixed grid is the reason the anchor is the fired slot rather than
    // "now". Catching up on the 15th must not re-phase the schedule onto the
    // 15th for ever after.
    client.intelScheduleDayOfMonth = 1;
    const recovery = new Date(2026, 4, 15, 10, 0).getTime();
    await tick(recovery);

    expect(new Date(client.intelScheduleNextRunAt).getDate()).toBe(1);
  });

  it("still regenerates once a month when nothing is overdue", async () => {
    // The un-regressed path: a client whose cron has been healthy gets exactly
    // one regeneration per configured slot, not zero.
    client.intelScheduleNextRunAt = new Date(2026, 1, 1, 9).getTime();
    for (let month = 1; month <= 4; month++) {
      for (let i = 0; i < 4; i++) {
        await tick(new Date(2026, month, 1, 9, 5).getTime() + i * TICK);
      }
    }
    expect(pipeline).toHaveBeenCalledTimes(4);
  });

  it("does not swallow the backlog when the pipeline FAILS — the cursor still moves on", async () => {
    // A failed regeneration must not leave the row due again immediately
    // either: that is the same burst with an error attached, and each attempt
    // is a full pipeline's worth of model calls.
    pipeline.mockRejectedValue(new Error("model overloaded"));
    const recovery = new Date(2026, 4, 15, 10, 0).getTime();
    for (let i = 0; i < 4; i++) await tick(recovery + i * TICK);

    expect(pipeline).toHaveBeenCalledTimes(1);
    expect(client.intelScheduleNextRunAt).toBeGreaterThan(recovery);
    // A failure must not stamp a successful report date.
    expect(client.lastIntelReportAt).toBeUndefined();
  });

  it("a schedule that is merely due, not overdue, is unaffected", async () => {
    client.intelScheduleNextRunAt = new Date(2026, 1, 1, 9).getTime();
    await tick(new Date(2026, 1, 1, 9, 1).getTime());

    expect(pipeline).toHaveBeenCalledTimes(1);
    // Exactly one interval on, on the grid — the catch-up walk must not have
    // skipped March.
    expect(client.intelScheduleNextRunAt).toBe(new Date(2026, 2, 1, 9).getTime());
  });
});
