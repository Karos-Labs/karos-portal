import { describe, expect, it } from "vitest";

import {
  buildContextLine,
  buildEngineViews,
  buildScoreViews,
  capturedNothing,
  engineCoverage,
} from "@/components/seo-geo/presenter";
import { computeVisibilityIndex, type PerEngineVisibility, type SeoGeoInsights } from "@/lib/seo-geo";

/**
 * QA #123 — THE AI-VISIBILITY TILE MUST NOT CONTRADICT ITSELF.
 *
 * 682e188 moved the headline score onto live data (`computeVisibilityIndex` over
 * `insights.perEngine`, the same array the "Score by engine" rows are drawn
 * from) and left every sentence about its COVERAGE on the frozen
 * `geoVisibilityEnginesScored` / `geoVisibilityEnginesTotal` fields the snapshot
 * was written with. A snapshot captured under an older scoring formula therefore
 * printed a real score directly above "based on 0 of 5 AI engines", or the words
 * "no engines measured this run" directly above "based on 4 of 5 AI engines".
 *
 * HOW THIS IS ASKED. Every fixture below is DELIBERATELY CONTRADICTORY: its
 * stored pair disagrees with its own `perEngine` array, which is what a legacy
 * snapshot looks like on disk. The expected numbers are then re-derived in this
 * file FROM THE ARRAY — the argument the presenter was handed — rather than
 * copied from the presenter or pinned as literals, so the rule under test is
 * "the tile answers to the run it is rendering", not "the tile emits this
 * string". A presenter that read the stored fields for any one of these
 * surfaces fails here whichever way the two disagree, and `storedContradicts`
 * fails the fixture itself if a later edit makes it consistent and turns the
 * whole file into a tautology.
 *
 * THREE SURFACES, NAMED. `coverageLine` is the sentence under the meter — the
 * one a client reads without doing anything. `explainer` is the InfoTip beside
 * the tile's label, which carries the same claim in different words and is
 * exactly the kind of second copy that stays stale while the visible surface
 * gets fixed. `buildContextLine` is the capture strip a few centimetres above
 * the tile, making the same claim a third time. All three are asserted, and the
 * strip and the tooltip are asserted AGAINST the visible line rather than
 * against a literal, so they cannot drift apart in either direction.
 */

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
 * What the RUN says, re-derived here from the array alone: an engine counts when
 * it came back at all and answered at least one category question — the same two
 * conditions `computeVisibilityIndex` applies via `categoryMetrics`, restated
 * from the run contract rather than imported, so a change to the scoring rule
 * has to be made in both places on purpose.
 */
function liveFromArray(perEngine: PerEngineVisibility[]): { scored: number; total: number } {
  const scored = perEngine.filter(
    (e) =>
      e.captureTier !== "UNAVAILABLE" &&
      (e.category ? e.category.promptsMeasured : e.promptsMeasured) > 0,
  ).length;
  return { scored, total: perEngine.length };
}

/** Fails the FIXTURE, not the code, if it stops posing the question. */
function storedContradicts(data: SeoGeoInsights) {
  const live = liveFromArray(data.perEngine);
  expect(
    [data.geoVisibilityEnginesScored, data.geoVisibilityEnginesTotal],
    "fixture no longer contradicts itself, so it can no longer catch a stored read",
  ).not.toEqual([live.scored, live.total]);
  return live;
}

const pairFrom = (text: string, label: string): [number, number] => {
  const m = text.match(/(\d+) of (\d+)/);
  expect(m, `no "N of M" fraction in the ${label}: ${JSON.stringify(text)}`).not.toBeNull();
  return [Number(m![1]), Number(m![2])];
};

/** Every engine claim the panel makes about one snapshot, in one place. */
function readTile(data: SeoGeoInsights) {
  const view = buildScoreViews(data)[2]!;
  expect(view.key, "third score tile is no longer the visibility tile").toBe("visibility");
  return {
    view,
    coverage: pairFrom(view.coverageLine, "coverage line under the meter"),
    tooltip: pairFrom(view.explainer, "InfoTip explainer beside the tile label"),
    strip: pairFrom(buildContextLine(data, Date.UTC(2026, 6, 14)), "capture strip"),
  };
}

/**
 * An engine that came back and answered NOTHING in the category set.
 *
 * ⚠️ THIS FIXTURE ALSO CARRIES A LIVE CONTRADICTION THE TILE ASSERTIONS BELOW DO
 * NOT SEE — see "pins a known contradiction" at the bottom of this file. The word
 * "measured" has two derivations on this page: `buildEngineViews` calls this row
 * measured on `row.promptsMeasured > 0`, `computeVisibilityIndex` refuses it on
 * `categoryMetrics(e).promptsMeasured === 0`. So the client gets a green "measured"
 * chip on a full Claude card sitting directly above "based on 2 of 3 AI engines".
 * Pre-existing, deliberately not fixed here (see that test), named here so the next
 * reader of this fixture cannot walk past it the way the first one did.
 */
const brandedOnlyEngine: SeoGeoInsights = insights({
  geoVisibilityEnginesScored: 3,
  geoVisibilityEnginesTotal: 3,
  perEngine: [
    engineRow({ engine: "chatgpt" }),
    engineRow({ engine: "gemini" }),
    engineRow({
      engine: "claude",
      category: { ...engineRow().category!, promptsMeasured: 0 },
    }),
  ],
});

describe("the AI-visibility tile against a snapshot whose stored coverage is stale (QA #123)", () => {
  const cases: Array<{ name: string; data: SeoGeoInsights }> = [
    {
      // The headline-over-zero case: stored says nothing was measured, the run
      // measured two engines and the big number is real.
      name: "stored 0 of 5, two engines actually scored",
      data: insights({
        geoVisibilityEnginesScored: 0,
        geoVisibilityEnginesTotal: 5,
        perEngine: [
          engineRow({ engine: "chatgpt" }),
          engineRow({ engine: "gemini" }),
          engineRow({ engine: "claude", captureTier: "UNAVAILABLE" }),
        ],
      }),
    },
    {
      // The mirror image: stored says four of five, every engine in the run
      // failed, so the band reads "no engines measured this run".
      name: "stored 4 of 5, no engine came back",
      data: insights({
        geoVisibilityEnginesScored: 4,
        geoVisibilityEnginesTotal: 5,
        perEngine: [
          engineRow({ engine: "chatgpt", captureTier: "UNAVAILABLE" }),
          engineRow({ engine: "gemini", captureTier: "UNAVAILABLE" }),
        ],
      }),
    },
    {
      // Not a capture failure but a scope one: the engine answered, and answered
      // nothing in the category set, so it scores nothing. Same predicate the
      // index uses, which is the point — a coverage count derived from "engines
      // that returned something" would pass the two cases above and fail here.
      name: "stored 3 of 3, one engine answered only branded questions",
      data: brandedOnlyEngine,
    },
  ];

  it.each(cases)("counts the run, not the snapshot's stored pair — $name", ({ data }) => {
    const live = storedContradicts(data);
    const { coverage } = readTile(data);

    expect(coverage).toEqual([live.scored, live.total]);
  });

  it.each(cases)("says the same thing on all three surfaces — $name", ({ data }) => {
    storedContradicts(data);
    const { coverage, tooltip, strip } = readTile(data);

    // Asserted against the visible line, so a fix applied to one surface and not
    // the others cannot pass: the tooltip once carried a stale copy of exactly
    // this claim while the line beneath the meter was live.
    expect(tooltip, "InfoTip disagrees with the coverage line").toEqual(coverage);
    expect(strip, "capture strip disagrees with the coverage line").toEqual(coverage);
  });

  it.each(cases)("keeps score, band and coverage telling one story — $name", ({ data }) => {
    storedContradicts(data);
    const { view, coverage } = readTile(data);
    const [scored, total] = coverage;

    // The contradiction as a client meets it: a number over "0 of N", or "no
    // engines measured this run" over "4 of 5". Both directions, one assertion
    // each way round.
    expect(view.value === null, "a headline score above a zero-engine coverage line").toBe(
      scored === 0,
    );
    expect(view.bandLabel === "no engines measured this run").toBe(scored === 0);
    // The rows drawn underneath the sentence ARE the engines the sentence
    // counts — the strongest form of "one derivation", since the two cannot be
    // separated by any amount of copy editing.
    expect(view.breakdown).toHaveLength(scored);
    expect(view.coveragePct).toBe(total > 0 ? Math.round((scored / total) * 100) : 0);
    expect(scored, "a coverage line claiming more engines than the run had").toBeLessThanOrEqual(
      total,
    );
  });

  it("still reads a snapshot whose stored pair happens to be right", () => {
    // The guard must not be "never agrees with the stored fields": on a current
    // snapshot the two agree, and the tile has to say so.
    const data = insights({
      geoVisibilityEnginesScored: 2,
      geoVisibilityEnginesTotal: 3,
      perEngine: [
        engineRow({ engine: "chatgpt" }),
        engineRow({ engine: "gemini" }),
        engineRow({ engine: "claude", captureTier: "UNAVAILABLE" }),
      ],
    });
    const live = liveFromArray(data.perEngine);
    expect([data.geoVisibilityEnginesScored, data.geoVisibilityEnginesTotal]).toEqual([
      live.scored,
      live.total,
    ]);

    const { view, coverage, tooltip, strip } = readTile(data);
    expect(coverage).toEqual([2, 3]);
    expect(tooltip).toEqual([2, 3]);
    expect(strip).toEqual([2, 3]);
    expect(view.coverageLine).toBe("based on 2 of 3 AI engines");
    expect(view.breakdown).toHaveLength(2);
  });

  /**
   * PINS A KNOWN OPEN CONTRADICTION. Not introduced by the #123 fix and not fixed
   * here: reconciling the two predicates changes what a client sees on an engine
   * card, which is the owner's call, not this test's.
   *
   * Two derivations of one word, one layer above #123:
   *   `buildEngineViews` (src/components/seo-geo/presenter.ts) — measured when
   *     `row.captureTier !== "UNAVAILABLE" && row.promptsMeasured > 0`
   *   `computeVisibilityIndex` (src/lib/seo-geo.ts) — scored when
   *     `captureTier !== "UNAVAILABLE" && categoryMetrics(e).promptsMeasured > 0`
   * An engine that answered only branded questions satisfies the first and fails
   * the second, so the page renders a green "measured" chip on a full Claude card
   * a few centimetres above a tile that counts two engines out of three. The card
   * is one of the three and is not one of the two, and nothing on screen says why.
   *
   * If you deliberately changed `buildEngineViews`, update this assertion and close
   * the finding. If it broke by accident, the two surfaces have drifted again.
   */
  it("pins a known contradiction: an engine the cards call measured and the tile does not count", () => {
    const claude = buildEngineViews(brandedOnlyEngine).find((v) => v.engine === "claude")!;
    const { coverage } = readTile(brandedOnlyEngine);

    expect(claude.status, "the engine card no longer calls this engine measured").toBe("measured");
    expect(claude.statusTone, "the chip is the success-toned one a client reads as good").toBe(
      "success",
    );
    expect(coverage, "the tile no longer excludes it from its count").toEqual([2, 3]);
  });
});

/**
 * The word after the fraction, and the total it has to agree with. Read
 * generically so this asks "does the noun match its own count", not "does this
 * surface contain this string".
 */
function nounAfterFraction(text: string, label: string): { total: number; noun: string } {
  const m = text.match(/(\d+) of (\d+) (?:AI )?(\w+)/);
  expect(m, `no "N of M <noun>" in the ${label}: ${JSON.stringify(text)}`).not.toBeNull();
  return { total: Number(m![2]), noun: m![3]! };
}

const NOW = Date.UTC(2026, 6, 14);

/** Every surface that renders the engine pair, keyed by what a client calls it. */
function coverageSurfaces(data: SeoGeoInsights): Array<[string, string]> {
  const view = buildScoreViews(data)[2]!;
  return [
    ["coverage line under the meter", view.coverageLine],
    ["InfoTip explainer beside the tile label", view.explainer],
    ["capture strip above the tile", buildContextLine(data, NOW)],
    ["band label on the tile", view.bandLabel],
  ];
}

describe("the engine pair reads like a person wrote it", () => {
  /**
   * `engineCoverage` defaulting its denominator to `perEngine.length` made
   * single-engine snapshots newly reachable, and every surface said "1 of 1 AI
   * engines". Asserted as grammatical number against the surface's own total, so
   * this equally catches the over-correction — a snapshot with two engines that
   * starts saying "2 of 2 AI engine".
   */
  it.each([
    { name: "one engine", perEngine: [engineRow({ engine: "chatgpt" })] },
    {
      name: "two engines",
      perEngine: [engineRow({ engine: "chatgpt" }), engineRow({ engine: "gemini" })],
    },
    {
      name: "one engine, and it came back empty",
      perEngine: [engineRow({ engine: "chatgpt", captureTier: "UNAVAILABLE" })],
    },
  ])("agrees the noun with its own denominator — $name", ({ perEngine }) => {
    for (const [label, text] of coverageSurfaces(insights({ perEngine }))) {
      if (!/\d+ of \d+/.test(text)) continue; // the band label carries no fraction
      const { total, noun } = nounAfterFraction(text, label);
      expect(noun.endsWith("s"), `${label} says "… of ${total} ${noun}"`).toBe(total !== 1);
    }
  });
});

describe("engineCoverage against a result its own callers cannot produce", () => {
  /**
   * `engineCoverage` used to document that "scored can never exceed total". That
   * was true of this file's two call sites — both leave `computeVisibilityIndex`'s
   * `enginesTotal` to default to `perEngine.length` — and false of the type it
   * accepts. `src/lib/intel/seo-geo.ts` already passes an explicit total
   * (`ENGINE_ROSTER.length`), so a result with an independent denominator is a
   * normal thing for this codebase to build — it agrees with the default there
   * only because the same roster builds `perEngine` two lines earlier.
   *
   * These go through the real `computeVisibilityIndex` rather than a hand-built
   * object, so they assert what the presenter would actually be handed, and they
   * fail if `seo-geo.ts` is fixed upstream — at which point the clamp is
   * redundant and can go, deliberately, rather than by accident.
   */
  const rows = [
    engineRow({ engine: "chatgpt" }),
    engineRow({ engine: "gemini" }),
    engineRow({ engine: "claude" }),
  ];

  it("never prints a numerator larger than the rows drawn beneath it", () => {
    // Three engines scored against a roster the caller declared as one.
    const live = computeVisibilityIndex(rows, 1);
    expect(live.enginesScored, "upstream stopped producing scored > total").toBeGreaterThan(
      live.enginesTotal,
    );

    const cov = engineCoverage(live);
    expect(cov.scored, "the count in the sentence is the count of rows on screen").toBe(
      live.perEngineScore.length,
    );
    expect(cov.scored).toBeLessThanOrEqual(cov.total);
    expect(cov.pct).toBeLessThanOrEqual(100);
  });

  it("keeps the meter on the same denominator as the fraction beside it", () => {
    // computeVisibilityIndex returns `enginesTotal || live.length` but divides
    // dataCoveragePct by the RAW parameter, so an explicit 0 hands the presenter
    // {scored: 3, total: 3, pct: 0} — "3 of 3" beside an empty meter.
    const live = computeVisibilityIndex(rows, 0);
    expect(
      [live.enginesScored, live.enginesTotal, live.dataCoveragePct],
      "upstream stopped returning two denominators in one result",
    ).toEqual([3, 3, 0]);

    const cov = engineCoverage(live);
    expect(cov.pct, "the meter still answers to a denominator the sentence never states").toBe(
      Math.round((cov.scored / cov.total) * 100),
    );
  });
});

describe("a snapshot carrying no engine rows at all", () => {
  /**
   * The `?? []` that made `computeVisibilityIndex` safe over a missing array made
   * this state reachable, and the tile met it with "based on 0 of 0 AI engines" —
   * a fraction over a zero denominator that also claims we attempted nothing. The
   * stored pair it replaced said "0 of 5": we asked five and got none. The
   * replacement was a WORSE statement than the bug, so neither is acceptable; the
   * only true thing here is that the snapshot carries no engine data.
   *
   * Reachable: `src/lib/seo-geo-import.ts` requires `perEngine` to be an array and
   * never a non-empty one, and `capturedNothing` — which does guard the capture
   * strip's question count — does not catch it, since a snapshot can carry a full
   * prompt set and no engine rows.
   */
  const noRows = insights({ perEngine: [] });

  it("is not caught by the capture-failed guard, so the tile has to handle it", () => {
    expect(capturedNothing(noRows)).toBe(false);
  });

  it("never prints a fraction on any surface", () => {
    for (const [label, text] of coverageSurfaces(noRows)) {
      expect(text, `${label} still prints an N-of-M fraction`).not.toMatch(/\d+ of \d+/);
    }
  });

  it("keeps the four surfaces telling one story", () => {
    const view = buildScoreViews(noRows)[2]!;
    const strip = buildContextLine(noRows, NOW);

    expect(view.value, "a headline score with no engines behind it").toBeNull();
    expect(view.breakdown, "engine rows drawn under a tile that has no engine rows").toHaveLength(
      0,
    );
    expect(view.coveragePct, "a coverage meter filled from a denominator that does not exist").toBe(
      0,
    );
    // The strip a few centimetres above must make the SAME statement as the line
    // under the meter — asserted against each other, not against literals.
    expect(strip, "capture strip disagrees with the coverage line").toContain(view.coverageLine);
  });

  it("does not say the same thing as a run whose engines all came back empty", () => {
    // The distinction being defended, in both directions. "We asked two and got
    // nothing" keeps its real denominator; "we have no rows" must not invent one.
    const cameBackEmpty = insights({
      perEngine: [
        engineRow({ engine: "chatgpt", captureTier: "UNAVAILABLE" }),
        engineRow({ engine: "gemini", captureTier: "UNAVAILABLE" }),
      ],
    });
    const absent = buildScoreViews(noRows)[2]!;
    const empty = buildScoreViews(cameBackEmpty)[2]!;

    expect(absent.value).toBeNull();
    expect(empty.value).toBeNull();
    expect(empty.coverageLine, "an engine that answered nothing stopped being counted").toContain(
      "0 of 2",
    );
    expect(absent.coverageLine).not.toBe(empty.coverageLine);
    expect(absent.bandLabel).not.toBe(empty.bandLabel);
    expect(buildContextLine(noRows, NOW)).not.toBe(buildContextLine(cameBackEmpty, NOW));
  });
});
