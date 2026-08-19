/* eslint-disable @typescript-eslint/no-explicit-any */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import * as data from "@/lib/data";
import * as storage from "@/lib/storage";
import { REHOST_DEADLINE_MS } from "@/lib/agent-service/rehost-budget";

/**
 * Finding #45 — the webhook must not destroy a deliverable it has been paid for.
 *
 * `claimExternalJobCompletion` is single-use: once a delivery takes it, the job
 * reads `review` and every redelivery answers "Already processed" forever. The
 * artifact re-host used to run AFTER that claim, so a wall-clock kill or an
 * instance recycle during the fetch/upload loop left a success-looking job with
 * zero assets, no error, and the client's credits spent — with no recovery path,
 * since the stuck-job sweep only reads queued/running and `reconcileOneJob`
 * refuses to touch a job the service reports as done.
 *
 * Three closed questions, one per suite below:
 *   1. at the moment the re-host is doing its network work, HAS the job been
 *      claimed? (If it has, dying there is unrecoverable.)
 *   2. does a redelivery of an already-settled job do any network work at all?
 *   3. does the re-host phase END by its deadline?
 *
 * Plus the counterweight: the pre-claim status filter that answers (2) must not
 * become a second gate, so a genuinely concurrent pair must still both reach the
 * claim.
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
  syncTaskForJobOutcome: vi.fn().mockResolvedValue(undefined),
  findDispatchingTask: vi.fn().mockResolvedValue(null),
}));
vi.mock("@/lib/job-alerts", () => ({ notifyJobFailure: vi.fn().mockResolvedValue(undefined) }));
const logUsageMock = vi.fn();
vi.mock("@/services/logger", () => ({ logger: { logUsage: logUsageMock } }));

import { refundJobCharge } from "@/lib/credit-reconcile";
import { reflowClientChain } from "@/lib/chain";
import { syncOptionsFromBatchAsset } from "@/lib/client-agent-slots";
import { autoCompleteTasksByTrigger, syncTaskForJobOutcome } from "@/lib/task-sync";

/**
 * `isJobInFlight` is pure, and the route's pre-claim filter reads it. Automocked
 * it returns undefined, which reads as "terminal" and turns every delivery away.
 * Restored from the real module rather than re-implemented here: the filter and
 * `claimExternalJobCompletion` must agree on one definition of "still in flight",
 * and a second copy in this file is exactly how they would drift apart.
 */
const realData = await vi.importActual<typeof import("@/lib/data")>("@/lib/data");

const DRAFTS_MD = "# Drafts\n\n> The post the client is paying for.\n";
const PNG_BYTES = "\x89PNG-slide-one";
const NOW = Date.parse("2026-07-31T09:00:00Z");

/** The mirrored platform job, mid-run — the state a first delivery finds. */
function jobDoc(overrides: Record<string, any> = {}) {
  return {
    id: "job-1",
    clientId: "c1",
    agentId: "agent-service",
    agentName: "LinkedIn Agent",
    title: "LinkedIn Agent · Weekly drafts",
    customAgentId: "agent-li",
    status: "running",
    assetIds: [],
    events: [],
    input: {},
    createdAt: 0,
    external: { serviceJobId: "svc-1", taskType: "custom" },
    ...overrides,
  };
}

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
      {
        name: "slide-1.png",
        path: "slide-1.png",
        bytes: PNG_BYTES.length,
        sha256: "bbbbbbbbbbbbbbbb",
        content_type: "image/png",
        client_facing: true,
        url: "https://service.test/slide-1.png",
      },
      {
        name: "debug.log",
        path: "debug.log",
        bytes: 5,
        sha256: "cccccccccccccccc",
        content_type: "text/plain",
        client_facing: false,
        url: "https://service.test/debug.log",
      },
    ],
    usage: {
      totalCostUsd: 0.1,
      models: {
        "claude-opus-5": {
          inputTokens: 10,
          outputTokens: 20,
          cacheReadInputTokens: 0,
          cacheCreationInputTokens: 0,
        },
      },
    },
    attempt: 0,
    ...overrides,
  };
}

/** A manifest of `count` client-facing text artifacts, all needing a re-host. */
function manifest(count: number) {
  return payload({
    artifacts: Array.from({ length: count }, (_, i) => ({
      name: `draft-${i + 1}.md`,
      path: `draft-${i + 1}.md`,
      bytes: DRAFTS_MD.length,
      sha256: String(i + 1).repeat(16),
      content_type: "text/markdown",
      client_facing: true,
      url: `https://service.test/draft-${i + 1}.md`,
    })),
  });
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

/** An instant server. Used by every test whose subject is not wall clock. */
function serveArtifacts() {
  return vi.fn().mockImplementation(async (url: string) => {
    const body = url.endsWith(".png") ? PNG_BYTES : DRAFTS_MD;
    return {
      ok: true,
      status: 200,
      headers: new Headers(),
      arrayBuffer: async () => new TextEncoder().encode(body).buffer,
      text: async () => body,
    };
  });
}

/**
 * Make `AbortSignal.timeout` fire on vi's fake clock. Node implements it on an
 * internal timer that fake timers do not drive (verified: a faked advance past
 * the delay never fires the abort), so without this a timing test cannot observe
 * a budget being enforced at all. The delays still come from the route.
 */
let abortSignalSpy: { mockRestore: () => void } | null = null;
function useFakeClockAbortSignals() {
  abortSignalSpy = vi.spyOn(AbortSignal, "timeout").mockImplementation(((ms: number) => {
    const controller = new AbortController();
    setTimeout(() => controller.abort(new Error("The operation was aborted")), ms);
    return controller.signal;
  }) as typeof AbortSignal.timeout);
}

/**
 * A slow server on the fake clock that HONOURS its abort signal the way undici
 * does: whichever of "the server answered" and "the caller's budget ran out"
 * comes first, wins. So a fetch can never consume more clock than the route
 * allowed it — which is what makes an assertion about elapsed time meaningful
 * rather than an artifact of the mock.
 *
 * `bodyMsFor` charges clock to reading the body. A real aborted fetch also kills
 * the body stream; this double deliberately does NOT, which is the only way to
 * reach the route's between-fetch-and-upload budget check.
 */
function slowServer(opts: { latencyMs: number; bodyMsFor?: (url: string) => number }) {
  return vi.fn().mockImplementation(async (url: string, init: RequestInit) => {
    await new Promise<void>((resolve, reject) => {
      const timer = setTimeout(resolve, opts.latencyMs);
      init.signal?.addEventListener("abort", () => {
        clearTimeout(timer);
        reject(Object.assign(new Error("The operation was aborted"), { name: "TimeoutError" }));
      });
    });
    const body = url.endsWith(".png") ? PNG_BYTES : DRAFTS_MD;
    return {
      ok: true,
      status: 200,
      headers: new Headers(),
      arrayBuffer: async () => {
        const bodyMs = opts.bodyMsFor?.(url) ?? 0;
        if (bodyMs > 0) await new Promise<void>((r) => setTimeout(r, bodyMs));
        return new TextEncoder().encode(body).buffer;
      },
      text: async () => body,
    };
  });
}

/**
 * Drive the handler on the fake clock until it settles. Ten fake minutes is far
 * more than any budget in play; running out means the handler never finished,
 * which fails the caller's assertion rather than hanging the suite.
 */
async function postOnFakeClock(body: Record<string, any>) {
  let response: Response | null = null;
  let failure: unknown = null;
  const pending = post(body).then(
    (r) => {
      response = r;
    },
    (e) => {
      failure = e;
    },
  );
  for (let elapsed = 0; elapsed < 600_000 && response === null && failure === null; elapsed += 500) {
    await vi.advanceTimersByTimeAsync(500);
  }
  await pending;
  if (failure) throw failure;
  return response as unknown as Response;
}

beforeEach(() => {
  vi.clearAllMocks();
  vi.useFakeTimers();
  vi.setSystemTime(NOW);
  process.env.AGENT_WEBHOOK_SECRET = "test-secret";

  vi.stubGlobal("fetch", serveArtifacts());
  (storage.uploadBytes as any).mockImplementation(async ({ path }: { path: string }) => ({
    url: `https://cdn.test/${path}`,
    path,
  }));

  (data.isJobInFlight as any).mockImplementation(realData.isJobInFlight);
  (data.getJobByExternalServiceId as any).mockResolvedValue(jobDoc());
  (data.claimExternalJobCompletion as any).mockResolvedValue(true);
  (data.createAsset as any).mockResolvedValue("asset-1");
  (data.updateJob as any).mockResolvedValue(undefined);
  (data.getClient as any).mockResolvedValue({ id: "c1", name: "Karos" });
});

afterEach(() => {
  // Restored narrowly rather than with restoreAllMocks(), which would also wipe
  // the module-mock implementations set in the vi.mock factories above.
  abortSignalSpy?.mockRestore();
  abortSignalSpy = null;
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

describe("#45 — the re-host runs before the single-use claim", () => {
  it("has not claimed the job while it is still fetching and uploading bytes", async () => {
    // The closed question. A wall-clock kill is not a catchable throw, so what
    // makes it survivable is that nothing has been claimed yet when it lands.
    let claimedWhenFetching: boolean | null = null;
    let claimedWhenUploading: boolean | null = null;
    const claimCount = () => (data.claimExternalJobCompletion as any).mock.calls.length;

    vi.stubGlobal(
      "fetch",
      vi.fn().mockImplementation(async (url: string) => {
        claimedWhenFetching ??= claimCount() > 0;
        const body = url.endsWith(".png") ? PNG_BYTES : DRAFTS_MD;
        return {
          ok: true,
          status: 200,
          headers: new Headers(),
          arrayBuffer: async () => new TextEncoder().encode(body).buffer,
          text: async () => body,
        };
      }),
    );
    (storage.uploadBytes as any).mockImplementation(async ({ path }: { path: string }) => {
      claimedWhenUploading ??= claimCount() > 0;
      return { url: `https://cdn.test/${path}`, path };
    });

    const res = await post(payload());
    expect(res.status).toBe(200);

    // Both phases ran, and neither had spent the single-use claim.
    expect(claimedWhenFetching).toBe(false);
    expect(claimedWhenUploading).toBe(false);
    // And the claim did happen — otherwise the assertions above are vacuous.
    expect(claimCount()).toBe(1);
  });

  it("re-delivers successfully after a delivery that ran out of wall clock", async () => {
    // Delivery 1: the manifest cannot finish inside the re-host budget. The old
    // ordering claimed first, so this delivery would have burned the job's only
    // claim and the client would have lost the deliverable permanently.
    useFakeClockAbortSignals();
    vi.stubGlobal("fetch", slowServer({ latencyMs: 40_000 }));

    const first = await postOnFakeClock(manifest(4));

    expect(first.status).toBe(503);
    expect(data.claimExternalJobCompletion).not.toHaveBeenCalled();
    expect(data.createAsset).not.toHaveBeenCalled();
    expect(data.updateJob).not.toHaveBeenCalled();

    // Delivery 2 (the service's retry): a fresh budget, and the deliverable
    // actually lands. This is the whole point of not claiming above.
    vi.stubGlobal("fetch", serveArtifacts());

    const second = await post(manifest(4));

    expect(second.status).toBe(200);
    expect(data.claimExternalJobCompletion).toHaveBeenCalledTimes(1);
    expect(data.createAsset).toHaveBeenCalledTimes(1);
    const asset = (data.createAsset as any).mock.calls[0][0];
    expect(asset.content).toContain("The post the client is paying for");
  });
});

describe("#45 — the re-host phase ends by its deadline", () => {
  it("ends the phase by the deadline rather than letting one artifact run past it", async () => {
    // Four artifacts from a server that takes 40s each. Bounding an artifact by
    // a fixed per-artifact constant instead of by the REMAINING budget lets the
    // third one start at 80s and run its full 40s to 120s — at or past the
    // handler's maxDuration, where the platform kills it and the clean 503
    // below never reaches anybody. Bounding by the remainder cuts that third
    // fetch off at the deadline instead.
    useFakeClockAbortSignals();
    vi.stubGlobal("fetch", slowServer({ latencyMs: 40_000 }));

    const startedAt = Date.now();
    const res = await postOnFakeClock(manifest(4));
    const elapsedMs = Date.now() - startedAt;

    expect(res.status).toBe(503);
    // The closed question: did the phase END by the deadline? Not "was a budget
    // handed to something".
    expect(elapsedMs).toBeLessThanOrEqual(REHOST_DEADLINE_MS + 500);
    // Data-safe either way, and worth pinning: the retry can still deliver.
    expect(data.claimExternalJobCompletion).not.toHaveBeenCalled();
  });

  it("never hands an upload a non-positive budget", async () => {
    // The degenerate case of bounding by the remainder: the budget can be gone
    // by the time the fetch returns, and neither AbortSignal.timeout nor the
    // storage upload may then be handed zero or a negative. Reached here by a
    // second artifact whose BODY read runs long — the first one uploads
    // normally, so the assertion below is not vacuous.
    useFakeClockAbortSignals();
    vi.stubGlobal(
      "fetch",
      slowServer({
        latencyMs: 10_000,
        bodyMsFor: (url) => (url.endsWith("draft-2.md") ? 80_000 : 0),
      }),
    );

    const res = await postOnFakeClock(manifest(2));

    expect(res.status).toBe(503);
    const budgets = (storage.uploadBytes as any).mock.calls.map((c: any[]) => c[0].timeoutMs);
    expect(budgets).toHaveLength(1);
    for (const budget of budgets) expect(budget).toBeGreaterThan(0);
  });
});

describe("#45 — a redelivery of a settled job pays nothing", () => {
  it("re-hosts nothing when the job has already reached a terminal status", async () => {
    // Why this matters: the sender abandons each delivery at 30s while the
    // re-host budget is longer, so exactly the slow manifests that budget exists
    // for get retried on the service's schedule. Without the pre-claim filter
    // every one of those attempts re-fetched and re-uploaded the whole manifest
    // before the claim rejected it — each under its own path segment, and only
    // the winner's URL recorded anywhere.
    (data.getJobByExternalServiceId as any).mockResolvedValue(jobDoc({ status: "review" }));

    const res = await post(payload());

    expect(res.status).toBe(200);
    await expect(res.json()).resolves.toEqual({
      ok: true,
      skipped: true,
      reason: "Already processed",
    });
    // Zero network and zero storage — not merely "it answered 200".
    expect(globalThis.fetch).not.toHaveBeenCalled();
    expect(storage.uploadBytes).not.toHaveBeenCalled();
    // And none of the other pre-claim work either.
    expect(refundJobCharge).not.toHaveBeenCalled();
    expect(data.createAsset).not.toHaveBeenCalled();
    expect(data.updateJob).not.toHaveBeenCalled();
  });

  it("turns away a locally force-cancelled job without re-hosting it", async () => {
    // `reconcileOneJob` terminalizes a force-cancelled run locally, so the
    // service's still-queued delivery arrives at a job that is already settled.
    (data.getJobByExternalServiceId as any).mockResolvedValue(jobDoc({ status: "cancelled" }));

    const res = await post(payload());

    expect(res.status).toBe(200);
    expect(globalThis.fetch).not.toHaveBeenCalled();
    expect(storage.uploadBytes).not.toHaveBeenCalled();
  });
});

/**
 * #159 — THE FALSE BRANCH OF THE CLAIM, DRIVEN ON ITS OWN.
 *
 * The concurrent pair below already reaches this branch — the loser's claim
 * returns false — and pins three of the writes behind it at exactly one: the
 * asset, the job record and the usage row. It says nothing about the other
 * three, because it never asserts on them: the calendar reflow, the daily
 * options assignment and the Task Map sync are not named there at all.
 *
 * So this pair drives ONE delivery whose claim comes back false — the shape a
 * redelivery takes when it slips past the advisory status filter (a stale read,
 * or a settled job whose status write has not landed yet) — and asks the
 * question as "what did it write", not "how many times was it written".
 */
describe("#159 — a delivery that loses the claim writes nothing after it", () => {
  it("answers already-processed and performs no post-claim write at all", async () => {
    (data.claimExternalJobCompletion as any).mockResolvedValue(false);

    const res = await post(payload());

    expect(res.status).toBe(200);
    await expect(res.json()).resolves.toEqual({
      ok: true,
      skipped: true,
      reason: "Already processed",
    });

    // NON-VACUITY, and it is the load-bearing line: this delivery did the whole
    // pre-claim phase (it re-hosted bytes) and REACHED the claim. Without it,
    // every assertion below would also hold for a delivery the advisory status
    // filter turned away hundreds of lines earlier, which is a different gate.
    expect(storage.uploadBytes).toHaveBeenCalled();
    expect(data.claimExternalJobCompletion).toHaveBeenCalledTimes(1);

    // Every persisted side effect the claim is the gate on. Enumerated rather
    // than sampled: the deliverable, the job record, the calendar date, the
    // daily options slice, the board ticket and the cost row are six different
    // writes, and a duplicate of any one of them is a client seeing the same
    // thing twice.
    expect(data.createAsset).not.toHaveBeenCalled();
    expect(data.updateJob).not.toHaveBeenCalled();
    expect(reflowClientChain).not.toHaveBeenCalled();
    expect(syncOptionsFromBatchAsset).not.toHaveBeenCalled();
    expect(syncTaskForJobOutcome).not.toHaveBeenCalled();
    expect(autoCompleteTasksByTrigger).not.toHaveBeenCalled();
    expect(logUsageMock).not.toHaveBeenCalled();
  });

  it("takes the claim BEFORE it creates the deliverable, not after", async () => {
    // The ordering the branch above depends on. If asset creation ever moved
    // above the claim, the test above would still pass — the loser would return
    // early having already written the asset — and two deliveries of one run
    // would put two copies of the same deliverable in a client's library and
    // charge for both.
    const res = await post(payload());
    expect(res.status).toBe(200);

    // Asserted as invocation order rather than as "which appears first in the
    // source", and the counts are pinned first so a NEVER-CALLED mock cannot
    // satisfy the comparison by leaving an undefined on one side of it.
    expect(data.claimExternalJobCompletion).toHaveBeenCalledTimes(1);
    expect(data.createAsset).toHaveBeenCalledTimes(1);
    const claimedAt = (data.claimExternalJobCompletion as any).mock.invocationCallOrder[0];
    const assetAt = (data.createAsset as any).mock.invocationCallOrder[0];
    expect(claimedAt).toBeLessThan(assetAt);
  });
});

describe("#45 — the claim is still the single gate on persistence", () => {
  it("gives one asset, one usage record and one job write to two concurrent deliveries", async () => {
    let claims = 0;
    (data.claimExternalJobCompletion as any).mockImplementation(async () => {
      claims += 1;
      return claims === 1;
    });

    const [a, b] = await Promise.all([post(payload()), post(payload())]);

    const bodies = await Promise.all([a.json(), b.json()]);
    const skipped = bodies.filter((x: any) => x.skipped === true);
    const processed = bodies.filter((x: any) => x.skipped === undefined);
    expect(skipped).toHaveLength(1);
    expect(processed).toHaveLength(1);

    // The loser writes nothing: no second deliverable, no second job record
    // (so no duplicate events), and no second usage/cost row.
    expect(data.createAsset).toHaveBeenCalledTimes(1);
    expect(data.updateJob).toHaveBeenCalledTimes(1);
    expect(logUsageMock).toHaveBeenCalledTimes(1);
    // A successful run moves no credits at all — the refund path is failures only.
    expect(refundJobCharge).not.toHaveBeenCalled();
  });

  it("hands both concurrent deliveries to the claim instead of filtering one out", async () => {
    // The guard on the pre-claim status filter: it must stay an optimisation for
    // settled redeliveries and never become a second gate. Both of these see an
    // in-flight job, so the claim — not the filter — has to be what decides.
    let claims = 0;
    (data.claimExternalJobCompletion as any).mockImplementation(async () => {
      claims += 1;
      return claims === 1;
    });

    await Promise.all([post(payload()), post(payload())]);

    expect(data.claimExternalJobCompletion).toHaveBeenCalledTimes(2);
  });

  it("keeps the two deliveries' uploads on separate paths", async () => {
    // The accepted cost of re-hosting first is orphaned bytes. What is NOT
    // acceptable is the loser overwriting the winner's object: these uploads
    // carry a fresh Firebase download token, so a shared path would invalidate
    // the URL the winner already wrote onto the asset.
    let claims = 0;
    (data.claimExternalJobCompletion as any).mockImplementation(async () => {
      claims += 1;
      return claims === 1;
    });

    await Promise.all([post(payload()), post(payload())]);

    const paths = (storage.uploadBytes as any).mock.calls.map((c: any[]) => c[0].path);
    expect(paths).toHaveLength(4); // 2 client-facing artifacts × 2 deliveries
    expect(new Set(paths).size).toBe(4);
  });
});

describe("#45 — the happy path is unchanged", () => {
  it("attaches every artifact and writes review exactly once", async () => {
    const res = await post(payload());
    expect(res.status).toBe(200);

    expect(data.claimExternalJobCompletion).toHaveBeenCalledTimes(1);
    expect(data.claimExternalJobCompletion).toHaveBeenCalledWith("job-1", "review");

    // The asset carries the re-hosted text and image.
    const asset = (data.createAsset as any).mock.calls[0][0];
    expect(asset.content).toContain("The post the client is paying for");
    expect(asset.imageUrl).toMatch(/^https:\/\/cdn\.test\/agent-service\/job-1\//);
    expect(asset.imageUrl).toMatch(/bbbbbbbbbbbb-slide-1\.png$/);
    // Client-facing only on the asset; all three on the job record.
    expect(asset.meta.artifacts).toHaveLength(2);

    expect(data.updateJob).toHaveBeenCalledTimes(1);
    const jobPatch = (data.updateJob as any).mock.calls[0][1];
    expect(jobPatch.status).toBe("review");
    expect(jobPatch.external.artifacts).toHaveLength(3);
    // Both client-facing artifacts point at our storage, not the service.
    const rehosted = jobPatch.external.artifacts.filter((a: any) =>
      a.url.startsWith("https://cdn.test/"),
    );
    expect(rehosted).toHaveLength(2);
    // The non-client-facing one keeps the service URL — it is never re-hosted.
    const internal = jobPatch.external.artifacts.find((a: any) => a.name === "debug.log");
    expect(internal.url).toBe("https://service.test/debug.log");
  });

  it("still records a failed run's refund and never re-hosts its artifacts", async () => {
    (refundJobCharge as any).mockResolvedValue({ refunded: true, amount: 3 });

    const res = await post(payload({ status: "failed", error: "boom" }));

    expect(res.status).toBe(200);
    expect(refundJobCharge).toHaveBeenCalledTimes(1);
    expect(storage.uploadBytes).not.toHaveBeenCalled();
    expect(data.createAsset).not.toHaveBeenCalled();
    expect(data.claimExternalJobCompletion).toHaveBeenCalledWith("job-1", "failed");
  });
});
