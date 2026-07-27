import { describe, expect, it } from "vitest";
import { parseLiDrafts } from "@/lib/li-drafts";
import {
  parseRedditDrafts,
  parseRedditThreadUrl,
  parseRedditUsername,
  parseSubredditList,
} from "@/lib/reddit-drafts";
import { parseXDrafts } from "@/lib/x-drafts";

/**
 * The Reddit drafts structure is pinned in the agent instructions
 * (docs/reddit-agent-portal.md) — these tests are the contract the
 * instructions, the parser, and the reader all share. If one changes, the
 * others must change with it.
 */

const BATCH = `# Reddit answer drafts — Karos Labs

## Account 1 · Karos Labs — company account (u/karos-al) · warming
*Value-only program-wide until the account earns history.*

### Draft 1 · Thorough value answer
*P5 early growth, the account's earned lane.*

- **Thread:** [How do you guys ACTUALLY market your SaaS?](https://www.reddit.com/r/SaaS/comments/1uqssai/how_do_you_guys_actually_market_your_saas/)
- **Subreddit:** r/SaaS — mention-ok when relevant, capped once per 60 days
- **Thread posted:** 2026-07-08, same-day and active
- **Why this thread:** nobody names the core problem — eight channels at month one with no read on why users convert

> At a month in with 150 users, the problem is not a missing channel. It is running eight at once, so none gets enough attention to tell you whether it works.
>
> The fix is subtraction, not addition.

\`742 chars\`

- **Disclosure:** none needed (no mention in this draft)
- **Why this is safe here:** pure value, no product mention, no links, speaks only from the earned pillar
- **Gates:** value-first PASS · promo/disclosure PASS · no-AI-tells PASS · earned-claim PASS
- **Source:** 2026 SaaS-marketing playbooks, verified 2026-07-08

### Draft 2 · Comparison answer

- **Thread:** [Agency vs in-house for a seed-stage team?](https://old.reddit.com/r/Entrepreneur/comments/1up7a5a/agency_vs_inhouse/)
- **Subreddit:** r/Entrepreneur — value-only, never mention, bans AI-sounding content
- **Disclosure:** I run a small marketing shop, so treat this as an interested view.

> Both options fail the same way, which is nobody owning the decision.

\`68 chars\`
`;

describe("parseRedditDrafts", () => {
  it("parses the pinned structure: accounts, drafts, thread, subreddit, verdict, gates", () => {
    const batch = parseRedditDrafts(BATCH);
    expect(batch).not.toBeNull();
    expect(batch!.accounts).toHaveLength(1);

    const account = batch!.accounts[0];
    expect(account.title).toBe("Karos Labs — company account (u/karos-al) · warming");
    expect(account.handle).toBe("u/karos-al");
    expect(account.mode).toBe("warming");
    expect(account.note).toBe("Value-only program-wide until the account earns history.");
    expect(account.drafts).toHaveLength(2);

    const [first, second] = account.drafts;
    expect(first.formula).toBe("Draft 1 · Thorough value answer");
    expect(first.laneNote).toBe("P5 early growth, the account's earned lane.");
    expect(first.threadTitle).toBe("How do you guys ACTUALLY market your SaaS?");
    expect(first.threadUrl).toBe(
      "https://www.reddit.com/r/SaaS/comments/1uqssai/how_do_you_guys_actually_market_your_saas",
    );
    expect(first.subreddit).toBe("r/SaaS");
    expect(first.verdict).toBe("mention-ok");
    expect(first.posted).toBe("2026-07-08, same-day and active");
    expect(first.whyThread).toContain("eight channels at month one");
    expect(first.text).toBe(
      "At a month in with 150 users, the problem is not a missing channel. It is running eight at once, so none gets enough attention to tell you whether it works.\n\nThe fix is subtraction, not addition.",
    );
    expect(first.chars).toBe("742 chars");
    expect(first.whySafe).toContain("pure value");
    expect(first.gates).toContain("value-first PASS");
    expect(first.meta.some((m) => m.startsWith("Source:"))).toBe(true);

    // "none needed" is an answer, not a disclosure line — the reader must not
    // render it as one.
    expect(first.disclosure).toBeUndefined();
    expect(second.disclosure).toBe("I run a small marketing shop, so treat this as an interested view.");
    // value-only wins even though the note also contains the word "mention".
    expect(second.verdict).toBe("value-only");
    expect(second.subreddit).toBe("r/Entrepreneur");
    // An old.reddit.com thread is normalized to the canonical host.
    expect(second.threadUrl).toBe("https://www.reddit.com/r/Entrepreneur/comments/1up7a5a/agency_vs_inhouse");
  });

  it("returns null without the pinned title or without any draft", () => {
    expect(parseRedditDrafts("## Account 1 · Nope\n\n### Draft 1 · X\n\n> text")).toBeNull();
    expect(parseRedditDrafts("# Reddit answer drafts — empty\n\nNothing here.")).toBeNull();
  });

  it("ends the account scope at a non-account h2 — no phantom drafts from trailing sections", () => {
    const withNotes = `${BATCH}\n## Notes\n\n### Open question\n\n> Not a draft - a question for the client.\n`;
    const batch = parseRedditDrafts(withNotes);
    expect(batch!.accounts).toHaveLength(1);
    expect(batch!.accounts[0].drafts).toHaveLength(2);
  });

  it("leaves the verdict undefined when no bullet names one, rather than guessing permissive", () => {
    const vague = BATCH.replace(
      "- **Subreddit:** r/SaaS — mention-ok when relevant, capped once per 60 days",
      "- **Subreddit:** r/SaaS",
    );
    const draft = parseRedditDrafts(vague)!.accounts[0].drafts[0];
    expect(draft.subreddit).toBe("r/SaaS");
    expect(draft.verdict).toBeUndefined();
  });

  it("keeps the three agent formats from claiming each other's batches", () => {
    const xBatch = [
      "# Account 1 · Company page @getkaros",
      "",
      "## Avenue 1 · Build-in-public",
      "",
      "> Shipping the thing.",
      "",
      "`21 chars`",
    ].join("\n");
    const liBatch = [
      "# LinkedIn drafts — Karos Labs",
      "",
      "## Account 1 · Karos Labs — Company page",
      "",
      "### Post 1 · Thought-leadership",
      "",
      "> Most founders do not need a $250K CMO.",
    ].join("\n");

    expect(parseRedditDrafts(xBatch)).toBeNull();
    expect(parseRedditDrafts(liBatch)).toBeNull();
    expect(parseLiDrafts(BATCH)).toBeNull();
    // THE ORDER RULE: Reddit's "## Account" headings contain the substring
    // "# Account " that asset-card.tsx uses to sniff X batches, so Reddit must
    // be sniffed BEFORE X. The X parser itself is line-anchored at h1 and so
    // refuses the batch — that is the belt to the sniff order's braces.
    expect(parseXDrafts(BATCH)).toBeNull();
  });
});

describe("parseRedditThreadUrl", () => {
  it("accepts reddit hosts and normalizes them", () => {
    expect(parseRedditThreadUrl("https://www.reddit.com/r/SaaS/comments/abc/title/")).toBe(
      "https://www.reddit.com/r/SaaS/comments/abc/title",
    );
    expect(parseRedditThreadUrl("old.reddit.com/r/SaaS/comments/abc")).toBe(
      "https://www.reddit.com/r/SaaS/comments/abc",
    );
    // Tracking suffixes are dropped from a client deliverable.
    expect(parseRedditThreadUrl("https://reddit.com/r/x/comments/abc?utm_source=share#c1")).toBe(
      "https://www.reddit.com/r/x/comments/abc",
    );
  });

  it("refuses anything not on reddit.com — the reader opens this URL in a new tab", () => {
    // The URL comes from model output, so a non-reddit host must yield no link
    // rather than being opened on the client's behalf.
    expect(parseRedditThreadUrl("https://reddit.com.evil.example/r/SaaS/comments/abc")).toBeNull();
    expect(parseRedditThreadUrl("https://notreddit.com/r/SaaS")).toBeNull();
    expect(parseRedditThreadUrl("javascript:alert(1)")).toBeNull();
    expect(parseRedditThreadUrl("")).toBeNull();
    expect(parseRedditThreadUrl("not a url")).toBeNull();
  });
});

describe("parseRedditUsername", () => {
  it("normalizes every shape a client might paste", () => {
    for (const input of [
      "u/karos-al",
      "/u/karos-al",
      "@karos-al",
      "karos-al",
      "https://www.reddit.com/user/karos-al",
      "reddit.com/u/karos-al/",
      "  u/karos-al  ",
    ]) {
      expect(parseRedditUsername(input), input).toBe("u/karos-al");
    }
  });

  it("treats no account yet as null, not an error", () => {
    // The program legitimately runs before an account is nominated: it drafts in
    // warming mode and says nothing can be posted yet.
    for (const input of ["", "   ", "none", "none yet", "pending"]) {
      expect(parseRedditUsername(input), input).toBeNull();
    }
  });

  it("rejects a malformed username rather than attributing drafts to a stranger", () => {
    for (const input of ["a", "ab", "has spaces", "way-too-long-a-username-here", "bad!char"]) {
      const result = parseRedditUsername(input);
      expect(result, input).toHaveProperty("error");
    }
  });
});

describe("parseSubredditList", () => {
  it("normalizes, dedupes and drops junk without failing the save", () => {
    expect(
      parseSubredditList("r/SaaS, /r/marketing\nEntrepreneur\nhttps://reddit.com/r/smallbusiness/\nr/saas, !!"),
    ).toEqual(["r/SaaS", "r/marketing", "r/Entrepreneur", "r/smallbusiness"]);
    expect(parseSubredditList("")).toEqual([]);
  });

  it("caps a runaway paste", () => {
    const many = Array.from({ length: 60 }, (_, i) => `r/sub${i}`).join(", ");
    expect(parseSubredditList(many)).toHaveLength(30);
  });
});
