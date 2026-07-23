/* eslint-disable @typescript-eslint/no-explicit-any */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import * as data from "@/lib/data";
import * as auth from "@/lib/auth";
import { MAX_ACTIVE_TASKS } from "@/lib/constants";

/**
 * Re-running a completed karos_managed task is a NET NEW active slot (unlike
 * pending/review_pending, which are already counted) — a security/QA review
 * found this bypassed the MAX_ACTIVE_TASKS queue cap that task creation
 * enforces, letting a client drag Done cards back to In Progress indefinitely,
 * each one a real credit charge + agent dispatch.
 */

vi.mock("server-only", () => ({}));
vi.mock("next/cache", () => ({ revalidatePath: () => {} }));
vi.mock("next/server", () => ({ after: (fn: () => void) => fn() }));
vi.mock("@/lib/data");
vi.mock("@/lib/auth");
vi.mock("@/lib/execution-engine", () => ({
  inferOwnerEngine: (t: any) => t.owner ?? "karos_managed",
  runTaskExecution: vi.fn().mockResolvedValue(undefined),
  plannedTaskExecutionCost: vi.fn().mockResolvedValue(5),
  resolveTaskType: vi.fn().mockReturnValue("content_generation"),
}));

const STAFF = { uid: "u-staff", role: "KAROS_EMPLOYEE", disabled: false, clientId: null } as any;

function makeTask(patch: Record<string, any> = {}): any {
  return {
    id: "t1",
    clientId: "c1",
    title: "Write LinkedIn post",
    status: "completed",
    owner: "karos_managed",
    priority: "medium",
    source: "swarm",
    createdAt: 0,
    updatedAt: 0,
    ...patch,
  };
}

beforeEach(() => {
  // clearAllMocks (not resetAllMocks) — resetting would also wipe the
  // runTaskExecution/plannedTaskExecutionCost implementations set in the
  // vi.mock factory above, since reset strips a vi.fn()'s implementation too.
  vi.clearAllMocks();
  vi.spyOn(auth, "getCurrentUser").mockResolvedValue(STAFF);
});

afterEach(() => {
  vi.clearAllMocks();
});

describe("updateTaskStatusAction — active-task cap on re-run", () => {
  it("blocks reopening a completed task when the queue is already at capacity", async () => {
    const { updateTaskStatusAction } = await import("@/lib/actions/task-actions");
    const task = makeTask({ status: "completed" });
    (data.getClientTask as any).mockResolvedValue(task);
    (data.getTaskBoardCapacity as any).mockResolvedValue({
      activeCount: MAX_ACTIVE_TASKS,
      existingTitles: new Set(),
      tasks: [],
    });

    const result = await updateTaskStatusAction("t1", "in_progress", "c1");

    expect(result).toMatchObject({ ok: false });
    expect(result.error).toMatch(/capacity/i);
    expect(data.claimTaskForExecution).not.toHaveBeenCalled();
  });

  it("allows reopening a completed task when the queue has room", async () => {
    const { updateTaskStatusAction } = await import("@/lib/actions/task-actions");
    const task = makeTask({ status: "completed" });
    (data.getClientTask as any).mockResolvedValue(task);
    (data.getTaskBoardCapacity as any).mockResolvedValue({
      activeCount: MAX_ACTIVE_TASKS - 1,
      existingTitles: new Set(),
      tasks: [],
    });
    (data.claimTaskForExecution as any).mockResolvedValue({ ...task, status: "in_progress" });
    (data.updateClientTask as any).mockResolvedValue(undefined);

    const result = await updateTaskStatusAction("t1", "in_progress", "c1");

    expect(result).toEqual({ ok: true });
    expect(data.claimTaskForExecution).toHaveBeenCalledWith("t1", "c1", [
      "pending",
      "review_pending",
      "completed",
    ]);
  });

  it("does not re-check capacity when re-running from review_pending (already counted)", async () => {
    const { updateTaskStatusAction } = await import("@/lib/actions/task-actions");
    const task = makeTask({ status: "review_pending" });
    (data.getClientTask as any).mockResolvedValue(task);
    (data.claimTaskForExecution as any).mockResolvedValue({ ...task, status: "in_progress" });

    const result = await updateTaskStatusAction("t1", "in_progress", "c1");

    expect(result).toEqual({ ok: true });
    expect(data.getTaskBoardCapacity).not.toHaveBeenCalled();
    expect(data.claimTaskForExecution).toHaveBeenCalled();
  });
});
