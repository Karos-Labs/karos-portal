import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));

/**
 * The intel pipeline's lab mode, driven through the REAL `runIntelReportPipeline`
 * and the REAL `agentOnboardingDeps` wiring. Only the edges are replaced: the
 * Firestore wrappers in data.ts (by in-memory stand-ins with the same write
 * semantics), the engine, the condensation model, branding, the workspace
 * projection and the materializer.
 *
 * The client in the lab half is shaped on N°3 Courchevel 1850 as it stands in
 * both databases: seven curated internal documents from the lab (its
 * client-guidelines at tier "internal", where the importer put it), six
 * client-tier condensations of them, a locked brand, four competitors from the
 * lab's tracking file, no Intel Report and no SEO/GEO capture.
 */

type Row = Record<string, unknown>;

const S = vi.hoisted(() => {
  let seq = 0;
  const state = {
    nextId: (prefix: string) => `${prefix}-${++seq}`,
    clients: new Map<string, Record<string, unknown>>(),
    docs: [] as Array<Record<string, unknown>>,
    competitors: [] as Array<{ id: string; data: Record<string, unknown> }>,
    reports: new Map<string, Record<string, unknown>>(),
    jobs: new Map<string, Record<string, unknown>>(),
    /** A client read that returns a different record from the Nth call on, for the "asked NOW" case. */
    clientOverride: null as null | { id: string; fromCall: number; value: Record<string, unknown> },
    clientReads: new Map<string, number>(),
    calls: {
      replaceDocs: [] as Array<{ clientId: string; docs: Array<Record<string, unknown>> }>,
      upsertDoc: [] as Array<Record<string, unknown>>,
      branding: [] as string[],
      condense: [] as Array<{ docTypes: string[]; internal: Record<string, string> }>,
      materialize: [] as string[],
      project: [] as string[],
    },
    deliverables: {
      intel: {} as Record<string, unknown>,
      seo: {} as Record<string, unknown>,
    },
    /** docTypes the fake condensation returns empty for, as a failed vendor call does. */
    condenseFails: new Set<string>(),
    /** The dispatch hands back job ids that no read can find. */
    jobsVanish: false,
  };
  return state;
});

vi.mock("@/lib/data", async () => {
  const { planReportCompetitorReplacement } = await import("@/lib/competitor-replace");
  const clone = <T,>(v: T): T => structuredClone(v);
  return {
    getClient: async (id: string) => {
      const n = (S.clientReads.get(id) ?? 0) + 1;
      S.clientReads.set(id, n);
      if (S.clientOverride && S.clientOverride.id === id && n >= S.clientOverride.fromCall) return clone(S.clientOverride.value);
      return S.clients.has(id) ? clone(S.clients.get(id)) : null;
    },
    getJob: async (id: string) => (S.jobs.has(id) ? clone(S.jobs.get(id)) : null),
    upsertClientReport: async (report: Record<string, unknown>) => {
      S.reports.set(report.clientId as string, clone(report));
    },
    // The real merge rules, applied the way data.ts applies them.
    replaceReportCompetitors: async (clientId: string, rows: Array<Record<string, unknown>>) => {
      const mine = S.competitors.filter((c) => c.data.clientId === clientId);
      const plan = planReportCompetitorReplacement(clone(mine) as never, rows as never, 42);
      for (const { id, patch } of plan.updates) {
        const target = S.competitors.find((c) => c.id === id)!;
        target.data = { ...target.data, ...patch };
      }
      S.competitors = S.competitors.filter((c) => !plan.deletes.includes(c.id));
      for (const created of plan.creates) S.competitors.push({ id: S.nextId("comp"), data: clone(created) as never });
    },
    listClientContextDocs: async (clientId: string, tier?: string) =>
      clone(S.docs.filter((d) => d.clientId === clientId && (!tier || d.tier === tier))),
    // `set`, not merge: the real wrapper overwrites the row it finds.
    upsertClientContextDoc: async (doc: Record<string, unknown>) => {
      S.calls.upsertDoc.push(clone(doc));
      const i = S.docs.findIndex((d) => d.clientId === doc.clientId && d.docType === doc.docType && d.tier === doc.tier);
      if (i === -1) S.docs.push({ id: S.nextId("doc"), ...clone(doc) });
      else S.docs[i] = { id: S.docs[i]!.id, ...clone(doc) };
    },
    // Delete every row of the client, then write the set.
    replaceClientContextDocs: async (clientId: string, docs: Array<Record<string, unknown>>) => {
      S.calls.replaceDocs.push({ clientId, docs: clone(docs) });
      S.docs = S.docs.filter((d) => d.clientId !== clientId);
      for (const doc of docs) S.docs.push({ id: S.nextId("doc"), ...clone(doc) });
    },
  };
});

// What the real one does, in miniature: a palette re-derived from the website,
// and the branding-guidelines document rewritten to match (branding.ts,
// "Context doc writes"). If a lab run ever reached it, both would show.
vi.mock("@/lib/branding", () => ({
  applyBrandingForClient: async (clientId: string) => {
    S.calls.branding.push(clientId);
    const client = S.clients.get(clientId)!;
    client.brandingGuidelines = { dominantColors: [{ hex: "#6366f1", dominanceRank: 1 }], updatedAt: 99 };
    const i = S.docs.findIndex((d) => d.clientId === clientId && d.docType === "branding-guidelines" && d.tier === "internal");
    if (i >= 0) S.docs[i] = { ...S.docs[i], content: "# Branding Guidelines, from the website", version: (S.docs[i]!.version as number) + 1 };
    return { source: "ai_generated", primaryAccent: "#6366f1" };
  },
}));

vi.mock("@/lib/agent-engine/dispatch-research-agents", () => ({
  dispatchOnboardingResearchAgents: async (client: { id: string }) => {
    const dispatch = (productId: string) => {
      const jobId = `job-${productId}-${client.id}`;
      const agentEngineRunId = `run-${productId}-${client.id}`;
      if (!S.jobsVanish) {
        S.jobs.set(jobId, { id: jobId, clientId: client.id, agentEngineRunId, agentEngineProductId: productId, assetIds: [], status: "queued" });
      }
      return { jobId, agentEngineRunId };
    };
    return { intelReport: dispatch("intel-report-agent"), seoGeo: dispatch("seo-geo-agent") };
  },
}));

vi.mock("@/lib/agent-engine/client", () => ({
  getAgentEngineDeliverable: async (_runId: string, kind: string) =>
    kind === "intel-report" ? S.deliverables.intel : S.deliverables.seo,
}));

// The condensation model: echoes its input, so a client-tier row can be traced
// back to the internal document it was condensed from.
vi.mock("@/lib/intel/condense", () => ({
  condenseDocs: async (_client: unknown, docTypes: string[], internal: Record<string, string>) => {
    S.calls.condense.push({ docTypes: [...docTypes], internal: { ...internal } });
    return docTypes.map((docType) => ({
      docType,
      content: internal[docType]?.trim() && !S.condenseFails.has(docType) ? `condensed ${docType} <- ${internal[docType]}` : "",
    }));
  },
}));

vi.mock("@/lib/agent-engine/context-doc-projection", () => ({
  projectClientToWorkspace: async (client: { id: string }) => {
    S.calls.project.push(client.id);
    return { projected: true, contextDocs: 0, brand: true, profile: true };
  },
}));

vi.mock("@/lib/agent-engine/materialize", () => ({
  materializeAgentEngineDeliverable: async (job: { id: string }) => {
    S.calls.materialize.push(job.id);
    return undefined;
  },
}));

const { runIntelReportPipeline } = await import("../intel/report");
const {
  CONTEXT_DOC_SET_CONTRACT,
  LAB_CONTEXT_DOC_WRITE_CONTRACT,
  ContextDocShapeError,
  assertLabContextDocWriteShape,
} = await import("../intel/agent-onboarding");

/* ── Fixtures ─────────────────────────────────────────────────────── */

const LAB_ID = "lab-n3";
const PORTAL_ID = "portal-acme";

const INTEL = {
  overallScore: 58,
  overallGrade: "C",
  dimensionScores: [{ dimension: "positioning", score: 61 }],
  swot: { strengths: ["One address"], weaknesses: ["No booking engine"], opportunities: ["Winter search demand"], threats: ["Palace residences"] },
  recommendations: [{ title: "Publish the three apartments' floor areas", description: "Every rival states them." }],
  competitorRankings: [{ company: "Le Strato", score: 74 }],
  competitors: [
    // The twin of a lab row, with the analysis the lab file never carries.
    { company: "Le Strato", url: "lestrato.com", positioning: "Ski-in hotel residences", keyStrengths: ["Slope access"], marketTier: "Niche", overlap: "Low", threatLevel: "LOW" },
    { company: "Six Senses Residences", marketTier: "Leader", overlap: "Medium" },
  ],
  brandAnalysis: "Discreet, factual, French.",
  brandVoiceTerritory: "The concierge who knows the mountain.",
  positioningAnalysis: "Three keys at one address.",
  contentAnalysis: "No public floor areas.",
  conversionAnalysis: "Enquiry by email only.",
  growthAnalysis: "Referral-led.",
  targetAudience: { summary: "Known guests who rebook." },
};

const SEO = {
  seoScore: { score: 44 },
  geoReadiness: { score: 30 },
  narrative: "New domain, thin index.",
  visibility: { byN: null, byNe: null },
  firedRecommendations: [{ recId: "SEO-3", recommendation: "Add a sitemap" }],
  measuredFacts: ["4 pages indexed"],
  promptSet: { prompts: [{ promptText: "luxury apartment courchevel 1850" }] },
};

const LAB_INTERNAL = {
  "brand-voice": "---\nmodule: brand-voice\nclient: n3\n---\n## 1. Voice in one line\nSobre, précis, confidentiel.",
  "market-strategy": "---\nmodule: market-strategy\n---\n## 1. Positioning\nUne adresse, trois clés.",
  "competitor-analysis": "---\nmodule: competitor-analysis\n---\n## 1. The landscape\nFour direct rivals.",
  "product-information": "---\nmodule: product-information\n---\n## 1. The maison\nSaulire, Vizelle, Loze.",
  "branding-guidelines": "---\nmodule: branding-guidelines\n---\n## 1. Colour: four, and nothing else\npierre #D8D0C2, encre #26241F, bordeaux #5F2329, ardoise #4A6076.",
  "target-audience": "---\nmodule: target-audience\n---\nThe guest is defined by relationship.",
  "client-guidelines": "---\nmodule: client-guidelines\n---\n10. 1850 is a name, never a measurement.",
};

const LAB_BRAND = {
  dominantColors: [
    { hex: "#D8D0C2", dominanceRank: 1, role: "pierre" },
    { hex: "#26241F", dominanceRank: 2, role: "encre" },
    { hex: "#5F2329", dominanceRank: 3, role: "bordeaux" },
    { hex: "#4A6076", dominanceRank: 4, role: "ardoise" },
  ],
  fontHeading: "Instrument Serif",
  fontBody: "Instrument Sans",
  logoUrl: "https://storage.example/client-logos/lab-n3/n3-avatar-v3.png",
  logoStoragePath: "client-logos/lab-n3/n3-avatar-v3.png",
  updatedAt: 1_757_550_000_000,
};

function seedLabClient(overrides: Record<string, unknown> = {}) {
  S.clients.set(LAB_ID, {
    id: LAB_ID,
    name: "N°3 Courchevel 1850",
    website: "https://n3courchevel.com",
    agentsRepoSlug: "n3",
    profileSource: "lab",
    brandingGuidelines: LAB_BRAND,
    logoUrl: LAB_BRAND.logoUrl,
    logoStoragePath: LAB_BRAND.logoStoragePath,
    accentColor: "#5F2329",
    assignedEmployeeIds: [],
    status: "active",
    ...overrides,
  });
  let at = 1_757_200_000_000;
  for (const [docType, content] of Object.entries(LAB_INTERNAL)) {
    S.docs.push({ id: `lab-internal-${docType}`, clientId: LAB_ID, docType, tier: "internal", content, version: 2, createdAt: at, updatedAt: at + 5 });
    at += 1000;
  }
  for (const docType of ["brand-voice", "market-strategy", "competitor-analysis", "product-information", "branding-guidelines", "target-audience"]) {
    S.docs.push({ id: `lab-client-${docType}`, clientId: LAB_ID, docType, tier: "client", content: `published ${docType}`, version: 1, createdAt: 1_757_550_000_000, updatedAt: 1_757_550_000_000, summary: ["cached"], summaryVersion: 1 });
  }
  // A staff-private row outside the onboarding set, which no run may touch either.
  S.docs.push({ id: "lab-meeting-notes", clientId: LAB_ID, docType: "meeting-notes", tier: "internal-only", content: "# Meeting Notes\nCall 2026-09-08.", version: 3, createdAt: 1, updatedAt: 2 });
  for (const [i, company] of ["Le Mascara (Cimalpes)", "Atmosphère", "Le Strato", "Les Grandes Alpes"].entries()) {
    S.competitors.push({
      id: `lab-comp-${i + 1}`,
      data: { clientId: LAB_ID, company, marketTier: "Leader", overlap: "High", threatLevel: "HIGH", deepDive: false, keyStrengths: [], keyWeaknesses: [], source: "lab", createdAt: 1_757_200_000_000, updatedAt: 1_757_200_000_000 },
    });
  }
}

function seedPortalClient() {
  S.clients.set(PORTAL_ID, {
    id: PORTAL_ID,
    name: "Acme",
    website: "https://acme.test",
    agentsRepoSlug: "acme",
    // A brand the pipeline itself derived: present, and still not the lab's.
    brandingGuidelines: { dominantColors: [{ hex: "#111111", dominanceRank: 1 }], updatedAt: 5 },
    assignedEmployeeIds: [],
    status: "active",
  });
  for (const row of CONTEXT_DOC_SET_CONTRACT) {
    S.docs.push({ id: `old-${row.docType}-${row.tier}`, clientId: PORTAL_ID, docType: row.docType, tier: row.tier, content: `old ${row.docType}`, version: 1, createdAt: 3, updatedAt: 3 });
  }
  S.competitors.push({ id: "p-r1", data: { clientId: PORTAL_ID, company: "Globex", marketTier: "Other", overlap: "Low", deepDive: false, keyStrengths: [], keyWeaknesses: [], source: "report", createdAt: 3, updatedAt: 3 } });
  S.competitors.push({ id: "p-m1", data: { clientId: PORTAL_ID, company: "Hooli", marketTier: "Challenger", overlap: "Medium", deepDive: false, keyStrengths: [], keyWeaknesses: [], source: "manual", createdAt: 3, updatedAt: 3 } });
}

const rowsOf = (clientId: string) => S.docs.filter((d) => d.clientId === clientId);
const byId = (rows: Row[]) => new Map(rows.map((r) => [r.id as string, r]));

beforeEach(() => {
  S.clients.clear();
  S.docs = [];
  S.competitors = [];
  S.reports.clear();
  S.jobs.clear();
  S.clientOverride = null;
  S.clientReads.clear();
  S.condenseFails.clear();
  S.jobsVanish = false;
  for (const list of Object.values(S.calls)) list.length = 0;
  S.deliverables.intel = structuredClone(INTEL);
  S.deliverables.seo = structuredClone(SEO);
  seedLabClient();
  seedPortalClient();
});

/* ── A lab client ─────────────────────────────────────────────────── */

describe("runIntelReportPipeline — a lab client (profileSource: \"lab\")", () => {
  it("keeps every internal and internal-only row byte for byte, and adds only the action plan", async () => {
    const before = byId(structuredClone(rowsOf(LAB_ID)));
    await runIntelReportPipeline(LAB_ID);
    const after = rowsOf(LAB_ID);

    for (const [id, row] of before) {
      if (row.tier === "client") continue;
      expect(after.find((r) => r.id === id), `${row.docType}::${row.tier}`).toEqual(row);
    }
    const added = after.filter((r) => !before.has(r.id as string));
    expect(added.map((r) => `${r.docType}::${r.tier}`)).toEqual(["action-plan::internal-only"]);
    expect(added[0]!.content).toContain("Publish the three apartments' floor areas");
    expect(added[0]!.version).toBe(1);
    expect(S.calls.replaceDocs).toEqual([]);
  });

  it("refreshes the client tier from the lab's own internal documents, in place", async () => {
    const before = byId(structuredClone(rowsOf(LAB_ID)));
    await runIntelReportPipeline(LAB_ID);

    // The condensation read the lab's documents, not the research's composition.
    expect(S.calls.condense).toHaveLength(1);
    const { internal, docTypes } = S.calls.condense[0]!;
    expect(docTypes).toEqual(["brand-voice", "market-strategy", "competitor-analysis", "product-information", "branding-guidelines", "target-audience"]);
    for (const docType of docTypes) expect(internal[docType]).toBe(LAB_INTERNAL[docType as keyof typeof LAB_INTERNAL]);

    for (const row of rowsOf(LAB_ID).filter((r) => r.tier === "client")) {
      const prev = before.get(row.id as string)!;
      expect(prev, "a client-tier row was re-created instead of updated in place").toBeDefined();
      expect(row.content).toBe(`condensed ${row.docType} <- ${LAB_INTERNAL[row.docType as keyof typeof LAB_INTERNAL]}`);
      expect(row.version).toBe((prev.version as number) + 1);
      expect(row.createdAt).toBe(prev.createdAt);
    }
  });

  it("leaves the brand alone: no branding run, and the client record is unchanged", async () => {
    const before = structuredClone(S.clients.get(LAB_ID));
    await runIntelReportPipeline(LAB_ID);
    expect(S.calls.branding).toEqual([]);
    expect(S.clients.get(LAB_ID)).toEqual(before);
  });

  it("keeps the lab's competitors, curated fields intact, and folds the analysis twin into its lab row", async () => {
    const before = structuredClone(S.competitors.filter((c) => c.data.clientId === LAB_ID));
    await runIntelReportPipeline(LAB_ID);
    const after = S.competitors.filter((c) => c.data.clientId === LAB_ID);

    for (const lab of before) {
      const now = after.find((c) => c.id === lab.id);
      expect(now, lab.data.company as string).toBeDefined();
      for (const field of ["company", "marketTier", "overlap", "threatLevel", "source", "createdAt"]) {
        expect(now!.data[field], `${lab.data.company}.${field}`).toEqual(lab.data[field]);
      }
    }
    // One Le Strato, the lab's, now carrying what the analysis found.
    const strato = after.filter((c) => c.data.company === "Le Strato");
    expect(strato).toHaveLength(1);
    expect(strato[0]!.id).toBe("lab-comp-3");
    expect(strato[0]!.data.positioning).toBe("Ski-in hotel residences");
    expect(strato[0]!.data.url).toBe("lestrato.com");
    // The rival the lab did not list arrives as an ordinary report row.
    expect(after.filter((c) => c.data.source === "report").map((c) => c.data.company)).toEqual(["Six Senses Residences"]);
  });

  it("stores the Intel Report and projects the client, as every run does", async () => {
    await runIntelReportPipeline(LAB_ID);
    expect(S.reports.get(LAB_ID)).toMatchObject({ clientId: LAB_ID, overallScore: 58 });
    expect(S.calls.project).toContain(LAB_ID);
  });

  it("keeps the client-tier copy it had when a condensation comes back empty", async () => {
    S.condenseFails.add("market-strategy");
    const before = structuredClone(rowsOf(LAB_ID).find((r) => r.docType === "market-strategy" && r.tier === "client"));
    await runIntelReportPipeline(LAB_ID);
    expect(rowsOf(LAB_ID).find((r) => r.docType === "market-strategy" && r.tier === "client")).toEqual(before);
  });

  it("fails loudly on a blank action plan, after storing the report, with no document written", async () => {
    // Nothing behind any action-plan section: no recommendations, fired
    // recommendations, measured facts or fix drafts.
    S.deliverables.intel = { ...structuredClone(INTEL), recommendations: [] };
    S.deliverables.seo = { seoScore: { score: 44 } };
    const before = structuredClone(rowsOf(LAB_ID));

    await expect(runIntelReportPipeline(LAB_ID)).rejects.toThrow(/required row action-plan::internal-only is missing|has empty content/);
    expect(S.reports.get(LAB_ID)).toBeDefined();
    expect(rowsOf(LAB_ID)).toEqual(before);
    expect(S.calls.upsertDoc).toEqual([]);
  });

  it("decides from the client as it is when the documents are written, not as it was at dispatch", async () => {
    // Dispatch reads a portal-owned client; by the time the research is back
    // it has been imported from the lab. The documents must be treated as the lab's.
    const labNow = structuredClone(S.clients.get(LAB_ID)!);
    S.clients.set(LAB_ID, { ...labNow, profileSource: undefined });
    S.clientOverride = { id: LAB_ID, fromCall: 2, value: labNow };

    await runIntelReportPipeline(LAB_ID);
    expect(S.calls.replaceDocs).toEqual([]);
    expect(S.calls.branding).toEqual([]);
  });
});

/* ── A client whose profile the portal owns ───────────────────────── */

describe("runIntelReportPipeline — a portal-owned client, exactly as before", () => {
  it("replaces the whole document set through replaceClientContextDocs", async () => {
    await runIntelReportPipeline(PORTAL_ID);

    expect(S.calls.replaceDocs).toHaveLength(1);
    const [{ clientId, docs }] = S.calls.replaceDocs;
    expect(clientId).toBe(PORTAL_ID);
    expect(docs.map((d) => `${d.docType}::${d.tier}`).sort()).toEqual(CONTEXT_DOC_SET_CONTRACT.map((r) => `${r.docType}::${r.tier}`).sort());
    for (const doc of docs) expect(doc.version).toBe(1);
    // The documents are composed from the research, and condensed from that.
    expect(docs.find((d) => d.docType === "brand-voice" && d.tier === "internal")!.content).toContain("Discreet, factual, French.");
    expect(S.calls.condense[0]!.internal["brand-voice"]).toContain("Discreet, factual, French.");
    // No row-by-row writes on this path.
    expect(S.calls.upsertDoc).toEqual([]);
  });

  it("refreshes the brand, even though the client already has brandingGuidelines", async () => {
    await runIntelReportPipeline(PORTAL_ID);
    expect(S.calls.branding).toEqual([PORTAL_ID]);
  });

  it("replaces report competitors and keeps manual ones", async () => {
    await runIntelReportPipeline(PORTAL_ID);
    const after = S.competitors.filter((c) => c.data.clientId === PORTAL_ID);
    expect(after.find((c) => c.id === "p-r1")).toBeUndefined();
    expect(after.find((c) => c.id === "p-m1")).toBeDefined();
    expect(after.filter((c) => c.data.source === "report").map((c) => c.data.company).sort()).toEqual(["Le Strato", "Six Senses Residences"]);
  });

  it("stores the Intel Report and projects the client", async () => {
    await runIntelReportPipeline(PORTAL_ID);
    expect(S.reports.get(PORTAL_ID)).toMatchObject({ clientId: PORTAL_ID, overallScore: 58 });
    expect(S.calls.project).toContain(PORTAL_ID);
  });
});

/* ── Both: the SEO/GEO capture lands with the run ─────────────────── */

/**
 * The one behaviour this change adds for EVERY client, stated apart so the
 * block above can stay "exactly as before". `clientSeoGeo` is written when the
 * seo-geo job is materialized; before, only the reconcile sweep or a view of the
 * Job page did that. The run now materializes its own job, through the same
 * idempotent function, once the competitors the capture's roster is read from
 * are stored.
 */
describe("runIntelReportPipeline — the SEO/GEO capture lands with the run", () => {
  for (const [label, clientId] of [["a lab client", LAB_ID], ["a portal-owned client", PORTAL_ID]] as const) {
    it(`materializes the run's own seo-geo job for ${label}`, async () => {
      await runIntelReportPipeline(clientId);
      expect(S.calls.materialize).toEqual([`job-seo-geo-agent-${clientId}`]);
    });
  }

  it("does not fail the run when the job cannot be read", async () => {
    // The dispatch reports a job id that nobody can find afterwards.
    S.jobsVanish = true;
    await expect(runIntelReportPipeline(PORTAL_ID)).resolves.toBeUndefined();
    expect(S.calls.materialize).toEqual([]);
    expect(S.reports.get(PORTAL_ID)).toBeDefined();
  });
});

/* ── The lab write gate ───────────────────────────────────────────── */

describe("assertLabContextDocWriteShape — what a lab client's run may write", () => {
  const good = (docType: string, tier: string, extra: Row = {}): Row => ({
    clientId: LAB_ID,
    docType,
    tier,
    content: `${docType} body`,
    version: 2,
    createdAt: 1,
    updatedAt: 2,
    ...extra,
  });
  const check = (rows: Row[]) => () => assertLabContextDocWriteShape(rows as never, LAB_ID);

  it("is a strict subset of the stored set, with no internal row and no client-guidelines", () => {
    const stored = new Set(CONTEXT_DOC_SET_CONTRACT.map((r) => `${r.docType}::${r.tier}`));
    for (const row of LAB_CONTEXT_DOC_WRITE_CONTRACT) expect(stored.has(`${row.docType}::${row.tier}`)).toBe(true);
    expect(LAB_CONTEXT_DOC_WRITE_CONTRACT.some((r) => r.tier === "internal")).toBe(false);
    expect(LAB_CONTEXT_DOC_WRITE_CONTRACT.some((r) => r.docType === "client-guidelines")).toBe(false);
  });

  it("passes the action plan with client-tier rows, and the action plan alone", () => {
    expect(check([good("action-plan", "internal-only"), good("brand-voice", "client")])).not.toThrow();
    expect(check([good("action-plan", "internal-only")])).not.toThrow();
  });

  it("fails on an internal row — the lab wrote those", () => {
    expect(check([good("action-plan", "internal-only"), good("brand-voice", "internal")])).toThrow(/row brand-voice::internal belongs to the lab/);
  });

  it("fails on client-guidelines at either tier", () => {
    expect(check([good("action-plan", "internal-only"), good("client-guidelines", "internal-only")])).toThrow(/client-guidelines::internal-only belongs to the lab/);
    expect(check([good("action-plan", "internal-only"), good("client-guidelines", "client")])).toThrow(/client-guidelines::client is not part of the stored context-document set/);
  });

  it("fails when the action plan would reach the client tier", () => {
    expect(check([good("action-plan", "internal-only"), good("action-plan", "client")])).toThrow(/action-plan::client is not part of the stored context-document set/);
  });

  it("fails without the action plan, and on the row rules the full gate enforces", () => {
    expect(check([good("brand-voice", "client")])).toThrow(/required row action-plan::internal-only is missing/);
    expect(check([good("action-plan", "internal-only", { sources: ["x"] })])).toThrow(/carries field "sources"/);
    expect(check([good("action-plan", "internal-only", { content: " " })])).toThrow(/has empty content/);
    expect(check([good("action-plan", "internal-only", { clientId: "other" })])).toThrow(ContextDocShapeError);
  });
});
