import { describe, it, expect, vi } from "vitest";
import fs from "node:fs";
import path from "node:path";

vi.mock("server-only", () => ({}));

const {
  CONTEXT_DOC_SET_CONTRACT,
  INTERNAL_CONTEXT_DOC_TYPES,
  INTERNAL_ONLY_CONTEXT_DOC_TYPES,
  STORED_CONTEXT_DOC_FIELDS,
  ContextDocShapeError,
  assertContextDocSetShape,
  composeContextDocsFromAgentReports,
  runAgentOnboarding,
  INTEL_REPORT_DELIVERABLE_KIND,
  SEO_GEO_DELIVERABLE_KIND,
} = await import("../intel/agent-onboarding");

type Row = Record<string, unknown>;

const CLIENT_ID = "acme";
const CLIENT = { id: CLIENT_ID, name: "Acme" } as never;

/**
 * The two deliverables. SCRUM-274 (T-B19) rewrote this fixture to the REAL
 * field names/shapes verified directly against agent-engine's ref clone
 * (`packages/tools/karos-intel/src/types.ts`'s `IntelReportOutputSchema`,
 * `agents/seo-geo-agent/src/workflow/types.ts`'s `SeoGeoReport`) — the
 * pre-T-B19 fixture here used `brandVoiceArchetypes: string[]`,
 * `customerSentiment: string`, `competitors: string[]`, `competitorRankings`
 * keyed by `name`, and `promptSet` as a bare array, none of which match what
 * the real deliverables actually send (`{company,archetype}` objects,
 * `CustomerSentimentEntry[]`, `ClientCompetitor[]`, `{company,score,...}`,
 * and `{prompts: SeoGeoPrompt[], ...}` respectively) — see this ticket's
 * report for the full finding. Every field below is the field name
 * `materialize.ts` already reads off the deliverable (`materializeIntelReport`
 * / `materializeSeoGeoReport`) where that overlaps, and the real schema
 * otherwise — the check against inventing a wire shape agent-engine does not
 * send.
 */
const INTEL_REPORT = {
  overallScore: 71,
  overallGrade: "B",
  dimensionScores: [
    { dimension: "contentMessaging", score: 68 },
    { dimension: "seo", score: 74 },
  ],
  swot: {
    strengths: ["Named category"],
    weaknesses: ["Thin comparison pages"],
    opportunities: ["Answer-engine share of voice"],
    threats: ["Two funded entrants"],
  },
  recommendations: [{ title: "Ship five comparison pages" }, { title: "Rewrite the pricing page" }],
  competitorRankings: [{ company: "Northwind", score: 81 }],
  competitors: [{ company: "Northwind" }, { company: "Initech" }],
  brandVoiceRows: [{ dimension: "Warmth", scores: { Acme: "4/5", Northwind: "2/5" } }],
  brandVoiceArchetypes: [
    { company: "Acme", archetype: "Sage" },
    { company: "Northwind", archetype: "Creator" },
  ],
  brandVoiceTerritory: "Plain-spoken operator, never a hype merchant.",
  customerSentiment: [{ company: "Acme", rating: "4.2", ratingLabel: "Very good", wouldReturn: "yes" }],
  whitespaceOpportunities: ["Migration tooling content"],
  contentAnalysis: "Docs outrank marketing pages for every buying term.",
  conversionAnalysis: "The trial gate is the drop-off, not the pricing.",
  seoAnalysis: "Technically sound, thin on intent coverage.",
  geoAnalysis: "Cited by two of five engines.",
  positioningAnalysis: "Positioned against spreadsheets, not against rivals.",
  brandAnalysis: "One voice in docs, a different one on the site.",
  growthAnalysis: "Growth is word of mouth with no assist layer.",
  brandSynchronizationUpdate: "Align the site to the docs voice, not the reverse.",
};

const SEO_GEO = {
  seoScore: { score: 74 },
  geoReadiness: { score: 58 },
  narrative: "Strong technical base, weak answer-engine presence.",
  // The real `visibility` shape has no per-engine breakdown at all (see
  // agent-onboarding.ts's own comment at this section) — `byN`/`byNe` are
  // what a real deliverable actually carries here.
  visibility: { byN: null, byNe: null },
  firedRecommendations: [{ recId: "GEO-1", recommendation: "Publish an FAQ block on every comparison page" }],
  fixDrafts: [{ recId: "GEO-1", title: "robots.txt allow for answer engines" }],
  promptSet: {
    prompts: [{ promptText: "best tool for X" }, { promptText: "X vs Northwind" }],
    source: "drafted",
  },
};

/** A shape-valid set, used as the baseline every failure case perturbs. */
function validSet(now = 1_700_000_000_000): Row[] {
  const generated = composeContextDocsFromAgentReports({
    client: CLIENT,
    intelReport: INTEL_REPORT,
    seoGeo: SEO_GEO,
  });
  return [
    ...INTERNAL_CONTEXT_DOC_TYPES.map((docType) => ({
      clientId: CLIENT_ID,
      docType,
      tier: "internal",
      content: generated[docType],
      version: 1,
      createdAt: now,
      updatedAt: now,
    })),
    ...INTERNAL_ONLY_CONTEXT_DOC_TYPES.map((docType) => ({
      clientId: CLIENT_ID,
      docType,
      tier: "internal-only",
      content: generated[docType],
      version: 1,
      createdAt: now,
      updatedAt: now,
    })),
    ...INTERNAL_CONTEXT_DOC_TYPES.map((docType) => ({
      clientId: CLIENT_ID,
      docType,
      tier: "client",
      content: `condensed ${docType}`,
      version: 1,
      createdAt: now,
      updatedAt: now,
    })),
  ];
}

const assertRows = (rows: Row[]) => assertContextDocSetShape(rows as never, CLIENT_ID);

/* ────────────────────────────────────────────────────────────────── */

describe("SCRUM-272 — the agent-based path exists and consumes the real agent deliverables", () => {
  /**
   * D1's whole point. Before this ticket the only agent-engine dispatch of
   * `intel-report-agent`/`seo-geo-agent` was `dispatch-research-agents.ts`,
   * whose own doc comment says it is "purely additive — their output does not
   * feed anything below". A path that fetches those deliverables and writes the
   * context documents from them did not exist anywhere in src/.
   */
  it("has a module that fetches both agent deliverables AND writes through replaceClientContextDocs", () => {
    const src = path.join(process.cwd(), "src");
    const files: string[] = [];
    const walk = (dir: string) => {
      for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
        const full = path.join(dir, e.name);
        if (e.isDirectory()) {
          if (e.name === "__tests__") continue;
          walk(full);
        } else if (/\.tsx?$/.test(e.name)) files.push(full);
      }
    };
    walk(src);

    const consumers = files.filter((f) => {
      const text = fs.readFileSync(f, "utf8");
      return (
        text.includes(INTEL_REPORT_DELIVERABLE_KIND) &&
        text.includes(SEO_GEO_DELIVERABLE_KIND) &&
        text.includes("replaceClientContextDocs")
      );
    });

    expect(
      consumers.map((f) => path.relative(process.cwd(), f).split(path.sep).join("/")),
      "no module derives the context documents from the intel-report + seo-geo-report deliverables",
    ).toContain("src/lib/intel/agent-onboarding.ts");
  });

  it("keeps the stored field set to exactly what the old path wrote — no new columns", () => {
    expect([...STORED_CONTEXT_DOC_FIELDS].sort()).toEqual([
      "clientId",
      "content",
      "createdAt",
      "docType",
      "tier",
      "updatedAt",
      "version",
    ]);
  });

  it("pins the (docType, tier) rows the read path serves", () => {
    expect(CONTEXT_DOC_SET_CONTRACT.map((r) => `${r.docType}::${r.tier}`)).toEqual([
      "brand-voice::internal",
      "market-strategy::internal",
      "competitor-analysis::internal",
      "product-information::internal",
      "branding-guidelines::internal",
      "target-audience::internal",
      "client-guidelines::internal-only",
      "action-plan::internal-only",
      "brand-voice::client",
      "market-strategy::client",
      "competitor-analysis::client",
      "product-information::client",
      "branding-guidelines::client",
      "target-audience::client",
    ]);
  });
});

describe("composeContextDocsFromAgentReports", () => {
  it("produces all eight generated documents with real content from both deliverables", () => {
    const docs = composeContextDocsFromAgentReports({
      client: CLIENT,
      intelReport: INTEL_REPORT,
      seoGeo: SEO_GEO,
    });
    for (const docType of [...INTERNAL_CONTEXT_DOC_TYPES, ...INTERNAL_ONLY_CONTEXT_DOC_TYPES]) {
      expect(docs[docType].trim(), docType).not.toBe("");
    }
    // Sourced from the intel report...
    expect(docs["brand-voice"]).toContain("Plain-spoken operator");
    expect(docs["competitor-analysis"]).toContain("Northwind");
    // ...and from the SEO/GEO report.
    expect(docs["market-strategy"]).toContain("SEO 74 · GEO readiness 58");
    expect(docs["market-strategy"]).toContain("weak answer-engine presence");
    expect(docs["action-plan"]).toContain("Publish an FAQ block");
  });

  /**
   * SCRUM-274 (T-B19) — the six field-path mismatches this ticket fixed
   * against the real deliverable shapes (see `agent-onboarding.ts`'s
   * `brandVoiceArchetypeList`/`brandVoiceAttributeList`/
   * `customerSentimentList` and the `competitors`/`promptSetPrompts` locals).
   * Each assertion below reads a section that composed to EMPTY before this
   * ticket, against the exact real-shaped fixture above.
   */
  it("reads the real (object-shaped) brandVoiceArchetypes, brandVoiceRows, customerSentiment, competitors and promptSet.prompts fields", () => {
    const docs = composeContextDocsFromAgentReports({
      client: CLIENT,
      intelReport: INTEL_REPORT,
      seoGeo: SEO_GEO,
    });
    expect(docs["brand-voice"]).toContain("Acme: Sage");
    expect(docs["brand-voice"]).toContain("Warmth");
    expect(docs["brand-voice"]).toContain("Acme: 4/5");
    expect(docs["competitor-analysis"]).toContain("Competitors analysed: 2");
    expect(docs["competitor-analysis"]).toContain("Initech");
    expect(docs["target-audience"]).toContain("Acme");
    expect(docs["target-audience"]).toContain("4.2 (Very good)");
    expect(docs["target-audience"]).toContain("best tool for X");
    expect(docs["target-audience"]).toContain("X vs Northwind");
  });

  it("omits a section whose field the engine did not send instead of throwing", () => {
    const docs = composeContextDocsFromAgentReports({
      client: CLIENT,
      intelReport: { brandAnalysis: "Only this one field." },
      seoGeo: {},
    });
    expect(docs["brand-voice"]).toContain("Only this one field.");
    expect(docs["brand-voice"]).not.toContain("Voice territory");
    // And a document with nothing behind it is the EMPTY STRING, not a lone
    // heading. A heading is non-empty text, so a bare-title document would sail
    // through the gate's content check and be stored as a client's ground
    // truth — the emptiness has to reach the check to be catchable.
    expect(docs["target-audience"]).toBe("");
    expect(docs["action-plan"]).toBe("");
  });
});

/**
 * The gate's failure cases. Nine of the last defects on this programme were a
 * check structurally incapable of failing, so each clause gets a case that
 * trips it — a guard nobody has watched fail is a guard nobody has.
 */
describe("assertContextDocSetShape — what makes it fail", () => {
  it("passes the set the new path actually builds", () => {
    expect(() => assertRows(validSet())).not.toThrow();
  });

  it("fails when a required internal row is missing", () => {
    const rows = validSet().filter((r) => !(r.docType === "brand-voice" && r.tier === "internal"));
    expect(() => assertRows(rows)).toThrow(/required row brand-voice::internal is missing/);
  });

  it("fails when an internal-only document is published at the client tier", () => {
    const rows = validSet();
    rows.push({ ...rows[0], docType: "action-plan", tier: "client" });
    expect(() => assertRows(rows)).toThrow(/row action-plan::client is not part of the stored context-document set/);
  });

  it("fails on a duplicate (docType, tier) row", () => {
    const rows = validSet();
    rows.push({ ...rows[0] });
    expect(() => assertRows(rows)).toThrow(/duplicate row brand-voice::internal/);
  });

  it("fails when a row carries another client's id", () => {
    const rows = validSet();
    rows[0] = { ...rows[0], clientId: "initech" };
    expect(() => assertRows(rows)).toThrow(/carries clientId "initech", expected "acme"/);
  });

  it("fails when a row carries a field onboarding has never written", () => {
    const rows = validSet();
    rows[0] = { ...rows[0], agentEngineRunId: "run_1" };
    expect(() => assertRows(rows)).toThrow(/carries field "agentEngineRunId", which onboarding has never written/);
  });

  it("fails when a row is missing a stored field", () => {
    const rows = validSet();
    const { updatedAt: _dropped, ...withoutUpdatedAt } = rows[0];
    rows[0] = withoutUpdatedAt;
    expect(() => assertRows(rows)).toThrow(/is missing field "updatedAt"/);
  });

  it("fails on empty content", () => {
    const rows = validSet();
    rows[0] = { ...rows[0], content: "   " };
    expect(() => assertRows(rows)).toThrow(/has empty content/);
  });

  it("fails on a version that is not a positive integer", () => {
    const rows = validSet();
    rows[0] = { ...rows[0], version: 0 };
    expect(() => assertRows(rows)).toThrow(/expected a positive integer/);
  });

  it("fails on a non-finite timestamp", () => {
    const rows = validSet();
    rows[0] = { ...rows[0], createdAt: Number.NaN };
    expect(() => assertRows(rows)).toThrow(/non-finite createdAt/);
  });

  it("reports every violation at once, as a ContextDocShapeError", () => {
    const rows = validSet();
    rows[0] = { ...rows[0], version: -1, content: "" };
    try {
      assertRows(rows);
      throw new Error("expected assertContextDocSetShape to throw");
    } catch (e) {
      expect(e).toBeInstanceOf(ContextDocShapeError);
      expect((e as InstanceType<typeof ContextDocShapeError>).violations.length).toBeGreaterThanOrEqual(2);
    }
  });
});

/* ────────────────────────────────────────────────────────────────── */

function deps(overrides: Partial<Record<string, unknown>> = {}) {
  const written: { clientId: string; docs: Row[] }[] = [];
  const base = {
    getClient: async () => CLIENT,
    dispatchResearchAgents: async () => ({
      intelReport: { agentEngineRunId: "run_intel" },
      seoGeo: { agentEngineRunId: "run_seo" },
    }),
    getDeliverable: async (_runId: string, kind: string) =>
      kind === INTEL_REPORT_DELIVERABLE_KIND ? INTEL_REPORT : SEO_GEO,
    condense: async (_c: unknown, docTypes: string[]) =>
      docTypes.map((docType) => ({ docType, content: `condensed ${docType}` })),
    replaceDocs: async (clientId: string, docs: Row[]) => {
      written.push({ clientId, docs });
    },
    now: () => 1_700_000_000_000,
    sleep: async () => {},
  };
  return { deps: { ...base, ...overrides } as never, written };
}

describe("runAgentOnboarding", () => {
  it("writes the full set through replaceClientContextDocs, unchanged", async () => {
    const { deps: d, written } = deps();
    const result = await runAgentOnboarding(CLIENT_ID, d);

    expect(result.docsWritten).toBe(14);
    expect(written).toHaveLength(1);
    expect(written[0].clientId).toBe(CLIENT_ID);
    expect(() => assertRows(written[0].docs)).not.toThrow();
    // Location is `replaceClientContextDocs`'s business, not this module's — the
    // proof it cannot move the read path is that it never names the collection.
    const source = fs.readFileSync(path.join(process.cwd(), "src/lib/intel/agent-onboarding.ts"), "utf8");
    expect(source).not.toContain("clientContextDocs()");
  });

  it("asks agent-engine for exactly the two kinds the engine writes", async () => {
    const asked: string[] = [];
    const { deps: d } = deps({
      getDeliverable: async (runId: string, kind: string) => {
        asked.push(`${runId}:${kind}`);
        return kind === INTEL_REPORT_DELIVERABLE_KIND ? INTEL_REPORT : SEO_GEO;
      },
    });
    await runAgentOnboarding(CLIENT_ID, d);
    expect(asked.sort()).toEqual(["run_intel:intel-report", "run_seo:seo-geo-report"]);
  });

  it("drops a condensation that came back empty rather than storing a blank client row", async () => {
    const { deps: d, written } = deps({
      condense: async (_c: unknown, docTypes: string[]) =>
        docTypes.map((docType) => ({ docType, content: docType === "brand-voice" ? "" : `condensed ${docType}` })),
    });
    await runAgentOnboarding(CLIENT_ID, d);
    const clientRows = written[0].docs.filter((r) => r.tier === "client").map((r) => r.docType);
    expect(clientRows).not.toContain("brand-voice");
    expect(clientRows).toHaveLength(5);
  });

  it("refuses to write anything when a deliverable never arrives", async () => {
    const { deps: d, written } = deps({
      getDeliverable: async (_runId: string, kind: string) =>
        kind === INTEL_REPORT_DELIVERABLE_KIND ? undefined : SEO_GEO,
      now: (() => {
        let t = 0;
        return () => (t += 60_000);
      })(),
    });
    await expect(runAgentOnboarding(CLIENT_ID, d, { deliverableTimeoutMs: 120_000, pollIntervalMs: 1 })).rejects.toThrow(
      /timed out waiting for the "intel-report" deliverable/,
    );
    expect(written).toHaveLength(0);
  });

  it("refuses to write anything when the dispatch itself was skipped", async () => {
    const { deps: d, written } = deps({
      dispatchResearchAgents: async () => ({
        intelReport: { skipped: true, reason: "client has no agentsRepoSlug configured" },
        seoGeo: { skipped: true, reason: "client has no agentsRepoSlug configured" },
      }),
    });
    await expect(runAgentOnboarding(CLIENT_ID, d)).rejects.toThrow(/could not dispatch intelReport/);
    expect(written).toHaveLength(0);
  });

  it("refuses to write when a deliverable is too thin to fill a document", async () => {
    // The gate firing on a real run, not on a hand-built set: an engine that
    // answers with an all-but-empty report produces a blank ground-truth
    // document, and a blank ground-truth document must fail the run.
    const { deps: d, written } = deps({
      getDeliverable: async (_runId: string, kind: string) =>
        kind === INTEL_REPORT_DELIVERABLE_KIND ? { brandAnalysis: "Only this." } : {},
    });
    await expect(runAgentOnboarding(CLIENT_ID, d)).rejects.toThrow(ContextDocShapeError);
    expect(written).toHaveLength(0);
  });
});
