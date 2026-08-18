import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import {
  LEVER_LABELS,
  PRODUCT_MAPPED_IDS,
  productLabelFor,
  bucketLabel,
  buildAnswerGridViews,
  buildCaptureStrip,
  buildContextLine,
  buildCitationView,
  buildIntentPromptViews,
  buildMeasurementBasis,
  buildQuestionPlanLine,
  capturedNothing,
  formatPrompt,
  snapshotAge,
  buildDiscoveredViews,
  buildRosterChips,
  buildRosterDrift,
  buildRosterSanity,
  buildEngineViews,
  buildGapViews,
  buildPresence,
  buildPromptViews,
  buildScoreViews,
  buildSnapshotTrust,
  formatCaptured,
  genericFlagPrefill,
  scoreBand,
} from "@/components/seo-geo/presenter";
import {
  GEO_READINESS_CHECKS,
  SEO_CHECKS,
  SEO_GEO_METHODOLOGY_VERSION,
  SEO_GEO_PIPELINE_VERSION,
  calculateOverallVisibilityScore,
  computeCheckGaps,
  computeVisibilityGaps,
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
  // DELIBERATELY CONTRADICTING `perEngine` below, and left that way (#123). These
  // three stored fields were frozen at capture under whatever formula was current
  // then; `perEngine` is what the tile is actually derived from now. The headline
  // went live in 682e188 while the coverage line stayed on these, so a snapshot
  // could print a real score above "based on 0 of 5 AI engines". Every visibility
  // assertion below is therefore stated in terms of the ARRAY (1 row = 1 of 1). If
  // a future edit "tidies" these to agree with `perEngine`, the fixture stops being
  // able to catch the regression it exists for.
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
    // The unknown delivery route falls back to the closed map's default; the
    // executing product still resolves, because it is keyed off the rec id and
    // never off `delivery` (F7).
    expect(view.fixRoute).toBe(
      "The Karos team will handle this. Produced by the Landing page managed product.",
    );
    expect(view.qualifier).toBe("Under review by the Karos team");
    expect(view.channelLabel).toBe("search + AI answers");
    expect(view.severityLabel).toBe("minor");
  });

  it("keeps capture tiers, the scoring-model label, and provider enums out of engine and score views", () => {
    const data = insights({
      perEngine: [
        engineRow(),
        engineRow({ engine: "gemini", source: "Gemini", captureTier: "MEASURED_grounded" }),
        engineRow({
          engine: "claude",
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
    expect(view.fixRoute).toContain("Social posts managed product");
  });
});

/**
 * British/US spelling pairs, word-anchored. Pairs rather than suffixes so the
 * pattern flags what it claims to and nothing else — see the scope note on the
 * test that uses it.
 */
const BRITISH_SPELLING =
  /\b(?:licence|licences|programme|programmes|centre|centres|centred|colour|colours|coloured|behaviour|behaviours|favour|favours|favourite|favourites|flavour|flavours|honour|honours|labour|neighbour|neighbours|rumour|humour|odour|armour|vapour|defence|offence|pretence|practise|practised|practising|cheque|cheques|grey|catalogue|catalogues|dialogue|dialogues|analogue|whilst|amongst|fulfil|fulfils|fulfilment|enrol|enrols|enrolment|instalment|instalments|skilful|cancelled|cancelling|travelled|travelling|modelling|labelled|labelling|signalled|organis(?:e|es|ed|ing|ation|ations)|recognis(?:e|es|ed|ing)|analys(?:e|es|ed|ing)|optimis(?:e|es|ed|ing|ation)|customis(?:e|es|ed|ing)|personalis(?:e|es|ed|ing)|prioritis(?:e|es|ed|ing)|summaris(?:e|es|ed|ing)|apologis(?:e|es|ed|ing)|authoris(?:e|es|ed|ing|ation)|categoris(?:e|es|ed|ing)|specialis(?:e|es|ed|ing)|maximis(?:e|es|ed|ing)|minimis(?:e|es|ed|ing)|utilis(?:e|es|ed|ing)|visualis(?:e|es|ed|ing)|monetis(?:e|es|ed|ing)|emphasis(?:e|es|ed|ing)|standardis(?:e|es|ed|ing))\b/i;

describe("client action-plan lever badge (QA F144 / CD-B1)", () => {
  const ACTION_PLAN = readFileSync(
    path.resolve(process.cwd(), "src/components/seo-geo-action-plan.tsx"),
    "utf8",
  );

  /**
   * The plan rendered `<Badge>{r.vertical}</Badge>` — the raw "SEO"/"GEO"/"BOTH"
   * lever code — on every row a CLIENT reads, while the staff gap card beside it
   * said "search results" / "AI answers". Its replacement map lives in the
   * component (a client leaf must not import the presenter, which would drag the
   * whole domain module into the browser bundle), so the two are pinned together
   * here: this test is the only thing standing between one defect and two
   * vocabularies for the same channel.
   */
  it("renders the presenter's lever words, never the raw code", () => {
    for (const lever of ALL_LEVERS) {
      expect(LEVER_LABELS[lever]).not.toBe(lever);
      expect(ACTION_PLAN).toContain(`${lever}: "${LEVER_LABELS[lever]}"`);
    }
    expect(ACTION_PLAN).toContain("LEVER_LABELS[r.vertical]");
    expect(ACTION_PLAN).not.toContain(">{r.vertical}<");
  });

  it("says the same thing as the staff channel chip for every lever", () => {
    for (const lever of ALL_LEVERS) {
      const [view] = buildGapViews([gap({ lever })], "c");
      expect(view.channelLabel).toBe(LEVER_LABELS[lever]);
    }
  });

  /**
   * The agreement tests above pin the two maps to EACH OTHER, not to the words.
   * Change both to "search engines" and every assertion above stays green —
   * which is the one change CD-B1 exists to prevent. The team paused on exactly
   * that phrasing ("search engines also sounds like AI") and settled the
   * vocabulary: classic ranked results vs assistant answers, and "search
   * results" rather than "Google search" because the checks behind the channel
   * cover Bing and Brave too (GEO-23, GEO-24). So the words themselves are
   * pinned here — a rewrite has to come back through this test and the ruling.
   */
  it("pins the settled CD-B1 wording, not merely the agreement", () => {
    expect(LEVER_LABELS).toEqual({
      SEO: "search results",
      GEO: "AI answers",
      BOTH: "search + AI answers",
    });
  });

  it("never names a single engine, and never says 'search engines'", () => {
    for (const label of Object.values(LEVER_LABELS)) {
      expect(label).not.toMatch(/search engines/i);
      expect(label).not.toMatch(/\b(google|bing|brave)\b/i);
    }
  });

  /**
   * SCOPE: the three lever labels and the quoted strings in
   * seo-geo-action-plan.tsx. Nothing wider. This is NOT a portal-wide spelling
   * guarantee and must not be cited as one.
   *
   * That correction matters, because the premise this guard shipped on was
   * false. Commit 48b5aa0 justified it with "the one genuine client-visible
   * British spelling in the portal ... add-competitor-modal.tsx's placeholder
   * read 'Central Bank licence'" — but that component had zero importers and
   * was rendered nowhere, so no client could ever have read it. It has since
   * been deleted outright (QA #140). The LIVE competitor-add surface,
   * client-context-sections.tsx via addCompetitorByNameAction, was then swept
   * for the same defect class and is clean: "Analyzing competitor profile…",
   * "Brand Colors", "AI analyzed all tracked competitors" are all correct US
   * forms. So this guard protects the two surfaces named above and nothing else.
   *
   * The detector was also rebuilt. It used to be a SUFFIX sweep — bare
   * alternatives "ise", "ised", "ising", "our" and "isation" behind a word
   * boundary — which flags "promise", "advise", "advised", "revised",
   * "concise", "wise", "your", "hour" and "four": nine correct US words. It
   * passed only because its two inputs happened to avoid them; the first person
   * to write "we advise" into the action plan would have been told their US
   * spelling was British. Word-anchored British/US PAIRS detect the thing the
   * name promises instead, and the two assertions below prove the detector both
   * fires and discriminates — without them a typo in the pattern would turn
   * this whole test into a silent pass.
   */
  it("keeps US spelling in the lever labels and the action-plan copy", () => {
    // Fires on real British forms...
    for (const british of [
      "licence",
      "programme",
      "centre",
      "colour",
      "behaviour",
      "defence",
      "organisation",
      "analysed",
      "prioritise",
      "whilst",
    ]) {
      expect(british, `${british} is not detected as British`).toMatch(BRITISH_SPELLING);
    }
    // ...and NOT on the correct US words the old suffix sweep wrongly caught.
    for (const us of [
      "promise",
      "advise",
      "advised",
      "revised",
      "concise",
      "wise",
      "your",
      "hour",
      "four",
      "license",
      "organization",
      "color",
      "center",
      "analyzed",
      "defense",
      "program",
    ]) {
      expect(us, `${us} is correct US spelling and must not be flagged`).not.toMatch(
        BRITISH_SPELLING,
      );
    }

    for (const label of Object.values(LEVER_LABELS)) {
      expect(label).not.toMatch(BRITISH_SPELLING);
    }
    // The plan component's own copy travels with the badge — same rule.
    for (const line of ACTION_PLAN.split("\n")) {
      const strings = line.match(/"[^"]{4,}"/g) ?? [];
      for (const s of strings) expect(s).not.toMatch(BRITISH_SPELLING);
    }
  });
});

describe("gap ordering (QA F22)", () => {
  it("sorts by severity first, lift second, under an 'ordered by impact' header", () => {
    const views = buildGapViews(
      [
        gap({ id: "SEO-02", severity: "high", scoreLift: 5 }),
        gap({ id: "GEO-35:chatgpt", severity: "critical", scoreLift: 4.5 }),
        gap({ id: "GEO-11:chatgpt", severity: "high", scoreLift: 6 }),
        gap({ id: "GEO-18", severity: "medium", scoreLift: 9 }),
      ],
      "c",
    );
    // The urgent row leads even though two rows carry a bigger lift.
    expect(views.map((v) => v.severityLabel)).toEqual([
      "urgent",
      "important",
      "important",
      "moderate",
    ]);
    // Within a severity, the bigger lift still wins.
    expect(views[1].key.startsWith("GEO-11")).toBe(true);
  });

  it("sorts an unknown severity last instead of to the top", () => {
    const views = buildGapViews(
      [
        gap({ id: "GEO-18", severity: "weird" as VisibilityGap["severity"], scoreLift: 10 }),
        gap({ id: "SEO-02", severity: "low", scoreLift: 1 }),
      ],
      "c",
    );
    expect(views[0].key.startsWith("SEO-02")).toBe(true);
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

describe("executing-product line (QA F7)", () => {
  /**
   * The regression this whole block exists for: the old suite hand-constructed
   * `delivery: "existing-product"` gaps carrying GEO-16 / GEO-31 / BOTH-08 — a
   * combination the pipeline never produces — so it passed while the chip was
   * structurally unreachable in production. Every id below is emitted by a real
   * registry, and none of them is forced onto the existing-product route.
   */
  it("names the executing managed product on real registry ids, whatever the delivery route", () => {
    const views = buildGapViews(
      [
        gap({ id: "GEO-20", delivery: "agent-direct", scoreLift: 9 }),
        gap({ id: "BOTH-13", delivery: "agent-direct", scoreLift: 8 }),
        gap({ id: "SEO-02", delivery: "agent-direct", scoreLift: 7 }),
        gap({ id: "GEO-22", delivery: "agent-direct", scoreLift: 6 }),
      ],
      "client-9",
    );
    // Only SEO-02 still names a product. The three content ids lost their clause
    // when the blog became a per-client custom agent — see the unmapped-content
    // test below — and keep the route sentence on its own.
    expect(views.map((v) => v.fixRoute)).toEqual([
      "Karos drafts this fix for your approval.",
      "Karos drafts this fix for your approval.",
      "Karos drafts this fix for your approval. Produced by the Landing page managed product.",
      "Karos drafts this fix for your approval.",
    ]);
  });

  it("never sends staff to an agents page that has no card for the product", () => {
    // /clients/[id]/agents renders the client's granted CUSTOM agents and their
    // umbrellas — MANAGED_PRODUCTS have no card there or anywhere else, so the
    // old "Handled by your Blog agent →" chip was a dead end twice over: no agent
    // by that name, and no card for the product doing the work.
    const views = buildGapViews(
      [gap({ id: "GEO-20" }), gap({ id: "SEO-02" }), gap({ id: "GEO-24" })],
      "client-9",
    );
    for (const v of views) expect(v.agentChip).toBeNull();
    expect(JSON.stringify(views)).not.toContain("/clients/client-9/agents");
  });

  it("maps only ids the producers actually emit — no phantom keys", () => {
    /**
     * Derived by RUNNING the producers, not by listing ids by hand. Every gap the
     * pipeline persists comes from exactly two of them (src/lib/intel/seo-geo.ts):
     * computeCheckGaps over each check registry, and computeVisibilityGaps — given
     * an engine row here that trips all three of its branches.
     *
     * REC_COPY is deliberately NOT in this set. It is client COPY, not a producer,
     * and folding it in is what let "BOTH-07" sit in the map unnoticed: it has
     * REC_COPY prose but no entry in either registry, so nothing can ever emit it.
     *
     * Limitation: computeCheckGaps passes through whatever ids the audit model
     * returned, and sanitizeChecks does not filter them to the registries. The
     * registries are what the audit prompt enumerates and demands back "exactly
     * once", so they are the honest producer set; an id the model invents resolves
     * through REC_FALLBACK and can never reach this map.
     */
    const failing = (defs: typeof SEO_CHECKS) =>
      defs.map((d) => ({
        id: d.id,
        bucket: d.bucket,
        label: d.label,
        evidence: "observed this run",
        norm: 0,
        tier: "MEASURED" as const,
        confidence: "CONFIRMED" as const,
      }));
    const starved = engineRow({
      category: {
        ...engineRow().category,
        mentionRate: 0,
        citationRate: 0,
        shareOfVoice: 0,
        topCompetitor: { name: "Rival", mentionRate: 0.9, shareOfVoice: 90 },
      },
    });
    const emitted = new Set(
      [
        ...computeCheckGaps(SEO_CHECKS, failing(SEO_CHECKS), "SEO"),
        ...computeCheckGaps(GEO_READINESS_CHECKS, failing(GEO_READINESS_CHECKS), "GEO"),
        ...computeVisibilityGaps([starved]),
      ].map((g) => g.id.split(":")[0]),
    );
    // A producer set that quietly went empty would make the subset check vacuous.
    expect(emitted.size).toBeGreaterThan(20);
    expect(emitted.has("GEO-27")).toBe(true); // the visibility producer really ran
    expect(emitted.has("BOTH-07")).toBe(false); // REC_COPY prose, no producer
    for (const id of PRODUCT_MAPPED_IDS) expect(emitted.has(id)).toBe(true);
  });

  it("resolves the product on a real pipeline gap, not just a hand-built one", () => {
    // Straight from the producer: model checks → computeCheckGaps → buildGapViews.
    const gaps = computeCheckGaps(
      SEO_CHECKS,
      [{ id: "SEO-02", bucket: "onPage", label: "Title tags", evidence: "74 chars", norm: 0, tier: "MEASURED", confidence: "CONFIRMED" }],
      "SEO",
    );
    const [view] = buildGapViews(gaps, "c");
    expect(view.fixRoute).toContain("Landing page managed product");
  });

  it("keeps the route sentence alongside the product instead of replacing it", () => {
    // Asked of SEO-02, one of the two ids still mapped to a managed product.
    // GEO-20 used to serve here; it lost its product clause with the blog, so it
    // can no longer prove the two halves coexist.
    const [view] = buildGapViews([gap({ id: "SEO-02", delivery: "agent-direct" })], "c");
    // QA F4: no apply path exists (both producers hardcode artifactRef: null), so
    // this route promises a draft-for-approval, never an automatic fix.
    expect(view.fixRoute).toContain("Karos drafts this fix for your approval.");
    expect(view.fixRoute).toContain("Landing page managed product");
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

  it("leaves advisory off-site and visibility gaps without a named product", () => {
    // Naming an agent (or a product) the client may not have is the defect F7
    // reports; these routes stay on the honest "our team will handle it" sentence.
    for (const id of ["GEO-04", "GEO-14", "GEO-25", "GEO-11:chatgpt", "GEO-27:gemini", "GEO-35:claude"]) {
      const [view] = buildGapViews([gap({ id, delivery: "advisory" })], "c");
      expect(view.fixRoute).toBe(
        "Our team will recommend the changes. This one takes content or outreach work, not a switch we can flip.",
      );
    }
  });

  it("falls back to the plain route sentence when no product resolves (closed map)", () => {
    const [view] = buildGapViews([gap({ id: "GEO-24", delivery: "existing-product" })], "c");
    expect(view.fixRoute).toBe("This is handled through a tool already in your Karos plan.");
  });

  it("prefers a resolvable productRef over the static rec-id map", () => {
    const g = gap({
      id: "GEO-20", // static map says Blog article
      delivery: "existing-product",
      productRef: { id: "landing_page", folder: "products/e9-web", status: "live" },
    });
    expect(productLabelFor(g)).toBe("Landing page");
  });

  it("falls back to the rec-id map when the productRef id is unknown", () => {
    const g = gap({
      id: "SEO-06",
      delivery: "existing-product",
      productRef: { id: "mystery_product", folder: "x", status: "live" },
    });
    expect(productLabelFor(g)).toBe("Landing page");
  });

  it("names NO product on the content checks the blog used to own", () => {
    // GEO-02/03/09/20/22 and BOTH-13/16 pointed at `blog_article` until the blog
    // became a per-client custom agent. They are deliberately unmapped rather
    // than re-pointed: this panel never receives the client's grants, so naming
    // that agent here would promise a client an agent they may not have — the F7
    // defect the rest of this map was cleaned up to remove.
    for (const id of ["GEO-02", "GEO-03", "GEO-09", "GEO-20", "GEO-22", "BOTH-13", "BOTH-16"]) {
      expect(productLabelFor(gap({ id, delivery: "existing-product" })), id).toBeNull();
      expect(PRODUCT_MAPPED_IDS, id).not.toContain(id);
    }
    // Non-vacuity: the map still works for what is still managed.
    expect(productLabelFor(gap({ id: "SEO-02", delivery: "existing-product" }))).toBe("Landing page");
  });

  it("strips engine suffixes from rec ids before the lookup", () => {
    expect(productLabelFor(gap({ id: "SEO-02:chatgpt" }))).toBe("Landing page");
  });
});

describe("engine views (SCRUM-52 fixes 2 + 4)", () => {
  it("always yields every tracked engine in fixed order, synthesizing missing rows", () => {
    const views = buildEngineViews(insights({ perEngine: [] }));
    // CD-B2: Perplexity and Copilot are no longer tracked engines.
    expect(views.map((v) => v.engine)).toEqual(["chatgpt", "gemini", "claude"]);
    expect(views.map((v) => v.status)).toEqual(["no-data", "no-data", "no-data"]);
  });

  it("drops Perplexity and Copilot even when a legacy snapshot still carries them", () => {
    const legacy = insights({
      perEngine: [
        engineRow(),
        { ...engineRow(), engine: "perplexity" as never },
        { ...engineRow(), engine: "copilot" as never },
      ],
    });
    const views = buildEngineViews(legacy);
    expect(views.map((v) => v.engine)).toEqual(["chatgpt", "gemini", "claude"]);
    const rendered = JSON.stringify(views);
    expect(rendered).not.toContain("Perplexity");
    expect(rendered).not.toContain("Copilot");
  });

  it("synthesizes a missing engine row from a partial capture and traces the cause", () => {
    const views = buildEngineViews(insights()); // fixture has chatgpt only
    const claude = views.find((v) => v.engine === "claude");
    expect(claude?.status).toBe("no-data");
    expect(claude?.statusLabel).toBe("no answers this run");
    expect(claude?.causeLine).toContain("no usable answers this run");
  });

  it("treats a wired engine with zero measured prompts as no-data", () => {
    const views = buildEngineViews(
      insights({ perEngine: [engineRow({ promptsMeasured: 0, brandMentions: [] })] }),
    );
    const chatgpt = views.find((v) => v.engine === "chatgpt");
    expect(chatgpt?.status).toBe("no-data");
    expect(chatgpt?.causeLine).toContain("no usable answers this run");
  });

  it("leads the engine scores with percentages and keeps the counts in the explainer (fix 3 / CD-J1)", () => {
    const [chatgpt] = buildEngineViews(insights());
    // Highest mention count sorts first (QA Fix 2 amendment) — Rival (6) before Acme (3).
    expect(chatgpt.brands.map((b) => b.name)).toEqual(["Rival", "Acme"]);
    // Brand rows stay counts: they are the raw series the bars encode, read against
    // one denominator the card states once — not a score each (CD-J1 directive 2).
    expect(chatgpt.brands[0].line).toBe("named in 6 of 10 answers");
    // The two SCORES are percentages…
    expect(chatgpt.stats.map((s) => s.value)).toEqual(["20%", "10%", "10%"]);
    // …and the honest denominator moved into the explainer rather than vanishing.
    expect(chatgpt.stats[1].explainer).toContain("1 of 10 category answers");
    expect(chatgpt.stats[2].explainer).toContain("1 of 10 category answers");
  });

  it("only surfaces ghost citations when the rate is above zero", () => {
    const base = engineRow();
    const [withGhost] = buildEngineViews(
      insights({
        perEngine: [{ ...base, category: { ...base.category!, ghostCitationRate: 33.3 } }],
      }),
    );
    expect(withGhost.ghost?.label).toBe("linked but not named · 33% of your citations");
    const [without] = buildEngineViews(insights());
    expect(without.ghost).toBeNull();
  });

  it("reads the ghost chip from the category denominator, not the full set (F10)", () => {
    // The chip sits in the same card as "cited as a source: N of M", which is
    // category-only. Feeding it the full-set rate is how the card contradicted itself.
    const base = engineRow();
    const [view] = buildEngineViews(
      insights({
        perEngine: [
          { ...base, ghostCitationRate: 80, category: { ...base.category!, ghostCitationRate: 0 } },
        ],
      }),
    );
    expect(view.ghost).toBeNull();
  });
});

describe("score views + context line (fixes 2 + 3)", () => {
  it("separates the score from its coverage and words the engine disclosure", () => {
    const [seo, readiness, visibility] = buildScoreViews(insights());
    expect(seo.coverageLine).toBe("measured 75% of checks");
    expect(readiness.coverageLine).toBe("measured 94% of checks");
    // From `perEngine` (one row, measured), NOT from the stored 3-of-5 the fixture
    // still carries — see the note on those fields. The headline above this line
    // and this line are now one derivation, so they cannot contradict each other.
    // Singular denominator, singular noun: the fixture has exactly one engine row
    // and this line read "1 of 1 AI engines" until the noun was made to agree.
    expect(visibility.coverageLine).toBe("based on 1 of 1 AI engine");
    expect(visibility.explainer).toContain("Based on the 1 of 1 engine we ");
    expect(visibility.coveragePct).toBe(100);
  });

  it("renders absent data as null values, never a zero grade", () => {
    const views = buildScoreViews(
      insights({ seoDataCoveragePct: 0, geoVisibilityEnginesScored: 0, perEngine: [] }),
    );
    expect(views[0].value).toBeNull();
    expect(views[0].bandLabel).toBe("not measured yet");
    expect(views[2].value).toBeNull();
    // No engine ROWS, which is not the same claim as "every engine came back
    // empty" — that state still reads "no engines measured this run" and keeps a
    // real denominator ("0 of 2"). Pinned in stale-claims-visibility-coverage.
    expect(views[2].bandLabel).toBe("no engine data in this snapshot");
  });

  /**
   * Regression: the "AI visibility today" tile once showed 37/100 next to a
   * "Score by engine" breakdown of ChatGPT 23% / Gemini 26% / Claude 25% — an
   * arithmetic mean of 25, not 37 — because the headline read a stored
   * `geoVisibilityIndex` field frozen at capture time while the breakdown below
   * it recomputed live from `insights.perEngine` on every render. A snapshot
   * captured under an older scoring formula silently drifted the two apart.
   * The headline must now always equal calculateOverallVisibilityScore() of the
   * exact per-engine numbers rendered in its own breakdown, never the stored
   * field on its own.
   */
  it("derives the headline from its own breakdown's scores, not a stale stored index", () => {
    const gemini = engineRow({
      engine: "gemini",
      source: "Gemini",
      mentionRate: 0.4,
      citationRate: 0.2,
      firstPositionRate: 0.2,
      shareOfVoice: 30,
      netSentiment: 0.5,
      category: {
        promptsMeasured: 10,
        mentionRate: 0.4,
        citationRate: 0.2,
        firstPositionRate: 0.2,
        shareOfVoice: 30,
        netSentiment: 0.5,
        ghostCitationRate: 0,
        topCompetitor: null,
        brandMentions: [],
      },
    });
    const claude = engineRow({
      engine: "claude",
      source: "Anthropic",
      mentionRate: 0.35,
      citationRate: 0.15,
      firstPositionRate: 0.15,
      shareOfVoice: 25,
      netSentiment: 0.2,
      category: {
        promptsMeasured: 10,
        mentionRate: 0.35,
        citationRate: 0.15,
        firstPositionRate: 0.15,
        shareOfVoice: 25,
        netSentiment: 0.2,
        ghostCitationRate: 0,
        topCompetitor: null,
        brandMentions: [],
      },
    });
    const data = insights({
      geoVisibilityIndex: 99, // deliberately stale/wrong — must never be trusted directly
      perEngine: [engineRow(), gemini, claude],
    });
    const [, , visibility] = buildScoreViews(data);
    const mean = calculateOverallVisibilityScore(
      visibility.breakdown.map((b) => b.pct).filter((pct): pct is number => pct !== null),
    );
    expect(visibility.value).toBe(mean);
    expect(visibility.value).not.toBe(99);
  });

  it("bands scores at the existing 40/70 thresholds", () => {
    expect(scoreBand(39).tone).toBe("danger");
    expect(scoreBand(40).tone).toBe("warning");
    expect(scoreBand(69).tone).toBe("warning");
    expect(scoreBand(70).tone).toBe("success");
  });

  /** Two days after the fixture's capture, so the relative age is deterministic. */
  const NOW = Date.UTC(2026, 6, 14);

  /**
   * Renamed: this was "answers 'why only 3 models'", from when the fixture carried
   * a three-engine roster. It carries one engine now, so what it actually pins is
   * the whole strip — date, relative age, question count, engine coverage — and
   * that the coverage noun agrees with a denominator of one.
   */
  it("states date, age, question count and engine coverage in the context line", () => {
    expect(buildContextLine(insights(), NOW)).toBe(
      "Snapshot from July 12, 2026 (2 days ago) · 2 real buyer questions · 1 of 1 AI engine measured",
    );
  });

  it("keeps the strip's nouns agreeing with their own counts", () => {
    const one = insights({ promptSet: ["best fintech tool for startups"] });
    expect(buildContextLine(one, NOW)).toBe(
      "Snapshot from July 12, 2026 (2 days ago) · 1 real buyer question · 1 of 1 AI engine measured",
    );
    const many = insights({
      perEngine: [engineRow({ engine: "chatgpt" }), engineRow({ engine: "gemini" })],
    });
    expect(buildContextLine(many, NOW)).toContain("2 of 2 AI engines measured");
  });

  /** QA F23: a rejected capture substitutes an empty prompt set, and the counts
   *  were interpolated into three separate sentences with no guard. */
  it("says the capture didn't complete instead of claiming zero questions", () => {
    const degraded = insights({ promptSet: [], geoVisibilityEnginesScored: 0 });
    expect(capturedNothing(degraded)).toBe(true);
    expect(buildContextLine(degraded, NOW)).toBe(
      "Snapshot from July 12, 2026 (2 days ago) · AI answer capture did not complete this run",
    );
    expect(buildContextLine(degraded, NOW)).not.toContain("0 real buyer questions");
  });

  it("treats a normal run as captured", () => {
    expect(capturedNothing(insights())).toBe(false);
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

  /* ── CD-J1 directive 2: percentage headline, denominators in the popup ── */

  it("leads with a percentage and keeps the fraction for the popup", () => {
    const view = buildPresence(insights());
    expect(view.brand.pctLabel).toBe("100%"); // 2 of 2
    expect(view.category.pctLabel).toBe("13%"); // 1 of 8
    expect(view.category.detail.lines[0]).toBe(
      "We asked 8 questions that buyers ask about your category, without naming you.",
    );
    expect(view.category.detail.lines[1]).toBe("You were named in 1 of them.");
  });

  it("discloses the questions no engine answered instead of shrinking the denominator", () => {
    const view = buildPresence(
      insights({ categoryPresence: { named: 1, measured: 8, total: 12 } }),
    );
    // Rate is over what came back — a client is not marked down for our engine
    // failures — but the four missing questions are stated, not deleted.
    expect(view.category.pctLabel).toBe("13%");
    expect(view.category.detail.lines[2]).toContain("4 more questions were part of this snapshot");
    expect(view.category.detail.lines[2]).toContain("not measured rather than counted against you");
  });

  it("says nothing about unmeasured questions on a complete run", () => {
    const view = buildPresence(insights({ categoryPresence: { named: 1, measured: 8, total: 8 } }));
    expect(view.category.detail.lines).toHaveLength(2);
  });

  it("reads a legacy bucket with no `measured` by its own rules", () => {
    const view = buildPresence(insights({ categoryPresence: { named: 3, total: 12 } }));
    expect(view.category.pctLabel).toBe("25%");
    expect(view.category.detail.lines).toHaveLength(2); // no invented shortfall
  });

  it("labels the roster share as category-only (CD-J1 directive 3)", () => {
    const share = buildPresence(insights()).rosterShare;
    expect(share?.caption).toContain("Measured on category questions only");
    expect(share?.explainer).toContain("Questions that name you are left out");
  });

  /** QA F17: the chip is driven by the persisted per-prompt intent — the same
   *  classifier the comparison itself uses — not a display-name string match. */
  it("tags the questions the comparison actually excludes", () => {
    const views = buildPromptViews(
      insights({
        promptSet: ["best fintech tool for startups", "Is Acme legit?", "Acme alternatives", "acme.com"],
        intentPrompts: [
          { prompt: "best fintech tool for startups", intent: "discovery" },
          { prompt: "Is Acme legit?", intent: "brand" },
          // A stored row from before the classifier's brand-before-comparison fix
          // (lib/seo-geo.ts's classifyIntent now tags a fresh "Acme alternatives"
          // capture "brand", not "comparison" — the asker already named Acme). The
          // presenter renders whatever intent is stored, so a legacy "comparison"
          // row still reads as in the like-for-like comparison, no chip.
          { prompt: "Acme alternatives", intent: "comparison" },
          // Bare domain: the pipeline counts it as naming you; the old name match missed it.
          { prompt: "acme.com", intent: "navigational" },
        ],
      }),
    );
    expect(views.map((p) => p.tagLabel)).toEqual([null, "mentions you", null, "mentions you"]);
    expect(views[1].tagExplainer).toContain("like-for-like");
  });

  it("keeps the chip count equal to brandPresence.total on a partial run", () => {
    // Two branded prompts, only one of which any engine answered. brandPresence
    // counts measured prompts only, so an unmeasured branded row must not wear a chip.
    const data = insights({
      promptSet: ["Is Acme legit?", "Acme reviews"],
      intentPrompts: [
        { prompt: "Is Acme legit?", intent: "brand" },
        { prompt: "Acme reviews", intent: "brand" },
      ],
      answerGrid: [
        {
          prompt: "Is Acme legit?",
          intent: "brand",
          cells: [{ engine: "chatgpt", source: "OpenAI", tier: "MEASURED", state: "named" }],
        },
        {
          prompt: "Acme reviews",
          intent: "brand",
          cells: [{ engine: "chatgpt", source: null, tier: "UNAVAILABLE", state: "unavailable" }],
        },
      ],
      brandPresence: { named: 1, total: 1 },
    });
    const chips = buildPromptViews(data).filter((p) => p.tagLabel).length;
    expect(chips).toBe(data.brandPresence.total);
  });

  it("stays silent rather than guessing when a snapshot has no stored intents", () => {
    const tags = buildPromptViews(insights({ intentPrompts: [] })).map((p) => p.tagLabel);
    expect(tags).toEqual([null, null]);
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

describe("answer grid (QA F12)", () => {
  const grid = () =>
    insights({
      answerGrid: [
        {
          prompt: "best fintech tool for startups",
          intent: "discovery",
          cells: [
            { engine: "chatgpt", source: "OpenAI", tier: "MEASURED", state: "named_first" },
            { engine: "gemini", source: "Gemini", tier: "MEASURED", state: "absent" },
            { engine: "claude", source: null, tier: "UNAVAILABLE", state: "unavailable" },
          ],
        },
        {
          prompt: "Is Acme legit?",
          intent: "brand",
          cells: [
            { engine: "chatgpt", source: "OpenAI", tier: "MEASURED", state: "cited_not_named" },
            { engine: "gemini", source: "Gemini", tier: "MEASURED", state: "named" },
            { engine: "claude", source: null, tier: "UNAVAILABLE", state: "unavailable" },
          ],
        },
      ],
    });

  const rowsOf = (v: ReturnType<typeof buildAnswerGridViews>) =>
    (v?.groups ?? []).flatMap((g) => g.rows);

  it("maps every cell state through plain English and keeps the panel's engine order", () => {
    const view = buildAnswerGridViews(grid())!;
    // Claude answered nothing this run → no empty column.
    expect(view.engines.map((e) => e.name)).toEqual(["ChatGPT", "Gemini"]);
    const rows = rowsOf(view);
    expect(rows.find((r) => r.prompt === "best fintech tool for startups")!.cells.map((c) => c.label)).toEqual([
      "Named first",
      "Not named",
    ]);
    expect(rows.find((r) => r.prompt === "Is Acme legit?")!.cells.map((c) => c.label)).toEqual([
      "Used your site, didn't name you",
      "Named",
    ]);
  });

  it("groups rows under plain-English intent headings, category questions first", () => {
    const view = buildAnswerGridViews(grid())!;
    expect(view.groups.map((g) => g.intentLabel)).toEqual([
      "Category questions",
      "Questions that name you",
    ]);
  });

  it("never leaks a raw cell state or intent code", () => {
    const rendered = JSON.stringify(buildAnswerGridViews(grid()));
    for (const token of ["named_first", "cited_not_named", "unavailable", "DISC", "BRAND", "MEASURED"]) {
      expect(rendered).not.toContain(token);
    }
    expect(buildAnswerGridViews(grid())!.groups[1].intentLabel).toBe("Questions that name you");
  });

  it("keeps rows with an unrecognized intent instead of dropping them", () => {
    const view = buildAnswerGridViews(
      insights({
        answerGrid: [
          {
            prompt: "q",
            intent: "mystery" as never,
            cells: [{ engine: "chatgpt", source: "OpenAI", tier: "MEASURED", state: "named" }],
          },
        ],
      }),
    )!;
    expect(view.groups.map((g) => g.intentLabel)).toEqual(["Other questions"]);
    expect(JSON.stringify(view)).not.toContain("mystery");
  });

  it("maps an unknown state to 'not measured' instead of echoing it", () => {
    const weird = insights({
      answerGrid: [
        {
          prompt: "q",
          intent: "discovery",
          cells: [
            { engine: "chatgpt", source: "OpenAI", tier: "MEASURED", state: "vibes" as never },
            { engine: "gemini", source: "Gemini", tier: "MEASURED", state: "named" },
          ],
        },
      ],
    });
    const view = buildAnswerGridViews(weird)!;
    expect(rowsOf(view)[0].cells[0].label).toBe("Not measured");
    expect(JSON.stringify(view)).not.toContain("vibes");
  });

  it("returns null when there is no grid, or nothing was measured", () => {
    expect(buildAnswerGridViews(insights({ answerGrid: [] }))).toBeNull();
    expect(
      buildAnswerGridViews(
        insights({
          answerGrid: [
            {
              prompt: "q",
              intent: "discovery",
              cells: [{ engine: "chatgpt", source: null, tier: "UNAVAILABLE", state: "unavailable" }],
            },
          ],
        }),
      ),
    ).toBeNull();
  });
});

describe("question typography + grouping (QA F18)", () => {
  it("quotes every question and adds a mark only to the ones that ask one", () => {
    expect(formatPrompt("Is Acme legit")).toBe("“Is Acme legit?”");
    expect(formatPrompt("what is the best fintech app")).toBe("“what is the best fintech app?”");
    expect(formatPrompt("How do I compare providers?")).toBe("“How do I compare providers?”");
    // The deterministic fallback set deliberately contains bare keyword strings
    // and a bare domain — "karoslabs.com?" would be a new defect, not a fix.
    expect(formatPrompt("Top-rated dental clinics")).toBe("“Top-rated dental clinics”");
    expect(formatPrompt("karoslabs.com")).toBe("“karoslabs.com”");
    expect(formatPrompt("Acme alternatives")).toBe("“Acme alternatives”");
  });

  it("groups the fallback list by intent, in display order", () => {
    const groups = buildIntentPromptViews(
      insights({
        promptSet: ["best fintech app", "Is Acme legit?", "acme.com"],
        intentPrompts: [
          { prompt: "Is Acme legit?", intent: "brand" },
          { prompt: "acme.com", intent: "navigational" },
          { prompt: "best fintech app", intent: "discovery" },
        ],
      }),
    );
    expect(groups.map((g) => g.intentLabel)).toEqual([
      "Category questions",
      "Questions that name you",
      "People looking for your site",
    ]);
    expect(groups[0].prompts.map((p) => p.text)).toEqual(["best fintech app"]);
  });

  it("falls back to one unlabelled group when nothing is tagged", () => {
    const groups = buildIntentPromptViews(insights({ intentPrompts: [] }));
    expect(groups).toHaveLength(1);
    expect(groups[0].intentLabel).toBe("");
    expect(groups[0].prompts).toHaveLength(2);
  });
});

describe("snapshot age + the promised next snapshot (QA F20)", () => {
  const CAPTURED = Date.UTC(2026, 4, 12); // 2026-05-12, the PDF's example
  const stale = () => insights({ capturedAt: CAPTURED });
  const NOW = Date.UTC(2026, 6, 14);

  it("humanizes the date instead of emitting a machine string", () => {
    expect(formatCaptured(CAPTURED)).toBe("May 12, 2026");
    expect(formatCaptured(Number.NaN)).toBe("an earlier run");
  });

  it("says how old the snapshot is, and flags it once it is stale", () => {
    expect(snapshotAge(CAPTURED, NOW)).toMatchObject({ label: "2 months ago", stale: true });
    expect(snapshotAge(Date.UTC(2026, 6, 13), NOW)).toMatchObject({ label: "yesterday", stale: false });
    expect(snapshotAge(NOW, NOW)).toMatchObject({ label: "today", stale: false });
    expect(snapshotAge(Number.NaN, NOW)).toBeNull();
  });

  it("warns on the capture strip once the snapshot passes the staleness threshold", () => {
    expect(buildCaptureStrip(stale(), {}, NOW).tone).toBe("warning");
    expect(buildCaptureStrip(insights(), {}, NOW).tone).toBe("neutral");
    expect(buildCaptureStrip(stale(), {}, NOW).line).toContain("2 months ago");
  });

  it("prints the real next-snapshot date when a schedule will actually fire", () => {
    const view = buildCaptureStrip(
      stale(),
      { scheduleEnabled: true, nextRunAt: Date.UTC(2026, 7, 1) },
      NOW,
    );
    expect(view.nextLine).toBe("Next snapshot: August 1, 2026");
    expect(view.scheduleFlagPrefill).toBeNull();
    expect(view.noScheduleLine).toBeNull();
  });

  it("offers the ask-us-to-schedule route when no refresh will ever fire", () => {
    // The monthly schedule never fires for a client whose admin never enabled it,
    // so the report ages silently forever while promising a "next snapshot".
    for (const opts of [{}, { scheduleEnabled: false, nextRunAt: Date.UTC(2026, 7, 1) }, { scheduleEnabled: true, nextRunAt: null }]) {
      const view = buildCaptureStrip(stale(), opts, NOW);
      expect(view.nextLine).toBeNull();
      expect(view.noScheduleLine).toContain("won't update on its own");
      expect(view.scheduleFlagPrefill?.subject).toContain("schedule regular");
      expect(view.scheduleFlagPrefill?.message).toContain("May 12, 2026");
    }
  });

  it("reports an in-place refreshing state while a run holds the lock", () => {
    expect(buildCaptureStrip(stale(), { refreshing: true }, NOW).refreshing).toBe(true);
    expect(buildCaptureStrip(stale(), {}, NOW).refreshing).toBe(false);
  });
});

describe("snapshot trust (CD-B4)", () => {
  // "Current" now means all three: the scoring pipeline, the question methodology,
  // and per-engine data that actually carries the category scope (CD-J1 bounce 2a).
  // One stamp cannot speak for the others — a snapshot can share today's maths and
  // still have been measured on a variable-sized question set.
  const current = (patch: Partial<SeoGeoInsights> = {}) =>
    insights({
      pipelineVersion: SEO_GEO_PIPELINE_VERSION,
      methodologyVersion: SEO_GEO_METHODOLOGY_VERSION,
      ...patch,
    });

  it("treats a snapshot from the current pipeline as current", () => {
    const view = buildSnapshotTrust(current());
    expect(view.isLegacy).toBe(false);
    expect(view.title).toBeNull();
    expect(view.description).toBeNull();
  });

  it("marks an unstamped snapshot legacy — every capture predating the stamp", () => {
    const view = buildSnapshotTrust(insights({ capturedAt: Date.UTC(2026, 4, 12) }));
    expect(view.isLegacy).toBe(true);
    expect(view.description).toContain("May 12, 2026");
    expect(view.description).toContain("before we rebuilt how visibility is measured");
  });

  it("marks a snapshot from a superseded pipeline version legacy", () => {
    // Captured AFTER the 2026-07-23 redeploy, so the wording drops the
    // "before we rebuilt" framing — but a stale stamp still means legacy.
    const view = buildSnapshotTrust(
      insights({ pipelineVersion: "2020-01-01", capturedAt: Date.UTC(2026, 6, 26) }),
    );
    expect(view.isLegacy).toBe(true);
    expect(view.description).toContain("has changed since this snapshot");
    expect(view.description).not.toContain("before we rebuilt");
  });

  it("generalizes F1's plan guard instead of running beside it", () => {
    // The narrow condition (gaps but no plan) is one reason inside this view now.
    expect(buildSnapshotTrust(current({ gaps: [gap()], recommendations: [] })).planPending).toBe(true);
    expect(buildSnapshotTrust(current({ gaps: [], recommendations: [] })).planPending).toBe(false);
    expect(
      buildSnapshotTrust(
        current({
          gaps: [gap()],
          recommendations: [
            { recId: "SEO-02", title: "t", description: "d", owner: "o", vertical: "SEO", impact: "high", actionKind: "one_click", targetPlatform: "site", live: true },
          ],
        }),
      ).planPending,
    ).toBe(false);
  });

  it("never narrates product history at the client", () => {
    for (const view of [
      buildSnapshotTrust(insights({ capturedAt: Date.UTC(2026, 4, 12) })),
      buildSnapshotTrust(insights({ pipelineVersion: "2020-01-01" })),
    ]) {
      const text = `${view.title} ${view.description}`;
      expect(text).not.toContain("plain English");
      expect(text).not.toContain("started writing");
    }
  });
});

describe("flag prefills (fix 4)", () => {
  it("attaches the no-data prefill to unmeasured engine views only", () => {
    const views = buildEngineViews(insights({ perEngine: [engineRow({ promptsMeasured: 0, brandMentions: [] })] }));
    const chatgpt = views.find((v) => v.engine === "chatgpt");
    const claude = views.find((v) => v.engine === "claude");
    const measured = buildEngineViews(insights()).find((v) => v.engine === "chatgpt");
    expect(chatgpt?.flagPrefill?.subject).toBe("Question about ChatGPT in our AI visibility snapshot");
    expect(claude?.flagPrefill?.subject).toBe("Question about Claude in our AI visibility snapshot");
    expect(measured?.flagPrefill).toBeNull();
  });

  it("never offers to add an engine we don't track (CD-B2)", () => {
    // engineFlagPrefill / unwiredRequestPrefill existed only to request Perplexity
    // and Copilot coverage; with those out of the set the request is meaningless.
    const rendered = JSON.stringify(buildEngineViews(insights({ perEngine: [] })));
    expect(rendered).not.toContain("Request: measure");
    expect(rendered).not.toContain("not yet measured");
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
    // CD-B3: both sides of the fraction are category answers, and the copy says so.
    expect(views[0].line).toBe("named in 4 of 12 category answers");
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

/* ── CD-J1 directive 4: roster sanity (staff-only, never mutating) ── */

/* ── CD-J1 bounce 2: label a legacy snapshot, never relabel it ────── */

describe("measurement basis", () => {
  /** A pre-CD-B3 record: real numbers, but no category scope on them. */
  const unscopedRow = () => {
    const row = engineRow();
    delete (row as Partial<PerEngineVisibility>).category;
    return row;
  };
  const legacy = (patch: Partial<SeoGeoInsights> = {}) =>
    insights({ perEngine: [unscopedRow()], ...patch });
  const modern = (patch: Partial<SeoGeoInsights> = {}) =>
    insights({
      pipelineVersion: SEO_GEO_PIPELINE_VERSION,
      methodologyVersion: SEO_GEO_METHODOLOGY_VERSION,
      ...patch,
    });

  it("calls unscoped figures what they are, never 'category'", () => {
    const basis = buildMeasurementBasis(legacy());
    expect(basis.categoryScoped).toBe(false);
    expect(basis.answers).toBe("answers");
    expect(basis.questions).not.toContain("category");
  });

  it("claims the category scope only when the record carries it", () => {
    const basis = buildMeasurementBasis(modern());
    expect(basis.categoryScoped).toBe(true);
    expect(basis.answers).toBe("category answers");
  });

  it("stops the engine card claiming a category denominator it doesn't have", () => {
    // The live defect: "named in 4 of 16 answers … the same 16 unbranded category
    // buyer questions", where 16 was the FULL prompt count wearing a category label.
    const [view] = buildEngineViews(legacy());
    expect(view.explainer).not.toContain("category");
    expect(view.stats[1].explainer).toContain("of 10 answers");
    expect(view.stats[1].explainer).not.toContain("category answers");

    const [scoped] = buildEngineViews(modern());
    expect(scoped.explainer).toContain("unbranded category buyer questions");
    expect(scoped.stats[1].explainer).toContain("category answers");
  });

  it("stops the discovered-brand line mislabelling the all-answers denominator", () => {
    // The live defect: "cited in 11 of 60 category answers", where 60 was every
    // probe across every engine.
    const [view] = buildDiscoveredViews(
      legacy({
        citationSummary: { totalMeasuredAnswers: 60, answersCited: 11, answersNamed: 0, ghostCitations: 0 },
        discoveredBrands: [{ name: "NewRival", mentions: 11, perEngine: [] }],
      }),
    );
    expect(view.line).toBe("named in 11 of 60 answers");
  });

  it("marks a snapshot legacy for an old methodology even when the pipeline matches", () => {
    // Same maths, variable-sized question set — the totals still aren't comparable.
    const view = buildSnapshotTrust(insights({ pipelineVersion: SEO_GEO_PIPELINE_VERSION }));
    expect(view.isLegacy).toBe(true);
    expect(view.description).toContain("Question counts also differed");
  });

  it("marks a structurally-unscoped snapshot legacy whatever it is stamped with", () => {
    const view = buildSnapshotTrust(modern({ perEngine: [unscopedRow()] }));
    expect(view.isLegacy).toBe(true);
    expect(view.description).toContain("cover every question we asked");
  });

  it("does not call a failed capture an earlier measurement setup", () => {
    // No engines returned anything, so there is no scope claim either way — the
    // capture strip explains that, and a second wrong story would contradict it.
    const view = buildSnapshotTrust(modern({ perEngine: [] }));
    expect(view.isLegacy).toBe(false);
  });

  it("states the v2 split in words, including the branded count", () => {
    const line = buildQuestionPlanLine(
      modern({
        promptSet: Array.from({ length: 20 }, (_, i) => `q${i}`),
        categoryPresence: { named: 1, measured: 16, total: 16 },
        brandPresence: { named: 4, measured: 4, total: 4 },
      }),
    );
    expect(line).toContain("20 questions");
    expect(line).toContain("16 about your category");
    expect(line).toContain("4 that name you directly");
  });

  it("does not claim a fixed plan for a snapshot measured without one", () => {
    const line = buildQuestionPlanLine(legacy({ promptSet: ["a", "b", "c"] }));
    expect(line).toContain("3 buyer questions");
    expect(line).toContain("varied between snapshots");
    expect(line).not.toContain("We ask 3 questions on every snapshot");
  });

  it("labels each question group as category or branded", () => {
    const groups = buildIntentPromptViews(
      insights({
        intentPrompts: [
          { prompt: "best fintech tool for startups", intent: "discovery" },
          { prompt: "Is Acme legit?", intent: "brand" },
        ],
      }),
    );
    expect(groups.map((g) => g.basisLabel)).toEqual(["category", "names you"]);
  });
});

describe("citation copy: absent is not zero (CD-J1 bounce 3)", () => {
  const noSummary = () => {
    const data = insights();
    delete (data as Partial<SeoGeoInsights>).citationSummary;
    return data;
  };

  it("does not report a measurement failure for a snapshot that never carried the data", () => {
    // The live contradiction: this line claimed "we couldn't measure any answers
    // this run" on the same page as "3 of 5 AI engines measured". The engines line
    // was a fact; this one was a missing field impersonating one.
    const view = buildCitationView(noSummary());
    expect(view.clientLine).toContain("before we started recording");
    expect(view.clientLine).not.toContain("couldn't measure");
    expect(view.emptyLine).toContain("predates our record");
  });

  it("still reports a real measured zero as a real measured zero", () => {
    const view = buildCitationView(
      insights({
        citationSummary: { totalMeasuredAnswers: 0, answersCited: 0, answersNamed: 0, ghostCitations: 0 },
      }),
    );
    expect(view.clientLine).toContain("couldn't measure any");
  });

  it("scopes its noun to what the snapshot actually measured", () => {
    const summary = { totalMeasuredAnswers: 60, answersCited: 11, answersNamed: 4, ghostCitations: 7 };
    const scoped = buildCitationView(
      insights({
        citationSummary: summary,
        pipelineVersion: SEO_GEO_PIPELINE_VERSION,
        methodologyVersion: SEO_GEO_METHODOLOGY_VERSION,
      }),
    );
    expect(scoped.clientLine).toContain("11 of 60 category answers");

    const unscopedRow = engineRow();
    delete (unscopedRow as Partial<PerEngineVisibility>).category;
    const legacy = buildCitationView(insights({ citationSummary: summary, perEngine: [unscopedRow] }));
    expect(legacy.clientLine).toContain("11 of 60 answers");
    expect(legacy.clientLine).not.toContain("category");
  });
});

describe("roster sanity", () => {
  /** Engines named NewRival; the tracked list is somebody else entirely. */
  const measured = (patch: Partial<SeoGeoInsights> = {}) =>
    insights({
      citationSummary: { totalMeasuredAnswers: 12, answersCited: 0, answersNamed: 0, ghostCitations: 0 },
      competitorsNamed: [],
      discoveredBrands: [{ name: "NewRival", url: "newrival.com", mentions: 7, perEngine: [] }],
      ...patch,
    });

  it("flags a tracked set that shares nobody with the brands the engines named", () => {
    const verdict = buildRosterSanity(measured(), [{ name: "Ghost Co" }, { name: "Absent Ltd" }]);
    expect(verdict?.noOverlap).toBe(true);
    expect(verdict?.trackedCount).toBe(2);
    expect(verdict?.headline).toContain("None of the 2 tracked competitors appear");
    expect(verdict?.suggestions).toEqual(["NewRival"]);
    expect(verdict?.detail).toContain("Consider tracking: NewRival");
  });

  it("stays silent when a tracked competitor IS named", () => {
    // One real overlap is enough: the comparison is measuring the right market.
    expect(
      buildRosterSanity(
        measured({ competitorsNamed: [{ name: "Ghost Co", mentions: 2 }] }),
        [{ name: "Ghost Co" }],
      ),
    ).toBeNull();
  });

  it("counts an overlap the discovery pass found, not just the frozen roster", () => {
    expect(buildRosterSanity(measured(), [{ name: "NewRival", url: "newrival.com" }])).toBeNull();
  });

  it("gives no verdict on a run with nothing measured", () => {
    // A degraded capture is not evidence of a bad roster.
    expect(buildRosterSanity(insights(), [{ name: "Ghost Co" }])).toBeNull();
  });

  it("gives no verdict when the engines named nobody at all", () => {
    expect(
      buildRosterSanity(measured({ discoveredBrands: [] }), [{ name: "Ghost Co" }]),
    ).toBeNull();
  });

  it("falls back to the snapshot roster when the page has no tracked list", () => {
    // insights().roster is ["Acme", "Rival"] — Rival was never named.
    const verdict = buildRosterSanity(measured());
    expect(verdict?.trackedCount).toBe(1);
    expect(verdict?.headline).toContain("None of the 1 tracked competitor appear");
  });

  it("never proposes a brand that is already tracked", () => {
    const verdict = buildRosterSanity(
      measured({
        discoveredBrands: [
          { name: "NewRival", url: "newrival.com", mentions: 7, perEngine: [] },
          { name: "Other Co", mentions: 3, perEngine: [] },
        ],
      }),
      [{ name: "Ghost Co" }],
    );
    expect(verdict?.suggestions).toEqual(["NewRival", "Other Co"]);
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
