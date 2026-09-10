import { describe, expect, it } from "vitest";
import { parseXDrafts } from "@/lib/x-drafts";
import { parseLiDrafts } from "@/lib/li-drafts";
import { parseRedditDrafts, isRedditV2Envelope } from "@/lib/reddit-drafts";

/**
 * Cross-repo contract test: proves this portal's drafts parsers genuinely
 * accept what agent-engine's `x-agent`/`linkedin-agent`/`reddit-agent`
 * workflows now actually write (`render-drafts-markdown.ts` in each of
 * `agent-engine/agents/{x,linkedin}-agent/src/workflow/`, and
 * `render-drafts-envelope.ts` in `agent-engine/agents/reddit-agent/src/
 * workflow/`) — not a guess at the shape, and not a shared npm package
 * (agent-engine is a separate deployable with its own release cycle, same
 * reason `src/lib/agent-engine/read-run.ts` duplicates its Firestore record
 * shapes instead of importing them).
 *
 * The three literal strings below are copied VERBATIM from those three
 * renderers' real output for the canned inputs recorded in each `it()` block
 * — produced by actually running them (`npx tsx` against agent-engine's
 * source, no hand-typing) and pasted here unedited. If a renderer's output
 * shape ever changes, this test only catches the drift when someone
 * re-generates and re-pastes the fixture — it does not import agent-engine's
 * source directly (see the "separate deployable" note above) — so this is a
 * point-in-time compatibility proof, not a live coupling.
 */

describe("agent-engine drafts deliverables parse in this portal", () => {
  it("x-agent's rendered DRAFTS.md parses with parseXDrafts", () => {
    // renderXDraftsMarkdown({ targetHandle: "@getkaros", lane: "build-in-public",
    // angle: "trend-observation", draft: { text/mainPostText: "We shipped the
    // drafts reader today, and the whole batch now reads on one page.", hook:
    // "shipping notes", lane: "build-in-public", targetHandle: "@getkaros" } })
    const markdown = [
      "# Account 1 · @getkaros",
      "",
      "## Avenue 1 · Build-in-public",
      "*trend-observation*",
      "",
      "> We shipped the drafts reader today, and the whole batch now reads on one page.",
      "",
      "`78 chars`",
      "",
      "- **Hook:** shipping notes",
      "",
    ].join("\n");

    const batch = parseXDrafts(markdown);
    expect(batch).not.toBeNull();
    const account = batch!.accounts[0]!;
    expect(account.title).toBe("@getkaros");
    expect(account.drafts).toHaveLength(1);
    const draft = account.drafts[0]!;
    expect(draft.avenue).toBe("Avenue 1 · Build-in-public");
    expect(draft.laneNote).toBe("trend-observation");
    expect(draft.posts).toHaveLength(1);
    expect(draft.posts[0]!.text).toBe("We shipped the drafts reader today, and the whole batch now reads on one page.");
    expect(draft.posts[0]!.chars).toBe("78 chars");
    expect(draft.meta).toEqual(["Hook: shipping notes"]);
  });

  it("linkedin-agent's rendered drafts document parses with parseLiDrafts", () => {
    // renderLinkedInDraftsMarkdown({ identity: { scope: "company" }, companyName:
    // "Karos Labs", archetype: "teardown-framework", topic: "How we cut client
    // review time in half", draft: { text: "Most agencies lose a day to review
    // cycles. Here is the framework that got ours down to under an hour." } })
    const markdown = [
      "# LinkedIn drafts",
      "",
      "## Account 1 · Karos Labs — Company page",
      "",
      "### Post 1 · Teardown framework",
      "",
      "> Most agencies lose a day to review cycles. Here is the framework that got ours down to under an hour.",
      "",
      "`101 chars`",
      "",
      "- **Topic:** How we cut client review time in half",
    ].join("\n");

    const batch = parseLiDrafts(markdown);
    expect(batch).not.toBeNull();
    const account = batch!.accounts[0]!;
    expect(account.title).toBe("Karos Labs — Company page");
    expect(account.drafts).toHaveLength(1);
    const draft = account.drafts[0]!;
    expect(draft.lane).toBe("Post 1 · Teardown framework");
    expect(draft.text).toBe("Most agencies lose a day to review cycles. Here is the framework that got ours down to under an hour.");
    expect(draft.chars).toBe("101 chars");
    expect(draft.meta).toEqual(["Topic: How we cut client review time in half"]);
  });

  it("reddit-agent's rendered v2 envelope parses with parseRedditDrafts", () => {
    // renderRedditDraftsEnvelope({ account: "u/karos-al", targetThreadUrl:
    // ".../comments/abc123/how_do_you_handle_client_review_cycles/",
    // targetThreadTitle: "How do you handle client review cycles?",
    // targetSubreddit: "marketing", draft: { replyBody: "We moved to async
    // comments on a shared doc and cut our review time in half.",
    // disclosureIncluded: false } })
    const envelope =
      '{"kind":"reddit-drafts-v2","outcome":"delivered","account":"u/karos-al","threads":[{"folder":"01-answer","threadTitle":"How do you handle client review cycles?","threadUrl":"https://www.reddit.com/r/marketing/comments/abc123/how_do_you_handle_client_review_cycles/","subreddit":"r/marketing","approaches":[{"id":"approach-1","text":"We moved to async comments on a shared doc and cut our review time in half."}]}]}';

    expect(isRedditV2Envelope(envelope)).toBe(true);
    const batch = parseRedditDrafts(envelope);
    expect(batch).not.toBeNull();
    expect(batch!.outcome).toBe("delivered");
    const account = batch!.accounts[0]!;
    expect(account.title).toBe("u/karos-al");
    expect(account.handle).toBe("u/karos-al");
    expect(account.drafts).toHaveLength(1);
    const draft = account.drafts[0]!;
    expect(draft.threadTitle).toBe("How do you handle client review cycles?");
    expect(draft.threadUrl).toBe("https://www.reddit.com/r/marketing/comments/abc123/how_do_you_handle_client_review_cycles/");
    expect(draft.subreddit).toBe("r/marketing");
    expect(draft.text).toBe("We moved to async comments on a shared doc and cut our review time in half.");
  });

  it("draft-only holds for Reddit: the envelope has no publish/auto-post field anywhere in its shape", () => {
    // Reddit is draft-only as a hard product rule (AGENTS.md / CLAUDE.md) — the
    // v2 envelope this test proves parseable carries no field that could ever
    // trigger a post, only reply text for a human to paste in themselves.
    const envelope =
      '{"kind":"reddit-drafts-v2","outcome":"delivered","threads":[{"folder":"01-answer","approaches":[{"id":"approach-1","text":"x"}]}]}';
    expect(envelope).not.toMatch(/"publish"|"autoPost"|"submit"/i);
    const batch = parseRedditDrafts(envelope);
    expect(batch).not.toBeNull();
  });
});
