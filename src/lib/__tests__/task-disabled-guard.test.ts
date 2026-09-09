/* eslint-disable @typescript-eslint/no-explicit-any */
import { beforeEach, describe, expect, it, vi } from "vitest";
import * as data from "@/lib/data";
import * as auth from "@/lib/auth";

/**
 * An admin-paused task (`metadata.disabled`, task-disable-copy.ts) must never
 * run — not from a drag, not from a re-run, not from campaign automation, and
 * not swept up by either "run pending tasks" path. This mirrors
 * client-agent-task-guard.test.ts's harness (the same shape of guard, a
 * different condition): every trigger refused/skipped BEFORE the claim and
 * the charge, and `setTaskDisabledAction` itself reachable by nobody but an
 * admin.
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

const CLIENT = {
  uid: "u-client",
  email: "client@acme.test",
  name: "Client User",
  role: "CLIENT_USER",
  disabled: false,
  clientId: "c1",
  createdAt: 0,
} as any;

const EMPLOYEE = { ...CLIENT, uid: "u-emp", role: "KAROS_EMPLOYEE", clientId: null };
const ADMIN = { ...CLIENT, uid: "u-admin", role: "KAROS_ADMIN", clientId: null };

function makeTask(patch: Record<string, any> = {}): any {
  return {
    id: "t1",
    clientId: "c1",
    title: "Instagram post for launch week",
    status: "pending",
    owner: "karos_managed",
    priority: "medium",
    source: "swarm",
    metadata: { disabled: true },
    createdAt: 0,
    updatedAt: 0,
    ...patch,
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  vi.spyOn(auth, "getCurrentUser").mockResolvedValue(CLIENT);
  (auth.requireUser as any) = vi.fn().mockResolvedValue(CLIENT);
  (data.getClientTask as any).mockResolvedValue(makeTask());
  (data.getClient as any).mockResolvedValue({ id: "c1", name: "Acme" });
});

describe("a paused task is refused at every execution-trigger door", () => {
  it("refuses a board drag to In Progress before the claim or the charge", async () => {
    const { updateTaskStatusAction } = await import("@/lib/actions/task-actions");

    const result = await updateTaskStatusAction("t1", "in_progress", "c1");

    expect(result.ok).toBe(false);
    expect(result.error).toBeTruthy();
    expect(data.claimTaskForExecution).not.toHaveBeenCalled();
    expect(data.chargeClientCredits).not.toHaveBeenCalled();
  });

  it("refuses the campaign/autopilot trigger before the claim or the charge", async () => {
    const { startTaskExecutionAction } = await import("@/lib/actions/execution-actions");

    const result = await startTaskExecutionAction("t1", "c1");

    expect(result.ok).toBe(false);
    expect(data.claimTaskForExecution).not.toHaveBeenCalled();
  });

  it("refuses the Review-stage re-run before the claim or the charge", async () => {
    (data.getClientTask as any).mockResolvedValue(makeTask({ status: "review_pending" }));
    const { requestAdjustmentsAction } = await import("@/lib/actions/execution-actions");

    const result = await requestAdjustmentsAction("t1", "c1", "Make it punchier");

    expect(result.ok).toBe(false);
    expect(data.claimTaskForExecution).not.toHaveBeenCalled();
  });

  it("does not block a task nobody has paused", async () => {
    (data.getClientTask as any).mockResolvedValue(makeTask({ metadata: {} }));
    (data.claimTaskForExecution as any).mockResolvedValue({
      ...makeTask({ metadata: {} }),
      status: "in_progress",
    });
    const { updateTaskStatusAction } = await import("@/lib/actions/task-actions");

    const result = await updateTaskStatusAction("t1", "in_progress", "c1");

    expect(result).toEqual({ ok: true });
  });
});

// "the pending-batch runner skips paused tasks" used to test this same guard
// through runPendingTasksBatchAction/previewPendingTasksBatchAction — the
// Workspace board's own "run all pending" batch action and its price preview.
// Both were deleted with the board (2026-08): the board was their only caller,
// so once it was removed they were an unreachable pair of charge points rather
// than a feature with nowhere left to trigger from. The guard they exercised
// is still covered above via updateTaskStatusAction, startTaskExecutionAction,
// and requestAdjustmentsAction, the triggers that remain.

describe("setTaskDisabledAction is admin-only", () => {
  it("refuses a CLIENT_USER", async () => {
    (data.getClientTask as any).mockResolvedValue(makeTask({ metadata: {} }));
    const { setTaskDisabledAction } = await import("@/lib/actions/task-actions");

    const result = await setTaskDisabledAction("t1", "c1", true);

    expect(result.ok).toBe(false);
    expect(data.updateClientTask).not.toHaveBeenCalled();
  });

  it("refuses a KAROS_EMPLOYEE — narrower than the rest of the task actions", async () => {
    vi.spyOn(auth, "getCurrentUser").mockResolvedValue(EMPLOYEE as any);
    (data.getClientTask as any).mockResolvedValue(makeTask({ metadata: {} }));
    const { setTaskDisabledAction } = await import("@/lib/actions/task-actions");

    const result = await setTaskDisabledAction("t1", "c1", true);

    expect(result.ok).toBe(false);
    expect(data.updateClientTask).not.toHaveBeenCalled();
  });

  it("lets a KAROS_ADMIN pause and resume", async () => {
    vi.spyOn(auth, "getCurrentUser").mockResolvedValue(ADMIN as any);
    (data.getClientTask as any).mockResolvedValue(makeTask({ metadata: {} }));
    const { setTaskDisabledAction } = await import("@/lib/actions/task-actions");

    const result = await setTaskDisabledAction("t1", "c1", true);

    expect(result).toEqual({ ok: true });
    expect(data.updateClientTask).toHaveBeenCalledWith(
      "t1",
      expect.objectContaining({ metadata: expect.objectContaining({ disabled: true }) }),
    );
  });
});
