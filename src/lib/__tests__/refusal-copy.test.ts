import { describe, expect, it } from "vitest";

import { groupRefusals, summarizeRefusals } from "@/lib/refusal-copy";
import { validateProposal, type CurrentState, type Row } from "@/lib/refresh-apply-core";

/**
 * Refusals have to read as sentences (Albert's second directive).
 *
 * He hit `competitors.create[0]: duplicates the existing row …` and could not
 * tell whether he had done something wrong or the tool had. These tests hold
 * two properties: the grouped copy says what happened and what to do WITHOUT
 * validator vocabulary, and no original line is ever lost — it moves into the
 * technical-detail block, it does not disappear.
 */

/** Anything a reader would have to be a maintainer to parse. */
const DEV_SPEAK = [/\bcompetitors\.(create|update)\[/, /\bdocs\[\d+\]/, /\bclient\.brandingGuidelines\b/, /`\w+`/];

function assertPlainEnglish(text: string) {
  for (const pattern of DEV_SPEAK) expect(text).not.toMatch(pattern);
}

describe("groupRefusals", () => {
  it("turns the exact error Albert hit into a sentence with advice", () => {
    const [group] = groupRefusals([
      'competitors.create[0]: matches 2 existing rows ("Rival Inc", "Other Co") — which one it means is ambiguous, so put it in `update` with the right row\'s id',
    ]);
    expect(group.title).toBe("1 new competitor matches more than one row already in the roster");
    assertPlainEnglish(group.title);
    expect(group.advice).toContain("wrong row could be overwritten");
    // The precise wording survives, one level down.
    expect(group.details).toHaveLength(1);
    expect(group.details[0]).toContain("competitors.create[0]");
  });

  it("counts like problems into one group and pluralises", () => {
    const groups = groupRefusals([
      "competitors.update[0].id: \"a\" is not a competitor of this client — ids come from the export's competitors[].id",
      "competitors.update[1].id: \"b\" is not a competitor of this client — ids come from the export's competitors[].id",
      "competitors.update[2].id: \"c\" is not a competitor of this client — ids come from the export's competitors[].id",
    ]);
    expect(groups).toHaveLength(1);
    expect(groups[0].title).toBe("3 competitor rows point at ids this client does not have");
    expect(groups[0].details).toHaveLength(3);
  });

  it("keeps unrelated problems in separate groups, most important first", () => {
    const groups = groupRefusals([
      "docs[0].content: too long (5 > 4)",
      'clientName: proposal says "X" but c1 is "Y" — refusing to cross-apply',
    ]);
    expect(groups.map((g) => g.title)).toEqual([
      "This bundle is for a different client",
      "1 field has the wrong shape",
    ]);
  });

  it("never drops a line it cannot categorise", () => {
    const groups = groupRefusals(["something entirely new the validator learned to say"]);
    expect(groups).toHaveLength(1);
    expect(groups[0].details).toEqual(["something entirely new the validator learned to say"]);
    expect(groups[0].title).toContain("could not categorise");
  });

  it("puts every input line in exactly one group", () => {
    const errors = [
      "docs[0].tier: would breach the no-leak boundary",
      "docs[1].content: contains the banned placeholder \"data unavailable\"",
      "docs[1].content: drops 2 section(s) (5 → 3). A completion pass never removes a section.",
      "client.brandingGuidelines.dominantColors: usagePct must sum to exactly 100 (CD-E2), got 90",
      "<root>: unknown key \"assets\"",
      "mystery line",
    ];
    const groups = groupRefusals(errors);
    const seen = groups.flatMap((g) => g.details);
    expect(seen).toHaveLength(errors.length);
    expect(new Set(seen)).toEqual(new Set(errors));
  });

  it("summarises for a collapsed card", () => {
    expect(summarizeRefusals(groupRefusals(["docs[0].tier: would breach the no-leak boundary"]))).toBe(
      "1 problem in 1 area. Nothing was written.",
    );
  });

  it("returns nothing for no errors", () => {
    expect(groupRefusals([])).toEqual([]);
  });
});

/* ── Against the real validator, not hand-written strings ────────────── */

describe("the copy covers what the validator actually emits", () => {
  const current = (over: Partial<CurrentState> = {}): CurrentState => ({
    clientId: "client-1",
    clientName: "Acme Co",
    client: {},
    docs: new Map(),
    competitors: [],
    ...over,
  });

  function realErrors(p: Row, c: CurrentState = current()): string[] {
    const res = validateProposal(p, c);
    if (res.ok) throw new Error("expected a refusal");
    return res.errors;
  }

  // The guard that matters over time: a validator message that no rule matches
  // shows up as "could not categorise", which is honest but unhelpful. These
  // pin the common refusals to real, written copy.
  it.each([
    [
      "an internal doc published to the client tier",
      {
        schemaVersion: 1,
        clientId: "client-1",
        docs: [{ docType: "action-plan", tier: "client", content: `---\nt: x\n---\n\n## A\n\n${"word ".repeat(300)}\n\n## B\n\n${"word ".repeat(300)}` }],
      },
      "would be published to the client portal",
    ],
    [
      "a competitor id this client does not own",
      { schemaVersion: 1, clientId: "client-1", competitors: { update: [{ id: "nope", positioning: "x" }] } },
      "ids this client does not have",
    ],
    [
      "an unknown top-level key",
      { schemaVersion: 1, clientId: "client-1", assets: [] },
      "does not store",
    ],
    [
      "a competitor with no usable domain",
      { schemaVersion: 1, clientId: "client-1", competitors: { create: [{ company: "Ghost Co" }] } },
      "missing a usable website",
    ],
  ])("has written copy for %s", (_label, proposal, expected) => {
    const groups = groupRefusals(realErrors(proposal as Row));
    expect(groups.map((g) => g.title).join(" | ")).toContain(expected);
    expect(groups.every((g) => !g.title.includes("could not categorise"))).toBe(true);
  });
});
