import { describe, it, expect, vi } from "vitest";
import fs from "node:fs";
import path from "node:path";

vi.mock("server-only", () => ({}));

const {
  CONTEXT_DOC_SET_CONTRACT,
  composeContextDocsFromAgentReports,
  runAgentOnboarding,
  ContextDocShapeError,
  INTEL_REPORT_DELIVERABLE_KIND,
} = await import("../intel/agent-onboarding");
const { ONBOARDING_DELIVERABLE_TIMEOUT_MS } = await import("../intel/report");

type Row = Record<string, unknown>;

const CLIENT_ID = "fixture-client";
const CLIENT = { id: CLIENT_ID, name: "Fixture Co" } as never;

/**
 * SCRUM-274 (T-B19) — required test evidence: "A full onboarding run against
 * a fixture client, asserting all document types and their storage
 * locations, plus a gate-timeout test that fast-forwards past the hour and
 * proves the run completes."
 *
 * The two deliverables below are shaped exactly like the real, current
 * agent-engine wire shapes (verified against the ref clone —
 * `packages/tools/karos-intel/src/types.ts`'s `IntelReportOutputSchema`,
 * `agents/seo-geo-agent/src/workflow/types.ts`'s `SeoGeoReport`), not the
 * pre-T-B19 fixture shape `agent-onboarding-shape.test.ts` used to carry
 * (which encoded several of the field-path bugs this ticket fixed — see that
 * file's own updated comment and this ticket's report).
 */
const FIXTURE_INTEL_REPORT = {
  overallScore: 64,
  overallGrade: "C",
  dimensionScores: [
    { dimension: "contentMessaging", score: 60 },
    { dimension: "positioning", score: 55 },
  ],
  swot: {
    strengths: ["Strong docs SEO"],
    weaknesses: ["No comparison content"],
    opportunities: ["Answer-engine visibility gap"],
    threats: ["Two funded entrants closing the gap"],
  },
  recommendations: [{ title: "Publish a comparison hub" }],
  competitorRankings: [{ company: "Rival Co", score: 70 }],
  competitors: [{ company: "Rival Co" }, { company: "Second Rival" }],
  brandVoiceRows: [{ dimension: "Formality", scores: { "Fixture Co": "3/5" } }],
  brandVoiceArchetypes: [{ company: "Fixture Co", archetype: "Everyman" }],
  brandVoiceTerritory: "Approachable expert, never condescending.",
  customerSentiment: [{ company: "Fixture Co", rating: "3.9", ratingLabel: "Good" }],
  whitespaceOpportunities: ["Buyer-comparison content"],
  contentAnalysis: "Product pages outrank the blog on every buying term.",
  conversionAnalysis: "Signup flow is the drop-off, not awareness.",
  positioningAnalysis: "Positioned as the developer-first option.",
  growthAnalysis: "Growth is inbound-led with no outbound assist.",
  brandAnalysis: "Consistent voice across docs and site.",
  brandSynchronizationUpdate: "Carry the docs voice into marketing pages verbatim.",
};

const FIXTURE_SEO_GEO = {
  seoScore: { score: 66 },
  geoReadiness: { score: 41 },
  narrative: "Solid organic base, largely absent from AI-answer citations.",
  visibility: { byN: null, byNe: null },
  firedRecommendations: [{ recId: "GEO-9", recommendation: "Add an FAQ schema block to the comparison hub" }],
  fixDrafts: [{ recId: "GEO-9", title: "FAQ schema draft" }],
  promptSet: {
    prompts: [{ promptText: "best fixture tool" }, { promptText: "fixture co vs rival co" }],
    source: "drafted",
  },
};

function fixtureDeps(overrides: Partial<Record<string, unknown>> = {}) {
  const written: { clientId: string; docs: Row[] }[] = [];
  const base = {
    getClient: async () => CLIENT,
    dispatchResearchAgents: async () => ({
      intelReport: { agentEngineRunId: "engine_run_intel_1" },
      seoGeo: { agentEngineRunId: "engine_run_seo_1" },
    }),
    getDeliverable: async (_runId: string, kind: string) =>
      kind === INTEL_REPORT_DELIVERABLE_KIND ? FIXTURE_INTEL_REPORT : FIXTURE_SEO_GEO,
    condense: async (_c: unknown, docTypes: string[]) =>
      docTypes.map((docType) => ({ docType, content: `condensed ${docType} for ${CLIENT_ID}` })),
    replaceDocs: async (clientId: string, docs: Row[]) => {
      written.push({ clientId, docs });
    },
    now: () => 1_700_000_000_000,
    sleep: async () => {},
  };
  return { deps: { ...base, ...overrides } as never, written };
}

describe("SCRUM-274 (T-B19) — the cutover is wired at the real call site", () => {
  const reportSrc = fs.readFileSync(path.join(process.cwd(), "src/lib/intel/report.ts"), "utf8");

  it("the pipeline runs through agent-onboarding, not the deleted \"./pipeline\"", () => {
    expect(reportSrc).toContain('from "./agent-onboarding"');
    expect(reportSrc).toContain("dispatchAndAwaitResearch");
    expect(reportSrc).toContain("writeContextDocsFromResearch");
    // Not a bare substring check (this file's own comments legitimately
    // mention the deleted module by name, in prose, while explaining the
    // cutover) — asserting there is no live import of it is the real check.
    expect(reportSrc).not.toMatch(/import\(["']\.\/pipeline["']\)/);
    expect(reportSrc).not.toMatch(/\brunOnboardPipeline\(/);
  });

  it("the deleted hardcoded pipeline module no longer exists on disk", () => {
    expect(fs.existsSync(path.join(process.cwd(), "src/lib/intel/pipeline.ts"))).toBe(false);
    expect(fs.existsSync(path.join(process.cwd(), "src/lib/intel/templates.ts"))).toBe(false);
    expect(fs.existsSync(path.join(process.cwd(), "src/lib/intel/seo-geo.ts"))).toBe(false);
  });

  /**
   * The Phase A cutover. SCRUM-274 deleted the hardcoded CONTEXT-DOCUMENT
   * pipeline and left the in-process REPORT generation standing, which is how
   * the portal ended up with a second report writer running for six minutes
   * before it dispatched the agent whose job that was.
   *
   * These assert the residue is gone rather than merely bypassed — the same
   * standard the block above holds `./pipeline` to.
   */
  it("generates no report in-process: no model call, no prompt, no markdown parse", () => {
    expect(reportSrc).not.toMatch(/\baiFor\(/);
    expect(reportSrc).not.toMatch(/\bDEFAULT_INTEL_PROMPT\b\s*[,;)]/);
    expect(reportSrc).not.toMatch(/\bparseMarkdownReport\(/);
    expect(reportSrc).not.toMatch(/\brunGuardedReportPass\(/);
    // The report is a mapping of the agent's deliverable now.
    expect(reportSrc).toContain("parsedReportFromDeliverable");
  });

  it("the in-process report-pass module no longer exists on disk", () => {
    expect(fs.existsSync(path.join(process.cwd(), "src/lib/intel/report-stream.ts"))).toBe(false);
  });

  it("dispatches BEFORE it stores anything, so both jobs exist while the run waits", () => {
    // The user-visible half of the cutover: the job documents are created by
    // the dispatch, so a dispatch that happens last is a Jobs list that stays
    // empty for the length of the run. Ordering is asserted by position in the
    // source because it is not otherwise observable from outside — the
    // fixture run below cannot see a Firestore write it does not make.
    const dispatchAt = reportSrc.indexOf("dispatchAndAwaitResearch(");
    const reportWriteAt = reportSrc.indexOf("upsertClientReport(");
    const docsWriteAt = reportSrc.indexOf("writeContextDocsFromResearch(");
    expect(dispatchAt).toBeGreaterThan(-1);
    expect(reportWriteAt).toBeGreaterThan(dispatchAt);
    expect(docsWriteAt).toBeGreaterThan(reportWriteAt);
  });

  it("raises deliverableTimeoutMs strictly above seo-geo-agent's real 1-hour gate auto-approve", () => {
    // T-A20/SCRUM-273's real, merged fix: `timeout: { duration: "1h", onTimeout:
    // "auto_approve" }` (agent-engine's create-seo-geo-agent-workflow.ts). A
    // timeout at or below one hour would fail the run before the auto-approve
    // ever fires — see this ticket's report for the exact value and margin
    // chosen.
    expect(ONBOARDING_DELIVERABLE_TIMEOUT_MS).toBeGreaterThan(60 * 60_000);
    expect(reportSrc).toContain("ONBOARDING_DELIVERABLE_TIMEOUT_MS");
  });
});

describe("SCRUM-274 (T-B19) — a full onboarding run against a fixture client", () => {
  it("produces all 8 distinct document types (14 stored rows) in the shape and location the read path serves", async () => {
    const { deps, written } = fixtureDeps();
    const result = await runAgentOnboarding(CLIENT_ID, deps);

    // "up to 14 stored rows" per agent-onboarding.ts's own corrected count
    // (6 internal + 2 internal-only + 6 client condensations) — this fixture
    // has every field populated, so nothing is dropped as empty.
    expect(result.docsWritten).toBe(14);
    expect(written).toHaveLength(1);
    // Storage location: the SAME client id, written through exactly one call
    // to `replaceDocs` (production wiring: `replaceClientContextDocs`) — no
    // per-doc-type writes, no second collection.
    expect(written[0]!.clientId).toBe(CLIENT_ID);

    const rowKeys = written[0]!.docs.map((d) => `${d.docType}::${d.tier}`).sort();
    const contractKeys = CONTEXT_DOC_SET_CONTRACT.map((r) => `${r.docType}::${r.tier}`).sort();
    expect(rowKeys).toEqual(contractKeys);

    // Every row belongs to this client, is versioned from 1, and carries real
    // (non-empty) content — the read path's own expectations, not merely
    // "something got written".
    for (const row of written[0]!.docs) {
      expect(row.clientId).toBe(CLIENT_ID);
      expect(row.version).toBe(1);
      expect(typeof row.content).toBe("string");
      expect((row.content as string).trim().length).toBeGreaterThan(0);
    }

    // The two internal-only docs never leak to the client tier — the no-leak
    // boundary `assertContextDocSetShape` exists to police.
    const clientTierTypes = written[0]!.docs.filter((d) => d.tier === "client").map((d) => d.docType);
    expect(clientTierTypes).not.toContain("client-guidelines");
    expect(clientTierTypes).not.toContain("action-plan");
  });

  it("both dispatched agent-engine deliverable kinds are the ones the engine actually writes", async () => {
    const asked: string[] = [];
    const { deps } = fixtureDeps({
      getDeliverable: async (runId: string, kind: string) => {
        asked.push(`${runId}:${kind}`);
        return kind === INTEL_REPORT_DELIVERABLE_KIND ? FIXTURE_INTEL_REPORT : FIXTURE_SEO_GEO;
      },
    });
    await runAgentOnboarding(CLIENT_ID, deps);
    expect(asked.sort()).toEqual([
      "engine_run_intel_1:intel-report",
      "engine_run_seo_1:seo-geo-report",
    ]);
  });
});

describe("SCRUM-274 (T-B19) — gate-timeout: completes within the hour rather than hanging", () => {
  /**
   * The load-bearing test for this ticket's timing fix. Simulates a run whose
   * gate receives no human action: agent-engine synthesizes an auto-approve
   * decision at the real 1-hour mark (T-A20/SCRUM-273) and the deliverable
   * becomes fetchable only after that — modelled here as "not ready" for the
   * first 61 simulated minutes, matching the 1h gate plus a minute of
   * resume/poll latency. `now`/`sleep` are the fast-forward seam
   * `runAgentOnboarding` exposes for exactly this purpose — no real clock
   * time elapses.
   */
  function delayedDeliverableDeps(readyAfterMs: number) {
    let simulatedNowMs = 0;
    const sleeps: number[] = [];
    const written: { clientId: string; docs: Row[] }[] = [];
    const deps = {
      getClient: async () => CLIENT,
      dispatchResearchAgents: async () => ({
        intelReport: { agentEngineRunId: "engine_run_intel_1" },
        seoGeo: { agentEngineRunId: "engine_run_seo_1" },
      }),
      getDeliverable: async (_runId: string, kind: string) => {
        if (simulatedNowMs < readyAfterMs) return undefined;
        return kind === INTEL_REPORT_DELIVERABLE_KIND ? FIXTURE_INTEL_REPORT : FIXTURE_SEO_GEO;
      },
      condense: async (_c: unknown, docTypes: string[]) =>
        docTypes.map((docType) => ({ docType, content: `condensed ${docType}` })),
      replaceDocs: async (clientId: string, docs: Row[]) => {
        written.push({ clientId, docs });
      },
      now: () => simulatedNowMs,
      sleep: async (ms: number) => {
        sleeps.push(ms);
        simulatedNowMs += ms;
      },
    } as never;
    return { deps, written, sleeps };
  }

  it("a run whose gate auto-approves at 1 hour completes, using the raised production timeout", async () => {
    // seo-geo-agent's gate auto-approves at 1h (T-A20). Model the deliverable
    // becoming available a minute after that, for the resume + finalize +
    // poll-interval round trip.
    const readyAfterMs = 61 * 60_000;
    const { deps, written } = delayedDeliverableDeps(readyAfterMs);

    const result = await runAgentOnboarding(CLIENT_ID, deps, {
      deliverableTimeoutMs: ONBOARDING_DELIVERABLE_TIMEOUT_MS,
      pollIntervalMs: 15_000,
    });

    expect(result.docsWritten).toBe(14);
    expect(written).toHaveLength(1);
  });

  it("survives a transient poll failure — a deploy mid-wait must not fail the run", async () => {
    // 2026-09-03, prep, Karos Labs. A deploy of agent-engine restarted the
    // service while this loop was waiting; one poll came back `fetch failed`;
    // the whole pipeline aborted and the client was stamped
    // `aiProcessingError: "fetch failed"` while BOTH agents were still
    // working. At 15-second intervals over 70 minutes this loop makes ~280
    // requests to a service that scales to zero and is redeployed during the
    // day — a transient failure is the expected weather, not an edge case.
    let calls = 0;
    let simulatedNowMs = 1_700_000_000_000;
    const written: Array<{ clientId: string; docs: Row[] }> = [];
    const deps = {
      getClient: async () => CLIENT,
      dispatchResearchAgents: async () => ({
        intelReport: { agentEngineRunId: "run-intel" },
        seoGeo: { agentEngineRunId: "run-seo" },
      }),
      getDeliverable: async (_runId: string, kind: string) => {
        calls += 1;
        // Every engine restart looks like this from the portal's side.
        if (calls <= 4) throw new TypeError("fetch failed");
        return kind === INTEL_REPORT_DELIVERABLE_KIND ? FIXTURE_INTEL_REPORT : FIXTURE_SEO_GEO;
      },
      condense: async (_c: unknown, docTypes: string[]) =>
        docTypes.map((docType) => ({ docType, content: `condensed ${docType}` })),
      replaceDocs: async (clientId: string, docs: Row[]) => {
        written.push({ clientId, docs });
      },
      now: () => simulatedNowMs,
      sleep: async (ms: number) => {
        simulatedNowMs += ms;
      },
    } as never;

    const result = await runAgentOnboarding(CLIENT_ID, deps, {
      deliverableTimeoutMs: ONBOARDING_DELIVERABLE_TIMEOUT_MS,
      pollIntervalMs: 15_000,
    });

    expect(result.docsWritten).toBe(14);
    expect(written).toHaveLength(1);
  });

  it("carries the last poll failure into the timeout message, instead of blaming a slow agent", async () => {
    // The timeout used to say only that the deliverable never arrived, which
    // reads as "the agent was slow" when the truth may be that every request
    // was refused. Losing that distinction is how an outage gets diagnosed as
    // a performance problem.
    let simulatedNowMs = 1_700_000_000_000;
    const deps = {
      getClient: async () => CLIENT,
      dispatchResearchAgents: async () => ({
        intelReport: { agentEngineRunId: "run-intel" },
        seoGeo: { agentEngineRunId: "run-seo" },
      }),
      getDeliverable: async () => {
        throw new TypeError("fetch failed");
      },
      condense: async () => [],
      replaceDocs: async () => {},
      now: () => simulatedNowMs,
      sleep: async (ms: number) => {
        simulatedNowMs += ms;
      },
    } as never;

    await expect(
      runAgentOnboarding(CLIENT_ID, deps, { deliverableTimeoutMs: 60_000, pollIntervalMs: 15_000 }),
    ).rejects.toThrow(/The last poll failed with: fetch failed/);
  });

  it("does NOT retry a credential failure for 70 minutes", async () => {
    // A misconfiguration is not weather. Retrying it to the deadline turns an
    // instant, legible error into a 70-minute silence.
    const credentialError = new Error("agent-engine is IAM-protected but no ID token could be minted: no metadata server");
    credentialError.name = "AgentEngineCredentialError";
    let simulatedNowMs = 1_700_000_000_000;
    let calls = 0;
    const deps = {
      getClient: async () => CLIENT,
      dispatchResearchAgents: async () => ({
        intelReport: { agentEngineRunId: "run-intel" },
        seoGeo: { agentEngineRunId: "run-seo" },
      }),
      getDeliverable: async () => {
        calls += 1;
        throw credentialError;
      },
      condense: async () => [],
      replaceDocs: async () => {},
      now: () => simulatedNowMs,
      sleep: async (ms: number) => {
        simulatedNowMs += ms;
      },
    } as never;

    await expect(
      runAgentOnboarding(CLIENT_ID, deps, { deliverableTimeoutMs: ONBOARDING_DELIVERABLE_TIMEOUT_MS, pollIntervalMs: 15_000 }),
    ).rejects.toThrow(/no ID token could be minted/);
    // Both deliverables are awaited concurrently, so one attempt each.
    expect(calls).toBeLessThanOrEqual(2);
  });

  it("the SAME scenario, on the pre-fix 15-minute default, times out instead of completing", async () => {
    // The exact bug this ticket fixes, pinned as a permanent regression test:
    // agent-onboarding.ts's own default (`deliverableTimeoutMs ?? 15 *
    // 60_000`) is shorter than the real 1-hour gate auto-approve, so an
    // unattended run fails at 15 minutes — before the auto-approve at 60
    // minutes ever has a chance to fire. This is what the report.ts call site
    // override (ONBOARDING_DELIVERABLE_TIMEOUT_MS) exists to prevent.
    const readyAfterMs = 61 * 60_000;
    const { deps, written } = delayedDeliverableDeps(readyAfterMs);

    await expect(runAgentOnboarding(CLIENT_ID, deps)).rejects.toThrow(
      /timed out waiting for the "(intel-report|seo-geo-report)" deliverable.*after 900s/,
    );
    expect(written).toHaveLength(0);
  });
});

describe("SCRUM-274 (T-B19) — a run with missing grounding is visibly marked, not silently generic", () => {
  it("refuses to write anything when both deliverables come back structurally empty", async () => {
    // The strongest form of "missing grounding" this repo can detect today —
    // see this ticket's report for what it CANNOT detect (an agent that
    // returned confident-looking but ungrounded content; neither deliverable
    // agent-engine actually sends carries a signal for that case, verified
    // against the ref clone). An engine that answers with nothing produces
    // documents whose sections are all empty; `document()` returns "" rather
    // than a lone heading (see agent-onboarding.ts's own comment), and the
    // gate rejects empty content BEFORE the write — a loud failure, never a
    // stored blank "ground truth".
    const { deps, written } = fixtureDeps({
      getDeliverable: async () => ({}),
    });
    await expect(runAgentOnboarding(CLIENT_ID, deps)).rejects.toThrow(ContextDocShapeError);
    expect(written).toHaveLength(0);
  });

  it("a deliverable with only ONE usable field still fails loudly for the docs that field cannot fill", () => {
    // Not exercised through the full write path (that always fails as a
    // batch — `assertContextDocSetShape` is all-or-nothing by design, see its
    // own doc comment) — this asserts the PER-DOCUMENT signal underneath it:
    // a document with nothing behind it composes to the empty string, visibly
    // distinct from a document with real content, never a placeholder that
    // reads as generic-but-plausible.
    const docs = composeContextDocsFromAgentReports({
      client: CLIENT,
      intelReport: { brandAnalysis: "The only field this run produced." },
      seoGeo: {},
    });
    expect(docs["brand-voice"].trim()).not.toBe("");
    expect(docs["target-audience"]).toBe("");
    expect(docs["action-plan"]).toBe("");
    expect(docs["product-information"]).toBe("");
  });
});
