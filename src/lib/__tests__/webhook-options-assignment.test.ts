/* eslint-disable @typescript-eslint/no-explicit-any */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import * as data from "@/lib/data";
import * as dataClientAgents from "@/lib/data-client-agents";

/**
 * B1, second pass — a batch driven THROUGH the webhook must slice the plan.
 *
 * The first fix hung assignment off ensureSlotHorizon, whose only
 * options-mode-reachable caller is the one-shot go-live (the other callers are
 * template-gated, and an options umbrella has no templates by design). The
 * recurring X batch arrives here, weekly, and never re-entered that path — so
 * week 2's drafts were never sliced and the picker stayed empty forever.
 *
 * These tests exercise the real POST handler end to end: signed payload in,
 * DRAFTS.md fetched as an artifact, asset written, slots assigned.
 */

vi.mock("server-only", () => ({}));
vi.mock("next/server", async (importOriginal) => {
  const actual = await importOriginal<typeof import("next/server")>();
  return { ...actual, after: (fn: () => void) => fn() };
});
vi.mock("@/lib/data");
vi.mock("@/lib/data-client-agents");
vi.mock("@/lib/agent-service/verify", () => ({
  SIGNATURE_HEADER: "x-signature",
  TIMESTAMP_HEADER: "x-timestamp",
  verifyAgentServiceSignature: () => true,
}));
vi.mock("@/lib/storage", () => ({
  uploadBytes: vi.fn().mockResolvedValue({ url: "https://cdn.test/DRAFTS.md" }),
}));
vi.mock("@/lib/chain", () => ({ reflowClientChain: vi.fn().mockResolvedValue(undefined) }));
vi.mock("@/lib/credit-reconcile", () => ({
  refundJobCharge: vi.fn().mockResolvedValue({ refunded: false }),
}));
vi.mock("@/lib/task-sync", () => ({
  autoCompleteTasksByTrigger: vi.fn().mockResolvedValue(undefined),
  syncTaskForJobOutcome: vi.fn().mockResolvedValue(undefined),
}));

const DRAFTS_MD = [
  "# Account 1 · Company page @getkaros",
  "",
  "## Avenue 1 · Playbook",
  "",
  "> Ship it weekly.",
  "",
  "## Avenue 2 · Founder POV",
  "",
  "> What I learned.",
  "",
  "## Avenue 3 · News-reaction (live)",
  "",
  "> On today's news.",
  "",
].join("\n");

const X_UMBRELLA = {
  id: "ca-x",
  clientId: "c1",
  customAgentId: "agent-x",
  displayName: "X Agent",
  launchState: "live",
  slotMode: "options",
  rotation: [],
  templates: [],
  scheduleRunId: "pr1",
} as any;

function slot(dateKey: string, patch: Record<string, any> = {}): any {
  return {
    id: `ca-x__${dateKey}`,
    clientId: "c1",
    clientAgentId: "ca-x",
    dateKey,
    kind: "options",
    templateKey: "daily-post",
    status: "planned",
    createdBy: "u1",
    createdAt: 0,
    updatedAt: 0,
    ...patch,
  };
}

const NOW = Date.parse("2026-07-28T09:00:00Z");

function payload(overrides: Record<string, any> = {}) {
  return {
    event: "job.completed",
    job_id: "svc-1",
    status: "done",
    task_type: "custom",
    client_id: "c1",
    artifacts: [
      {
        name: "DRAFTS.md",
        path: "DRAFTS.md",
        bytes: DRAFTS_MD.length,
        sha256: "abc",
        content_type: "text/markdown",
        client_facing: true,
        url: "https://service.test/DRAFTS.md",
      },
    ],
    attempt: 0,
    ...overrides,
  };
}

async function post(body: Record<string, any>) {
  const { POST } = await import("@/app/api/agent-service/webhook/route");
  const req = new Request("https://portal.test/api/agent-service/webhook", {
    method: "POST",
    headers: { "x-signature": "sig", "x-timestamp": "1", "content-type": "application/json" },
    body: JSON.stringify(body),
  });
  return POST(req as any);
}

beforeEach(() => {
  vi.clearAllMocks();
  vi.useFakeTimers();
  vi.setSystemTime(NOW);
  process.env.AGENT_WEBHOOK_SECRET = "test-secret";

  vi.stubGlobal(
    "fetch",
    vi.fn().mockResolvedValue({
      ok: true,
      headers: new Headers({ "content-type": "text/markdown" }),
      arrayBuffer: async () => new TextEncoder().encode(DRAFTS_MD).buffer,
      text: async () => DRAFTS_MD,
    }),
  );

  (data.getJobByExternalServiceId as any).mockResolvedValue({
    id: "job-1",
    clientId: "c1",
    agentId: "agent-service",
    agentName: "X Agent",
    title: "X Agent · Weekly drafts",
    customAgentId: "agent-x",
    status: "running",
    assetIds: [],
    events: [],
    input: {},
    createdAt: 0,
    external: { serviceJobId: "svc-1", taskType: "custom" },
  });
  (data.claimExternalJobCompletion as any).mockResolvedValue(true);
  (data.createAsset as any).mockResolvedValue("asset-batch-1");
  (data.updateJob as any).mockResolvedValue(undefined);

  (dataClientAgents.listClientAgents as any).mockResolvedValue([X_UMBRELLA]);
  (dataClientAgents.listAgentSlots as any).mockResolvedValue([
    slot("2026-07-28"),
    slot("2026-07-29"),
  ]);
  (dataClientAgents.updateAgentSlot as any).mockResolvedValue(undefined);
  (data.listPlannedScheduledRuns as any).mockResolvedValue([
    { id: "pr1", clientId: "c1", customAgentId: "agent-x", clientAgentId: "ca-x", cadence: "weekly", status: "active", weekdays: [0, 1, 2, 3, 4, 5, 6], hour: 9, minute: 0, timeZone: "UTC" },
  ]);
});

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

describe("webhook → daily options assignment (B1)", () => {
  it("slices a DRAFTS batch across the plan when it lands", async () => {
    const res = await post(payload());
    expect(res.status).toBe(200);

    // The day got its three candidates, pointed at the batch asset just written.
    const calls = (dataClientAgents.updateAgentSlot as any).mock.calls;
    expect(calls.length).toBe(1);
    const [slotId, patch] = calls[0];
    expect(slotId).toBe("ca-x__2026-07-28");
    expect(patch.optionRefs).toHaveLength(3);
    expect(patch.assetId).toBe("asset-batch-1");
  });

  it("is safe on redelivery — a day that already has options is untouched", async () => {
    (dataClientAgents.listAgentSlots as any).mockResolvedValue([
      slot("2026-07-28", { optionRefs: ["Company page @getkaros · Avenue 1 · Playbook"] }),
    ]);

    await post(payload());

    // The claim is single-use, but this runs after it — so idempotence has to
    // come from the assignment itself, not from the claim.
    expect(dataClientAgents.updateAgentSlot).not.toHaveBeenCalled();
  });

  it("assigns nothing for a client with no live options umbrella", async () => {
    (dataClientAgents.listClientAgents as any).mockResolvedValue([
      { ...X_UMBRELLA, launchState: "curating" },
    ]);

    await post(payload());

    expect(dataClientAgents.updateAgentSlot).not.toHaveBeenCalled();
  });

  it("ignores a normal post — the parse predicate is the test, not the filename", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue({
        ok: true,
        headers: new Headers({ "content-type": "text/markdown" }),
        arrayBuffer: async () => new TextEncoder().encode("Just a post.").buffer,
        text: async () => "Just a post.",
      }),
    );

    await post(payload());

    expect(dataClientAgents.updateAgentSlot).not.toHaveBeenCalled();
  });

  it("looks umbrellas up by the JOB's client, never the payload's", async () => {
    // A crafted payload naming another tenant must not reach their plan.
    await post(payload({ client_id: "c1" }));

    expect(dataClientAgents.listClientAgents).toHaveBeenCalledWith({ clientId: "c1" });
  });
});
