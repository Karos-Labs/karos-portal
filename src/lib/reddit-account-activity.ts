/**
 * Reading a Reddit account's own public activity, so the client does not have to
 * describe their own account to us.
 *
 * Pure and client-safe (the fetch lives in integrations/reddit.ts): parsing the
 * Atom feed and deriving the profile are separated from the network call so both
 * are testable without hitting Reddit.
 *
 * WHAT THIS CAN AND CANNOT SEE, verified empirically 2026-07-27 from a
 * residential IP with a browser User-Agent:
 *
 * - `reddit.com/user/<name>.rss` → HTTP 200. Gives the 25 most recent posts and
 *   comments with their subreddit and timestamp. That is enough for subreddit
 *   distribution, cadence, and the post-vs-comment mix.
 * - `reddit.com/user/<name>/about.json` → HTTP **403**, on both www and old, with
 *   a browser UA and with a descriptive one. So karma, account age and the
 *   verified flags are NOT publicly readable at all.
 *
 * Karma, account age and removal rate therefore need the authenticated read
 * (OAuth scopes identity + history, already configured in integrations/oauth.ts
 * and implemented in integrations/reddit.ts) — see docs/reddit-agent-portal.md
 * "What the Reddit OAuth app unlocks". Until that app exists, the account-safety
 * fields stay human-answered and the subreddit/cadence fields are derived.
 */

/** One post or comment from an account's public feed. */
export interface RedditActivityItem {
  /** "r/SaaS", or "u/name" for their own profile posts. */
  subreddit: string;
  kind: "post" | "comment";
  title: string;
  url: string;
  /** epoch millis */
  at: number;
}

export interface RedditAccountProfile {
  itemCount: number;
  postCount: number;
  commentCount: number;
  /** Subreddits they actually participate in, most frequent first. */
  subreddits: Array<{ name: string; count: number }>;
  /** epoch millis of the oldest and newest item in the feed. */
  firstSeenAt?: number;
  lastSeenAt?: number;
  /** Items per week across the observed window, one decimal. */
  perWeek?: number;
  /**
   * A sentence a person can read and correct, written for the intake form's
   * history field. Deliberately hedged about what the feed cannot show.
   */
  summary: string;
}

const ENTRY = /<entry>([\s\S]*?)<\/entry>/g;

function unescapeXml(s: string): string {
  return s
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#0?39;|&apos;/g, "'")
    .replace(/&amp;/g, "&");
}

/**
 * Parses the Atom feed at reddit.com/user/<name>.rss.
 *
 * A comment entry's link carries a trailing comment id after the thread slug
 * (…/comments/<id>/<slug>/<commentId>/), which is how post and comment are told
 * apart — the feed has no explicit type. Reddit's own profile posts arrive with
 * a `u_<name>` category, normalized to "u/<name>" so they never look like a
 * subreddit the account participates in.
 */
export function parseRedditUserFeed(xml: string): RedditActivityItem[] {
  const items: RedditActivityItem[] = [];
  for (const match of xml.matchAll(ENTRY)) {
    const entry = match[1];
    const category = entry.match(/<category[^>]*\blabel="([^"]+)"/)?.[1];
    const term = entry.match(/<category[^>]*\bterm="([^"]+)"/)?.[1];
    const url = entry.match(/<link[^>]*\bhref="([^"]+)"/)?.[1];
    const updated = entry.match(/<updated[^>]*>([^<]+)<\/updated>/)?.[1];
    const title = entry.match(/<title[^>]*>([\s\S]*?)<\/title>/)?.[1];
    if (!url || !updated) continue;
    const at = Date.parse(updated);
    if (Number.isNaN(at)) continue;

    let subreddit = (category ?? (term ? `r/${term}` : "")).trim();
    if (!subreddit) continue;
    // A profile post arrives as term "u_name" / label "u/name".
    if (/^u_/.test(subreddit)) subreddit = `u/${subreddit.slice(2)}`;
    if (!/^[ru]\//.test(subreddit)) subreddit = `r/${subreddit}`;

    // …/comments/<threadId>/<slug>/<commentId>/ = a comment on someone's thread.
    const isComment = /\/comments\/[^/]+\/[^/]+\/[^/]+\/?$/.test(url);
    items.push({
      subreddit,
      kind: isComment ? "comment" : "post",
      title: title ? unescapeXml(title).trim() : "",
      url,
      at,
    });
  }
  return items.sort((a, b) => b.at - a.at);
}

const WEEK_MS = 7 * 24 * 60 * 60 * 1000;

/**
 * Turns the feed into the shape the intake form pre-fills from.
 *
 * `now` is passed in rather than read, so the summary is deterministic in tests.
 * Their own profile subreddit (u/<name>) is kept out of the participation list:
 * posting to your own profile is not community participation and would give the
 * agent a bogus subreddit to draft for.
 */
export function deriveAccountProfile(
  items: RedditActivityItem[],
  now: number,
): RedditAccountProfile {
  if (items.length === 0) {
    return {
      itemCount: 0,
      postCount: 0,
      commentCount: 0,
      subreddits: [],
      summary:
        "No public activity found on this account. Either it is brand new, or its history is private or removed. Treat it as having no usable history: value-only replies until it has earned some.",
    };
  }

  const counts = new Map<string, number>();
  let postCount = 0;
  let commentCount = 0;
  for (const item of items) {
    if (item.kind === "post") postCount += 1;
    else commentCount += 1;
    if (item.subreddit.startsWith("u/")) continue;
    counts.set(item.subreddit, (counts.get(item.subreddit) ?? 0) + 1);
  }
  const subreddits = [...counts.entries()]
    .map(([name, count]) => ({ name, count }))
    .sort((a, b) => b.count - a.count || a.name.localeCompare(b.name));

  const lastSeenAt = items[0].at;
  const firstSeenAt = items[items.length - 1].at;
  const spanWeeks = Math.max((lastSeenAt - firstSeenAt) / WEEK_MS, 1 / 7);
  const perWeek = Math.round((items.length / spanWeeks) * 10) / 10;

  const daysSince = Math.floor((now - lastSeenAt) / (24 * 60 * 60 * 1000));
  const recency =
    daysSince <= 7
      ? "active this week"
      : daysSince <= 31
        ? `last active about ${Math.max(1, Math.round(daysSince / 7))} weeks ago`
        : `last active about ${Math.max(1, Math.round(daysSince / 30))} months ago`;

  const top = subreddits
    .slice(0, 5)
    .map((s) => `${s.name} (${s.count})`)
    .join(", ");
  const mix =
    commentCount > 0 && postCount > 0
      ? `${commentCount} comments and ${postCount} posts`
      : commentCount > 0
        ? `${commentCount} comments and no posts`
        : `${postCount} posts and no comments`;

  const summary = [
    `Public activity: the ${items.length} most recent items are ${mix}, ${recency}, roughly ${perWeek} a week.`,
    subreddits.length > 0
      ? `Active in ${top}.`
      : "No community activity, only posts to their own profile.",
    "Karma and account age are not publicly readable, so add them here if you know them.",
  ].join(" ");

  return {
    itemCount: items.length,
    postCount,
    commentCount,
    subreddits,
    firstSeenAt,
    lastSeenAt,
    perWeek,
    summary,
  };
}
