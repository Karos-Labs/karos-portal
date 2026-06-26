import { type NextRequest, NextResponse } from "next/server";
import { listScheduledAssets, listClientIntegrations, updateAsset } from "@/lib/data";
import type { Asset, ClientIntegration } from "@/lib/types";

/* ── Platform → asset type mapping ──────────────────────────────────── */

const ASSET_TYPE_TO_PLATFORM: Record<string, string[]> = {
  instagram_post: ["instagram"],
  social_post: ["twitter", "linkedin", "facebook"],
  article: ["linkedin"],
  email: [],
  note: [],
};

function inferPlatform(assetType: string, connectedPlatforms: string[]): string | null {
  const candidates = ASSET_TYPE_TO_PLATFORM[assetType] ?? [];
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

  // Get pages and their connected IG business accounts
  const pagesRes = await fetch(
    `https://graph.facebook.com/v20.0/me/accounts?access_token=${encodeURIComponent(token)}`,
  );
  if (!pagesRes.ok) throw new Error(`Failed to fetch pages: ${pagesRes.status}`);
  const pagesData = (await pagesRes.json()) as { data: Array<{ id: string; access_token: string }> };
  if (!pagesData.data?.length) throw new Error("No Facebook pages found on this account");

  let igUserId: string | null = null;
  let pageToken: string | null = null;

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

  const pagesRes = await fetch(
    `https://graph.facebook.com/v20.0/me/accounts?access_token=${encodeURIComponent(token)}`,
  );
  if (!pagesRes.ok) throw new Error(`Failed to fetch pages: ${pagesRes.status}`);
  const pagesData = (await pagesRes.json()) as {
    data: Array<{ id: string; access_token: string; name: string }>;
  };
  if (!pagesData.data?.length) throw new Error("No Facebook pages found");

  const page = pagesData.data[0];
  const params = new URLSearchParams({ message: asset.content, access_token: page.access_token });
  if (asset.imageUrl) params.set("url", asset.imageUrl);

  const postRes = await fetch(
    `https://graph.facebook.com/v20.0/${page.id}/feed`,
    { method: "POST", body: params },
  );
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

  // Get person URN from OpenID userinfo
  const infoRes = await fetch("https://api.linkedin.com/v2/userinfo", {
    headers: { Authorization: `Bearer ${token}` },
  });
  if (!infoRes.ok) throw new Error(`Failed to fetch LinkedIn profile: ${infoRes.status}`);
  const info = (await infoRes.json()) as { sub?: string };
  const personUrn = info.sub ?? "";
  if (!personUrn) throw new Error("Could not determine LinkedIn person URN");

  // Truncate to 3000 chars (LinkedIn limit)
  const text = asset.content.slice(0, 3000);

  const body = {
    author: personUrn.startsWith("urn:") ? personUrn : `urn:li:person:${personUrn}`,
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

  if (!postRes.ok) {
    const err = (await postRes.json()) as { detail?: string; title?: string };
    throw new Error(`Tweet failed: ${err.detail ?? err.title ?? postRes.status}`);
  }
}

/* ── Dispatcher ──────────────────────────────────────────────────────── */

async function publishAsset(
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
    default:
      throw new Error(`Publisher not implemented for platform: ${platform}`);
  }
}

/* ── Cron handler ────────────────────────────────────────────────────── */

export async function GET(req: NextRequest) {
  // Auth: Vercel Cron sends Authorization: Bearer <CRON_SECRET>
  // In dev, CRON_SECRET can be any value or omitted entirely
  const secret = process.env.CRON_SECRET;
  if (secret) {
    const authHeader = req.headers.get("Authorization");
    if (authHeader !== `Bearer ${secret}`) {
      return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    }
  }

  const now = Date.now();
  const dueAssets = await listScheduledAssets({ before: now });

  if (dueAssets.length === 0) {
    return NextResponse.json({ processed: 0, results: [] });
  }

  const results: Array<{
    assetId: string;
    platform: string;
    status: "published" | "failed" | "skipped";
    error?: string;
  }> = [];

  for (const asset of dueAssets) {
    const integrations = await listClientIntegrations(asset.clientId);
    const connectedPlatforms = integrations.map((i) => i.platform);

    const platform =
      asset.scheduledPlatform ??
      inferPlatform(asset.type, connectedPlatforms);

    if (!platform) {
      results.push({
        assetId: asset.id,
        platform: "none",
        status: "skipped",
        error: "No compatible platform connected",
      });
      continue;
    }

    const integration = integrations.find((i) => i.platform === platform);
    if (!integration) {
      results.push({
        assetId: asset.id,
        platform,
        status: "skipped",
        error: `Integration for ${platform} not found`,
      });
      continue;
    }

    try {
      await publishAsset(platform, integration, asset);
      await updateAsset(asset.id, { status: "published", updatedAt: Date.now() });
      results.push({ assetId: asset.id, platform, status: "published" });
    } catch (e) {
      const error = e instanceof Error ? e.message : "Unknown error";
      results.push({ assetId: asset.id, platform, status: "failed", error });
      // Leave as "scheduled" so the next cron tick retries
    }
  }

  return NextResponse.json({
    processed: dueAssets.length,
    published: results.filter((r) => r.status === "published").length,
    failed: results.filter((r) => r.status === "failed").length,
    results,
  });
}
