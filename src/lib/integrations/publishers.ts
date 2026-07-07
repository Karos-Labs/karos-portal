/**
 * Platform publishers — the single place that talks to social-network APIs.
 * Used by both the publish cron (/api/publish, auto mode) and the
 * "Publish Now" server action (manual mode). Server-only.
 */

import type { Asset, ClientIntegration } from "@/lib/types";
import { PUBLISHABLE_PLATFORMS } from "@/lib/integrations/platforms";

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

/* ── Instagram ───────────────────────────────────────────────────────── */

async function publishToInstagram(
  credentials: Record<string, string>,
  asset: Asset,
): Promise<void> {
  const token = credentials.accessToken;
  if (!token) throw new Error("No access token");
  if (!asset.imageUrl) throw new Error("Instagram posts require an image");

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
    image_url: asset.imageUrl,
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
}

/* ── Facebook ────────────────────────────────────────────────────────── */

async function publishToFacebook(
  credentials: Record<string, string>,
  asset: Asset,
): Promise<void> {
  const token = credentials.accessToken;
  if (!token) throw new Error("No access token");

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
  if (asset.imageUrl) params.set("url", asset.imageUrl);

  const postRes = await fetch(
    `https://graph.facebook.com/v20.0/${pageId}/feed`,
    { method: "POST", body: params },
  );
  if (postRes.status === 401 || postRes.status === 403) throw new TokenExpiredError("facebook", postRes.status);
  if (!postRes.ok) {
    const err = (await postRes.json()) as { error?: { message?: string } };
    throw new Error(`Post failed: ${err.error?.message ?? postRes.status}`);
  }
}

/* ── LinkedIn ────────────────────────────────────────────────────────── */

async function publishToLinkedIn(
  credentials: Record<string, string>,
  asset: Asset,
): Promise<void> {
  const token = credentials.accessToken;
  if (!token) throw new Error("No access token");

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
}

/* ── Twitter / X ─────────────────────────────────────────────────────── */

async function publishToTwitter(
  credentials: Record<string, string>,
  asset: Asset,
): Promise<void> {
  const token = credentials.accessToken;
  if (!token) throw new Error("No access token");
  // Manual OAuth 1.0a keys (apiKey/apiSecret/accessTokenSecret) can't be used as a
  // bearer token — posting requires request signing we don't implement. Fail with
  // a clear message instead of a confusing 401 from the API.
  if (credentials.accessTokenSecret && !token.startsWith("Bearer") && credentials.apiKey) {
    throw new Error(
      "X (Twitter) manual OAuth 1.0a keys are not supported for publishing — reconnect via OAuth to get a bearer token",
    );
  }

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
}

/* ── Dispatcher ──────────────────────────────────────────────────────── */

export async function publishAssetToPlatform(
  platform: string,
  integration: ClientIntegration,
  asset: Asset,
): Promise<void> {
  switch (platform) {
    case "instagram":
      return publishToInstagram(integration.credentials, asset);
    case "facebook":
      return publishToFacebook(integration.credentials, asset);
    case "linkedin":
      return publishToLinkedIn(integration.credentials, asset);
    case "twitter":
      return publishToTwitter(integration.credentials, asset);
    case "youtube":
      // Video upload (resumable, multi-GB) is a different beast — YouTube items
      // stay on the calendar as manual/placeholder entries for now.
      throw new Error("YouTube publishing is not automated yet — post manually and mark as published");
    default:
      throw new Error(`Publisher not implemented for platform: ${platform}`);
  }
}
