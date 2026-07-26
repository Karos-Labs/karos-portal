import { describe, expect, it } from "vitest";
import { parseXDrafts, xIntentUrl, type XParsedDraft } from "@/lib/x-drafts";

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
