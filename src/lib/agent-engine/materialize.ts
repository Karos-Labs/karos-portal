import "server-only";
import { createAsset, updateJob } from "@/lib/data";
import { uploadBytes } from "@/lib/storage";
import { reflowClientChain } from "@/lib/chain";
import { orderKeyForCreatedAt } from "@/lib/post-chain";
import { recommendedScheduleFields } from "@/lib/scheduling";
import { deliverableAssetType } from "@/lib/agent-service/deliverable-asset-type";
import { getAgentEngineDeliverable } from "./client";
import type { Job, WireTaskType } from "@/lib/types";

/**
 * Task 3 — asset materialization for a completed agent-engine run.
 *
 * `syncAgentEngineJobStatusFromView` (reconcile.ts) only ever flips
 * `job.status`; it has no equivalent of the legacy agent-service webhook's
 * artifact-rehost + `createAsset` + `reflowClientChain` pipeline (see that
 * webhook's own doc comments — one generic pipeline, no per-task-type
 * branching). This module is that pipeline's agent-engine-sourced
 * counterpart, scoped to the only two product ids that currently have a
 * known deliverable shape at all: `instagram-agent`/`branded-shorts-agent`
 * (`ledger.writeDeliverable`'s `instagram-carousel`/`branded-shorts-video`
 * kinds) and `landing-builder-agent` (`landing-page-site`). Any other
 * product id (a custom agent, a dynamic-agent smoke test, a future channel
 * not wired here yet) is a deliberate no-op — the job still reaches
 * `status: "review"` via reconcile.ts, it just has no library asset,
 * exactly matching a custom-agent job that produces something this portal
 * has no rendering for.
 */

/** Kinds this module knows how to turn into a real karosCMO asset. Absent from this map ⇒ no known deliverable shape yet, not an error. */
const DELIVERABLE_KIND_BY_PRODUCT: Record<string, string> = {
  "instagram-agent": "instagram-carousel",
  "branded-shorts-agent": "branded-shorts-video",
  "landing-builder-agent": "landing-page-site",
};

/**
 * The `WireTaskType` each agent-engine product id maps onto — NOT its own
 * separate asset-type derivation. The actual `AssetType` is always resolved
 * through `deliverableAssetType()` (see `materializeAgentEngineDeliverable`),
 * the one shared point every runtime-derived asset type in this codebase is
 * required to go through (platforms-publishable.test.ts's own governance
 * scan) — inventing a second, agent-engine-local mapping here would be
 * exactly the "fourth unreviewed derivation" that scan exists to catch.
 */
const WIRE_TASK_TYPE_BY_PRODUCT: Record<string, WireTaskType> = {
  "instagram-agent": "social_post",
  "branded-shorts-agent": "social_post",
  "landing-builder-agent": "landing_page",
};

interface AssetMaterialization {
  title: string;
  content: string;
  imageUrl?: string | null;
  videoUrl?: string | null;
  channels?: string[];
  meta: Record<string, unknown>;
}

/**
 * Re-hosts one agent-engine-produced file into karosCMO's own storage, the
 * same reason the legacy webhook never puts a foreign URL on a client-facing
 * asset directly: agent-engine's own signed URLs expire (7 days, V4 signing's
 * own maximum) and point at a bucket this portal doesn't control access to
 * long-term. Only a `path` that's actually an `https://` signed URL is
 * fetchable at all — a bare `gs://` URI (signing unavailable) or a local
 * filesystem path (no media store configured on agent-engine's side) is
 * skipped, loudly, rather than silently producing an asset with no image.
 */
async function rehostIfFetchable(path: string | undefined, objectPath: string, contentType: string): Promise<string | undefined> {
  if (!path || !path.startsWith("https://")) {
    if (path) console.error(`[agent-engine materialize] artifact at "${path}" is not a fetchable signed URL — skipping rehost, asset will have no media for it`);
    return undefined;
  }
  const res = await fetch(path, { signal: AbortSignal.timeout(30_000) });
  if (!res.ok) {
    console.error(`[agent-engine materialize] failed to fetch artifact (${res.status}): ${path}`);
    return undefined;
  }
  const bytes = Buffer.from(await res.arrayBuffer());
  const { url } = await uploadBytes({ bytes, path: objectPath, contentType });
  return url;
}

interface InstagramCarouselDeliverable {
  postId?: string;
  topic?: string;
  slides?: Array<{ n: number; caption?: string }>;
  rendered?: Array<{ n: number; path: string; gcsUri?: string }>;
}

async function materializeInstagramCarousel(job: Job, deliverable: InstagramCarouselDeliverable): Promise<AssetMaterialization> {
  const rendered = deliverable.rendered ?? [];
  const first = rendered[0];
  const imageUrl = first ? await rehostIfFetchable(first.path, `agent-engine/${job.id}/slide-${first.n}.png`, "image/png") : undefined;
  return {
    title: deliverable.topic ?? "Instagram post",
    content: deliverable.topic ?? "",
    imageUrl: imageUrl ?? null,
    channels: ["instagram"],
    meta: {
      taskType: "social_post",
      postId: deliverable.postId,
      slideCount: rendered.length,
      artifacts: rendered.map((r) => ({ n: r.n, gcsUri: r.gcsUri })),
    },
  };
}

interface BrandedShortsVideoDeliverable {
  gcsUri?: string;
  signedUrl?: string;
  durationSeconds?: number;
}

async function materializeBrandedShortsVideo(job: Job, deliverable: BrandedShortsVideoDeliverable): Promise<AssetMaterialization> {
  const videoUrl = await rehostIfFetchable(deliverable.signedUrl, `agent-engine/${job.id}/final.mp4`, "video/mp4");
  return {
    title: "TikTok video",
    content: "",
    videoUrl: videoUrl ?? null,
    channels: ["tiktok"],
    meta: {
      taskType: "social_post",
      durationSeconds: deliverable.durationSeconds,
      artifacts: deliverable.gcsUri ? [{ gcsUri: deliverable.gcsUri }] : [],
    },
  };
}

interface LandingPageSiteDeliverable {
  gcsPrefix?: string;
  fileCount?: number;
  status?: string;
}

/**
 * No landing-page-bundle concept exists anywhere in `Asset` today (confirmed:
 * the legacy webhook has zero special-casing for `landing_page` either — it
 * lands as a slot-less `"note"`, same as here). `gcsPrefix` is a directory
 * tree, not a single fetchable URL, so there is nothing to rehost — the
 * asset's `content` names where the reviewed source tree lives, and staff
 * retrieve it out-of-band until a real bundle/preview concept exists on
 * either side.
 */
function materializeLandingPageSite(deliverable: LandingPageSiteDeliverable): AssetMaterialization {
  return {
    title: "Landing page",
    content: deliverable.gcsPrefix
      ? `Site source (${deliverable.fileCount ?? "?"} files) uploaded to ${deliverable.gcsPrefix}`
      : "Landing page build completed — no site bundle was uploaded (GCS_ARTIFACTS_BUCKET not configured on agent-engine).",
    meta: { taskType: "landing_page", gcsPrefix: deliverable.gcsPrefix, fileCount: deliverable.fileCount, buildStatus: deliverable.status },
  };
}

async function buildMaterialization(job: Job, productId: string, deliverable: unknown): Promise<AssetMaterialization | undefined> {
  switch (productId) {
    case "instagram-agent":
      return materializeInstagramCarousel(job, deliverable as InstagramCarouselDeliverable);
    case "branded-shorts-agent":
      return materializeBrandedShortsVideo(job, deliverable as BrandedShortsVideoDeliverable);
    case "landing-builder-agent":
      return materializeLandingPageSite(deliverable as LandingPageSiteDeliverable);
    default:
      return undefined;
  }
}

/**
 * Fetches a completed run's deliverable, rehosts its media, creates the
 * karosCMO asset, attaches it to the job, and reflows the client's calendar
 * chain — the Task 3 counterpart to the legacy webhook's own pipeline.
 * Idempotent by the same convention `dispatchAgentEngineRun` already
 * establishes (a freshly dispatched job starts with `assetIds: []`): a job
 * that already has at least one asset is treated as already materialized
 * (or as a job type this module was never meant to touch), and this is a
 * pure no-op. Returns the new asset id, or `undefined` when nothing was
 * materialized (no known deliverable shape, deliverable not found yet, or
 * already materialized) — never throws, since a materialization failure
 * must not block the job from reaching `status: "review"`.
 */
export async function materializeAgentEngineDeliverable(job: Job): Promise<string | undefined> {
  if (!job.agentEngineRunId || !job.agentEngineProductId) return undefined;
  if (job.assetIds.length > 0) return undefined;

  const kind = DELIVERABLE_KIND_BY_PRODUCT[job.agentEngineProductId];
  if (!kind) return undefined;

  try {
    const deliverable = await getAgentEngineDeliverable(job.agentEngineRunId, kind);
    if (!deliverable) return undefined;

    const materialization = await buildMaterialization(job, job.agentEngineProductId, deliverable);
    if (!materialization) return undefined;

    // The one shared point every runtime-derived asset type in this codebase goes
    // through (platforms-publishable.test.ts's own governance scan, PINNED_DERIVATIONS)
    // — applies the Reddit draft-only fence unconditionally, exactly as the webhook and
    // MCP upload_asset paths already do. None of this module's three products are ever
    // Reddit, but the fence costs nothing to apply and a future fourth product might be.
    const assetType = deliverableAssetType({
      taskType: WIRE_TASK_TYPE_BY_PRODUCT[job.agentEngineProductId]!,
      content: materialization.content,
      identity: [job.agentEngineProductId],
    });

    const now = Date.now();
    const assetId = await createAsset({
      clientId: job.clientId,
      jobId: job.id,
      agentId: "agent-engine",
      type: assetType,
      title: materialization.title,
      content: materialization.content,
      meta: { ...materialization.meta, agentEngineRunId: job.agentEngineRunId, agentEngineProductId: job.agentEngineProductId },
      imageUrl: materialization.imageUrl ?? null,
      ...(materialization.videoUrl ? { videoUrl: materialization.videoUrl } : {}),
      ...(materialization.channels ? { channels: materialization.channels } : {}),
      status: "draft",
      orderKey: orderKeyForCreatedAt(now, job.id),
      ...recommendedScheduleFields(assetType, 0, materialization.channels?.[0]),
      createdBy: "agent-engine",
      createdAt: now,
      updatedAt: now,
    });

    await updateJob(job.id, { assetIds: [...job.assetIds, assetId], updatedAt: Date.now() });

    // Best-effort, same as the legacy webhook's own reflow call: the job already has its
    // asset and its "review" status regardless of whether the calendar slot lands.
    await reflowClientChain(job.clientId).catch((e: unknown) => {
      console.error(`[agent-engine materialize] calendar reflow failed for client "${job.clientId}" — run the staff reflow action`, e);
    });

    return assetId;
  } catch (e) {
    console.error(`[agent-engine materialize] failed to materialize deliverable for job "${job.id}" (run "${job.agentEngineRunId}")`, e);
    return undefined;
  }
}
