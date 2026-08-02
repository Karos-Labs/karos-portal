/* eslint-disable @typescript-eslint/no-explicit-any */
import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * THE OTHER HALF OF #54: the cancel path's own read-modify-write.
 *
 * The webhook was fixed to re-read the job before writing `events` and
 * `assetIds` back, because it held a pre-re-host snapshot across an unbounded
 * amount of work. `requestJobCancellation` has the identical hole POINTING THE
 * OTHER WAY, and it is the concurrent writer the webhook's own comment names:
 * it reads the job, calls `cancelAgentServiceJob` — an unbounded HTTP call —
 * and then writes the whole `events` array back from the base it read first.
 * `cancelClientAgentJobAction` widens the window further by preloading the job
 * and passing it in.
 *
 * A read-modify-write hole is only closed when BOTH writers re-read. Fixing one
 * side and leaving the other means the race still erases a timeline, just in the
 * opposite direction — and the lines it erases are the ones a reader most needs:
 * "N client-facing deliverable(s) attached", the per-artifact re-host failures,
 * and "Refunded N credits for the failed run". Losing those leaves a job sitting
 * in `review` whose timeline says only that someone asked to cancel it.
 *
 * Driven through the real action against a mocked data layer whose `getJob`
 * answers differently before and after the cancel call — which is exactly the
 * interleaving, and the only way to tell a re-read from a stale write.
 */

vi.mock("server-only", () => ({}));
vi.mock("next/cache", () => ({ revalidatePath: vi.fn() }));
vi.mock("@/lib/data");
vi.mock("@/lib/auth", async (io) => {
  const actual = await io<typeof import("@/lib/auth")>();
  return {
    ...actual,
    requireUser: vi.fn(async () => ({ uid: "u1", role: "KAROS_ADMIN", clientId: null, createdAt: 0 })),
    getCurrentUser: vi.fn(async () => ({ uid: "u1", role: "KAROS_ADMIN", clientId: null, createdAt: 0 })),
  };
});
vi.mock("@/lib/actions/_shared", async (io) => {
  const actual = await io<any>();
  return { ...actual, requireStaff: vi.fn(async () => ({ uid: "u1", role: "KAROS_ADMIN" })), logActivity: vi.fn() };
});
vi.mock("@/lib/agent-service/client", () => ({
  cancelAgentServiceJob: vi.fn(async () => undefined),
}));

import * as data from "@/lib/data";
import { cancelManagedJobAction } from "@/lib/actions/external-job-actions";

const BASE_EVENT = { at: 1, level: "info" as const, message: "Run started" };
/** What the webhook appended while the cancel was waiting on its HTTP call. */
const WEBHOOK_EVENT = { at: 2, level: "info" as const, message: "2 client-facing deliverable(s) attached" };

function job(events: Array<{ at: number; level: "info"; message: string }>) {
  return {
    id: "j1",
    clientId: "c1",
    events,
    assetIds: [],
    external: { serviceJobId: "svc-1" },
    status: "running",
  };
}

describe("cancelling a run does not erase what landed while it was cancelling", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(data.updateJob).mockResolvedValue(undefined as any);
  });

  it("keeps a concurrently appended event", async () => {
    // First read: the base the action starts from. Second read (after the
    // unbounded cancel call): the webhook's line has landed.
    vi.mocked(data.getJob)
      .mockResolvedValueOnce(job([BASE_EVENT]) as any)
      .mockResolvedValueOnce(job([BASE_EVENT, WEBHOOK_EVENT]) as any);

    await cancelManagedJobAction("j1");

    const written = vi.mocked(data.updateJob).mock.calls[0]![1] as any;
    const messages = written.events.map((e: { message: string }) => e.message);
    expect(
      messages,
      "the cancel wrote its whole array back from a base read before the HTTP call",
    ).toContain(WEBHOOK_EVENT.message);
    expect(messages).toContain("Cancellation requested");
    expect(messages[0]).toBe(BASE_EVENT.message);
  });

  it("still appends its own line when nothing raced it", async () => {
    // The other direction: the re-read must not drop the event it exists to add,
    // and must not duplicate the base.
    vi.mocked(data.getJob)
      .mockResolvedValueOnce(job([BASE_EVENT]) as any)
      .mockResolvedValueOnce(job([BASE_EVENT]) as any);

    await cancelManagedJobAction("j1");

    const written = vi.mocked(data.updateJob).mock.calls[0]![1] as any;
    expect(written.events.map((e: { message: string }) => e.message)).toEqual([
      BASE_EVENT.message,
      "Cancellation requested",
    ]);
  });

  it("falls back to the copy it holds when the re-read fails", async () => {
    // Stated residual made real: a read failure must not cost the event. Dropping
    // this line to punish a failed read would lose more than it protects.
    vi.mocked(data.getJob)
      .mockResolvedValueOnce(job([BASE_EVENT]) as any)
      .mockRejectedValueOnce(new Error("firestore unavailable"));

    const res = await cancelManagedJobAction("j1");

    expect(res.error, "a failed re-read broke the cancel").toBeUndefined();
    const written = vi.mocked(data.updateJob).mock.calls[0]![1] as any;
    expect(written.events.map((e: { message: string }) => e.message)).toEqual([
      BASE_EVENT.message,
      "Cancellation requested",
    ]);
  });
});
