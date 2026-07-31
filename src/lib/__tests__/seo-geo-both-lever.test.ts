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

describe("a BOTH-lever gap reaches both markdown briefs", () => {
  const brief = readFileSync(join(process.cwd(), "src/lib/intel/seo-geo.ts"), "utf8");

  it("excludes only the opposite lever, never by strict equality", () => {
    // `=== "SEO"` / `=== "GEO"` is what dropped the promoted gaps from both.
    expect(brief).toContain('g.lever !== "GEO"');
    expect(brief).toContain('g.lever !== "SEO"');
    expect(brief).not.toContain('g.lever === "SEO"');
    expect(brief).not.toContain('g.lever === "GEO"');
  });
});
