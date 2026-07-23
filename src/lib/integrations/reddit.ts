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

const USER_AGENT = "karoscmo:agent-connectors:v1 (by /u/karoslabs)";

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
