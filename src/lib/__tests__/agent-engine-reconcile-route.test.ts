import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * `GET /api/agent-engine/reconcile` — the periodic half of the agent-engine
 * completion channel, which shipped with no test at all.
 *
 * WHAT THIS IS ABOUT. The sweep queried one thing: jobs still `queued`/
 * `running`, asking "has `job.status` caught up with the run?". It could not see
 * the second kind of incompleteness — a job already at `review` holding no
 * asset, where the status is right and the DELIVERABLE never landed. Those are
 * terminal, so no in-flight query reaches them, and `syncAgentEngineJobStatus`
 * used to return early on them too. Every engine job delivered before its
 * product had a materializer sat that way indefinitely, healed only if a human
 * opened its Job page.
 *
 * SCOPE, stated rather than implied: this covers the cron fence and which
 * candidate sets get swept. It does NOT cover `syncAgentEngineJobStatus` itself
 * (mocked here; its own suite is `lib/agent-engine/__tests__/reconcile.test.ts`)
 * or the Firestore queries' index requirements, which were verified against the
 * real prep database rather than a fake.
 */

const { inFlightMock, unmaterializedMock, syncMock, cronGuardMock } = vi.hoisted(() => ({
  inFlightMock: vi.fn(),
  unmaterializedMock: vi.fn(),
  syncMock: vi.fn(),
  cronGuardMock: vi.fn(),
}));

vi.mock("server-only", () => ({}));
vi.mock("@/lib/data", () => ({
  listInFlightAgentEngineJobs: inFlightMock,
  listUnmaterializedAgentEngineJobs: unmaterializedMock,
}));
vi.mock("@/lib/agent-engine/reconcile", () => ({ syncAgentEngineJobStatus: syncMock }));
vi.mock("@/lib/cron-auth", () => ({ requireCronSecret: cronGuardMock }));

import { GET } from "@/app/api/agent-engine/reconcile/route";
import type { Job } from "@/lib/types";

function job(id: string, overrides: Partial<Job> = {}): Job {
  return {
    id,
    clientId: "c1",
    agentId: "agent-engine",
    agentName: "X / Twitter Content Specialist",
    title: "t",
    status: "review",
    input: {},
    assetIds: [],
    events: [],
    createdBy: "u",
    createdAt: 1,
    updatedAt: 1,
    agentEngineRunId: `run_${id}`,
    ...overrides,
  } as Job;
}

const req = {} as Parameters<typeof GET>[0];

beforeEach(() => {
  cronGuardMock.mockReset().mockReturnValue(undefined); // authorized
  inFlightMock.mockReset().mockResolvedValue([]);
  unmaterializedMock.mockReset().mockResolvedValue([]);
  // Default: the sync is a no-op that hands the job straight back.
  syncMock.mockReset().mockImplementation(async (j: Job) => j);
});

describe("the cron fence", () => {
  it("refuses without the cron secret, and sweeps nothing", async () => {
    const denial = NextResponseLike(401);
    cronGuardMock.mockReturnValue(denial);

    const res = await GET(req);

    expect(res).toBe(denial);
    expect(inFlightMock).not.toHaveBeenCalled();
    expect(unmaterializedMock).not.toHaveBeenCalled();
    expect(syncMock).not.toHaveBeenCalled();
  });
});

describe("which jobs the sweep picks up", () => {
  it("sweeps BOTH the in-flight and the unmaterialized sets", async () => {
    // The regression in one assertion: only the first query existed, so a
    // completed-but-asset-less job was never re-examined by anything.
    inFlightMock.mockResolvedValue([job("running_1", { status: "running" })]);
    unmaterializedMock.mockResolvedValue([job("review_no_asset")]);

    const res = await GET(req);
    const body = await res.json();

    expect(syncMock).toHaveBeenCalledTimes(2);
    expect(syncMock.mock.calls.map((c) => (c[0] as Job).id)).toEqual(["running_1", "review_no_asset"]);
    expect(body.checked).toBe(2);
    expect(body.inFlight).toBe(1);
    expect(body.unmaterialized).toBe(1);
    expect(body.results.map((r: { reason: string }) => r.reason)).toEqual(["in_flight", "unmaterialized"]);
  });

  it("reports the asset COUNT, not just the status, so an unmaterialized sync's outcome is visible", async () => {
    // For an already-`review` job the status was right before and after, so the
    // status alone cannot say whether this tick attached anything.
    unmaterializedMock.mockResolvedValue([job("review_no_asset")]);
    syncMock.mockResolvedValue(job("review_no_asset", { assetIds: ["asset_new"] }));

    const body = await (await GET(req)).json();

    expect(body.results[0].status).toBe("review (1 asset(s))");
  });

  it("keeps going after one job throws, and records the failure against that job", async () => {
    unmaterializedMock.mockResolvedValue([job("bad"), job("good")]);
    syncMock.mockImplementation(async (j: Job) => {
      if (j.id === "bad") throw new Error("engine unreachable");
      return j;
    });

    const body = await (await GET(req)).json();

    expect(body.checked).toBe(2);
    expect(body.results[0].status).toBe("error: engine unreachable");
    expect(body.results[1].status).toBe("review (0 asset(s))");
  });

  it("reports an empty sweep rather than failing when there is nothing to do", async () => {
    const body = await (await GET(req)).json();
    expect(body).toMatchObject({ checked: 0, inFlight: 0, unmaterialized: 0, results: [] });
  });
});

/** A stand-in for whatever `requireCronSecret` returns on denial — the route must pass it through untouched. */
function NextResponseLike(status: number): unknown {
  return { status, __denial: true };
}
