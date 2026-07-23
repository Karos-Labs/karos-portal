/**
 * Analytics providers — the single place that fetches performance metrics from
 * social-network Insights APIs. Mirrors the shape of `publishers.ts`: one async
 * function per platform with a uniform `(credentials, asset)` signature, a
 * `switch` dispatcher, and a shared typed error for dead tokens. Server-only.
 *
 * Live API calls are stubbed for now (we're preparing for them, not shipping
 * them): each `fetchLiveX` throws `MetricsUnavailableError`, and the dispatcher
 * falls back to a deterministic, realistic mock so the whole ingestion loop —
 * fetch → normalize → score → persist — is exercisable end-to-end today. When a
 * platform's real endpoint is wired in, replace its `fetchLiveX` body and the
 * mock fallback simply stops being reached.
 */

import "server-only";
import type { Asset, EmployeeSeat, MarketingMetrics } from "@/lib/types";
import { mockRawMetrics, normalizePlatformMetrics, type RawPlatformMetrics } from "@/lib/analytics";
import { TokenExpiredError } from "@/lib/integrations/publishers";

/** Thrown when a platform's Insights API isn't wired up yet — triggers the mock fallback. */
export class MetricsUnavailableError extends Error {
  constructor(platform: string) {
    super(`Live metrics not available for ${platform} yet`);
    this.name = "MetricsUnavailableError";
  }
}

export interface PlatformMetricsResult {
  metrics: MarketingMetrics;
  /** "live" once a real API answered; "mock" while we fall back. */
  source: "live" | "mock";
}

/* ── Live fetch (stubbed) ────────────────────────────────────────────── */

/**
 * Whether live ingestion is switched on. Gated by env so dev/test never hammer
 * real APIs with placeholder tokens — flip ANALYTICS_LIVE_INGEST=1 in the GCP
 * runtime to go live. Read at call time (not module load) so tests can toggle it.
 */
function liveIngestEnabled(): boolean {
  return process.env.ANALYTICS_LIVE_INGEST === "1";
}

/** Shared 401/403 → TokenExpiredError guard for the raw fetchers. */
function assertNotExpired(platform: string, res: Response): void {
  if (res.status === 401 || res.status === 403) throw new TokenExpiredError(platform, res.status);
}

/*
 * Per-platform live fetchers. Each pulls the metrics for ONE published post
 * (scoped by `asset.platformPostId`) using the client's OAuth access token, and
 * returns a platform-native payload for `normalizePlatformMetrics`. Response
 * shapes follow each platform's documented Insights API. 401/403 → TokenExpiredError
 * so the batch marks the integration for reauth and moves on; other non-OK
 * responses throw so the loop skips that asset (rather than masking with mock).
 * "Pull what you can": fields a token may lack permission for default to 0.
 */

async function fetchLinkedInRaw(token: string, postId: string): Promise<RawPlatformMetrics> {
  // socialActions gives likes/comments for the share urn. Member-post impressions
  // aren't exposed by a simple endpoint, so they stay 0 (pull-what-you-can).
  const res = await fetch(`https://api.linkedin.com/v2/socialActions/${encodeURIComponent(postId)}`, {
    headers: { Authorization: `Bearer ${token}`, "X-Restli-Protocol-Version": "2.0.0" },
  });
  assertNotExpired("linkedin", res);
  if (!res.ok) throw new Error(`LinkedIn metrics failed: ${res.status}`);
  const body = (await res.json()) as {
    likesSummary?: { totalLikes?: number };
    commentsSummary?: { aggregatedTotalComments?: number };
  };
  return {
    impressionCount: 0,
    clickCount: 0,
    likeCount: body.likesSummary?.totalLikes ?? 0,
    commentCount: body.commentsSummary?.aggregatedTotalComments ?? 0,
    shareCount: 0,
  };
}

async function fetchTwitterRaw(token: string, postId: string): Promise<RawPlatformMetrics> {
  const res = await fetch(
    `https://api.twitter.com/2/tweets/${encodeURIComponent(postId)}?tweet.fields=public_metrics,non_public_metrics`,
    { headers: { Authorization: `Bearer ${token}` } },
  );
  assertNotExpired("twitter", res);
  if (!res.ok) throw new Error(`Twitter metrics failed: ${res.status}`);
  const body = (await res.json()) as {
    data?: {
      public_metrics?: { impression_count?: number; like_count?: number; retweet_count?: number; reply_count?: number };
      non_public_metrics?: { url_link_clicks?: number; impression_count?: number };
    };
  };
  const pub = body.data?.public_metrics ?? {};
  const np = body.data?.non_public_metrics ?? {};
  return {
    impression_count: pub.impression_count ?? np.impression_count ?? 0,
    url_link_clicks: np.url_link_clicks ?? 0,
    like_count: pub.like_count ?? 0,
    retweet_count: pub.retweet_count ?? 0,
    reply_count: pub.reply_count ?? 0,
  };
}

async function fetchInstagramRaw(token: string, mediaId: string): Promise<RawPlatformMetrics> {
  const base = `https://graph.facebook.com/v20.0/${encodeURIComponent(mediaId)}`;
  const [countsRes, insightsRes] = await Promise.all([
    fetch(`${base}?fields=like_count,comments_count&access_token=${encodeURIComponent(token)}`),
    fetch(`${base}/insights?metric=impressions,reach,saved&access_token=${encodeURIComponent(token)}`),
  ]);
  assertNotExpired("instagram", countsRes);
  assertNotExpired("instagram", insightsRes);
  if (!countsRes.ok) throw new Error(`Instagram metrics failed: ${countsRes.status}`);
  const counts = (await countsRes.json()) as { like_count?: number; comments_count?: number };
  // Insights can be permission-gated; treat a failure as "pull what you can" (zeros).
  const insights = insightsRes.ok
    ? ((await insightsRes.json()) as { data?: Array<{ name: string; values?: Array<{ value?: number }> }> })
    : { data: [] };
  const metric = (name: string) =>
    insights.data?.find((d) => d.name === name)?.values?.[0]?.value ?? 0;
  return {
    impressions: metric("impressions"),
    likes: counts.like_count ?? 0,
    comments: counts.comments_count ?? 0,
    saves: metric("saved"),
    shares: 0,
    website_clicks: 0,
    profile_visits: 0,
  };
}

async function fetchFacebookRaw(token: string, postId: string): Promise<RawPlatformMetrics> {
  const base = `https://graph.facebook.com/v20.0/${encodeURIComponent(postId)}`;
  const [insightsRes, engagementRes] = await Promise.all([
    fetch(`${base}/insights?metric=post_impressions,post_clicks&access_token=${encodeURIComponent(token)}`),
    fetch(`${base}?fields=reactions.summary(true),comments.summary(true),shares&access_token=${encodeURIComponent(token)}`),
  ]);
  assertNotExpired("facebook", insightsRes);
  assertNotExpired("facebook", engagementRes);
  if (!insightsRes.ok && !engagementRes.ok) throw new Error(`Facebook metrics failed: ${insightsRes.status}`);
  const insights = insightsRes.ok
    ? ((await insightsRes.json()) as { data?: Array<{ name: string; values?: Array<{ value?: number }> }> })
    : { data: [] };
  const engagement = engagementRes.ok
    ? ((await engagementRes.json()) as {
        reactions?: { summary?: { total_count?: number } };
        comments?: { summary?: { total_count?: number } };
        shares?: { count?: number };
      })
    : {};
  const metric = (name: string) => insights.data?.find((d) => d.name === name)?.values?.[0]?.value ?? 0;
  return {
    post_impressions: metric("post_impressions"),
    post_clicks: metric("post_clicks"),
    reactions: engagement.reactions?.summary?.total_count ?? 0,
    comments: engagement.comments?.summary?.total_count ?? 0,
    shares: engagement.shares?.count ?? 0,
  };
}

async function fetchYouTubeRaw(token: string, videoId: string): Promise<RawPlatformMetrics> {
  // Data API statistics (public counts). Watch time needs the Analytics API +
  // channel-owner scope, so estimatedMinutesWatched stays 0 here.
  const res = await fetch(
    `https://www.googleapis.com/youtube/v3/videos?part=statistics&id=${encodeURIComponent(videoId)}`,
    { headers: { Authorization: `Bearer ${token}` } },
  );
  assertNotExpired("youtube", res);
  if (!res.ok) throw new Error(`YouTube metrics failed: ${res.status}`);
  const body = (await res.json()) as {
    items?: Array<{ statistics?: { viewCount?: string; likeCount?: string; commentCount?: string } }>;
  };
  const s = body.items?.[0]?.statistics ?? {};
  return {
    views: Number(s.viewCount ?? 0),
    likes: Number(s.likeCount ?? 0),
    comments: Number(s.commentCount ?? 0),
    clicks: 0,
    estimatedMinutesWatched: 0,
  };
}

async function fetchTikTokRaw(token: string, publishId: string): Promise<RawPlatformMetrics> {
  // Query the video by id for its public stats. TikTok's organic post metrics
  // require the video.list scope; fields a token lacks default to 0.
  const res = await fetch("https://open.tiktokapis.com/v2/video/query/?fields=id,view_count,like_count,comment_count,share_count", {
    method: "POST",
    headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
    body: JSON.stringify({ filters: { video_ids: [publishId] } }),
  });
  assertNotExpired("tiktok", res);
  if (!res.ok) throw new Error(`TikTok metrics failed: ${res.status}`);
  const body = (await res.json()) as {
    data?: { videos?: Array<{ view_count?: number; like_count?: number; comment_count?: number; share_count?: number }> };
  };
  const v = body.data?.videos?.[0] ?? {};
  return {
    video_views: v.view_count ?? 0,
    profile_views: 0,
    likes: v.like_count ?? 0,
    comments: v.comment_count ?? 0,
    shares: v.share_count ?? 0,
    total_time_watched: 0,
  };
}

/**
 * Fetch the live raw metrics for one asset on one platform, or throw
 * MetricsUnavailableError when live can't run (ingest disabled, no token, or no
 * captured post id) so the caller falls back to mock.
 */
async function fetchLiveRaw(
  platform: string,
  credentials: Record<string, string>,
  asset: Asset,
): Promise<RawPlatformMetrics> {
  if (!liveIngestEnabled()) throw new MetricsUnavailableError(`${platform} (live ingest disabled)`);
  const token = credentials.accessToken;
  if (!token) throw new MetricsUnavailableError(`${platform} (no access token)`);
  const postId = asset.platformPostId;
  if (!postId) throw new MetricsUnavailableError(`${platform} (no platformPostId on asset ${asset.id})`);

  switch (platform) {
    case "linkedin":  return fetchLinkedInRaw(token, postId);
    case "twitter":   return fetchTwitterRaw(token, postId);
    case "instagram": return fetchInstagramRaw(token, postId);
    case "facebook":  return fetchFacebookRaw(token, postId);
    case "youtube":   return fetchYouTubeRaw(token, postId);
    case "tiktok":    return fetchTikTokRaw(token, postId);
    default:          throw new MetricsUnavailableError(platform);
  }
}

/* ── Extended reads (audience/comments/mentions/growth) ─────────────────
 * These are separate from fetchPlatformMetrics above: not "one post's
 * numbers" but account-level reads the PDF's agent connectors ask for.
 * Grouped here by which scope they ride on:
 *  - Instagram audience + comments: already-granted scopes, real endpoints.
 *  - YouTube channel analytics: new ungated scope added in oauth.ts.
 *  - Twitter mentions/follower growth: existing scopes, just new endpoints.
 *  - LinkedIn org / Meta comments+mentions: gated behind the platform's
 *    extendedScopes approval flag — throw a clear error until then instead
 *    of pretending to work.
 * ------------------------------------------------------------------ */

/** Thrown when a read needs a platform product/partner approval that hasn't
 *  landed yet (see extendedScopes/envApprovalFlag in oauth.ts). Distinct from
 *  TokenExpiredError: the fix is a pending platform approval, not reconnecting. */
export class ExtendedAccessNotGrantedError extends Error {
  constructor(platform: string, envFlag: string) {
    super(
      `${platform}: this read needs the platform's extended/partner API access, ` +
        `which isn't approved yet. Set ${envFlag}=1 once it is.`,
    );
    this.name = "ExtendedAccessNotGrantedError";
  }
}

function assertExtendedAccessApproved(platform: string, envFlag: string): void {
  if (process.env[envFlag] !== "1") throw new ExtendedAccessNotGrantedError(platform, envFlag);
}

export interface InstagramAudience {
  totalFollowers: number;
  /** Breakdown key format follows the Graph API response, e.g. "F.25-34" (gender.age range) or a city/country name. */
  byDimension: Record<string, number>;
}

/** Follower demographics for an IG business account — already covered by the
 *  existing `instagram_manage_insights` scope, no extra approval needed. */
export async function fetchInstagramAudience(token: string, igUserId: string): Promise<InstagramAudience> {
  const res = await fetch(
    `https://graph.facebook.com/v20.0/${encodeURIComponent(igUserId)}/insights` +
      `?metric=follower_demographics&period=lifetime&metric_type=total_value` +
      `&breakdown=age,gender&access_token=${encodeURIComponent(token)}`,
  );
  assertNotExpired("instagram", res);
  if (!res.ok) throw new Error(`Instagram audience fetch failed: ${res.status}`);
  const body = (await res.json()) as {
    data?: Array<{ total_value?: { breakdowns?: Array<{ results?: Array<{ dimension_values?: string[]; value?: number }> }> } }>;
  };
  const results = body.data?.[0]?.total_value?.breakdowns?.[0]?.results ?? [];
  const byDimension: Record<string, number> = {};
  let total = 0;
  for (const r of results) {
    const key = (r.dimension_values ?? []).join(".");
    byDimension[key] = r.value ?? 0;
    total += r.value ?? 0;
  }
  return { totalFollowers: total, byDimension };
}

export interface PlatformComment {
  id: string;
  text: string;
  authorName: string;
  createdAt: string;
}

/** Comments on one IG media object — for drafting replies. Existing scope. */
export async function fetchInstagramComments(token: string, mediaId: string): Promise<PlatformComment[]> {
  const res = await fetch(
    `https://graph.facebook.com/v20.0/${encodeURIComponent(mediaId)}/comments` +
      `?fields=id,text,username,timestamp&access_token=${encodeURIComponent(token)}`,
  );
  assertNotExpired("instagram", res);
  if (!res.ok) throw new Error(`Instagram comments fetch failed: ${res.status}`);
  const body = (await res.json()) as {
    data?: Array<{ id?: string; text?: string; username?: string; timestamp?: string }>;
  };
  return (body.data ?? []).map((c) => ({
    id: c.id ?? "",
    text: c.text ?? "",
    authorName: c.username ?? "",
    createdAt: c.timestamp ?? "",
  }));
}

export interface YouTubeChannelAnalytics {
  views: number;
  estimatedMinutesWatched: number;
  averageViewDurationSeconds: number;
  subscribersGained: number;
}

/** Channel-level watch time / retention via the YouTube Analytics API —
 *  needs the `yt-analytics.readonly` scope added in oauth.ts (ungated). */
export async function fetchYouTubeChannelAnalytics(
  token: string,
  params: { startDate: string; endDate: string },
): Promise<YouTubeChannelAnalytics> {
  const url = new URL("https://youtubeanalytics.googleapis.com/v2/reports");
  url.searchParams.set("ids", "channel==MINE");
  url.searchParams.set("startDate", params.startDate);
  url.searchParams.set("endDate", params.endDate);
  url.searchParams.set("metrics", "views,estimatedMinutesWatched,averageViewDuration,subscribersGained");
  const res = await fetch(url.toString(), { headers: { Authorization: `Bearer ${token}` } });
  assertNotExpired("youtube", res);
  if (!res.ok) throw new Error(`YouTube Analytics fetch failed: ${res.status}`);
  const body = (await res.json()) as { rows?: number[][] };
  const [views = 0, estimatedMinutesWatched = 0, averageViewDurationSeconds = 0, subscribersGained = 0] =
    body.rows?.[0] ?? [];
  return { views, estimatedMinutesWatched, averageViewDurationSeconds, subscribersGained };
}

export interface TwitterFollowerGrowth {
  followersCount: number;
  followingCount: number;
  tweetCount: number;
}

/** Own follower count — no extra scope needed, just `user.fields=public_metrics`. */
export async function fetchTwitterFollowerGrowth(token: string): Promise<TwitterFollowerGrowth> {
  const res = await fetch("https://api.twitter.com/2/users/me?user.fields=public_metrics", {
    headers: { Authorization: `Bearer ${token}` },
  });
  assertNotExpired("twitter", res);
  if (!res.ok) throw new Error(`Twitter follower fetch failed: ${res.status}`);
  const body = (await res.json()) as {
    data?: { public_metrics?: { followers_count?: number; following_count?: number; tweet_count?: number } };
  };
  const m = body.data?.public_metrics ?? {};
  return {
    followersCount: m.followers_count ?? 0,
    followingCount: m.following_count ?? 0,
    tweetCount: m.tweet_count ?? 0,
  };
}

/** Mentions of the connected account — `tweet.read`+`users.read`, already granted. */
export async function fetchTwitterMentions(token: string, userId: string, maxResults = 20): Promise<PlatformComment[]> {
  const res = await fetch(
    `https://api.twitter.com/2/users/${encodeURIComponent(userId)}/mentions` +
      `?max_results=${maxResults}&tweet.fields=created_at,author_id&expansions=author_id`,
    { headers: { Authorization: `Bearer ${token}` } },
  );
  assertNotExpired("twitter", res);
  if (!res.ok) throw new Error(`Twitter mentions fetch failed: ${res.status}`);
  const body = (await res.json()) as {
    data?: Array<{ id?: string; text?: string; created_at?: string; author_id?: string }>;
    includes?: { users?: Array<{ id?: string; username?: string }> };
  };
  const usersById = new Map((body.includes?.users ?? []).map((u) => [u.id, u.username]));
  return (body.data ?? []).map((t) => ({
    id: t.id ?? "",
    text: t.text ?? "",
    authorName: usersById.get(t.author_id ?? "") ?? "",
    createdAt: t.created_at ?? "",
  }));
}

export interface LinkedInOrgFollowers {
  organizationUrn: string;
  followerCount: number;
}

/**
 * Company-page follower count — requires the LinkedIn Community Management
 * API (r_organization_social). Unlike Meta/TikTok's extendedScopes, this isn't
 * gated by an approval flag on the SAME app: LinkedIn requires this to be a
 * wholly separate developer app (see OAUTH_CONFIGS.linkedin_community in
 * oauth.ts), so `token` here MUST be the linkedin_community integration's
 * access token, never the primary `linkedin` integration's. Written against
 * LinkedIn's documented `organizationalEntityFollowerStatistics` shape but
 * UNVERIFIED (no live community-app token to test against yet).
 */
export async function fetchLinkedInOrgFollowers(token: string, organizationUrn: string): Promise<LinkedInOrgFollowers> {
  const res = await fetch(
    `https://api.linkedin.com/v2/organizationalEntityFollowerStatistics?q=organizationalEntity&organizationalEntity=${encodeURIComponent(organizationUrn)}`,
    { headers: { Authorization: `Bearer ${token}`, "X-Restli-Protocol-Version": "2.0.0" } },
  );
  assertNotExpired("linkedin_community", res);
  if (!res.ok) throw new Error(`LinkedIn org followers fetch failed: ${res.status}`);
  const body = (await res.json()) as {
    elements?: Array<{ followerCounts?: { organicFollowerCount?: number; paidFollowerCount?: number } }>;
  };
  const counts = body.elements?.[0]?.followerCounts;
  return {
    organizationUrn,
    followerCount: (counts?.organicFollowerCount ?? 0) + (counts?.paidFollowerCount ?? 0),
  };
}

/**
 * Comments/mentions on a Facebook Page or IG account — requires Meta Advanced
 * Access (pages_read_user_content), gated by META_ADVANCED_ACCESS_APPROVED.
 */
export async function fetchMetaMentions(token: string, pageOrIgId: string): Promise<PlatformComment[]> {
  assertExtendedAccessApproved("facebook", "META_ADVANCED_ACCESS_APPROVED");
  const res = await fetch(
    `https://graph.facebook.com/v20.0/${encodeURIComponent(pageOrIgId)}/tagged` +
      `?fields=id,message,from,created_time&access_token=${encodeURIComponent(token)}`,
  );
  assertNotExpired("facebook", res);
  if (!res.ok) throw new Error(`Meta mentions fetch failed: ${res.status}`);
  const body = (await res.json()) as {
    data?: Array<{ id?: string; message?: string; from?: { name?: string }; created_time?: string }>;
  };
  return (body.data ?? []).map((m) => ({
    id: m.id ?? "",
    text: m.message ?? "",
    authorName: m.from?.name ?? "",
    createdAt: m.created_time ?? "",
  }));
}

/* ── Dispatcher ──────────────────────────────────────────────────────── */

/**
 * Fetch and normalize the recent performance metrics for one asset on one
 * platform. Tries the live API first. `TokenExpiredError` propagates so the
 * batch marks the integration for reauth. `MetricsUnavailableError` (ingest
 * off / no token / no post id — including when the client has no connected
 * integration at all, i.e. `credentials` is `{}`) falls back to deterministic
 * mock so dev + demo keep working. Any OTHER live failure propagates so the
 * batch skips that asset rather than persisting fake numbers as if real.
 */
/**
 * Fetch aggregate metrics for one LinkedIn employee-advocacy seat (its personal
 * handle). The seat's token is validated live so an expired one surfaces as
 * TokenExpiredError (the sync then pauses the seat); detailed member-post
 * analytics require the LinkedIn Marketing API (elevated access), so until that's
 * granted the numbers are best-effort mock keyed per seat. `seat.credentials`
 * must already be DECRYPTED (getEmployeeSeatsForSync does this).
 */
export async function fetchSeatMetrics(seat: EmployeeSeat): Promise<PlatformMetricsResult> {
  try {
    if (!liveIngestEnabled()) throw new MetricsUnavailableError("linkedin seat (live disabled)");
    const token = seat.credentials.accessToken;
    if (!token) throw new MetricsUnavailableError("linkedin seat (no token)");
    const res = await fetch("https://api.linkedin.com/v2/userinfo", {
      headers: { Authorization: `Bearer ${token}` },
    });
    assertNotExpired("linkedin", res);
    // Token is valid but member-post analytics aren't reachable yet — best-effort mock.
    throw new MetricsUnavailableError("linkedin seat (member analytics require Marketing API access)");
  } catch (err) {
    if (err instanceof MetricsUnavailableError) {
      const raw = mockRawMetrics("linkedin", seat.id);
      return { metrics: normalizePlatformMetrics("linkedin", raw), source: "mock" };
    }
    throw err;
  }
}

export async function fetchPlatformMetrics(
  platform: string,
  credentials: Record<string, string>,
  asset: Asset,
): Promise<PlatformMetricsResult> {
  try {
    const raw = await fetchLiveRaw(platform, credentials, asset);
    return { metrics: normalizePlatformMetrics(platform, raw), source: "live" };
  } catch (err) {
    if (err instanceof MetricsUnavailableError) {
      const raw = mockRawMetrics(platform, asset.id);
      return { metrics: normalizePlatformMetrics(platform, raw), source: "mock" };
    }
    throw err; // TokenExpiredError and real HTTP failures propagate to the batch loop
  }
}
