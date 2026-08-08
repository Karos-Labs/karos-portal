/* eslint-disable @typescript-eslint/no-explicit-any */
import { beforeEach, describe, expect, it, vi } from "vitest";
import * as data from "@/lib/data";
import type { DynamicAgentSpec } from "@/lib/types";

/**
 * Phase 8 coverage for submitDynamicAgentJob (submit-custom.ts): the
 * per-agent client allowlist (Decision 6), the fixed price charged exactly
 * once (Decision 3), and specSnapshot immutability under a concurrent admin
 * edit (Decision 2). Drives the REAL submit core with only the data layer and
 * the agent-service client mocked — mirrors credit-attribution.test.ts's
 * pattern for submitCustomAgentJob's sibling.
 */

vi.mock("server-only", () => ({}));
vi.mock("@/lib/data");
vi.mock("next/cache", () => ({ revalidatePath: vi.fn() }));
vi.mock("@/lib/actions/_shared", () => ({ logActivity: vi.fn().mockResolvedValue(undefined) }));
vi.mock("@/lib/credit-reconcile", () => ({
  refundJobCharge: vi.fn().mockResolvedValue({ refunded: false }),
}));
vi.mock("@/lib/mcp/job-token", () => ({ mintJobToken: () => null }));

const submitAgentServiceJob = vi.fn().mockResolvedValue({ job_id: "svc-1" });
vi.mock("@/lib/agent-service/client", () => ({
  isAgentServiceConfigured: () => true,
  submitAgentServiceJob: (...args: unknown[]) => submitAgentServiceJob(...args),
  cancelAgentServiceJob: vi.fn().mockResolvedValue({ status: "cancelled" }),
}));

process.env.NEXT_PUBLIC_APP_URL = "https://portal.test";

const ADMIN_USER = {
  uid: "u-admin",
  email: "admin@karoslabs.test",
  name: "Admin",
  role: "KAROS_ADMIN",
  disabled: false,
  createdAt: 0,
} as any;

const CLIENT_USER = {
  uid: "u-client",
  email: "client@acme.test",
  name: "Client User",
  role: "CLIENT_USER",
  disabled: false,
  clientId: "c1",
  createdAt: 0,
} as any;

function spec(patch: Partial<DynamicAgentSpec> = {}): DynamicAgentSpec {
  return {
    id: "spec-1",
    name: "Case Study Drafter",
    description: "desc",
    category: "Content",
    icon: "Sparkles",
    creditsCost: 5,
    active: true,
    version: 3,
    allowedClientIds: [],
    inputSchema: [{ key: "company_name", type: "text", label: "Company name", required: true, order: 0 }],
    steps: [{ id: "research", type: "ai", label: "Research", model: "sonnet", prompt: "Go", order: 0 }],
    createdAt: 0,
    updatedAt: 0,
    createdBy: "u-admin",
    ...patch,
  };
}

function installMocks(specDoc: DynamicAgentSpec) {
  (data.getDynamicAgentSpec as any).mockResolvedValue(specDoc);
  (data.getClient as any).mockResolvedValue({ id: "c1", name: "Acme" });
  (data.createJob as any).mockResolvedValue("job-1");
  (data.updateJob as any).mockResolvedValue(undefined);
  (data.deleteJob as any).mockResolvedValue(undefined);
  (data.chargeClientCredits as any).mockResolvedValue({ balance: 100 });
}

function charge() {
  const calls = (data.chargeClientCredits as any).mock.calls;
  expect(calls.length, "expected at most one charge").toBeLessThan(2);
  return calls.length === 1 ? calls[0][0] : null;
}

beforeEach(() => {
  vi.clearAllMocks();
});

describe("submitDynamicAgentJob", () => {
  it("refuses a missing or inactive agent", async () => {
    const { submitDynamicAgentJob } = await import("@/lib/jobs/submit-custom");
    installMocks(spec());
    (data.getDynamicAgentSpec as any).mockResolvedValue(null);
    const result = await submitDynamicAgentJob(ADMIN_USER, {
      specId: "spec-1",
      clientId: "c1",
      inputs: { company_name: "Acme" },
    });
    expect(result.error).toBeTruthy();
    expect(data.createJob).not.toHaveBeenCalled();

    installMocks(spec({ active: false }));
    const result2 = await submitDynamicAgentJob(ADMIN_USER, {
      specId: "spec-1",
      clientId: "c1",
      inputs: { company_name: "Acme" },
    });
    expect(result2.error).toBeTruthy();
  });

  it("Decision 6: refuses a CLIENT_USER outside the agent's allowlist", async () => {
    installMocks(spec({ allowedClientIds: ["some-other-client"] }));
    const { submitDynamicAgentJob } = await import("@/lib/jobs/submit-custom");
    const result = await submitDynamicAgentJob(CLIENT_USER, {
      specId: "spec-1",
      clientId: "c1",
      inputs: { company_name: "Acme" },
    });
    expect(result.error).toBeTruthy();
    expect(data.createJob).not.toHaveBeenCalled();
  });

  it("Decision 6: an empty allowlist means every client may run it", async () => {
    installMocks(spec({ allowedClientIds: [] }));
    const { submitDynamicAgentJob } = await import("@/lib/jobs/submit-custom");
    const result = await submitDynamicAgentJob(CLIENT_USER, {
      specId: "spec-1",
      clientId: "c1",
      inputs: { company_name: "Acme" },
    });
    expect(result.error).toBeUndefined();
    expect(result.jobId).toBe("job-1");
  });

  it("staff are never charged; a CLIENT_USER is charged exactly the spec's creditsCost, once", async () => {
    installMocks(spec({ creditsCost: 7 }));
    const { submitDynamicAgentJob } = await import("@/lib/jobs/submit-custom");

    await submitDynamicAgentJob(ADMIN_USER, { specId: "spec-1", clientId: "c1", inputs: { company_name: "Acme" } });
    expect(charge()).toBeNull();

    vi.clearAllMocks();
    installMocks(spec({ creditsCost: 7 }));
    await submitDynamicAgentJob(CLIENT_USER, { specId: "spec-1", clientId: "c1", inputs: { company_name: "Acme" } });
    const c = charge();
    expect(c).not.toBeNull();
    expect(c.amount).toBe(7);
    expect(c.operation).toBe("custom_agent_run");
  });

  it("Portal-side guard: refuses a submission missing a required input, before any job doc or charge is written", async () => {
    installMocks(spec());
    const { submitDynamicAgentJob } = await import("@/lib/jobs/submit-custom");
    const result = await submitDynamicAgentJob(CLIENT_USER, { specId: "spec-1", clientId: "c1", inputs: {} });
    expect(result.error).toMatch(/required/i);
    expect(data.createJob).not.toHaveBeenCalled();
    expect(data.chargeClientCredits).not.toHaveBeenCalled();
  });

  it("Portal-side guard: refuses a submission with a key absent from the spec's inputSchema", async () => {
    installMocks(spec());
    const { submitDynamicAgentJob } = await import("@/lib/jobs/submit-custom");
    const result = await submitDynamicAgentJob(CLIENT_USER, {
      specId: "spec-1",
      clientId: "c1",
      inputs: { company_name: "Acme", not_a_real_field: "x" },
    });
    expect(result.error).toBeTruthy();
    expect(data.createJob).not.toHaveBeenCalled();
  });

  it("Decision 2: the submitted brief's specSnapshot is a deep clone, not the live spec object", async () => {
    const liveSpec = spec();
    installMocks(liveSpec);
    const { submitDynamicAgentJob } = await import("@/lib/jobs/submit-custom");
    await submitDynamicAgentJob(CLIENT_USER, { specId: "spec-1", clientId: "c1", inputs: { company_name: "Acme" } });

    expect(submitAgentServiceJob).toHaveBeenCalledTimes(1);
    const brief = submitAgentServiceJob.mock.calls[0][0].brief;
    expect(brief.specSnapshot).not.toBe(liveSpec); // not the same reference
    expect(brief.specSnapshot).toEqual(liveSpec); // but an equal, deep copy
    expect(brief.spec_version).toBe(liveSpec.version);

    // Mutating the live spec object after submission must never reach the
    // already-submitted brief — this is what "never resolve the live spec at
    // execution time" means when an admin edits mid-flight.
    (liveSpec as any).steps[0].prompt = "mutated after submission";
    expect(brief.specSnapshot.steps[0].prompt).toBe("Go");
  });

  it("never sends the legacy hardcoded-brief fields (entry_skill_dir/instructions/prompt) on a dynamic brief", async () => {
    installMocks(spec());
    const { submitDynamicAgentJob } = await import("@/lib/jobs/submit-custom");
    await submitDynamicAgentJob(CLIENT_USER, { specId: "spec-1", clientId: "c1", inputs: { company_name: "Acme" } });
    const brief = submitAgentServiceJob.mock.calls[0][0].brief;
    expect(brief.entry_skill_dir).toBeUndefined();
    expect(brief.instructions).toBeUndefined();
    expect(brief.prompt).toBeUndefined();
  });
});
