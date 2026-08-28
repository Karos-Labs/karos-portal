/* eslint-disable @typescript-eslint/no-explicit-any */
import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * T-B9 ("[T-B9] Generate now, publish on date X", SCRUM-253) — the STAFF-ONLY
 * gate on `runCustomAgentAction`'s `requestedScheduledAt`.
 *
 * `createPlannedRunAction` (schedule the generation itself) is staff-only.
 * This is the same trust tier applied to the run-now-then-schedule
 * alternative, enforced in ONE place so every caller of `runCustomAgentAction`
 * (the chat tool today, any future one) inherits it rather than re-deriving
 * it. Proven both ways: a client session is refused BEFORE any job is
 * submitted, and a staff session with a genuinely future date passes the
 * value through untouched.
 */

vi.mock("server-only", () => ({}));
vi.mock("next/cache", () => ({ revalidatePath: vi.fn() }));
vi.mock("@/lib/data");
vi.mock("@/lib/data-client-agents");
vi.mock("@/lib/client-agent-gate", () => ({
  clientAgentRunRefusal: vi.fn().mockResolvedValue(null),
}));
vi.mock("@/lib/jobs/submit-custom", () => ({
  submitCustomAgentJob: vi.fn().mockResolvedValue({ jobId: "job-1" }),
}));

const requireClientAccessMock = vi.fn();
vi.mock("@/lib/actions/_shared", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/actions/_shared")>();
  return { ...actual, requireClientAccess: (...args: unknown[]) => requireClientAccessMock(...args) };
});

import { runCustomAgentAction } from "@/lib/actions/custom-agent-actions";
import { submitCustomAgentJob } from "@/lib/jobs/submit-custom";
import { getCustomAgent } from "@/lib/data";

const STAFF = { uid: "u-staff", role: "KAROS_EMPLOYEE" } as any;
const IMPERSONATING_ADMIN = { uid: "u-admin", role: "CLIENT_USER", impersonatedBy: "u-admin-real" } as any;
const CLIENT = { uid: "u-client", role: "CLIENT_USER", clientId: "c1" } as any;

const FUTURE = Date.now() + 30 * 24 * 60 * 60 * 1000;
const PAST = Date.now() - 60 * 60 * 1000;

beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(getCustomAgent).mockResolvedValue({ id: "agent-1", enabled: true, key: "k", name: "Agent" } as any);
});

describe("a CLIENT session (including an admin impersonating one)", () => {
  it("is refused BEFORE the job is ever submitted", async () => {
    requireClientAccessMock.mockResolvedValue(CLIENT);

    const result = await runCustomAgentAction({
      agentId: "agent-1",
      clientId: "c1",
      prompt: "go",
      requestedScheduledAt: FUTURE,
    });

    expect(result.error).toBeTruthy();
    expect(submitCustomAgentJob).not.toHaveBeenCalled();
  });

  it("stays refused under impersonation — impersonation is not staff", async () => {
    requireClientAccessMock.mockResolvedValue(IMPERSONATING_ADMIN);

    const result = await runCustomAgentAction({
      agentId: "agent-1",
      clientId: "c1",
      prompt: "go",
      requestedScheduledAt: FUTURE,
    });

    expect(result.error).toBeTruthy();
    expect(submitCustomAgentJob).not.toHaveBeenCalled();
  });
});

describe("a real staff session", () => {
  it("refuses a target date that is already in the past", async () => {
    requireClientAccessMock.mockResolvedValue(STAFF);

    const result = await runCustomAgentAction({
      agentId: "agent-1",
      clientId: "c1",
      prompt: "go",
      requestedScheduledAt: PAST,
    });

    expect(result.error).toBeTruthy();
    expect(submitCustomAgentJob).not.toHaveBeenCalled();
  });

  it("passes a genuinely future date through to the job submission unchanged", async () => {
    requireClientAccessMock.mockResolvedValue(STAFF);

    const result = await runCustomAgentAction({
      agentId: "agent-1",
      clientId: "c1",
      prompt: "go",
      requestedScheduledAt: FUTURE,
    });

    expect(result.error).toBeUndefined();
    expect(submitCustomAgentJob).toHaveBeenCalledWith(
      STAFF,
      expect.objectContaining({ requestedScheduledAt: FUTURE }),
    );
  });
});

describe("an ordinary run with no requested schedule — the common case this must not disturb", () => {
  it("submits normally for a client, with no requestedScheduledAt field at all", async () => {
    requireClientAccessMock.mockResolvedValue(CLIENT);

    const result = await runCustomAgentAction({ agentId: "agent-1", clientId: "c1", prompt: "go" });

    expect(result.error).toBeUndefined();
    const call = vi.mocked(submitCustomAgentJob).mock.calls[0]?.[1] as any;
    expect(call.requestedScheduledAt).toBeUndefined();
  });
});
