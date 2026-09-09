/* eslint-disable @typescript-eslint/no-explicit-any */
import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * FIVE WAYS A DELIVERY SHIPPED A BROKEN DELIVERABLE (#47, #50, #51, #49).
 *
 * All four questions here are asked of the ASSET the handler writes, because the
 * asset is what a client opens:
 *
 *   #47  Does the asset ever carry an agent-service URL? Those are V4 signed GCS
 *        links with a 7-day TTL, so one on a client's asset plays for a week and
 *        then 403s forever. The re-host was gated on a size budget whose failure
 *        path logged NOTHING and fell through with the service URL intact.
 *   #50  When a carousel arrives short, does anything say so — including which
 *        photo has silently become the cover?
 *   #51  Is "delivered" counted from what ARRIVED, or from what the manifest
 *        claimed? The count was `artifacts.filter(clientFacing).length`, so a
 *        timeout on DRAFTS.md still produced a titled, empty, calendar-dated
 *        asset.
 *   #49  Can the `asset_type` hint make a Reddit reply publishable?
 *
 * The invariant suite at the bottom is the tripwire: it drives EVERY failure mode
 * the re-host has and asserts the same property of each resulting asset, so a new
 * failure path is covered by the shape of the assertion rather than by someone
 * remembering to add a case.
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
vi.mock("@/lib/jobs/launch-outcome", () => ({
  applyLaunchOutcome: vi.fn().mockResolvedValue(undefined),
  isLaunchTemplatesArtifact: () => false,
}));
vi.mock("@/lib/task-sync", () => ({
  autoCompleteTasksByTrigger: vi.fn().mockResolvedValue(undefined),
  syncTaskForJobOutcome: vi.fn().mockResolvedValue(undefined),
  findDispatchingTask: vi.fn().mockResolvedValue(null),
}));
vi.mock("@/lib/job-alerts", () => ({ notifyJobFailure: vi.fn().mockResolvedValue(undefined) }));
vi.mock("@/services/logger", () => ({ logger: { logUsage: vi.fn() } }));

import * as data from "@/lib/data";
import * as storage from "@/lib/storage";
import { refundJobCharge } from "@/lib/credit-reconcile";
import { REHOST_DEADLINE_MS } from "@/lib/agent-service/rehost-budget";

process.env.AGENT_WEBHOOK_SECRET = "test-secret";

/** `isJobInFlight` is pure; automocked it reads as "terminal" and blocks every delivery. */
const realData = await vi.importActual<typeof import("@/lib/data")>("@/lib/data");

const SERVICE = "https://service.test";
const DRAFTS_MD = "# LinkedIn drafts\n\n> The post the client is paying for.\n";
const PNG = "\x89PNG-bytes";
const MB = 1024 * 1024;

function jobDoc(overrides: Record<string, any> = {}) {
  return {
    id: "job-1",
    clientId: "c1",
    agentId: "agent-service",
    agentName: "LinkedIn Agent",
    title: "LinkedIn Agent - Acme",
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

type ArtifactSpec = { name: string; bytes?: number; contentType?: string; clientFacing?: boolean; url?: string };

function artifact(spec: ArtifactSpec) {
  const name = spec.name;
  return {
    name,
    path: name,
    bytes: spec.bytes ?? 32,
    sha256: name.replace(/\W/g, "").padEnd(16, "z").slice(0, 16),
    content_type: spec.contentType ?? (name.endsWith(".png") ? "image/png" : "text/markdown"),
    client_facing: spec.clientFacing ?? true,
    url: spec.url === undefined ? `${SERVICE}/${name}` : spec.url,
  };
}

function payload(artifacts: ArtifactSpec[], overrides: Record<string, any> = {}) {
  return {
    event: "job.completed",
    job_id: "svc-1",
    status: "done",
    task_type: "custom",
    client_id: "c1",
    artifacts: artifacts.map(artifact),
    usage: { totalCostUsd: 0.1, models: {} },
    attempt: 0,
    ...overrides,
  };
}

async function deliver(body: Record<string, any>) {
  const { POST } = await import("@/app/api/agent-service/webhook/route");
  const req = new Request("https://portal.test/api/agent-service/webhook", {
    method: "POST",
    headers: { "x-signature": "sig", "x-timestamp": "1", "content-type": "application/json" },
    body: JSON.stringify(body),
  });
  return POST(req as any);
}

/** A server that answers every artifact, unless the URL is in `failing`. */
function serve(opts: { failing?: Record<string, number>; throwing?: string[] } = {}) {
  return vi.fn().mockImplementation(async (url: string) => {
    if (opts.throwing?.some((n) => url.endsWith(n))) throw new Error("socket hang up");
    const failure = Object.entries(opts.failing ?? {}).find(([name]) => url.endsWith(name));
    const body = url.endsWith(".png") ? PNG : DRAFTS_MD;
    return {
      ok: !failure,
      status: failure ? failure[1] : 200,
      headers: new Headers(),
      arrayBuffer: async () => new TextEncoder().encode(body).buffer,
      text: async () => body,
    };
  });
}

const createdAsset = () => (data.createAsset as any).mock.calls[0]?.[0];
const jobEvents = (): Array<{ level: string; message: string }> =>
  ((data.updateJob as any).mock.calls[0]?.[1]?.events ?? []) as Array<{ level: string; message: string }>;
const eventText = () => jobEvents().map((e) => e.message).join("\n");

/** Every string anywhere inside a value — the asset is checked as a whole. */
function strings(value: unknown, out: string[] = []): string[] {
  if (typeof value === "string") out.push(value);
  else if (Array.isArray(value)) value.forEach((v) => strings(v, out));
  else if (value && typeof value === "object") Object.values(value).forEach((v) => strings(v, out));
  return out;
}

beforeEach(() => {
  vi.clearAllMocks();
  vi.stubGlobal("fetch", serve());
  (storage.uploadBytes as any).mockImplementation(async ({ path }: { path: string }) => ({
    url: `https://cdn.test/${path}`,
    path,
  }));
  (data.isJobInFlight as any).mockImplementation(realData.isJobInFlight);
  (data.getJobByExternalServiceId as any).mockResolvedValue(jobDoc());
  (data.claimExternalJobCompletion as any).mockResolvedValue(true);
  (data.createAsset as any).mockResolvedValue("asset-1");
  (data.updateJob as any).mockResolvedValue(undefined);
  (data.getClient as any).mockResolvedValue({ id: "c1", name: "Acme" });
});

describe("#47 — the size-capped path is as loud as the error path, and never ships a dying URL", () => {
  it("names the file, its size and the limit when a clip is too big to copy", async () => {
    // 30 MB > the 25 MB per-file limit. This is the path that logged nothing at
    // all: the clip stayed on the asset with its service URL and 403'd a week
    // later, with no line anywhere saying why.
    await deliver(payload([{ name: "DRAFTS.md" }, { name: "clip.mp4", bytes: 30 * MB, contentType: "video/mp4" }]));

    expect(eventText()).toMatch(/Could not re-host clip\.mp4/);
    expect(eventText()).toMatch(/30 MB, past the 25 MB per-file limit/);
    // The size rounds UP and the limit is exact, so the two can never render as
    // the same number: `Math.round` on both halves made every file between 25.0
    // and 25.5 MB log "it is 25 MB, past the 25 MB per-file limit".
    expect(eventText()).not.toMatch(/(\d+) MB, past the \1 MB/);
    // The one-line total says the run was short, instead of reading as clean.
    expect(eventText()).toMatch(/1 client-facing deliverable\(s\) attached/);
    expect(eventText()).toMatch(/1 could not be re-hosted/);
  });

  /**
   * THE BOUNDARY, which is the only place the defect was visible. `Math.round` on
   * both the size and the limit made every file between 25.0 and 25.5 MB log
   * "it is 25 MB, past the 25 MB per-file limit" — the sentence a staff member
   * reads to decide whether to raise the cap, contradicting itself. A 30 MB
   * fixture cannot see it: 30 and 25 differ under any rounding.
   */
  it("never logs a size equal to the limit it says was exceeded", async () => {
    await deliver(
      payload([
        { name: "DRAFTS.md" },
        { name: "just-over.mp4", bytes: Math.round(25.4 * MB), contentType: "video/mp4" },
      ]),
    );

    expect(eventText()).toMatch(/Could not re-host just-over\.mp4/);
    expect(eventText()).not.toMatch(/25 MB, past the 25 MB/);
    // Rounded up, so it reads as genuinely past the cap.
    expect(eventText()).toMatch(/26 MB, past the 25 MB per-file limit/);
  });

  it("keeps the un-copied clip off the client's asset and on the run record", async () => {
    await deliver(payload([{ name: "DRAFTS.md" }, { name: "clip.mp4", bytes: 30 * MB, contentType: "video/mp4" }]));

    // The asset carries the copied text only — no service URL for assetVideos to
    // hand a client, which is the whole of #47.
    const asset = createdAsset();
    expect(asset.meta.artifacts.map((a: any) => a.name)).toEqual(["DRAFTS.md"]);
    expect(strings(asset).filter((s) => s.includes(SERVICE))).toEqual([]);

    // …and the remedy the fix must not take with it: staff can still fetch the
    // file from the job page while its link lives.
    const jobPatch = (data.updateJob as any).mock.calls[0][1];
    const clip = jobPatch.external.artifacts.find((a: any) => a.name === "clip.mp4");
    expect(clip.url).toBe(`${SERVICE}/clip.mp4`);
    expect(clip.clientFacing).toBe(true);
  });

  it("reports the run-total limit separately from the per-file one", async () => {
    // Eight 20 MB files, each inside the 25 MB per-file cap: the run cap (150 MB)
    // trips on the eighth. A different reason from the per-file one, and it used
    // to be just as silent.
    //
    // The bodies really are 20 MB, because the running total is accumulated from
    // the bytes ACTUALLY read while the pre-fetch check adds the DECLARED size —
    // an asymmetry this test had to work with rather than around. (It is the
    // conservative direction for the pre-fetch check, which is what keeps a
    // 400 MB clip from being pulled into memory at all.)
    vi.stubGlobal(
      "fetch",
      vi.fn().mockImplementation(async () => ({
        ok: true,
        status: 200,
        headers: new Headers(),
        arrayBuffer: async () => new ArrayBuffer(20 * MB),
      })),
    );

    await deliver(
      payload(
        ["a", "b", "c", "d", "e", "f", "g", "h"].map((n) => ({ name: `${n}.md`, bytes: 20 * MB })),
      ),
    );

    expect(eventText()).toMatch(/Could not re-host h\.md/);
    // Names why THIS file was refused rather than only how full the run is:
    // "already copied 149 MB of its 150 MB limit" reads as though there was room.
    expect(eventText()).toMatch(/would take it past its 150 MB limit/);
  });

  it("says so when the service sends a client-facing artifact with no URL", async () => {
    await deliver(payload([{ name: "DRAFTS.md" }, { name: "ghost.md", url: "" }]));
    expect(eventText()).toMatch(/Could not re-host ghost\.md - the service sent no download URL/);
  });
});

describe("#51 — 'delivered' counts what arrived, not what the manifest claimed", () => {
  it("creates no asset and refunds when every client-facing file fails to copy", async () => {
    vi.stubGlobal("fetch", serve({ failing: { "DRAFTS.md": 504 } }));

    const res = await deliver(payload([{ name: "DRAFTS.md" }]));

    expect(res.status).toBe(200);
    // The old gate counted the manifest, so this wrote a titled asset with an
    // empty body, an orderKey and a place on the calendar.
    expect(data.createAsset).not.toHaveBeenCalled();
    expect((refundJobCharge as any).mock.calls[0][1]).toMatch(/no deliverables/);
    // And the log does not claim the run produced nothing — it produced a file we
    // could not copy, which is a different sentence.
    expect(eventText()).toMatch(/none of them could be copied into platform storage/);
  });

  it("still delivers an image-only run, whose empty body is a real state", async () => {
    // The counterweight (task-sync.ts on `artifact: ""`): a run with an image and
    // no primary text IS a delivery, so a gate keyed to "has text" would have
    // refunded and deleted every image-only run's deliverable.
    await deliver(payload([{ name: "slide-1.png" }]));

    const asset = createdAsset();
    expect(asset.content).toBe("");
    expect(asset.imageUrl).toMatch(/^https:\/\/cdn\.test\//);
    expect(refundJobCharge).not.toHaveBeenCalled();
  });

  it("delivers a run whose text failed but whose image landed, and says the text is missing", async () => {
    vi.stubGlobal("fetch", serve({ failing: { "DRAFTS.md": 500 } }));

    await deliver(payload([{ name: "DRAFTS.md" }, { name: "slide-1.png" }]));

    const asset = createdAsset();
    expect(asset.content).toBe("");
    expect(asset.meta.artifacts.map((a: any) => a.name)).toEqual(["slide-1.png"]);
    expect(eventText()).toMatch(/Could not re-host DRAFTS\.md - the service answered HTTP 500/);
  });

  it("counts a PDF-only run as delivered", async () => {
    // Neither text nor image: the asset exists for the attachment, and the
    // count has to agree with that.
    await deliver(payload([{ name: "brief.pdf", contentType: "application/pdf" }]));
    expect(createdAsset().meta.artifacts.map((a: any) => a.name)).toEqual(["brief.pdf"]);
    expect(eventText()).toMatch(/1 client-facing deliverable\(s\) attached/);
  });
});

describe("#50 — a short carousel says so, and names its new cover", () => {
  it("reports the missing slide and which photo is now the cover", async () => {
    vi.stubGlobal("fetch", serve({ failing: { "slide-1.png": 404 } }));

    await deliver(
      payload([{ name: "slide-1.png" }, { name: "slide-2.png" }, { name: "slide-3.png" }]),
    );

    // The cover really did move — that is the silent half of the finding.
    expect(createdAsset().imageUrl).toMatch(/slide-2\.png$/);
    expect(eventText()).toMatch(/Carousel is short 1 photo\(s\) \(slide-1\.png\)/);
    expect(eventText()).toMatch(/the cover is now slide-2\.png/);
  });

  it("leaves no dying URL in the slide list of a partial carousel", async () => {
    vi.stubGlobal("fetch", serve({ throwing: ["slide-2.png"] }));

    await deliver(
      payload([{ name: "slide-1.png" }, { name: "slide-2.png" }, { name: "slide-3.png" }]),
    );

    const asset = createdAsset();
    expect(asset.meta.slides.map((s: any) => s.imageUrl)).toHaveLength(2);
    expect(strings(asset).filter((s) => s.includes(SERVICE))).toEqual([]);
    expect(eventText()).toMatch(/Could not re-host slide-2\.png - the transfer failed/);
  });

  it("says nothing about a carousel that arrived whole", async () => {
    await deliver(payload([{ name: "slide-1.png" }, { name: "slide-2.png" }]));
    expect(eventText()).not.toMatch(/Carousel is short/);
    expect(eventText()).not.toMatch(/could not be re-hosted/);
    expect(jobEvents().some((e) => e.level === "success")).toBe(true);
  });
});

/**
 * THE TRIPWIRE. One property — no client-facing asset may carry a URL we did not
 * re-host — asked of every failure mode the re-host has, driven from a table so a
 * sixth mode is a row rather than a new test nobody writes.
 */
describe("the invariant: an asset never carries an un-re-hosted service URL", () => {
  const MODES: Array<{ mode: string; artifacts: ArtifactSpec[]; fetch?: () => any; upload?: () => any }> = [
    {
      mode: "over the per-file size cap",
      artifacts: [{ name: "slide-1.png" }, { name: "clip.mp4", bytes: 40 * MB, contentType: "video/mp4" }],
    },
    {
      mode: "HTTP error from the service",
      artifacts: [{ name: "slide-1.png" }, { name: "slide-2.png" }],
      fetch: () => serve({ failing: { "slide-2.png": 403 } }),
    },
    {
      mode: "the fetch throws",
      artifacts: [{ name: "slide-1.png" }, { name: "slide-2.png" }],
      fetch: () => serve({ throwing: ["slide-2.png"] }),
    },
    {
      mode: "the upload throws",
      artifacts: [{ name: "slide-1.png" }, { name: "slide-2.png" }],
      upload: () =>
        vi.fn().mockImplementation(async ({ path }: { path: string }) => {
          if (path.endsWith("slide-2.png")) throw new Error("storage unavailable");
          return { url: `https://cdn.test/${path}`, path };
        }),
    },
    {
      mode: "no URL on the artifact",
      artifacts: [{ name: "slide-1.png" }, { name: "orphan.png", url: "" }],
    },
  ];

  for (const { mode, artifacts, fetch: fetchFor, upload } of MODES) {
    it(`holds when: ${mode}`, async () => {
      if (fetchFor) vi.stubGlobal("fetch", fetchFor());
      if (upload) (storage.uploadBytes as any).mockImplementation(upload());

      await deliver(payload(artifacts));

      const asset = createdAsset();
      // Non-vacuity: an asset WAS written (one artifact always succeeds), so the
      // negative below is held over a real document.
      expect(asset, `${mode} created no asset at all`).toBeTruthy();
      expect(
        strings(asset).filter((s) => s.includes(SERVICE)),
        `${mode} left a service URL on the client's asset`,
      ).toEqual([]);
      // And every failure mode is reported, not just the ones with a log line.
      expect(eventText(), `${mode} was silent`).toMatch(/Could not re-host/);
    });
  }

  it("re-hosts and attaches everything when nothing fails", async () => {
    // The counterweight to the whole suite: if the handler simply stopped
    // attaching artifacts, every assertion above would pass.
    await deliver(payload([{ name: "DRAFTS.md" }, { name: "slide-1.png" }, { name: "internal.log", clientFacing: false }]));

    const asset = createdAsset();
    expect(asset.meta.artifacts.map((a: any) => a.name)).toEqual(["DRAFTS.md", "slide-1.png"]);
    expect(asset.content).toContain("The post the client is paying for");
    expect(eventText()).not.toMatch(/Could not re-host/);
  });
});

describe("#49 — the asset_type hint cannot make a Reddit reply publishable", () => {
  const REDDIT_BATCH = "# Reddit answer drafts\n\n## Account 1 · u/acme\n\n### Direct answer\n\n> Hello.\n";

  it("lands a Reddit reply as a library note even when the run asked for social_post", async () => {
    // The live shape: a scheduled Reddit run whose schedule row says social_post.
    // Typed social_post, the reply is offered on every publish surface and the
    // auto-publish cron pushes it to whichever of twitter/linkedin/tiktok
    // is connected — a reply written for one thread, cross-posted to four feeds.
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue({
        ok: true,
        status: 200,
        headers: new Headers(),
        arrayBuffer: async () => new TextEncoder().encode(REDDIT_BATCH).buffer,
        text: async () => REDDIT_BATCH,
      }),
    );
    (data.getJobByExternalServiceId as any).mockResolvedValue(
      jobDoc({ agentName: "Reddit Answer Agent", title: "Reddit Answer Agent - Acme" }),
    );

    await deliver(
      payload([{ name: "DRAFTS.md" }], {
        metadata: { asset_type: "social_post", platform: "reddit", karos_agent_key: "karos-reddit-agent" },
      }),
    );

    expect(createdAsset().type).toBe("note");
  });

  it("still honours the hint for a LinkedIn run", async () => {
    await deliver(
      payload([{ name: "DRAFTS.md" }], {
        metadata: { asset_type: "social_post", platform: "linkedin", karos_agent_key: "karos-linkedin-agent" },
      }),
    );
    expect(createdAsset().type).toBe("social_post");
  });
});

describe("the pre-claim budget is unchanged by all of this", () => {
  it("still fails the delivery for retry rather than half-delivering on a spent budget", async () => {
    // The #45 contract: nothing is claimed and nothing is written when the
    // re-host phase runs past its deadline. Asserted here because the new
    // per-artifact accounting sits inside that same loop.
    vi.useFakeTimers();
    vi.setSystemTime(Date.parse("2026-08-01T09:00:00Z"));
    vi.spyOn(AbortSignal, "timeout").mockImplementation(((ms: number) => {
      const controller = new AbortController();
      setTimeout(() => controller.abort(new Error("aborted")), ms);
      return controller.signal;
    }) as typeof AbortSignal.timeout);
    vi.stubGlobal(
      "fetch",
      vi.fn().mockImplementation(async (_url: string, init: RequestInit) => {
        await new Promise<void>((resolve, reject) => {
          const timer = setTimeout(resolve, 40_000);
          init.signal?.addEventListener("abort", () => {
            clearTimeout(timer);
            reject(Object.assign(new Error("aborted"), { name: "TimeoutError" }));
          });
        });
        return { ok: true, status: 200, headers: new Headers(), arrayBuffer: async () => new ArrayBuffer(0) };
      }),
    );

    const body = payload([
      { name: "a.md" },
      { name: "b.md" },
      { name: "c.md" },
      { name: "d.md" },
    ]);
    let response: Response | null = null;
    const pending = deliver(body).then((r) => {
      response = r;
    });
    for (let t = 0; t < REHOST_DEADLINE_MS + 60_000 && response === null; t += 500) {
      await vi.advanceTimersByTimeAsync(500);
    }
    await pending;

    expect((response as unknown as Response).status).toBe(503);
    expect(data.claimExternalJobCompletion).not.toHaveBeenCalled();
    expect(data.createAsset).not.toHaveBeenCalled();
    vi.useRealTimers();
    vi.restoreAllMocks();
  });
});
