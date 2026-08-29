import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import ts from "typescript";
import { describe, expect, it } from "vitest";
import {
  groupRecommendationsByOwner,
  hasClassifiedOwner,
  KNOWN_ACTION_KINDS,
  KNOWN_ENGINE_PRODUCT_IDS,
  KNOWN_FIX_ACTIONS,
  toRoutableRecommendation,
  type RoutableRecommendation,
} from "../routable-recommendation";

/**
 * [C2] SCRUM-210 coverage — modeled on C5/SCRUM-213's materialize.test.ts
 * `ENGINE_CATALOG` transcription-plus-coverage pattern: this file pins the
 * cross-repo literal contracts (the two canonical unions, and agent-engine's
 * known productId set) and exercises the fail-safe parser + the sprayer.
 */

const SEO_GEO_SRC = resolve(__dirname, "..", "..", "seo-geo.ts");

/**
 * Reads the string-literal members of a `type X = "a" | "b" | ...;` alias
 * declaration straight off the TypeScript AST of the given source TEXT.
 *
 * THIS IS THE FIX for the R1 review finding: the previous version of this
 * suite hand-copied `@/lib/seo-geo`'s `FixAction`/`ActionKind` union members
 * into a second literal array in THIS file, then asserted that array equalled
 * `KNOWN_FIX_ACTIONS`/`KNOWN_ACTION_KINDS` — two independently hand-typed
 * lists compared to each other, never to the real declaration. Verified
 * directly: adding a tenth member to `FixAction` in `seo-geo.ts` changed
 * nothing in that old test file, so nothing failed — neither `vitest run` nor
 * `tsc --noEmit` — and the "pins against seo-geo.ts's own declaration" claim
 * in both the commit message and this file's own prior doc comment was false.
 *
 * Parsing the real file's AST (the same technique
 * `client-model-charge-boundary.test.ts` already uses elsewhere in this repo
 * to read ground truth off source text rather than re-asserting a duplicate)
 * closes that gap: this function's output changes automatically when
 * `seo-geo.ts`'s union changes, with no second copy anywhere to fall
 * out of sync.
 */
function stringUnionMembers(sourceText: string, typeName: string): string[] {
  const source = ts.createSourceFile(SEO_GEO_SRC, sourceText, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS);
  let members: string[] | undefined;
  const visit = (node: ts.Node): void => {
    if (ts.isTypeAliasDeclaration(node) && node.name.text === typeName) {
      const type = node.type;
      // A single-member "union" (ActionKind's four members are still a real
      // UnionTypeNode; only a *one*-literal alias would ever hit the branch
      // below) — kept as a fallback so this helper doesn't silently return
      // undefined if a union ever shrinks to one member.
      if (ts.isUnionTypeNode(type)) {
        members = type.types
          .filter((t): t is ts.LiteralTypeNode => ts.isLiteralTypeNode(t) && ts.isStringLiteral(t.literal))
          .map((t) => (t.literal as ts.StringLiteral).text);
      } else if (ts.isLiteralTypeNode(type) && ts.isStringLiteral(type.literal)) {
        members = [type.literal.text];
      }
    }
    node.forEachChild(visit);
  };
  visit(source);
  if (!members) {
    throw new Error(
      `stringUnionMembers: no string-literal union type alias named "${typeName}" found in the given source — ` +
        `has it been renamed, or restructured into something other than "type ${typeName} = \"a\" | \"b\" | ...;"?`,
    );
  }
  return members;
}

const SEO_GEO_SOURCE_TEXT = readFileSync(SEO_GEO_SRC, "utf8");

describe("the canonical FixAction/ActionKind unions (the cross-repo contract half)", () => {
  it("KNOWN_FIX_ACTIONS is exactly seo-geo.ts's live FixAction union, no more and no less", () => {
    const live = stringUnionMembers(SEO_GEO_SOURCE_TEXT, "FixAction");
    // Non-vacuity: if the AST walk ever silently found nothing (e.g. the type
    // moved into a form this parser doesn't recognize) this comparison would
    // pass by both sides being empty, hiding a real regression in the parser
    // itself rather than in the union.
    expect(live.length).toBeGreaterThan(0);
    expect([...KNOWN_FIX_ACTIONS].sort()).toEqual([...live].sort());
  });

  it("KNOWN_ACTION_KINDS is exactly seo-geo.ts's live ActionKind union, no more and no less", () => {
    const live = stringUnionMembers(SEO_GEO_SOURCE_TEXT, "ActionKind");
    expect(live.length).toBeGreaterThan(0);
    expect([...KNOWN_ACTION_KINDS].sort()).toEqual([...live].sort());
  });

  /**
   * THE PLANTED-NEGATIVE PROOF that the pin above is real, in the same style
   * `client-model-charge-boundary.test.ts` uses: mutate the REAL source TEXT
   * in memory (nothing written to disk), and show the extractor actually
   * notices — which is exactly the failure the R1 version of this file could
   * not produce. This is the test that catches "someone reverted the pin
   * mechanism back to a hand-copied comparison" as surely as it catches "a
   * new FixAction/ActionKind member landed unmirrored".
   */
  it("goes red (would fail) if seo-geo.ts's FixAction union gains a member KNOWN_FIX_ACTIONS doesn't list", () => {
    const planted = SEO_GEO_SOURCE_TEXT.replace('  | "manual";', '  | "manual"\n  | "a_brand_new_fix_action_nobody_added_here";');
    expect(planted, "the FixAction union's exact text shape changed underneath this plant — re-aim it").not.toBe(SEO_GEO_SOURCE_TEXT);

    const live = stringUnionMembers(planted, "FixAction");
    expect(live).toContain("a_brand_new_fix_action_nobody_added_here");
    // The assertion the real test above makes would now fail — proving this
    // suite's pin actually moves when the live union does, rather than
    // comparing two hand-copied lists that can drift together unnoticed.
    expect([...KNOWN_FIX_ACTIONS].sort()).not.toEqual([...live].sort());
  });

  it("goes red (would fail) if seo-geo.ts's ActionKind union gains a member KNOWN_ACTION_KINDS doesn't list", () => {
    const planted = SEO_GEO_SOURCE_TEXT.replace(
      'export type ActionKind = "one_click" | "review_approve" | "connect" | "guided_manual";',
      'export type ActionKind = "one_click" | "review_approve" | "connect" | "guided_manual" | "a_brand_new_action_kind_nobody_added_here";',
    );
    expect(planted, "the ActionKind alias's exact text shape changed underneath this plant — re-aim it").not.toBe(SEO_GEO_SOURCE_TEXT);

    const live = stringUnionMembers(planted, "ActionKind");
    expect(live).toContain("a_brand_new_action_kind_nobody_added_here");
    expect([...KNOWN_ACTION_KINDS].sort()).not.toEqual([...live].sort());
  });

  it("also catches the mirror mistake: a member removed from the live union", () => {
    const planted = SEO_GEO_SOURCE_TEXT.replace('  | "sitemap"\n  | "indexing"\n  | "manual";', '  | "sitemap";');
    expect(planted, "the FixAction union's exact text shape changed underneath this plant — re-aim it").not.toBe(SEO_GEO_SOURCE_TEXT);

    const live = stringUnionMembers(planted, "FixAction");
    expect(live).not.toContain("indexing");
    expect(live).not.toContain("manual");
    expect([...KNOWN_FIX_ACTIONS].sort()).not.toEqual([...live].sort());
  });
});

describe("KNOWN_ENGINE_PRODUCT_IDS (mirrors agent-engine's KNOWN_PRODUCT_IDS)", () => {
  // Transcribed from apps/agent-server/src/wiring/workflows.ts in the
  // agent-engine repo (read directly to verify — 13 entries, tiktok-agent
  // included). Same drift-detection role as materialize.test.ts's
  // ENGINE_CATALOG: this is a point-in-time copy, not a re-derivation — the
  // portal cannot import a type from a separate deployable's repo, unlike
  // FixAction/ActionKind above, which live in THIS repo and so have no excuse
  // for a hand-copied comparison.
  const AGENT_ENGINE_KNOWN_PRODUCT_IDS = [
    "x-agent",
    "instagram-agent",
    "linkedin-agent",
    "reddit-agent",
    "blog-agent",
    "newsletter-agent",
    "campaign-orchestrator",
    "landing-builder-agent",
    "branded-shorts-agent",
    "reputation-agent",
    "seo-geo-agent",
    "intel-report-agent",
    "tiktok-agent",
  ];

  it("matches agent-engine's real KNOWN_PRODUCT_IDS, exactly 13 entries", () => {
    expect([...KNOWN_ENGINE_PRODUCT_IDS].sort()).toEqual([...AGENT_ENGINE_KNOWN_PRODUCT_IDS].sort());
    expect(KNOWN_ENGINE_PRODUCT_IDS).toHaveLength(13);
  });
});

function baseRaw(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    recId: "ZZZ-901",
    recommendation: "A never-before-seen synthetic recommendation.",
    fireState: "fail",
    worstNorm: 0.4,
    scoreLift: 3.2,
    impact: "high",
    effort: "quick",
    delivery: "agent-direct",
    priorityScore: 512,
    hardOverride: false,
    check: "Some failing check description.",
    lever: "SEO",
    productRef: { id: "a3", folder: "seo-geo", status: "live" },
    fixAction: "meta_title",
    actionKind: "one_click",
    ...overrides,
  };
}

describe("toRoutableRecommendation", () => {
  it("parses a fully-shaped record through untouched, preserving what the old wire shape discarded", () => {
    const parsed = toRoutableRecommendation(baseRaw({ owner: "karos_tool", targetPlatform: "search-console" }));
    expect(parsed).toBeDefined();
    expect(parsed).toMatchObject({
      recId: "ZZZ-901",
      recommendation: "A never-before-seen synthetic recommendation.",
      fireState: "fail",
      worstNorm: 0.4,
      scoreLift: 3.2,
      priorityScore: 512,
      hardOverride: false,
      check: "Some failing check description.",
      lever: "SEO",
      productRef: { id: "a3", folder: "seo-geo", status: "live" },
      fixAction: "meta_title",
      actionKind: "one_click",
      owner: "karos_tool",
      targetPlatform: "search-console",
    });
  });

  it("returns undefined for a record with no recId or no recommendation — not even a base FiredRecommendation", () => {
    expect(toRoutableRecommendation({ recommendation: "x" })).toBeUndefined();
    expect(toRoutableRecommendation({ recId: "a" })).toBeUndefined();
    expect(toRoutableRecommendation(null)).toBeUndefined();
    expect(toRoutableRecommendation("not an object")).toBeUndefined();
  });

  it("defaults owner to client_manual when absent — the ticket's fail-safe for an unmapped record", () => {
    const parsed = toRoutableRecommendation(baseRaw());
    expect(parsed?.owner).toBe("client_manual");
    expect(parsed?.engineProductId).toBeUndefined();
  });

  it("defaults owner to client_manual when the wire value is unrecognized", () => {
    const parsed = toRoutableRecommendation(baseRaw({ owner: "something-new-nobody-classified" }));
    expect(parsed?.owner).toBe("client_manual");
  });

  it("keeps owner=karos_agent only when engineProductId is present AND a known engine product", () => {
    const parsed = toRoutableRecommendation(baseRaw({ owner: "karos_agent", engineProductId: "seo-geo-agent" }));
    expect(parsed?.owner).toBe("karos_agent");
    expect(parsed?.engineProductId).toBe("seo-geo-agent");
  });

  it("downgrades karos_agent to client_manual when engineProductId is missing (rule 3, read defensively)", () => {
    const parsed = toRoutableRecommendation(baseRaw({ owner: "karos_agent" }));
    expect(parsed?.owner).toBe("client_manual");
    expect(parsed?.engineProductId).toBeUndefined();
  });

  it("downgrades karos_agent to client_manual when engineProductId is not a KNOWN_ENGINE_PRODUCT_IDS member", () => {
    const parsed = toRoutableRecommendation(baseRaw({ owner: "karos_agent", engineProductId: "not-a-real-product" }));
    expect(parsed?.owner).toBe("client_manual");
    expect(parsed?.engineProductId).toBeUndefined();
  });

  it("never fabricates a fixAction/actionKind the catalog didn't send — falls back to manual/guided_manual", () => {
    const parsed = toRoutableRecommendation(baseRaw({ fixAction: "not-a-real-fix-action", actionKind: "not-a-real-action-kind" }));
    expect(parsed?.fixAction).toBe("manual");
    expect(parsed?.actionKind).toBe("guided_manual");
  });

  it("null-safe productRef: a malformed or absent product_ref becomes null, never a half-filled object", () => {
    expect(toRoutableRecommendation(baseRaw({ productRef: null }))?.productRef).toBeNull();
    expect(toRoutableRecommendation(baseRaw({ productRef: { id: "a3" } }))?.productRef).toBeNull();
    expect(toRoutableRecommendation(baseRaw({ productRef: undefined }))?.productRef).toBeNull();
  });
});

describe("groupRecommendationsByOwner — the sprayer (SCRUM-210 acceptance #3)", () => {
  it("classifies purely off `owner`, proven with recIds this repo has never seen and that match no real catalog entry", () => {
    const recs: RoutableRecommendation[] = [
      toRoutableRecommendation(baseRaw({ recId: "SYN-001", owner: "karos_agent", engineProductId: "x-agent" }))!,
      toRoutableRecommendation(baseRaw({ recId: "SYN-002", owner: "karos_tool" }))!,
      toRoutableRecommendation(baseRaw({ recId: "SYN-003" /* no owner at all */ }))!,
      toRoutableRecommendation(baseRaw({ recId: "SYN-004", owner: "karos_agent", engineProductId: "linkedin-agent" }))!,
    ];
    expect(recs.every(Boolean)).toBe(true);

    const grouped = groupRecommendationsByOwner(recs);
    expect(grouped.karos_agent.map((r) => r.recId).sort()).toEqual(["SYN-001", "SYN-004"]);
    expect(grouped.karos_tool.map((r) => r.recId)).toEqual(["SYN-002"]);
    expect(grouped.client_manual.map((r) => r.recId)).toEqual(["SYN-003"]);
  });

  it("always returns all three buckets, even when empty", () => {
    const grouped = groupRecommendationsByOwner([]);
    expect(grouped).toEqual({ karos_agent: [], karos_tool: [], client_manual: [] });
  });

  it("every karos_agent-bucketed recommendation carries a valid engineProductId (acceptance #2)", () => {
    const recs: RoutableRecommendation[] = [
      toRoutableRecommendation(baseRaw({ recId: "SYN-010", owner: "karos_agent", engineProductId: "blog-agent" }))!,
      toRoutableRecommendation(baseRaw({ recId: "SYN-011", owner: "karos_agent" /* no id -> downgraded */ }))!,
    ];
    const grouped = groupRecommendationsByOwner(recs);
    expect(grouped.karos_agent).toHaveLength(1);
    for (const r of grouped.karos_agent) {
      expect(r.engineProductId).toBeDefined();
      expect(KNOWN_ENGINE_PRODUCT_IDS).toContain(r.engineProductId);
    }
    // The malformed one landed in client_manual instead of vanishing or
    // staying a mis-tagged karos_agent.
    expect(grouped.client_manual.map((r) => r.recId)).toEqual(["SYN-011"]);
  });
});

describe("hasClassifiedOwner (the R1 review's finding #4 fix: distinguishing real data from the fail-safe default)", () => {
  it("is true only for a raw record carrying one of the three recognized owner values", () => {
    expect(hasClassifiedOwner({ owner: "karos_agent" })).toBe(true);
    expect(hasClassifiedOwner({ owner: "karos_tool" })).toBe(true);
    expect(hasClassifiedOwner({ owner: "client_manual" })).toBe(true);
  });

  it("is false for a record with no owner field, an unrecognized one, or not an object at all", () => {
    expect(hasClassifiedOwner({})).toBe(false);
    expect(hasClassifiedOwner({ owner: "something-nobody-classified" })).toBe(false);
    expect(hasClassifiedOwner({ owner: 42 })).toBe(false);
    expect(hasClassifiedOwner(null)).toBe(false);
    expect(hasClassifiedOwner("not an object")).toBe(false);
    expect(hasClassifiedOwner(undefined)).toBe(false);
  });

  it("reflects today's real agent-engine payload shape: none of a bare FiredRecommendation's ten fields count as classified", () => {
    // Exactly the shape create-seo-geo-agent-workflow.ts writes today —
    // verified directly against that file's `firedRecommendations: recommendations`
    // assignment and recommend.ts's FiredRecommendation, neither of which has
    // ever carried an `owner` field.
    const bareFiredRecommendation = {
      recId: "SEO-02",
      recommendation: "Title length, truncation & rewrite-mismatch guard",
      fireState: "fail",
      worstNorm: 0.4,
      scoreLift: 3.2,
      impact: "high",
      effort: "quick",
      delivery: "agent-direct",
      priorityScore: 512,
      hardOverride: false,
    };
    expect(hasClassifiedOwner(bareFiredRecommendation)).toBe(false);
  });
});
