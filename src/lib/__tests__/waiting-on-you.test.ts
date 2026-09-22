import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * "Waiting on you" — the runs that stopped and need a person.
 *
 * `awaiting_gate` deliberately does not change `job.status`: the approval is
 * rendered on the job page by `AgentEngineRunPanel`, which is the right place
 * to ANSWER a gate and the wrong place to DISCOVER one. So a run needing a
 * decision was visible only to whoever already thought to open that job.
 *
 * Measured 2026-09-22: 39 runs parked at a gate in prep and 3 in production,
 * the oldest untouched for 734 hours, none of them surfaced anywhere.
 *
 * The two properties worth pinning are the ones a reviewer cannot see by
 * reading the query: that the visibility fence is STRUCTURAL (the reader is
 * handed already-fenced jobs and can only read their runs, so it cannot
 * return another tenant's work even by mistake), and that the ordering is
 * oldest-first (the whole point is finding what has been ignored longest).
 */

const { getAllMock, docMock, collectionMock, gateGetMock } = vi.hoisted(() => ({
  getAllMock: vi.fn(),
  docMock: vi.fn(),
  collectionMock: vi.fn(),
  gateGetMock: vi.fn(),
}));

vi.mock("server-only", () => ({}));
vi.mock("@/lib/firebase/admin", () => ({
  adminDb: () => ({ collection: collectionMock, getAll: getAllMock }),
}));

import { readRunsWaitingOnYou, WAITING_ON_YOU_READ_LIMIT } from "@/lib/agent-engine/read-run";

type RunDoc = { runId: string; status: string; updatedAt: number; productId: string; pendingGateId?: string };

/** A Firestore-shaped snapshot for one run. */
function snap(run: RunDoc) {
  return { exists: true, data: () => run };
}

function setup(runs: RunDoc[], gates: Record<string, unknown> = {}) {
  getAllMock.mockReset();
  collectionMock.mockReset();
  gateGetMock.mockReset();
  getAllMock.mockResolvedValue(runs.map(snap));
  collectionMock.mockImplementation((name: string) => {
    if (name === "agentEngineGates") {
      return {
        doc: (gateId: string) => ({
          get: async () => (gates[gateId] ? { exists: true, data: () => gates[gateId] } : { exists: false }),
        }),
      };
    }
    return { doc: docMock.mockReturnValue({}) };
  });
}

function job(id: string, runId: string, clientId = "c1") {
  return { id, clientId, agentEngineRunId: runId, agentEngineProductId: "instagram-agent" };
}

describe("readRunsWaitingOnYou", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("returns only the runs that are actually parked at a gate", async () => {
    setup([
      { runId: "r1", status: "running", updatedAt: 10, productId: "instagram-agent" },
      { runId: "r2", status: "awaiting_gate", updatedAt: 20, productId: "instagram-agent" },
      { runId: "r3", status: "completed", updatedAt: 30, productId: "instagram-agent" },
    ]);

    const { items } = await readRunsWaitingOnYou([job("j1", "r1"), job("j2", "r2"), job("j3", "r3")]);

    expect(items.map((i) => i.runId)).toEqual(["r2"]);
    expect(items[0]?.jobId).toBe("j2");
  });

  it("puts the longest-ignored first, which is the only ordering a reader can act on", async () => {
    setup([
      { runId: "new", status: "awaiting_gate", updatedAt: 9_000, productId: "x-agent" },
      { runId: "ancient", status: "awaiting_gate", updatedAt: 1, productId: "x-agent" },
      { runId: "middle", status: "awaiting_gate", updatedAt: 500, productId: "x-agent" },
    ]);

    const { items } = await readRunsWaitingOnYou([job("a", "new"), job("b", "ancient"), job("c", "middle")]);

    expect(items.map((i) => i.runId)).toEqual(["ancient", "middle", "new"]);
  });

  it("carries the gate's timeout policy, because 'ships on its own' and 'waits forever' are opposite facts", async () => {
    setup(
      [{ runId: "r1", status: "awaiting_gate", updatedAt: 1, productId: "instagram-agent", pendingGateId: "g1" }],
      { g1: { gateId: "g1", timeout: { duration: "24h", onTimeout: "hold" } } },
    );

    const { items } = await readRunsWaitingOnYou([job("j1", "r1")]);

    expect(items[0]?.ifIgnored).toBe("hold");
    expect(items[0]?.timeoutDuration).toBe("24h");
  });

  it("survives a gate that predates timeouts, rather than dropping the row", async () => {
    // An older gate document has no `timeout`. The run is still waiting for a
    // person — reporting nothing at all would be worse than reporting it
    // without a policy badge.
    setup([{ runId: "r1", status: "awaiting_gate", updatedAt: 1, productId: "blog-agent", pendingGateId: "missing" }]);

    const { items } = await readRunsWaitingOnYou([job("j1", "r1")]);

    expect(items).toHaveLength(1);
    expect(items[0]?.ifIgnored).toBeUndefined();
  });

  it("keeps a row whose timeout policy it does not recognise, and makes no promise about it", async () => {
    // The stored field is a plain string: it mirrors Firestore, and the engine
    // may add a policy before this mirror learns it. The card can phrase three.
    // A fourth must read as "no promise made" rather than be rendered as one a
    // reader then waits on — and the run still has to appear, because it is
    // still a run that stopped and needs a person.
    setup(
      [{ runId: "r1", status: "awaiting_gate", updatedAt: 1, productId: "x-agent", pendingGateId: "g1" }],
      { g1: { gateId: "g1", timeout: { duration: "12h", onTimeout: "escalate_to_owner" } } },
    );

    const { items } = await readRunsWaitingOnYou([job("j1", "r1")]);

    expect(items).toHaveLength(1);
    expect(items[0]?.ifIgnored).toBeUndefined();
    // The duration is still a fact, and still true.
    expect(items[0]?.timeoutDuration).toBe("12h");
  });

  it("reads nothing at all when no job carries a run id", async () => {
    setup([]);
    const { items, truncated } = await readRunsWaitingOnYou([{ id: "j1", clientId: "c1" }]);
    expect(items).toEqual([]);
    expect(truncated).toBe(false);
    expect(getAllMock).not.toHaveBeenCalled();
  });

  it("bounds the read and says so, instead of quietly fetching every in-flight job", async () => {
    const jobs = Array.from({ length: WAITING_ON_YOU_READ_LIMIT + 5 }, (_, i) => job(`j${i}`, `r${i}`));
    setup([{ runId: "r0", status: "awaiting_gate", updatedAt: 1, productId: "x-agent" }]);

    const { truncated } = await readRunsWaitingOnYou(jobs);

    expect(truncated).toBe(true);
    // The bound is on the READ, so exactly the limit is fetched — not all 205.
    expect(getAllMock.mock.calls[0]).toHaveLength(WAITING_ON_YOU_READ_LIMIT);
  });

  it("can only ever read the runs of jobs it was handed — the fence is structural", async () => {
    // The caller passes jobs it has already filtered to the viewer's visible
    // clients. A status query over `agentEngineRuns` would instead return
    // every tenant's parked runs and rely on filtering afterwards, which is a
    // fence somebody has to remember. This asserts the shape that makes
    // forgetting impossible: the only ids read are the ones passed in.
    setup([{ runId: "mine", status: "awaiting_gate", updatedAt: 1, productId: "x-agent" }]);

    await readRunsWaitingOnYou([job("j1", "mine")]);

    expect(getAllMock).toHaveBeenCalledTimes(1);
    expect(docMock).toHaveBeenCalledTimes(1);
    expect(docMock).toHaveBeenCalledWith("mine");
  });
});
