/**
 * Platform publishers — the single place that talks to social-network APIs.
 * Used by both the publish cron (/api/publish, auto mode) and the
 * "Publish Now" server action (manual mode). Server-only.
 */

import type { Asset, ClientIntegration } from "@/lib/types";
import { assetImages, assetVideos } from "@/lib/asset-images";
import { PUBLISHABLE_PLATFORMS, platformLabel } from "@/lib/integrations/platforms";

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
 * weeks — so a clip scheduled beyond that window hands TikTok a URL that has
 * expired. `assetVideoSrc` solves the same problem for playback by re-signing per
 * request from `meta.gcsPath`; a publisher cannot use that route (it is
 * session-authorized, and TikTok fetches anonymously). Re-signing here is the fix
 * for the lifetime and is deliberately not attempted in this change.
 *
 * WHAT IS NOT CLAIMED ABOUT REACHING IT. This note used to say the whole path was
 * "unreachable in production today" on the strength of
 * PENDING_VERIFICATION_PLATFORM_IDS, and that set does not carry the weight: it
 * withholds the OAuth Connect button on the Integrations card (`!isConnected &&`
 * there, integrations-tab.tsx) and nothing else. The admin "Manual credentials"
 * accordion on that same card saves credentials for ANY platform in the registry,
 * tiktok included, so a tiktok integration can exist today and this function can
 * run against it. What the code does say about the failure is right below in
 * `publishToTikTok`: TikTok answers an unverified source domain with an HTTP 200
 * whose body carries an error code (`url_ownership_unverified`), which that check
 * turns into a refusal. Not being able to complete a real publish end to end is
 * the reason the re-sign is not written — an untested one would be guesswork —
 * rather than a reason the expiry cannot be hit.
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

async function publishToInstagram(
  credentials: Record<string, string>,
  asset: Asset,
): Promise<PublishResult> {
  const token = credentials.accessToken;
  if (!token) throw new Error("No access token");
  // The photo, from wherever this asset's ingest path put it (see photoUrl). A
  // clip-only asset is refused by its own reason rather than by "requires an
  // image", which describes the wrong problem: the asset HAS media, and Reels
  // upload is a different Graph call this module does not make.
  const photo = photoUrl(asset);
  if (!photo) {
    throw new Error(
      clipUrl(asset)
        ? "Instagram video (Reels) publishing is not automated yet - post this clip manually and mark it as published"
        : "Instagram posts require an image",
    );
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
      `https://graph.facebook.com/v20.0/me/accounts?access_token=${encodeURIComponent(token)}`,
    );
    if (pagesRes.status === 401 || pagesRes.status === 403) throw new TokenExpiredError("instagram", pagesRes.status);
    if (!pagesRes.ok) throw new Error(`Failed to fetch pages: ${pagesRes.status}`);
    const pagesData = (await pagesRes.json()) as { data: Array<{ id: string; access_token: string }> };
    if (!pagesData.data?.length) throw new Error("No Facebook pages found on this account");

    for (const page of pagesData.data) {
      const igRes = await fetch(
        `https://graph.facebook.com/v20.0/${page.id}?fields=instagram_business_account&access_token=${encodeURIComponent(page.access_token)}`,
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

  // Create media container
  const containerParams = new URLSearchParams({
    image_url: photo,
    caption: asset.content,
    access_token: pageToken,
  });
  const containerRes = await fetch(
    `https://graph.facebook.com/v20.0/${igUserId}/media`,
    { method: "POST", body: containerParams },
  );
  if (containerRes.status === 401 || containerRes.status === 403) throw new TokenExpiredError("instagram", containerRes.status);
  if (!containerRes.ok) {
    const err = (await containerRes.json()) as { error?: { message?: string } };
    throw new Error(`Media container failed: ${err.error?.message ?? containerRes.status}`);
  }
  const { id: creationId } = (await containerRes.json()) as { id: string };

  // Publish
  const publishParams = new URLSearchParams({ creation_id: creationId, access_token: pageToken });
  const publishRes = await fetch(
    `https://graph.facebook.com/v20.0/${igUserId}/media_publish`,
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
      `https://graph.facebook.com/v20.0/me/accounts?access_token=${encodeURIComponent(token)}`,
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
    `https://graph.facebook.com/v20.0/${pageId}/feed`,
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

async function publishToTikTok(
  credentials: Record<string, string>,
  asset: Asset,
): Promise<PublishResult> {
  const token = credentials.accessToken;
  if (!token) throw new Error("No access token");

  // TikTok is video-first: the Content Posting API pulls a hosted video by URL.
  // `clipUrl` is where that URL comes from — every field a clip can live in, not
  // just the cover-image field this used to read (#48).
  const videoUrl = clipUrl(asset);
  if (!videoUrl) {
    throw new Error("TikTok posts require a video file (e.g. video/mp4)");
  }

  const res = await fetch("https://open.tiktokapis.com/v2/post/publish/video/init/", {
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
      source_info: { source: "PULL_FROM_URL", video_url: videoUrl },
    }),
  });

  if (res.status === 401 || res.status === 403) throw new TokenExpiredError("tiktok", res.status);
  if (!res.ok) {
    const err = (await res.json().catch(() => ({}))) as { error?: { message?: string } };
    throw new Error(`TikTok publish failed: ${err.error?.message ?? res.status}`);
  }
  // A logical failure (e.g. url_ownership_unverified) still returns HTTP 200 with a
  // non-"ok" error code, so inspect the body rather than trusting the status alone.
  const body = (await res.json()) as {
    data?: { publish_id?: string };
    error?: { code?: string; message?: string };
  };
  if (body.error?.code && body.error.code !== "ok") {
    throw new Error(`TikTok publish failed: ${body.error.message ?? body.error.code}`);
  }
  // TikTok returns a publish_id (an async publish-job handle), the closest thing to a post id here.
  return { postId: body.data?.publish_id ?? null };
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
    case "facebook":
      return publishToFacebook(integration.credentials, asset);
    case "linkedin":
      return publishToLinkedIn(integration.credentials, asset);
    case "twitter":
      return publishToTwitter(integration.credentials, asset);
    case "tiktok":
      return publishToTikTok(integration.credentials, asset);
    case "youtube":
      // Video upload (resumable, multi-GB) is a different beast — YouTube items
      // stay on the calendar as manual/placeholder entries for now.
      throw new Error("YouTube publishing is not automated yet - post manually and mark as published");
    default:
      throw new Error(`Publisher not implemented for platform: ${platform}`);
  }
}
