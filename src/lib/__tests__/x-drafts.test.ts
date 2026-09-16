import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  classifyXMetaBullet,
  parseXDrafts,
  xIntentUrl,
  xThreadParts,
  xThreadReplies,
  type XParsedDraft,
} from "@/lib/x-drafts";
import { readSource } from "./source-scan";

/**
 * The X drafts structure is pinned in the agent instructions
 * (docs/x-agent-portal.md) — these tests are the contract the instructions,
 * the parser, and the reader all share. The reply/quote target rules carry the
 * most weight: a missed target only costs a plain compose, a wrong one
 * addresses the client's reply at somebody else's post.
 */

const BATCH = `# Account 1 · Company page @getkaros
*Brand voice: measured, no hype.*

## Avenue 1 · Build-in-public
*Shipping notes, evergreen.*

**1/2**

> We shipped the drafts reader today.

\`36 chars\`

**2/2**

> The whole batch reads on one page now.

\`38 chars\`

- **Source:** market-strategy.md section 3

## Avenue 2 · Reply

> Agreed, and the pricing part is the tell.

\`41 chars\`

- **In reply to:** https://x.com/patio11/status/1790000000000000001
`;

/** A one-draft batch whose single meta bullet is the thing under test. */
function draftWithMeta(bullet: string): XParsedDraft {
  const batch = parseXDrafts(
    [
      "# Account 1 · Company page @getkaros",
      "",
      "## Avenue 1 · Reply",
      "",
      "> Agreed, and the pricing part is the tell.",
      "",
      "`41 chars`",
      "",
      `- ${bullet}`,
    ].join("\n"),
  );
  return batch!.accounts[0].drafts[0];
}

describe("parseXDrafts", () => {
  it("parses the pinned structure: accounts, avenues, threads, chars, meta", () => {
    const batch = parseXDrafts(BATCH);
    expect(batch).not.toBeNull();
    expect(batch!.accounts).toHaveLength(1);

    const account = batch!.accounts[0];
    expect(account.title).toBe("Company page @getkaros");
    expect(account.note).toBe("Brand voice: measured, no hype.");
    expect(account.drafts).toHaveLength(2);

    const [thread, reply] = account.drafts;
    expect(thread.avenue).toBe("Avenue 1 · Build-in-public");
    expect(thread.laneNote).toBe("Shipping notes, evergreen.");
    expect(thread.posts.map((p) => p.marker)).toEqual(["1/2", "2/2"]);
    expect(thread.posts[0].text).toBe("We shipped the drafts reader today.");
    expect(thread.posts[0].chars).toBe("36 chars");
    expect(thread.meta).toEqual(["Source: market-strategy.md section 3"]);
    expect(thread.replyToUrl).toBeUndefined();

    expect(reply.replyToUrl).toBe("https://x.com/patio11/status/1790000000000000001");
    expect(reply.quoteUrl).toBeUndefined();
  });

  it("takes reply targets from labelled bullets on either host", () => {
    expect(draftWithMeta("**In reply to:** https://x.com/patio11/status/1790000000000000001").replyToUrl).toBe(
      "https://x.com/patio11/status/1790000000000000001",
    );
    expect(draftWithMeta("**Reply to:** https://twitter.com/patio11/status/1790000000000000002").replyToUrl).toBe(
      "https://twitter.com/patio11/status/1790000000000000002",
    );
    expect(
      draftWithMeta("**Reply target:** https://www.x.com/patio11/status/1790000000000000003").replyToUrl,
    ).toBe("https://www.x.com/patio11/status/1790000000000000003");
    expect(
      draftWithMeta("**Target:** replying to https://x.com/patio11/status/1790000000000000004").replyToUrl,
    ).toBe("https://x.com/patio11/status/1790000000000000004");
  });

  it("takes quote targets from the labelled variants", () => {
    expect(
      draftWithMeta("**Quote source:** https://x.com/patio11/status/1790000000000000005").quoteUrl,
    ).toBe("https://x.com/patio11/status/1790000000000000005");
    expect(draftWithMeta("**Quoting:** https://twitter.com/patio11/status/1790000000000000006").quoteUrl).toBe(
      "https://twitter.com/patio11/status/1790000000000000006",
    );
    expect(
      draftWithMeta("**Grounding:** quoted post https://x.com/patio11/status/1790000000000000007").quoteUrl,
    ).toBe("https://x.com/patio11/status/1790000000000000007");
    expect(draftWithMeta("**Quote source:** https://x.com/patio11/status/17").replyToUrl).toBeUndefined();
  });

  it("lets an explicit label beat prose elsewhere in the bullet", () => {
    // The phrases match anywhere in the bullet, so an aside about replying must
    // not re-aim a labelled quote source at the post it quotes: that would
    // address the client's reply at that post AND drop the quoted URL.
    const quote = draftWithMeta(
      "**Quote source:** https://x.com/acme/status/1790000000000000012 (replying to their pricing thread)",
    );
    expect(quote.quoteUrl).toBe("https://x.com/acme/status/1790000000000000012");
    expect(quote.replyToUrl).toBeUndefined();
    const url = new URL(xIntentUrl(quote, "The tell is the pricing."));
    expect(url.searchParams.get("text")).toBe(
      "The tell is the pricing.\n\nhttps://x.com/acme/status/1790000000000000012",
    );
    expect(url.searchParams.get("in_reply_to")).toBeNull();

    const reply = draftWithMeta(
      "**Reply target:** https://twitter.com/acme/status/1790000000000000013 — a reply, not a quoted post",
    );
    expect(reply.replyToUrl).toBe("https://twitter.com/acme/status/1790000000000000013");
    expect(reply.quoteUrl).toBeUndefined();
  });

  it("never reads a target out of an unlabelled URL or a source bullet", () => {
    const bare = draftWithMeta("https://x.com/patio11/status/1790000000000000008");
    expect(bare.replyToUrl).toBeUndefined();
    expect(bare.quoteUrl).toBeUndefined();

    const source = draftWithMeta(
      "**Source:** a reply by @patio11 — https://x.com/patio11/status/1790000000000000009",
    );
    expect(source.replyToUrl).toBeUndefined();
    expect(source.quoteUrl).toBeUndefined();
    // The bullet is still shown to the client either way.
    expect(source.meta).toHaveLength(1);
  });

  it("keeps the first labelled target when several bullets carry a status URL", () => {
    const batch = parseXDrafts(
      [
        "# Account 1 · Company page @getkaros",
        "",
        "## Avenue 1 · Reply",
        "",
        "> Agreed, and the pricing part is the tell.",
        "",
        "- **In reply to:** https://x.com/patio11/status/1790000000000000010",
        "- **In reply to:** https://x.com/someone/status/1790000000000000011",
      ].join("\n"),
    );
    expect(batch!.accounts[0].drafts[0].replyToUrl).toBe(
      "https://x.com/patio11/status/1790000000000000010",
    );
  });

  it("returns null when the shape isn't there", () => {
    expect(parseXDrafts("Just some prose about X.")).toBeNull();
    expect(parseXDrafts("# Account 1 · Company page @getkaros\n\nNothing drafted.")).toBeNull();
  });
});

describe("xIntentUrl", () => {
  const reply: XParsedDraft = {
    avenue: "Avenue 2 · Reply",
    posts: [{ text: "Agreed." }],
    meta: [],
    replyToUrl: "https://twitter.com/patio11/status/1790000000000000001",
  };

  it("addresses the reply under both intent param names", () => {
    const url = new URL(xIntentUrl(reply, "Agreed, and the pricing part is the tell."));
    expect(url.origin + url.pathname).toBe("https://x.com/intent/post");
    expect(url.searchParams.get("text")).toBe("Agreed, and the pricing part is the tell.");
    expect(url.searchParams.get("in_reply_to")).toBe("1790000000000000001");
    expect(url.searchParams.get("in_reply_to_status_id")).toBe("1790000000000000001");
  });

  it("appends the quoted post to the text and addresses nothing", () => {
    const quote: XParsedDraft = {
      avenue: "Avenue 3 · Quote-comment",
      posts: [{ text: "The tell is the pricing." }],
      meta: [],
      quoteUrl: "https://x.com/patio11/status/1790000000000000005",
    };
    const url = new URL(xIntentUrl(quote, "The tell is the pricing."));
    expect(url.searchParams.get("text")).toBe(
      "The tell is the pricing.\n\nhttps://x.com/patio11/status/1790000000000000005",
    );
    expect(url.searchParams.get("in_reply_to")).toBeNull();
    expect(url.searchParams.get("in_reply_to_status_id")).toBeNull();
  });

  it("carries only the text for a plain post", () => {
    const plain: XParsedDraft = { avenue: "Avenue 1 · Build-in-public", posts: [], meta: [] };
    const url = new URL(xIntentUrl(plain, "We shipped the drafts reader today."));
    expect([...url.searchParams.keys()]).toEqual(["text"]);
  });
});

/**
 * C3, 2026-09-15. A client was shown a Notion page presented as the post their
 * reply answered: the bullet said "First reply", the reader linked every URL it
 * found, and nothing checked the URL was an X post at all. The parser's target
 * rules were already right — they never made it a `replyToUrl` — so the fix is
 * about what the READER may print, which is what this classification decides.
 */
describe("classifyXMetaBullet", () => {
  /** What the reader prints for a bullet: its label, if any, then its words. */
  const rendered = (bullet: string) => {
    const meta = classifyXMetaBullet(bullet);
    return (meta.label ? `${meta.label}: ` : "") + meta.text;
  };

  it("keeps a labelled X post as the target it is, words and all", () => {
    const reply = classifyXMetaBullet("**In reply to:** https://x.com/patio11/status/1790000000000000001");
    expect(reply.kind).toBe("reply-target");
    expect(reply.url).toBe("https://x.com/patio11/status/1790000000000000001");
    expect(reply.label).toBeUndefined();
    expect(reply.text).toBe("In reply to: https://x.com/patio11/status/1790000000000000001");

    const quote = classifyXMetaBullet("**Quote source:** https://twitter.com/acme/status/1790000000000000005");
    expect(quote.kind).toBe("quote-target");
    expect(quote.url).toBe("https://twitter.com/acme/status/1790000000000000005");
    expect(quote.label).toBeUndefined();
  });

  it("calls a reply-labelled bullet a source when its URL is not an X post", () => {
    // THE BUG: "First reply" is not even a target label (in a thread it names
    // the draft's own second post), and a Notion page cannot be replied to.
    for (const bullet of [
      "**First reply:** https://www.notion.so/Launch-notes-2f41",
      "**Reply URL:** https://www.notion.so/Launch-notes-2f41",
      "**In reply to:** https://www.notion.so/Launch-notes-2f41",
    ]) {
      const meta = classifyXMetaBullet(bullet);
      expect(meta.kind, bullet).toBe("source");
      expect(meta.url, bullet).toBe("https://www.notion.so/Launch-notes-2f41");
      // The label is what lied, so the label is what goes: the reader prints
      // "Source: <link>" and the link still opens.
      expect(meta.label, bullet).toBe("Source");
      expect(meta.text, bullet).toBe("https://www.notion.so/Launch-notes-2f41");
    }
  });

  it("drops a reply phrase the same way when the bullet carries no label", () => {
    const meta = classifyXMetaBullet("replying to https://example.com/pricing-teardown");
    expect(meta.kind).toBe("source");
    expect(meta.label).toBe("Source");
    expect(meta.text).toBe("https://example.com/pricing-teardown");
  });

  it("keeps the words around the link when only the label was wrong", () => {
    const meta = classifyXMetaBullet("**First reply:** the Q3 launch note, https://notion.so/q3 section 4");
    expect(meta.kind).toBe("source");
    expect(meta.label).toBe("Source");
    expect(meta.text).toBe("the Q3 launch note, https://notion.so/q3 section 4");
  });

  it("leaves an honest bullet exactly as written", () => {
    const source = classifyXMetaBullet(
      "**Source:** a reply by @patio11 — https://x.com/patio11/status/1790000000000000009",
    );
    expect(source.kind).toBe("source");
    expect(source.label).toBeUndefined();
    expect(source.text).toBe(
      "Source: a reply by @patio11 — https://x.com/patio11/status/1790000000000000009",
    );

    const grounding = classifyXMetaBullet("**Grounding:** https://karoslabs.io/blog/pricing");
    expect(grounding.kind).toBe("source");
    expect(grounding.label).toBeUndefined();
    expect(grounding.url).toBe("https://karoslabs.io/blog/pricing");
  });

  it("calls a bullet with no URL a note, whatever it says", () => {
    const note = classifyXMetaBullet("**Source:** market-strategy.md section 3");
    expect(note.kind).toBe("note");
    expect(note.url).toBeUndefined();
    expect(note.label).toBeUndefined();
    expect(note.text).toBe("Source: market-strategy.md section 3");

    const none = classifyXMetaBullet("**First reply:** none planned");
    expect(none.kind).toBe("note");
    expect(none.label).toBeUndefined();
  });

  it("keeps a real X post named under a label that is not a target", () => {
    // The deliberate pass-through: "first reply" names the draft's own second
    // post, so it addresses nothing — but the link IS an X post, so the bullet's
    // words are true and it is shown as written.
    const meta = classifyXMetaBullet("**First reply:** https://x.com/acme/status/1790000000000000001");
    expect(meta.kind).toBe("source");
    expect(meta.label).toBeUndefined();
    expect(meta.text).toBe("First reply: https://x.com/acme/status/1790000000000000001");
  });

  it("judges the URL the claim governs, not any X post further along", () => {
    // The link under the reply label is the one that would read as the post
    // this draft answers; an X post named later in the bullet cannot vouch for
    // it.
    const mixed = classifyXMetaBullet(
      "**Reply:** https://example.com/a — quoted from https://x.com/a/status/12345",
    );
    expect(mixed.kind).toBe("source");
    expect(mixed.url).toBe("https://example.com/a");
    expect(mixed.label).toBe("Source");
    expect(mixed.text).toBe("https://example.com/a — quoted from https://x.com/a/status/12345");

    const notion = classifyXMetaBullet(
      "**First reply:** https://www.notion.so/Launch-notes-2f41 (thread: https://x.com/acme/status/1790000000000000001)",
    );
    expect(notion.kind).toBe("source");
    expect(notion.label).toBe("Source");
    expect(notion.text).toBe(
      "https://www.notion.so/Launch-notes-2f41 (thread: https://x.com/acme/status/1790000000000000001)",
    );
  });

  it("catches reply wording that never reaches a colon", () => {
    for (const bullet of ["First reply — https://www.notion.so/x", "Reply url https://www.notion.so/x"]) {
      const meta = classifyXMetaBullet(bullet);
      expect(meta.kind, bullet).toBe("source");
      expect(meta.label, bullet).toBe("Source");
      expect(meta.text, bullet).toBe("https://www.notion.so/x");
    }
  });

  it("prints one label, never a Source over the bullet's own", () => {
    // The label was honest and the reply wording is the sentence's, so both
    // stay: a second label in front would read "Source: Source: …".
    const source = rendered("**Source:** in reply to a thread at https://example.com/x");
    expect(source).toBe("Source: in reply to a thread at https://example.com/x");
    expect(source.match(/Source:/g)).toHaveLength(1);

    expect(rendered("**Context:** replying to the launch thread — https://notion.so/launch")).toBe(
      "Context: replying to the launch thread — https://notion.so/launch",
    );
  });

  it("never cuts words out of a sentence to fix a label", () => {
    // Wording mid-clause is the agent describing the draft. Deleting it leaves
    // broken English in front of a client, which is worse than the label it was
    // meant to fix.
    const angle = classifyXMetaBullet(
      "**Angle:** what to say when replying to critics, per https://notion.so/tone",
    );
    expect(angle.kind).toBe("source");
    expect(angle.label).toBeUndefined();
    expect(angle.text).toBe("Angle: what to say when replying to critics, per https://notion.so/tone");

    expect(rendered("**Why now:** we are replying to https://example.com/story")).toBe(
      "Why now: we are replying to https://example.com/story",
    );
  });

  it("leaves a label that merely contains the word alone", () => {
    // "Quote of the week" is not a quote target, and swapping it for "Source"
    // would throw away the only words the bullet had.
    for (const [bullet, shown] of [
      ["**Quote of the week:** https://example.com/q", "Quote of the week: https://example.com/q"],
      ["**Reply rate:** https://example.com/metrics", "Reply rate: https://example.com/metrics"],
      ["**Replies to date:** https://example.com/metrics", "Replies to date: https://example.com/metrics"],
    ]) {
      const meta = classifyXMetaBullet(bullet);
      expect(meta.kind, bullet).toBe("source");
      expect(meta.label, bullet).toBeUndefined();
      expect(rendered(bullet), bullet).toBe(shown);
    }
  });

  it("agrees with the parser: a mislabelled bullet addresses nothing", () => {
    const draft = draftWithMeta("**First reply:** https://www.notion.so/Launch-notes-2f41");
    expect(draft.replyToUrl).toBeUndefined();
    expect(draft.quoteUrl).toBeUndefined();
    expect(classifyXMetaBullet(draft.meta[0]).kind).toBe("source");
  });
});

/**
 * The engine sends an X thread's parts as `meta.thread` (materializeXPost's
 * metaFields) even when the DRAFTS.md holds the opener alone, so the reader can
 * show the chain from either source. The element shape is the engine's, not
 * ours — hence the tolerance, and the refusal to guess past it.
 */
describe("xThreadParts", () => {
  it("reads plain strings and the engine's post objects", () => {
    expect(xThreadParts(["one", "two"])).toEqual(["one", "two"]);
    expect(xThreadParts([{ text: "one" }, { post: "two" }])).toEqual(["one", "two"]);
  });

  it("ignores blanks and anything it cannot read as a post", () => {
    expect(xThreadParts(["one", "   ", 7, null, { chars: 12 }, { text: "two" }])).toEqual([
      "one",
      "two",
    ]);
    expect(xThreadParts(undefined)).toEqual([]);
    expect(xThreadParts("one\n\ntwo")).toEqual([]);
    expect(xThreadParts({ 0: "one" })).toEqual([]);
  });

  it("de-marks each part exactly as the parser de-marks a post", () => {
    // These render beside posts the parser produced and the clipboard hands
    // them to X, where `**` is two asterisks in the client's post.
    expect(xThreadParts(["**Part two.** stays bold", "   Part three.  "])).toEqual([
      "Part two. stays bold",
      "Part three.",
    ]);
  });
});

describe("xThreadReplies", () => {
  const main = "We shipped the drafts reader today.";

  it("drops the opener when the chain restates it", () => {
    expect(xThreadReplies([main, "Here is what changed.", "And why."], main)).toEqual([
      "Here is what changed.",
      "And why.",
    ]);
    // Bold and stray whitespace are the deliverable's, not a different post.
    expect(xThreadReplies([`**${main}**  `, "Here is what changed."], main)).toEqual([
      "Here is what changed.",
    ]);
  });

  it("keeps every part when the chain is the replies alone", () => {
    expect(xThreadReplies(["Here is what changed.", "And why."], main)).toEqual([
      "Here is what changed.",
      "And why.",
    ]);
    expect(xThreadReplies([], main)).toEqual([]);
    expect(xThreadReplies([main], main)).toEqual([]);
  });

  it("drops an opener that drifted rather than showing the post twice", () => {
    // The engine's copy and the markdown's are the same post whenever one of
    // them gained a full stop, a hashtag, a link or a normalized dash.
    for (const opener of [
      `${main} `,
      "We shipped the drafts reader today",
      `${main} #shipping`,
      `${main} https://karoslabs.io/blog/x-reader`,
      "We shipped the drafts reader today…",
    ]) {
      expect(xThreadReplies([opener, "Here is what changed."], main), opener).toEqual([
        "Here is what changed.",
      ]);
    }
    expect(
      xThreadReplies(["Pricing — the tell", "And why."], "Pricing – the tell."),
    ).toEqual(["And why."]);
  });

  it("keeps a reply that only opens with the post's words", () => {
    // A duplicate is visible to the client; a reply quietly swallowed is not.
    const echo = `${main} And here is the whole story of why we did it, at length and in detail.`;
    expect(xThreadReplies([echo, "And why."], main)).toEqual([echo, "And why."]);
    expect(xThreadReplies(["We shipped.", "And why."], "We shipped. Eventually.")).toEqual([
      "We shipped.",
      "And why.",
    ]);
  });
});

/**
 * Reader rules, asserted on the source: the component imports a server action
 * (the Admin SDK comes with it) and cannot be mounted in a unit test — the same
 * technique the Reddit and intake-gate suites use.
 */
describe("the X reader shows a thread as a post with its replies", () => {
  const reader = readSource(join(process.cwd(), "src/components/x-drafts-review.tsx"));

  it("classifies every meta bullet instead of linking whatever it finds", () => {
    expect(reader).toContain("const bullet = classifyXMetaBullet(m);");
    expect(reader).toContain("splitMetaLinks(bullet.text)");
    // The old render fed the raw bullet straight to the linker.
    expect(reader).not.toContain("splitMetaLinks(m)");
  });

  it("hangs parts 2..n under the post as one indented chain", () => {
    expect(reader).toContain("const mainPost = draft.posts[0];");
    expect(reader).toContain("draft.posts.slice(1)");
    expect(reader).toContain("xThreadReplies(thread, mainPost.text)");
    expect(reader).toContain("Reply {i + 1}");
    expect(reader).toContain("border-l border-border pl-4");
    // The lab's "1/3" numbering across N equal cards is what it replaces.
    expect(reader).not.toContain("{post.marker}");
  });

  it("keeps the character counts and the reader's own copy rules", () => {
    expect(reader).toContain("charLabel(mainPost.chars)");
    expect(reader).toContain("charLabel(post.chars)");
    expect(reader).toContain("normalizeDashes(stripInlineMarkdown(seg.text))");
    expect(reader).toContain("normalizeDashes(stripInlineMarkdown(draft.laneNote))");
  });

  it("deep-links the first post only", () => {
    // X's compose takes one post; the replies ride the clipboard, which is why
    // the whole chain is what gets copied.
    expect(reader).toContain('(mainPost?.text ?? "")');
    expect(reader).toContain('const fullText = chain.map((p) => p.text).join("\\n\\n");');
    expect(reader).toContain("xIntentUrl(draft, composeText)");
  });

  it("takes the engine's chain only when one draft can own it", () => {
    expect(reader).toContain("totalDrafts === 1 && thread && thread.length > 0");
  });
});
