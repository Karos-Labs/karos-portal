import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

import { healRecommendations } from "@/components/seo-geo/presenter";
import type { Lever, RecImpact, Recommendation } from "@/lib/seo-geo";

/**
 * Two client-facing defects that shared a cause: a gap promoted to lever "BOTH"
 * (which `dedupeGapsByRecId` does when one recId is found under both levers)
 * was handled as if "BOTH" were a third, separate thing rather than the union.
 *
 *  1. Both markdown briefs filtered on strict equality, so a promoted gap was
 *     excluded from BOTH of them and simply vanished from the client report.
 *  2. `healRecommendations` healed copy without deduping, so a legacy snapshot
 *     rendered one action twice with contradictory chips — and because both rows
 *     carry the same recId, approving one flipped both.
 */

const rec = (over: Partial<Recommendation> = {}): Recommendation => ({
  recId: "BOTH-09",
  title: "raw engineering label",
  description: "",
  owner: "Karos",
  vertical: "SEO" as Lever,
  impact: "medium" as RecImpact,
  actionKind: "review_approve",
  targetPlatform: "site",
  live: true,
  ...over,
});

describe("healRecommendations collapses one recId to one row", () => {
  it("keeps a single row when two copies share a recId", () => {
    const out = healRecommendations([rec(), rec({ impact: "high" })]);
    expect(out).toHaveLength(1);
  });

  it("keeps the stronger impact, whichever order it arrives in", () => {
    expect(healRecommendations([rec({ impact: "low" }), rec({ impact: "high" })])[0].impact).toBe("high");
    expect(healRecommendations([rec({ impact: "high" }), rec({ impact: "low" })])[0].impact).toBe("high");
  });

  it("promotes the vertical to BOTH when the copies disagree", () => {
    // The same rule dedupeGapsByRecId applies to the gaps these rows come from:
    // a recId seen under both levers is a both-levers action, not two actions.
    const out = healRecommendations([rec({ vertical: "SEO" }), rec({ vertical: "GEO" })]);
    expect(out).toHaveLength(1);
    expect(out[0].vertical).toBe("BOTH");
  });

  it("leaves a single vertical alone", () => {
    expect(healRecommendations([rec({ vertical: "GEO" })])[0].vertical).toBe("GEO");
  });

  it("preserves first-seen order across distinct recIds", () => {
    const out = healRecommendations([
      rec({ recId: "GEO-01" }),
      rec({ recId: "BOTH-02" }),
      rec({ recId: "GEO-01", impact: "high" }),
    ]);
    expect(out.map((r) => r.recId)).toEqual(["GEO-01", "BOTH-02"]);
  });

  it("still heals the copy — dedupe did not replace the healing", () => {
    // The raw engineering label must not survive to a client's screen.
    const out = healRecommendations([rec({ recId: "BOTH-09", title: "raw engineering label" })]);
    expect(out[0].title).not.toBe("raw engineering label");
  });

  it("is safe on an empty plan", () => {
    expect(healRecommendations([])).toEqual([]);
  });
});

/* ── AF-11: the OTHER duplicate — two ids, one set of words ── */

describe("healRecommendations collapses rows that heal to identical copy", () => {
  // Albert saw the same approved item twice. The pass above closes one recId
  // appearing twice; this closes two DIFFERENT ids rendering byte for byte the
  // same, which is a different defect with the same face — and it is the one a
  // client meets, because the green treatment on an approved row is what makes
  // the pair visible at all.

  it("keeps one row for the per-engine twins of a known finding", () => {
    // `resolveRecCopy` keys on `recId.split(":")[0]`, so every engine's copy of
    // GEO-11 resolves to one entry in REC_COPY and renders identically.
    const out = healRecommendations([
      rec({ recId: "GEO-11:chatgpt" }),
      rec({ recId: "GEO-11:gemini" }),
      rec({ recId: "GEO-11:perplexity" }),
    ]);
    expect(out).toHaveLength(1);
    // Not vacuous: the fixture really does heal to one set of words.
    expect(out[0].title).toBeTruthy();
  });

  it("keeps one row for N unmapped findings that all fall back", () => {
    // Every id REC_COPY does not know resolves to the single REC_FALLBACK, so
    // these rendered as N rows all reading "A technical finding your team is
    // reviewing".
    const out = healRecommendations([
      rec({ recId: "MODEL-INVENTED-1", title: "" }),
      rec({ recId: "MODEL-INVENTED-2", title: "" }),
    ]);
    expect(out).toHaveLength(1);
    // Not vacuous: these really are the fallback, not two rows that happened to
    // share a blank title.
    expect(out[0].title).toBe("A technical finding your team is reviewing");
  });

  it("does not collapse two findings that actually say different things", () => {
    // The whole risk of keying on copy. Two real, distinct actions must stay two
    // rows however similar their ids look.
    const out = healRecommendations([
      rec({ recId: "SEO-02", title: "Fix your title tags", description: "One." }),
      rec({ recId: "SEO-03", title: "Fix your meta descriptions", description: "Two." }),
    ]);
    expect(out).toHaveLength(2);
    // And a shared title with different explanations is still two rows.
    const sameTitle = healRecommendations([
      rec({ recId: "X-1", title: "Same title", description: "One." }),
      rec({ recId: "X-2", title: "Same title", description: "Two." }),
    ]);
    expect(sameTitle).toHaveLength(2);
  });

  it("applies the same merge rules the recId pass does", () => {
    const out = healRecommendations([
      rec({ recId: "GEO-11:chatgpt", vertical: "SEO", impact: "low" }),
      rec({ recId: "GEO-11:gemini", vertical: "GEO", impact: "high" }),
    ]);
    expect(out).toHaveLength(1);
    expect(out[0].impact).toBe("high");
    expect(out[0].vertical).toBe("BOTH");
  });

  it("preserves first-seen order and leaves distinct rows untouched", () => {
    const out = healRecommendations([
      rec({ recId: "SEO-02", title: "Fix your title tags" }),
      rec({ recId: "GEO-11:chatgpt" }),
      rec({ recId: "SEO-05", title: "Fix your headings" }),
      rec({ recId: "GEO-11:gemini" }),
    ]);
    expect(out).toHaveLength(3);
    expect(out.map((r) => r.recId)).toEqual(["SEO-02", "GEO-11:chatgpt", "SEO-05"]);
  });

  it("keeps the id the client already approved as the survivor's", () => {
    // The half that makes the collapse safe. Without it, collapsing a pair whose
    // approved member was not first-seen shows an un-approved row for something
    // the client already approved, which is a worse lie than the duplicate.
    const rows = [rec({ recId: "GEO-11:chatgpt" }), rec({ recId: "GEO-11:gemini" })];
    expect(healRecommendations(rows, { approvedRecIds: ["GEO-11:gemini" ] })[0].recId).toBe(
      "GEO-11:gemini",
    );
    // First-seen wins when neither, or both, are approved — a stable answer
    // either way rather than one that depends on the arrival order.
    expect(healRecommendations(rows)[0].recId).toBe("GEO-11:chatgpt");
    expect(
      healRecommendations(rows, { approvedRecIds: ["GEO-11:chatgpt", "GEO-11:gemini"] })[0].recId,
    ).toBe("GEO-11:chatgpt");
  });

  it("hands the leaf a plan it can key by recId alone", () => {
    // The rendered consequence: the list key is `r.recId` now, so a surviving
    // duplicate would be a React key collision rather than a silent second row.
    const out = healRecommendations([
      rec({ recId: "GEO-11:chatgpt" }),
      rec({ recId: "GEO-11:gemini" }),
      rec({ recId: "SEO-02", title: "Fix your title tags" }),
    ]);
    expect(new Set(out.map((r) => r.recId)).size).toBe(out.length);
  });
});

describe("where an approved item goes is on the row (AF-11)", () => {
  const leaf = readFileSync(join(process.cwd(), "src/components/seo-geo-action-plan.tsx"), "utf8");

  it("names the hand-off, the person, and when it shows", () => {
    // Albert could not tell where approvals go. The old line named a destination
    // but not the hand-off, so it could still read as something the system had
    // queued for itself.
    expect(leaf).toContain("Sent to your Karos team.");
    expect(leaf).toContain("They make the change, and it shows in your next");
  });

  it("keys the list by recId, not by index", () => {
    // An index suffix is what a list keys by when it EXPECTS duplicates.
    expect(leaf).toContain("key={r.recId}");
    expect(leaf).not.toContain("key={`${r.recId}-${i}`}");
  });

  it("writes both approval sentences without an em dash", () => {
    // AF-8, on the two strings this change touches.
    const approvedLine = leaf.slice(leaf.indexOf("Sent to your Karos team."));
    expect(approvedLine.slice(0, 200)).not.toContain("—");
    const footer = leaf.slice(leaf.indexOf("Approving sends it to your Karos team"));
    expect(footer.slice(0, 200)).not.toContain("—");
  });
});

// The "a BOTH-lever gap reaches both markdown briefs" describe block that used
// to live here read `src/lib/intel/seo-geo.ts`'s source directly to guard a
// `=== "SEO"` / `=== "GEO"` strict-equality regression in the markdown-brief
// generation it — and only it — performed. SCRUM-274 (T-B19) deleted that
// file wholesale: it was the old, hardcoded onboarding pipeline's in-process
// SEO/GEO research orchestrator (`runSeoGeoResearch`, called exclusively from
// the now-also-deleted `src/lib/intel/pipeline.ts`), superseded by the real
// `seo-geo-agent` dispatched through agent-engine. There is no markdown brief
// left for this guard to protect — see this ticket's report for the full
// file-by-file account. `healRecommendations`' own BOTH-lever dedupe (tested
// above, in `@/components/seo-geo/presenter`) is untouched by this deletion.
