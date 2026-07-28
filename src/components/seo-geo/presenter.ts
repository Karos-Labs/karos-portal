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
import { competitorBrandKeys } from "@/lib/competitor-input";
import {
  ENGINE_LABELS,
  ENGINE_PROVIDERS,
  GEO_READINESS_CHECKS,
  REC_COPY,
  SEO_CHECKS,
  brandKeys,
  computeCheckScore,
  engineVisibilityScore,
  findMention,
  normalizeBrandKey,
  type EngineId,
  type SeoGeoInsights,
  type SubMetrics,
  type VisibilityGap,
} from "@/lib/seo-geo";

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

export function buildScoreViews(insights: SeoGeoInsights): ScoreView[] {
  const seoBand = scoreBand(insights.seoScore);
  const geoBand = scoreBand(insights.geoReadiness);
  const visBand = scoreBand(insights.geoVisibilityIndex);
  const promptCount = insights.promptSet.length;

  const seoMeasured = insights.seoDataCoveragePct > 0;
  const readinessMeasured = insights.geoReadinessCoveragePct > 0;
  const visibilityMeasured = insights.geoVisibilityEnginesScored > 0;

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
      explainer: `How often AI assistants actually name or recommend you right now, when we ask them ${promptCount || "real"} buyer questions. Based on the ${insights.geoVisibilityEnginesScored} of ${insights.geoVisibilityEnginesTotal} engines we can measure. This is the number the fixes below are designed to move.`,
      value: visibilityMeasured ? insights.geoVisibilityIndex : null,
      tone: visibilityMeasured ? visBand.tone : "neutral",
      bandLabel: visibilityMeasured ? visBand.label : "no engines measured this run",
      coveragePct:
        insights.geoVisibilityEnginesTotal > 0
          ? Math.round((insights.geoVisibilityEnginesScored / insights.geoVisibilityEnginesTotal) * 100)
          : 0,
      coverageLine: `based on ${insights.geoVisibilityEnginesScored} of ${insights.geoVisibilityEnginesTotal} AI engines`,
      breakdownTitle: "Score by engine",
      breakdown: insights.perEngine
        .filter((e) => e.captureTier !== "UNAVAILABLE" && e.promptsMeasured > 0)
        .map((e) => ({
          label: ENGINE_LABELS[e.engine] ?? "Engine",
          pct: Math.round(engineVisibilityScore(e) * 100),
          note: null,
        })),
    },
  ];
}

/* ── Capture context ──────────────────────────────────────────────── */

export function formatCaptured(capturedAt: number): string {
  if (!Number.isFinite(capturedAt)) return "an earlier run";
  return new Date(capturedAt).toISOString().slice(0, 10);
}

export function buildContextLine(insights: SeoGeoInsights): string {
  return [
    `Snapshot from ${formatCaptured(insights.capturedAt)}`,
    `${insights.promptSet.length} real buyer questions`,
    `${insights.geoVisibilityEnginesScored} of ${insights.geoVisibilityEnginesTotal} AI engines measured`,
  ].join(" · ");
}

/* ── Engines ──────────────────────────────────────────────────────── */

export type EngineStatus = "measured" | "no-data" | "not-wired";

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

const ENGINE_ORDER: EngineId[] = ["chatgpt", "gemini", "claude", "perplexity", "copilot"];

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

/** Closed status → copy map for the two unmeasured states. */
const UNMEASURED_COPY = {
  "not-wired": {
    statusLabel: "not yet measured",
    explainer: (name: string) =>
      `We can't measure ${name} yet. Our connection to this engine isn't built. Your scores only count the engines we can actually measure, so nothing here is guessed.`,
    causeLine: (name: string) =>
      `We can't ask ${name} questions yet. Our connection to this engine isn't built.`,
    prefill: engineFlagPrefill,
  },
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
  return ENGINE_ORDER.map((engine) => {
    const row = byEngine.get(engine) ?? null;
    const name = ENGINE_LABELS[engine] ?? "Engine";
    const source = row?.source ?? ENGINE_PROVIDERS[engine] ?? null;
    const measured = !!row && row.captureTier !== "UNAVAILABLE" && row.promptsMeasured > 0;
    const status: EngineStatus = measured ? "measured" : source === null ? "not-wired" : "no-data";

    if (status !== "measured" || !row) {
      const copy = UNMEASURED_COPY[status === "not-wired" ? "not-wired" : "no-data"];
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

    // Client-vs-competitor comparison uses CATEGORY prompts only — the 6 branded
    // questions name the client by construction and guarantee it mentions, which
    // would otherwise inflate every stat here to a near-meaningless number even
    // when every tracked competitor sits at 0 (QA Fix 2). Older persisted snapshots
    // were captured before `category` existed on this record, so fall back to the
    // full (all-prompts) metrics rather than crashing on the missing field.
    const cat: SubMetrics = row.category ?? {
      promptsMeasured: row.promptsMeasured,
      mentionRate: row.mentionRate,
      citationRate: row.citationRate,
      firstPositionRate: row.firstPositionRate,
      shareOfVoice: row.shareOfVoice,
      netSentiment: row.netSentiment,
      ghostCitationRate: row.ghostCitationRate,
      topCompetitor: row.topCompetitor,
      brandMentions: row.brandMentions,
    };
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
      explainer: `Measured ${providerPhrase(row.source)} by asking the same ${n} unbranded category buyer questions we ask every engine.`,
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
        {
          label: "cited as a source",
          value: fraction(citedCount, n, "answers"),
          explainer:
            "How often the engine linked to your website as a source for its answer. Being cited means the AI is reading your site, not just remembering your name.",
        },
        {
          label: "answered first",
          value: fraction(firstCount, n, "answers"),
          explainer:
            "When the answer listed brands, how often yours came first. First mention carries the most weight with buyers skimming an answer.",
        },
      ],
      ghost:
        row.ghostCitationRate > 0
          ? {
              label: `linked but not named · ${Math.round(row.ghostCitationRate)}% of your citations`,
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
  fractionLine: string | null;
  pct: number | null;
  explainer: string;
  emptyLine: string | null;
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

export function buildPresence(insights: SeoGeoInsights): PresenceView {
  const b = insights.brandPresence;
  const c = insights.categoryPresence;
  const competitors = Math.max(0, insights.roster.length - 1);

  const brandRate = b.total > 0 ? b.named / b.total : null;
  const catRate = c.total > 0 ? c.named / c.total : null;

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
    brand: {
      heading: "When buyers ask about you by name",
      caption: "questions that mention your brand",
      fractionLine: b.total > 0 ? `Named in ${fraction(b.named, b.total, "questions")}` : null,
      pct: b.total > 0 ? Math.round((b.named / b.total) * 100) : null,
      explainer:
        "Questions that mention you by name, like asking whether your brand is any good. Being named here shows the engines know who you are.",
      emptyLine: b.total > 0 ? null : "We didn't ask any questions that name you this run.",
    },
    category: {
      heading: "When buyers ask about your category",
      caption: "questions that don't mention your name",
      fractionLine: c.total > 0 ? `Named in ${fraction(c.named, c.total, "questions")}` : null,
      pct: c.total > 0 ? Math.round((c.named / c.total) * 100) : null,
      explainer:
        "Questions buyers ask before they know you exist, like asking for the best option in your category. Being named here is how new customers find you. It's the hardest and most valuable place to show up.",
      emptyLine: c.total > 0 ? null : "No category questions were measured this run.",
    },
    takeaway,
    rosterShare:
      competitors > 0
        ? {
            value: `${Math.round(insights.rosterSharePct)}%`,
            pct: Math.round(insights.rosterSharePct),
            caption: `of every brand mention across you and the ${competitors} competitor${competitors === 1 ? "" : "s"} we track`,
            explainer:
              "Your share of every brand mention across all measured answers, counting you and the competitors we track. It's the single number for how much of the AI conversation you own.",
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
  const total = insights.citationSummary?.totalMeasuredAnswers ?? 0;
  return (insights.discoveredBrands ?? [])
    .filter((d) => !brandKeys(d.name, d.url).some((k) => trackedKeys.has(k)))
    .map((d) => ({
      name: d.name,
      url: d.url ?? null,
      mentions: d.mentions,
      line: total > 0 ? `named in ${fraction(d.mentions, total, "answers")}` : `named ${d.mentions} times`,
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
  /** SCRUM-52 amendment: funnel into the executing agent. */
  agentChip: { label: string; href: string } | null;
  qualifier: string | null;
}

const SEVERITY_VIEW: Record<string, { label: string; tone: Tone }> = {
  critical: { label: "urgent", tone: "danger" },
  high: { label: "important", tone: "warning" },
  medium: { label: "moderate", tone: "info" },
  low: { label: "minor", tone: "neutral" },
};

const CHANNEL_VIEW: Record<string, { channel: GapChannel; label: string }> = {
  SEO: { channel: "search", label: "search engines" },
  GEO: { channel: "ai", label: "AI answers" },
  BOTH: { channel: "both", label: "search + AI" },
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
 * Rec id → executing agent (QA F7). CLOSED map: unknown ids fall back to the plain
 * fix-route sentence, never a broken link.
 *
 * The original map keyed GEO-16 / GEO-31 / BOTH-08 — ids no producer in this repo
 * emits — and the chip was additionally gated on `delivery === "existing-product"`,
 * which only the four indexReach checks ever get (GEO-24/23/41/BOTH-09). Zero
 * overlap, so the chip was structurally unreachable. Keyed off the rec id now, and
 * only onto ids the registries actually emit (pinned in seo-geo-presenter.test.ts).
 *
 * Deliberately NOT mapped: the off-site entity/review checks (GEO-04, GEO-14,
 * GEO-25) and the competitor-visibility gaps (GEO-11, GEO-27, GEO-35). Those are
 * `advisory` outreach work; the only agents that could own them are the per-client
 * LinkedIn (e10) custom agent — honest only if it is in `client.customAgentIds`,
 * which this panel does not receive — and a Reddit agent that does not exist in this
 * repo. Naming an agent a client doesn't have is the exact defect F7 reports.
 */
const REC_AGENT_LABELS: Record<string, string> = {
  // Content-shaped checks → the blog_article product.
  "GEO-02": "Blog agent",
  "GEO-03": "Blog agent",
  "GEO-09": "Blog agent",
  "GEO-20": "Blog agent",
  "GEO-22": "Blog agent",
  "BOTH-13": "Blog agent",
  "BOTH-16": "Blog agent",
  // Page-level title / description / canonical work → the landing_page product.
  "SEO-02": "Website agent",
  "SEO-06": "Website agent",
  "BOTH-07": "Website agent",
};

/** Exported for the regression pin: every key must be an id a producer emits (F7). */
export const AGENT_MAPPED_IDS = Object.keys(REC_AGENT_LABELS);

/** Managed-product task types (agent-service catalog) → agent label. */
const PRODUCT_AGENT_LABELS: Record<string, string> = {
  social_post: "Social agent",
  newsletter_issue: "Newsletter agent",
  blog_article: "Blog agent",
  landing_page: "Website agent",
};

/**
 * A server-populated productRef wins over the static rec-id map (it will be
 * filled in by a follow-up ticket); only ever the humanized label, never the
 * raw ref id or folder.
 */
export function agentLabelFor(gap: VisibilityGap): string | null {
  const fromProduct = gap.productRef?.id ? (PRODUCT_AGENT_LABELS[gap.productRef.id] ?? null) : null;
  if (fromProduct) return fromProduct;
  const recId = gap.id.split(":")[0];
  return REC_AGENT_LABELS[recId] ?? null;
}

export function buildGapViews(gaps: VisibilityGap[], clientId: string): GapView[] {
  return [...gaps]
    .sort((a, b) => b.scoreLift - a.scoreLift)
    .map((g, i) => {
      const severity = SEVERITY_VIEW[g.severity] ?? SEVERITY_VIEW.low;
      const channel = CHANNEL_VIEW[g.lever] ?? CHANNEL_VIEW.BOTH;
      // F7: keyed off the rec id, NOT `delivery` — the delivery gate made this
      // permanently null (only indexReach is "existing-product", and none of those
      // ids are in the agent map).
      const agentLabel = agentLabelFor(g);
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
        fixRoute: FIX_ROUTES[g.delivery] ?? FIX_ROUTE_DEFAULT,
        agentChip: agentLabel
          ? { label: `Handled by your ${agentLabel}`, href: `/clients/${clientId}/agents` }
          : null,
        qualifier: g.confidence in QUALIFIERS ? QUALIFIERS[g.confidence] : QUALIFIER_DEFAULT,
      };
    });
}

/* ── Prompt set ───────────────────────────────────────────────────── */

export interface PromptView {
  text: string;
  /**
   * "mentions you" when the client's display name appears in the prompt;
   * null otherwise. Deliberately makes no "category question" claim: the
   * pipeline's brand/category split matches the full alias set (domain,
   * short label), which isn't stored on the doc, so a definite tag here
   * could contradict the presence tile above. Follow-up: persist per-prompt
   * brand flags in clientSeoGeo so both surfaces classify identically.
   */
  tagLabel: string | null;
}

export function buildPromptViews(insights: SeoGeoInsights): PromptView[] {
  const clientName = insights.roster[0] ?? "";
  return insights.promptSet.map((prompt) => ({
    text: prompt,
    tagLabel: clientName && findMention(prompt, clientName) >= 0 ? "mentions you" : null,
  }));
}

/* ── Flag-to-team prefills ────────────────────────────────────────── */

export interface FlagPrefill {
  subject: string;
  message: string;
}

export function engineFlagPrefill(engineName: string, insights: SeoGeoInsights): FlagPrefill {
  return {
    subject: `Request: measure ${engineName} in our AI visibility snapshot`,
    message: `We'd like ${engineName} added to our AI visibility snapshot. It currently shows "not yet measured" on our dashboard (snapshot ${formatCaptured(insights.capturedAt)}).`,
  };
}

export function noDataFlagPrefill(engineName: string, insights: SeoGeoInsights): FlagPrefill {
  return {
    subject: `Question about ${engineName} in our AI visibility snapshot`,
    message: `${engineName} shows "no answers this run" on our dashboard (snapshot ${formatCaptured(insights.capturedAt)}). Can you take a look?`,
  };
}

/** One request covering every unwired engine, for the capture-strip banner. */
export function unwiredRequestPrefill(engineNames: string[], insights: SeoGeoInsights): FlagPrefill {
  const names = engineNames.join(" and ");
  return {
    subject: `Request: measure ${names} in our AI visibility snapshot`,
    message: `We'd like ${names} added to our AI visibility snapshot (snapshot ${formatCaptured(insights.capturedAt)}).`,
  };
}

export function genericFlagPrefill(insights: SeoGeoInsights): FlagPrefill {
  return {
    subject: `Question about our search and AI visibility snapshot (${formatCaptured(insights.capturedAt)})`,
    message: "",
  };
}
