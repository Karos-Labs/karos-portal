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
vi.mock("@/lib/storage", () => ({
  uploadBytes: vi.fn().mockResolvedValue({ url: "https://storage.test/client-context.md", path: "x" }),
}));

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

  /**
   * First-class, not an edge case: an agent whose steps read client data
   * often needs no client input at all — it generates from the company's own
   * documents. The whole submit path must work end to end with zero fields.
   */
  it("an agent with an empty input schema creates a job normally with an empty inputs payload", async () => {
    installMocks(spec({ inputSchema: [] }));
    const { submitDynamicAgentJob } = await import("@/lib/jobs/submit-custom");
    const result = await submitDynamicAgentJob(CLIENT_USER, { specId: "spec-1", clientId: "c1", inputs: {} });
    expect(result.error).toBeUndefined();
    expect(result.jobId).toBe("job-1");
    const data = await import("@/lib/data");
    expect(data.createJob).toHaveBeenCalledTimes(1);
    expect(data.chargeClientCredits).toHaveBeenCalledTimes(1);
  });

  describe("per-AI-step capability grants", () => {
    it("sends no context_files and records dynamicCapabilities as all-false when no step requests client data or network", async () => {
      installMocks(spec());
      const { submitDynamicAgentJob } = await import("@/lib/jobs/submit-custom");
      await submitDynamicAgentJob(CLIENT_USER, { specId: "spec-1", clientId: "c1", inputs: { company_name: "Acme" } });

      const call = submitAgentServiceJob.mock.calls[0][0];
      expect(call.context_files).toBeUndefined();

      const data = await import("@/lib/data");
      const jobArg = (data.createJob as any).mock.calls[0][0];
      expect(jobArg.dynamicCapabilities).toEqual({ anyNetwork: false, anyClientData: false });
    });

    it("attaches context_files and records anyClientData: true when a step has allowClientData", async () => {
      const data = await import("@/lib/data");
      installMocks(
        spec({
          steps: [
            { id: "research", type: "ai", label: "Research", model: "sonnet", prompt: "Go", order: 0, allowClientData: true },
          ],
        }),
      );
      (data.listClientContextDocs as any).mockResolvedValue([
        { id: "doc-1", clientId: "c1", docType: "brand-voice", tier: "internal", content: "Speaks plainly.", version: 1, createdAt: 0, updatedAt: 0 },
      ]);
      const { submitDynamicAgentJob } = await import("@/lib/jobs/submit-custom");
      await submitDynamicAgentJob(CLIENT_USER, { specId: "spec-1", clientId: "c1", inputs: { company_name: "Acme" } });

      const call = submitAgentServiceJob.mock.calls[0][0];
      expect(call.context_files).toHaveLength(1);
      expect(call.context_files[0].name).toBe("client-context.md");

      const jobArg = (data.createJob as any).mock.calls[0][0];
      expect(jobArg.dynamicCapabilities).toEqual({ anyNetwork: false, anyClientData: true });
    });

    it("requests client docs at the INTERNAL tier only", async () => {
      const data = await import("@/lib/data");
      installMocks(
        spec({
          steps: [
            { id: "research", type: "ai", label: "Research", model: "sonnet", prompt: "Go", order: 0, allowClientData: true },
          ],
        }),
      );
      (data.listClientContextDocs as any).mockResolvedValue([]);
      const { submitDynamicAgentJob } = await import("@/lib/jobs/submit-custom");
      await submitDynamicAgentJob(CLIENT_USER, { specId: "spec-1", clientId: "c1", inputs: { company_name: "Acme" } });
      expect(data.listClientContextDocs).toHaveBeenCalledWith("c1", "internal");
    });

    it("sends no context_files when allowClientData is set but the client has no internal-tier docs yet", async () => {
      const data = await import("@/lib/data");
      installMocks(
        spec({
          steps: [
            { id: "research", type: "ai", label: "Research", model: "sonnet", prompt: "Go", order: 0, allowClientData: true },
          ],
        }),
      );
      (data.listClientContextDocs as any).mockResolvedValue([]);
      const { submitDynamicAgentJob } = await import("@/lib/jobs/submit-custom");
      await submitDynamicAgentJob(CLIENT_USER, { specId: "spec-1", clientId: "c1", inputs: { company_name: "Acme" } });
      const call = submitAgentServiceJob.mock.calls[0][0];
      expect(call.context_files).toBeUndefined();
    });

    it("records anyNetwork: true from an allowNetwork step, independent of client-data", async () => {
      const data = await import("@/lib/data");
      installMocks(
        spec({
          steps: [
            { id: "research", type: "ai", label: "Research", model: "sonnet", prompt: "Go", order: 0, allowNetwork: true },
          ],
        }),
      );
      const { submitDynamicAgentJob } = await import("@/lib/jobs/submit-custom");
      await submitDynamicAgentJob(CLIENT_USER, { specId: "spec-1", clientId: "c1", inputs: { company_name: "Acme" } });
      const jobArg = (data.createJob as any).mock.calls[0][0];
      expect(jobArg.dynamicCapabilities).toEqual({ anyNetwork: true, anyClientData: false });
      const call = submitAgentServiceJob.mock.calls[0][0];
      expect(call.context_files).toBeUndefined();
    });
  });
});

/**
 * Topic guardrails and output de-duplication, at the SUBMIT boundary
 * (docs/dynamic-agent-guardrails.md). What matters here is exactly what does
 * and does not reach the brief: both features are inert by default, and the
 * "inert" case is asserted first because it is the one that protects every
 * existing client from this work.
 */
describe("submitDynamicAgentJob — guardrails and de-duplication", () => {
  function brief() {
    const call = submitAgentServiceJob.mock.calls[0]?.[0] as { brief: Record<string, unknown> } | undefined;
    return call?.brief;
  }

  async function submit(user = ADMIN_USER) {
    const { submitDynamicAgentJob } = await import("@/lib/jobs/submit-custom");
    return submitDynamicAgentJob(user, { specId: "spec-1", clientId: "c1", inputs: { company_name: "Acme" } });
  }

  /* ── zero impact ── */

  it("sends NEITHER field for a client with no topics and an agent without the opt-in", async () => {
    installMocks(spec());
    await submit();
    expect(brief()).toBeDefined();
    expect(brief()!.guardrails).toBeUndefined();
    expect(brief()!.output_history).toBeUndefined();
  });

  it("never reads job history when the agent did not opt in", async () => {
    // The read is a full client job scan; an agent without the flag must not
    // pay for it on every run.
    installMocks(spec());
    await submit();
    expect(data.listJobs).not.toHaveBeenCalled();
  });

  it("treats an EMPTY forbidden-topics list on the client as no guardrails", async () => {
    installMocks(spec());
    (data.getClient as any).mockResolvedValue({ id: "c1", name: "Acme", forbiddenTopics: [] });
    await submit();
    expect(brief()!.guardrails).toBeUndefined();
  });

  /* ── guardrails ── */

  it("sends the client's forbidden topics on the brief, snake_cased", async () => {
    installMocks(spec());
    (data.getClient as any).mockResolvedValue({
      id: "c1",
      name: "Acme",
      forbiddenTopics: ["competitor pricing", "pending litigation"],
    });
    await submit();
    expect(brief()!.guardrails).toEqual({
      forbidden_topics: ["competitor pricing", "pending litigation"],
    });
  });

  it("sends guardrails regardless of the agent's de-duplication setting — they are independent features", async () => {
    installMocks(spec({ dedupeAgainstHistory: false }));
    (data.getClient as any).mockResolvedValue({ id: "c1", name: "Acme", forbiddenTopics: ["x"] });
    await submit();
    expect(brief()!.guardrails).toBeDefined();
    expect(brief()!.output_history).toBeUndefined();
  });

  it("records the guardrail on the job payload frozen at creation time", async () => {
    installMocks(spec());
    (data.getClient as any).mockResolvedValue({ id: "c1", name: "Acme", forbiddenTopics: ["x"] });
    await submit();
    // The brief is the frozen carrier — a later edit to the client's list
    // cannot reach this job, exactly like specSnapshot.
    expect(brief()!.guardrails).toEqual({ forbidden_topics: ["x"] });
  });

  /* ── de-duplication ── */

  it("sends prior deliverables when the agent opted in", async () => {
    installMocks(spec({ dedupeAgainstHistory: true }));
    (data.listJobs as any).mockResolvedValue([
      {
        id: "job-old",
        clientId: "c1",
        dynamicAgentSpecId: "spec-1",
        status: "delivered",
        assetIds: ["asset-1"],
        createdAt: 1_000,
      },
    ]);
    (data.getAsset as any).mockResolvedValue({ id: "asset-1", content: "last month's post" });
    await submit();
    expect(brief()!.output_history).toEqual({
      items: [{ job_id: "job-old", created_at: 1_000, excerpt: "last month's post" }],
    });
  });

  it("sends an EMPTY history — not an absent field — on the agent's first run", async () => {
    // Presence of the field is the runner's opt-in signal, and an empty list is
    // the meaningful "nothing to compare against yet" state. Dropping the field
    // here would make the runner report nothing at all.
    installMocks(spec({ dedupeAgainstHistory: true }));
    (data.listJobs as any).mockResolvedValue([]);
    await submit();
    expect(brief()!.output_history).toEqual({ items: [] });
  });

  it("ignores other agents' jobs for the same client", async () => {
    installMocks(spec({ dedupeAgainstHistory: true }));
    (data.listJobs as any).mockResolvedValue([
      { id: "other", clientId: "c1", dynamicAgentSpecId: "spec-999", status: "delivered", assetIds: ["a"], createdAt: 5 },
    ]);
    await submit();
    expect(brief()!.output_history).toEqual({ items: [] });
    expect(data.getAsset).not.toHaveBeenCalled();
  });

  it("still charges exactly once with both features on", async () => {
    installMocks(spec({ dedupeAgainstHistory: true }));
    (data.getClient as any).mockResolvedValue({ id: "c1", name: "Acme", forbiddenTopics: ["x"] });
    (data.listJobs as any).mockResolvedValue([]);
    await submit(CLIENT_USER);
    expect(charge()).not.toBeNull();
  });
});
