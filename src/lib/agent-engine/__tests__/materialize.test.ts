import { describe, expect, it, vi, beforeEach } from "vitest";

const {
  createAssetMock,
  attachAssetToJobMock,
  getJobMock,
  getDeliverableMock,
  generateTitleMock,
  reflowMock,
  uploadBytesMock,
  getClientMock,
  listClientCompetitorsMock,
  upsertClientSeoGeoMock,
  readAgentEngineRunMock,
} = vi.hoisted(() => ({
  createAssetMock: vi.fn(),
  attachAssetToJobMock: vi.fn(),
  getJobMock: vi.fn(),
  getDeliverableMock: vi.fn(),
  generateTitleMock: vi.fn(),
  reflowMock: vi.fn(),
  uploadBytesMock: vi.fn(),
  getClientMock: vi.fn(),
  listClientCompetitorsMock: vi.fn(),
  upsertClientSeoGeoMock: vi.fn(),
  readAgentEngineRunMock: vi.fn(),
}));

vi.mock("server-only", () => ({}));
vi.mock("@/lib/data", () => ({
  createAsset: createAssetMock,
  attachAssetToJob: attachAssetToJobMock,
  getJob: getJobMock,
  // [T-B16/SCRUM-271] persist-seo-geo-insights.ts's own dependencies — a
  // seo-geo-agent materialization now also builds and persists `clientSeoGeo`;
  // see the "T-B16: persisting clientSeoGeo" describe block below for the
  // tests that exercise this directly. Every other product's tests never
  // touch these three.
  getClient: getClientMock,
  listClientCompetitors: listClientCompetitorsMock,
  upsertClientSeoGeo: upsertClientSeoGeoMock,
}));
vi.mock("@/lib/storage", () => ({ uploadBytes: uploadBytesMock }));
vi.mock("@/lib/chain", () => ({ reflowClientChain: reflowMock }));
vi.mock("../read-run", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../read-run")>()),
  readAgentEngineRun: readAgentEngineRunMock,
}));
// The titler is a live Haiku call in production. Mocked to null by default so
// every assertion below reads the DETERMINISTIC field-derived title — which is
// also the fallback the real path uses whenever that call fails, so this is the
// branch that has to be right.
vi.mock("@/lib/asset-titles", () => ({ generateAssetTitle: generateTitleMock }));
// Partial mock: `AgentEngineCredentialError` must be the REAL class, or the
// `instanceof` branch in materialize.ts silently never matches and the
// credential case would test as if it did not exist (SCRUM-330).
vi.mock("../client", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../client")>()),
  getAgentEngineDeliverable: getDeliverableMock,
}));

import { materializeAgentEngineDeliverable, PRODUCT_DELIVERABLE_KINDS } from "../materialize";
import type { RoutableRecommendation } from "../routable-recommendation";
import { parseXDrafts } from "@/lib/x-drafts";
import { parseLiDrafts } from "@/lib/li-drafts";
import { parseRedditDrafts } from "@/lib/reddit-drafts";
import type { Asset, Job } from "@/lib/types";
import type { SeoGeoInsights } from "@/lib/seo-geo";

function job(productId: string, overrides: Partial<Job> = {}): Job {
  return {
    id: "job_1",
    clientId: "client_1",
    agentId: "agent-engine",
    agentName: "X / Twitter Content Specialist",
    title: "Test job",
    status: "review",
    input: {},
    assetIds: [],
    events: [],
    createdBy: "user_1",
    createdAt: 1000,
    updatedAt: 1000,
    agentEngineRunId: "pubsub-1",
    agentEngineProductId: productId,
    ...overrides,
  } as Job;
}

/** What `createAsset(data, id)` answers when this writer wins the create. */
const createdWithId = async (_data: unknown, id: string) => ({ id, created: true });

/** The asset payload the one `createAsset` call was given. */
function createdAsset(): Omit<Asset, "id"> {
  expect(createAssetMock).toHaveBeenCalledTimes(1);
  return createAssetMock.mock.calls[0]![0] as Omit<Asset, "id">;
}

async function materialize(productId: string, deliverable: unknown, overrides: Partial<Job> = {}) {
  getDeliverableMock.mockResolvedValue(deliverable);
  return materializeAgentEngineDeliverable(job(productId, overrides));
}

beforeEach(() => {
  createAssetMock.mockReset().mockImplementation(createdWithId);
  attachAssetToJobMock.mockReset();
  getJobMock.mockReset().mockResolvedValue(null); // no fresh information — the snapshot stands
  getDeliverableMock.mockReset();
  generateTitleMock.mockReset().mockResolvedValue(null);
  reflowMock.mockReset().mockResolvedValue(undefined);
  uploadBytesMock.mockReset().mockResolvedValue({ url: "https://karos.example/rehosted.png" });
  // Defaults every non-seo-geo product's tests never touch: a resolvable
  // client, no tracked competitors, no run steps (no visibility cells), and a
  // no-op persist. The seo-geo-specific tests below override these per case.
  getClientMock.mockReset().mockResolvedValue({ id: "client_1", name: "Acme Fintech", website: "acme.example" });
  listClientCompetitorsMock.mockReset().mockResolvedValue([]);
  upsertClientSeoGeoMock.mockReset().mockResolvedValue(undefined);
  readAgentEngineRunMock.mockReset().mockResolvedValue(undefined);
});

/**
 * agent-engine's own product catalog and the `kind` each one passes to
 * `ledger.writeDeliverable`, transcribed from the eleven workflows themselves
 * (`agent-engine/agents/*​/src/workflow/create-*-workflow.ts`, each one's
 * persist step).
 *
 * WRITTEN OUT RATHER THAN DERIVED, deliberately — deriving it from the module
 * under test would make this assertion "the map equals itself". agent-engine is
 * a separate deployable with its own release cycle, the same reason `read-run.ts`
 * duplicates its Firestore record shapes instead of importing them, so this is a
 * point-in-time transcription: a product added over there does not fail here
 * until someone re-transcribes. What it DOES catch is the failure that actually
 * shipped — a product dropped from, or misspelled in, karosCMO's own map, which
 * silently produced a job at "In review" with nothing attached.
 */
const ENGINE_CATALOG: Readonly<Record<string, string>> = {
  "x-agent": "x-post",
  "linkedin-agent": "linkedin-post",
  "instagram-agent": "instagram-carousel",
  "branded-shorts-agent": "branded-shorts-video",
  "tiktok-agent": "tiktok-clip",
  "reddit-agent": "reddit-reply",
  "blog-agent": "blog-post",
  "newsletter-agent": "newsletter-edition",
  "landing-builder-agent": "landing-page-site",
  "intel-report-agent": "intel-report",
  "seo-geo-agent": "seo-geo-report",
  "campaign-orchestrator": "campaign-bundle",
  "reputation-agent": "reputation-pulse",
};

describe("the product catalog is covered end to end", () => {
  it("maps every one of the thirteen engine products, by the kind its workflow actually writes", () => {
    expect(PRODUCT_DELIVERABLE_KINDS).toEqual(ENGINE_CATALOG);
    expect(Object.keys(PRODUCT_DELIVERABLE_KINDS)).toHaveLength(13);
  });

  it("fetches each product's deliverable by that exact kind — a mismatch 404s and silently delivers nothing", async () => {
    for (const [productId, kind] of Object.entries(ENGINE_CATALOG)) {
      getDeliverableMock.mockReset().mockResolvedValue({ text: "something" });
      createAssetMock.mockReset().mockImplementation(createdWithId);
      await materializeAgentEngineDeliverable(job(productId));
      expect(getDeliverableMock, productId).toHaveBeenCalledWith("pubsub-1", kind);
    }
  });

  it("produces an asset for every product, never a silent no-op", async () => {
    // The regression in one line: eight of eleven products used to fall through
    // `DELIVERABLE_KIND_BY_PRODUCT` and return undefined here.
    for (const productId of Object.keys(ENGINE_CATALOG)) {
      createAssetMock.mockReset().mockImplementation(createdWithId);
      const assetId = await materialize(productId, { text: "body text", topic: "a topic" });
      expect(assetId, productId).toBe("agent-engine-pubsub-1");
    }
  });
});

describe("the three draft-batch channels hand their reader-shaped string straight through", () => {
  // Copied from the renderers' real output — the same fixtures
  // `agent-engine-drafts-compat.test.ts` pins the parsers against.
  const xMarkdown = [
    "# Account 1 · @getkaros",
    "",
    "## Avenue 1 · Build-in-public",
    "*trend-observation*",
    "",
    "> We shipped the drafts reader today, and the whole batch now reads on one page.",
    "",
    "`78 chars`",
    "",
    "- **Hook:** shipping notes",
    "",
  ].join("\n");

  it("x-agent: content is draftsMarkdown, outer whitespace aside, and this portal's own parser reads it", async () => {
    await materialize("x-agent", {
      draftsMarkdown: xMarkdown,
      text: "the raw text, which must NOT win over draftsMarkdown",
      hook: "shipping notes",
      lane: "build-in-public",
      angle: "trend-observation",
      targetHandle: "getkaros",
    });
    const asset = createdAsset();
    // The outer trim is the ONLY mutation — asserted as such rather than as
    // `toBe(xMarkdown)`, which passed only until the fixture grew a trailing
    // newline. Trimming both sides is what makes the two comparable; anything
    // rewritten INSIDE the string would break the parser contract.
    expect(asset.content).toBe(xMarkdown.trim());
    expect(xMarkdown).toContain(asset.content);
    // The point of passing it through unrewritten: the AssetCard's drafts reader renders it.
    expect(parseXDrafts(asset.content)).not.toBeNull();
    expect(asset.type).toBe("social_post");
    expect(asset.channels).toEqual(["twitter"]);
    expect(asset.title).toBe("shipping notes");
    expect(asset.meta).toMatchObject({ lane: "build-in-public", angle: "trend-observation", targetHandle: "getkaros" });
  });

  it("linkedin-agent: same, with hashtags left on the exact meta key the card reads", async () => {
    const markdown = [
      "# LinkedIn drafts",
      "",
      "## Account 1 · Karos Labs — Company page",
      "",
      "### Post 1 · Teardown framework",
      "",
      "> Most agencies lose a day to review cycles.",
      "",
      "`42 chars`",
      "",
      "- **Topic:** How we cut client review time in half",
    ].join("\n");
    await materialize("linkedin-agent", {
      draftsMarkdown: markdown,
      text: "raw",
      headline: "The brief matters more than the volume",
      archetype: "lesson-learned",
      hashtags: ["#AIMarketing", "#ContentStrategy"],
    });
    const asset = createdAsset();
    expect(asset.content).toBe(markdown);
    expect(parseLiDrafts(asset.content)).not.toBeNull();
    expect(asset.channels).toEqual(["linkedin"]);
    expect(asset.title).toBe("The brief matters more than the volume");
    expect(asset.meta?.hashtags).toEqual(["#AIMarketing", "#ContentStrategy"]);
  });

  it("reddit-agent: the v2 envelope, fenced to a draft-only note with NO publish channel", async () => {
    const envelope = JSON.stringify({
      kind: "reddit-drafts-v2",
      outcome: "delivered",
      threads: [
        {
          folder: "01-answer",
          threadTitle: "How do you handle client review cycles?",
          threadUrl: "https://reddit.com/r/agency/comments/abc",
          subreddit: "r/agency",
          approaches: [{ id: "approach-1", text: "We moved review to the brief stage." }],
        },
      ],
    });
    await materialize("reddit-agent", {
      draftsEnvelope: envelope,
      replyBody: "We moved review to the brief stage.",
      targetThreadTitle: "How do you handle client review cycles?",
      targetSubreddit: "agency",
      disclosureIncluded: true,
    });
    const asset = createdAsset();
    expect(asset.content).toBe(envelope);
    expect(parseRedditDrafts(asset.content)).not.toBeNull();
    // THE FENCE. `social_post` would offer a reply written for one thread to
    // twitter/linkedin/tiktok; `note` has no publish targets at all.
    expect(asset.type).toBe("note");
    expect(asset.channels).toBeUndefined();
    expect(asset.meta).toMatchObject({ targetSubreddit: "agency", disclosureIncluded: true });
  });

  it("falls back to the raw text when a deliverable predates the reader-shaped field", async () => {
    await materialize("x-agent", { text: "Just the post text.", hook: "a hook" });
    expect(createdAsset().content).toBe("Just the post text.");
  });
});

describe("the long-form products land on the asset type their content actually is", () => {
  it("blog-agent: the markdown body, typed article — via custom + a hint, never the RETIRED blog_article task type", async () => {
    await materialize("blog-agent", {
      title: "Why your AI content reads as noise",
      bodyMarkdown: "## The brief is the decision\n\nBody here.",
      text: "flattened text",
      slug: "ai-content-noise",
      metaDescription: "A short description.",
      jsonLd: { "@type": "BlogPosting" },
    });
    const asset = createdAsset();
    expect(asset.type).toBe("article");
    expect(asset.content).toBe("## The brief is the decision\n\nBody here.");
    expect(asset.title).toBe("Why your AI content reads as noise");
    expect(asset.meta).toMatchObject({ slug: "ai-content-noise", jsonLd: { "@type": "BlogPosting" } });
  });

  it("newsletter-agent: typed email, titled by its subject line", async () => {
    await materialize("newsletter-agent", {
      subjectLine: "The brief is the decision",
      previewText: "Why more output made things worse",
      text: "Full assembled edition body.",
    });
    const asset = createdAsset();
    expect(asset.type).toBe("email");
    expect(asset.title).toBe("The brief is the decision");
    expect(asset.content).toBe("Full assembled edition body.");
  });

  it("newsletter-agent: stitches intro/sections/signoff when the agent recorded no assembled text", async () => {
    // An empty asset with the real content hidden in meta is the failure mode
    // this branch exists to avoid.
    await materialize("newsletter-agent", {
      subjectLine: "Subject",
      intro: "Hello there.",
      sections: [
        { heading: "First story", body: "What happened." },
        { heading: "Second story", body: "What else." },
      ],
      signoff: "Until next week.",
    });
    const content = createdAsset().content;
    expect(content).toContain("Hello there.");
    expect(content).toContain("## First story");
    expect(content).toContain("What else.");
    expect(content).toContain("Until next week.");
  });
});

describe("the report and bundle products render to something a reviewer can read", () => {
  it("intel-report: real headings, a dimension-scores table, grouped recommendations and the SWOT — not a wall of JSON", async () => {
    await materialize("intel-report-agent", {
      overallScore: 72,
      overallGrade: "B",
      dimensionScores: [
        { key: "content", score: 80 },
        { key: "seo", score: 64 },
      ],
      contentAnalysis: "The content library is broad but undifferentiated.",
      seoAnalysis: "Technical SEO is sound.",
      brandSynchronizationUpdate: "Tighten the positioning line.",
      swot: { strengths: ["Fast delivery"], weaknesses: ["Thin case studies"], opportunities: [], threats: ["Two funded entrants"] },
      recommendations: [
        { title: "Ship the case-studies page", priorityLabel: "Priority 1", tag: "Content" },
        { id: "r1" },
      ],
    });
    const asset = createdAsset();
    expect(asset.type).toBe("note");
    expect(asset.title).toBe("Competitive intelligence report (B)");
    expect(asset.content).toContain("## Overall Assessment");
    expect(asset.content).toContain("**Overall score: 72/100 (Grade B)**");
    expect(asset.content).toContain("| Dimension | Score |");
    expect(asset.content).toContain("| content | 80/100 |");
    expect(asset.content).toContain("## Content & Messaging");
    expect(asset.content).toContain("The content library is broad but undifferentiated.");
    expect(asset.content).toContain("## SWOT Analysis");
    expect(asset.content).toContain("### Strengths\n\n- Fast delivery");
    // An empty SWOT arm contributes no empty heading.
    expect(asset.content).not.toContain("### Opportunities");
    expect(asset.content).toContain("## Recommendations");
    expect(asset.content).toContain("### Priority 1");
    expect(asset.content).toContain("**Ship the case-studies page** [Content]");
    // A recommendation with no title-ish field but an id still renders (the
    // same "ask, don't assert" fallback the seo-geo renderer already used).
    expect(asset.content).toContain("**r1**");
    // The structure still travels, so a future dedicated viewer can be built
    // later without re-delivering the run.
    expect(asset.meta).toMatchObject({ overallScore: 72, recommendations: [{ title: "Ship the case-studies page", priorityLabel: "Priority 1", tag: "Content" }, { id: "r1" }] });
  });

  it("intel-report: an empty deliverable renders to an empty string rather than broken markdown", async () => {
    await materialize("intel-report-agent", {});
    const asset = createdAsset();
    expect(asset.type).toBe("note");
    expect(asset.title).toBe("Competitive intelligence report");
    expect(asset.content).toBe("");
  });

  it("seo-geo-report: the narrative leads, with both canonical scores above it", async () => {
    await materialize("seo-geo-agent", {
      seoScore: { score: 61 },
      geoReadiness: { score: 44 },
      narrative: "Visibility is concentrated in two prompts.",
      firedRecommendations: [{ recId: "a", recommendation: "Add FAQ schema" }, { recId: "b", title: "Fix canonical tags" }],
      promptSet: { promptSetHash: "abc123" },
    });
    const asset = createdAsset();
    expect(asset.content).toContain("**SEO 61 · GEO readiness 44**");
    expect(asset.content).toContain("Visibility is concentrated in two prompts.");
    expect(asset.content).toContain("## Recommendations (2)");
    expect(asset.content).toContain("- Add FAQ schema");
    expect(asset.content).toContain("- Fix canonical tags");
  });

  /**
   * [C2/SCRUM-210] THE INTEGRATION WIRING ITSELF, exercised through the real
   * `materializeAgentEngineDeliverable` -> `buildMaterialization` ->
   * `materializeSeoGeoReport` path (the same call the tests above already
   * use) — never a duplicate call into `routable-recommendation.ts`'s own
   * exports directly. That distinction is the whole point: the R1 review's
   * finding #1 was that reverting `materialize.ts`'s C2 changes back to its
   * pre-C2 version left ALL existing tests green, including the test above,
   * because nothing exercised the wiring — only the isolated parser/sprayer
   * functions had coverage. Delete `routableRecommendations`/`ownerMixLine`
   * from `materializeSeoGeoReport` (or the import at the top of
   * materialize.ts) and see this block go red; that is what proves it now
   * covers the wiring rather than the parser's own unit tests a second time.
   */
  describe("seo-geo-report: the C2 routable-recommendation wiring", () => {
    it("today's REAL agent-engine payload shape (zero owner/fixAction/engineProductId fields) renders no Owner-mix line at all", async () => {
      // Exactly what create-seo-geo-agent-workflow.ts writes today, verified
      // directly against that file: `firedRecommendations: recommendations`,
      // a bare `FiredRecommendation[]` with none of C2's routing fields.
      // (R1 review finding #4: this used to render "0 we run automatically ·
      // 0 tool/connector · 2 client action" — a false-looking triage result
      // manufactured entirely by the fail-safe default, not by any real
      // classification, and no test caught it.)
      await materialize("seo-geo-agent", {
        narrative: "Visibility is concentrated in two prompts.",
        firedRecommendations: [
          { recId: "SEO-02", recommendation: "Title length, truncation & rewrite-mismatch guard", fireState: "fail" },
          { recId: "BOTH-07", recommendation: "Canonical tag coverage", fireState: "approaching" },
        ],
      });
      const asset = createdAsset();
      expect(asset.content).not.toContain("Owner mix");
      expect(asset.content).not.toContain("we run automatically");
      // The structured data is still there for a future consumer, correctly
      // fail-safed to client_manual — it is only the PROSE claim that is
      // withheld until the data backing it is real.
      const routable = asset.meta?.routableRecommendations as RoutableRecommendation[];
      expect(routable).toHaveLength(2);
      expect(routable.every((r) => r.owner === "client_manual")).toBe(true);
      expect(routable.every((r) => r.engineProductId === undefined)).toBe(true);
    });

    it("once the wire carries real owner data, meta.routableRecommendations groups correctly AND the Owner-mix line reports it", async () => {
      await materialize("seo-geo-agent", {
        narrative: "Visibility is concentrated in two prompts.",
        firedRecommendations: [
          {
            recId: "SEO-02",
            recommendation: "Fix the title tag",
            owner: "karos_agent",
            engineProductId: "seo-geo-agent",
            fixAction: "meta_title",
            actionKind: "one_click",
          },
          {
            recId: "BOTH-09",
            recommendation: "Submit an updated sitemap",
            owner: "karos_tool",
            fixAction: "sitemap",
            actionKind: "connect",
          },
          {
            recId: "GEO-14",
            recommendation: "Publish an FAQ page addressing X",
            owner: "client_manual",
            fixAction: "manual",
            actionKind: "guided_manual",
          },
        ],
      });
      const asset = createdAsset();
      expect(asset.content).toContain("**Owner mix:** 1 we run automatically · 1 tool/connector · 1 client action");

      const routable = asset.meta?.routableRecommendations as RoutableRecommendation[];
      expect(routable).toHaveLength(3);
      const byId = Object.fromEntries(routable.map((r) => [r.recId, r]));
      expect(byId["SEO-02"]).toMatchObject({ owner: "karos_agent", engineProductId: "seo-geo-agent", fixAction: "meta_title" });
      expect(byId["BOTH-09"]).toMatchObject({ owner: "karos_tool", fixAction: "sitemap" });
      expect(byId["GEO-14"]).toMatchObject({ owner: "client_manual", fixAction: "manual" });
    });

    it("a karos_agent record with no verifiable engineProductId is downgraded to client_manual through the real wiring, not just in the unit parser", async () => {
      await materialize("seo-geo-agent", {
        narrative: "n",
        firedRecommendations: [
          { recId: "SEO-06", recommendation: "Meta description coverage", owner: "karos_agent" /* no engineProductId */ },
        ],
      });
      const asset = createdAsset();
      const routable = asset.meta?.routableRecommendations as RoutableRecommendation[];
      expect(routable[0]?.owner).toBe("client_manual");
      expect(routable[0]?.engineProductId).toBeUndefined();
      // Real classification data DID arrive on the wire (an "owner" field was
      // present), so the mix line still renders — this is a real, if all-manual,
      // triage result, not the zero-data case above.
      expect(asset.content).toContain("**Owner mix:** 0 we run automatically · 0 tool/connector · 1 client action");
    });

    it("no firedRecommendations at all: no crash, no Owner-mix line, empty routableRecommendations", async () => {
      await materialize("seo-geo-agent", { narrative: "n" });
      const asset = createdAsset();
      expect(asset.content).not.toContain("Owner mix");
      expect(asset.meta?.routableRecommendations).toEqual([]);
    });
  });

  /**
   * [T-B16/SCRUM-271] The second half of "note only" -> "full rendering":
   * a seo-geo-agent materialization now also builds and persists
   * `clientSeoGeo` (via `persist-seo-geo-insights.ts` ->
   * `seo-geo-insights-mapping.ts`), which is what the client-facing SEO/GEO
   * analytics view actually reads (`getClientSeoGeo`) — the note asset above
   * was never that surface. These tests exercise the real wiring, the same
   * discipline the C2 block above states for `routableRecommendations`.
   */
  describe("T-B16/SCRUM-271: persisting clientSeoGeo alongside the note asset", () => {
    function stepsWithCells(cells: unknown[]) {
      return {
        run: {
          runId: "pubsub-1",
          clientSlug: "acme",
          productId: "seo-geo-agent",
          runKind: "recurring" as const,
          status: "completed" as const,
          createdAt: 0,
          updatedAt: 0,
        },
        steps: [
          {
            stepId: "08-assemble-visibility-cells",
            kind: "code" as const,
            status: "completed" as const,
            startedAt: 0,
            output: { cells },
          },
        ],
      };
    }

    it("acceptance: an AIO-absent Gemini cell renders a different answer-grid state than a plain brand-absent cell, end to end", async () => {
      readAgentEngineRunMock.mockResolvedValue(
        stepsWithCells([
          // Gemini genuinely had no AI Overview render for p1 — distinct from p2,
          // where an AIO rendered and simply never named the brand.
          { promptId: "p1", engine: "gemini", captureTier: "MEASURED_grounded", brandMentioned: false, brandCited: false, aioAbsent: true },
          { promptId: "p2", engine: "gemini", captureTier: "MEASURED_grounded", brandMentioned: false, brandCited: false, aioAbsent: false },
        ]),
      );

      await materialize("seo-geo-agent", {
        seoScore: { score: 61, dataCoveragePct: 80, inputs: [] },
        geoReadiness: { score: 44, dataCoveragePct: 70, inputs: [] },
        narrative: "n",
        firedRecommendations: [],
        promptSet: {
          prompts: [
            { promptId: "p1", promptText: "best fintech apps", intentType: "discovery" },
            { promptId: "p2", promptText: "top rated fintech providers", intentType: "discovery" },
          ],
        },
      });

      expect(upsertClientSeoGeoMock).toHaveBeenCalledTimes(1);
      const insights = upsertClientSeoGeoMock.mock.calls[0]![0] as SeoGeoInsights;
      const aioAbsentCell = insights.answerGrid
        .find((r) => r.prompt === "best fintech apps")
        ?.cells.find((c) => c.engine === "gemini");
      const plainAbsentCell = insights.answerGrid
        .find((r) => r.prompt === "top rated fintech providers")
        ?.cells.find((c) => c.engine === "gemini");
      expect(aioAbsentCell?.state).toBe("aio_absent");
      expect(plainAbsentCell?.state).toBe("absent");
      expect(aioAbsentCell?.state).not.toBe(plainAbsentCell?.state);
    });

    it("real per-engine data (chatgpt, perplexity, gemini, claude, copilot) maps onto the widened 5-engine EngineId, not just the old 3", async () => {
      readAgentEngineRunMock.mockResolvedValue(
        stepsWithCells([
          { promptId: "p1", engine: "perplexity", captureTier: "MEASURED", brandMentioned: true, brandFirstMentionCharOffset: 0, brandCited: false },
          { promptId: "p1", engine: "copilot", captureTier: "MEASURED", brandMentioned: false, brandCited: false },
        ]),
      );
      await materialize("seo-geo-agent", {
        seoScore: { score: 50, dataCoveragePct: 50 },
        geoReadiness: { score: 50, dataCoveragePct: 50 },
        narrative: "n",
        promptSet: { prompts: [{ promptId: "p1", promptText: "best fintech apps", intentType: "discovery" }] },
      });
      const insights = upsertClientSeoGeoMock.mock.calls[0]![0] as SeoGeoInsights;
      const perplexity = insights.perEngine.find((e) => e.engine === "perplexity");
      const copilot = insights.perEngine.find((e) => e.engine === "copilot");
      expect(perplexity?.captureTier).toBe("MEASURED");
      expect(perplexity?.promptsMeasured).toBe(1);
      expect(copilot?.captureTier).toBe("MEASURED");
    });

    it("never blocks the job when the client record can't be read", async () => {
      getClientMock.mockResolvedValue(null);
      await materialize("seo-geo-agent", { narrative: "n" });
      expect(createdAsset().type).toBe("note"); // the note asset still lands
      expect(upsertClientSeoGeoMock).not.toHaveBeenCalled();
    });

    it("degrades honestly (no crash, zero engines scored) when the run's step 08 output can't be read", async () => {
      readAgentEngineRunMock.mockResolvedValue(undefined);
      await materialize("seo-geo-agent", {
        seoScore: { score: 61, dataCoveragePct: 80 },
        geoReadiness: { score: 44, dataCoveragePct: 70 },
        narrative: "n",
      });
      expect(upsertClientSeoGeoMock).toHaveBeenCalledTimes(1);
      const insights = upsertClientSeoGeoMock.mock.calls[0]![0] as SeoGeoInsights;
      expect(insights.seoScore).toBe(61);
      expect(insights.geoReadiness).toBe(44);
      expect(insights.perEngine.every((e) => e.captureTier === "UNAVAILABLE")).toBe(true);
      expect(insights.answerGrid).toEqual([]);
    });

    it("does not persist clientSeoGeo for any other product", async () => {
      await materialize("x-agent", { text: "hello" });
      expect(upsertClientSeoGeoMock).not.toHaveBeenCalled();
    });
  });

  it("campaign-bundle: an index over the channel slots, not a copy of their drafts", async () => {
    await materialize("campaign-orchestrator", {
      campaignName: "Q4 authority push",
      theme: "AI-first operations",
      targetPillars: ["Positioning", "Proof"],
      channelResults: [
        { channel: "x", status: "completed", topic: "Two camps" },
        { channel: "linkedin", status: "held" },
      ],
    });
    const asset = createdAsset();
    expect(asset.title).toBe("Q4 authority push");
    expect(asset.content).toContain("**Theme:** AI-first operations");
    expect(asset.content).toContain("**Pillars:** Positioning, Proof");
    expect(asset.content).toContain("- **x** · completed — Two camps");
    expect(asset.content).toContain("- **linkedin** · held");
  });
});

describe("tiktok-clip", () => {
  it("rehosts the signed clip into a video asset whose content is the commentary caption", async () => {
    globalThis.fetch = vi.fn().mockResolvedValue({ ok: true, arrayBuffer: async () => new ArrayBuffer(4) }) as unknown as typeof fetch;
    uploadBytesMock.mockResolvedValue({ url: "https://karos.example/agent-engine/job_1/clip.mp4" });
    await materialize("tiktok-agent", {
      topic: "The Show ep. 12 — the margin call moment",
      caption: "Our read: the number is right, the conclusion is wrong. Via Jane Doe on The Show ep. 12.",
      about: "A clip where a guest gives a figure we disagree with.",
      sourceCredit: "Jane Doe on The Show ep. 12",
      hookLine: "word10.",
      hookType: "surprising-number",
      sourceTier: "user-asset",
      durationSeconds: 40,
      signedUrl: "https://signed.example/clip.mp4",
      gcsUri: "gs://media/tiktok/acme/run/clip.mp4",
    });
    const asset = createdAsset();
    expect(asset.type).toBe("social_post");
    expect(asset.channels).toEqual(["tiktok"]);
    expect(asset.videoUrl).toBe("https://karos.example/agent-engine/job_1/clip.mp4");
    // The caption IS the post text — the reviewer reads the client's own take,
    // with the source credit the engine enforces in code.
    expect(asset.content).toContain("Via Jane Doe on The Show ep. 12");
    expect(asset.meta).toMatchObject({
      sourceCredit: "Jane Doe on The Show ep. 12",
      sourceTier: "user-asset",
      durationSeconds: 40,
      artifacts: [{ gcsUri: "gs://media/tiktok/acme/run/clip.mp4" }],
    });
  });

  it("still materializes with no signed URL — the caption survives even when the engine had no media store", async () => {
    await materialize("tiktok-agent", {
      topic: "A moment",
      caption: "The take. Via Jane Doe on The Show.",
      sourceTier: "generated",
    });
    const asset = createdAsset();
    expect(asset.content).toBe("The take. Via Jane Doe on The Show.");
    expect(asset.videoUrl ?? undefined).toBeUndefined();
    expect(asset.meta).toMatchObject({ sourceTier: "generated" });
  });
});

describe("reputation-pulse", () => {
  it("renders the crisis line, flagged items, and drafted replies as one markdown asset, typed note", async () => {
    await materialize("reputation-agent", {
      pulseNumber: "004",
      generatedAt: "2026-08-20T00:00:00.000Z",
      summary: { respond: 2, flag: 1, no_action: 3, unavailable: 0 },
      crisis: { fired: true, triggers: [{ signature: "sig-1" }] },
      flagged: [{ reviewId: "r1", valueScore: 80, urgencyScore: 91, reason: "Legal threat mentioned in the review." }],
      approvedDrafts: [
        { reviewId: "r2", draftText: "Thanks for the feedback — we've passed this to the team." },
        { reviewId: "r3", draftText: "We're sorry to hear that and would like to make it right." },
      ],
      draftManifest: [{ reviewId: "r2", outcome: "written" }],
    });
    const asset = createdAsset();
    // The fence: a review reply is posted from the client's own listing, not
    // through this portal, so this is `note` — never `social_post` offered
    // to twitter/linkedin/tiktok.
    expect(asset.type).toBe("note");
    expect(asset.title).toBe("Reputation pulse 004");
    expect(asset.content).toContain("A crisis trigger fired on this pulse");
    expect(asset.content).toContain("2 responded · 1 flagged · 3 no action · 0 unavailable");
    expect(asset.content).toContain("## Flagged — needs a person (1)");
    expect(asset.content).toContain("Legal threat mentioned in the review. (urgency 91/100)");
    expect(asset.content).toContain("## Drafted replies (2)");
    expect(asset.content).toContain("Thanks for the feedback");
    expect(asset.content).toContain("We're sorry to hear that");
    expect(asset.meta).toMatchObject({
      pulseNumber: "004",
      crisis: { fired: true, triggers: [{ signature: "sig-1" }] },
    });
  });

  it("a pulse with nothing safe to answer but a live flag still materializes — flags alone count", async () => {
    await materialize("reputation-agent", {
      pulseNumber: "005",
      summary: { respond: 0, flag: 1, no_action: 0, unavailable: 0 },
      crisis: { fired: false },
      flagged: [{ reviewId: "r1", urgencyScore: 95, reason: "Needs a manager's response." }],
      approvedDrafts: [],
    });
    const asset = createdAsset();
    expect(asset.content).not.toContain("crisis trigger fired");
    expect(asset.content).toContain("Needs a manager's response. (urgency 95/100)");
    expect(asset.content).not.toContain("## Drafted replies");
  });

  it("survives a deliverable with none of these fields yet, without throwing", async () => {
    const assetId = await materialize("reputation-agent", {});
    expect(assetId).toBe("agent-engine-pubsub-1");
    expect(createdAsset().content).toBe("");
    expect(createdAsset().title).toBe("Reputation pulse");
  });
});

describe("the three products that already worked keep working", () => {
  it("instagram-carousel rehosts its first rendered slide", async () => {
    globalThis.fetch = vi.fn().mockResolvedValue({ ok: true, arrayBuffer: async () => new ArrayBuffer(4) }) as unknown as typeof fetch;
    await materialize("instagram-agent", {
      topic: "Three ways to brief an AI",
      slides: [{ n: 1, fields: { headline: "Three ways to brief an AI" } }],
      rendered: [{ n: 1, path: "https://signed.example/slide-1.png", gcsUri: "gs://b/1.png" }],
    });
    const asset = createdAsset();
    expect(asset.type).toBe("social_post");
    expect(asset.imageUrl).toBe("https://karos.example/rehosted.png");
    expect(asset.channels).toEqual(["instagram"]);
  });

  // A real prep run (rWb2EutSDjHzkPnsoeEY) shipped 8 slides and the reviewer
  // could see none of it, before or after approval: `content` was the bare
  // topic and only slide 1's photo was ever rehosted. This is the regression
  // test for both halves of that fix.
  it("instagram-carousel rehosts EVERY slide into a gallery, and builds real caption text from each slide's own fields", async () => {
    globalThis.fetch = vi.fn().mockResolvedValue({ ok: true, arrayBuffer: async () => new ArrayBuffer(4) }) as unknown as typeof fetch;
    uploadBytesMock.mockImplementation(async ({ path }: { path: string }) => ({ url: `https://karos.example/${path}` }));
    await materialize("instagram-agent", {
      topic: "AI Digital Marketing trends this week",
      slides: [
        { n: 1, fields: { headline: "AI is reshaping marketing", body: "Here's what changed this quarter." } },
        { n: 2, fields: { stat: "62%", label: "of teams now use AI drafting tools" } },
      ],
      rendered: [
        { n: 1, path: "https://signed.example/slide-1.png", gcsUri: "gs://b/1.png" },
        { n: 2, path: "https://signed.example/slide-2.png", gcsUri: "gs://b/2.png" },
      ],
    });
    const asset = createdAsset();

    // The actual post copy, not the topic label.
    expect(asset.content).toContain("AI is reshaping marketing");
    expect(asset.content).toContain("Here's what changed this quarter.");
    expect(asset.content).toContain("62%");
    expect(asset.content).not.toBe("AI Digital Marketing trends this week");

    // Both slides rehosted and exposed as a gallery `assetImages()` can read,
    // not just slide 1.
    const metaSlides = asset.meta?.slides as Array<{ n: number; imageUrl: string | null; headline?: string }>;
    expect(metaSlides).toHaveLength(2);
    expect(metaSlides.map((s) => s.imageUrl)).toEqual([
      "https://karos.example/agent-engine/job_1/slide-1.png",
      "https://karos.example/agent-engine/job_1/slide-2.png",
    ]);
    expect(metaSlides[0]!.headline).toContain("AI is reshaping marketing");

    // The cover thumbnail existing cards read is still slide 1's photo.
    expect(asset.imageUrl).toBe("https://karos.example/agent-engine/job_1/slide-1.png");
  });

  // The engine's instagram-copy prompt gained a required `caption` field
  // (2026-08) — the post's own text, distinct from any slide's copy. The
  // asset's `content` must prefer it over the joined-slide-fields fallback.
  it("instagram-carousel uses the deliverable's own caption as content when present", async () => {
    uploadBytesMock.mockImplementation(async ({ path }: { path: string }) => ({ url: `https://karos.example/${path}` }));
    await materialize("instagram-agent", {
      topic: "AI Digital Marketing trends this week",
      caption: "ChatGPT just became an ad platform, and Europe is first. Here's what changed this week.",
      slides: [{ n: 1, fields: { headline: "ChatGPT just became an ad platform" } }],
      rendered: [{ n: 1, path: "https://signed.example/slide-1.png", gcsUri: "gs://b/1.png" }],
    });
    const asset = createdAsset();
    expect(asset.content).toBe("ChatGPT just became an ad platform, and Europe is first. Here's what changed this week.");
  });

  // Job hcf9ymPGJC7mDS5pcEQ4's photos rendered correctly once, then vanished
  // with no code change in between: two overlapping materialize calls for
  // the same job both uploaded to the same deterministic slide-N.png path,
  // each minting its own random download token, and whichever upload landed
  // last orphaned the token the OTHER call had just written into Firestore
  // — a permanent 403 on every future load. `ifAbsent: true` is
  // `uploadBytes`'s own documented fix for exactly this ("two overlapping
  // writers to the same deterministic path... whichever write lands LAST
  // wins the object"): a second attempt reads back the first writer's real,
  // still-valid token instead of minting one that immediately orphans it.
  it("rehosts every slide with ifAbsent: true, so a second overlapping materialize call can't orphan the first one's token", async () => {
    uploadBytesMock.mockImplementation(async ({ path }: { path: string }) => ({ url: `https://karos.example/${path}` }));
    await materialize("instagram-agent", {
      topic: "Two overlapping writers",
      slides: [{ n: 1, fields: { headline: "Slide one" } }],
      rendered: [{ n: 1, path: "https://signed.example/slide-1.png", gcsUri: "gs://b/1.png" }],
    });
    expect(uploadBytesMock).toHaveBeenCalledWith(expect.objectContaining({ ifAbsent: true }));
  });

  // Every slide's `fields` always carries `accentColor` (a hex string) —
  // never prose, and it must not leak into either the fallback caption text
  // or a slide's own gallery caption (prep run 2VFCw79Wu8xfJOKXC7zP's
  // "preview" read "#ff6b2c week in ai marketing..." before this fix).
  it("never lets accentColor's hex code leak into content or a slide's gallery caption", async () => {
    uploadBytesMock.mockImplementation(async ({ path }: { path: string }) => ({ url: `https://karos.example/${path}` }));
    await materialize("instagram-agent", {
      topic: "No caption field on this old deliverable",
      slides: [{ n: 1, fields: { accentColor: "#ff6b2c", headline: "The real headline" } }],
      rendered: [{ n: 1, path: "https://signed.example/slide-1.png", gcsUri: "gs://b/1.png" }],
    });
    const asset = createdAsset();
    expect(asset.content).not.toContain("#ff6b2c");
    expect(asset.content).toContain("The real headline");
    const metaSlides = asset.meta?.slides as Array<{ headline?: string }>;
    expect(metaSlides[0]!.headline).not.toContain("#ff6b2c");
  });

  // Every slide's `fields` may also carry `dir` ("rtl"/"ltr", the RTL-template
  // fix for prep job 9qkTWlg7e9ZLiVIZUok4's Hebrew client) — same non-prose
  // rule as `accentColor` above, so it must not leak into content either.
  it("never lets the dir field leak into content or a slide's gallery caption", async () => {
    uploadBytesMock.mockImplementation(async ({ path }: { path: string }) => ({ url: `https://karos.example/${path}` }));
    await materialize("instagram-agent", {
      topic: "No caption field on this old deliverable",
      slides: [{ n: 1, fields: { dir: "rtl", headline: "The real headline" } }],
      rendered: [{ n: 1, path: "https://signed.example/slide-1.png", gcsUri: "gs://b/1.png" }],
    });
    const asset = createdAsset();
    expect(asset.content).not.toContain("rtl");
    expect(asset.content).toContain("The real headline");
    const metaSlides = asset.meta?.slides as Array<{ headline?: string }>;
    expect(metaSlides[0]!.headline).not.toContain("rtl");
  });

  // The Brand Kit adds two more standing non-prose fields to every slide:
  // the client's @handle watermark and the series badge. Same rule again.
  it("never lets brandHandle or seriesBadge leak into content or a slide's gallery caption", async () => {
    uploadBytesMock.mockImplementation(async ({ path }: { path: string }) => ({ url: `https://karos.example/${path}` }));
    await materialize("instagram-agent", {
      topic: "No caption field on this old deliverable",
      slides: [{ n: 1, fields: { brandHandle: "@geektimecoil", seriesBadge: "PITCH SCHOOL | LESSON 15", headline: "The real headline" } }],
      rendered: [{ n: 1, path: "https://signed.example/slide-1.png", gcsUri: "gs://b/1.png" }],
    });
    const asset = createdAsset();
    expect(asset.content).not.toContain("@geektimecoil");
    expect(asset.content).not.toContain("PITCH SCHOOL");
    expect(asset.content).toContain("The real headline");
    const metaSlides = asset.meta?.slides as Array<{ headline?: string }>;
    expect(metaSlides[0]!.headline).not.toContain("@geektimecoil");
  });

  // Phase 2's reviewer typography controls ride as two more per-slide
  // non-prose fields. Same rule once more.
  it("never lets fontScale or textAlign leak into content or a slide's gallery caption", async () => {
    uploadBytesMock.mockImplementation(async ({ path }: { path: string }) => ({ url: `https://karos.example/${path}` }));
    await materialize("instagram-agent", {
      topic: "No caption field on this old deliverable",
      slides: [{ n: 1, fields: { fontScale: "s", textAlign: "center", headline: "The real headline" } }],
      rendered: [{ n: 1, path: "https://signed.example/slide-1.png", gcsUri: "gs://b/1.png" }],
    });
    const asset = createdAsset();
    expect(asset.content).not.toContain("fontScale");
    expect(asset.content).not.toMatch(/\bcenter\b/);
    expect(asset.content).toContain("The real headline");
  });

  it("instagram-carousel skips a slide that could not be rehosted, without losing the others", async () => {
    uploadBytesMock.mockImplementation(async ({ path }: { path: string }) => ({ url: `https://karos.example/${path}` }));
    await materialize("instagram-agent", {
      topic: "Fallback case",
      slides: [
        { n: 1, fields: { headline: "First slide" } },
        { n: 2, fields: { headline: "Second slide" } },
      ],
      rendered: [
        // Not a signed URL — signing was unavailable on this deploy — so
        // `rehostIfFetchable` skips it rather than fetching a `gs://` URI.
        { n: 1, path: "gs://bucket/1.png", gcsUri: "gs://bucket/1.png" },
        { n: 2, path: "https://signed.example/slide-2.png", gcsUri: "gs://bucket/2.png" },
      ],
    });
    const asset = createdAsset();
    const metaSlides = asset.meta?.slides as Array<{ n: number; imageUrl: string | null }>;
    expect(metaSlides).toHaveLength(1);
    expect(metaSlides[0]!.n).toBe(2);
    expect(asset.imageUrl).toBe("https://karos.example/agent-engine/job_1/slide-2.png");
  });

  it("landing-page-site names where the reviewed source tree lives", async () => {
    await materialize("landing-builder-agent", { gcsPrefix: "gs://bucket/sites/acme", fileCount: 12, status: "ok" });
    const asset = createdAsset();
    expect(asset.type).toBe("note");
    expect(asset.content).toContain("gs://bucket/sites/acme");
  });
});

/**
 * SCRUM-404, break #2: the materializer used to DROP the context-grounding
 * marker.
 *
 * agent-engine attaches it to the deliverable under one `contextGrounding` key,
 * identically for every grounded agent. This module parses deliverables into
 * narrow typed shapes (`InstagramCarouselDeliverable` and siblings) and none of
 * them declared it, so a degraded deliverable reached the client looking
 * exactly like a fully-grounded one — which is the situation T-A10 exists to
 * prevent and SCRUM-388's relaxation quietly depended on not being true.
 *
 * Asserted THROUGH the materializer, on the asset it actually writes, and
 * across products rather than on one: the whole defect was that it worked
 * per-product-shape, so a test that pinned one product would have passed
 * against the broken code for every other.
 */
describe("SCRUM-404: the context-grounding marker survives onto the asset", () => {
  const marker = {
    contextGroundingStatus: "degraded",
    agentId: "intel-report-agent",
    missingDocTypes: ["market-strategy", "target-audience"],
    reason: "output is a client-facing deliverable that names external parties (competitors) — ungrounded is worse than absent — exempted from BLOCK because this is a runKind:\"setup\" run",
  };

  it("carries the marker through for each of the three agents whose policy row can produce one", async () => {
    // The CONTEXT_DOC_POLICY rows actually wired to a call site
    // (`context-doc-policy.ts`): intel-report degrades under `bootstrapExempt`,
    // instagram and branded-shorts degrade outright.
    for (const [productId, deliverable] of [
      ["intel-report-agent", { headline: "Three competitors moved", sections: [] }],
      ["instagram-agent", { caption: "A caption", slides: [] }],
      ["branded-shorts-agent", { title: "A short", scriptMarkdown: "# Script" }],
    ] as const) {
      createAssetMock.mockClear();
      await materialize(productId, { ...deliverable, contextGrounding: marker });
      expect(createdAsset().contextGrounding, `${productId} must carry the marker`).toEqual({
        status: "degraded",
        agentId: "intel-report-agent",
        missingDocTypes: ["market-strategy", "target-audience"],
        reason: marker.reason,
      });
    }
  });

  it("leaves the field ABSENT on a fully-grounded deliverable — no scare copy on the normal path", async () => {
    await materialize("intel-report-agent", { headline: "Three competitors moved", sections: [] });
    expect("contextGrounding" in createdAsset()).toBe(false);
  });

  it("drops a marker that does not validate rather than rendering a half-claim", async () => {
    // This crossed a service boundary, so it gets the same treatment as every
    // other value that does. A partial marker must not become a client-visible
    // label naming a document it cannot actually name.
    for (const bad of [
      { contextGroundingStatus: "degraded" }, // no agentId, no reason
      { contextGroundingStatus: "some_future_state", agentId: "a", reason: "r" },
      { agentId: "a", reason: "r", missingDocTypes: [] }, // no status literal
      "degraded",
    ]) {
      createAssetMock.mockClear();
      await materialize("intel-report-agent", { headline: "H", sections: [], contextGrounding: bad });
      expect("contextGrounding" in createdAsset(), `${JSON.stringify(bad)} must not become an asset label`).toBe(false);
    }
  });

  it("keeps a marker whose missingDocTypes list is empty or partly unusable", async () => {
    // The marker is still a true statement about the run when the list is
    // empty, and a list with junk in it is narrowed to the strings present
    // rather than dropped — the count a client reads must stay honest.
    await materialize("intel-report-agent", {
      headline: "H",
      sections: [],
      contextGrounding: { ...marker, missingDocTypes: ["market-strategy", 7, null, ""] },
    });
    expect(createdAsset().contextGrounding?.missingDocTypes).toEqual(["market-strategy"]);
  });
});

describe("what it deliberately does not do", () => {
  it("no-ops for a product id it has never heard of, without reaching the engine", async () => {
    const assetId = await materializeAgentEngineDeliverable(job("some-future-agent"));
    expect(assetId).toBeUndefined();
    expect(getDeliverableMock).not.toHaveBeenCalled();
    expect(createAssetMock).not.toHaveBeenCalled();
  });

  it("no-ops for a job that already has an asset — the idempotency convention", async () => {
    const assetId = await materialize("x-agent", { text: "x" }, { assetIds: ["asset_existing"] });
    expect(assetId).toBeUndefined();
    expect(createAssetMock).not.toHaveBeenCalled();
  });

  it("no-ops when the deliverable is not written yet (a 404 reads as undefined)", async () => {
    getDeliverableMock.mockResolvedValue(undefined);
    expect(await materializeAgentEngineDeliverable(job("x-agent"))).toBeUndefined();
    expect(createAssetMock).not.toHaveBeenCalled();
  });

  it("swallows a materialization failure rather than blocking the job from reaching review", async () => {
    getDeliverableMock.mockRejectedValue(new Error("engine unreachable"));
    expect(await materializeAgentEngineDeliverable(job("x-agent"))).toBeUndefined();
  });

  it("survives a deliverable whose shape drifted, with a thinner asset rather than a throw", async () => {
    // Every field read defensively — the alternative is an exception this module
    // swallows, which lands the job right back at "review with nothing attached".
    const assetId = await materialize("linkedin-agent", { archetype: 42, hashtags: "not-an-array", text: null });
    expect(assetId).toBe("agent-engine-pubsub-1");
    const asset = createdAsset();
    expect(asset.content).toBe("");
    expect(asset.title).toBe("LinkedIn post");
  });
});

describe("titling", () => {
  it("prefers the shared titler, so both delivery paths name assets under one contract", async () => {
    generateTitleMock.mockResolvedValue("Two camps in marketing automation");
    await materialize("x-agent", { text: "Some post text.", hook: "a hook" });
    expect(createdAsset().title).toBe("Two camps in marketing automation");
    expect(generateTitleMock).toHaveBeenCalledWith(
      expect.objectContaining({ content: "Some post text.", clientId: "client_1" }),
    );
  });

  it("does not spend the call on an empty-content deliverable", async () => {
    await materialize("branded-shorts-agent", { durationSeconds: 30 });
    expect(generateTitleMock).not.toHaveBeenCalled();
    expect(createdAsset().title).toBe("TikTok video");
  });
});

describe("the job is wired to its new asset", () => {
  it("attaches the asset id and reflows the client's calendar chain", async () => {
    await materialize("x-agent", { text: "post" });
    expect(attachAssetToJobMock).toHaveBeenCalledWith("job_1", "agent-engine-pubsub-1");
    expect(reflowMock).toHaveBeenCalledWith("client_1");
  });

  it("stamps the run and product onto the asset's meta for traceability", async () => {
    await materialize("x-agent", { text: "post" });
    expect(createdAsset().meta).toMatchObject({ agentEngineRunId: "pubsub-1", agentEngineProductId: "x-agent" });
  });
});

describe("two materializations of one run cannot produce two assets", () => {
  // Prep, 2026-08-25: eight Job-page renders in 16 s during one run's
  // completion, eight identical instagram assets — every deferred sync held a
  // job snapshot with `assetIds: []`. The three layers below are the fix.

  it("bails on the FRESH job before spending anything when another writer already attached an asset", async () => {
    getJobMock.mockResolvedValue({ ...job("x-agent"), assetIds: ["agent-engine-pubsub-1"] });
    const assetId = await materialize("x-agent", { text: "post" });
    expect(assetId).toBeUndefined();
    expect(getDeliverableMock).not.toHaveBeenCalled();
    expect(generateTitleMock).not.toHaveBeenCalled();
    expect(createAssetMock).not.toHaveBeenCalled();
  });

  it("mints the asset under a deterministic id derived from the run, via the idempotent create", async () => {
    await materialize("x-agent", { text: "post" });
    expect(createAssetMock).toHaveBeenCalledWith(expect.objectContaining({ jobId: "job_1" }), "agent-engine-pubsub-1");
  });

  it("when it loses the create race it still attaches the winner's asset, and neither reflows nor duplicates", async () => {
    createAssetMock.mockImplementation(async (_data: unknown, id: string) => ({ id, created: false }));
    const assetId = await materialize("x-agent", { text: "post" });
    expect(assetId).toBe("agent-engine-pubsub-1");
    expect(attachAssetToJobMock).toHaveBeenCalledWith("job_1", "agent-engine-pubsub-1");
    expect(reflowMock).not.toHaveBeenCalled();
  });

  it("treats a failed fresh read as no information rather than as a reason to throw or to skip", async () => {
    getJobMock.mockRejectedValue(new Error("firestore hiccup"));
    expect(await materialize("x-agent", { text: "post" })).toBe("agent-engine-pubsub-1");
  });
});
