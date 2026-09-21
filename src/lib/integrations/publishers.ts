/**
 * Platform publishers — the single place that talks to social-network APIs.
 * Used by both the publish cron (/api/publish, auto mode) and the
 * "Publish Now" server action (manual mode). Server-only.
 */

import type { Asset, ClientIntegration } from "@/lib/types";
import { assetImages, assetVideos } from "@/lib/asset-images";
import { PUBLISHABLE_PLATFORMS, platformLabel } from "@/lib/integrations/platforms";
import { metaGraphUrl, metaInstagramGraphUrl } from "@/lib/integrations/meta-graph";

/**
 * Thrown when a platform API returns HTTP 401 or 403.
 * Callers catch this specifically to mark the integration expired
 * rather than retrying indefinitely with a dead token.
 */
export class TokenExpiredError extends Error {
  constructor(platform: string, httpStatus: number) {
    super(`${platform} token expired or revoked (HTTP ${httpStatus})`);
    this.name = "TokenExpiredError";
  }
}

/** First connected platform compatible with the asset type, or null. */
export function inferPlatform(assetType: string, connectedPlatforms: string[]): string | null {
  const candidates = PUBLISHABLE_PLATFORMS[assetType] ?? [];
  return candidates.find((p) => connectedPlatforms.includes(p)) ?? null;
}

/**
 * Result of a successful publish. `postId` is the platform's own id for the new
 * post when the API returns one (captured for later metrics fetching); null when
 * the platform doesn't return one or we couldn't parse it.
 */
export interface PublishResult {
  postId: string | null;
}

/* ── What a publisher may read off an asset (finding #48) ─────────────── */

/** A URL whose extension says video, whatever field it is stored in. */
const VIDEO_URL = /\.(mp4|mov|webm|m4v)(\?|$)/i;

/**
 * THE clip on an asset, asked through the same helper the card, the detail modal
 * and the download route ask — `assetVideos`, which knows all four places a clip
 * can live (`asset.videoUrl`, `meta.videos`, `meta.files`, `meta.artifacts`).
 *
 * This is finding #48. `publishToTikTok` read `asset.imageUrl` and its comment
 * asserted "the media URL rides on asset.imageUrl", while the bulk-upload route —
 * the only writer of `asset.videoUrl` in the tree, and the path that channels its
 * clips to TikTok — sets `videoUrl` and never `imageUrl`. So every bulk-uploaded
 * clip failed its scheduled publish with "TikTok posts require a video file", the
 * one shape TikTok exists for. (A webhook run can also land on the TikTok channel
 * via its platform hint; its clip is a `meta.artifacts` entry, which the old read
 * missed just as completely.)
 *
 * The imageUrl fallback is kept rather than deleted: a generated payload really can
 * carry its clip there, and dropping it would take that remedy away with the fix.
 * It is gated on the URL or the mime type actually looking like video, so a photo
 * post can never be handed to a video publisher.
 *
 * STATED RESIDUAL, because this fixes the READ and not the URL's lifetime: a
 * bulk-uploaded clip's `videoUrl` is a V4 signed GCS link minted at upload with a
 * 7-day TTL, and `bulkScheduleClipsAction` spreads a batch one clip per day over
 * weeks — so a clip scheduled beyond that window hands `publishToTikTok` a URL
 * that has expired. `assetVideoSrc` solves the same problem for playback by
 * re-signing per request from `meta.gcsPath`, but that route is
 * session-authorized, and reusing it here is still not attempted in this change
 * — now more because it would mean writing and testing a new server-to-server
 * re-sign path than because of who was doing the fetching. That obstacle did
 * used to be sharper: TikTok itself fetched the URL anonymously under
 * PULL_FROM_URL (see below), which ruled out any session-bound route outright.
 * Now that `publishToTikTok` reads the clip's bytes on our own server (FILE_UPLOAD,
 * 2026-09-20), that specific obstacle is gone — this residual is next up, not
 * closed.
 *
 * WHAT IS NOT CLAIMED ABOUT REACHING IT. This note used to say the whole path was
 * "unreachable in production today" on the strength of
 * PENDING_VERIFICATION_PLATFORM_IDS, and that set does not carry the weight: it
 * withholds the OAuth Connect button on the Integrations card (`!isConnected &&`
 * there, integrations-tab.tsx) and nothing else. The admin "Manual credentials"
 * accordion on that same card saves credentials for ANY platform in the registry,
 * tiktok included, so a tiktok integration can exist today and this function can
 * run against it. What the code used to say about the failure, until 2026-09-20,
 * was right below in `publishToTikTok`: PULL_FROM_URL made TikTok fetch this URL
 * itself, and TikTok answers an unverified source domain with an HTTP 200 whose
 * body carries an error code (`url_ownership_unverified`) — unavoidable, since
 * these clip URLs resolve to storage.googleapis.com, a domain nobody outside
 * Google can verify. `publishToTikTok` now uploads the bytes directly
 * (FILE_UPLOAD) instead of naming a URL for TikTok to fetch, which is what
 * finally lets a real publish complete end to end — and with it, lets the
 * expiry residual above actually get hit rather than staying theoretical.
 */
function clipUrl(asset: Asset): string | null {
  const clip = assetVideos(asset)[0]?.url;
  if (clip) return clip;
  const looksLikeVideo =
    (asset.mimeType?.startsWith("video/") ?? false) || VIDEO_URL.test(asset.imageUrl ?? "");
  return asset.imageUrl && looksLikeVideo ? asset.imageUrl : null;
}

/**
 * THE photo on an asset — `assetImages`, so a post whose photos landed in
 * `meta.files` / `meta.slides` (every lab import, every webhook carousel) is no
 * longer invisible to the publishers, which read the bare `asset.imageUrl` cover.
 *
 * A video URL is never a photo: `assetImages` returns `asset.imageUrl` unfiltered
 * as its last resort, and for the legacy payloads described above that field can
 * hold an .mp4 — which Instagram's image_url would then reject with a Meta error
 * instead of the reason.
 */
function photoUrl(asset: Asset): string | null {
  const photo = assetImages(asset)[0]?.url;
  return photo && !VIDEO_URL.test(photo) ? photo : null;
}

/**
 * A clip the asset IS, as against a clip it merely CARRIES.
 *
 * `asset.videoUrl` is the field that means "this asset is a clip" — the bulk-upload
 * dropzone is its only writer — and a run whose only payload is a video says the
 * same thing by having no text. A video sitting in `meta.artifacts` BESIDE a
 * written post is neither: it is an attachment the LinkedIn per-draft reader offers
 * a human (assetLiMedia accepts mp4/mov/webm for exactly that), and refusing to
 * publish the written post over it would take a working path away in order to fix a
 * different one.
 *
 * STATED RESIDUAL, because that is where this line leaves things: a written post
 * carrying an attached clip still publishes as text and drops the attachment
 * silently, exactly as before. Naming it is not the same as fixing it.
 */
function isClipDeliverable(asset: Asset): boolean {
  if (asset.videoUrl) return true;
  return Boolean(clipUrl(asset)) && asset.content.trim() === "";
}

/**
 * The precondition shared by the THREE TEXT-FIRST publishers (X, LinkedIn,
 * Facebook): they post `asset.content`, and none of them uploads a clip.
 *
 * Both refusals here are the same defect as #48 seen from the other side — a
 * publisher silently doing something other than delivering the asset:
 *
 *  • NOTHING TO POST. A bulk-uploaded clip has `content: ""`, and
 *    `PUBLISHABLE_PLATFORMS.social_post` lists twitter FIRST, so the auto-publish
 *    cron's `inferPlatform` hands exactly that asset to X. The old code sliced the
 *    empty string and posted it: an empty tweet at best, an unexplained 400 in
 *    practice, and for Facebook an empty page post that really does go out.
 *  • A CLIP THAT WOULD BE DROPPED. The asset's whole deliverable is the video;
 *    posting its caption alone is not a smaller version of that, it is a different
 *    post. Refusing leaves the asset scheduled and retryable with the reason on it,
 *    which a human can act on.
 *
 * DELIBERATELY NOT SYMMETRIC for photos, and this is the line to re-read before
 * widening it: an image on a text post is decoration, so X and LinkedIn keep
 * posting the text and dropping the image exactly as they did — a pre-existing,
 * unchanged, still-silent behaviour that this function does not fix. Facebook is
 * the one that can attach a photo, so it says so via `attachesPhoto` and a
 * photo-only post stays legal there.
 */
function assertTextPostDeliverable(
  platform: string,
  asset: Asset,
  opts: { attachesPhoto: boolean },
): void {
  // `platformLabel`, not a second `PLATFORM_LABELS[...] ?? platform` — one rule,
  // and the two spellings answered differently for an unknown id
  // (`linkedin_community` vs "linkedin community"). This string reaches a CLIENT:
  // it is written to `asset.publishError`, which their home page renders.
  const label = platformLabel(platform);
  if (isClipDeliverable(asset)) {
    throw new Error(
      `${label} posts here carry text only, so this post's video would be dropped - post the clip by hand, or schedule it to a channel that carries video`,
    );
  }
  const photo = opts.attachesPhoto ? photoUrl(asset) : null;
  if (asset.content.trim() === "" && !photo) {
    throw new Error(`This post has no text to publish to ${label}`);
  }
}

/* ── Instagram ───────────────────────────────────────────────────────── */

/**
 * How long a freshly-created media container takes Meta to finish processing
 * before it can be published. A Reels container (real video transcoding) is
 * the slow case this budget is sized for; a photo container finishes in
 * one or two polls in practice, but Meta's own Content Publishing API docs
 * say to confirm `status_code: FINISHED` before `media_publish` for EITHER
 * kind, and a live test against Karos Labs' own account is what found out
 * why: the container-creation call returning a `creation_id` synchronously
 * does not mean the underlying media object exists yet — `media_publish`
 * called immediately after, for a plain photo, failed with Meta's own
 * "Media ID is not available". A still-PROCESSING container 20 polls in is
 * refused rather than published early, which `media_publish` would reject
 * anyway — the timeout error says so and to retry, rather than pretending
 * the post went out.
 */
const CONTAINER_POLL_INTERVAL_MS = 3000;
const CONTAINER_POLL_MAX_ATTEMPTS = 20; // ~60s

/**
 * Poll a media container's `status_code` until Meta reports FINISHED (ready
 * for `media_publish`) or ERROR. `statusUrl` carries the host difference
 * between the two Instagram products (graph.facebook.com vs
 * graph.instagram.com) — everything else about waiting for Meta to finish
 * processing a container, photo or video, is identical between them.
 */
async function pollMediaContainerReady(statusUrl: string, platform: string): Promise<void> {
  for (let attempt = 0; attempt < CONTAINER_POLL_MAX_ATTEMPTS; attempt++) {
    const res = await fetch(statusUrl);
    if (res.status === 401 || res.status === 403) throw new TokenExpiredError(platform, res.status);
    if (res.ok) {
      const body = (await res.json()) as { status_code?: string; status?: string };
      if (body.status_code === "FINISHED") return;
      if (body.status_code === "ERROR") {
        throw new Error(`Instagram media processing failed: ${body.status ?? "unknown error"}`);
      }
      // EXPIRED / IN_PROGRESS / PUBLISHED (already, on a race) all fall through
      // to another wait — only FINISHED/ERROR are terminal for this loop.
    }
    await new Promise((resolve) => setTimeout(resolve, CONTAINER_POLL_INTERVAL_MS));
  }
  throw new Error(
    "Instagram is still processing this post after a minute - it may finish and publish on a retry shortly",
  );
}

async function publishToInstagram(
  credentials: Record<string, string>,
  asset: Asset,
): Promise<PublishResult> {
  const token = credentials.accessToken;
  if (!token) throw new Error("No access token");
  // The photo, from wherever this asset's ingest path put it (see photoUrl).
  // No photo but a clip ⇒ Reels: a real video-processing container, not the
  // image_url path below.
  const photo = photoUrl(asset);
  const clip = photo ? null : clipUrl(asset);
  if (!photo && !clip) {
    throw new Error("Instagram posts require an image or video");
  }

  let igUserId: string | null = null;
  let pageToken: string | null = null;

  // Manual setup provides the IG business account id directly with a page token —
  // use it as-is and skip the OAuth-style page discovery.
  if (credentials.pageId) {
    igUserId = credentials.pageId;
    pageToken = token;
  } else {
    // Get pages and their connected IG business accounts
    const pagesRes = await fetch(
      metaGraphUrl(`me/accounts?access_token=${encodeURIComponent(token)}`),
    );
    if (pagesRes.status === 401 || pagesRes.status === 403) throw new TokenExpiredError("instagram", pagesRes.status);
    if (!pagesRes.ok) throw new Error(`Failed to fetch pages: ${pagesRes.status}`);
    const pagesData = (await pagesRes.json()) as { data: Array<{ id: string; access_token: string }> };
    if (!pagesData.data?.length) throw new Error("No Facebook pages found on this account");

    for (const page of pagesData.data) {
      const igRes = await fetch(
        metaGraphUrl(`${page.id}?fields=instagram_business_account&access_token=${encodeURIComponent(page.access_token)}`),
      );
      if (!igRes.ok) continue;
      const igData = (await igRes.json()) as { instagram_business_account?: { id: string } };
      if (igData.instagram_business_account?.id) {
        igUserId = igData.instagram_business_account.id;
        pageToken = page.access_token;
        break;
      }
    }
  }

  if (!igUserId || !pageToken) throw new Error("No Instagram Business Account linked to any page");

  // Create media container. A photo container (image_url) usually finishes
  // within a poll or two; a Reels container (media_type=REELS, video_url)
  // needs Meta to transcode the clip first — either way, pollMediaContainerReady
  // below waits for it, since a container's `creation_id` existing is not the
  // same as its media being ready to publish (a live "Media ID is not
  // available" on a photo is what found this). share_to_feed keeps a Reel's
  // behavior matching a photo post's: it lands on the profile grid too, not
  // only the Reels tab.
  const containerParams = new URLSearchParams({
    caption: asset.content,
    access_token: pageToken,
    ...(photo ? { image_url: photo } : { media_type: "REELS", video_url: clip!, share_to_feed: "true" }),
  });
  const containerRes = await fetch(
    metaGraphUrl(`${igUserId}/media`),
    { method: "POST", body: containerParams },
  );
  if (containerRes.status === 401 || containerRes.status === 403) throw new TokenExpiredError("instagram", containerRes.status);
  if (!containerRes.ok) {
    const err = (await containerRes.json()) as { error?: { message?: string } };
    throw new Error(`Media container failed: ${err.error?.message ?? containerRes.status}`);
  }
  const { id: creationId } = (await containerRes.json()) as { id: string };

  await pollMediaContainerReady(
    metaGraphUrl(`${creationId}?fields=status_code&access_token=${encodeURIComponent(pageToken)}`),
    "instagram",
  );

  // Publish
  const publishParams = new URLSearchParams({ creation_id: creationId, access_token: pageToken });
  const publishRes = await fetch(
    metaGraphUrl(`${igUserId}/media_publish`),
    { method: "POST", body: publishParams },
  );
  if (publishRes.status === 401 || publishRes.status === 403) throw new TokenExpiredError("instagram", publishRes.status);
  if (!publishRes.ok) {
    const err = (await publishRes.json()) as { error?: { message?: string } };
    throw new Error(`Publish failed: ${err.error?.message ?? publishRes.status}`);
  }
  const published = (await publishRes.json().catch(() => ({}))) as { id?: string };
  return { postId: published.id ?? null };
}

/* ── Instagram (direct login) ───────────────────────────────────────── */

/**
 * "Instagram API with Instagram Login" publish — the `instagram_business`
 * platform's own container→publish flow, against `graph.instagram.com`
 * (`metaInstagramGraphUrl`, see meta-graph.ts) rather than `publishToInstagram`'s
 * `graph.facebook.com`. No `me/accounts` page-discovery hop: this product logs
 * the client's own Instagram professional account in directly, so `/me` already
 * resolves the account id the same way `fetchInstagramBusinessProfile` reads it
 * (instagram-business-graph.ts) — there is no separate page token to look up.
 */
async function publishToInstagramBusiness(
  credentials: Record<string, string>,
  asset: Asset,
): Promise<PublishResult> {
  const token = credentials.accessToken;
  if (!token) throw new Error("No access token");
  const photo = photoUrl(asset);
  const clip = photo ? null : clipUrl(asset);
  if (!photo && !clip) {
    throw new Error("Instagram posts require an image or video");
  }

  const meRes = await fetch(
    metaInstagramGraphUrl(`me?fields=id&access_token=${encodeURIComponent(token)}`),
  );
  if (meRes.status === 401 || meRes.status === 403) throw new TokenExpiredError("instagram_business", meRes.status);
  if (!meRes.ok) throw new Error(`Failed to resolve Instagram account: ${meRes.status}`);
  const { id: igUserId } = (await meRes.json()) as { id?: string };
  if (!igUserId) throw new Error("Could not resolve Instagram account id");

  const containerParams = new URLSearchParams({
    caption: asset.content,
    access_token: token,
    ...(photo ? { image_url: photo } : { media_type: "REELS", video_url: clip!, share_to_feed: "true" }),
  });
  const containerRes = await fetch(
    metaInstagramGraphUrl(`${igUserId}/media`),
    { method: "POST", body: containerParams },
  );
  if (containerRes.status === 401 || containerRes.status === 403) throw new TokenExpiredError("instagram_business", containerRes.status);
  if (!containerRes.ok) {
    const err = (await containerRes.json()) as { error?: { message?: string } };
    throw new Error(`Media container failed: ${err.error?.message ?? containerRes.status}`);
  }
  const { id: creationId } = (await containerRes.json()) as { id: string };

  await pollMediaContainerReady(
    metaInstagramGraphUrl(`${creationId}?fields=status_code&access_token=${encodeURIComponent(token)}`),
    "instagram_business",
  );

  const publishParams = new URLSearchParams({ creation_id: creationId, access_token: token });
  const publishRes = await fetch(
    metaInstagramGraphUrl(`${igUserId}/media_publish`),
    { method: "POST", body: publishParams },
  );
  if (publishRes.status === 401 || publishRes.status === 403) throw new TokenExpiredError("instagram_business", publishRes.status);
  if (!publishRes.ok) {
    const err = (await publishRes.json()) as { error?: { message?: string } };
    throw new Error(`Publish failed: ${err.error?.message ?? publishRes.status}`);
  }
  const published = (await publishRes.json().catch(() => ({}))) as { id?: string };
  return { postId: published.id ?? null };
}

/* ── Facebook ────────────────────────────────────────────────────────── */

async function publishToFacebook(
  credentials: Record<string, string>,
  asset: Asset,
): Promise<PublishResult> {
  const token = credentials.accessToken;
  if (!token) throw new Error("No access token");
  // Facebook's /feed call posts a message with an optional photo URL and cannot
  // carry a clip, so it answers the shared text-post precondition with
  // attachesPhoto: a photo-only post is fine here, a video-only one is not.
  assertTextPostDeliverable("facebook", asset, { attachesPhoto: true });

  let pageId: string;
  let pageToken: string;

  // Manual setup provides pageId + a page token directly.
  if (credentials.pageId) {
    pageId = credentials.pageId;
    pageToken = token;
  } else {
    const pagesRes = await fetch(
      metaGraphUrl(`me/accounts?access_token=${encodeURIComponent(token)}`),
    );
    if (pagesRes.status === 401 || pagesRes.status === 403) throw new TokenExpiredError("facebook", pagesRes.status);
    if (!pagesRes.ok) throw new Error(`Failed to fetch pages: ${pagesRes.status}`);
    const pagesData = (await pagesRes.json()) as {
      data: Array<{ id: string; access_token: string; name: string }>;
    };
    if (!pagesData.data?.length) throw new Error("No Facebook pages found");
    pageId = pagesData.data[0].id;
    pageToken = pagesData.data[0].access_token;
  }

  const params = new URLSearchParams({ message: asset.content, access_token: pageToken });
  const photo = photoUrl(asset);
  if (photo) params.set("url", photo);

  const postRes = await fetch(
    metaGraphUrl(`${pageId}/feed`),
    { method: "POST", body: params },
  );
  if (postRes.status === 401 || postRes.status === 403) throw new TokenExpiredError("facebook", postRes.status);
  if (!postRes.ok) {
    const err = (await postRes.json()) as { error?: { message?: string } };
    throw new Error(`Post failed: ${err.error?.message ?? postRes.status}`);
  }
  const published = (await postRes.json().catch(() => ({}))) as { id?: string };
  return { postId: published.id ?? null };
}

/* ── LinkedIn ────────────────────────────────────────────────────────── */

async function publishToLinkedIn(
  credentials: Record<string, string>,
  asset: Asset,
): Promise<PublishResult> {
  const token = credentials.accessToken;
  if (!token) throw new Error("No access token");
  // shareMediaCategory is NONE below: this call posts commentary text and nothing
  // else, so it takes the text-post precondition with no photo to offer.
  assertTextPostDeliverable("linkedin", asset, { attachesPhoto: false });

  // Post as the organization when a Company Page URN was configured;
  // otherwise as the member the token belongs to.
  let authorUrn: string;
  if (credentials.organizationId) {
    authorUrn = credentials.organizationId.startsWith("urn:")
      ? credentials.organizationId
      : `urn:li:organization:${credentials.organizationId}`;
  } else {
    const infoRes = await fetch("https://api.linkedin.com/v2/userinfo", {
      headers: { Authorization: `Bearer ${token}` },
    });
    if (infoRes.status === 401 || infoRes.status === 403) throw new TokenExpiredError("linkedin", infoRes.status);
    if (!infoRes.ok) throw new Error(`Failed to fetch LinkedIn profile: ${infoRes.status}`);
    const info = (await infoRes.json()) as { sub?: string };
    const personUrn = info.sub ?? "";
    if (!personUrn) throw new Error("Could not determine LinkedIn person URN");
    authorUrn = personUrn.startsWith("urn:") ? personUrn : `urn:li:person:${personUrn}`;
  }

  // Truncate to 3000 chars (LinkedIn limit)
  const text = asset.content.slice(0, 3000);

  const body = {
    author: authorUrn,
    lifecycleState: "PUBLISHED",
    specificContent: {
      "com.linkedin.ugc.ShareContent": {
        shareCommentary: { text },
        shareMediaCategory: "NONE",
      },
    },
    visibility: {
      "com.linkedin.ugc.MemberNetworkVisibility": "PUBLIC",
    },
  };

  const postRes = await fetch("https://api.linkedin.com/v2/ugcPosts", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${token}`,
      "Content-Type": "application/json",
      "X-Restli-Protocol-Version": "2.0.0",
    },
    body: JSON.stringify(body),
  });

  if (postRes.status === 401 || postRes.status === 403) throw new TokenExpiredError("linkedin", postRes.status);
  if (!postRes.ok) {
    const err = (await postRes.json()) as { message?: string };
    throw new Error(`LinkedIn post failed: ${err.message ?? postRes.status}`);
  }
  // LinkedIn returns the UGC urn in the x-restli-id header and the body `id`.
  const headerId = postRes.headers.get("x-restli-id") ?? postRes.headers.get("x-linkedin-id");
  const published = (await postRes.json().catch(() => ({}))) as { id?: string };
  return { postId: headerId ?? published.id ?? null };
}

/* ── Twitter / X ─────────────────────────────────────────────────────── */

async function publishToTwitter(
  credentials: Record<string, string>,
  asset: Asset,
): Promise<PublishResult> {
  const token = credentials.accessToken;
  if (!token) throw new Error("No access token");
  // Text-only endpoint (media needs the separate chunked upload API, which this
  // module does not implement), so the same precondition with no photo to offer.
  assertTextPostDeliverable("twitter", asset, { attachesPhoto: false });

  // 280-char hard limit
  const text = asset.content.slice(0, 280);

  const postRes = await fetch("https://api.twitter.com/2/tweets", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${token}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({ text }),
  });

  if (postRes.status === 401 || postRes.status === 403) throw new TokenExpiredError("twitter", postRes.status);
  if (!postRes.ok) {
    const err = (await postRes.json()) as { detail?: string; title?: string };
    throw new Error(`Tweet failed: ${err.detail ?? err.title ?? postRes.status}`);
  }
  const published = (await postRes.json().catch(() => ({}))) as { data?: { id?: string } };
  return { postId: published.data?.id ?? null };
}

/* ── TikTok ──────────────────────────────────────────────────────────── */

/** TikTok's own limits for a FILE_UPLOAD chunk plan (Media Transfer Guide). */
const TIKTOK_MAX_CHUNK_BYTES = 64 * 1024 * 1024; // 64 MB
const TIKTOK_MAX_VIDEO_BYTES = 4 * 1024 * 1024 * 1024; // 4 GB

/**
 * The chunk_size / total_chunk_count TikTok's init call wants.
 *
 * Anything up to 64MB (every short-form clip this app makes, in practice) goes
 * up as ONE chunk — TikTok requires chunk_size === video_size in that case,
 * which also covers their stricter sub-5MB rule for free. Past 64MB, chunks
 * are fixed at the max size and `total_chunk_count` is `floor(size / chunk)`
 * exactly as their docs specify: the remainder rides along on the last chunk,
 * which their "final chunk may run past chunk_size, up to 128MB" allowance
 * exists precisely to cover.
 */
function planTikTokChunks(videoSize: number): { chunkSize: number; totalChunkCount: number } {
  if (videoSize > TIKTOK_MAX_VIDEO_BYTES) {
    throw new Error(
      `TikTok publish failed: video is ${(videoSize / (1024 * 1024)).toFixed(0)}MB, over TikTok's 4GB upload limit`,
    );
  }
  if (videoSize <= TIKTOK_MAX_CHUNK_BYTES) {
    return { chunkSize: videoSize, totalChunkCount: 1 };
  }
  return { chunkSize: TIKTOK_MAX_CHUNK_BYTES, totalChunkCount: Math.floor(videoSize / TIKTOK_MAX_CHUNK_BYTES) };
}

/**
 * The clip's total byte size, off the same signed URL we're about to read it
 * from. Shared by every publisher that uploads bytes itself (TikTok, YouTube)
 * — the error below deliberately names neither, since either caller can hit it.
 */
async function probeVideoSize(videoUrl: string): Promise<number> {
  const res = await fetch(videoUrl, { headers: { Range: "bytes=0-0" } });
  if (res.status === 206) {
    // "bytes 0-0/12345678" — GCS answers a satisfiable range with the total after the slash.
    const total = Number(res.headers.get("content-range")?.split("/")[1]);
    if (Number.isFinite(total) && total > 0) return total;
  }
  // Range not honoured (unusual for GCS, but not this function's job to assume) — the
  // full-body response still carries the real size on Content-Length.
  const total = Number(res.headers.get("content-length"));
  if (Number.isFinite(total) && total > 0) return total;
  throw new Error("Video publish failed: could not determine the video file's size");
}

/** One byte range of the clip, straight off its signed GCS URL. Shared, see probeVideoSize. */
async function fetchVideoChunk(videoUrl: string, start: number, end: number): Promise<ArrayBuffer> {
  const res = await fetch(videoUrl, { headers: { Range: `bytes=${start}-${end}` } });
  if (!res.ok && res.status !== 206) {
    throw new Error(`Video publish failed: could not read the video file (HTTP ${res.status})`);
  }
  return res.arrayBuffer();
}

async function publishToTikTok(
  credentials: Record<string, string>,
  asset: Asset,
): Promise<PublishResult> {
  const token = credentials.accessToken;
  if (!token) throw new Error("No access token");

  // TikTok is video-first: the Content Posting API needs the clip's bytes.
  // `clipUrl` is where that URL comes from — every field a clip can live in, not
  // just the cover-image field this used to read (#48).
  const videoUrl = clipUrl(asset);
  if (!videoUrl) {
    throw new Error("TikTok posts require a video file (e.g. video/mp4)");
  }

  // FILE_UPLOAD, not PULL_FROM_URL (2026-09-20 — SCRUM TikTok app-review fix).
  // PULL_FROM_URL hands TikTok the signed GCS link and has THEM fetch it, which
  // TikTok only allows once the source domain is verified — a DNS/file check
  // you can only do on a domain you own. This app's clip URLs resolve to
  // Google's storage.googleapis.com, which nobody outside Google can verify,
  // so every PULL_FROM_URL publish was always going to end in the
  // `url_ownership_unverified` failure `clipUrl`'s own comment already named.
  // FILE_UPLOAD sidesteps the requirement entirely: our server reads the
  // clip's bytes itself (the same signed URL, an ordinary ranged GET) and PUTs
  // them straight to TikTok, so no domain claim is ever made. The cost is the
  // chunked-upload dance below, which TikTok requires even for a single chunk.
  const videoSize = await probeVideoSize(videoUrl);
  const { chunkSize, totalChunkCount } = planTikTokChunks(videoSize);

  const initRes = await fetch("https://open.tiktokapis.com/v2/post/publish/video/init/", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${token}`,
      "Content-Type": "application/json; charset=UTF-8",
    },
    body: JSON.stringify({
      post_info: {
        // TikTok caption limit is 2200 chars. SELF_ONLY keeps posts private until
        // the TikTok app is approved for public posting (required for unaudited apps).
        title: asset.content.slice(0, 2200),
        privacy_level: "SELF_ONLY",
      },
      source_info: {
        source: "FILE_UPLOAD",
        video_size: videoSize,
        chunk_size: chunkSize,
        total_chunk_count: totalChunkCount,
      },
    }),
  });

  // TEMPORARY — DIAGNOSTIC ONLY (2026-09-20): a 401/403 here has always been assumed
  // to mean an expired/revoked token, but that assumption was never checked against
  // TikTok's actual response body. Surface the real body so the next Publish Now
  // attempt tells us whether this is really TokenExpiredError or something else
  // (app not actually approved for Content Posting API, creator_info/privacy_level,
  // etc). Revert this block once the real cause is known — see TikTok status doc.
  if (initRes.status === 401 || initRes.status === 403) {
    const body = await initRes.text().catch(() => "");
    throw new Error(`TikTok publish failed (HTTP ${initRes.status}): ${body.slice(0, 500)}`);
  }
  if (!initRes.ok) {
    const err = (await initRes.json().catch(() => ({}))) as { error?: { message?: string } };
    throw new Error(`TikTok publish failed: ${err.error?.message ?? initRes.status}`);
  }
  // A logical failure still returns HTTP 200 with a non-"ok" error code, so inspect
  // the body rather than trusting the status alone — the same shape that hid the
  // PULL_FROM_URL failure this replaces.
  const initBody = (await initRes.json()) as {
    data?: { publish_id?: string; upload_url?: string };
    error?: { code?: string; message?: string };
  };
  if (initBody.error?.code && initBody.error.code !== "ok") {
    throw new Error(`TikTok publish failed: ${initBody.error.message ?? initBody.error.code}`);
  }
  const uploadUrl = initBody.data?.upload_url;
  if (!uploadUrl) throw new Error("TikTok publish failed: no upload_url returned");

  // Chunks go up SEQUENTIALLY (TikTok's own requirement, not a style choice) —
  // straight from the clip's signed GCS URL to TikTok's upload_url, nothing
  // touches disk on this server. `upload_url` carries its own authorization;
  // it does not take our OAuth bearer token.
  for (let i = 0; i < totalChunkCount; i++) {
    const start = i * chunkSize;
    const end = i === totalChunkCount - 1 ? videoSize - 1 : start + chunkSize - 1;
    const chunk = await fetchVideoChunk(videoUrl, start, end);
    const putRes = await fetch(uploadUrl, {
      method: "PUT",
      headers: {
        "Content-Type": "video/mp4",
        "Content-Length": String(end - start + 1),
        "Content-Range": `bytes ${start}-${end}/${videoSize}`,
      },
      body: chunk,
    });
    if (!putRes.ok) {
      const text = await putRes.text().catch(() => "");
      throw new Error(
        `TikTok publish failed: chunk ${i + 1}/${totalChunkCount} upload failed (HTTP ${putRes.status}) ${text.slice(0, 200)}`,
      );
    }
  }

  // TikTok returns a publish_id (an async publish-job handle), the closest thing to a post id here.
  return { postId: initBody.data?.publish_id ?? null };
}

/* ── YouTube ─────────────────────────────────────────────────────────── */

/** YouTube's own ceiling for `snippet.title` (Data API v3 docs). */
const YOUTUBE_TITLE_MAX = 100;

/**
 * A real video title, which YouTube requires and this app's assets do not
 * carry — `Asset` only has `content` (the caption/body text every other
 * publisher posts verbatim). First line of the caption, cut to its first
 * sentence when one is found within that line, else the line itself, capped
 * at YouTube's own title length. A caption-less clip (the bulk-upload shape —
 * see `bulkClip` in publisher-media-payload.test.ts, and `publishToTikTok`'s
 * own title slice above) falls back to a dated placeholder rather than
 * shipping an empty `snippet.title`, which the API rejects outright.
 */
function youtubeTitleFrom(asset: Asset): string {
  const text = asset.content.trim();
  if (!text) return `Karos Labs upload - ${new Date().toISOString().slice(0, 10)}`;
  const firstLine = text.split("\n")[0]!.trim();
  const sentenceEnd = firstLine.search(/[.!?](\s|$)/);
  const cut = sentenceEnd === -1 ? firstLine : firstLine.slice(0, sentenceEnd + 1);
  return (cut || firstLine).slice(0, YOUTUBE_TITLE_MAX).trim();
}

/**
 * YouTube Data API v3's resumable upload protocol — the same shape of problem
 * `publishToTikTok` solved (2026-09-20: upload this server reads bytes for
 * itself, off the clip's signed GCS URL, rather than handing a third party a
 * URL to fetch), reusing its `clipUrl`/`probeVideoSize`/`fetchVideoChunk`
 * helpers directly since none of the three name TikTok.
 *
 * TWO PROTOCOL DIFFERENCES FROM TIKTOK, both load-bearing:
 *  - The init call's answer is NOT in its JSON body. YouTube hands back the
 *    resumable session URL in the `Location` response HEADER — TikTok's
 *    `upload_url` sits in `data.upload_url`. Missing header is treated the
 *    same as a missing `upload_url` there: a clear thrown error.
 *  - YouTube's resumable protocol allows ONE PUT of the whole file (the
 *    `Content-Range: bytes 0-N/N` header below IS the "this is everything"
 *    case, not a slice of a bigger plan) — no TikTok-style
 *    total_chunk_count/chunk_size negotiation, and no server-side reason to
 *    add one: this route calls out to Google directly rather than accepting
 *    a large inbound request body itself, so Next's own body-size limits
 *    never enter into it. `fetchVideoChunk` still does the reading — it is
 *    just asked for the single range that is the entire file.
 *
 * PRIVATE ON PURPOSE, like TikTok's `SELF_ONLY`: `privacyStatus: "private"`
 * keeps every upload off the public channel until this path is proven against
 * a real account in production. Flip it once that happens.
 */
async function publishToYouTube(
  credentials: Record<string, string>,
  asset: Asset,
): Promise<PublishResult> {
  const token = credentials.accessToken;
  if (!token) throw new Error("No access token");

  const videoUrl = clipUrl(asset);
  if (!videoUrl) {
    throw new Error("YouTube posts require a video file (e.g. video/mp4)");
  }

  const videoSize = await probeVideoSize(videoUrl);
  const title = youtubeTitleFrom(asset);

  const initRes = await fetch(
    "https://www.googleapis.com/upload/youtube/v3/videos?uploadType=resumable&part=snippet,status",
    {
      method: "POST",
      headers: {
        Authorization: `Bearer ${token}`,
        "Content-Type": "application/json; charset=UTF-8",
        "X-Upload-Content-Type": "video/*",
        "X-Upload-Content-Length": String(videoSize),
      },
      body: JSON.stringify({
        snippet: { title, description: asset.content },
        status: { privacyStatus: "private" },
      }),
    },
  );

  if (initRes.status === 401 || initRes.status === 403) throw new TokenExpiredError("youtube", initRes.status);
  if (!initRes.ok) {
    const err = (await initRes.json().catch(() => ({}))) as { error?: { message?: string } };
    throw new Error(`YouTube publish failed: ${err.error?.message ?? initRes.status}`);
  }
  const sessionUrl = initRes.headers.get("location");
  if (!sessionUrl) {
    throw new Error("YouTube publish failed: no upload session URL returned");
  }

  // Same read-then-PUT shape as publishToTikTok's chunk loop, collapsed to the
  // one call YouTube's protocol allows for a whole file.
  const bytes = await fetchVideoChunk(videoUrl, 0, videoSize - 1);
  const putRes = await fetch(sessionUrl, {
    method: "PUT",
    headers: {
      "Content-Type": "video/*",
      "Content-Length": String(videoSize),
      "Content-Range": `bytes 0-${videoSize - 1}/${videoSize}`,
    },
    body: bytes,
  });

  if (putRes.status === 401 || putRes.status === 403) throw new TokenExpiredError("youtube", putRes.status);
  if (!putRes.ok) {
    const err = (await putRes.json().catch(() => ({}))) as { error?: { message?: string } };
    throw new Error(`YouTube publish failed: upload failed (HTTP ${putRes.status}) ${err.error?.message ?? ""}`.trim());
  }
  const published = (await putRes.json().catch(() => ({}))) as { id?: string };
  return { postId: published.id ?? null };
}

/* ── Dispatcher ──────────────────────────────────────────────────────── */

export async function publishAssetToPlatform(
  platform: string,
  integration: ClientIntegration,
  asset: Asset,
): Promise<PublishResult> {
  switch (platform) {
    case "instagram":
      return publishToInstagram(integration.credentials, asset);
    case "instagram_business":
      return publishToInstagramBusiness(integration.credentials, asset);
    case "facebook":
      return publishToFacebook(integration.credentials, asset);
    case "linkedin":
      return publishToLinkedIn(integration.credentials, asset);
    case "twitter":
      return publishToTwitter(integration.credentials, asset);
    case "tiktok":
      return publishToTikTok(integration.credentials, asset);
    case "youtube":
      return publishToYouTube(integration.credentials, asset);
    default:
      throw new Error(`Publisher not implemented for platform: ${platform}`);
  }
}
