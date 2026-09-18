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
/**
 * The client record as the composer now reads it: `brandVoice` and
 * `brandingGuidelines` are the brand's OWN statement of how it sounds and
 * looks, and they are what `brand-voice` / `branding-guidelines` are built
 * from. Before this fixture carried them, both documents were composed
 * entirely out of the intel report's per-company comparison fields.
 */
const CLIENT = {
  id: CLIENT_ID,
  name: "Acme",
  brandVoice: "Short declarative sentences. No exclamation marks. Every claim carries a number.",
  brandingGuidelines: {
    dominantColors: [{ hex: "#ff6b2c", role: "Primary accent, CTA buttons", dominanceRank: 1 }],
    fontHeading: "Space Grotesk",
    fontBody: "Inter",
    toneKeywords: ["Precise", "Direct"],
    visualStyle: "Dark Mode",
    guidelines: "## Brand Voice\nPlain and exact.\n\n## Don'ts\n- No hype adjectives",
    updatedAt: 1_700_000_000_000,
  },
} as never;

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
  // With their descriptions, because the description is what made these
  // duplicate: market-strategy and action-plan each printed the full block,
  // and on the real report that was nine long paragraphs twice. A fixture of
  // bare titles cannot reproduce that, so the duplication guard could not
  // fail against it.
  recommendations: [
    {
      title: "Ship five comparison pages",
      priorityLabel: "High",
      description:
        "Every buying term in this category resolves to a comparison query, and the docs currently outrank the marketing pages for all five. Publishing the comparison set is the one move that puts an owned page on the term the buyer actually types.",
    },
    {
      title: "Rewrite the pricing page",
      priorityLabel: "Medium",
      description:
        "The trial gate is the measured drop-off, not the price itself, so the page needs to answer what happens after the trial rather than restating the tiers. Naming the gate on the page removes the question the drop-off is made of.",
    },
  ],
  competitorRankings: [{ company: "Northwind", score: 81 }],
  competitors: [{ company: "Northwind" }, { company: "Initech" }],
  brandVoiceRows: [{ dimension: "Warmth", scores: { Acme: "4/5", Northwind: "2/5" } }],
  brandVoiceArchetypes: [
    { company: "Acme", archetype: "Sage" },
    { company: "Northwind", archetype: "Creator" },
  ],
  // A real `brandVoiceTerritory` positions the voice AGAINST named rivals —
  // that is what a territory claim is — so the fixture names one. It is the
  // reason the guard below asserts the absence of the two comparison
  // SECTIONS rather than the absence of competitor names, which would be a
  // guard that only passes because the fixture is tamer than production.
  brandVoiceTerritory: "Plain-spoken operator, never a hype merchant — where Northwind is all superlatives.",
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
  targetAudience: {
    summary: "Ops leads at 50-500 person manufacturers.",
    personas: [{ label: "Ops lead", isPrimary: true, avoidPhrases: ["best-in-class", "synergy"] }],
    evidence: ["context-provided: targetAudience"],
    rulesForContentAgents: ["Open on the cost of replanning, never on the product"],
  },
  // intel-report-craft@7. Both blocks exist because no field on this report
  // answered "how do I write the next sentence" or "what does this client
  // sell" — the two questions every publishing agent has before it starts.
  brandVoiceSpec: {
    voiceInOneLine: "A calm operator who moves fast.",
    adjectives: ["Direct", "Concrete"],
    dimensions: [{ scale: "plain to technical", position: "plain first", shiftsWhen: "the reader is an engineer" }],
    sentenceMechanics: ["Second person for the reader", "No exclamation marks"],
    preferredTerms: ["run", "workspace"],
    bannedTerms: ["leverage", "synergy"],
    platformVoice: [{ platform: "LinkedIn", guidance: "Open on the number, not the story." }],
    ctaTaxonomy: [{ situation: "cold social post", cta: "Book a call" }],
    samplePhrases: ["We found three gaps your competitors are exploiting."],
  },
  productInformation: {
    whatItDoes: "Runs a manufacturer's scheduling off its own order book.",
    offerings: [{ name: "Scheduler", whatItIs: "Plans the week from live orders", whoItIsFor: "Ops leads" }],
    businessModel: "Per-seat subscription; pricing not published.",
    primaryCtas: ["Book a demo"],
    proofPoints: ["Named on the customer page: Northwind"],
    // Realistic length: the real ones run 150-260 characters, because a
    // constraint an agent can act on has to say what the limit actually is.
    doNotMisstate: [
      "Never claim ISO certification — they hold none, and the word appears nowhere on the site or in the client-provided material",
      "Never say the scheduler runs unattended — every plan is released by a human, and that gate is the product's own differentiator",
    ],
    faq: [{ question: "Does it integrate with SAP?", answer: "Yes, via the published connector." }],
    techSignals: ["Published REST connector"],
  },
  // intel-report-craft@8 — the rest of the gap to the curated lab profile.
  messaging: {
    positioningStatement: "For ops leads at mid-market manufacturers, the scheduler their order book already implies.",
    valuePropositions: [{ audience: "Ops lead", promise: "The week plans itself from live orders.", proof: "Northwind cut replanning to zero" }],
    messagingPillars: [
      { pillar: "Plans from what is already true", whatItMeans: "The order book is the input; nobody re-keys it.", proofPoints: ["Northwind"], whenToLead: "a cold post" },
    ],
    messageHierarchy: "Lead on the order book. Support with the time saved. Never open on the AI.",
    channelPriorities: [{ channel: "LinkedIn", role: "proof", cadence: "twice a week" }],
  },
  visualDirection: {
    logoUsage: ["Never on a photograph", "Clear space of one mark-height"],
    imagery: { direction: "Plant floors, shot wide and lit flat.", subjects: ["machines at rest"], avoid: ["handshake stock photography"] },
    iconography: "Stroked, 2px, square corners.",
    layout: "Twelve-column grid, generous left margin.",
    motion: "Cuts, never dissolves.",
  },
  perPlatformReality: [{ platform: "X", observation: "Nobody in the category posts more than weekly.", implication: "A daily cadence is uncontested" }],
  watchList: [{ company: "Initech", why: "Adjacent ERP vendor with the same buyer.", signal: "a scheduling module on their pricing page" }],
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
    // The client's own voice spec leads the document every writing agent reads.
    expect(docs["brand-voice"]).toContain("Short declarative sentences");
    expect(docs["brand-voice"]).toContain("No hype adjectives");
    // Sourced from the intel report...
    expect(docs["brand-voice"]).toContain("Plain-spoken operator");
    // ...and the brand KIT is what "Branding Guidelines" actually contains.
    expect(docs["branding-guidelines"]).toContain("#ff6b2c");
    expect(docs["branding-guidelines"]).toContain("Space Grotesk");
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
    // These three fields are per-company rows (`{ company, archetype }`,
    // `{ dimension, scores: one per company }`, `CustomerSentimentEntry[]`),
    // so they compose into the competitor document. They used to be the bulk
    // of `brand-voice` and the tail of `target-audience`, which is what made
    // a "Brand Voice" document read as a competitor table.
    expect(docs["competitor-analysis"]).toContain("Acme: Sage");
    expect(docs["competitor-analysis"]).toContain("Warmth");
    expect(docs["competitor-analysis"]).toContain("Acme: 4/5");
    expect(docs["competitor-analysis"]).toContain("Competitors analysed: 2");
    expect(docs["competitor-analysis"]).toContain("Initech");
    expect(docs["competitor-analysis"]).toContain("4.2 (Very good)");
    // The buyer-intent prompt set is SEO/GEO material and sits beside the
    // visibility narrative it is scored against.
    expect(docs["market-strategy"]).toContain("best tool for X");
    expect(docs["market-strategy"]).toContain("X vs Northwind");
    // `target-audience` is the ICP blueprint and nothing else.
    expect(docs["target-audience"]).toContain("Ops lead");
    expect(docs["target-audience"]).not.toContain("best tool for X");
    expect(docs["target-audience"]).not.toContain("4.2 (Very good)");
  });

  /**
   * The defect this revision fixes, pinned from the reader's side: the
   * document a writing agent opens to sound like the brand must carry the
   * brand's own rules and must NOT carry a competitor comparison. Both halves
   * are asserted, because the first one passed for three prompt versions
   * while the second was false.
   */
  /**
   * `buildGuidelinesMarkdown` composes the branding markdown as "## Brand
   * Voice" plus the very string also stored as `Client.brandVoice`, so
   * rendering both put the same statement in the document twice — and worse
   * once they drift, as they had for Karos Labs: a hand-edited 958-character
   * `brandVoice` above a stale generated paragraph, two different answers to
   * "how does this brand sound" with nothing to say which one wins.
   */
  it("does not print the brand's voice statement twice when the guidelines repeat it", () => {
    const docs = composeContextDocsFromAgentReports({ client: CLIENT, intelReport: INTEL_REPORT, seoGeo: SEO_GEO });
    const doc = docs["brand-voice"];
    expect(doc).toContain("Short declarative sentences");
    // The Do's and Don'ts survive; the duplicated voice paragraph does not.
    expect(doc).toContain("No hype adjectives");
    expect(doc).not.toContain("Plain and exact.");
  });

  it("keeps the whole guidelines markdown when the client has no voice of its own", () => {
    const docs = composeContextDocsFromAgentReports({
      client: { ...(CLIENT as object), brandVoice: undefined } as never,
      intelReport: INTEL_REPORT,
      seoGeo: SEO_GEO,
    });
    // Nothing above it to duplicate, so its voice paragraph is the only one
    // the document would have and it stays.
    expect(docs["brand-voice"]).toContain("Plain and exact.");
  });

  it("keeps the per-company comparison tables out of brand-voice and the brand's own rules in it", () => {
    const docs = composeContextDocsFromAgentReports({
      client: CLIENT,
      intelReport: INTEL_REPORT,
      seoGeo: SEO_GEO,
    });
    expect(docs["brand-voice"]).toContain("No exclamation marks");
    expect(docs["brand-voice"]).toContain("Precise");
    // The two sections that made this document a competitor table, by the
    // per-company rows only they can produce: an archetype label the client
    // does not hold, and a rival's score in the comparison grid.
    expect(docs["brand-voice"]).not.toContain("Northwind: Creator");
    expect(docs["brand-voice"]).not.toContain("Northwind: 2/5");
    expect(docs["competitor-analysis"]).toContain("Northwind: Creator");
    expect(docs["competitor-analysis"]).toContain("Northwind: 2/5");
    // `brandVoiceTerritory` is the deliberate exception and still lands here:
    // it is one paragraph about where THIS voice sits, which is what a writer
    // needs, even though it names a rival to say so.
    expect(docs["brand-voice"]).toContain("Plain-spoken operator");
  });

  /**
   * The two blocks intel-report-craft@7 added, and the documents they exist
   * for. Before them, `brand-voice` had no rule a writer could follow and
   * `product-information` had nothing about the product — and neither gap was
   * visible, because both documents composed non-empty out of competitor
   * comparison and marketing analysis respectively.
   */
  it("puts the researched voice spec in brand-voice, in a form a writer can follow", () => {
    const docs = composeContextDocsFromAgentReports({ client: CLIENT, intelReport: INTEL_REPORT, seoGeo: SEO_GEO });
    const doc = docs["brand-voice"];
    expect(doc).toContain("A calm operator who moves fast.");
    expect(doc).toContain("plain to technical");
    // A NOUN label, so the condition need not agree with our sentence — two
    // real Geektime rows came back as "Shifts toward formal..." and "Never
    // shifts to observer frame", which the old prefix turned into a stutter
    // and a contradiction respectively.
    expect(doc).toContain("_When it shifts:_ the reader is an engineer");
    expect(doc).toContain("No exclamation marks");
    expect(doc).toContain("Never say this");
    expect(doc).toContain("LinkedIn");
    expect(doc).toContain("cold social post → Book a call");
    // The client's own statement still leads it: the client record is
    // hand-editable and an edit there must outrank a research run.
    expect(doc.indexOf("Short declarative sentences")).toBeLessThan(doc.indexOf("A calm operator"));
  });

  it("puts the product in product-information, with the claims an agent may not make above the analyses", () => {
    const docs = composeContextDocsFromAgentReports({ client: CLIENT, intelReport: INTEL_REPORT, seoGeo: SEO_GEO });
    const doc = docs["product-information"];
    expect(doc).toContain("Runs a manufacturer's scheduling off its own order book.");
    expect(doc).toContain("**Scheduler**");
    expect(doc).toContain("Per-seat subscription");
    expect(doc).toContain("Book a demo");
    expect(doc).toContain("Does it integrate with SAP?");
    // An agent that reads only the top of this document must still see what it
    // is not allowed to claim, so the constraint precedes the commentary.
    expect(doc.indexOf("Never claim ISO certification")).toBeLessThan(doc.indexOf("Content analysis"));
    // And staff briefing a run see it on the internal-only row too.
    expect(docs["client-guidelines"]).toContain("Never claim ISO certification");
  });

  /**
   * Both blocks are optional on the report — the prompt tells the model to omit
   * rather than invent house style or a product it could not read. Neither
   * document may go empty when that happens, because an empty row fails the
   * shape gate and takes the whole onboarding with it.
   */
  it("composes both documents without either block", () => {
    const { brandVoiceSpec: _v, productInformation: _p, ...withoutBlocks } = INTEL_REPORT;
    const docs = composeContextDocsFromAgentReports({ client: CLIENT, intelReport: withoutBlocks, seoGeo: SEO_GEO });
    expect(docs["brand-voice"].trim()).not.toBe("");
    expect(docs["product-information"].trim()).not.toBe("");
    expect(docs["brand-voice"]).toContain("Short declarative sentences");
    // The fallback is now the two analyses that remain - contentAnalysis and
    // conversionAnalysis, both REQUIRED on the report - rather than
    // positioningAnalysis, which was a verbatim copy of market-strategy's.
    expect(docs["product-information"]).toContain("Docs outrank marketing pages");
  });

  /**
   * intel-report-craft@8 — the blocks that close the rest of the gap to the
   * curated lab profile the owner set as the bar. Each one is asserted in the
   * document it exists for, because each was measured as a section the lab
   * profile carried and this pipeline could not produce at all.
   */
  it("leads market-strategy with the message architecture, hierarchy and all", () => {
    const docs = composeContextDocsFromAgentReports({ client: CLIENT, intelReport: INTEL_REPORT, seoGeo: SEO_GEO });
    const doc = docs["market-strategy"];
    expect(doc).toContain("the scheduler their order book already implies");
    expect(doc).toContain("Plans from what is already true");
    expect(doc).toContain("Never open on the AI.");
    expect(doc).toContain("**LinkedIn:** proof");
    // The prescriptive half precedes the analytical half: an agent reading
    // only the top should come away with what to SAY.
    expect(doc.indexOf("What we say")).toBeLessThan(doc.indexOf("Positioning"));
  });

  it("gives branding-guidelines the art direction a renderer needs", () => {
    const docs = composeContextDocsFromAgentReports({ client: CLIENT, intelReport: INTEL_REPORT, seoGeo: SEO_GEO });
    const doc = docs["branding-guidelines"];
    expect(doc).toContain("Never on a photograph");
    expect(doc).toContain("Plant floors, shot wide");
    // `avoid` is the half a sourcing agent can reject a candidate on.
    expect(doc).toContain("handshake stock photography");
    expect(doc).toContain("Cuts, never dissolves.");
  });

  it("puts the moving competitive picture in competitor-analysis", () => {
    const docs = composeContextDocsFromAgentReports({ client: CLIENT, intelReport: INTEL_REPORT, seoGeo: SEO_GEO });
    const doc = docs["competitor-analysis"];
    expect(doc).toContain("Nobody in the category posts more than weekly");
    expect(doc).toContain("a scheduling module on their pricing page");
  });

  it("puts the writer-facing rules in target-audience, above the evidence", () => {
    const docs = composeContextDocsFromAgentReports({ client: CLIENT, intelReport: INTEL_REPORT, seoGeo: SEO_GEO });
    const doc = docs["target-audience"];
    expect(doc).toContain("Open on the cost of replanning");
    expect(doc.indexOf("How to appeal to them")).toBeLessThan(doc.indexOf("## Evidence"));
  });

  it("composes every document without any of the craft@8 blocks", () => {
    const { messaging: _m, visualDirection: _v, perPlatformReality: _p, watchList: _w, ...without } = INTEL_REPORT;
    const docs = composeContextDocsFromAgentReports({ client: CLIENT, intelReport: without, seoGeo: SEO_GEO });
    for (const docType of [...INTERNAL_CONTEXT_DOC_TYPES, ...INTERNAL_ONLY_CONTEXT_DOC_TYPES]) {
      expect(docs[docType].trim(), docType).not.toBe("");
    }
  });

  /**
   * No generated document may be a copy of another. Five of the eight were
   * before this revision — `branding-guidelines` was a strict subset of
   * `brand-voice`, and `client-guidelines` repeated `market-strategy`'s whole
   * recommendation list — which is what made the set read as one report
   * reshuffled eight ways.
   */
  /**
   * Two real Geektime rows, verbatim from the 2026-09-18 Regenerate. The model
   * restates the field's own name inside the value, which the old prefixes
   * ("— shifts when ", "_Lead with this when:_ ") turned into a stutter and,
   * once, a flat contradiction: "shifts when Never shifts to observer frame".
   * Karos Labs' run happened to phrase both as bare clauses, so one client
   * alone would never have shown this. A noun label reads correctly whichever
   * way the model writes it.
   */
  it("reads correctly when the model restates the field name inside its own value", () => {
    const docs = composeContextDocsFromAgentReports({
      client: CLIENT,
      intelReport: {
        ...INTEL_REPORT,
        brandVoiceSpec: {
          ...INTEL_REPORT.brandVoiceSpec,
          dimensions: [
            { scale: "insider to observer", position: "Always insider", shiftsWhen: "Never shifts to observer frame — this is the brand moat" },
          ],
        },
        messaging: {
          ...INTEL_REPORT.messaging,
          messagingPillars: [
            {
              pillar: "Of the community",
              whatItMeans: "The publication is of the industry, not covering it.",
              whenToLead: "Lead with this pillar in all editorial brand campaigns",
            },
          ],
        },
      },
      seoGeo: SEO_GEO,
    });

    expect(docs["brand-voice"]).not.toContain("shifts when Never shifts");
    expect(docs["brand-voice"]).toContain("_When it shifts:_ Never shifts to observer frame");
    expect(docs["market-strategy"]).not.toContain("Lead with this when:_ Lead with this pillar");
    expect(docs["market-strategy"]).toContain("_When to lead with it:_ Lead with this pillar");
  });

  /**
   * The owner's complaint, measured. On the real Karos Labs documents, 23
   * paragraphs over 200 characters appeared in more than one of the eight —
   * more duplicated prose than several of the documents had of their own,
   * which is why the set read as one report reshuffled eight ways.
   *
   * Exactly one repetition is allowed, and it is named: `doNotMisstate`, on
   * `product-information` and again on the internal-only `client-guidelines`.
   * That list's cost of being missed is a claim the client has to retract, and
   * `client-guidelines` is the row staff read before briefing a run. Any
   * OTHER shared paragraph is the defect coming back.
   */
  it("repeats exactly one paragraph across the set, and it is the one we chose", () => {
    const docs = composeContextDocsFromAgentReports({ client: CLIENT, intelReport: INTEL_REPORT, seoGeo: SEO_GEO });
    const all = [...INTERNAL_CONTEXT_DOC_TYPES, ...INTERNAL_ONLY_CONTEXT_DOC_TYPES];

    const owners = new Map<string, string[]>();
    for (const docType of all) {
      for (const para of docs[docType].split("\n\n").map((p) => p.trim())) {
        if (para.length <= 200 || para.startsWith("#")) continue;
        owners.set(para, [...(owners.get(para) ?? []), docType]);
      }
    }
    const shared = [...owners.entries()].filter(([, who]) => who.length > 1);

    for (const [para, who] of shared) {
      expect(para, `unexpected repetition across ${who.join(" + ")}`).toContain("Never claim ISO certification");
      expect(who.sort()).toEqual(["client-guidelines", "product-information"]);
    }
    expect(shared).toHaveLength(1);
  });

  it("gives every document at least one substantial paragraph no other document has", () => {
    const docs = composeContextDocsFromAgentReports({
      client: CLIENT,
      intelReport: INTEL_REPORT,
      seoGeo: SEO_GEO,
    });
    const all = [...INTERNAL_CONTEXT_DOC_TYPES, ...INTERNAL_ONLY_CONTEXT_DOC_TYPES];
    const paragraphs = (text: string) =>
      text
        .split("\n\n")
        .map((p) => p.trim())
        .filter((p) => p.length > 40 && !p.startsWith("#"));
    for (const docType of all) {
      const mine = paragraphs(docs[docType]);
      const theirs = new Set(all.filter((d) => d !== docType).flatMap((d) => paragraphs(docs[d])));
      expect(mine.filter((p) => !theirs.has(p)), docType).not.toHaveLength(0);
    }
  });

  it("omits a section whose field the engine did not send instead of throwing", () => {
    const docs = composeContextDocsFromAgentReports({
      // `client` without a brand kit too: every `brand-voice` source is
      // optional now, so this is the case the document's fallback exists for.
      client: { id: CLIENT_ID, name: "Acme" } as never,
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
    // No stored rows: the carry-forward in `writeContextDocsFromResearch`
    // has nothing to preserve, so these cases exercise the composed output
    // exactly as they did before it existed. Overridden per-case where a
    // test is about the carry-forward itself.
    listDocs: async () => [],
    now: () => 1_700_000_000_000,
    sleep: async () => {},
  };
  return { deps: { ...base, ...overrides } as never, written };
}

/**
 * The carry-forward. This path REPLACES the whole contract in one batch, so a
 * research step that failed or came back empty used to have two endings: a
 * blank document stored as the client's ground truth, or a shape error that
 * failed the run and refreshed nothing. A document eight agents read on every
 * run should survive a bad run instead.
 */
describe("a document the research could not fill", () => {
  const storedRow = (docType: string, tier: string, content: string) =>
    ({ id: `${docType}-${tier}`, clientId: CLIENT_ID, docType, tier, content, version: 3, createdAt: 1, updatedAt: 1 }) as never;

  it("keeps the stored document rather than replacing it with nothing", async () => {
    const { deps: d, written } = deps({
      // Everything the `target-audience` document is composed from is gone.
      getDeliverable: async (_runId: string, kind: string) =>
        kind === INTEL_REPORT_DELIVERABLE_KIND ? { ...INTEL_REPORT, targetAudience: undefined } : { ...SEO_GEO, promptSet: undefined },
      listDocs: async () => [storedRow("target-audience", "internal", "# Target Audience\n\nThe ICP we already had.")],
    });

    await runAgentOnboarding(CLIENT_ID, d);
    const row = written[0].docs.find((r) => r.docType === "target-audience" && r.tier === "internal")!;
    expect(row.content).toContain("The ICP we already had.");
    // And the client-tier condensation runs over the carried-forward content,
    // so the two tiers cannot disagree about what the document says.
    expect(written[0].docs.some((r) => r.docType === "target-audience" && r.tier === "client")).toBe(true);
  });

  it("never lets a stored document outlive research that did produce one", async () => {
    const { deps: d, written } = deps({
      listDocs: async () => [storedRow("target-audience", "internal", "STALE — from a run two months ago.")],
    });

    await runAgentOnboarding(CLIENT_ID, d);
    const row = written[0].docs.find((r) => r.docType === "target-audience" && r.tier === "internal")!;
    expect(row.content).not.toContain("STALE");
    expect(row.content).toContain("Ops lead");
  });

  it("still fails the run when there is nothing stored to carry forward", async () => {
    const { deps: d } = deps({
      getDeliverable: async () => ({}),
      listDocs: async () => [],
    });
    // Nothing to preserve, so the gate is still the right answer: this is the
    // one failure an empty document exists to catch.
    await expect(runAgentOnboarding(CLIENT_ID, d)).rejects.toBeInstanceOf(ContextDocShapeError);
  });
});

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
