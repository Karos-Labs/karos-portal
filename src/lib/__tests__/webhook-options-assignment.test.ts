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
  findDispatchingTask: vi.fn().mockResolvedValue(null),
}));

const realData = await vi.importActual<typeof import("@/lib/data")>("@/lib/data");

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

/**
 * The tenant OUR job record names — the only one any write here may reach.
 * Bound once so the fixtures below and the isolation tests at the bottom cannot
 * drift into agreeing with the payload by accident.
 */
const JOB_CLIENT = "c1";

/**
 * A tenant the job does NOT belong to, used only by the isolation tests at the
 * bottom. Deliberately not a near-miss of `JOB_CLIENT`: the two ids have to be
 * distinguishable at a glance in a failure message.
 */
const OTHER_TENANT = "c-not-this-jobs-client";

const X_UMBRELLA = {
  id: "ca-x",
  clientId: JOB_CLIENT,
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
    clientId: JOB_CLIENT,
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
    client_id: JOB_CLIENT,
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

  // Pure, and read by the route's pre-claim status filter. Automocked it returns
  // undefined, which reads as "terminal" and turns every delivery away. Restored
  // from the real module rather than re-implemented, so this file cannot drift
  // from the one definition of "still in flight" in `src/lib/data.ts`.
  (data.isJobInFlight as any).mockImplementation(realData.isJobInFlight);

  (data.getJobByExternalServiceId as any).mockResolvedValue({
    id: "job-1",
    clientId: JOB_CLIENT,
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
    { id: "pr1", clientId: JOB_CLIENT, customAgentId: "agent-x", clientAgentId: "ca-x", cadence: "weekly", status: "active", weekdays: [0, 1, 2, 3, 4, 5, 6], hour: 9, minute: 0, timeZone: "UTC" },
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

  /**
   * THE TENANT FENCE, and the reason it is asked with two DIFFERENT ids.
   *
   * This test used to post `client_id: "c1"` against a job whose clientId was
   * already "c1", so both candidate sources spelled the same string and
   * `toHaveBeenCalledWith({ clientId: "c1" })` could not tell which one the
   * route had read. It passed on the fix and would have passed on the bug.
   *
   * The HMAC proves the SENDER, not the body: a wrong tenant in `client_id`
   * (a service-side mix-up, a replayed body from another run, a leaked signing
   * key) must still not steer a write, because our own job record is the thing
   * that says whose run this is. So the payload names a tenant the job does
   * not, and every assertion below is on the JOB's.
   */
  it("looks umbrellas up by the JOB's client, never the payload's", async () => {
    await post(payload({ client_id: OTHER_TENANT }));

    expect(dataClientAgents.listClientAgents).toHaveBeenCalledWith({ clientId: JOB_CLIENT });
    // Every call, not just one of them — `toHaveBeenCalledWith` is satisfied by
    // a single matching call and would ignore a second one naming the payload's
    // tenant. The lookup is what reaches another client's plan, so it is asked
    // as "no call anywhere named anyone else".
    const lookups = (dataClientAgents.listClientAgents as any).mock.calls.map(
      (c: any[]) => c[0]?.clientId,
    );
    expect(lookups).toEqual([JOB_CLIENT]);
  });

  it("writes the deliverable to the JOB's client, never the payload's", async () => {
    // The sibling half: the umbrella lookup above decides whose PLAN gets
    // sliced, this decides whose LIBRARY the batch asset lands in — and the
    // slot rows the assignment writes carry the asset id, so a deliverable
    // filed under the wrong tenant would be reachable from the right one.
    await post(payload({ client_id: OTHER_TENANT }));

    expect((data.createAsset as any).mock.calls).toHaveLength(1);
    expect((data.createAsset as any).mock.calls[0][0].clientId).toBe(JOB_CLIENT);
  });
});
