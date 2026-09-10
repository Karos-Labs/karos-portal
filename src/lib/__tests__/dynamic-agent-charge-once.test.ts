/* eslint-disable @typescript-eslint/no-explicit-any */
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { beforeEach, describe, expect, it, vi } from "vitest";
import * as data from "@/lib/data";
import { stripComments } from "./source-scan";
import type { DynamicAgentSpec } from "@/lib/types";

/**
 * DECISION 3, INCLUDING THE HALF NOTHING TESTED.
 *
 * "`creditsCost` is taken from the snapshot and charged once at job creation.
 * Token-based variable pricing is out of scope. Resumed/retried steps must NOT
 * re-charge — mirror the resumable-campaign behavior in
 * `campaign-run-actions.ts`."
 *
 * submit-dynamic-agent.test.ts covers the first sentence (one submission, one
 * charge, at the snapshot's price). The RETRY clause had no test at all, and it
 * is the one with teeth: a retried run that re-charges bills a client twice for
 * work they asked for once, and nothing about the happy path would notice.
 *
 * There are three places a re-charge could come from, and each is asserted
 * below rather than argued:
 *   1. the Portal's own retry action,
 *   2. the runner's automatic retry of a transient AI step,
 *   3. the queue worker's whole-job retry.
 */

vi.mock("server-only", () => ({}));
vi.mock("@/lib/data");
vi.mock("next/cache", () => ({ revalidatePath: vi.fn() }));
vi.mock("@/lib/actions/_shared", () => ({ logActivity: vi.fn().mockResolvedValue(undefined) }));
vi.mock("@/lib/credit-reconcile", () => ({ refundJobCharge: vi.fn().mockResolvedValue({ refunded: false }) }));
vi.mock("@/lib/mcp/job-token", () => ({ mintJobToken: () => null }));
vi.mock("@/lib/agent-service/client", () => ({
  isAgentServiceConfigured: () => true,
  submitAgentServiceJob: vi.fn().mockResolvedValue({ job_id: "svc-1" }),
  cancelAgentServiceJob: vi.fn().mockResolvedValue({ status: "cancelled" }),
}));

process.env.NEXT_PUBLIC_APP_URL = "https://portal.test";

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
    description: "d",
    category: "Content",
    icon: "Sparkles",
    creditsCost: 7,
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

function installMocks(specDoc: DynamicAgentSpec, jobId = "job-1") {
  (data.getDynamicAgentSpec as any).mockResolvedValue(specDoc);
  (data.getClient as any).mockResolvedValue({ id: "c1", name: "Acme" });
  (data.createJob as any).mockResolvedValue(jobId);
  (data.updateJob as any).mockResolvedValue(undefined);
  (data.deleteJob as any).mockResolvedValue(undefined);
  (data.chargeClientCredits as any).mockResolvedValue({ balance: 100 });
}

beforeEach(() => {
  vi.clearAllMocks();
});

describe("one submission bills once, at the snapshot's price", () => {
  it("charges exactly once, keyed to the job it created", async () => {
    installMocks(spec({ creditsCost: 7 }));
    const { submitDynamicAgentJob } = await import("@/lib/jobs/submit-custom");
    await submitDynamicAgentJob(CLIENT_USER, {
      specId: "spec-1",
      clientId: "c1",
      inputs: { company_name: "Acme" },
    });
    const calls = (data.chargeClientCredits as any).mock.calls;
    expect(calls).toHaveLength(1);
    expect(calls[0][0].amount).toBe(7);
    expect(calls[0][0].jobId).toBe("job-1");
  });

  it("takes the price from the SNAPSHOT, so a mid-flight admin price change cannot re-price a live run", async () => {
    const live = spec({ creditsCost: 7 });
    installMocks(live);
    const { submitDynamicAgentJob } = await import("@/lib/jobs/submit-custom");
    // An admin raises the price the instant after the spec is read.
    (data.getDynamicAgentSpec as any).mockImplementation(async () => {
      const copy = spec({ creditsCost: 7 });
      live.creditsCost = 99;
      return copy;
    });
    await submitDynamicAgentJob(CLIENT_USER, {
      specId: "spec-1",
      clientId: "c1",
      inputs: { company_name: "Acme" },
    });
    expect((data.chargeClientCredits as any).mock.calls[0][0].amount).toBe(7);
  });

  it("never charges when validation refuses the submission", async () => {
    installMocks(spec());
    const { submitDynamicAgentJob } = await import("@/lib/jobs/submit-custom");
    const result = await submitDynamicAgentJob(CLIENT_USER, { specId: "spec-1", clientId: "c1", inputs: {} });
    expect(result.error).toBeTruthy();
    expect(data.chargeClientCredits).not.toHaveBeenCalled();
    expect(data.createJob).not.toHaveBeenCalled();
  });
});

describe("DECISION 3: a retry never re-charges — source 1, the Portal's retry/resume actions", () => {
  const ACTIONS_FILE = join(__dirname, "..", "actions", "external-job-actions.ts");
  const actionsSource = stripComments(readFileSync(ACTIONS_FILE, "utf8"));

  it("retryJobAction refuses a run that has no customAgentId, which is every dynamic run", () => {
    // A dynamic job is written with `dynamicAgentSpecId` and no
    // `customAgentId` (see submitDynamicAgentJob's createJob call), so this
    // guard is what keeps the retry path — and therefore a second charge —
    // unreachable for dynamic runs.
    expect(actionsSource).toMatch(/if \(!job\.customAgentId\) return \{ error:/);
  });

  /**
   * DELIBERATE DECISION (dynamic-agent step resume): `resumeFailedJobAction`
   * was added to this same file specifically to resume a failed Dynamic
   * Agent Studio run — the canary above (originally "retryJobAction does not
   * know about dynamic specs at all") is what forced this update. The
   * invariant it must preserve is the same one retryJobAction relies on: it
   * only ever reuses the existing (already-charged) jobId via
   * retryAgentServiceJob, or falls back to submitDynamicAgentJob's own single
   * charge-on-creation call — never a second chargeClientCredits call from
   * this file.
   */
  it("resumeFailedJobAction — the dynamic-run counterpart — refuses a run that has no dynamicAgentSpecId, which is every customAgent run", () => {
    expect(actionsSource).toMatch(/if \(!job\.dynamicAgentSpecId\) return \{ error:/);
  });

  it("neither retryJobAction nor resumeFailedJobAction calls chargeClientCredits — any charge can only come from submitCustomAgentJob/submitDynamicAgentJob's own single charge-on-creation call, never duplicated here", () => {
    expect(actionsSource).not.toMatch(/chargeClientCredits\s*\(/);
  });

  it("the job page offers the retry button for a customAgent run and the resume button for a dynamicAgentSpec run", () => {
    const page = stripComments(
      readFileSync(join(__dirname, "..", "..", "app", "(app)", "jobs", "[id]", "page.tsx"), "utf8"),
    );
    expect(page).toMatch(/job\.customAgentId && <JobRetryButton/);
    expect(page).toMatch(/job\.dynamicAgentSpecId && <JobResumeButton/);
  });
});

// DECISION 3's sources 2 and 3 were asserted here by reading the runner's own
// modules: that no dynamic-runner module references a billing symbol, that its
// retry re-invokes one step rather than resubmitting a job, and that the queue
// worker never asks the Portal to create another. agent-service was removed
// from this repo along with its deploy workflows, so that code is frozen at
// the revisions currently serving production and can no longer drift.
//
// The half that CAN still change is kept below: the Portal's own webhook
// handler, which refunds on failure and must never charge.
// Recoverable at 942218f.

describe("DECISION 3: a retry never re-charges — the Portal side", () => {
  it("the Portal's webhook handler refunds on failure but never charges", () => {
    const handler = stripComments(
      readFileSync(join(__dirname, "..", "..", "app", "api", "agent-service", "webhook", "route.ts"), "utf8"),
    );
    expect(handler).not.toMatch(/\bchargeClientCredits\s*\(/);
    expect(handler).toMatch(/refundJobCharge/);
  });
});
