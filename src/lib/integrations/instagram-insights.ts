/**
 * Instagram performance insights — read client, System User model. Server-only.
 *
 * UNLIKE the existing `instagram`/`facebook` entries in `oauth.ts` (which are
 * a PER-CLIENT OAuth consent flow used for publishing on that client's own
 * behalf), this module reads on Karos Labs' OWN Meta Business Manager System
 * User token (`META_SYSTEM_USER_TOKEN`): a client grants access by adding
 * Karos Labs as a partner in their Business Settings, not by an individual
 * OAuth popup. One token, every client whose Page granted it access.
 *
 * This is deliberately NOT a "Facebook" integration from the client's point
 * of view — see `platforms.ts`'s note on why Facebook was dropped as a
 * sellable channel (portal feedback round 2, 2026-09). The Facebook Graph API
 * is still the transport (an Instagram professional account is always linked
 * through a Facebook Page), but nothing here posts to, reads, or names a
 * Facebook Page as a product; the client-facing surface is Instagram insights
 * only, and `platforms.ts`'s registry entry for this is `instagram_insights`.
 *
 * Gated the same way `oauth.ts`'s existing Meta scopes already are:
 * `META_ADVANCED_ACCESS_APPROVED` — this file's calls need `pages_show_list`
 * and `read_insights`-equivalent Advanced Access from the same Meta App
 * Review the OAuth flow's `pages_read_user_content`/`read_insights` scopes
 * are already waiting on (see `SETUP.md`/`.env.example`).
 */

import "server-only";
import { TokenExpiredError } from "@/lib/integrations/publishers";
import { metaGraphUrl } from "@/lib/integrations/meta-graph";

/** Thrown on Meta's "permission not yet approved" shape — distinct from a dead token: the fix is Meta approving App Review, not reconnecting anything. */
export class MetaAccessNotGrantedError extends Error {
  constructor(detail?: string) {
    super(
      "Meta has not approved Advanced Access for this permission yet " +
        "(pages_show_list / pages_read_engagement / instagram_manage_insights) — " +
        `submit App Review in Meta for Developers, then set META_ADVANCED_ACCESS_APPROVED=1${detail ? `. Meta said: ${detail}` : ""}`,
    );
    this.name = "MetaAccessNotGrantedError";
  }
}

interface GraphErrorBody {
  error?: { message?: string; code?: number; error_subcode?: number };
}

async function assertGraphOk(res: Response): Promise<void> {
  if (res.ok) return;
  let body: GraphErrorBody = {};
  try {
    body = (await res.json()) as GraphErrorBody;
  } catch {
    // no JSON body — fall through with the raw status
  }
  const code = body.error?.code;
  const subcode = body.error?.error_subcode;
  if (code === 190) throw new TokenExpiredError("instagram_insights", res.status);
  // Meta's shape for "this permission has not cleared App Review yet for an
  // asset outside the app's own roles": code 10, or a 2xx error_subcode.
  if (code === 10 || (subcode !== undefined && subcode >= 200 && subcode < 300)) {
    throw new MetaAccessNotGrantedError(body.error?.message);
  }
  throw new Error(`Instagram insights request failed: ${body.error?.message ?? res.status}`);
}

/**
 * `pages_show_list` territory: which Instagram professional account is
 * linked to this client's Facebook Page. A client hands over their Page id
 * (what they actually have on hand); this turns it into the id every other
 * call here needs.
 */
export async function resolveInstagramBusinessAccountId(
  systemUserToken: string,
  pageId: string,
): Promise<string | null> {
  const res = await fetch(
    `${metaGraphUrl(encodeURIComponent(pageId))}?fields=instagram_business_account&access_token=${encodeURIComponent(systemUserToken)}`,
  );
  await assertGraphOk(res);
  const body = (await res.json()) as { instagram_business_account?: { id?: string } };
  return body.instagram_business_account?.id ?? null;
}

export type InstagramMediaType = "FEED" | "REELS" | "STORY";

export interface InstagramMediaSummary {
  id: string;
  mediaType: InstagramMediaType;
  timestamp?: string;
  permalink?: string;
}

function normalizeMediaType(raw: { media_type?: string; media_product_type?: string }): InstagramMediaType {
  if (raw.media_product_type === "REELS") return "REELS";
  if (raw.media_product_type === "STORY") return "STORY";
  return "FEED";
}

/** `instagram_basic`: the client's own recent posts/reels, newest first. */
export async function listRecentInstagramMedia(
  systemUserToken: string,
  igUserId: string,
  limit = 25,
): Promise<InstagramMediaSummary[]> {
  const res = await fetch(
    `${metaGraphUrl(`${encodeURIComponent(igUserId)}/media`)}` +
      `?fields=id,media_type,media_product_type,timestamp,permalink&limit=${limit}` +
      `&access_token=${encodeURIComponent(systemUserToken)}`,
  );
  await assertGraphOk(res);
  const body = (await res.json()) as {
    data?: Array<{ id: string; media_type?: string; media_product_type?: string; timestamp?: string; permalink?: string }>;
  };
  return (body.data ?? []).map((m) => ({
    id: m.id,
    mediaType: normalizeMediaType(m),
    ...(m.timestamp !== undefined ? { timestamp: m.timestamp } : {}),
    ...(m.permalink !== undefined ? { permalink: m.permalink } : {}),
  }));
}

export interface InstagramMediaInsights {
  mediaId: string;
  reach: number | null;
  views: number | null;
  saved: number | null;
  shares: number | null;
  follows: number | null;
  profileVisits: number | null;
}

/**
 * Per Meta's documented `instagram-media/insights` metric support (checked
 * 2026-09-16): `saved` is FEED+REELS only; `follows`/`profile_visits` are
 * FEED+STORY only; `reach`/`views`/`shares` apply to all three. A metric not
 * valid for the media's type is never requested and comes back `null` here —
 * never a fabricated `0` (same rule `analytics-providers.ts`'s "pull what you
 * can" comment already follows for this client's own published posts).
 */
function metricsForMediaType(mediaType: InstagramMediaType): string[] {
  const metrics = ["reach", "views", "shares"];
  if (mediaType === "FEED" || mediaType === "REELS") metrics.push("saved");
  if (mediaType === "FEED" || mediaType === "STORY") metrics.push("follows", "profile_visits");
  return metrics;
}

/** `instagram_manage_insights`: the six metrics the client dashboard reports, for one post/reel/story. */
export async function fetchInstagramMediaInsights(
  systemUserToken: string,
  mediaId: string,
  mediaType: InstagramMediaType,
): Promise<InstagramMediaInsights> {
  const metrics = metricsForMediaType(mediaType);
  const res = await fetch(
    `${metaGraphUrl(`${encodeURIComponent(mediaId)}/insights`)}?metric=${metrics.join(",")}` +
      `&access_token=${encodeURIComponent(systemUserToken)}`,
  );
  await assertGraphOk(res);
  const body = (await res.json()) as { data?: Array<{ name: string; values?: Array<{ value?: number }> }> };
  const valueOf = (name: string): number | null => {
    if (!metrics.includes(name)) return null;
    return body.data?.find((d) => d.name === name)?.values?.[0]?.value ?? 0;
  };
  return {
    mediaId,
    reach: valueOf("reach"),
    views: valueOf("views"),
    saved: valueOf("saved"),
    shares: valueOf("shares"),
    follows: valueOf("follows"),
    profileVisits: valueOf("profile_visits"),
  };
}

/**
 * The account's current follower total — a plain field, not an insights
 * metric. The natural first writer for `clientFollowerSnapshots`
 * (`src/lib/follower-tracking.ts`), which today has none — see that module's
 * own comment: "the moment an ingestion cron writes to
 * clientFollowerSnapshots... the audience cell lights up on its own".
 */
export async function fetchInstagramFollowerCount(systemUserToken: string, igUserId: string): Promise<number | null> {
  const res = await fetch(
    `${metaGraphUrl(encodeURIComponent(igUserId))}?fields=followers_count&access_token=${encodeURIComponent(systemUserToken)}`,
  );
  await assertGraphOk(res);
  const body = (await res.json()) as { followers_count?: number };
  return body.followers_count ?? null;
}
