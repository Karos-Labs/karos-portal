/* eslint-disable @typescript-eslint/no-explicit-any */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import * as data from "@/lib/data";
import * as storage from "@/lib/storage";

/**
 * Two findings about the same handler, both about something OUTSIDE it.
 *
 * #53 — THE RETRY CONTRACT. The route asks the agent-service's delivery queue to
 * retry by choosing a status code; the queue's classifier
 * (`agent-service/src/webhooks/deliver.ts`) reads only the code, and the worker
 * (`agent-service/src/queue/webhooks.ts`) RETURNS on a "rejected" verdict
 * instead of throwing, so BullMQ never re-queues it. The unmatched-job branch
 * answered 404 with a comment promising a retry, which meant one attempt and
 * then nothing: the job stays queued/running (the reconciler leaves a job the
 * service reports as `done` alone precisely so this webhook can attach the
 * deliverables), no asset is written, and a client-charged run is never
 * refunded. So the assertion here is not "404 became 503" — it is that every
 * condition this route wants retried picks the SAME code, and that code is not
 * in the range the sender treats as permanent.
 *
 * #54 — THE CONCURRENT APPEND. `events` and `assetIds` are written back as
 * WHOLE ARRAYS, over a base read before a re-host budgeted for most of a
 * minute. `requestJobCancellation` (`src/lib/actions/external-job-actions.ts`)
 * appends "Cancellation requested" through the same read-modify-write idiom and
 * takes no claim, so its line was being erased by this write.
 *
 * agent-service is a separate package: the root vitest config excludes it and
 * `npm ci` does not install its deps, so this suite cannot import
 * `deliverWebhook` and ask it directly. What it can pin is the route's half of
 * the seam — one code for every retry-me answer, and never a 4xx.
 */

vi.mock("server-only", () => ({}));
vi.mock("next/server", async (importOriginal) => {
  const actual = await importOriginal<typeof import("next/server")>();
  return { ...actual, after: (fn: () => void) => fn() };
});
vi.mock("@/lib/data");
vi.mock("@/lib/data-client-agents");
/**
 * CONTROLLABLE, not hard-true. It was `() => true` at module scope, which made
 * the 401 branch unreachable in this file — while a test named "still refuses a
 * delivery it cannot AUTHENTICATE or parse" claimed to cover it. #53's whole
 * argument is that the 4xx/5xx split IS the contract, so "the remaining 4xx stay
 * 4xx" is the counterweight to broadening the retryable side; half of it was
 * decorative.
 */
let signatureValid = true;
vi.mock("@/lib/agent-service/verify", () => ({
  SIGNATURE_HEADER: "x-signature",
  TIMESTAMP_HEADER: "x-timestamp",
  verifyAgentServiceSignature: () => signatureValid,
}));
vi.mock("@/lib/storage", () => ({ uploadBytes: vi.fn() }));
vi.mock("@/lib/chain", () => ({ reflowClientChain: vi.fn().mockResolvedValue(undefined) }));
vi.mock("@/lib/client-agent-slots", () => ({
  syncOptionsFromBatchAsset: vi.fn().mockResolvedValue(undefined),
}));
vi.mock("@/lib/credit-reconcile", () => ({
  refundJobCharge: vi.fn().mockResolvedValue({ refunded: false }),
}));
vi.mock("@/lib/task-sync", () => ({
  autoCompleteTasksByTrigger: vi.fn().mockResolvedValue(undefined),
  findDispatchingTask: vi.fn().mockResolvedValue(null),
  syncTaskForJobOutcome: vi.fn().mockResolvedValue(undefined),
}));
vi.mock("@/lib/job-alerts", () => ({ notifyJobFailure: vi.fn().mockResolvedValue(undefined) }));
vi.mock("@/services/logger", () => ({ logger: { logUsage: vi.fn() } }));

import { refundJobCharge } from "@/lib/credit-reconcile";
import { getClientAgent } from "@/lib/data-client-agents";

/**
 * `isJobInFlight` is pure and the route's pre-claim filter reads it. Automocked
 * it returns undefined, which reads as "terminal" and turns every delivery
 * away. Restored from the real module rather than re-implemented, so this file
 * cannot hold a second opinion about what "in flight" means.
 */
const realData = await vi.importActual<typeof import("@/lib/data")>("@/lib/data");

const DRAFTS_MD = "# Drafts\n\nThe post the client is paying for.\n";
const CANCEL_LINE = "Cancellation requested";

function jobDoc(overrides: Record<string, any> = {}): Record<string, any> {
  return {
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
    ...overrides,
  };
}

/**
 * No `metadata` on purpose. `platform_job_id` would send the handler through a
 * SECOND `getJob` call (the submission-race fallback), and these tests read that
 * mock to talk about the pre-write re-read.
 */
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
        sha256: "aaaaaaaaaaaaaaaa",
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

function serveArtifacts(onFetch?: () => void) {
  return vi.fn().mockImplementation(async () => {
    onFetch?.();
    return {
      ok: true,
      status: 200,
      headers: new Headers(),
      arrayBuffer: async () => new TextEncoder().encode(DRAFTS_MD).buffer,
      text: async () => DRAFTS_MD,
    };
  });
}

/** The patch the handler wrote to the job record, or null if it never wrote one. */
function writtenJobPatch(): any {
  const call = (data.updateJob as any).mock.calls.at(-1);
  return call ? call[1] : null;
}

function messages(patch: any): string[] {
  return (patch?.events ?? []).map((e: any) => e.message);
}

beforeEach(() => {
  vi.clearAllMocks();
  process.env.AGENT_WEBHOOK_SECRET = "test-secret";
  vi.stubGlobal("fetch", serveArtifacts());
  (storage.uploadBytes as any).mockImplementation(async ({ path }: { path: string }) => ({
    url: `https://cdn.test/${path}`,
    path,
  }));
  (data.isJobInFlight as any).mockImplementation(realData.isJobInFlight);
  (data.getJobByExternalServiceId as any).mockResolvedValue(jobDoc());
  (data.getJob as any).mockResolvedValue(jobDoc());
  (data.claimExternalJobCompletion as any).mockResolvedValue(true);
  (data.createAsset as any).mockResolvedValue("asset-new");
  (data.updateJob as any).mockResolvedValue(undefined);
  (data.getClient as any).mockResolvedValue({ id: "c1", name: "Karos" });
  (getClientAgent as any).mockResolvedValue(null);
  vi.spyOn(console, "error").mockImplementation(() => {});
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

/* ── #53 ─────────────────────────────────────────────────────────────── */

describe("#53 — every condition the route wants retried asks for it the same way", () => {
  /**
   * One scenario per pre-claim bail-out whose body says "retry delivery". The
   * re-host budget is the fourth; it needs the fake clock and is already pinned
   * at 503 by webhook-rehost-before-claim.test.ts and webhook-rehost-integrity.
   */
  const retryable: [string, () => void | Promise<void>, () => Record<string, any>][] = [
    [
      "no platform job matched the delivery",
      () => {
        (data.getJobByExternalServiceId as any).mockResolvedValue(null);
        (data.getJob as any).mockResolvedValue(null);
      },
      () => payload({ metadata: { platform_job_id: "job-gone" } }),
    ],
    [
      "the failed run's credit refund did not write",
      () => {
        (refundJobCharge as any).mockRejectedValue(new Error("firestore unavailable"));
      },
      () => payload({ status: "failed", error: "boom" }),
    ],
    [
      "the template-stream lookup threw",
      () => {
        (data.getJobByExternalServiceId as any).mockResolvedValue(
          jobDoc({ clientAgentId: "ca-1", templateKey: "weekly", runType: "scheduled" }),
        );
        (getClientAgent as any).mockRejectedValue(new Error("firestore unavailable"));
      },
      () => payload(),
    ],
  ];

  it.each(retryable)("%s → a status the sender's queue will retry", async (_name, arrange, body) => {
    await arrange();
    const res = await post(body());

    // THE POINT OF THE FINDING. `deliverWebhook` maps 400-499 to "rejected" and
    // the webhooks worker gives up on that verdict without throwing, so BullMQ
    // never schedules attempt 2. A 4xx here is a dropped deliverable.
    expect(res.status).toBeGreaterThanOrEqual(500);
    expect(res.status).toBeLessThan(600);

    // …and nothing was claimed, so the retry gets the whole delivery again.
    expect(data.claimExternalJobCompletion).not.toHaveBeenCalled();
  });

  it("uses ONE code for all of them, so the sender has one rule and not a list", async () => {
    const codes: number[] = [];
    for (const [, arrange, body] of retryable) {
      vi.clearAllMocks();
      (data.isJobInFlight as any).mockImplementation(realData.isJobInFlight);
      (data.getJobByExternalServiceId as any).mockResolvedValue(jobDoc());
      (data.getJob as any).mockResolvedValue(jobDoc());
      (data.claimExternalJobCompletion as any).mockResolvedValue(true);
      (data.createAsset as any).mockResolvedValue("asset-new");
      (data.updateJob as any).mockResolvedValue(undefined);
      (refundJobCharge as any).mockResolvedValue({ refunded: false });
      (getClientAgent as any).mockResolvedValue(null);
      await arrange();
      codes.push((await post(body())).status);
    }
    expect(new Set(codes)).toEqual(new Set([503]));
  });

  it("still refuses a delivery it cannot PARSE, permanently", async () => {
    // The counterweight: broadening the retryable side must not turn the
    // genuinely permanent refusals into retries the queue chases for 42 minutes.
    const { POST } = await import("@/app/api/agent-service/webhook/route");
    const bad = new Request("https://portal.test/api/agent-service/webhook", {
      method: "POST",
      headers: { "x-signature": "sig", "x-timestamp": "1", "content-type": "application/json" },
      body: "{not json",
    });
    expect((await POST(bad as any)).status).toBe(400);

    const wrongShape = await post({ event: "job.completed", job_id: "svc-1" });
    expect(wrongShape.status).toBe(400);
  });

  it("still refuses a delivery it cannot AUTHENTICATE, permanently", async () => {
    // Split out and actually driven. A bad signature is permanent for real:
    // retrying it would chase an attacker (or a misconfigured secret) for the
    // queue's whole schedule, and no amount of retrying makes it verify.
    signatureValid = false;
    try {
      const res = await post(payload());
      expect(res.status).toBe(401);
      expect(res.status, "a bad signature became retryable").toBeLessThan(500);
    } finally {
      signatureValid = true;
    }
  });
});

/* ── #54 ─────────────────────────────────────────────────────────────── */

describe("#54 — a concurrent writer's event is not erased by the whole-array write", () => {
  it("keeps a cancellation appended while the delivery was still re-hosting", async () => {
    // The job as this delivery first read it: no cancellation on it yet.
    const atReadTime = jobDoc({ events: [{ at: 1, level: "info", message: "Submitted to agent service" }] });
    (data.getJobByExternalServiceId as any).mockResolvedValue(atReadTime);

    // …and the job as it exists by the time the writes run, because a staff
    // Force Cancel landed mid-re-host. Applied from inside the fetch mock so the
    // ordering is the real one: after the handler's read, before its write.
    const onDisk = jobDoc({ events: [...atReadTime.events] });
    (data.getJob as any).mockResolvedValue(onDisk);
    vi.stubGlobal(
      "fetch",
      serveArtifacts(() => {
        onDisk.events.push({ at: 2, level: "info", message: CANCEL_LINE } as any);
      }),
    );

    const res = await post(payload());
    expect(res.status).toBe(200);

    const written = messages(writtenJobPatch());
    expect(written.filter((m) => m === CANCEL_LINE)).toHaveLength(1);
    // and this delivery's own outcome line is still there beside it
    expect(written.filter((m) => m.startsWith("Agent run complete"))).toHaveLength(1);
  });

  it("writes each pre-existing line exactly once", async () => {
    // The other direction. Merging onto a re-read base while ALSO seeding the
    // accumulator from the stale copy would duplicate every line the job already
    // had — a run log that says "Submitted to agent service" twice.
    const existing = { at: 1, level: "info", message: "Submitted to agent service" };
    (data.getJobByExternalServiceId as any).mockResolvedValue(jobDoc({ events: [existing] }));
    (data.getJob as any).mockResolvedValue(jobDoc({ events: [existing] }));

    await post(payload());

    const written = messages(writtenJobPatch());
    expect(written.filter((m) => m === existing.message)).toHaveLength(1);
  });

  it("keeps an asset id another delivery had already recorded", async () => {
    // Same merge, the assetIds half. No second writer appends here today, so
    // this pins the symmetry rather than a loss anyone has seen.
    (data.getJobByExternalServiceId as any).mockResolvedValue(jobDoc({ assetIds: [] }));
    (data.getJob as any).mockResolvedValue(jobDoc({ assetIds: ["asset-earlier"] }));

    await post(payload());

    expect(writtenJobPatch().assetIds).toEqual(["asset-earlier", "asset-new"]);
  });

  it("still records its own lines when the pre-write re-read fails", async () => {
    // The re-read is a convenience, not a dependency: losing it must not lose
    // the delivery's own run log on top of it.
    (data.getJobByExternalServiceId as any).mockResolvedValue(
      jobDoc({ events: [{ at: 1, level: "info", message: "Submitted to agent service" }] }),
    );
    (data.getJob as any).mockRejectedValue(new Error("firestore unavailable"));

    const res = await post(payload());
    expect(res.status).toBe(200);

    const written = messages(writtenJobPatch());
    expect(written.filter((m) => m.startsWith("Agent run complete"))).toHaveLength(1);
    expect(written.filter((m) => m === "Submitted to agent service")).toHaveLength(1);
  });
});
