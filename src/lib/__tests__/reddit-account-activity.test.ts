import { describe, expect, it } from "vitest";
import { deriveAccountProfile, parseRedditUserFeed } from "@/lib/reddit-account-activity";

/**
 * Fixture shaped from a real `reddit.com/user/<name>.rss` response pulled
 * 2026-07-27 (HTTP 200, browser User-Agent, residential IP): Atom entries, one
 * `category` per entry carrying the subreddit, an `updated` timestamp, and a
 * comment distinguished only by the extra comment id on its link.
 *
 * The point of the whole module is that the client types a handle and we answer
 * the rest, so these tests pin what we can actually learn from that feed.
 */
const FEED = `<?xml version="1.0" encoding="UTF-8"?>
<feed xmlns="http://www.w3.org/2005/Atom">
  <category term="u_karos_al" label="u/karos_al"/>
  <updated>2026-07-27T19:30:48+00:00</updated>
  <entry>
    <category term="SaaS" label="r/SaaS"/>
    <title>/u/karos_al on How do you guys ACTUALLY market your SaaS?</title>
    <link href="https://www.reddit.com/r/SaaS/comments/1uqssai/how_do_you_guys/os0o1vi/"/>
    <updated>2026-07-20T16:59:58+00:00</updated>
    <content type="html">&lt;div class="md"&gt;&lt;p&gt;The problem is not a missing channel. You are running eight at once, so none gets enough attention to tell you whether it works.&lt;/p&gt;&lt;p&gt;Cut to the one that is pulling and go deeper.&lt;/p&gt;&lt;/div&gt;</content>
  </entry>
  <entry>
    <category term="SaaS" label="r/SaaS"/>
    <content type="html">&lt;div class="md"&gt;&lt;p&gt;short&lt;/p&gt;&lt;/div&gt;</content>
    <title>Small teams &amp; the &quot;one channel&quot; rule</title>
    <link href="https://www.reddit.com/r/SaaS/comments/1uqaaaa/small_teams/"/>
    <updated>2026-07-19T10:00:00+00:00</updated>
  </entry>
  <entry>
    <category term="marketing" label="r/marketing"/>
    <title>/u/karos_al on Agency vs in-house</title>
    <link href="https://www.reddit.com/r/marketing/comments/1up7a5a/agency_vs/orucdtm/"/>
    <updated>2026-07-14T19:01:03+00:00</updated>
    <content type="html">&lt;div class="md"&gt;&lt;p&gt;Both fail the same way, which is nobody owning the decision. Pick the option where one person is accountable and you will be fine either way.&lt;/p&gt;&lt;/div&gt;</content>
  </entry>
  <entry>
    <category term="u_karos_al" label="u/karos_al"/>
    <title>A note on my own profile</title>
    <link href="https://www.reddit.com/r/u_karos_al/comments/1u7hraf/a_note/"/>
    <updated>2026-07-13T16:04:27+00:00</updated>
  </entry>
</feed>`;

/** 2026-07-27, so "days since last activity" is deterministic. */
const NOW = Date.parse("2026-07-27T12:00:00Z");

describe("parseRedditUserFeed", () => {
  it("reads subreddit, kind, title and time from each entry", () => {
    const items = parseRedditUserFeed(FEED);
    expect(items).toHaveLength(4);
    // Newest first.
    expect(items.map((i) => i.subreddit)).toEqual(["r/SaaS", "r/SaaS", "r/marketing", "u/karos_al"]);
    // A comment carries an extra id after the thread slug; a post does not.
    expect(items.map((i) => i.kind)).toEqual(["comment", "post", "comment", "post"]);
    expect(items[1].title).toBe('Small teams & the "one channel" rule');
    // The body is double-escaped HTML in the feed; it arrives as plain words.
    expect(items[0].text).toContain("You are running eight at once");
    expect(items[0].text).not.toContain("<p>");
    expect(items[0].at).toBe(Date.parse("2026-07-20T16:59:58+00:00"));
  });

  it("normalizes a profile post so it never looks like a subreddit", () => {
    // u_<name> is Reddit's own profile-post pseudo-subreddit. Left as "r/u_name"
    // it would become a subreddit the agent thinks it may draft for.
    const items = parseRedditUserFeed(FEED);
    expect(items[3].subreddit).toBe("u/karos_al");
  });

  it("returns nothing for an empty or unparseable feed rather than throwing", () => {
    expect(parseRedditUserFeed("")).toEqual([]);
    expect(parseRedditUserFeed("<feed></feed>")).toEqual([]);
    expect(parseRedditUserFeed("not xml at all")).toEqual([]);
  });
});

describe("deriveAccountProfile", () => {
  it("answers the questions the form used to ask the client", () => {
    const profile = deriveAccountProfile(parseRedditUserFeed(FEED), NOW);

    // Which subreddits they actually take part in, most frequent first — and
    // their own profile is NOT one of them.
    expect(profile.subreddits).toEqual([
      { name: "r/SaaS", count: 2 },
      { name: "r/marketing", count: 1 },
    ]);
    expect(profile.subreddits.some((s) => s.name.includes("karos_al"))).toBe(false);

    expect(profile.itemCount).toBe(4);
    expect(profile.commentCount).toBe(2);
    expect(profile.postCount).toBe(2);
    expect(profile.summary).toContain("2 comments and 2 posts");
    expect(profile.summary).toContain("r/SaaS (2)");
    // The summary LEADS with the writing, because that is the point.
    expect(profile.summary).toMatch(/^Read \d+ of their own recent replies to learn the voice\./);
  });

  it("captures their actual writing as the voice source, longest first", () => {
    const profile = deriveAccountProfile(parseRedditUserFeed(FEED), NOW);
    expect(profile.samples).toHaveLength(2);
    // Longest first, and the HTML is stripped to their plain words with the
    // paragraph break preserved.
    expect(profile.samples[0]).toBe(
      "The problem is not a missing channel. You are running eight at once, so none gets enough attention to tell you whether it works.\n\nCut to the one that is pulling and go deeper.",
    );
    expect(profile.samples[1]).toContain("nobody owning the decision");
    // A one-word acknowledgement teaches nothing about voice and is dropped.
    expect(profile.samples.some((s) => s === "short")).toBe(false);
  });

  it("says the voice is coming from brand docs when there is nothing to learn from", () => {
    const terse = parseRedditUserFeed(FEED).map((i) => ({ ...i, text: "ok" }));
    const profile = deriveAccountProfile(terse, NOW);
    expect(profile.samples).toEqual([]);
    expect(profile.summary).toMatch(/no substantial writing/i);
    expect(profile.summary).toMatch(/brand docs/i);
  });

  it("treats no public activity as no usable history, the safe direction", () => {
    const profile = deriveAccountProfile([], NOW);
    expect(profile.itemCount).toBe(0);
    expect(profile.subreddits).toEqual([]);
    expect(profile.samples).toEqual([]);
    expect(profile.summary).toMatch(/no usable history/i);
    expect(profile.summary).toMatch(/value-only/i);
  });

  it("describes recency without pretending to precision", () => {
    const stale = parseRedditUserFeed(FEED).map((i) => ({ ...i, at: i.at - 200 * 24 * 3600 * 1000 }));
    expect(deriveAccountProfile(stale, NOW).summary).toMatch(/last active about \d+ months ago/);

    const fresh = parseRedditUserFeed(FEED).map((i) => ({ ...i, at: NOW - 2 * 24 * 3600 * 1000 }));
    expect(deriveAccountProfile(fresh, NOW).summary).toContain("active this week");
  });

  it("never divides by zero when every item shares one timestamp", () => {
    const sameInstant = parseRedditUserFeed(FEED).map((i) => ({ ...i, at: NOW }));
    const profile = deriveAccountProfile(sameInstant, NOW);
    expect(Number.isFinite(profile.perWeek!)).toBe(true);
    expect(profile.perWeek!).toBeGreaterThan(0);
  });
});
