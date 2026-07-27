/**
 * Reddit — read client. Server-only.
 *
 * Requires a Reddit "web app" OAuth client (reddit.com/prefs/apps) — see
 * OAUTH_CONFIGS.reddit in oauth.ts for scopes. Every call needs a
 * descriptive, non-generic User-Agent per Reddit's API rules or requests get
 * silently rate-limited harder. NOTE: Reddit's 2023 API terms require a paid
 * Data API license for meaningful commercial-volume use — this client covers
 * the "connect the client's own account" read (karma, history, account
 * health), which is low-volume and account-scoped; subreddit-wide thread
 * scanning / competitor-presence reads are a different, higher-volume use
 * case and are (correctly) left on the existing scraper path, not this OAuth
 * connector — see agent-service's egress allowlist for reddit.com.
 */

import "server-only";
import { TokenExpiredError } from "@/lib/integrations/publishers";
import { parseRedditUserFeed, type RedditActivityItem } from "@/lib/reddit-account-activity";

const USER_AGENT = "karoscmo:agent-connectors:v1 (by /u/karoslabs)";

/**
 * Reddit serves its keyless feeds only to browser-shaped clients: the same
 * request with our descriptive UA returns 403. Verified 2026-07-27. Reddit's API
 * rules ask for a descriptive UA on the AUTHENTICATED endpoints, which is what
 * USER_AGENT above is for — this constant is only for the public RSS a logged-out
 * browser could fetch anyway.
 */
const BROWSER_USER_AGENT =
  "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36";

/** Why a public activity read produced nothing, so the UI can say which. */
export type RedditReadFailure = "blocked" | "rate_limited" | "not_found" | "unavailable";

export type RedditPublicActivity =
  | { ok: true; items: RedditActivityItem[] }
  | { ok: false; reason: RedditReadFailure };

/**
 * An account's own recent public posts and comments, with NO credential.
 *
 * This is the only keyless read that works: `/user/<name>/about.json` returns 403
 * even from a residential IP with a browser UA, so karma and account age are not
 * available here — they need the OAuth app (see the module header in
 * reddit-account-activity.ts).
 *
 * Never throws: a blocked or rate-limited read is an expected outcome that the
 * intake form degrades around, not an error worth failing a save over. Reddit
 * also blocks datacenter egress, so this may legitimately fail in production
 * while working locally.
 */
export async function fetchRedditPublicActivity(username: string): Promise<RedditPublicActivity> {
  const handle = username.trim().replace(/^\/?(?:u\/|@)/i, "");
  if (!/^[A-Za-z0-9_-]{3,20}$/.test(handle)) return { ok: false, reason: "not_found" };
  let res: Response;
  try {
    res = await fetch(`https://www.reddit.com/user/${encodeURIComponent(handle)}.rss`, {
      headers: { "User-Agent": BROWSER_USER_AGENT, Accept: "application/atom+xml, application/xml" },
      signal: AbortSignal.timeout(10_000),
    });
  } catch {
    return { ok: false, reason: "unavailable" };
  }
  if (res.status === 404) return { ok: false, reason: "not_found" };
  if (res.status === 429) return { ok: false, reason: "rate_limited" };
  if (res.status === 403 || res.status === 401) return { ok: false, reason: "blocked" };
  if (!res.ok) return { ok: false, reason: "unavailable" };
  const xml = await res.text();
  // A private, suspended or empty account returns a valid feed with no entries;
  // that is a real answer ("no usable history"), not a failure.
  return { ok: true, items: parseRedditUserFeed(xml) };
}

export interface RedditAccountHealth {
  username: string;
  totalKarma: number;
  linkKarma: number;
  commentKarma: number;
  createdUtc: number;
}

/** The connected account's own karma + age — the "voice + account health check" read. */
export async function fetchRedditAccountHealth(accessToken: string): Promise<RedditAccountHealth> {
  const res = await fetch("https://oauth.reddit.com/api/v1/me", {
    headers: { Authorization: `Bearer ${accessToken}`, "User-Agent": USER_AGENT },
  });
  if (res.status === 401 || res.status === 403) throw new TokenExpiredError("reddit", res.status);
  if (!res.ok) throw new Error(`Reddit account fetch failed: ${res.status}`);
  const body = (await res.json()) as {
    name?: string;
    total_karma?: number;
    link_karma?: number;
    comment_karma?: number;
    created_utc?: number;
  };
  return {
    username: body.name ?? "",
    totalKarma: body.total_karma ?? 0,
    linkKarma: body.link_karma ?? 0,
    commentKarma: body.comment_karma ?? 0,
    createdUtc: body.created_utc ?? 0,
  };
}

export interface RedditHistoryItem {
  id: string;
  subreddit: string;
  title?: string;
  body?: string;
  score: number;
  removed: boolean;
  createdUtc: number;
}

/**
 * The connected account's own recent posts/comments — for the removal-rate
 * check and voice sampling. `kind`: "submitted" (posts) or "comments".
 */
export async function fetchRedditOwnHistory(
  accessToken: string,
  username: string,
  kind: "submitted" | "comments" = "submitted",
  limit = 50,
): Promise<RedditHistoryItem[]> {
  const res = await fetch(
    `https://oauth.reddit.com/user/${encodeURIComponent(username)}/${kind}?limit=${limit}`,
    { headers: { Authorization: `Bearer ${accessToken}`, "User-Agent": USER_AGENT } },
  );
  if (res.status === 401 || res.status === 403) throw new TokenExpiredError("reddit", res.status);
  if (!res.ok) throw new Error(`Reddit history fetch failed: ${res.status}`);
  const body = (await res.json()) as {
    data?: { children?: Array<{ data?: Record<string, unknown> }> };
  };
  return (body.data?.children ?? []).map((c) => {
    const d = c.data ?? {};
    return {
      id: String(d.id ?? ""),
      subreddit: String(d.subreddit ?? ""),
      title: typeof d.title === "string" ? d.title : undefined,
      body: typeof d.body === "string" ? d.body : undefined,
      score: Number(d.score ?? 0),
      removed: !!(d.removed || d.removal_reason),
      createdUtc: Number(d.created_utc ?? 0),
    };
  });
}
