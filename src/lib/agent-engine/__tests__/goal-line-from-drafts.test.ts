import { describe, expect, it, vi } from "vitest";

/**
 * SCRUM-474 — D11's line reaching the client's card on the three DRAFTING
 * agents, which is the half PR #140 (the visual agents) did not cover.
 *
 * The bug was not that nothing carried the line. It was that two surfaces read
 * it from two places and disagreed. `materialize.ts` listed
 * `goal`/`audience`/`whyNow` in X's and LinkedIn's `metaFields` and `whyThread`
 * in Reddit's — deliverable fields the C7 §3 contract does not promise for
 * these products. The engine resolves the line once and writes it into the
 * DRAFTS STRING; the deliverable's own fields are `optional()` and hold only
 * what the model happened to state, and Reddit's deliverable names the fact
 * `whyThisThread`, which nothing in this repo reads. So the modal's block was
 * populated by luck on two agents and never on the third, while the card beside
 * it — parsing the same bullets and the same envelope — was right.
 */
vi.mock("server-only", () => ({}));

import { goalLineFromDraftsEnvelope, goalLineFromDraftsMarkdown } from "@/lib/agent-engine/goal-line-from-drafts";

/** A drafts markdown in the shape `goalLineBullets` writes: `- **Label:** value`. */
const X_DRAFTS = `# X drafts

## Post 1
- **Goal:** show expertise
- **For:** ops leads whose intake breaks in month two
- **Why now:** a benchmark report landed on Monday
- **Lane:** knowledge

Most marketing calendars fail in the second month, not the first.
`;

describe("goalLineFromDraftsMarkdown — the bullets the card already reads", () => {
  it("recovers all three, and stores the funnel WORD rather than the sentence", () => {
    // The bullet says "show expertise"; an Instagram deliverable stores
    // "expertise"; the modal maps the word to "Show expertise". Storing the
    // sentence would put two vocabularies in one field and render one of them
    // uncapitalised.
    expect(goalLineFromDraftsMarkdown(X_DRAFTS)).toEqual({
      goal: "expertise",
      audience: "ops leads whose intake breaks in month two",
      whyNow: "a benchmark report landed on Monday",
    });
  });

  it("maps each of the three funnel sentences back to its word", () => {
    for (const [sentence, word] of [
      ["earn attention", "attention"],
      ["show expertise", "expertise"],
      ["help them decide", "decide"],
    ] as const) {
      expect(goalLineFromDraftsMarkdown(`- **Goal:** ${sentence}`).goal, sentence).toBe(word);
    }
  });

  it("keeps a goal it does not recognise verbatim, because the modal passes an unknown value through", () => {
    // A future prompt that words the line differently must reach the client
    // saying what it said, not vanish because this map is out of date.
    expect(goalLineFromDraftsMarkdown("- **Goal:** start an argument").goal).toBe("start an argument");
  });

  it("takes the FIRST draft's bullets when a markdown carries more than one", () => {
    const two = `## Post 1\n- **Goal:** earn attention\n\n## Post 2\n- **Goal:** help them decide\n`;
    expect(goalLineFromDraftsMarkdown(two).goal).toBe("attention");
  });

  it("parses a bullet whose bold markers are missing", () => {
    expect(goalLineFromDraftsMarkdown("- Goal: earn attention\n- Why now: a launch\n")).toEqual({
      goal: "attention",
      whyNow: "a launch",
    });
  });

  it("returns nothing at all rather than empty rows, for a draft that carries no line", () => {
    // An older prompt version, or a run that resumed mid-flight, legitimately
    // has none of this. An empty labelled row is worse than no row, so the
    // absence has to survive all the way to the modal.
    expect(goalLineFromDraftsMarkdown("## Post 1\n\nJust the post text.\n")).toEqual({});
    expect(goalLineFromDraftsMarkdown("")).toEqual({});
  });

  it("does not mistake a body line for a bullet", () => {
    // The label match is anchored to a list item: prose that happens to contain
    // "Goal:" is the post, not its meta.
    expect(goalLineFromDraftsMarkdown("Our Goal: ship by Friday. That is the post.\n")).toEqual({});
  });
});

describe("goalLineFromDraftsEnvelope — Reddit's v2 slot", () => {
  it("finds whyThread wherever the envelope nests it", () => {
    const envelope = JSON.stringify({
      version: 2,
      account: "acme",
      threads: [{ targetThreadUrl: "https://reddit.com/r/x/1", whyThread: "the thread is asking our exact question" }],
    });
    expect(goalLineFromDraftsEnvelope(envelope)).toEqual({ whyThread: "the thread is asking our exact question" });
  });

  it("finds it at the root too, so a shape change does not silently drop it", () => {
    expect(goalLineFromDraftsEnvelope(JSON.stringify({ whyThread: "live and on topic" }))).toEqual({
      whyThread: "live and on topic",
    });
  });

  it("answers nothing for an envelope it cannot read, and never throws", () => {
    // A materializer that threw here would lose the whole asset over one label.
    expect(goalLineFromDraftsEnvelope("not json at all")).toEqual({});
    expect(goalLineFromDraftsEnvelope("")).toEqual({});
    expect(goalLineFromDraftsEnvelope(JSON.stringify({ threads: [{ whyThread: "   " }] }))).toEqual({});
  });

  it("is bounded, so a deeply nested payload costs nothing", () => {
    let deep: Record<string, unknown> = { whyThread: "too deep to find" };
    for (let i = 0; i < 12; i++) deep = { nested: deep };
    expect(goalLineFromDraftsEnvelope(JSON.stringify(deep))).toEqual({});
  });
});
