/* eslint-disable @typescript-eslint/no-explicit-any */
import { beforeEach, describe, expect, it, vi } from "vitest";
import * as data from "@/lib/data";
import * as dataClientAgents from "@/lib/data-client-agents";
import * as auth from "@/lib/auth";

/**
 * D1 — the §2 guard rail must key on the BILLED actor, not the dispatching one.
 *
 * The agent card's Run button was guarded from the start. The TASK BOARD was
 * not: dragging a karos_managed card to In Progress charges the client's
 * credits (chargeClientCredits fires against the session user) and then hands
 * the run to the execution engine, which dispatches it as TASK_ENGINE_ACTOR — a
 * synthetic KAROS_ADMIN. Every guard downstream of that hand-off sees staff and
 * waves the run through, so a client could run, and pay for, an agent whose
 * umbrella is still being set up simply by using the board instead of the card.
 *
 * These tests drive the real actions with a REAL (billable) client session
 * against a non-live umbrella and assert three things: the run is refused, the
 * task is never claimed, and no credits are taken.
 */

vi.mock("server-only", () => ({}));
vi.mock("next/cache", () => ({ revalidatePath: () => {} }));
vi.mock("next/server", () => ({ after: (fn: () => void) => fn() }));
vi.mock("@/lib/data");
vi.mock("@/lib/data-client-agents");
vi.mock("@/lib/auth");
vi.mock("@/lib/execution-engine", () => ({
  inferOwnerEngine: () => "karos_managed",
  runTaskExecution: vi.fn().mockResolvedValue(undefined),
  plannedTaskExecutionCost: vi.fn().mockResolvedValue(5),
  resolveTaskType: vi.fn().mockReturnValue("content_generation"),
  dispatchArtifactEmail: vi.fn(),
}));

/** A real client user: role CLIENT_USER, no impersonatedBy ⇒ isBillableClientActor. */
const CLIENT = {
  uid: "u-client",
  email: "client@acme.test",
  name: "Client User",
  role: "CLIENT_USER",
  disabled: false,
  clientId: "c1",
  createdAt: 0,
} as any;

const CUSTOM_AGENT_ID = "ca-instagram";

/** A task the copilot linked to a custom agent — the dispatch path under test. */
function makeTask(patch: Record<string, any> = {}): any {
  return {
    id: "t1",
    clientId: "c1",
    title: "Instagram post for launch week",
    status: "pending",
    owner: "karos_managed",
    priority: "medium",
    source: "swarm",
    metadata: { customAgentId: CUSTOM_AGENT_ID },
    createdAt: 0,
    updatedAt: 0,
    ...patch,
  };
}

/** The umbrella the guard resolves, in a state that is NOT live. */
function umbrella(launchState: string) {
  return {
    id: "ca1",
    clientId: "c1",
    agentKey: "karos-instagram-agent",
    customAgentId: CUSTOM_AGENT_ID,
    displayName: "Instagram agent",
    launchState,
    templates: [],
  } as any;
}

beforeEach(() => {
  vi.clearAllMocks();
  vi.spyOn(auth, "getCurrentUser").mockResolvedValue(CLIENT);
  (auth.requireUser as any) = vi.fn().mockResolvedValue(CLIENT);
  // The guard resolves the umbrella by the agent's STABLE KEY.
  (data.getCustomAgent as any).mockResolvedValue({
    id: CUSTOM_AGENT_ID,
    key: "karos-instagram-agent",
    name: "Instagram agent",
    enabled: true,
  });
  (data.getClientTask as any).mockResolvedValue(makeTask());
  (data.getClient as any).mockResolvedValue({ id: "c1", name: "Acme" });
});

describe("D1 — task-board dispatch honors the §2 guard rail", () => {
  for (const state of ["not_launched", "launching", "curating", "launch_failed"]) {
    it(`refuses a client's board drag while the umbrella is "${state}"`, async () => {
      (dataClientAgents.getClientAgentByKey as any).mockResolvedValue(umbrella(state));
      const { updateTaskStatusAction } = await import("@/lib/actions/task-actions");

      const result = await updateTaskStatusAction("t1", "in_progress", "c1");

      expect(result.ok).toBe(false);
      expect(result.error).toBeTruthy();
      // Refused BEFORE the claim and BEFORE the charge — a guard that fires
      // after the debit would leave a charge with no run behind it.
      expect(data.claimTaskForExecution).not.toHaveBeenCalled();
      expect(data.chargeClientCredits).not.toHaveBeenCalled();
    });
  }

  it("lets the same client through once the umbrella is live", async () => {
    (dataClientAgents.getClientAgentByKey as any).mockResolvedValue(umbrella("live"));
    (data.claimTaskForExecution as any).mockResolvedValue({
      ...makeTask(),
      status: "in_progress",
    });
    (data.chargeClientCredits as any).mockResolvedValue(undefined);
    const { updateTaskStatusAction } = await import("@/lib/actions/task-actions");

    const result = await updateTaskStatusAction("t1", "in_progress", "c1");

    expect(result).toEqual({ ok: true });
    expect(data.claimTaskForExecution).toHaveBeenCalled();
  });

  it("does not block a task with no custom agent linked (managed product)", async () => {
    (data.getClientTask as any).mockResolvedValue(makeTask({ metadata: {} }));
    (data.claimTaskForExecution as any).mockResolvedValue({
      ...makeTask({ metadata: {} }),
      status: "in_progress",
    });
    const { updateTaskStatusAction } = await import("@/lib/actions/task-actions");

    const result = await updateTaskStatusAction("t1", "in_progress", "c1");

    expect(result).toEqual({ ok: true });
    // No umbrella lookup is even attempted — there is no agent to resolve.
    expect(dataClientAgents.getClientAgentByKey).not.toHaveBeenCalled();
  });

  it("still lets STAFF drive the same non-live umbrella (they run setup)", async () => {
    const STAFF = { ...CLIENT, uid: "u-staff", role: "KAROS_EMPLOYEE", clientId: null };
    vi.spyOn(auth, "getCurrentUser").mockResolvedValue(STAFF as any);
    (dataClientAgents.getClientAgentByKey as any).mockResolvedValue(umbrella("curating"));
    (data.claimTaskForExecution as any).mockResolvedValue({
      ...makeTask(),
      status: "in_progress",
    });
    const { updateTaskStatusAction } = await import("@/lib/actions/task-actions");

    const result = await updateTaskStatusAction("t1", "in_progress", "c1");

    expect(result).toEqual({ ok: true });
  });
});

describe("D1 — the Review-stage re-run honors the same guard", () => {
  it("refuses a client's re-run while the umbrella is not live", async () => {
    (data.getClientTask as any).mockResolvedValue(makeTask({ status: "review_pending" }));
    (dataClientAgents.getClientAgentByKey as any).mockResolvedValue(umbrella("not_launched"));
    const { requestAdjustmentsAction } = await import("@/lib/actions/execution-actions");

    const result = await requestAdjustmentsAction("t1", "c1", "Make it punchier");

    expect(result.ok).toBe(false);
    expect(data.claimTaskForExecution).not.toHaveBeenCalled();
    expect(data.chargeClientCredits).not.toHaveBeenCalled();
  });
});

// "D1 — the pending-batch runner skips guarded tasks" used to test this same
// guard through runPendingTasksBatchAction/previewPendingTasksBatchAction —
// the Workspace board's own "run all pending" batch action and its price
// preview. Both were deleted with the board (2026-08): the board was their
// only caller, so once it was removed they were an unreachable pair of charge
// points rather than a feature with nowhere left to trigger from. The guard
// they exercised is still covered above via updateTaskStatusAction and
// requestAdjustmentsAction, the two triggers that remain.
