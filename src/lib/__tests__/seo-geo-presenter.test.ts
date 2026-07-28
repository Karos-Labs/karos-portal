import { describe, expect, it } from "vitest";
import {
  AGENT_MAPPED_IDS,
  agentLabelFor,
  bucketLabel,
  buildContextLine,
  buildDiscoveredViews,
  buildRosterChips,
  buildRosterDrift,
  buildEngineViews,
  buildGapViews,
  buildPresence,
  buildPromptViews,
  buildScoreViews,
  engineFlagPrefill,
  formatCaptured,
  genericFlagPrefill,
  scoreBand,
  unwiredRequestPrefill,
} from "@/components/seo-geo/presenter";
import {
  GEO_READINESS_CHECKS,
  REC_COPY,
  SEO_CHECKS,
  computeCheckGaps,
  type PerEngineVisibility,
  type SeoGeoInsights,
  type VisibilityGap,
} from "@/lib/seo-geo";

/* ── factories (existing seo-geo.test.ts style: defaults + patch) ── */

const gap = (patch: Partial<VisibilityGap> = {}): VisibilityGap => ({
  id: "SEO-02",
  lever: "SEO",
  title: "innocuous title",
  severity: "high",
  evidence: "innocuous evidence",
  confidence: "CONFIRMED",
  fixAction: "manual",
  target: "site-wide",
  delivery: "agent-direct",
  benchmark: "innocuous benchmark",
  measured: "innocuous measured",
  scoreLift: 1,
  productRef: null,
  artifactRef: null,
  ...patch,
});

const engineRow = (patch: Partial<PerEngineVisibility> = {}): PerEngineVisibility => ({
  engine: "chatgpt",
  source: "OpenAI",
  captureTier: "MEASURED",
  promptsMeasured: 10,
  promptsTotal: 10,
  mentionRate: 0.3,
  citationRate: 0.1,
  firstPositionRate: 0.1,
  shareOfVoice: 20,
  netSentiment: 0,
  ghostCitationRate: 0,
  topCompetitor: null,
  brandMentions: [
    { name: "Acme", mentions: 3, isClient: true },
    { name: "Rival", mentions: 6, isClient: false },
  ],
  category: {
    promptsMeasured: 10,
    mentionRate: 0.3,
    citationRate: 0.1,
    firstPositionRate: 0.1,
    shareOfVoice: 20,
    netSentiment: 0,
    ghostCitationRate: 0,
    topCompetitor: null,
    brandMentions: [
      { name: "Acme", mentions: 3, isClient: true },
      { name: "Rival", mentions: 6, isClient: false },
    ],
  },
  brandNamed: 0,
  brandPromptsMeasured: 0,
  ...patch,
});

const insights = (patch: Partial<SeoGeoInsights> = {}): SeoGeoInsights => ({
  clientId: "client-1",
  capturedAt: Date.UTC(2026, 6, 12),
  seoScore: 63,
  seoDataCoveragePct: 75,
  geoReadiness: 36,
  geoReadinessCoveragePct: 94,
  geoVisibilityIndex: 21,
  geoVisibilityCoveragePct: 60,
  geoVisibilityModel: "appearance-led (geo-score-v3): mean over engines",
  geoVisibilityEnginesMeasured: 3,
  geoVisibilityEnginesScored: 3,
  geoVisibilityEnginesTotal: 5,
  rosterSharePct: 18.3,
  categoryPresence: { named: 1, total: 8 },
  brandPresence: { named: 2, total: 2 },
  perEngine: [engineRow()],
  gaps: [],
  recommendations: [],
  seoChecks: [],
  geoChecks: [],
  intentPrompts: [],
  answerGrid: [],
  citationLeaderboard: [],
  citationSummary: {
    totalMeasuredAnswers: 0,
    answersCited: 0,
    answersNamed: 0,
    ghostCitations: 0,
  },
  competitorsNamed: [],
  promptSet: ["best fintech tool for startups", "Is Acme legit?"],
  roster: ["Acme", "Rival"],
  updatedAt: 0,
  ...patch,
});

/**
 * Internal producer/actuator vocabulary that must never reach a client screen
 * (SCRUM-52 fix 1). Checked against every string the presenter GENERATES;
 * passthrough human text (title/evidence/measured/benchmark) is exercised
 * with innocuous values so any hit here is presenter-made.
 */
const FORBIDDEN_TOKENS = [
  "agent-direct",
  "existing-product",
  "meta_title",
  "meta_description",
  "og_image",
  "image_alt",
  "canonical",
  "sitemap",
  "indexing",
  "CONFIRMED",
  "LIKELY",
  "HYPOTHESIS",
  "MEASURED_grounded",
  "UNAVAILABLE",
  "geo-score-v3",
  "appearance-led",
  "scoreLift",
  "productRef",
  "products/",
  "social_post",
];

const ALL_FIX_ACTIONS = [
  "meta_title",
  "meta_description",
  "schema",
  "og_image",
  "canonical",
  "image_alt",
  "sitemap",
  "indexing",
  "manual",
] as const;
const ALL_DELIVERIES = ["agent-direct", "existing-product", "advisory"] as const;
const ALL_CONFIDENCES = ["CONFIRMED", "LIKELY", "HYPOTHESIS"] as const;
const ALL_LEVERS = ["SEO", "GEO", "BOTH"] as const;

describe("leak guard (SCRUM-52 fix 1)", () => {
  it("never emits internal vocabulary for any known enum combination", () => {
    const gaps: VisibilityGap[] = [];
    for (const fixAction of ALL_FIX_ACTIONS)
      for (const delivery of ALL_DELIVERIES)
        for (const confidence of ALL_CONFIDENCES)
          for (const lever of ALL_LEVERS)
            gaps.push(gap({ fixAction, delivery, confidence, lever }));
    // `key` is a React key (never rendered), so strip it from the sweep.
    const rendered = JSON.stringify(buildGapViews(gaps, "client-1"), (k, v) =>
      k === "key" ? undefined : v,
    );
    for (const token of FORBIDDEN_TOKENS) expect(rendered).not.toContain(token);
  });

  it("maps unknown enum values to safe defaults instead of echoing them", () => {
    const weird = gap({
      fixAction: "weird_opcode" as VisibilityGap["fixAction"],
      delivery: "weird-route" as VisibilityGap["delivery"],
      confidence: "GUESSING" as VisibilityGap["confidence"],
      lever: "MYSTERY" as VisibilityGap["lever"],
      severity: "weird" as VisibilityGap["severity"],
    });
    const [view] = buildGapViews([weird], "client-1");
    const rendered = JSON.stringify(view);
    expect(rendered).not.toContain("weird_opcode");
    expect(rendered).not.toContain("weird-route");
    expect(rendered).not.toContain("GUESSING");
    expect(rendered).not.toContain("MYSTERY");
    expect(view.fixArea).toBeNull();
    expect(view.fixRoute).toBe("The Karos team will handle this.");
    expect(view.qualifier).toBe("Under review by the Karos team");
    expect(view.channelLabel).toBe("search + AI");
    expect(view.severityLabel).toBe("minor");
  });

  it("keeps capture tiers, the scoring-model label, and provider enums out of engine and score views", () => {
    const data = insights({
      perEngine: [
        engineRow(),
        engineRow({ engine: "gemini", source: "Gemini", captureTier: "MEASURED_grounded" }),
        engineRow({
          engine: "perplexity",
          source: null,
          captureTier: "UNAVAILABLE",
          promptsMeasured: 0,
          brandMentions: [],
        }),
      ],
    });
    const rendered = JSON.stringify([buildEngineViews(data), buildScoreViews(data)]);
    expect(rendered).not.toContain("MEASURED_grounded");
    expect(rendered).not.toContain("UNAVAILABLE");
    expect(rendered).not.toContain("geo-score-v3");
    expect(rendered).not.toContain("appearance-led");
  });

  it("never renders a raw productRef id or folder", () => {
    const [view] = buildGapViews(
      [
        gap({
          id: "GEO-31",
          delivery: "existing-product",
          productRef: { id: "social_post", folder: "products/e7-social", status: "live" },
        }),
      ],
      "client-1",
    );
    const rendered = JSON.stringify(view);
    expect(rendered).not.toContain("social_post");
    expect(rendered).not.toContain("products/");
    expect(view.agentChip?.label).toBe("Handled by your Social agent");
  });
});

describe("gap copy (QA F3)", () => {
  it("resolves the card title through REC_COPY and demotes the registry label", () => {
    const [view] = buildGapViews(
      [gap({ id: "SEO-04a", title: "LCP p75 ≤ 2.5s", benchmark: "LCP p75 ≤ 2.5s" })],
      "c",
    );
    expect(view.title).toBe("Speed up how fast your pages appear");
    expect(view.technicalLabel).toBe("LCP p75 ≤ 2.5s");
  });

  it("drops the goal line when the benchmark just repeats the title", () => {
    // computeCheckGaps sets benchmark = def.label = title for EVERY site check,
    // so "what good looks like" printed the card title back verbatim.
    const [same] = buildGapViews(
      [gap({ id: "SEO-04a", title: "LCP p75 ≤ 2.5s", benchmark: "LCP p75 ≤ 2.5s" })],
      "c",
    );
    expect(same.goalLine).toBeNull();

    const [differs] = buildGapViews(
      [gap({ id: "GEO-35:chatgpt", title: "Low named-mention rate", benchmark: "≥ 30% of category answers" })],
      "c",
    );
    expect(differs.goalLine).toBe("≥ 30% of category answers");
  });

  it("never carries an unmapped model label into the title when copy exists", () => {
    for (const def of [...SEO_CHECKS, ...GEO_READINESS_CHECKS]) {
      const [view] = buildGapViews([gap({ id: def.id, title: def.label, benchmark: def.label })], "c");
      expect(view.title).not.toBe(def.label);
      expect(view.goalLine).toBeNull();
    }
  });

  it("still shows something for an id with no copy at all", () => {
    const [view] = buildGapViews([gap({ id: "GEO-999", title: "Vibes score" })], "c");
    expect(view.title).toBe("Vibes score");
    expect(view.technicalLabel).toBeNull();
  });
});

describe("funnel chip (QA F7)", () => {
  /**
   * The regression this whole block exists for: the old suite hand-constructed
   * `delivery: "existing-product"` gaps carrying GEO-16 / GEO-31 / BOTH-08 — a
   * combination the pipeline never produces — so it passed while the chip was
   * structurally unreachable in production. Every id below is emitted by a real
   * registry, and none of them is forced onto the existing-product route.
   */
  it("routes real registry ids to their executing agent, whatever the delivery route", () => {
    const views = buildGapViews(
      [
        gap({ id: "GEO-20", delivery: "agent-direct", scoreLift: 9 }),
        gap({ id: "BOTH-13", delivery: "agent-direct", scoreLift: 8 }),
        gap({ id: "SEO-02", delivery: "agent-direct", scoreLift: 7 }),
        gap({ id: "GEO-22", delivery: "agent-direct", scoreLift: 6 }),
      ],
      "client-9",
    );
    expect(views.map((v) => v.agentChip?.label)).toEqual([
      "Handled by your Blog agent",
      "Handled by your Blog agent",
      "Handled by your Website agent",
      "Handled by your Blog agent",
    ]);
    for (const v of views) expect(v.agentChip?.href).toBe("/clients/client-9/agents");
  });

  it("maps only ids the producers actually emit — no phantom keys", () => {
    const emitted = new Set([
      ...SEO_CHECKS.map((d) => d.id),
      ...GEO_READINESS_CHECKS.map((d) => d.id),
      ...Object.keys(REC_COPY),
    ]);
    for (const id of AGENT_MAPPED_IDS) expect(emitted.has(id)).toBe(true);
  });

  it("resolves the chip on a real pipeline gap, not just a hand-built one", () => {
    // Straight from the producer: model checks → computeCheckGaps → buildGapViews.
    const gaps = computeCheckGaps(
      SEO_CHECKS,
      [{ id: "SEO-02", bucket: "onPage", label: "Title tags", evidence: "74 chars", norm: 0, tier: "MEASURED", confidence: "CONFIRMED" }],
      "SEO",
    );
    const [view] = buildGapViews(gaps, "c");
    expect(view.agentChip?.label).toBe("Handled by your Website agent");
  });

  it("keeps the route sentence alongside the chip instead of replacing it", () => {
    const [view] = buildGapViews([gap({ id: "GEO-20", delivery: "agent-direct" })], "c");
    // QA F4: no apply path exists (both producers hardcode artifactRef: null), so
    // this route promises a draft-for-approval, never an automatic fix.
    expect(view.fixRoute).toBe("Karos drafts this fix for your approval.");
    expect(view.agentChip).not.toBeNull();
  });

  it("never promises an automatic fix on any delivery route (QA F4)", () => {
    const views = buildGapViews(
      (["agent-direct", "existing-product", "advisory", "weird"] as const).map((delivery) =>
        gap({ delivery: delivery as VisibilityGap["delivery"] }),
      ),
      "c",
    );
    for (const v of views) expect(v.fixRoute.toLowerCase()).not.toContain("automatic");
  });

  it("leaves advisory off-site and visibility gaps without an agent chip", () => {
    // Naming an agent the client may not have is the defect F7 reports; these
    // routes stay on the honest "our team will handle it" sentence.
    for (const id of ["GEO-04", "GEO-14", "GEO-25", "GEO-11:chatgpt", "GEO-27:gemini", "GEO-35:claude"]) {
      const [view] = buildGapViews([gap({ id, delivery: "advisory" })], "c");
      expect(view.agentChip).toBeNull();
    }
  });

  it("falls back to the plain route sentence when no route resolves (closed map)", () => {
    const [view] = buildGapViews([gap({ id: "GEO-24", delivery: "existing-product" })], "c");
    expect(view.agentChip).toBeNull();
    expect(view.fixRoute).toBe("This is handled through a tool already in your Karos plan.");
  });

  it("prefers a resolvable productRef over the static rec-id map", () => {
    const g = gap({
      id: "GEO-20", // static map says Blog agent
      delivery: "existing-product",
      productRef: { id: "landing_page", folder: "products/e9-web", status: "live" },
    });
    expect(agentLabelFor(g)).toBe("Website agent");
  });

  it("falls back to the rec-id map when the productRef id is unknown", () => {
    const g = gap({
      id: "GEO-20",
      delivery: "existing-product",
      productRef: { id: "mystery_product", folder: "x", status: "live" },
    });
    expect(agentLabelFor(g)).toBe("Blog agent");
  });

  it("strips engine suffixes from rec ids before the lookup", () => {
    expect(agentLabelFor(gap({ id: "GEO-20:chatgpt" }))).toBe("Blog agent");
  });
});

describe("engine views (SCRUM-52 fixes 2 + 4)", () => {
  it("always yields all five engines in fixed order, synthesizing missing rows", () => {
    const views = buildEngineViews(insights({ perEngine: [] }));
    expect(views.map((v) => v.engine)).toEqual(["chatgpt", "gemini", "claude", "perplexity", "copilot"]);
    // Wired engines with no row are "no answers"; unwired are "not yet measured".
    expect(views.map((v) => v.status)).toEqual(["no-data", "no-data", "no-data", "not-wired", "not-wired"]);
  });

  it("synthesizes the missing copilot row from a partial capture and traces the cause", () => {
    const views = buildEngineViews(insights()); // fixture has chatgpt only
    const copilot = views.find((v) => v.engine === "copilot");
    expect(copilot?.status).toBe("not-wired");
    expect(copilot?.statusLabel).toBe("not yet measured");
    expect(copilot?.causeLine).toContain("connection to this engine isn't built");
  });

  it("treats a wired engine with zero measured prompts as no-data, not not-wired", () => {
    const views = buildEngineViews(
      insights({ perEngine: [engineRow({ promptsMeasured: 0, brandMentions: [] })] }),
    );
    const chatgpt = views.find((v) => v.engine === "chatgpt");
    expect(chatgpt?.status).toBe("no-data");
    expect(chatgpt?.causeLine).toContain("no usable answers this run");
  });

  it("labels ratios as fractions and derives counts from rates (fix 3)", () => {
    const [chatgpt] = buildEngineViews(insights());
    // Highest mention count sorts first (QA Fix 2 amendment) — Rival (6) before Acme (3).
    expect(chatgpt.brands.map((b) => b.name)).toEqual(["Rival", "Acme"]);
    expect(chatgpt.brands[0].line).toBe("named in 6 of 10 answers");
    expect(chatgpt.stats.map((s) => s.value)).toEqual(["20%", "1 of 10 answers", "1 of 10 answers"]);
  });

  it("only surfaces ghost citations when the rate is above zero", () => {
    const [withGhost] = buildEngineViews(
      insights({ perEngine: [engineRow({ ghostCitationRate: 33.3 })] }),
    );
    expect(withGhost.ghost?.label).toBe("linked but not named · 33% of your citations");
    const [without] = buildEngineViews(insights());
    expect(without.ghost).toBeNull();
  });
});

describe("score views + context line (fixes 2 + 3)", () => {
  it("separates the score from its coverage and words the engine disclosure", () => {
    const [seo, readiness, visibility] = buildScoreViews(insights());
    expect(seo.coverageLine).toBe("measured 75% of checks");
    expect(readiness.coverageLine).toBe("measured 94% of checks");
    expect(visibility.coverageLine).toBe("based on 3 of 5 AI engines");
    expect(visibility.coveragePct).toBe(60);
  });

  it("renders absent data as null values, never a zero grade", () => {
    const views = buildScoreViews(
      insights({ seoDataCoveragePct: 0, geoVisibilityEnginesScored: 0 }),
    );
    expect(views[0].value).toBeNull();
    expect(views[0].bandLabel).toBe("not measured yet");
    expect(views[2].value).toBeNull();
    expect(views[2].bandLabel).toBe("no engines measured this run");
  });

  it("bands scores at the existing 40/70 thresholds", () => {
    expect(scoreBand(39).tone).toBe("danger");
    expect(scoreBand(40).tone).toBe("warning");
    expect(scoreBand(69).tone).toBe("warning");
    expect(scoreBand(70).tone).toBe("success");
  });

  it("answers 'why only 3 models' in the context line", () => {
    expect(buildContextLine(insights())).toBe(
      "Snapshot from 2026-07-12 · 2 real buyer questions · 3 of 5 AI engines measured",
    );
  });

  it("labels every registry bucket without falling back to the generic", () => {
    for (const def of [...SEO_CHECKS, ...GEO_READINESS_CHECKS]) {
      expect(bucketLabel(def.bucket)).not.toBe("Other checks");
    }
  });
});

describe("presence + prompts", () => {
  it("picks the known-by-name-but-invisible takeaway for high brand / low category", () => {
    const view = buildPresence(insights());
    expect(view.brand.fractionLine).toBe("Named in 2 of 2 questions");
    expect(view.category.fractionLine).toBe("Named in 1 of 8 questions");
    expect(view.takeaway).toContain("missing from the questions new customers ask");
  });

  it("suppresses the takeaway and fraction when a prompt bucket is empty", () => {
    const view = buildPresence(insights({ brandPresence: { named: 0, total: 0 } }));
    expect(view.brand.fractionLine).toBeNull();
    expect(view.brand.emptyLine).not.toBeNull();
    expect(view.takeaway).toBeNull();
  });

  it("drops the roster share strip when no competitors are tracked", () => {
    expect(buildPresence(insights({ roster: ["Acme"] })).rosterShare).toBeNull();
    expect(buildPresence(insights()).rosterShare?.value).toBe("18%");
  });

  it("tags prompts that mention the client by name and stays silent otherwise", () => {
    // No affirmative "category question" claim: the pipeline's brand/category
    // split matches the full alias set, which the doc doesn't store, so a
    // definite tag could contradict the presence tiles.
    const tags = buildPromptViews(insights()).map((p) => p.tagLabel);
    expect(tags).toEqual([null, "mentions you"]);
  });

  it("covers the low-brand, high-category takeaway quadrant", () => {
    const view = buildPresence(
      insights({
        brandPresence: { named: 0, total: 2 },
        categoryPresence: { named: 4, total: 8 },
      }),
    );
    expect(view.takeaway).toContain("Strengthening your brand signals");
  });
});

describe("flag prefills (fix 4)", () => {
  it("prefills the connector request with the engine and snapshot date", () => {
    const prefill = engineFlagPrefill("Perplexity", insights());
    expect(prefill.subject).toBe("Request: measure Perplexity in our AI visibility snapshot");
    expect(prefill.message).toContain("snapshot 2026-07-12");
  });

  it("attaches the right prefill to unmeasured engine views", () => {
    const views = buildEngineViews(insights({ perEngine: [engineRow({ promptsMeasured: 0, brandMentions: [] })] }));
    const chatgpt = views.find((v) => v.engine === "chatgpt");
    const copilot = views.find((v) => v.engine === "copilot");
    const measured = buildEngineViews(insights()).find((v) => v.engine === "chatgpt");
    expect(chatgpt?.flagPrefill?.subject).toBe("Question about ChatGPT in our AI visibility snapshot");
    expect(copilot?.flagPrefill?.subject).toBe("Request: measure Copilot in our AI visibility snapshot");
    expect(measured?.flagPrefill).toBeNull();
  });

  it("builds one request covering every unwired engine", () => {
    const prefill = unwiredRequestPrefill(["Perplexity", "Copilot"], insights());
    expect(prefill.subject).toBe("Request: measure Perplexity and Copilot in our AI visibility snapshot");
    expect(prefill.message).toContain("snapshot 2026-07-12");
  });

  it("degrades gracefully when capturedAt is invalid instead of throwing", () => {
    expect(formatCaptured(Number.NaN)).toBe("an earlier run");
    expect(genericFlagPrefill(insights({ capturedAt: Number.NaN })).subject).toContain("an earlier run");
  });
});

describe("tracked-list alignment (competitor side-by-side)", () => {
  const trackedInsights = () =>
    insights({
      roster: ["Acme", "Rival"],
      discoveredBrands: [
        {
          name: "NewRival",
          url: "newrival.com",
          mentions: 4,
          perEngine: [{ engine: "chatgpt", mentions: 3 }],
        },
      ],
      citationSummary: { totalMeasuredAnswers: 12, answersCited: 1, answersNamed: 2, ghostCitations: 0 },
    });

  it("renders rows for the CURRENT tracked list, not the frozen snapshot", () => {
    const tracked = [
      { name: "Rival", url: "rival.com" },
      { name: "NewRival", url: "newrival.com" },
      { name: "Unmeasured Co" },
    ];
    const [chatgpt] = buildEngineViews(trackedInsights(), tracked, "https://acme.com");
    const names = chatgpt.brands.map((b) => b.name);
    expect(names).toContain("Rival");
    expect(names).toContain("NewRival");
    expect(names).toContain("Unmeasured Co");

    const rival = chatgpt.brands.find((b) => b.name === "Rival")!;
    expect(rival.measured).toBe(true);
    expect(rival.line).toBe("named in 6 of 10 answers");

    // Discovered brand: counts come from the discovery pass for this engine.
    const newRival = chatgpt.brands.find((b) => b.name === "NewRival")!;
    expect(newRival.measured).toBe(true);
    expect(newRival.line).toBe("named in 3 of 10 answers");

    // Tracked but never measured: explicit placeholder, no invented counts.
    const pending = chatgpt.brands.find((b) => b.name === "Unmeasured Co")!;
    expect(pending.measured).toBe(false);
    expect(pending.line).toBe("measured on the next snapshot");

    // Client row keeps its favicon website + (you) flag position.
    const client = chatgpt.brands.find((b) => b.isClient)!;
    expect(client.url).toBe("https://acme.com");
  });

  it("drops snapshot brands that are no longer tracked and reports them as drift", () => {
    const tracked = [{ name: "NewRival", url: "newrival.com" }];
    const [chatgpt] = buildEngineViews(trackedInsights(), tracked, null);
    expect(chatgpt.brands.map((b) => b.name)).not.toContain("Rival");

    const drift = buildRosterDrift(trackedInsights(), tracked);
    expect(drift.isStale).toBe(true);
    expect(drift.removed).toEqual(["Rival"]);
    // NewRival has discovery data, so it is NOT "added/pending".
    expect(drift.added).toEqual([]);
  });

  it("keeps the legacy snapshot rows when no tracked list is supplied", () => {
    const [chatgpt] = buildEngineViews(trackedInsights());
    expect(chatgpt.brands.map((b) => b.name)).toEqual(["Rival", "Acme"]);
    expect(chatgpt.brands.every((b) => b.measured)).toBe(true);
  });

  it("lists discovered brands minus the ones already tracked", () => {
    const none = buildDiscoveredViews(trackedInsights(), [{ name: "NewRival", url: "newrival.com" }]);
    expect(none).toEqual([]);

    const views = buildDiscoveredViews(trackedInsights(), [{ name: "Rival" }]);
    expect(views).toHaveLength(1);
    expect(views[0].name).toBe("NewRival");
    expect(views[0].line).toBe("named in 4 of 12 answers");
  });

  it("builds roster chips from the tracked list with pending flags", () => {
    const chips = buildRosterChips(
      trackedInsights(),
      [{ name: "Rival", url: "rival.com" }, { name: "Ghost Co" }],
      "acme.com",
    );
    expect(chips[0]).toMatchObject({ name: "Acme", isClient: true, url: "acme.com", pending: false });
    expect(chips[1]).toMatchObject({ name: "Rival", pending: false });
    expect(chips[2]).toMatchObject({ name: "Ghost Co", pending: true });
  });
});

describe("name-vs-domain identity (CTech regression)", () => {
  const ctechInsights = () =>
    insights({
      roster: ["Acme", "CTech by Calcalist"],
      perEngine: [
        engineRow({
          brandMentions: [
            { name: "Acme", mentions: 3, isClient: true },
            { name: "CTech by Calcalist", mentions: 4, isClient: false },
          ],
          category: {
            promptsMeasured: 10,
            mentionRate: 0.3,
            citationRate: 0.1,
            firstPositionRate: 0.1,
            shareOfVoice: 20,
            netSentiment: 0,
            ghostCitationRate: 0,
            topCompetitor: null,
            brandMentions: [
              { name: "Acme", mentions: 3, isClient: true },
              { name: "CTech by Calcalist", mentions: 4, isClient: false },
            ],
          },
        }),
      ],
    });

  it("matches a tracked ref whose display name differs from its domain label", () => {
    const tracked = [{ name: "CTech by Calcalist", url: "https://www.calcalistech.com" }];
    const [chatgpt] = buildEngineViews(ctechInsights(), tracked, null);
    const row = chatgpt.brands.find((b) => b.name === "CTech by Calcalist")!;
    expect(row.measured).toBe(true);
    expect(row.line).toBe("named in 4 of 10 answers");

    const drift = buildRosterDrift(ctechInsights(), tracked);
    expect(drift).toEqual({ added: [], removed: [], isStale: false });

    const chips = buildRosterChips(ctechInsights(), tracked, null);
    expect(chips[1]).toMatchObject({ name: "CTech by Calcalist", pending: false });
  });
});
