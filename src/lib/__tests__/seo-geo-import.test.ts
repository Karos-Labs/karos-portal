import { describe, expect, it } from "vitest";

import {
  SEO_GEO_METHODOLOGY_VERSION,
  SEO_GEO_PIPELINE_VERSION,
  type SeoGeoInsights,
} from "@/lib/seo-geo";
import { describeProvenance, validateSeoGeoSnapshot } from "@/lib/seo-geo-import";
import { buildSnapshotTrust } from "@/components/seo-geo/presenter";

/**
 * Hand-imported SEO/GEO snapshots (admin Ops Import).
 *
 * The refresh harness banned this write path outright, because these numbers
 * are MACHINE-MEASURED and a portal that reports an unmeasured position is
 * worse than one that reports nothing. Albert's directive re-opened it, so what
 * used to be a ban is now a provenance obligation — and these tests are what
 * make it one. The load-bearing property: an imported snapshot must never be
 * indistinguishable from a fresh machine capture.
 */

const NOW = Date.UTC(2026, 6, 28);
const CAPTURED = Date.UTC(2026, 6, 27);

function snapshot(over: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    clientId: "client-1",
    capturedAt: CAPTURED,
    pipelineVersion: SEO_GEO_PIPELINE_VERSION,
    // A current bundle carries BOTH stamps — the trust verdict keys on the question
    // methodology as well as the scoring pipeline (CD-J1 bounce 2a).
    methodologyVersion: SEO_GEO_METHODOLOGY_VERSION,
    seoScore: 62,
    seoDataCoveragePct: 90,
    geoReadiness: 55,
    geoReadinessCoveragePct: 80,
    geoVisibilityIndex: 34,
    geoVisibilityCoveragePct: 75,
    geoVisibilityModel: "share-of-answer v3",
    geoVisibilityEnginesMeasured: 3,
    geoVisibilityEnginesScored: 3,
    geoVisibilityEnginesTotal: 4,
    rosterSharePct: 18,
    categoryPresence: { named: 4, total: 12 },
    brandPresence: { named: 9, total: 10 },
    perEngine: [],
    gaps: [],
    recommendations: [],
    seoChecks: [],
    geoChecks: [],
    promptSet: ["best crm for startups"],
    intentPrompts: [],
    answerGrid: [],
    citationLeaderboard: [],
    citationSummary: { cited: 2, named: 5, ghost: 3 },
    competitorsNamed: [],
    roster: ["Acme Co"],
    updatedAt: CAPTURED,
    ...over,
  };
}

function ok(raw: Record<string, unknown>, now = NOW) {
  const res = validateSeoGeoSnapshot(raw, { clientId: "client-1", importedBy: "Albert K." }, now);
  if (!res.ok) throw new Error(`expected acceptance, got:\n${res.errors.join("\n")}`);
  return res;
}

function refuse(raw: unknown, now = NOW): string {
  const res = validateSeoGeoSnapshot(raw, { clientId: "client-1" }, now);
  expect(res.ok).toBe(false);
  if (res.ok) throw new Error("unreachable");
  return res.errors.join("\n");
}

describe("imported snapshots carry their provenance", () => {
  it("stamps the import rather than letting it pass as a machine capture", () => {
    const { insights } = ok(snapshot());
    expect(insights.importedFrom).toMatchObject({
      source: "local-import",
      importedAt: NOW,
      importedBy: "Albert K.",
    });
  });

  // The single most important property here. A snapshot with no importedFrom is
  // a machine capture; every stored snapshot predating Ops Import is one.
  it("leaves a machine capture distinguishable from an import", () => {
    const machine = { ...snapshot() } as unknown as SeoGeoInsights;
    expect(machine.importedFrom).toBeUndefined();
    expect(describeProvenance(machine)).toContain("Machine capture");
    expect(describeProvenance(ok(snapshot()).insights)).toContain("Imported");
  });

  it("refuses a bundle that tries to declare its own provenance", () => {
    expect(refuse(snapshot({ importedFrom: { source: "local-import", importedAt: 1 } }))).toContain(
      "a bundle may not declare its own provenance",
    );
  });

  it("keeps the measurement date, and does not backdate the import to it", () => {
    const { insights } = ok(snapshot());
    expect(insights.capturedAt).toBe(CAPTURED);
    expect(insights.importedFrom?.importedAt).toBe(NOW);
    expect(insights.updatedAt).toBe(NOW);
  });
});

describe("the trust verdict is not laundered by importing", () => {
  it("carries a current pipeline stamp through, so the verdict is unchanged", () => {
    const { insights } = ok(snapshot());
    expect(insights.pipelineVersion).toBe(SEO_GEO_PIPELINE_VERSION);
    expect(buildSnapshotTrust(insights).isLegacy).toBe(false);
  });

  // The importer must never invent a stamp to silence the banner: an unstamped
  // capture stays unstamped, and keeps reading as legacy.
  it("never invents a pipeline stamp for an unstamped capture", () => {
    const raw = snapshot();
    delete raw.pipelineVersion;
    const res = ok(raw);
    expect(res.insights.pipelineVersion).toBeUndefined();
    expect(buildSnapshotTrust(res.insights).isLegacy).toBe(true);
    expect(res.warnings.join(" ")).toContain("legacy banner");
  });

  it("carries a superseded stamp through verbatim", () => {
    const { insights } = ok(snapshot({ pipelineVersion: "2026-01-01" }));
    expect(insights.pipelineVersion).toBe("2026-01-01");
    expect(buildSnapshotTrust(insights).isLegacy).toBe(true);
  });

  it("warns rather than silently freshening an old capture", () => {
    const old = Date.UTC(2026, 3, 1);
    const res = ok(snapshot({ capturedAt: old }));
    expect(res.insights.capturedAt).toBe(old);
    expect(res.warnings.join(" ")).toMatch(/days old/);
  });

  it("refuses a capture dated in the future", () => {
    expect(refuse(snapshot({ capturedAt: NOW + 86_400_000 }))).toContain("cannot postdate its import");
  });
});

describe("shape validation", () => {
  it("refuses a snapshot filed under another client", () => {
    expect(refuse(snapshot({ clientId: "client-2" }))).toContain("refusing to cross-apply");
  });

  it("refuses an unknown key rather than importing a foreign schema's recognised half", () => {
    expect(refuse(snapshot({ answerMatrix: [] }))).toContain('unknown key "answerMatrix"');
  });

  it.each([
    ["seoScore", "not-a-number"],
    ["geoVisibilityIndex", null],
    ["rosterSharePct", undefined],
  ])("refuses a non-numeric %s", (field, value) => {
    expect(refuse(snapshot({ [field]: value }))).toContain(field);
  });

  it.each(["perEngine", "recommendations", "roster", "promptSet"])(
    "refuses a %s that is not an array",
    (field) => {
      expect(refuse(snapshot({ [field]: {} }))).toContain(field);
    },
  );

  it("refuses malformed presence counters", () => {
    expect(refuse(snapshot({ categoryPresence: { named: 4 } }))).toContain("categoryPresence");
  });

  it("refuses a non-object", () => {
    expect(refuse("nope")).toContain("must be a JSON object");
  });

  it("drops portal-owned fields so the data layer stays authoritative", () => {
    // visibilityHistory is recomputed on write and approvedRecIds is preserved
    // from the stored doc; a bundle must not be able to rewrite either.
    const { insights } = ok(snapshot({ visibilityHistory: [1, 2, 3], approvedRecIds: ["rec-1"] }));
    expect(insights.visibilityHistory).toBeUndefined();
    expect(insights.approvedRecIds).toBeUndefined();
  });

  it("reports no stored snapshot honestly", () => {
    expect(describeProvenance(null)).toContain("No snapshot stored");
  });
});
