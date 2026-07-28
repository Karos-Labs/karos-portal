import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { parseLiDrafts } from "@/lib/li-drafts";
import {
  parseRedditDrafts,
  parseRedditThreadUrl,
  parseRedditUsername,
  parseSubredditList,
  subredditKey,
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
      parseSubredditList("r/SaaS, /r/marketing\nhttps://reddit.com/r/smallbusiness/\nr/saas"),
    ).toEqual(["r/SaaS", "r/marketing", "r/smallbusiness"]);
    expect(parseSubredditList("")).toEqual([]);
  });

  it("reads subreddits out of prose, because the off-limits box invites it", () => {
    // Regression: requiring each comma-piece to be ONLY a name silently
    // discarded any annotated answer. Paired with a caller that reads an empty
    // result as "the client cleared this", that deleted a binding off-limits
    // list. Every one of these used to return [].
    expect(parseSubredditList("r/SEO and r/marketing - I got banned in both")).toEqual([
      "r/SEO",
      "r/marketing",
    ]);
    expect(parseSubredditList("r/SaaS r/marketing r/Entrepreneur")).toEqual([
      "r/SaaS",
      "r/marketing",
      "r/Entrepreneur",
    ]);
    expect(parseSubredditList("r/SaaS; r/marketing")).toEqual(["r/SaaS", "r/marketing"]);
    expect(parseSubredditList("we were banned from r/SEO")).toEqual(["r/SEO"]);
    expect(parseSubredditList("r/politics (banned)")).toEqual(["r/politics"]);
    // Bare names still work when no r/ token appears anywhere.
    expect(parseSubredditList("SaaS, marketing")).toEqual(["r/SaaS", "r/marketing"]);
    // And genuinely unreadable input still yields nothing, so the caller can ask
    // instead of guessing.
    expect(parseSubredditList("anywhere political")).toEqual([]);
  });

  it("caps a runaway paste", () => {
    const many = Array.from({ length: 60 }, (_, i) => `r/sub${i}`).join(", ");
    expect(parseSubredditList(many)).toHaveLength(30);
  });
});

/**
 * The pinned structure has to be reachable from what the agent ACTUALLY writes,
 * not just from a fixture written to match the parser. This case is built from
 * the lab repo's real 2026-07-08 karoslabs launch run
 * (clients/karoslabs/outputs/reddit-agent/2026-07-08-launch-run/client/
 * 01-market-your-saas-focus/{answer.md,about.txt}) — the same thread, URL,
 * subreddit verdict, reply opening, disclosure posture and gate line, re-laid
 * out into the DRAFTS.md structure docs/reddit-agent-portal.md pins.
 *
 * If this breaks, the contract and the real deliverable have drifted apart.
 */
describe("the pinned structure against real lab output", () => {
  const REAL = `# Reddit answer drafts — Karos Labs

## Account 1 · Karos Labs — company account (u/karos-al) · warming
*Account pending nomination; program-wide warming mode.*

### Draft 1 · F1 thorough value answer

- **Thread:** [How do you guys ACTUALLY market your SaaS?](https://www.reddit.com/r/SaaS/comments/1uqssai/how_do_you_guys_actually_market_your_saas/)
- **Subreddit:** r/SaaS — mention-ok when relevant, but self-promotion is capped at once per 60 days per the 2026-04-14 mod announcement
- **Thread posted:** 2026-07-08, same day, live comment field still growing
- **Why this thread:** the existing comments cover an SEO tool stack and video advice, but nobody names the core problem, eight channels at month one with no read on why users convert

> At a month in with 150 users and 5 to 10 a day, the problem is not that you are missing a channel. It is that you are running eight of them at once, so none of them gets enough attention to tell you whether it works. That is the most common way early growth stalls, and the fix is subtraction, not addition.
>
> Before adding ads, do the boring diagnostic first. You already have a real cohort. Ask the last 20 or 30 people who signed up two questions: what were you trying to do when you found us, and what almost stopped you from signing up.

\`2847 chars\`

- **Disclosure:** none needed (warming mode ships value-only, no Karos mention)
- **Why this is safe here:** there is no product mention to delete, so the answer stands on its own; it speaks only from the content-operations and channel-focus pillars, with no invented numbers
- **Gates:** value-first PASS · promo/disclosure PASS · no-AI-tells PASS · earned-claim PASS · culture-fit PASS · freshness PASS
- **Source:** 2026 SaaS-marketing playbooks, verified 2026-07-08 via WebSearch
`;

  it("extracts every field the reader renders", () => {
    const batch = parseRedditDrafts(REAL);
    expect(batch).not.toBeNull();
    const account = batch!.accounts[0];
    expect(account.handle).toBe("u/karos-al");
    expect(account.mode).toBe("warming");

    const draft = account.drafts[0];
    expect(draft.threadTitle).toBe("How do you guys ACTUALLY market your SaaS?");
    expect(draft.threadUrl).toBe(
      "https://www.reddit.com/r/SaaS/comments/1uqssai/how_do_you_guys_actually_market_your_saas",
    );
    expect(draft.subreddit).toBe("r/SaaS");
    // The real r/SaaS verdict is permissive but capped. The note carries the cap
    // so the poster sees it, and the badge stays honest about the verdict.
    expect(draft.verdict).toBe("mention-ok");
    expect(draft.verdictNote).toContain("once per 60 days");
    expect(draft.posted).toContain("2026-07-08");
    expect(draft.whyThread).toContain("eight channels at month one");
    // Both paragraphs of the reply survive, separated, so the clipboard copy is
    // the whole answer and not just the opening.
    expect(draft.text.startsWith("At a month in with 150 users")).toBe(true);
    expect(draft.text).toContain("\n\nBefore adding ads");
    expect(draft.chars).toBe("2847 chars");
    // Warming mode carries no disclosure line, and "none needed" must not render
    // as one.
    expect(draft.disclosure).toBeUndefined();
    expect(draft.whySafe).toContain("no product mention to delete");
    expect(draft.gates).toContain("freshness PASS");
    expect(draft.meta.some((m) => m.startsWith("Source:"))).toBe(true);
  });
});

describe("subredditKey", () => {
  it("folds case so one subreddit cannot split its own tally", () => {
    // The promo-downgrade rule counts outcomes per subreddit. The stored value
    // is free text from parsed agent output, so keying on it raw let "r/SaaS"
    // and "r/saas" count separately and the two-strike downgrade never fire.
    expect(subredditKey("r/SaaS")).toBe(subredditKey("r/saas"));
    expect(subredditKey("r/SaaS")).toBe(subredditKey("SaaS"));
    expect(subredditKey("  /r/SaaS  ")).toBe("saas");
    expect(subredditKey("")).toBe("");
  });
});


/**
 * The rules the X and LinkedIn readers already follow, applied to the Reddit
 * surfaces. Source-level, because these components import server actions (the
 * Admin SDK comes with them) and cannot be mounted in a unit test — the same
 * technique the intake-gate suite uses on the submit cores.
 */
describe("the Reddit reader follows the shared render rules", () => {
  const reader = readFileSync(
    join(process.cwd(), "src/components/reddit-drafts-review.tsx"),
    "utf8",
  );

  it("de-marks every line of lab commentary it prints", () => {
    // The lab writes markdown into these fields; raw ** in front of a client is
    // F70. One assertion per site, so a regression names the field it lost.
    for (const site of [
      "draft.verdictNote ? stripInlineMarkdown(draft.verdictNote)",
      "stripInlineMarkdown(draft.threadTitle)",
      "stripInlineMarkdown(draft.whyThread)",
      "stripInlineMarkdown(draft.laneNote)",
      "stripInlineMarkdown(draft.whySafe)",
      "stripInlineMarkdown(seg.text)",
      "stripInlineMarkdown(acc.note)",
    ]) {
      expect(reader, `missing strip at ${site}`).toContain(site);
    }
  });

  it("leaves the reply body and the disclosure exactly as written", () => {
    // These two are what the client POSTS, and Reddit renders markdown
    // natively — stripping them would change the comment that goes up.
    expect(reader).toContain("{draft.text}");
    expect(reader).toContain("{draft.disclosure}");
    expect(reader).not.toContain("stripInlineMarkdown(draft.text)");
    expect(reader).not.toContain("stripInlineMarkdown(draft.disclosure)");
  });

  it("humanizes the lab's lane vocabulary when it stands in as the title", () => {
    // "Draft 1 · Thorough value answer" is production shorthand. It stays raw
    // in the draftRef the feedback log joins on, and is humanized only here.
    expect(reader).toContain("laneLabel(draft.formula)");
    expect(reader).toContain("const draftRef = `${accountTitle} · ${draft.formula}`");
  });
});

describe("the Reddit intake follows them too", () => {
  const intake = readFileSync(
    join(process.cwd(), "src/components/reddit-agent-intake.tsx"),
    "utf8",
  );

  it("renders a run's state and date through the app's own helpers", () => {
    expect(intake).toContain("<JobStatusBadge status={r.status} />");
    // Staff keep the generation date; a client gets the relative, outcome-worded
    // stamp instead (A3/A4 — four rows carrying one date is the batch tell).
    // intake-run-rows.test.ts owns that split; this pin only holds the
    // formatters, which is what it was written for.
    expect(intake).toContain("`Run ${formatDate(r.createdAt)}`");
    expect(intake).toContain("relativeTime(r.createdAt)");
    // The raw database word and the ISO machine date, both gone.
    expect(intake).not.toContain("· {r.status}");
    expect(intake).not.toContain('new Date(r.createdAt).toISOString()');
  });

  it("sends clients to the archive only for work that reaches it (F28)", () => {
    // F149 filters the client archive to approved, non-future items, so freshly
    // generated work is not there and a client sent looking for it finds an
    // empty page. The copy names the approval step and links the destination —
    // it no longer names the unit the work ships in.
    expect(intake).toContain("Once your Karos team has approved the replies");
    expect(intake).toContain('href="/tasks?tab=archive"');
  });
});

describe("Reddit owns no chain family", () => {
  it("is excluded from chainFamilyForAgent alongside the X agent", () => {
    // A Reddit reply answers a thread that is live NOW: re-dating one to fill a
    // calendar gap posts it into a discussion that has moved on. Reddit also
    // reaches the identity map as a social platform, so without the exclusion
    // it would claim the social family — and a client running Reddit beside
    // Instagram would have one silently owning the other's chain days.
    const src = readFileSync(
      join(process.cwd(), "src/lib/actions/client-agent-actions.ts"),
      "utf8",
    );
    const fn = src.match(/function chainFamilyForAgent[\s\S]*?\n}/)?.[0];
    expect(fn).toBeDefined();
    expect(fn).toContain("isRedditAgentIdentity(agent.key)");
    expect(fn?.indexOf("isRedditAgentIdentity")).toBeLessThan(
      fn?.indexOf("socialPlatformsFor") ?? Infinity,
    );
  });
});

describe("Reddit is registered as an intake-driven agent", () => {
  it("gets a setup entry, so its card cannot compute ready-by-omission", () => {
    const rows = readFileSync(join(process.cwd(), "src/lib/client-agent-rows.ts"), "utf8");
    const fn = rows.slice(rows.indexOf("export async function buildAgentSetup"));
    expect(fn).toContain("isRedditAgentIdentity(agent.key)");
    expect(fn).toContain("hasRedditAgentIntake(clientId)");
    expect(fn).toContain("reddit-agent");
    expect(fn).toContain('"Reddit agent data"');
    // And the pane, so the staff dialog can collect the account form in place.
    expect(fn).toContain('kind: "reddit", data: panes.reddit');
  });

  it("keeps the blurb table and its backfill twin byte-identical", () => {
    // They are twins by construction: the table serves live surfaces, the
    // script writes the same line onto existing docs. A blurb in one and not
    // the other means an agent reads differently depending on when it landed.
    const REDDIT_BLURB =
      "Find the Reddit threads worth joining and get a reply drafted in your voice, one at a time.";
    const table = readFileSync(join(process.cwd(), "src/lib/agent-blurbs.ts"), "utf8");
    const script = readFileSync(join(process.cwd(), "scripts/backfill-agent-blurbs.ts"), "utf8");
    expect(table).toContain(REDDIT_BLURB);
    expect(script).toContain(REDDIT_BLURB);
  });
});

describe("the deliverable's two viewers agree about what it is", () => {
  it("sniffs li -> reddit -> x in the modal, the same order as the card", () => {
    // Reddit and LinkedIn both write "## Account N · …" headings, which contain
    // the X sniff's "# Account " substring, so both must be tested before X or
    // the X reader claims their batches. The modal is the only deliverable
    // viewer a client can reach, so a missing slot there means the client sees
    // raw markdown of a batch staff see as a reader.
    const modal = readFileSync(
      join(process.cwd(), "src/components/asset-detail-modal.tsx"),
      "utf8",
    );
    const li = modal.indexOf('includes("# LinkedIn drafts")');
    const reddit = modal.indexOf('includes("# Reddit answer drafts")');
    const x = modal.indexOf('includes("# Account ")');
    expect(li).toBeGreaterThan(-1);
    expect(reddit).toBeGreaterThan(-1);
    expect(li).toBeLessThan(reddit);
    expect(reddit).toBeLessThan(x);
    // The X sniff is reached only when neither of the other two claimed it.
    expect(modal).toContain("!liBatch && !redditBatch");
    expect(modal).toContain("<RedditDraftsBatch");
  });
});
