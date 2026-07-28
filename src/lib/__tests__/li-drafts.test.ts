import { describe, expect, it } from "vitest";
import { parseLiDrafts } from "@/lib/li-drafts";
import { parseXDrafts } from "@/lib/x-drafts";

/**
 * The LinkedIn drafts structure is pinned in the agent instructions
 * (docs/linkedin-agent-portal.md) — these tests are the contract the
 * instructions, the parser, and the reader all share. If one changes, the
 * others must change with it.
 */

const BATCH = `# LinkedIn drafts — Karos Labs

## Account 1 · Karos Labs — Company page
*Brand voice: measured, no hype.*

### Post 1 · Thought-leadership
*The $250K CMO lane, evergreen.*

> Most founders do not need a $250K CMO.
>
> They need the judgment, without the payroll line.

\`412 chars\`

- **Topic:** tl-001 — the $250K CMO vs the AI CMO
- **Media:** karos-labs-250k.pdf · slide-1.png · slide-2.png
- **First comment:** https://karoslabs.com/playbook — the full cost breakdown
- **Source:** market-strategy.md section 3

### Post 2 · Educational

> One idea per post beats ten.

\`29 chars\`

- **Source:** brand-voice.md
`;

describe("parseLiDrafts", () => {
  it("parses the pinned structure: accounts, posts, chars, media, meta", () => {
    const batch = parseLiDrafts(BATCH);
    expect(batch).not.toBeNull();
    expect(batch!.accounts).toHaveLength(1);

    const account = batch!.accounts[0];
    expect(account.title).toBe("Karos Labs — Company page");
    expect(account.note).toBe("Brand voice: measured, no hype.");
    expect(account.drafts).toHaveLength(2);

    const [first, second] = account.drafts;
    expect(first.lane).toBe("Post 1 · Thought-leadership");
    expect(first.laneNote).toBe("The $250K CMO lane, evergreen.");
    expect(first.text).toBe(
      "Most founders do not need a $250K CMO.\n\nThey need the judgment, without the payroll line.",
    );
    expect(first.chars).toBe("412 chars");
    expect(first.mediaNames).toEqual(["karos-labs-250k.pdf", "slide-1.png", "slide-2.png"]);
    expect(first.meta.some((m) => m.startsWith("First comment:"))).toBe(true);
    expect(first.meta.some((m) => m.startsWith("Source:"))).toBe(true);

    expect(second.lane).toBe("Post 2 · Educational");
    expect(second.mediaNames).toEqual([]);
    expect(second.chars).toBe("29 chars");
  });

  it("returns null without the pinned title or without any post", () => {
    expect(parseLiDrafts("## Account 1 · Nope\n\n### Post 1 · Lane\n\n> text")).toBeNull();
    expect(parseLiDrafts("# LinkedIn drafts — empty\n\nNothing here.")).toBeNull();
  });

  it("ends the account scope at a non-account h2 — no phantom drafts from trailing sections", () => {
    const withNotes = `${BATCH}\n## Notes\n\n### Open confirm\n\n> Not a post - a question for the client.\n`;
    const batch = parseLiDrafts(withNotes);
    expect(batch!.accounts).toHaveLength(1);
    expect(batch!.accounts[0].drafts).toHaveLength(2);
  });

  it("parses the optional post-window bullet", () => {
    const withWindow = BATCH.replace(
      "- **Source:** market-strategy.md section 3",
      "- **Post window:** Tue-Thu morning, client timezone\n- **Source:** market-strategy.md section 3",
    );
    const batch = parseLiDrafts(withWindow);
    expect(batch!.accounts[0].drafts[0].postWindow).toBe("Tue-Thu morning, client timezone");
  });

  /**
   * The notes are free text the agent lifted out of its own deliverable, so
   * they carry whatever it wrote there — including the run bookkeeping the
   * summary path already drops. The readers only ever applied
   * `stripInlineMarkdown`, which takes the marks off and leaves the words, so
   * the filter has to be in the parser: one choke point, server and browser.
   */
  it("drops an account or lane note that is run bookkeeping, not prose", () => {
    const leaky = BATCH.replace(
      "*Brand voice: measured, no hype.*",
      "*status: pending_review · product e13 · job e52ffe1e*",
    ).replace("*The $250K CMO lane, evergreen.*", "*run: 2026-07-28-abc12345*");

    const batch = parseLiDrafts(leaky);
    expect(batch!.accounts[0].note).toBeUndefined();
    expect(batch!.accounts[0].drafts[0].laneNote).toBeUndefined();
    // The posts themselves are untouched — this filters notes, not content.
    expect(batch!.accounts[0].drafts[0].text).toContain("Most founders do not need");
  });

  it("keeps a genuine note — the filter is not a blanket drop", () => {
    const batch = parseLiDrafts(BATCH);
    expect(batch!.accounts[0].note).toBe("Brand voice: measured, no hype.");
    expect(batch!.accounts[0].drafts[0].laneNote).toBe("The $250K CMO lane, evergreen.");
  });

  it("the X parser applies the same rule to its own notes", () => {
    const xLeaky = [
      "# Account 1 · Company page @getkaros",
      "*status: pending_review · job e52ffe1e*",
      "",
      "## Avenue 1 · Build-in-public",
      "*Keeps the build visible.*",
      "",
      "> Shipping the thing.",
      "",
      "`21 chars`",
    ].join("\n");
    const batch = parseXDrafts(xLeaky);
    expect(batch!.accounts[0].note).toBeUndefined();
    expect(batch!.accounts[0].drafts[0].laneNote).toBe("Keeps the build visible.");
  });

  it("never claims an X batch, and the X parser never claims a LinkedIn batch", () => {
    const xBatch = [
      "# Account 1 · Company page @getkaros",
      "",
      "## Avenue 1 · Build-in-public",
      "",
      "> Shipping the thing.",
      "",
      "`21 chars`",
    ].join("\n");
    expect(parseLiDrafts(xBatch)).toBeNull();
    // The LinkedIn "## Account" headings contain the substring "# Account "
    // that the asset card uses to sniff X batches — the X parser must not
    // parse them (its heading regex is line-anchored at h1).
    expect(parseXDrafts(BATCH)).toBeNull();
  });
});
