/**
 * SEO/GEO panel presenter — pure view-model builders (SCRUM-52).
 *
 * Everything client-facing renders through this module so the run-record's
 * internal vocabulary (fix_action opcodes, delivery routes, confidence enums,
 * capture tiers, rec ids) can never leak into the UI: every enum passes
 * through a CLOSED lookup with an explicit plain-English default, never
 * `map[value] ?? value`. Unit-tested in src/lib/__tests__/seo-geo-presenter.test.ts.
 *
 * No React in here: pure data in, serializable strings/numbers out, so the
 * client components that consume these views stay free of domain imports and
 * vitest can test the mappings without a DOM.
 */
import { MANAGED_PRODUCTS } from "@/lib/agent-service/products";
import { competitorBrandKeys } from "@/lib/competitor-input";
import {
  ENGINE_LABELS,
  GEO_READINESS_CHECKS,
  REC_COPY,
  SEO_CHECKS,
  SEO_GEO_METHODOLOGY_VERSION,
  SEO_GEO_PIPELINE_VERSION,
  SNAPSHOT_TRUST_CUTOFF,
  brandKeys,
  categoryMetrics,
  computeCheckScore,
  computeVisibilityIndex,
  dedupeGapsByRecId,
  intentBasis,
  normalizeBrandKey,
  presenceCounts,
  resolveRecCopy,
  type EngineId,
  type Lever,
  type RecImpact,
  type Recommendation,
  type SeoGeoInsights,
  type SubMetrics,
  type VisibilityGap,
  type VisibilityIndexResult,
} from "@/lib/seo-geo";
import type { ManagedTaskType } from "@/lib/types";

export type Tone = "success" | "warning" | "danger" | "info" | "neutral";

/**
 * A currently-tracked competitor (the sidebar's tracked-5), passed by the page
 * so every panel surface renders THE SAME competitors as the Competitor Track —
 * side by side with the sidebar, never the frozen snapshot's roster alone.
 * `url` drives the brand favicon.
 */
export interface TrackedCompetitorRef {
  name: string;
  url?: string;
}

/** All identity keys for a tracked ref (name-derived + url-derived; tolerates
 *  legacy rows whose display name is a raw pasted URL). */
const refKeys = (t: TrackedCompetitorRef) => competitorBrandKeys(t.name, t.url);

/** First map hit across any of the brand's identity keys. */
function lookupByKeys<T>(map: Map<string, T>, keys: string[]): T | undefined {
  for (const k of keys) {
    const hit = map.get(k);
    if (hit !== undefined) return hit;
  }
  return undefined;
}

/* ── Score tiles ──────────────────────────────────────────────────── */

export interface BreakdownRow {
  label: string;
  /** 0–100 sub-score over measured checks, or null when nothing measured. */
  pct: number | null;
  /** Coverage note shown muted next to the bar, if any. */
  note: string | null;
}

export interface ScoreView {
  key: "seo" | "readiness" | "visibility";
  label: string;
  explainer: string;
  /** null renders as an em-free placeholder: data absent is not a zero. */
  value: number | null;
  tone: Tone;
  bandLabel: string;
  coveragePct: number;
  coverageLine: string;
  breakdownTitle: string;
  breakdown: BreakdownRow[];
}

export function scoreBand(score: number): { label: string; tone: Tone } {
  if (score >= 70) return { label: "strong", tone: "success" };
  if (score >= 40) return { label: "developing", tone: "warning" };
  return { label: "needs attention", tone: "danger" };
}

/** Closed bucket-id → client label map; unknown buckets get a safe generic. */
const BUCKET_LABELS: Record<string, string> = {
  eligibility: "Search eligibility",
  technicalCwv: "Speed and stability",
  onPage: "On-page content",
  structure: "Content structure",
  crawlerAccess: "AI crawler access",
  extractability: "Answer extractability",
  evidenceDensity: "Evidence and citations",
  freshness: "Content freshness",
  multimodal: "Media and alt text",
  indexReach: "Search index reach",
  offsiteEntity: "Off-site reputation",
};

export function bucketLabel(bucket: string): string {
  return BUCKET_LABELS[bucket] ?? "Other checks";
}

function checkBreakdown(registry: typeof SEO_CHECKS, checks: SeoGeoInsights["seoChecks"]): BreakdownRow[] {
  return computeCheckScore(registry, checks).buckets.map((b) => ({
    label: bucketLabel(b.bucket),
    pct: b.measuredWeight ? Math.round((b.earned / b.measuredWeight) * 100) : null,
    note:
      b.measuredWeight === 0
        ? "not measured yet"
        : b.measuredWeight < b.weight
          ? "partly measured"
          : null,
  }));
}

/**
 * "N of M AI engines", off the SAME `computeVisibilityIndex` RESULT the headline
 * score was read from — the whole point being that a caller cannot hand this the
 * live index and the stored coverage pair at the same time (QA #123).
 *
 * The headline went live in 682e188 while every sentence describing its coverage
 * stayed on the frozen `geoVisibilityEnginesScored` / `geoVisibilityEnginesTotal`
 * fields, so a snapshot captured under an older scoring formula printed a real
 * score directly above "based on 0 of 5 AI engines", or "no engines measured this
 * run" directly above "based on 4 of 5 AI engines". Same shape as the bug the
 * comment in buildScoreViews describes, one line further down the tile.
 *
 * THE INVARIANT, AS IT ACTUALLY HOLDS. Taking the RESULT OBJECT rather than the
 * insights record is what keeps it closed: engine numbers may come from a
 * `computeVisibilityIndex` result and from nowhere else — re-reading the stored
 * fields "for the denominator" is exactly what re-opens the bug. It is NOT
 * "derived exactly once per render", and this docstring used to say so:
 * `buildContextLine` runs the derivation a second time for the capture strip,
 * which sits above the tile and makes the same claim. That second call is safe
 * for a different reason, and it is the reason worth keeping —
 * `visibilityFromSnapshot` below is the SINGLE EXPRESSION in this module that maps
 * a snapshot to these numbers, and it is pure over `insights.perEngine`, so two
 * invocations on one snapshot cannot disagree. Add a second such expression and
 * the guarantee is gone; the call count is not what protects it.
 *
 * WHAT IT DOES NOT TRUST. `enginesScored` counts the engines inside
 * `perEngineScore`, so the numerator is exactly the number of rows the tile draws
 * underneath the sentence — a client can count them. The denominator is not
 * equally safe, and the old claim that "scored can never exceed total" was true of
 * this file's two call sites, not of the type:
 *   - `enginesTotal` is a roster size only when the caller leaves
 *     `computeVisibilityIndex`'s default (`perEngine.length`). Both call sites here
 *     do. `src/lib/intel/seo-geo.ts` passes `ENGINE_ROSTER.length` explicitly —
 *     harmless today only because it maps that same roster to build `perEngine`, so
 *     the explicit total equals the default. Nothing holds it there, and
 *     `computeVisibilityIndex(rows, N)` with `N < rows.length` returns scored > total.
 *   - the returned `enginesTotal` falls back to `live.length` (`enginesTotal ||
 *     live.length`) while `dataCoveragePct` divides by the RAW parameter, so an
 *     explicit `0` yields `{scored: 3, total: 3, pct: 0}` — one result object
 *     carrying two different denominators, which is the #123 shape in miniature.
 * So: the denominator is clamped to at least the number of scored rows on screen,
 * and the percentage is recomputed from the pair this function prints. The meter
 * and the sentence beneath it are one derivation whatever the caller passed.
 *
 * NO ROWS AT ALL is a different statement from no engine ANSWERING, and the tile
 * must not merge them. `perEngine: []` is reachable (an imported bundle only has to
 * carry an array — src/lib/seo-geo-import.ts), and it used to read "based on 0 of 0
 * AI engines", which says we attempted nothing; two UNAVAILABLE rows honestly read
 * "0 of 2", we asked two and got none. `fraction` is null in the no-rows state and
 * every surface says the snapshot carries no engine data rather than print a
 * fraction over zero.
 *
 * EXPORTED FOR ONE REASON: neither call site in this file can produce the
 * divergent result described above, because both leave `enginesTotal` to default.
 * Left private, the clamp and the recomputed percentage would be unenforceable —
 * every assertion this module can make about them passes equally with them
 * deleted, which is precisely how a stated mechanism stops being in force. The
 * signature is unchanged and still refuses an insights record, so this does not
 * reopen #123: a caller must still hand it a `computeVisibilityIndex` result.
 * Pinned in src/lib/__tests__/stale-claims-visibility-coverage.test.ts.
 */
export function engineCoverage(live: VisibilityIndexResult): {
  scored: number;
  total: number;
  pct: number;
  /** "2 of 3"; null when the snapshot has no engine rows and no fraction is honest. */
  fraction: string | null;
  /** Agrees with the TOTAL, so a one-engine snapshot never says "1 of 1 engines". */
  engineNoun: "engine" | "engines";
} {
  const scored = live.enginesScored;
  const total = Math.max(live.enginesTotal, scored);
  return {
    scored,
    total,
    pct: total > 0 ? Math.round((scored / total) * 100) : 0,
    fraction: total > 0 ? `${scored} of ${total}` : null,
    engineNoun: total === 1 ? "engine" : "engines",
  };
}

/**
 * The one expression in this module that turns a snapshot into visibility numbers
 * — see engineCoverage. Pure over `insights.perEngine`, which is what lets the
 * tile and the capture strip agree without sharing a call.
 */
function visibilityFromSnapshot(insights: SeoGeoInsights): {
  live: VisibilityIndexResult;
  coverage: ReturnType<typeof engineCoverage>;
} {
  const live = computeVisibilityIndex(insights.perEngine ?? []);
  return { live, coverage: engineCoverage(live) };
}

/** What every surface says when the snapshot carries no engine rows at all. */
const NO_ENGINE_DATA = {
  band: "no engine data in this snapshot",
  line: "no AI engine data in this snapshot",
  sentence: "This snapshot carries no AI engine data.",
} as const;

export function buildScoreViews(insights: SeoGeoInsights): ScoreView[] {
  const seoBand = scoreBand(insights.seoScore);
  const geoBand = scoreBand(insights.geoReadiness);
  // The headline is derived LIVE from insights.perEngine — the exact same array
  // and the exact same per-engine scores the "Score by engine" breakdown below
  // renders — rather than trusted from the stored geoVisibilityIndex field. A
  // persisted snapshot's index was computed by whatever scoring formula was live
  // at capture time and then frozen; the breakdown below has always been
  // recomputed fresh on every render. On a snapshot captured under an older
  // formula version those two silently diverged (bug: headline "37" next to
  // engine cards "23% / 26% / 25%", whose mean is 25, not 37). Deriving both
  // from one computeVisibilityIndex call makes that contradiction structurally
  // impossible: the big number is always calculateOverallVisibilityScore() of
  // the same rounded integers shown in the cards beneath it.
  // Every engine number on this tile — the band, the meter, the sentence under
  // it and the tooltip — comes off this one result. See engineCoverage.
  const { live: liveVisibility, coverage: visCoverage } = visibilityFromSnapshot(insights);
  const visBand = scoreBand(liveVisibility.index);

  const seoMeasured = insights.seoDataCoveragePct > 0;
  const readinessMeasured = insights.geoReadinessCoveragePct > 0;
  const visibilityMeasured = liveVisibility.enginesScored > 0;
  const basis = buildMeasurementBasis(insights);
  // State the denominator (QA F10): the index is scored on the CATEGORY questions,
  // the same set every card and gap below uses — not the full prompt set, which
  // includes the questions that name the client and hit by construction.
  const categoryCount = insights.categoryPresence?.total ?? 0;
  // A snapshot with NO engine rows says so, rather than printing "0 of 0", which
  // claims a measurement attempt that never happened. See engineCoverage.
  const noEngineData = visCoverage.fraction === null;
  /** The explainer's coverage sentence: "can" on a current snapshot, "could" on a legacy one. */
  const coverageSentence = (verb: "can" | "could") =>
    noEngineData
      ? NO_ENGINE_DATA.sentence
      : `Based on the ${visCoverage.fraction} ${visCoverage.engineNoun} we ${verb} measure.`;

  return [
    {
      key: "seo",
      label: "Search score",
      explainer:
        "How well your site is set up for search engines like Google. We run automated checks on things like page speed, titles, and whether pages can be listed at all. 100 means every check we measured passed.",
      value: seoMeasured ? insights.seoScore : null,
      tone: seoMeasured ? seoBand.tone : "neutral",
      bandLabel: seoMeasured ? seoBand.label : "not measured yet",
      coveragePct: insights.seoDataCoveragePct,
      coverageLine: `measured ${insights.seoDataCoveragePct}% of checks`,
      breakdownTitle: "What's behind this score",
      breakdown: checkBreakdown(SEO_CHECKS, insights.seoChecks),
    },
    {
      key: "readiness",
      label: "AI readiness",
      explainer:
        "How prepared your site is to be read and quoted by AI assistants like ChatGPT. We check whether AI crawlers can reach your pages and whether your content is easy to lift into an answer. 100 means fully prepared.",
      value: readinessMeasured ? insights.geoReadiness : null,
      tone: readinessMeasured ? geoBand.tone : "neutral",
      bandLabel: readinessMeasured ? geoBand.label : "not measured yet",
      coveragePct: insights.geoReadinessCoveragePct,
      coverageLine: `measured ${insights.geoReadinessCoveragePct}% of checks`,
      breakdownTitle: "What's behind this score",
      breakdown: checkBreakdown(GEO_READINESS_CHECKS, insights.geoChecks),
    },
    {
      key: "visibility",
      label: "AI visibility today",
      // CD-J1 bounce 2b: only claim the category scope when the record carries it.
      explainer: basis.categoryScoped
        ? `How often AI assistants actually name or recommend you right now, when we ask them the ${categoryCount || "real"} category questions that don't mention your brand, the questions new customers ask. ${coverageSentence("can")} This is the number the fixes below are designed to move.`
        : `How often AI assistants actually named or recommended you on this snapshot, measured across all the buyer questions we asked, including the ones naming your brand, which is why it isn't comparable with a current snapshot. ${coverageSentence("could")}`,
      value: visibilityMeasured ? liveVisibility.index : null,
      tone: visibilityMeasured ? visBand.tone : "neutral",
      // Already live (`visibilityMeasured` is liveVisibility.enginesScored > 0);
      // it was the coverage line beneath it that still read the frozen pair, which
      // is how "no engines measured this run" came to sit above "based on 4 of 5
      // AI engines". Both now answer to the same count. The two zero states are
      // NOT the same sentence: engines that came back empty were measured and
      // scored nothing; no rows at all means the snapshot never carried any.
      bandLabel: visibilityMeasured
        ? visBand.label
        : noEngineData
          ? NO_ENGINE_DATA.band
          : "no engines measured this run",
      coveragePct: visCoverage.pct,
      coverageLine: noEngineData
        ? NO_ENGINE_DATA.line
        : `based on ${visCoverage.fraction} AI ${visCoverage.engineNoun}`,
      breakdownTitle: "Score by engine",
      // Same perEngineScore array the headline above was averaged from
      // (calculateOverallVisibilityScore) — the tile and its own breakdown can
      // no longer drift onto two different numbers for the same run.
      breakdown: liveVisibility.perEngineScore.map((e) => ({
        label: ENGINE_LABELS[e.engine] ?? "Engine",
        pct: e.score,
        note: null,
      })),
    },
  ];
}

/* ── Capture context ──────────────────────────────────────────────── */

/**
 * QA F20: this emitted a raw machine date ("2026-05-12") straight into client copy.
 * Fixed locale + UTC so the string is deterministic (server-rendered, and pinned by
 * tests) rather than drifting with the render host.
 */
export function formatCaptured(capturedAt: number): string {
  if (!Number.isFinite(capturedAt)) return "an earlier run";
  return new Date(capturedAt).toLocaleDateString("en-US", {
    month: "long",
    day: "numeric",
    year: "numeric",
    timeZone: "UTC",
  });
}

const DAY_MS = 86_400_000;
/** Past this, a snapshot is old enough that the panel says so (monthly cadence + slack). */
export const SNAPSHOT_STALE_DAYS = 45;

/** Relative age of a snapshot, in the client's language. Null when undateable. */
export function snapshotAge(capturedAt: number, now = Date.now()): { days: number; label: string; stale: boolean } | null {
  if (!Number.isFinite(capturedAt)) return null;
  const days = Math.max(0, Math.floor((now - capturedAt) / DAY_MS));
  const months = Math.round(days / 30);
  const label =
    days === 0
      ? "today"
      : days === 1
        ? "yesterday"
        : days < 45
          ? `${days} days ago`
          : months < 2
            ? "about a month ago"
            : months < 12
              ? `${months} months ago`
              : "over a year ago";
  return { days, label, stale: days >= SNAPSHOT_STALE_DAYS };
}

/**
 * True when the AI answer capture rejected and the pipeline substituted an empty
 * probe set, empty prompt set and a one-name roster (QA F23). The panel renders the
 * full scaffolding against those zeros otherwise — "0 real buyer questions",
 * "excluding the 0 questions that name you directly", "The 0 buyer questions we
 * asked" opening onto an empty box — which reads like the product is broken rather
 * than like one leg of one run degrading.
 */
export function capturedNothing(insights: SeoGeoInsights): boolean {
  return (insights.promptSet?.length ?? 0) === 0;
}

export function buildContextLine(insights: SeoGeoInsights, now = Date.now()): string {
  const age = snapshotAge(insights.capturedAt, now);
  const dated = `Snapshot from ${formatCaptured(insights.capturedAt)}${age ? ` (${age.label})` : ""}`;
  if (capturedNothing(insights)) {
    return `${dated} · AI answer capture did not complete this run`;
  }
  // The capture strip sits a few centimetres above the visibility tile and makes
  // the same claim, so it goes through the same derivation (QA #123). Left on the
  // stored pair it was the third contradiction on the page: a strip saying "4 of 5
  // AI engines measured" over a tile whose own count is 2. This is a second
  // invocation, not a second derivation — see engineCoverage.
  const { coverage } = visibilityFromSnapshot(insights);
  const asked = insights.promptSet.length;
  return [
    dated,
    `${asked} real buyer question${asked === 1 ? "" : "s"}`,
    coverage.fraction
      ? `${coverage.fraction} AI ${coverage.engineNoun} measured`
      : NO_ENGINE_DATA.line,
  ].join(" · ");
}

/* ── Measurement basis (CD-J1 bounce 2) ───────────────────────────── */

export interface MeasurementBasis {
  /** True when this snapshot's per-engine numbers really are category-only. */
  categoryScoped: boolean;
  /** False when no engine returned anything — there is no scope claim either way. */
  hasMeasuredEngines: boolean;
  /** Noun for an answer denominator: "category answers" or plain "answers". */
  answers: string;
  /** Phrase for a question denominator on an engine card. */
  questions: string;
}

/**
 * Is this snapshot's comparison data genuinely scoped to category questions?
 *
 * CD-J1 bounce 2 — LABEL A LEGACY SNAPSHOT, NEVER RELABEL IT. `categoryMetrics`
 * falls back to a record's FULL-set figures when it has no `category` field, which is
 * right (a pre-CD-B3 snapshot still has real numbers) — but every string around it
 * called those numbers "category", so one page showed four denominators that
 * contradicted each other: "20 real buyer questions", "the 12 category questions",
 * "named in 4 of 16 … the same 16 unbranded category buyer questions" (16 being the
 * full prompt count wearing a category label), and "cited in 11 of 60 category
 * answers" (60 being every probe across every engine, same trick).
 *
 * The fallback stays. What changes is that a surface reading it stops CLAIMING a
 * scope the number does not have: unscoped figures are described as what they are,
 * measured over all questions, and the legacy banner says the counts differ.
 *
 * Structural, not just a version string: a record whose measured engines carry no
 * `category` field is unscoped whatever it is stamped with.
 */
export function buildMeasurementBasis(insights: SeoGeoInsights): MeasurementBasis {
  const measured = (insights.perEngine ?? []).filter(
    (e) => e.captureTier !== "UNAVAILABLE" && e.promptsMeasured > 0,
  );
  const categoryScoped = measured.length > 0 && measured.every((e) => e.category !== undefined);
  return {
    categoryScoped,
    hasMeasuredEngines: measured.length > 0,
    answers: categoryScoped ? "category answers" : "answers",
    questions: categoryScoped ? "unbranded category buyer questions" : "buyer questions",
  };
}

/**
 * The methodology in one sentence, for the surfaces that describe how we measure
 * (CD-J1 bounce 2c). v2 snapshots state the split explicitly — the branded count
 * appeared nowhere on screen before this — while a legacy snapshot describes only
 * what it can honestly claim: the set it actually asked.
 */
export function buildQuestionPlanLine(insights: SeoGeoInsights): string {
  const asked = insights.promptSet?.length ?? 0;
  if (insights.methodologyVersion !== SEO_GEO_METHODOLOGY_VERSION) {
    return `We asked ${asked} buyer question${asked === 1 ? "" : "s"} on this snapshot. Question counts varied between snapshots under the older measurement setup.`;
  }
  const cat = presenceCounts(insights.categoryPresence).planned;
  const brand = presenceCounts(insights.brandPresence).planned;
  return `We ask ${asked} questions on every snapshot · ${cat} about your category, and ${brand} that name you directly. Only the ${cat} category questions count toward how you compare with competitors.`;
}

export interface CitationView {
  /** The client's own citation sentence (QA F19 — never gated on there being any). */
  clientLine: string;
  /** What the leaderboard says when it has no rows. */
  emptyLine: string;
}

/**
 * The citation copy, in the presenter so it can be pinned by a test rather than
 * assembled inline in JSX.
 *
 * CD-J1 bounce 3 — ABSENT IS NOT ZERO. Captures from before `citationSummary`
 * existed carry no summary at all. Defaulting that to 0 made the panel report a
 * measurement failure that never happened: "We couldn't measure any answers this
 * run", sitting on the same page as "3 of 5 AI engines measured". One was a fact
 * about the run and the other was a missing field impersonating one. A snapshot
 * that never carried the data now says exactly that.
 */
export function buildCitationView(insights: SeoGeoInsights): CitationView {
  const basis = buildMeasurementBasis(insights);
  const summary = insights.citationSummary;
  if (!summary) {
    return {
      clientLine:
        "This snapshot was taken before we started recording which sources the engines quote, so there is nothing to show here. Your next refresh records it.",
      emptyLine: "This snapshot predates our record of which sources the engines quote.",
    };
  }
  const cited = summary.answersCited;
  const of = summary.totalMeasuredAnswers;
  return {
    clientLine:
      of === 0
        ? `We couldn't measure any ${basis.answers} this run, so there is nothing to count citations against yet.`
        : cited > 0
          ? `Your site was cited as a source in ${cited} of ${of} ${basis.answers} across every engine we measured.`
          : `Your site was never cited as a source in the ${of} ${basis.answers} we measured. Earning citations from these domains' territory is what moves the visibility score.`,
    emptyLine: "No engine cited any source domain on the answers we measured this run.",
  };
}

/* ── Snapshot trust (CD-B4) ───────────────────────────────────────── */

export interface SnapshotTrustView {
  /** Measured under superseded rules — show it as historical, not current. */
  isLegacy: boolean;
  /** Banner heading; null when the snapshot is current. */
  title: string | null;
  /** Banner body; null when the snapshot is current. */
  description: string | null;
  /** No written plan on this snapshot — the action plan renders its waiting state
   *  instead of an empty "nothing to fix", which would be a lie. */
  planPending: boolean;
}

/**
 * CD-B4, generalizing the narrow guard F1 added rather than adding a second
 * mechanism beside it.
 *
 * F1's guard was `recommendations.length === 0 && gaps.length > 0` — one symptom
 * (a snapshot captured before the plan was persisted) of one cause: this snapshot
 * was produced by a pipeline that no longer matches the one describing it. The
 * cause is now the thing we test, via the version stamp, and the missing-plan case
 * is one reason among them. That covers the 2026-07-23/24 redeploy the team
 * flagged, the QA-sweep measurement changes, and every future change that makes
 * old snapshots non-comparable — without a new flag per episode.
 *
 * The copy deliberately does not narrate product history (F1's guard said "before
 * we started writing the plan in plain English", which tells a client about our
 * release schedule). It says what it means for their numbers, and what to do.
 */
export function buildSnapshotTrust(insights: SeoGeoInsights): SnapshotTrustView {
  const planPending =
    (insights.recommendations?.length ?? 0) === 0 && (insights.gaps?.length ?? 0) > 0;
  // CD-J1 bounce 2a: three independent reasons a snapshot is not current, because
  // one stamp cannot speak for all of them. The pipeline stamp covers the scoring
  // changes; the methodology stamp covers the question plan (a snapshot measured on
  // a variable-sized set is not comparable with one measured on the fixed 20, even
  // if the maths matched); and the structural check catches a record whose engines
  // carry no category scope whatever it is stamped with.
  const basis = buildMeasurementBasis(insights);
  const oldPipeline = insights.pipelineVersion !== SEO_GEO_PIPELINE_VERSION;
  const oldMethodology = insights.methodologyVersion !== SEO_GEO_METHODOLOGY_VERSION;
  // Only a snapshot that HAS engine figures can have unscoped ones. A run where
  // every engine failed is a degraded capture, which the capture strip already
  // explains — calling it "an earlier measurement setup" would be a second, wrong
  // story about the same event.
  const unscoped = basis.hasMeasuredEngines && !basis.categoryScoped;
  const isLegacy = oldPipeline || oldMethodology || unscoped;
  if (!isLegacy) return { isLegacy: false, title: null, description: null, planPending };

  const preRedeploy = Number.isFinite(insights.capturedAt) && insights.capturedAt < SNAPSHOT_TRUST_CUTOFF;
  // Say WHICH way the numbers differ, rather than a generic "things changed". The
  // counts are the part a client can see with their own eyes — a legacy snapshot's
  // question totals do not match the fixed plan a current one is measured on, and
  // its comparison figures may cover every question rather than category ones.
  const countsLine = oldMethodology
    ? " Question counts also differed between snapshots back then, so the totals here won't match a current snapshot's."
    : "";
  const scopeLine = unscoped
    ? " Its engine-by-engine figures cover every question we asked, including the ones that name you. Current snapshots measure those on category questions only."
    : "";
  return {
    isLegacy: true,
    title: "These results are from an earlier measurement setup",
    description:
      (preRedeploy
        ? `This snapshot was captured on ${formatCaptured(insights.capturedAt)}, before we rebuilt how visibility is measured. Read the numbers as history rather than your position today. A refresh re-measures everything on the current setup.`
        : "How we measure visibility has changed since this snapshot, so these numbers aren't directly comparable with a current one. A refresh re-measures everything on the current setup.") +
      countsLine +
      scopeLine,
    planPending,
  };
}

/* ── Capture strip (QA F20 / CD-B4) ───────────────────────────────── */

export interface CaptureStripView {
  line: string;
  /** "warning" once the snapshot is past the staleness threshold. */
  tone: Tone;
  /** True while a refresh run holds the workspace lock — an in-place state
   *  instead of a top-of-page banner naming controls the client doesn't have. */
  refreshing: boolean;
  /** "Next snapshot: …" when a schedule is on; null when it will never fire. */
  nextLine: string | null;
  /** Ask-us-to-schedule prefill, when no refresh is scheduled. */
  scheduleFlagPrefill: FlagPrefill | null;
  /** Shown beside the prefill button; explains why we're asking. */
  noScheduleLine: string | null;
}

/**
 * QA F20. Across the report a client is told "we'll retry on the next snapshot",
 * "this is measured on the next snapshot", "we ask every engine the same questions
 * on every snapshot" — while no control on the page produces a next snapshot and no
 * date says when one is due. The snapshot is only ever written by the intel
 * pipeline, which has exactly three entry points: client creation, a staff-only
 * regenerate action, and an admin-only monthly schedule that never fires for a
 * client whose schedule was never switched on. So for those clients the promised
 * next snapshot never happens and the report ages silently forever.
 *
 * This strip says, in one place: how old this snapshot is, whether it is stale,
 * whether a refresh is running right now, and when the next one is due — or, when
 * nothing is scheduled, offers the existing flag-to-team route to ask for one.
 */
export function buildCaptureStrip(
  insights: SeoGeoInsights,
  opts: { scheduleEnabled?: boolean; nextRunAt?: number | null; refreshing?: boolean } = {},
  now = Date.now(),
): CaptureStripView {
  const age = snapshotAge(insights.capturedAt, now);
  const scheduled = !!opts.scheduleEnabled && Number.isFinite(opts.nextRunAt ?? NaN);
  return {
    line: buildContextLine(insights, now),
    tone: age?.stale ? "warning" : "neutral",
    refreshing: !!opts.refreshing,
    nextLine: scheduled ? `Next snapshot: ${formatCaptured(opts.nextRunAt as number)}` : null,
    noScheduleLine: scheduled
      ? null
      : "No refresh is scheduled yet, so this snapshot won't update on its own.",
    scheduleFlagPrefill: scheduled
      ? null
      : {
          subject: "Request: schedule regular search and AI visibility snapshots",
          message: `Our latest snapshot is from ${formatCaptured(insights.capturedAt)}${age ? ` (${age.label})` : ""}. Please set up a regular refresh so it stays current.`,
        },
  };
}

/* ── Engines ──────────────────────────────────────────────────────── */

/** CD-B2: "not-wired" removed — every tracked engine has a provider. */
export type EngineStatus = "measured" | "no-data";

export interface EngineBrandRow {
  name: string;
  isClient: boolean;
  /** Website for the brand favicon (client website / competitor url), if known. */
  url: string | null;
  /** False = tracked now but not present in this snapshot — counts arrive on the next capture. */
  measured: boolean;
  /** Bar width relative to the engine's most-mentioned brand, 0–100. */
  pctOfMax: number;
  line: string;
}

export interface EngineStatView {
  label: string;
  value: string;
  explainer: string;
}

export interface EngineView {
  engine: EngineId;
  name: string;
  status: EngineStatus;
  statusLabel: string;
  statusTone: Tone;
  /** Plain-English measurement note (carries provenance for measured engines). */
  explainer: string;
  /** Why there is no data, for the no-data / not-wired states. */
  causeLine: string | null;
  /** Prefilled flag-to-team dialog content; null for measured engines. */
  flagPrefill: FlagPrefill | null;
  allZero: boolean;
  brands: EngineBrandRow[];
  stats: EngineStatView[];
  ghost: { label: string; explainer: string } | null;
}

/** Display order for every engine surface. CD-B2 removed Perplexity and Copilot. */
const ENGINE_ORDER: EngineId[] = ["chatgpt", "gemini", "claude"];

/** Closed provider → "measured through …" phrase (provenance without badges). */
const PROVIDER_PHRASES: Record<string, string> = {
  OpenAI: "through the OpenAI API",
  Gemini: "through the Google Gemini API",
  Anthropic: "through the Anthropic API",
};

function providerPhrase(source: string | null): string {
  if (!source) return "directly";
  return PROVIDER_PHRASES[source] ?? "through the engine's API";
}

function fraction(count: number, total: number, noun: string): string {
  return `${count} of ${total} ${noun}`;
}

/** A 0..1 rate as a whole-percent headline (CD-J1 directive 2). */
function pct(rate: number): string {
  return `${Math.round(rate * 100)}%`;
}

/**
 * Copy for the one unmeasured state. CD-B2 removed the "not-wired" tier along with
 * Perplexity and Copilot: every tracked engine has a wired provider now, so a
 * permanently-unreachable "we can't measure this yet, flag us to add it" tier would
 * be exactly the dead client-facing surface F7 and F152 exist to prevent.
 */
const UNMEASURED_COPY = {
  "no-data": {
    statusLabel: "no answers this run",
    explainer: (name: string) =>
      `${name} returned no usable answers this run, so it is left out of your scores rather than guessed at.`,
    causeLine: (name: string) =>
      `${name} returned no usable answers this run. We'll retry on the next snapshot.`,
    prefill: noDataFlagPrefill,
  },
} as const;

/**
 * Per-brand comparison rows for one measured engine. When the CURRENT tracked
 * list is supplied, rows are built from it (same competitors as the sidebar,
 * side by side): counts come from the snapshot roster when the competitor was
 * on it, from the discovery pass when the engines named it unprompted, and a
 * "not measured yet" placeholder otherwise. Snapshot brands that are no longer
 * tracked are dropped here and surfaced via buildRosterDrift. Without a tracked
 * list (legacy callers/tests), the frozen snapshot rows render as before.
 */
function buildBrandRows(
  cat: SubMetrics,
  engine: EngineId,
  insights: SeoGeoInsights,
  tracked?: TrackedCompetitorRef[],
  clientWebsite?: string | null,
): EngineBrandRow[] {
  const n = cat.promptsMeasured;
  const clientName = insights.roster[0] ?? cat.brandMentions.find((b) => b.isClient)?.name ?? "";

  interface Draft {
    name: string;
    isClient: boolean;
    url: string | null;
    mentions: number | null;
  }
  let drafts: Draft[];

  if (tracked && tracked.length > 0) {
    // Snapshot rosters store display NAMES only, so the snapshot side is keyed by
    // the name-derived key; each tracked ref probes with ALL its identity keys
    // (name + url) — one-sided keying is the "CTech by Calcalist" bug.
    const snapshot = new Map(
      cat.brandMentions.filter((b) => !b.isClient).map((b) => [normalizeBrandKey(b.name), b.mentions] as const),
    );
    const discovered = new Map<string, NonNullable<SeoGeoInsights["discoveredBrands"]>[number]>();
    for (const d of insights.discoveredBrands ?? []) {
      for (const k of brandKeys(d.name, d.url)) if (!discovered.has(k)) discovered.set(k, d);
    }
    drafts = [
      {
        name: clientName,
        isClient: true,
        url: clientWebsite?.trim() || null,
        mentions: cat.brandMentions.find((b) => b.isClient)?.mentions ?? 0,
      },
      ...tracked.map((t): Draft => {
        const keys = refKeys(t);
        const snap = lookupByKeys(snapshot, keys);
        if (snap !== undefined) return { name: t.name, isClient: false, url: t.url ?? null, mentions: snap };
        const disc = lookupByKeys(discovered, keys);
        if (disc) {
          return {
            name: t.name,
            isClient: false,
            url: t.url ?? disc.url ?? null,
            mentions: disc.perEngine.find((pe) => pe.engine === engine)?.mentions ?? 0,
          };
        }
        return { name: t.name, isClient: false, url: t.url ?? null, mentions: null };
      }),
    ];
  } else {
    drafts = cat.brandMentions.map((b) => ({
      name: b.name,
      isClient: b.isClient,
      url: b.isClient ? clientWebsite?.trim() || null : null,
      mentions: b.mentions,
    }));
  }

  // Measured rows first, highest mention count on top; pending rows sink to the
  // bottom in tracked order (they have no counts to sort by).
  const measured = drafts.filter((d) => d.mentions !== null);
  const pending = drafts.filter((d) => d.mentions === null);
  measured.sort((a, b) => (b.mentions ?? 0) - (a.mentions ?? 0));
  const max = Math.max(1, ...measured.map((d) => d.mentions ?? 0));

  return [
    ...measured.map((d) => ({
      name: d.name,
      isClient: d.isClient,
      url: d.url,
      measured: true,
      pctOfMax: Math.round(((d.mentions ?? 0) / max) * 100),
      line: `named in ${fraction(d.mentions ?? 0, n, "answers")}`,
    })),
    ...pending.map((d) => ({
      name: d.name,
      isClient: d.isClient,
      url: d.url,
      measured: false,
      pctOfMax: 0,
      line: "measured on the next snapshot",
    })),
  ];
}

export function buildEngineViews(
  insights: SeoGeoInsights,
  tracked?: TrackedCompetitorRef[],
  clientWebsite?: string | null,
): EngineView[] {
  const byEngine = new Map(insights.perEngine.map((e) => [e.engine, e]));
  // What these numbers are actually measured over — "category answers" only when
  // the record carries the scope (CD-J1 bounce 2b).
  const basis = buildMeasurementBasis(insights);
  return ENGINE_ORDER.map((engine) => {
    const row = byEngine.get(engine) ?? null;
    const name = ENGINE_LABELS[engine] ?? "Engine";
    const measured = !!row && row.captureTier !== "UNAVAILABLE" && row.promptsMeasured > 0;
    const status: EngineStatus = measured ? "measured" : "no-data";

    if (status !== "measured" || !row) {
      const copy = UNMEASURED_COPY["no-data"];
      return {
        engine,
        name,
        status,
        statusLabel: copy.statusLabel,
        statusTone: "neutral" as Tone,
        explainer: copy.explainer(name),
        causeLine: copy.causeLine(name),
        flagPrefill: copy.prefill(name, insights),
        allZero: true,
        brands: [],
        stats: [],
        ghost: null,
      };
    }

    // Client-vs-competitor comparison uses CATEGORY prompts only — the branded
    // questions name the client by construction and guarantee mentions, which would
    // otherwise inflate every stat here to a near-meaningless number even when every
    // tracked competitor sits at 0 (QA Fix 2 / CD-B3). `categoryMetrics` carries the
    // legacy fallback for snapshots captured before `category` existed on this record,
    // and is the SAME accessor the scoring maths uses, so the tile and these cards
    // can never drift apart again (QA F10).
    const cat: SubMetrics = categoryMetrics(row);
    const n = cat.promptsMeasured;
    const citedCount = Math.round(cat.citationRate * n);
    const firstCount = Math.round(cat.firstPositionRate * n);
    const brands = buildBrandRows(cat, engine, insights, tracked, clientWebsite);
    // pctOfMax > 0 iff mentions > 0, so this is exactly "no measured brand was named".
    const allZero = brands.filter((b) => b.measured).every((b) => b.pctOfMax === 0);

    return {
      engine,
      name,
      status,
      statusLabel: "measured",
      statusTone: "success" as Tone,
      // CD-J1 bounce 2b: `n` comes from categoryMetrics, which falls back to the
      // FULL prompt count on a pre-CD-B3 record. Describe what the number is.
      explainer: `Measured ${providerPhrase(row.source)} by asking the same ${n} ${basis.questions} we ask every engine.`,
      causeLine: null,
      flagPrefill: null,
      allZero,
      brands,
      stats: [
        {
          label: "share of conversation",
          value: `${Math.round(cat.shareOfVoice)}%`,
          explainer:
            "Of every time this engine named you or a tracked competitor in a category question, this is your slice. 50% would mean you get named as often as everyone else combined.",
        },
        // CD-J1 directive 2: these two are SCORES, so the headline is a percentage
        // and the count that produced it moves into the explainer. (The brand rows
        // above stay as counts — they are the raw series the bars encode, read
        // against a denominator this card states once, not one score each.)
        {
          label: "cited as a source",
          value: pct(cat.citationRate),
          explainer: `How often the engine linked to your website as a source for its answer · ${fraction(citedCount, n, basis.answers)}. Being cited means the AI is reading your site, not just remembering your name.`,
        },
        {
          label: "answered first",
          value: pct(cat.firstPositionRate),
          explainer: `When the answer listed brands, how often yours came first · ${fraction(firstCount, n, basis.answers)}. First mention carries the most weight with buyers skimming an answer.`,
        },
      ],
      // F10: `cat.`, not `row.` — the chip sat in the same card as "cited as a
      // source: 0 of 14", which is category-only, and read from the full set.
      ghost:
        cat.ghostCitationRate > 0
          ? {
              label: `linked but not named · ${Math.round(cat.ghostCitationRate)}% of your citations`,
              explainer:
                "The engine used your website as a source but never said your name. Your content is doing the work while your brand stays invisible. Usually fixable with clearer branding on the cited pages.",
            }
          : null,
    };
  });
}

/* ── Presence split + roster share ────────────────────────────────── */

export interface PresenceTile {
  heading: string;
  caption: string;
  /** Honest count line — the denominators, kept for the popup, not the headline. */
  fractionLine: string | null;
  pct: number | null;
  /** The headline: "62%", or null when nothing in this bucket came back. */
  pctLabel: string | null;
  explainer: string;
  emptyLine: string | null;
  /**
   * CD-J1 directive 2 — what the popup says when the client clicks the score.
   * Plain sentences, no ratio arithmetic to do in their head: how many we asked,
   * how many named them, and (only when it happened) how many we couldn't measure.
   */
  detail: {
    title: string;
    lines: string[];
  };
}

export interface PresenceView {
  brand: PresenceTile;
  category: PresenceTile;
  takeaway: string | null;
  rosterShare: {
    value: string;
    pct: number;
    caption: string;
    explainer: string;
  } | null;
}

/**
 * CD-J1 directive 2: the headline is a PERCENTAGE, the denominators live one click
 * away. "Named in 8 of 8 / 0 of 12" asked a client to compare two fractions with
 * different denominators and work out that one is a control and the other is the
 * score. The percentage is the score; the popup is the honesty.
 *
 * The rate is named-over-MEASURED, and the questions we couldn't measure are
 * disclosed in the popup rather than folded into the denominator. Scoring a client
 * down for our engine failures would be as dishonest as the old behaviour of
 * dropping those questions — the difference is that this says so out loud.
 */
function presenceTile(
  bucket: Parameters<typeof presenceCounts>[0],
  copy: { heading: string; caption: string; explainer: string; asked: string; emptyLine: string },
): PresenceTile {
  const { named, measured, notMeasured } = presenceCounts(bucket);
  const pct = measured > 0 ? Math.round((named / measured) * 100) : null;
  const lines = [`We asked ${measured} question${measured === 1 ? "" : "s"} ${copy.asked}.`,
    `You were named in ${named} of them.`];
  if (notMeasured > 0) {
    lines.push(
      `${notMeasured} more ${notMeasured === 1 ? "question was" : "questions were"} part of this snapshot but no engine answered ${notMeasured === 1 ? "it" : "them"}, so ${notMeasured === 1 ? "it is" : "they are"} shown as not measured rather than counted against you.`,
    );
  }
  return {
    heading: copy.heading,
    caption: copy.caption,
    fractionLine: measured > 0 ? `Named in ${fraction(named, measured, "questions")}` : null,
    pct,
    pctLabel: pct === null ? null : `${pct}%`,
    explainer: copy.explainer,
    emptyLine: measured > 0 ? null : copy.emptyLine,
    detail: { title: copy.heading, lines },
  };
}

export function buildPresence(insights: SeoGeoInsights): PresenceView {
  const b = presenceCounts(insights.brandPresence);
  const c = presenceCounts(insights.categoryPresence);
  const competitors = Math.max(0, insights.roster.length - 1);

  const brandRate = b.measured > 0 ? b.named / b.measured : null;
  const catRate = c.measured > 0 ? c.named / c.measured : null;

  let takeaway: string | null = null;
  if (brandRate !== null && catRate !== null) {
    if (brandRate >= 0.5 && catRate < 0.25) {
      takeaway =
        "Engines know who you are, but you're missing from the questions new customers ask. That's the gap the work below closes.";
    } else if (brandRate < 0.5 && catRate < 0.25) {
      takeaway = "Engines rarely name you even when asked directly. Improving your AI readiness comes first.";
    } else if (brandRate >= 0.5 && catRate >= 0.25) {
      takeaway = "You show up both by name and in open category questions. The work below protects that position.";
    } else {
      takeaway =
        "You appear in category questions more often than when buyers ask about you by name. Strengthening your brand signals makes that recognition stick.";
    }
  }

  return {
    brand: presenceTile(insights.brandPresence, {
      heading: "When buyers ask about you by name",
      caption: "questions that mention your brand",
      asked: "that buyers ask about you by name",
      explainer:
        "Questions that mention you by name, like asking whether your brand is any good. Being named here shows the engines know who you are.",
      emptyLine: "We couldn't measure any questions that name you this run.",
    }),
    category: presenceTile(insights.categoryPresence, {
      heading: "When buyers ask about your category",
      caption: "questions that don't mention your name",
      asked: "that buyers ask about your category, without naming you",
      explainer:
        "Questions buyers ask before they know you exist, like asking for the best option in your category. Being named here is how new customers find you. It's the hardest and most valuable place to show up.",
      emptyLine: "No category questions were measured this run.",
    }),
    takeaway,
    rosterShare:
      competitors > 0
        ? {
            value: `${Math.round(insights.rosterSharePct)}%`,
            pct: Math.round(insights.rosterSharePct),
            caption: `of every brand mention across you and the ${competitors} competitor${competitors === 1 ? "" : "s"} we track. Measured on category questions only`,
            // CD-J1 directive 3: state the basis. This is computed on category
            // questions alone; the branded ones name the client by construction,
            // and counting them would be scoring yourself on your own name.
            explainer:
              "Your share of every brand mention across the category answers we measured, counting you and the competitors we track. Questions that name you are left out. Being named in a question about you isn't visibility. It's the single number for how much of the AI conversation you own.",
          }
        : null,
  };
}

/* ── Roster drift + discovered brands ─────────────────────────────── */

export interface RosterDrift {
  /** Tracked now but absent from this snapshot (no counts anywhere) — pending the next capture. */
  added: string[];
  /** Measured in this snapshot but no longer tracked — their bars are dropped from the comparison. */
  removed: string[];
  isStale: boolean;
}

/**
 * Compare the CURRENT tracked list against the snapshot's frozen roster.
 * A tracked competitor covered by the discovery pass is not "added" — it has
 * real measured counts even though it wasn't on the capture roster.
 */
export function buildRosterDrift(insights: SeoGeoInsights, tracked?: TrackedCompetitorRef[]): RosterDrift {
  if (!tracked || tracked.length === 0) return { added: [], removed: [], isStale: false };
  const snapshotKeys = new Set(insights.roster.slice(1).map((n) => normalizeBrandKey(n)));
  const discoveredKeys = new Set(
    (insights.discoveredBrands ?? []).flatMap((d) => brandKeys(d.name, d.url)),
  );
  const trackedKeys = new Set(tracked.flatMap(refKeys));
  const added = tracked
    .filter((t) => !refKeys(t).some((k) => snapshotKeys.has(k) || discoveredKeys.has(k)))
    .map((t) => t.name);
  const removed = insights.roster.slice(1).filter((n) => !trackedKeys.has(normalizeBrandKey(n)));
  return { added, removed, isStale: added.length > 0 || removed.length > 0 };
}

/* ── Roster sanity (CD-J1 directive 4) ────────────────────────────── */

/**
 * Re-resolve every stored plan row's copy through today's REC_COPY (CD-J1 bounce 1).
 *
 * The plan is frozen into the snapshot at capture, so improvements to the copy table
 * only ever reached clients measured afterwards: a July-22 snapshot still served raw
 * engineering labels, and snapshots from the window before the table was complete
 * served a mix of healed and raw rows. Rec ids are stable, so this heals every
 * existing snapshot at render — no re-capture required.
 *
 * Runs at the SERVER boundary rather than inside the client leaf, which is the
 * established rule (wave 1): a client viewer must not RECEIVE an internal string,
 * even one a component would have chosen not to display. Healing here keeps the raw
 * labels out of the RSC payload entirely. Only title and description are touched —
 * impact, vertical, recId and the approval state are the snapshot's own facts.
 */
const IMPACT_RANK: Record<RecImpact, number> = { high: 3, medium: 2, low: 1 };

export function healRecommendations(recommendations: Recommendation[]): Recommendation[] {
  // Dedupe BEFORE healing, and by the same rule `dedupeGapsByRecId` applies to
  // the gaps these rows are built from (src/lib/seo-geo.ts): keep the strongest
  // member, preserve first-seen order, and promote the vertical to "BOTH" when
  // the group disagrees.
  //
  // Why it is needed here at all: a snapshot captured before that dedupe existed
  // persisted two rows for one recId. Healing their copy through today's
  // REC_COPY then made them TEXTUALLY IDENTICAL while they kept contradictory
  // impact and channel chips — the same action listed twice on a client's plan,
  // disagreeing with itself. And because both rows carry the same recId (which
  // is what `approveSeoGeoRecommendation` stores), approving one flipped both.
  const byId = new Map<string, Recommendation>();
  const verticals = new Map<string, Set<Lever>>();
  const order: string[] = [];

  for (const rec of recommendations) {
    const seen = verticals.get(rec.recId) ?? new Set<Lever>();
    seen.add(rec.vertical);
    verticals.set(rec.recId, seen);

    const held = byId.get(rec.recId);
    if (!held) {
      byId.set(rec.recId, rec);
      order.push(rec.recId);
    } else if (IMPACT_RANK[rec.impact] > IMPACT_RANK[held.impact]) {
      byId.set(rec.recId, rec);
    }
  }

  return order.map((recId) => {
    const rec = byId.get(recId)!;
    const seen = verticals.get(recId)!;
    const merged = seen.size > 1 ? { ...rec, vertical: "BOTH" as Lever } : rec;
    return { ...merged, ...resolveRecCopy(merged.recId, merged) };
  });
}

export interface RosterSanity {
  /** The tracked set and the brands the engines actually name share nobody. */
  noOverlap: boolean;
  trackedCount: number;
  /** Named-but-untracked brands, strongest first — a suggestion, never an action. */
  suggestions: string[];
  headline: string;
  detail: string;
}

/**
 * STAFF-ONLY sanity check: does the tracked competitor set intersect the brands
 * the engines actually named this run?
 *
 * A client can be tracking five rivals that no AI answer has ever mentioned. Every
 * comparison then renders honestly and means nothing — five bars at zero, a share
 * of voice computed against opponents who are not in the race, and a report that
 * looks measured while measuring the wrong market. Nothing on the page distinguishes
 * that from "you're losing to these five", which is the reading a client takes.
 *
 * Returns null when there is no verdict to give: nobody tracked, or no measured
 * answers to check against (a degraded run is not evidence of a bad roster).
 *
 * This SUGGESTS and never mutates. The tracked roster is a deliberate account
 * decision — whose competitor set it is matters more than whether it maximises
 * measured overlap — so this puts named-but-untracked brands in front of the team
 * and stops. Client-facing comparisons keep using the tracked roster exactly as
 * chosen; the client never sees this block.
 */
export function buildRosterSanity(
  insights: SeoGeoInsights,
  tracked?: TrackedCompetitorRef[],
): RosterSanity | null {
  const measuredAnswers = insights.citationSummary?.totalMeasuredAnswers ?? 0;
  if (measuredAnswers === 0) return null;

  // The tracked set: the CURRENT list when the page has it, else the frozen roster
  // the capture actually ran against.
  const trackedRefs: TrackedCompetitorRef[] =
    tracked && tracked.length > 0
      ? tracked
      : insights.roster.slice(1).map((name) => ({ name }));
  if (trackedRefs.length === 0) return null;

  // Brands the engines NAMED: tracked competitors with a real count, plus every
  // brand the open discovery pass verified. Both are category-scoped (CD-B3).
  const namedKeys = new Set<string>();
  for (const c of insights.competitorsNamed ?? []) {
    if (c.mentions > 0) for (const k of brandKeys(c.name)) namedKeys.add(k);
  }
  for (const d of insights.discoveredBrands ?? []) {
    for (const k of brandKeys(d.name, d.url)) namedKeys.add(k);
  }
  if (namedKeys.size === 0) return null; // engines named nobody — not a roster verdict

  const overlap = trackedRefs.filter((t) => refKeys(t).some((k) => namedKeys.has(k)));
  if (overlap.length > 0) return null;

  const trackedKeys = new Set(trackedRefs.flatMap(refKeys));
  const suggestions = (insights.discoveredBrands ?? [])
    .filter((d) => !brandKeys(d.name, d.url).some((k) => trackedKeys.has(k)))
    .sort((a, b) => b.mentions - a.mentions)
    .slice(0, 3)
    .map((d) => d.name);

  const n = trackedRefs.length;
  return {
    noOverlap: true,
    trackedCount: n,
    suggestions,
    headline: `None of the ${n} tracked competitor${n === 1 ? "" : "s"} appear in the AI answers we measured`,
    detail: suggestions.length
      ? `Every comparison on this page is scored against brands the engines never named, so the client sees a race they aren't in. Consider tracking: ${suggestions.join(", ")}.`
      : "Every comparison on this page is scored against brands the engines never named, so the client sees a race they aren't in. The discovery pass found no untracked brands either. Worth checking the client's category and question set.",
  };
}

export interface DiscoveredView {
  name: string;
  url: string | null;
  mentions: number;
  line: string;
}

/**
 * Non-roster brands the engines named this run, minus any that are now tracked
 * (those already render inside the comparison). This is the "who ranks well on
 * the LLMs that we are NOT tracking yet" surface — the discovery signal that
 * also feeds auto-selection via competitor-sync.
 */
export function buildDiscoveredViews(
  insights: SeoGeoInsights,
  tracked?: TrackedCompetitorRef[],
): DiscoveredView[] {
  const trackedKeys = new Set((tracked ?? []).flatMap(refKeys));
  // Both sides of this fraction share the comparison rows' scope (CD-B3), so a
  // discovered brand's count is read like-for-like. On a pre-CD-B3 snapshot that
  // scope is the full answer set, and the noun says so (CD-J1 bounce 2b).
  const basis = buildMeasurementBasis(insights);
  const total = insights.citationSummary?.totalMeasuredAnswers ?? 0;
  return (insights.discoveredBrands ?? [])
    .filter((d) => !brandKeys(d.name, d.url).some((k) => trackedKeys.has(k)))
    .map((d) => ({
      name: d.name,
      url: d.url ?? null,
      mentions: d.mentions,
      line:
        total > 0
          ? `named in ${fraction(d.mentions, total, basis.answers)}`
          : `named ${d.mentions} times`,
    }));
}

export interface RosterChip {
  name: string;
  isClient: boolean;
  url: string | null;
  /** Tracked now but not yet measured — appears in the next snapshot. */
  pending: boolean;
}

/** Methodology "who we compare you against" chips — the CURRENT tracked list when given. */
export function buildRosterChips(
  insights: SeoGeoInsights,
  tracked?: TrackedCompetitorRef[],
  clientWebsite?: string | null,
): RosterChip[] {
  const clientChip: RosterChip = {
    name: insights.roster[0] ?? "",
    isClient: true,
    url: clientWebsite?.trim() || null,
    pending: false,
  };
  if (!tracked || tracked.length === 0) {
    return [
      clientChip,
      ...insights.roster.slice(1).map((name) => ({ name, isClient: false, url: null, pending: false })),
    ];
  }
  const snapshotKeys = new Set(insights.roster.slice(1).map((n) => normalizeBrandKey(n)));
  const discoveredKeys = new Set(
    (insights.discoveredBrands ?? []).flatMap((d) => brandKeys(d.name, d.url)),
  );
  return [
    clientChip,
    ...tracked.map((t) => ({
      name: t.name,
      isClient: false,
      url: t.url ?? null,
      pending: !refKeys(t).some((k) => snapshotKeys.has(k) || discoveredKeys.has(k)),
    })),
  ];
}

/* ── Gaps ─────────────────────────────────────────────────────────── */

export type GapChannel = "search" | "ai" | "both";

export interface GapView {
  /** React key only. Never rendered. */
  key: string;
  title: string;
  /** The registry's own check label, when it differs from the resolved plain-English
   *  title. Staff-only surface (F1 demoted GapList behind an isClientViewer gate), so
   *  the technical precision stays available without becoming a card headline (F3c). */
  technicalLabel: string | null;
  severityLabel: string;
  severityTone: Tone;
  channel: GapChannel;
  channelLabel: string;
  foundLine: string;
  /** Extra evidence when it adds detail beyond foundLine. */
  evidence: string | null;
  /** null when the benchmark is just the title again (F3b) — the registry sets
   *  `benchmark = def.label = title` for every site check, so it always was. */
  goalLine: string | null;
  fixArea: { label: string; gloss: string } | null;
  fixRoute: string;
  /**
   * SCRUM-52 amendment: funnel into the executing agent. Always null now — every
   * label this ever carried named a MANAGED PRODUCT, and no managed product has a
   * card at `/clients/[id]/agents` (or anywhere else), so the chip's only
   * destination was a dead end. The product is named in `fixRoute` instead.
   * Kept rather than deleted so the invariant stays pinned: nothing renders it,
   * and seo-geo-presenter.test.ts asserts every view's chip is null, so putting a
   * href back fails a test instead of shipping another dead end.
   */
  agentChip: { label: string; href: string } | null;
  qualifier: string | null;
}

const SEVERITY_VIEW: Record<string, { label: string; tone: Tone }> = {
  critical: { label: "urgent", tone: "danger" },
  high: { label: "important", tone: "warning" },
  medium: { label: "moderate", tone: "info" },
  low: { label: "minor", tone: "neutral" },
};

/** Display order for the priority chips (QA F22). Unknown severities sort last. */
const SEVERITY_RANK: Record<string, number> = { critical: 0, high: 1, medium: 2, low: 3 };
const SEVERITY_RANK_DEFAULT = 4;

function severityRank(severity: string): number {
  return SEVERITY_RANK[severity] ?? SEVERITY_RANK_DEFAULT;
}

/**
 * QA F144 / call directive B1. "Search engines" was the word the whole report
 * hinges on and the team itself paused on it — "search engines also sounds like
 * AI". One word set everywhere: classic ranked results vs assistant answers.
 * "Search results" rather than "Google search" because the checks behind this
 * channel cover Bing and Brave indexes too (GEO-24, GEO-23), so naming one engine
 * would be its own inaccuracy.
 *
 * `Record<Lever, …>`, so a lever added to the union is a compile error here rather
 * than a raw "SEO"/"GEO"/"BOTH" code on a client screen — the F144/CD-B1 defect the
 * client action plan was still shipping (it rendered `r.vertical` straight into a
 * badge). Every lever-shaped surface reads these words: CHANNEL_VIEW below, and
 * seo-geo-action-plan.tsx, whose own map is pinned to this one by
 * seo-geo-presenter.test.ts so the two can't drift into different vocabulary.
 */
export const LEVER_LABELS: Record<Lever, string> = {
  SEO: "search results",
  GEO: "AI answers",
  BOTH: "search + AI answers",
};

/**
 * Lever → channel, on the SAME words. `Record<string, …>` deliberately (not
 * `Record<Lever, …>`): persisted snapshots can carry a lever string from an older
 * pipeline, and the `?? CHANNEL_VIEW.BOTH` fallback below is what stops that
 * reaching a client. New levers are caught by LEVER_LABELS being closed over the
 * union, which this map reads from.
 */
const CHANNEL_VIEW: Record<string, { channel: GapChannel; label: string }> = {
  SEO: { channel: "search", label: LEVER_LABELS.SEO },
  GEO: { channel: "ai", label: LEVER_LABELS.GEO },
  BOTH: { channel: "both", label: LEVER_LABELS.BOTH },
};

const FIX_AREAS: Record<string, { label: string; gloss: string }> = {
  meta_title: { label: "Page titles", gloss: "The headline each page shows in search results." },
  meta_description: { label: "Page descriptions", gloss: "The snippet under your link in search results." },
  schema: { label: "Structured data", gloss: "Behind-the-scenes labels that tell engines what your content is." },
  og_image: { label: "Link preview images", gloss: "The image shown when your pages are shared." },
  canonical: { label: "Duplicate page signals", gloss: "Telling engines which version of a page is the real one." },
  image_alt: { label: "Image descriptions", gloss: "Text descriptions of images that engines can read." },
  sitemap: { label: "Site map", gloss: "The index file that tells engines which pages exist and when they changed." },
  indexing: { label: "Search engine access", gloss: "Making sure engines can find and list your pages." },
};

/**
 * QA F4: "agent-direct" does NOT mean an actuator applies the fix. Nothing in the
 * portal writes to a client's website: there is no apply action, no job type, and
 * both gap producers hardcode `artifactRef: null`. The route means Karos drafts the
 * change and the client approves it on the action plan. Do NOT reintroduce the word
 * "automatically" until an apply path exists that writes artifactRef.
 */
const FIX_ROUTES: Record<string, string> = {
  "agent-direct": "Karos drafts this fix for your approval.",
  "existing-product": "This is handled through a tool already in your Karos plan.",
  advisory: "Our team will recommend the changes. This one takes content or outreach work, not a switch we can flip.",
};
const FIX_ROUTE_DEFAULT = "The Karos team will handle this.";

const QUALIFIERS: Record<string, string | null> = {
  CONFIRMED: null,
  LIKELY: "Based on strong signals · we verify before acting",
  HYPOTHESIS: "Early signal · our team confirms this before any work starts",
};
const QUALIFIER_DEFAULT = "Under review by the Karos team";

/**
 * Rec id → the MANAGED PRODUCT that produces the fix (QA F7). CLOSED map: unknown
 * ids fall back to the plain fix-route sentence on its own.
 *
 * These are managed products (agent-service catalog), NOT agents with a card:
 * `/clients/[id]/agents` renders the client's granted CUSTOM agents and their
 * umbrellas, and nothing else — no MANAGED_PRODUCTS surface exists anywhere in the
 * portal, for staff or for clients. So "Handled by your Blog agent" linking there
 * was a dead end twice over: no agent by that name, and no card for the product
 * doing the work. The label now names the catalog product and carries no link.
 *
 * Values are task types rather than prose so the name a human reads comes from the
 * catalog itself (MANAGED_PRODUCTS) and can't drift from the product's real name.
 *
 * The original map keyed GEO-16 / GEO-31 / BOTH-08 — ids no producer in this repo
 * emits — and was additionally gated on `delivery === "existing-product"`, which
 * only the four indexReach checks ever get (GEO-24/23/41/BOTH-09). Zero overlap, so
 * the chip was structurally unreachable. Keyed off the rec id now, and only onto ids
 * a producer actually emits (pinned in seo-geo-presenter.test.ts against the
 * producers themselves — that pin is what retired the last phantom key, BOTH-07,
 * which has REC_COPY prose but sits in neither check registry).
 *
 * Deliberately NOT mapped: the off-site entity/review checks (GEO-04, GEO-14,
 * GEO-25) and the competitor-visibility gaps (GEO-11, GEO-27, GEO-35). Those are
 * `advisory` outreach work; the only agents that could own them are the per-client
 * LinkedIn (e10) custom agent — honest only if it is in `client.customAgentIds`,
 * which this panel does not receive — and a Reddit agent that does not exist in this
 * repo. Naming an agent a client doesn't have is the exact defect F7 reports.
 */
const REC_PRODUCTS: Record<string, ManagedTaskType> = {
  // Content-shaped checks → the blog_article product.
  "GEO-02": "blog_article",
  "GEO-03": "blog_article",
  "GEO-09": "blog_article",
  "GEO-20": "blog_article",
  "GEO-22": "blog_article",
  "BOTH-13": "blog_article",
  "BOTH-16": "blog_article",
  // Page-level title / description work → the landing_page product.
  "SEO-02": "landing_page",
  "SEO-06": "landing_page",
};

/** Exported for the regression pin: every key must be an id a producer emits (F7). */
export const PRODUCT_MAPPED_IDS = Object.keys(REC_PRODUCTS);

/** Task type → the catalog's own product name. Closed by construction. */
const PRODUCT_NAMES: Record<string, string> = Object.fromEntries(
  MANAGED_PRODUCTS.map((p) => [p.taskType, p.name] as const),
);

/**
 * A server-populated productRef wins over the static rec-id map (it will be
 * filled in by a follow-up ticket); only ever the catalog name, never the raw ref
 * id or folder.
 */
export function productLabelFor(gap: VisibilityGap): string | null {
  const fromRef = gap.productRef?.id ? (PRODUCT_NAMES[gap.productRef.id] ?? null) : null;
  if (fromRef) return fromRef;
  const taskType = REC_PRODUCTS[gap.id.split(":")[0]];
  return taskType ? (PRODUCT_NAMES[taskType] ?? null) : null;
}

/** `_clientId` is vestigial: it only ever built the funnel chip's href, and that
 *  chip has no honest destination (see REC_PRODUCTS). Kept so the call sites in
 *  seo-geo-panel.tsx and the suite don't have to change in this pass. */
export function buildGapViews(gaps: VisibilityGap[], _clientId: string): GapView[] {
  // F11: the pipeline collapses registry duplicates at the source, but every
  // snapshot persisted before that still carries both copies — dedupe at render
  // too, so no UI consumer can show one defect as two contradictory cards.
  return dedupeGapsByRecId(gaps)
    // F22: the header promises "ordered by expected impact", so the chip a client
    // reads must agree with the rank they see. Severity first, lift as the
    // tie-breaker — scanning top-down now gives the urgent things first.
    .sort((a, b) => severityRank(a.severity) - severityRank(b.severity) || b.scoreLift - a.scoreLift)
    .map((g, i) => {
      const severity = SEVERITY_VIEW[g.severity] ?? SEVERITY_VIEW.low;
      const channel = CHANNEL_VIEW[g.lever] ?? CHANNEL_VIEW.BOTH;
      // F7: keyed off the rec id, NOT `delivery` — the delivery gate made this
      // permanently null (only indexReach is "existing-product", and none of those
      // ids are in the product map).
      const product = productLabelFor(g);
      const route = FIX_ROUTES[g.delivery] ?? FIX_ROUTE_DEFAULT;
      // F3c: the registry/model label is never the headline. REC_COPY covers every
      // registry id (pinned in seo-geo.test.ts); the raw title is the last resort and
      // is demoted to a secondary technical line when the lookup succeeds.
      const copy = REC_COPY[g.id.split(":")[0]];
      const title = copy?.title ?? g.title;
      return {
        key: `${g.id}-${i}`,
        title,
        technicalLabel: g.title && g.title !== title ? g.title : null,
        severityLabel: severity.label,
        severityTone: severity.tone,
        channel: channel.channel,
        channelLabel: channel.label,
        foundLine: g.measured,
        evidence: g.evidence && g.evidence !== g.measured ? g.evidence : null,
        // F3b: `benchmark` is `def.label` for every site check, i.e. the same string
        // as the title — the existing evidence-vs-measured guard, applied here too.
        goalLine: g.benchmark && g.benchmark !== g.title && g.benchmark !== title ? g.benchmark : null,
        fixArea: FIX_AREAS[g.fixAction] ?? null,
        // The executing product is named in the route sentence — plain text that
        // states a fact — instead of in a chip linking to /clients/[id]/agents,
        // where the product has no card and never did (see REC_PRODUCTS).
        fixRoute: product ? `${route} Produced by the ${product} managed product.` : route,
        agentChip: null,
        qualifier: g.confidence in QUALIFIERS ? QUALIFIERS[g.confidence] : QUALIFIER_DEFAULT,
      };
    });
}

/* ── Answer grid (QA F12) ─────────────────────────────────────────── */

/**
 * The per-question × per-engine matrix the pipeline computes and persists on every
 * run (`insights.answerGrid`) and which, until now, no component read. It is the
 * exhibit behind every aggregate on the page — "named in 3 of 14 answers" without it
 * is an assertion, and the panel's own "no black box" claim was unsupported.
 *
 * The raw answer TEXT is deliberately never persisted (src/lib/intel/seo-geo.ts),
 * so this shows the outcome per question, not the answer. Surfacing the text would
 * be a separate data-retention decision.
 */
export interface AnswerCellView {
  engine: EngineId;
  engineName: string;
  /** Plain-English outcome, from a CLOSED map — never the raw CellState. */
  label: string;
  tone: Tone;
  /** Filled / ring / hollow / none — the dot rendered in the matrix. */
  mark: "solid" | "ring" | "hollow" | "none";
}

export interface AnswerGridRow {
  prompt: string;
  /** Typographically presentable form of `prompt` (F18) — quoted, punctuated. */
  displayText: string;
  cells: AnswerCellView[];
}

/** Rows under one plain-English intent heading (F18). */
export interface AnswerGridGroup {
  intentLabel: string;
  /** Which side of the question plan this group sits on (CD-J1 bounce 2c). */
  basisLabel: string;
  rows: AnswerGridRow[];
}

export interface AnswerGridView {
  engines: Array<{ engine: EngineId; name: string }>;
  groups: AnswerGridGroup[];
  legend: Array<{ label: string; tone: Tone; mark: AnswerCellView["mark"] }>;
}

/** Closed CellState → client copy. Unknown states get the safe "not measured". */
const CELL_VIEW: Record<string, { label: string; tone: Tone; mark: AnswerCellView["mark"] }> = {
  named_first: { label: "Named first", tone: "success", mark: "solid" },
  named: { label: "Named", tone: "info", mark: "solid" },
  cited_not_named: { label: "Used your site, didn't name you", tone: "warning", mark: "ring" },
  absent: { label: "Not named", tone: "neutral", mark: "hollow" },
  unavailable: { label: "Not measured", tone: "neutral", mark: "none" },
};
const CELL_VIEW_DEFAULT = CELL_VIEW.unavailable;

/**
 * Plain-English headings for the buyer-intent taxonomy. Closed map — the stored
 * DISC / COMP / PROB / BRAND / NAV codes never reach a client screen. Order here is
 * the display order: the questions that win new customers first.
 */
export const INTENT_VIEW: Record<string, string> = {
  discovery: "Category questions",
  comparison: "Comparison questions",
  problem: "Problem questions",
  brand: "Questions that name you",
  navigational: "People looking for your site",
};
export const INTENT_VIEW_ORDER = ["discovery", "comparison", "problem", "brand", "navigational"];
const INTENT_VIEW_DEFAULT = "Other questions";

export function intentLabel(intent: string): string {
  return INTENT_VIEW[intent] ?? INTENT_VIEW_DEFAULT;
}

/**
 * Which side of the question plan a group sits on, in the client's words (CD-J1
 * bounce 2c). The intent headings alone don't carry it — "Comparison questions" and
 * "Problem questions" are both category questions, and nothing on screen said which
 * groups feed the competitor comparison and which are the control.
 */
export function basisLabel(intent: string): string {
  return intentBasis(intent) === "branded" ? "names you" : "category";
}

/** Prompts that open with one of these read as questions and earn a "?" (F18). */
const INTERROGATIVE =
  /^(what|which|who|whom|whose|where|when|why|how|is|are|was|were|do|does|did|can|could|should|would|will|has|have|am)\b/i;

/**
 * Typographic treatment for a stored prompt (QA F18). The questions rendered as
 * bare unpunctuated text — "Top-rated dental clinics", "Karos alternatives",
 * "karoslabs.com" — reading as a dump rather than a deliberate set, even though
 * the markdown brief for the same run already quotes each one.
 *
 * Quotes make every row read as a query that was typed into an engine. The "?" is
 * added only to prompts that actually open interrogatively: the deterministic
 * fallback set deliberately contains bare keyword strings and a bare domain, and
 * "karoslabs.com?" would be a new defect, not a fix. (The spec's shorthand was
 * "append a question mark when there is no terminal punctuation" — narrowed here
 * for that reason.)
 */
export function formatPrompt(prompt: string): string {
  const text = prompt.trim();
  if (!text) return text;
  const punctuated = /[.?!]$/.test(text) || !INTERROGATIVE.test(text) ? text : `${text}?`;
  return `“${punctuated}”`;
}

/**
 * Build the answer matrix. Columns are the engines that actually answered something
 * this run, in the panel's fixed engine order; an engine with nothing but
 * "not measured" cells is dropped rather than shown as an empty column. Returns
 * null when there is no grid at all (pre-grid snapshots, or a failed capture).
 */
export function buildAnswerGridViews(insights: SeoGeoInsights): AnswerGridView | null {
  const grid = insights.answerGrid ?? [];
  if (grid.length === 0) return null;

  const answered = new Set<EngineId>();
  for (const row of grid) {
    for (const cell of row.cells ?? []) {
      if (cell.state !== "unavailable") answered.add(cell.engine);
    }
  }
  const engines = ENGINE_ORDER.filter((e) => answered.has(e)).map((engine) => ({
    engine,
    name: ENGINE_LABELS[engine] ?? "Engine",
  }));
  if (engines.length === 0) return null;

  const toRow = (row: (typeof grid)[number]): AnswerGridRow => {
    const byEngine = new Map((row.cells ?? []).map((c) => [c.engine, c] as const));
    return {
      prompt: row.prompt,
      displayText: formatPrompt(row.prompt),
      cells: engines.map(({ engine, name }) => {
        const state = byEngine.get(engine)?.state;
        const view = (state && CELL_VIEW[state]) || CELL_VIEW_DEFAULT;
        return { engine, engineName: name, ...view };
      }),
    };
  };

  // Grouped under plain-English intent headings (F18), in the display order that
  // puts the questions winning new customers first. Unknown intents fall into one
  // trailing "Other questions" group rather than vanishing.
  const known = new Set(INTENT_VIEW_ORDER);
  const order = [...INTENT_VIEW_ORDER, ...new Set(grid.map((r) => r.intent).filter((i) => !known.has(i)))];
  const groups: AnswerGridGroup[] = [];
  for (const intent of order) {
    const rows = grid.filter((r) => r.intent === intent).map(toRow);
    if (rows.length > 0)
      groups.push({ intentLabel: intentLabel(intent), basisLabel: basisLabel(intent), rows });
  }

  return {
    engines,
    groups,
    legend: [CELL_VIEW.named_first, CELL_VIEW.named, CELL_VIEW.cited_not_named, CELL_VIEW.absent],
  };
}

/* ── Grouped question list (pre-grid snapshots) ───────────────────── */

export interface IntentPromptGroup {
  intentLabel: string;
  /** Which side of the question plan this group sits on (CD-J1 bounce 2c). */
  basisLabel: string;
  prompts: PromptView[];
}

/**
 * The questions grouped under plain-English intent headings, for snapshots with no
 * persisted answer grid (QA F18). Mirrors the grouping the markdown brief has
 * always used (intel/seo-geo.ts), reusing INTENT_LABELS' ordering but never its
 * DISC/COMP/PROB codes. Returns a single unlabelled group when nothing is tagged.
 */
export function buildIntentPromptViews(insights: SeoGeoInsights): IntentPromptGroup[] {
  const views = new Map(buildPromptViews(insights).map((v) => [v.text, v] as const));
  const intents = insights.intentPrompts ?? [];
  if (intents.length === 0) {
    return [{ intentLabel: "", basisLabel: "", prompts: [...views.values()] }];
  }
  const known = new Set(INTENT_VIEW_ORDER);
  const order = [...INTENT_VIEW_ORDER, ...new Set(intents.map((p) => p.intent).filter((i) => !known.has(i)))];
  const groups: IntentPromptGroup[] = [];
  for (const intent of order) {
    const prompts = intents
      .filter((p) => p.intent === intent)
      .map((p) => views.get(p.prompt))
      .filter((v): v is PromptView => !!v);
    if (prompts.length > 0)
      groups.push({ intentLabel: intentLabel(intent), basisLabel: basisLabel(intent), prompts });
  }
  return groups;
}

/* ── Prompt set ───────────────────────────────────────────────────── */

export interface PromptView {
  text: string;
  /** "mentions you" for the questions the comparison excludes; null otherwise. */
  tagLabel: string | null;
  /** What the tag means — the chip used to be the only marker on an inert row. */
  tagExplainer: string | null;
}

/**
 * QA F17 — the chip and the count came from two different classifiers.
 *
 * The chip matched only the client's DISPLAY NAME against the prompt text. The
 * "questions that name you" count comes from the pipeline's intent classifier,
 * which matches the full alias set (name, domain, short label) and returns
 * "comparison" for anything containing alternative/vs/compare BEFORE it checks the
 * brand name. So "Karos alternatives" was counted as a category question and
 * included in the like-for-like comparison while wearing a chip saying the
 * opposite; and a multi-word brand lost its chip on the bare-domain prompt, which
 * the pipeline does count as naming you.
 *
 * Driven by the persisted per-prompt intent now — the single source of truth the
 * comparison itself uses. The chip is additionally scoped to prompts an engine
 * actually ANSWERED (via the answer grid), because brandPresence.total counts only
 * measured prompts: without that, a partial run showed more chips than the sentence
 * claimed. Chip count now equals brandPresence.total by construction, on complete
 * and partial runs alike.
 */
export function buildPromptViews(insights: SeoGeoInsights): PromptView[] {
  const intentByPrompt = new Map((insights.intentPrompts ?? []).map((p) => [p.prompt, p.intent]));
  const grid = insights.answerGrid ?? [];
  const hasGrid = grid.length > 0;
  const measured = new Set(
    grid.filter((r) => (r.cells ?? []).some((c) => c.state !== "unavailable")).map((r) => r.prompt),
  );
  return insights.promptSet.map((prompt) => {
    const intent = intentByPrompt.get(prompt);
    const namesYou =
      (intent === "brand" || intent === "navigational") && (!hasGrid || measured.has(prompt));
    return {
      text: prompt,
      tagLabel: namesYou ? "mentions you" : null,
      tagExplainer: namesYou
        ? "This question names your brand, so engines are near-guaranteed to mention you. We leave it out of the competitor comparison to keep that like-for-like."
        : null,
    };
  });
}

/* ── Flag-to-team prefills ────────────────────────────────────────── */

export interface FlagPrefill {
  subject: string;
  message: string;
}

export function noDataFlagPrefill(engineName: string, insights: SeoGeoInsights): FlagPrefill {
  return {
    subject: `Question about ${engineName} in our AI visibility snapshot`,
    message: `${engineName} shows "no answers this run" on our dashboard (snapshot ${formatCaptured(insights.capturedAt)}). Can you take a look?`,
  };
}

/* CD-B2 removed `engineFlagPrefill` and `unwiredRequestPrefill`. Both existed only
   to let a client ask us to add Perplexity or Copilot coverage; with those engines
   out of the tracked set there is no unwired engine to request, and keeping the
   prefills would keep alive a banner that can never render. */

export function genericFlagPrefill(insights: SeoGeoInsights): FlagPrefill {
  return {
    subject: `Question about our search and AI visibility snapshot (${formatCaptured(insights.capturedAt)})`,
    message: "",
  };
}
