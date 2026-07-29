/**
 * SEO & GEO metrics engine — pure, client-safe maths (no server imports).
 *
 * TypeScript port of the karos-agents lab product `a3`
 * (products/onboarding/step-02-seo-geo, scoring config `a3-scoring-v2`):
 *   - SEO score        : 4 buckets — eligibility 35 + technical/CWV 25 + on-page 25 + structure 15
 *   - GEO readiness    : 7 buckets — crawler access 28 + extractability 22 + evidence 15 +
 *                        freshness 12 + multimodal 5 + index reach 8 + off-site entity 10
 *   - GEO visibility   : 6 weighted components over the frozen multi-engine answer set
 *                        (citation share 35, first position 20, share of voice 20,
 *                        mention rate 15, sentiment 6, ghost penalty 4)
 *
 * Grade rule (ported verbatim): ESTIMATED values never enter a grade. Scores are
 * computed over MEASURED checks only; `dataCoveragePct` = measured weight / total weight.
 *
 * Multi-model provenance: every engine answer carries the provider that produced it
 * (`source: "OpenAI" | "Gemini" | "Anthropic"`) so UI graphs can attribute each data
 * point to the model that generated it.
 */

/* ── Engines & provenance ─────────────────────────────────────────── */

/**
 * The tracked answer engines. Call directive B2 (2026-07-27) removed Perplexity and
 * Copilot from the set entirely: neither has a wired provider, so they contributed
 * nothing but permanent "not yet measured" chips, a "0 of 5 engines measured"
 * coverage figure that could never reach 5, and a standing flag-us-to-add-them
 * banner for connectors nobody is building. Removing them from the TYPE is
 * deliberate — every roster, order and label map is keyed by EngineId, so the
 * compiler now enforces the removal rather than five separate lists agreeing.
 *
 * Snapshots captured before this still carry perplexity/copilot rows; they are
 * simply not rendered (ENGINE_ORDER drives the UI) and their stored
 * geoVisibilityEnginesTotal of 5 stands as a historical fact.
 */
export type EngineId = "chatgpt" | "gemini" | "claude";

/** Which model provider actually produced a data point (multi-model provenance). */
export type ProviderSource = "OpenAI" | "Gemini" | "Anthropic";

/** Capture tier per the a3 grade-data-only rule. Set at capture time, never upgraded. */
export type CaptureTier = "MEASURED" | "MEASURED_grounded" | "ESTIMATED" | "UNAVAILABLE";

export const ENGINE_LABELS: Record<EngineId, string> = {
  chatgpt: "ChatGPT",
  gemini: "Gemini",
  claude: "Claude",
};

/** Engine → provider that answers for it in this platform (null = no connector wired yet). */
export const ENGINE_PROVIDERS: Record<EngineId, ProviderSource | null> = {
  chatgpt: "OpenAI",
  gemini: "Gemini",
  claude: "Anthropic",
};

/* ── Probe & answer shapes ────────────────────────────────────────── */

/** One raw engine answer for one buyer-intent prompt. */
export interface EngineAnswer {
  engine: EngineId;
  /** Provider that produced this answer — the provenance tag surfaced in the UI. */
  source: ProviderSource;
  prompt: string;
  answerText: string;
  /** Registrable domains cited by the engine, in return order (ordinal = index + 1). */
  citations: string[];
  captureTier: CaptureTier;
}

/** Deterministic per-prompt analysis of one engine answer against the brand gazetteer. */
export interface GeoProbe {
  engine: EngineId;
  source: ProviderSource;
  prompt: string;
  captureTier: CaptureTier;
  brandMentioned: boolean;
  brandCited: boolean;
  /** 1-based ordinal of the first brand mention among all roster mentions; null if absent. */
  brandFirst: boolean;
  /** Roster brands (client + competitors) mentioned, in order of first appearance. */
  mentionedBrands: string[];
  /** Net sentiment of brand-adjacent text: -1 | 0 | +1 (deterministic lexicon — ESTIMATED). */
  brandSentiment: number;
  /** Registrable domains this engine cited in the answer (for the citation leaderboard). */
  citations: string[];
}

/* ── Gazetteer (deterministic mention matching) ───────────────────── */

export interface Gazetteer {
  /** Client display name + aliases. */
  client: string[];
  /** Client registrable domain (e.g. "karoslabs.com"), if known. */
  clientDomain: string | null;
  /** Competitor name → aliases. */
  competitors: Record<string, string[]>;
}

/**
 * Aliases derived from a brand's website so answers that name a brand by its domain
 * ("rivalone.com") or compressed label ("rivalone") still match. Previously the URL was
 * discarded and only the display name was matched, under-counting share-of-voice whenever
 * a model referred to a competitor by domain/short form. Root domain is always safe; the
 * bare label is only added when it's distinctive enough (≥4 chars) to avoid false hits on
 * common words.
 */
const GENERIC_DOMAIN_LABELS = new Set([
  "www", "com", "net", "org", "co", "app", "web", "site", "shop", "store", "blog", "news", "en", "he", "il",
]);

/**
 * Best-effort brand label from a registrable domain: the LAST meaningful label
 * before the public-suffix tail — "tech.walla.co.il" → "walla" (not "tech"),
 * "en.mapstr.com" → "mapstr", "calcalistech.com" → "calcalistech". Without this,
 * section-subdomain sites key/alias on their subdomain ("tech"), which both
 * mis-identifies the brand and word-matches unrelated answer text.
 */
function brandLabelFromDomain(domain: string | null): string | null {
  if (!domain) return null;
  const labels = domain.split(".").filter(Boolean);
  if (labels.length === 0) return null;
  const candidates = labels.slice(0, -1).filter((l) => l.length >= 3 && !GENERIC_DOMAIN_LABELS.has(l));
  return candidates.length ? candidates[candidates.length - 1] : labels[0];
}

function aliasesFromWebsite(url: string | undefined | null): string[] {
  const domain = rootDomain(url);
  if (!domain) return [];
  const aliases = [domain];
  const label = brandLabelFromDomain(domain);
  if (label && label.length >= 4) aliases.push(label);
  return aliases;
}

/** Case-insensitive alias dedupe, preserving first-seen order and dropping blanks. */
function uniqueAliases(aliases: string[]): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const raw of aliases) {
    const a = raw.trim();
    const key = a.toLowerCase();
    if (a && !seen.has(key)) {
      seen.add(key);
      out.push(a);
    }
  }
  return out;
}

/**
 * Collapse a brand to a comparison key so near-duplicate roster rows merge instead of
 * competing against each other (QA Fix 2: "Kairos AI Agency" and "KAIROS.ai" are one
 * entity). The registrable domain root is the strongest identity; otherwise the name
 * stripped of generic agency suffixes + punctuation.
 */
export function normalizeBrandKey(name: string, url?: string): string {
  const domainRoot = brandLabelFromDomain(rootDomain(url));
  if (domainRoot && domainRoot.length >= 3) return domainRoot;
  return name
    .toLowerCase()
    .replace(/\b(ai|agency|consulting|labs?|studio|inc|llc|ltd|co|group|the|and|&)\b/g, "")
    .replace(/[^a-z0-9]/g, "");
}

/**
 * Every identity key for a brand: the name-derived key plus the url-derived key
 * when they differ. Cross-surface matching (snapshot roster names ↔ competitor
 * rows with urls ↔ discovered brands) must test ALL keys on both sides — a
 * name-only vs url-only comparison misses brands whose display name isn't their
 * domain label ("CTech by Calcalist" vs calcalistech.com).
 */
export function brandKeys(name: string, url?: string): string[] {
  const nameKey = normalizeBrandKey(name);
  if (!url) return [nameKey];
  const urlKey = normalizeBrandKey(name, url);
  return urlKey === nameKey ? [nameKey] : [nameKey, urlKey];
}

export function buildGazetteer(
  clientName: string,
  clientWebsite: string | undefined,
  competitors: Array<{ company: string; url?: string }>,
): Gazetteer {
  // Dedupe competitors that resolve to the same entity, merging their aliases under the
  // first-seen canonical name — otherwise a client's split roster names double-count.
  const canonicalByKey = new Map<string, string>();
  const merged: Record<string, string[]> = {};
  for (const c of competitors) {
    const key = normalizeBrandKey(c.company, c.url);
    const canonical = canonicalByKey.get(key);
    if (canonical) {
      merged[canonical] = uniqueAliases([...merged[canonical], c.company, ...aliasesFromWebsite(c.url)]);
      continue;
    }
    canonicalByKey.set(key, c.company);
    merged[c.company] = uniqueAliases([c.company, ...aliasesFromWebsite(c.url)]);
  }
  return {
    client: uniqueAliases([clientName, ...aliasesFromWebsite(clientWebsite)]),
    clientDomain: rootDomain(clientWebsite),
    competitors: merged,
  };
}

/** Registrable root domain from a URL/host ("https://www.foo.com.br/x" → "foo.com.br" best-effort). */
export function rootDomain(url: string | undefined | null): string | null {
  if (!url) return null;
  try {
    const host = new URL(url.includes("://") ? url : `https://${url}`).hostname.toLowerCase();
    return host.replace(/^www\./, "");
  } catch {
    return null;
  }
}

/** Case/accent-insensitive word-boundary mention search; returns first match index or -1. */
export function findMention(text: string, alias: string): number {
  const norm = (s: string) => s.normalize("NFD").replace(/[̀-ͯ]/g, "").toLowerCase();
  const hay = norm(text);
  const needle = norm(alias);
  if (!needle) return -1;
  const escaped = needle.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const m = new RegExp(`(?<![\\p{L}\\p{N}])${escaped}(?![\\p{L}\\p{N}])`, "u").exec(hay);
  return m ? m.index : -1;
}

/** Tiny deterministic sentiment lexicon applied to the ±160 chars around a brand mention.
 *  This is an ESTIMATED signal by the a3 grade rule — never enters the visibility index. */
const POSITIVE_WORDS = ["best", "leading", "top", "recommended", "excellent", "trusted", "popular", "reliable", "strong", "melhor", "líder", "recomendado", "confiável"];
const NEGATIVE_WORDS = ["avoid", "poor", "weak", "complaint", "scam", "worst", "unreliable", "negative", "evite", "ruim", "fraco", "reclamação"];

export function estimateMentionSentiment(text: string, mentionIndex: number): number {
  const windowText = text.slice(Math.max(0, mentionIndex - 160), mentionIndex + 160).toLowerCase();
  const pos = POSITIVE_WORDS.some((w) => windowText.includes(w));
  const neg = NEGATIVE_WORDS.some((w) => windowText.includes(w));
  if (pos && !neg) return 1;
  if (neg && !pos) return -1;
  return 0;
}

/** Analyze one raw engine answer into a deterministic probe record. */
export function analyzeAnswer(answer: EngineAnswer, gazetteer: Gazetteer): GeoProbe {
  const unavailable = answer.captureTier === "UNAVAILABLE" || !answer.answerText.trim();
  const firstIndexOf = (aliases: string[]): number => {
    let min = -1;
    for (const a of aliases) {
      const i = findMention(answer.answerText, a);
      if (i >= 0 && (min === -1 || i < min)) min = i;
    }
    return min;
  };

  const clientIdx = unavailable ? -1 : firstIndexOf(gazetteer.client);
  const rosterHits: Array<{ brand: string; index: number }> = [];
  if (clientIdx >= 0) rosterHits.push({ brand: gazetteer.client[0], index: clientIdx });
  if (!unavailable) {
    for (const [brand, aliases] of Object.entries(gazetteer.competitors)) {
      const i = firstIndexOf(aliases);
      if (i >= 0) rosterHits.push({ brand, index: i });
    }
  }
  rosterHits.sort((a, b) => a.index - b.index);

  const cited =
    !unavailable &&
    !!gazetteer.clientDomain &&
    answer.citations.some((d) => d === gazetteer.clientDomain || d.endsWith(`.${gazetteer.clientDomain}`));

  return {
    engine: answer.engine,
    source: answer.source,
    prompt: answer.prompt,
    captureTier: answer.captureTier,
    brandMentioned: clientIdx >= 0,
    brandCited: cited,
    brandFirst: rosterHits.length > 0 && rosterHits[0].brand === gazetteer.client[0],
    mentionedBrands: rosterHits.map((h) => h.brand),
    brandSentiment: clientIdx >= 0 ? estimateMentionSentiment(answer.answerText, clientIdx) : 0,
    citations: unavailable ? [] : answer.citations,
  };
}

/* ── Per-engine visibility metrics ────────────────────────────────── */

/** Per-engine sub-metrics (a3 `per_engine` record) plus provenance. */
export interface PerEngineVisibility {
  engine: EngineId;
  /** Provider that produced this engine's data — shown as a badge in the UI. */
  source: ProviderSource | null;
  captureTier: CaptureTier;
  /** Prompts with a real answer from this engine. */
  promptsMeasured: number;
  promptsTotal: number;
  /** Σ brand mentioned / N_e, 0..1 */
  mentionRate: number;
  /** Σ brand cited / N_e, 0..1 */
  citationRate: number;
  /** Σ brand ranked first among roster mentions / N_e, 0..1 */
  firstPositionRate: number;
  /** Client share of all roster mentions on this engine, 0..100. */
  shareOfVoice: number;
  /** (#pos − #neg) / mentions, −1..+1. ESTIMATED — context only, never graded. */
  netSentiment: number;
  /** Cited but never named: ghost citations / citations, 0..100 (diagnostic). */
  ghostCitationRate: number;
  /** Competitor with the highest mention count on this engine (gap benchmark). */
  topCompetitor: { name: string; mentionRate: number; shareOfVoice: number } | null;
  /** Per-brand mention counts — the raw series behind comparative graphs. */
  brandMentions: Array<{ name: string; mentions: number; isClient: boolean }>;
  /**
   * Client-vs-competitor comparison computed on CATEGORY prompts only (excludes brand +
   * navigational prompts that name the client and guarantee it mentions). This is what
   * the "client vs competitors" bars + share-of-voice must render — otherwise brand
   * prompts inflate the client to a meaningless 100% (QA Fix 2). Equals the full set
   * when no intent filter is supplied.
   */
  category: SubMetrics;
  /** Brand/nav prompts where the client was named, e.g. "6 of 6" (the split label). */
  brandNamed: number;
  brandPromptsMeasured: number;
}

/** The share-of-voice / mention sub-metrics, computable over any probe subset. */
export interface SubMetrics {
  promptsMeasured: number;
  mentionRate: number;
  citationRate: number;
  firstPositionRate: number;
  shareOfVoice: number;
  netSentiment: number;
  ghostCitationRate: number;
  topCompetitor: { name: string; mentionRate: number; shareOfVoice: number } | null;
  brandMentions: Array<{ name: string; mentions: number; isClient: boolean }>;
}

function computeSubMetrics(measured: GeoProbe[], gazetteer: Gazetteer): SubMetrics {
  const n = measured.length;
  const clientName = gazetteer.client[0];
  const roster = [clientName, ...Object.keys(gazetteer.competitors)];
  const counts = new Map<string, number>(roster.map((b) => [b, 0]));
  for (const p of measured) for (const b of p.mentionedBrands) counts.set(b, (counts.get(b) ?? 0) + 1);
  const totalMentions = [...counts.values()].reduce((a, b) => a + b, 0);

  const mentioned = measured.filter((p) => p.brandMentioned).length;
  const citedCount = measured.filter((p) => p.brandCited).length;
  const ghost = measured.filter((p) => p.brandCited && !p.brandMentioned).length;
  const sentimentSum = measured.reduce((a, p) => a + p.brandSentiment, 0);

  const competitorRows = Object.keys(gazetteer.competitors)
    .map((name) => ({ name, mentions: counts.get(name) ?? 0 }))
    .sort((a, b) => b.mentions - a.mentions);
  const top = competitorRows[0] && competitorRows[0].mentions > 0 ? competitorRows[0] : null;

  return {
    promptsMeasured: n,
    mentionRate: n ? mentioned / n : 0,
    citationRate: n ? citedCount / n : 0,
    firstPositionRate: n ? measured.filter((p) => p.brandFirst).length / n : 0,
    shareOfVoice: totalMentions ? ((counts.get(clientName) ?? 0) / totalMentions) * 100 : 0,
    netSentiment: mentioned ? sentimentSum / mentioned : 0,
    ghostCitationRate: citedCount ? (ghost / citedCount) * 100 : 0,
    topCompetitor: top
      ? { name: top.name, mentionRate: n ? top.mentions / n : 0, shareOfVoice: totalMentions ? (top.mentions / totalMentions) * 100 : 0 }
      : null,
    brandMentions: roster.map((name) => ({ name, mentions: counts.get(name) ?? 0, isClient: name === clientName })),
  };
}

/**
 * @param isCategory optional predicate marking a prompt as a category (non-brand,
 *   non-navigational) question. When supplied, the `category` sub-metrics use only those
 *   prompts, so the client-vs-competitor comparison is like-for-like (QA Fix 2).
 */
export function computePerEngineVisibility(
  engine: EngineId,
  probes: GeoProbe[],
  gazetteer: Gazetteer,
  isCategory?: (prompt: string) => boolean,
): PerEngineVisibility {
  const engineProbes = probes.filter((p) => p.engine === engine);
  const measured = engineProbes.filter((p) => p.captureTier !== "UNAVAILABLE");
  const source = engineProbes[0]?.source ?? ENGINE_PROVIDERS[engine];
  const tier: CaptureTier = measured.length === 0 ? "UNAVAILABLE" : measured[0].captureTier;

  // Index inputs use the full measured set (headline consistency with the a3 reference).
  const all = computeSubMetrics(measured, gazetteer);
  // Comparison/display uses category prompts only.
  const categoryProbes = isCategory ? measured.filter((p) => isCategory(p.prompt)) : measured;
  const brandProbes = isCategory ? measured.filter((p) => !isCategory(p.prompt)) : [];
  const category = computeSubMetrics(categoryProbes, gazetteer);

  return {
    engine,
    source,
    captureTier: tier,
    promptsMeasured: all.promptsMeasured,
    promptsTotal: engineProbes.length,
    mentionRate: all.mentionRate,
    citationRate: all.citationRate,
    firstPositionRate: all.firstPositionRate,
    shareOfVoice: all.shareOfVoice,
    netSentiment: all.netSentiment,
    ghostCitationRate: all.ghostCitationRate,
    topCompetitor: all.topCompetitor,
    brandMentions: all.brandMentions,
    category,
    brandNamed: brandProbes.filter((p) => p.brandMentioned).length,
    brandPromptsMeasured: brandProbes.length,
  };
}

/* ── GEO visibility index (appearance-led geo-score-v3) ───────────── */

/**
 * Headline GEO visibility model, aligned to the production a3 run contract
 * (run-record.json `geo_visibility_model`, geo-score-v3):
 *
 *   mean over engines of
 *     0.40*appearance + 0.20*citation + 0.15*first_position + 0.15*share_of_roster + 0.10*sentiment
 *
 * This "appearance-led" model is the honest, pilot-consistent headline number.
 * It replaced an earlier weighted-index model (citation 35 / first 20 / roster 20 /
 * mention 15 / sentiment 6 / ghost 4, TARGET_CITE=0.1) that diverged ~3x on the same
 * frozen inputs — brand/nav prompts + a low citation target + a low-visibility locked
 * roster inflated citation_share and share_of_roster. Do NOT reintroduce the old model
 * as the headline; the Sitti baseline (appearance-led 20 vs weighted-index ~62) is the
 * recorded evidence for this choice.
 */
export const GEO_VISIBILITY_MODEL =
  "appearance-led (geo-score-v3): mean over engines of 0.40*appearance + 0.20*citation + 0.15*first_position + 0.15*share_of_roster + 0.10*sentiment";

export const APPEARANCE_LED_WEIGHTS = {
  appearance: 0.4, // brand named in the answer at all (mention rate)
  citation: 0.2, //   client domain cited as a source
  firstPosition: 0.15, // brand ranked first among roster mentions
  shareOfRoster: 0.15, // client share among the locked roster
  sentiment: 0.1, //  net sentiment of brand-adjacent text (lexicon-estimated)
} as const;

export const TARGET_CITE = 0.1;
export const TARGET_MENTION = 0.3;

export function ratioClamp(value: number, target: number): number {
  if (target <= 0) return 0;
  return Math.min(Math.max(value / target, 0), 1);
}

function clamp01(v: number): number {
  return Math.min(Math.max(v, 0), 1);
}

/**
 * The CATEGORY sub-metrics for an engine row, with a fallback to the full-prompt
 * figures for snapshots captured before `category` existed on this record. One
 * definition, shared by the scoring maths and the presenter, so the headline tile
 * and the cards under it can never disagree about their denominator (QA F10 / CD-B3).
 */
export function categoryMetrics(e: PerEngineVisibility): SubMetrics {
  return (
    e.category ?? {
      promptsMeasured: e.promptsMeasured,
      mentionRate: e.mentionRate,
      citationRate: e.citationRate,
      firstPositionRate: e.firstPositionRate,
      shareOfVoice: e.shareOfVoice,
      netSentiment: e.netSentiment,
      ghostCitationRate: e.ghostCitationRate,
      topCompetitor: e.topCompetitor,
      brandMentions: e.brandMentions,
    }
  );
}

/**
 * Per-engine geo-score-v3 sub-score, 0..1 (each signal normalized to 0..1 first).
 *
 * QA F10 — two corrections to the ported model, both about honesty rather than
 * weighting:
 *  (1) Inputs are the CATEGORY sub-metrics, not the full prompt set. The brand and
 *      navigational questions name the client by construction, so the headline used
 *      to show a positive grade next to an engine card of zeros, while claiming to
 *      be "the number the fixes below are designed to move" — those fixes derive
 *      from the category metrics. Also the CD-B3 rule: branded queries never feed a
 *      client-vs-competitor number.
 *  (2) The sentiment term only counts when the brand was actually mentioned.
 *      netSentiment is 0 for an unmentioned brand, which maps to the neutral 0.5
 *      midpoint and awarded 5/100 for having no presence at all — contradicting
 *      this file's own rule, stated three times, that ESTIMATED signals never enter
 *      a grade. The weights themselves are untouched (the a3 model is the recorded
 *      baseline); zero presence now scores zero.
 */
export function engineVisibilityScore(e: PerEngineVisibility): number {
  const c = categoryMetrics(e);
  return (
    APPEARANCE_LED_WEIGHTS.appearance * clamp01(c.mentionRate) +
    APPEARANCE_LED_WEIGHTS.citation * clamp01(c.citationRate) +
    APPEARANCE_LED_WEIGHTS.firstPosition * clamp01(c.firstPositionRate) +
    APPEARANCE_LED_WEIGHTS.shareOfRoster * clamp01(c.shareOfVoice / 100) +
    (c.mentionRate > 0 ? APPEARANCE_LED_WEIGHTS.sentiment * clamp01((c.netSentiment + 1) / 2) : 0)
  );
}

export interface VisibilityIndexResult {
  /** 0–100 int: appearance-led mean over engines captured this run. */
  index: number;
  /** Model label (matches run-record `geo_visibility_model`). */
  model: string;
  /** Engines included in the mean (returned an answer this run). */
  enginesScored: number;
  /** First-party MEASURED / MEASURED_grounded engines among those scored. */
  enginesMeasured: number;
  /** Total engines in the roster (for the "N of M" disclosure). */
  enginesTotal: number;
  /** enginesScored / enginesTotal, 0–100 (UI coverage bar). */
  dataCoveragePct: number;
  /** Per-engine 0–100 sub-score with provenance (chart series). */
  perEngineScore: Array<{ engine: EngineId; source: ProviderSource | null; tier: CaptureTier; score: number }>;
}

/**
 * Appearance-led visibility index across every engine captured this run. Engines
 * that returned no answer (UNAVAILABLE) are excluded from the mean and surfaced via
 * enginesScored / enginesTotal — mirroring the run contract's "N of 5 engines
 * measured" disclosure rather than a renormalized coverage grade.
 */
export function computeVisibilityIndex(
  perEngine: PerEngineVisibility[],
  enginesTotal = perEngine.length,
): VisibilityIndexResult {
  // Scored on CATEGORY questions (F10), so an engine that only answered branded
  // questions contributes nothing rather than a guaranteed-hit inflation.
  const live = perEngine.filter(
    (e) => e.captureTier !== "UNAVAILABLE" && categoryMetrics(e).promptsMeasured > 0,
  );
  const index = live.length
    ? Math.round((live.reduce((a, e) => a + engineVisibilityScore(e), 0) / live.length) * 100)
    : 0;
  return {
    index,
    model: GEO_VISIBILITY_MODEL,
    enginesScored: live.length,
    enginesMeasured: live.filter((e) => e.captureTier === "MEASURED" || e.captureTier === "MEASURED_grounded").length,
    enginesTotal: enginesTotal || live.length,
    dataCoveragePct: enginesTotal ? Math.round((live.length / enginesTotal) * 100) : 0,
    perEngineScore: live.map((e) => ({
      engine: e.engine,
      source: e.source,
      tier: e.captureTier,
      score: Math.round(engineVisibilityScore(e) * 100),
    })),
  };
}

/**
 * Client share among the LOCKED roster (client + tracked competitors) across every
 * measured answer this run, as a percentage — the run-record `roster_share_pct`.
 *
 * @param isCategory predicate marking a prompt as a category (non-brand,
 *   non-navigational) question — only those count toward the share. Brand/nav
 *   prompts name the client by construction and would otherwise inflate this to a
 *   near-meaningless number even when every competitor sits at 0 (QA Fix 2: the
 *   same like-for-like rule as computePerEngineVisibility's `category`).
 *
 *   REQUIRED, unlike the sibling predicates (CD-J1 directive 3). This number is
 *   rendered to clients as "your share of the conversation" with nothing else to
 *   qualify it, and there is no honest reading of it over the full prompt set — so
 *   the scope is a parameter you cannot forget rather than one you should remember.
 */
export function computeRosterSharePct(
  probes: GeoProbe[],
  gazetteer: Gazetteer,
  isCategory: (prompt: string) => boolean,
): number {
  const clientName = gazetteer.client[0];
  const roster = [clientName, ...Object.keys(gazetteer.competitors)];
  const counts = new Map<string, number>(roster.map((b) => [b, 0]));
  for (const p of probes) {
    if (p.captureTier === "UNAVAILABLE") continue;
    if (!isCategory(p.prompt)) continue;
    for (const b of p.mentionedBrands) counts.set(b, (counts.get(b) ?? 0) + 1);
  }
  const total = [...counts.values()].reduce((a, b) => a + b, 0);
  return total ? Math.round(((counts.get(clientName) ?? 0) / total) * 1000) / 10 : 0;
}

/**
 * One presence bucket (run-record `brand_presence` / `category_presence`).
 *
 * Three numbers, because two cannot tell the truth about a partial run:
 *   total    — questions the plan ASKED for in this bucket (the honest denominator)
 *   measured — of those, how many at least one engine actually answered
 *   named    — of the measured ones, how many named the client
 *
 * `measured` is optional only for snapshots written before methodology v2, where
 * `total` already meant "questions with an answer". Read every bucket through
 * `presenceCounts` rather than reaching for the fields, so that legacy reading
 * happens in exactly one place.
 */
export interface PresenceCount {
  named: number;
  total: number;
  measured?: number;
}

/** Brand-prompt vs category-prompt presence. */
export interface PresenceBreakdown {
  brand: PresenceCount;
  category: PresenceCount;
}

/**
 * Normalize a presence bucket to the four numbers every surface needs, applying
 * the legacy rule in one place: a bucket with no `measured` was written before
 * methodology v2, when nothing was counted unless it was measured — so for those,
 * measured IS the total and there is no not-measured remainder to disclose.
 */
export function presenceCounts(p: PresenceCount | undefined): {
  named: number;
  measured: number;
  planned: number;
  notMeasured: number;
} {
  const planned = p?.total ?? 0;
  const measured = p?.measured ?? planned;
  return {
    named: p?.named ?? 0,
    measured,
    planned,
    notMeasured: Math.max(0, planned - measured),
  };
}

/**
 * Split the frozen question set into branded questions (those that name the client)
 * and category questions (those that don't), then count how many of each the brand
 * actually appeared in.
 *
 * CD-J1 directive 1 — A QUESTION NO ENGINE ANSWERED IS NOT A QUESTION WE DIDN'T ASK.
 * This used to derive the whole universe from the probes and skip UNAVAILABLE ones,
 * so a question every engine failed on vanished from the record entirely: the
 * denominator quietly shrank, and "named in 3 of 9" was reported for a 12-question
 * run with three dead cells. A capture bug flattered the score, and the size of the
 * report changed for reasons nothing on the page explained. Passing `promptSet` (the
 * frozen set) fixes the denominator to what was ASKED, and the shortfall surfaces as
 * `total - measured` for the UI to disclose.
 *
 * @param promptSet the frozen question set. Omit only for legacy callers that have
 *   probes but no set — then the universe is every prompt with a probe, including
 *   the all-UNAVAILABLE ones, which is still strictly more honest than before.
 */
export function computePresence(
  probes: GeoProbe[],
  gazetteer: Gazetteer,
  isBrandPrompt: (prompt: string) => boolean = (prompt) =>
    gazetteer.client.some((a) => findMention(prompt, a) >= 0),
  promptSet?: string[],
): PresenceBreakdown {
  const byPrompt = new Map<string, { brand: boolean; measured: boolean; named: boolean }>();
  const ensure = (prompt: string) => {
    let cur = byPrompt.get(prompt);
    if (!cur) {
      cur = { brand: isBrandPrompt(prompt), measured: false, named: false };
      byPrompt.set(prompt, cur);
    }
    return cur;
  };
  // Seed with the plan, so an unanswered question still occupies its slot.
  for (const prompt of promptSet ?? []) ensure(prompt);
  for (const p of probes) {
    const cur = ensure(p.prompt);
    if (p.captureTier === "UNAVAILABLE") continue;
    cur.measured = true;
    if (p.brandMentioned) cur.named = true;
  }

  const brand: PresenceCount = { named: 0, total: 0, measured: 0 };
  const category: PresenceCount = { named: 0, total: 0, measured: 0 };
  for (const v of byPrompt.values()) {
    const bucket = v.brand ? brand : category;
    bucket.total += 1;
    if (v.measured) {
      bucket.measured = (bucket.measured ?? 0) + 1;
      if (v.named) bucket.named += 1;
    }
  }
  return { brand, category };
}

/* ── Site-audit checks (SEO score + GEO readiness) ────────────────── */

/** One audited check, evaluated by the SEO/GEO audit agent from live crawl evidence. */
export interface SeoGeoCheck {
  /** a3 rec id, e.g. "BOTH-01", "SEO-04", "GEO-02". */
  id: string;
  bucket: string;
  label: string;
  /** What was actually observed (URL, HTTP code, measured value). */
  evidence: string;
  /** 0..1 — degree to which the check passes its target. */
  norm: number;
  tier: "MEASURED" | "ESTIMATED" | "PENDING";
  confidence: "CONFIRMED" | "LIKELY" | "HYPOTHESIS";
}

interface CheckDef {
  id: string;
  bucket: string;
  weight: number;
  label: string;
}

/** SEO score check registry — ids, buckets and weights ported from a3-scoring-v2 `scores.seo`. */
export const SEO_CHECKS: CheckDef[] = [
  // Eligibility (35)
  { id: "BOTH-01", bucket: "eligibility", weight: 10, label: "Indexable: pages return 200, no noindex/nosnippet" },
  { id: "BOTH-02", bucket: "eligibility", weight: 8, label: "Main content in crawlable HTML (no auth/paywall/JS-only)" },
  { id: "BOTH-01b", bucket: "eligibility", weight: 7, label: "Robots meta clean across scoped URLs" },
  { id: "BOTH-09", bucket: "eligibility", weight: 5, label: "Valid XML sitemap, referenced in robots.txt, no noindexed entries" },
  { id: "GEO-01", bucket: "eligibility", weight: 5, label: "robots.txt does not block Googlebot / AI opt-out off" },
  // Technical / CWV (25)
  { id: "SEO-04a", bucket: "technicalCwv", weight: 8, label: "LCP p75 ≤ 2.5s" },
  { id: "SEO-04b", bucket: "technicalCwv", weight: 7, label: "INP p75 ≤ 200ms" },
  { id: "SEO-04c", bucket: "technicalCwv", weight: 5, label: "CLS p75 ≤ 0.1" },
  { id: "BOTH-19", bucket: "technicalCwv", weight: 5, label: "Mobile: viewport meta, parity at 360px, no horizontal scroll" },
  // On-page (25)
  { id: "BOTH-03", bucket: "onPage", weight: 5, label: "No content duplication vs top-ranking pages" },
  { id: "SEO-02", bucket: "onPage", weight: 5, label: "Title tags ≤ 60 chars, unique, keyword-placed" },
  { id: "GEO-17", bucket: "onPage", weight: 4, label: "Exactly one H1 per page" },
  { id: "SEO-06", bucket: "onPage", weight: 3, label: "Meta descriptions present, 120–158 chars, unique" },
  { id: "BOTH-05", bucket: "onPage", weight: 4, label: "≥3 internal links per priority page" },
  { id: "GEO-20", bucket: "onPage", weight: 4, label: "Content freshness: genuine dateModified ≤ 90 days" },
  // Structure (15)
  { id: "GEO-02", bucket: "structure", weight: 8, label: "Answer capsules: 40–60 word summary under key H2s" },
  { id: "BOTH-16", bucket: "structure", weight: 7, label: "Scannable sections 120–180 words, none > 300" },
];

/** GEO readiness check registry — ids, buckets and weights ported from `scores.geo_readiness`. */
export const GEO_READINESS_CHECKS: CheckDef[] = [
  // Crawler / snippet access (28)
  { id: "BOTH-01", bucket: "crawlerAccess", weight: 7, label: "Pages 200 + no noindex/nosnippet" },
  { id: "BOTH-02", bucket: "crawlerAccess", weight: 6, label: "Primary content crawlable, path not disallowed" },
  { id: "GEO-01", bucket: "crawlerAccess", weight: 6, label: "AI crawlers allowed: OAI-SearchBot, PerplexityBot, ClaudeBot, Googlebot, Bingbot" },
  { id: "GEO-08", bucket: "crawlerAccess", weight: 5, label: "OAI-SearchBot allowed + site indexed on Bing" },
  { id: "GEO-10", bucket: "crawlerAccess", weight: 4, label: "Entity/about pages open to all AI crawlers" },
  // Extractability (22)
  { id: "GEO-02", bucket: "extractability", weight: 6, label: "Answer capsules under target H2s" },
  { id: "GEO-18", bucket: "extractability", weight: 4, label: "Entity density ~15 recognized entities / 1000 words (no stuffing)" },
  { id: "GEO-17", bucket: "extractability", weight: 3, label: "Clean heading hierarchy, question-form H2/H3s" },
  { id: "BOTH-16", bucket: "extractability", weight: 3, label: "Section length + 'X is' definition + readability" },
  { id: "BOTH-21", bucket: "extractability", weight: 2, label: "No keyword stuffing, one primary intent per URL" },
  { id: "GEO-22", bucket: "extractability", weight: 2, label: "≥3 question H2/H3s with ≤80-word HTML answers" },
  { id: "BOTH-03", bucket: "extractability", weight: 2, label: "Content originality vs top-ranking pages" },
  // Evidence density (15)
  { id: "GEO-03", bucket: "evidenceDensity", weight: 7, label: "Stats + cited sources per section, quotes + outbound cites" },
  { id: "GEO-09", bucket: "evidenceDensity", weight: 5, label: "Inline citations, bylines, original statistics" },
  { id: "BOTH-11", bucket: "evidenceDensity", weight: 3, label: "First-person experience markers + original data" },
  // Freshness (12)
  { id: "GEO-20", bucket: "freshness", weight: 7, label: "dateModified ≤ 30/90 days with real body changes" },
  { id: "GEO-37", bucket: "freshness", weight: 3, label: "Entity/about/pillar pages updated ≤ 90 days" },
  { id: "BOTH-13", bucket: "freshness", weight: 2, label: "Publishing cadence: no gap > 30 days" },
  // Multimodal (5)
  { id: "GEO-19", bucket: "multimodal", weight: 5, label: "Original media on priority pages + complete alt text" },
  // Per-engine index reach (8)
  { id: "GEO-24", bucket: "indexReach", weight: 2, label: "Indexed on Bing + IndexNow key live" },
  { id: "GEO-23", bucket: "indexReach", weight: 2, label: "Indexed on Brave" },
  { id: "GEO-41", bucket: "indexReach", weight: 2, label: "Indexed on Google, AI opt-out off" },
  { id: "BOTH-09", bucket: "indexReach", weight: 2, label: "Sitemap valid + referenced" },
  // Off-site entity (10)
  { id: "GEO-25", bucket: "offsiteEntity", weight: 3, label: "Wikipedia article + Wikidata entity (≥5 statements)" },
  { id: "GEO-04", bucket: "offsiteEntity", weight: 3, label: "≥10 authoritative domains mentioning brand in 90 days" },
  { id: "GEO-07", bucket: "offsiteEntity", weight: 2, label: "Wikidata official-website matches client domain" },
  { id: "GEO-14", bucket: "offsiteEntity", weight: 2, label: "Review footprint: ≥3 platforms, ≥4.0 avg, ≥25 reviews each" },
];

export interface ScoreResult {
  /** 0–100 int over MEASURED checks only. */
  score: number;
  /** measured weight / total weight, 0–100. */
  dataCoveragePct: number;
  buckets: Array<{ bucket: string; weight: number; earned: number; measuredWeight: number }>;
}

/** Score a check set against its registry: Σ weight×norm over measured checks, renormalized. */
export function computeCheckScore(registry: CheckDef[], checks: SeoGeoCheck[]): ScoreResult {
  const byKey = new Map(checks.map((c) => [`${c.id}:${c.bucket}`, c] as const));
  const lookup = (d: CheckDef) => byKey.get(`${d.id}:${d.bucket}`) ?? checks.find((c) => c.id === d.id && !byKey.has(`${c.id}:${c.bucket}`));

  let measuredWeight = 0;
  let earnedWeighted = 0;
  const bucketAgg = new Map<string, { weight: number; earned: number; measuredWeight: number }>();

  for (const def of registry) {
    const agg = bucketAgg.get(def.bucket) ?? { weight: 0, earned: 0, measuredWeight: 0 };
    agg.weight += def.weight;
    const check = lookup(def);
    if (check && check.tier === "MEASURED") {
      const norm = Math.min(Math.max(check.norm, 0), 1);
      measuredWeight += def.weight;
      earnedWeighted += def.weight * norm;
      agg.measuredWeight += def.weight;
      agg.earned += def.weight * norm;
    }
    bucketAgg.set(def.bucket, agg);
  }

  const totalWeight = registry.reduce((a, d) => a + d.weight, 0);
  return {
    score: measuredWeight ? Math.round((earnedWeighted / measuredWeight) * 100) : 0,
    dataCoveragePct: totalWeight ? Math.round((measuredWeight / totalWeight) * 100) : 0,
    buckets: [...bucketAgg.entries()].map(([bucket, a]) => ({ bucket, ...a })),
  };
}

/* ── Gap analysis ─────────────────────────────────────────────────── */

export type GapSeverity = "critical" | "high" | "medium" | "low";

/** The lever a finding sits on (run-record `lever`). */
export type Lever = "SEO" | "GEO" | "BOTH";

/** Actuator hint — matches the run-record `fix_action` enum exactly. */
export type FixAction =
  | "meta_title"
  | "meta_description"
  | "schema"
  | "og_image"
  | "canonical"
  | "image_alt"
  | "sitemap"
  | "indexing"
  | "manual";

/** How a fix ships (run-record `delivery`). */
export type Delivery = "agent-direct" | "existing-product" | "advisory";

/**
 * One search-visibility gap / issue: a failing site check or a competitor visibility
 * delta. Field shape mirrors the run-record `issues[]` producer contract so the
 * fix-actuator can consume it directly (id, lever, severity, title, evidence,
 * confidence, fix_action, target, delivery, product_ref, artifact_ref).
 */
export interface VisibilityGap {
  id: string;
  lever: Lever;
  title: string;
  severity: GapSeverity;
  evidence: string;
  confidence: "CONFIRMED" | "LIKELY" | "HYPOTHESIS";
  /** Actuator hint (run-record `fix_action`). */
  fixAction: FixAction;
  /** Opaque scope/path hint (run-record `target`) — never interpolated into a URL. */
  target: string;
  /** How the fix ships (run-record `delivery`). */
  delivery: Delivery;
  /** Human-readable "what good looks like" (kept for the report/UI). */
  benchmark: string;
  /** What was measured, human-readable. */
  measured: string;
  /** (1 − norm) × weight — ordering heuristic (not part of the run-record). */
  scoreLift: number;
  /** Provider provenance for engine-derived gaps. */
  source?: ProviderSource;
  /** Product mapping (run-record `product_ref`) — null in the SaaS (no rec-catalog here). */
  productRef?: { id: string; folder: string; status: string } | null;
  /** Generated-fix artifact path (run-record `artifact_ref`) — null until the Phase 7 actuator runs. */
  artifactRef?: string | null;
}

/**
 * ONE severity scale for every gap type (QA F22). Site checks derive their lift from
 * registry weight, which runs 0–10; the competitor-visibility gaps used to set their
 * chip independently and produce much smaller numbers on unrelated scales, so a
 * half-failing site check scoring 5 and tagged "important" out-ranked a genuinely
 * urgent visibility gap whose number topped out at 4.5 — under a header promising
 * the list was ordered by impact.
 *
 * Known ceiling, unchanged and deliberate: a site check whose registry weight is
 * below 7 can never reach "urgent" however completely it fails. Changing that means
 * re-tuning the a3 weights, which is out of scope here.
 */
function severityFromLift(lift: number): GapSeverity {
  if (lift >= 7) return "critical";
  if (lift >= 4) return "high";
  if (lift >= 2) return "medium";
  return "low";
}

/**
 * Normalize a visibility shortfall onto the same 0–10 band computeCheckGaps uses.
 * `weight` is chosen so a TOTAL miss lands in the severity the product intends:
 * never named at all is urgent (10), never cited is important (6), and a category
 * leader holding 100% of the conversation to your 0% is urgent (10).
 */
function visibilityLift(shortfall: number, target: number, weight: number): number {
  const ratio = target > 0 ? clamp01(shortfall / target) : 0;
  return Math.round(ratio * weight * 10) / 10;
}

/**
 * Normalize an audit-model evidence string before it is persisted (QA F3a).
 * The model writes free-text markdown ("**robots.txt** (fetched today) has _no_
 * `Disallow` for ClaudeBot"); this strips the markup, collapses whitespace,
 * sentence-cases the opening and gives it terminal punctuation, so no raw model
 * formatting survives into any rendered surface. Pure — applied at the server
 * boundary in intel/seo-geo.ts sanitizeChecks, never at render.
 */
export function normalizeEvidence(raw: string): string {
  let s = (raw ?? "").trim();
  if (!s) return "";
  s = s
    .replace(/!?\[([^\]]*)\]\([^)]*\)/g, "$1") // [text](url) / ![alt](src) → text
    .replace(/`{1,3}([^`]*)`{1,3}/g, "$1") // `code` → code
    .replace(/\*\*([^*]+)\*\*/g, "$1") // **bold** → bold
    .replace(/(^|[\s(])[*_]([^*_\n]+)[*_](?=[\s).,;:!?]|$)/g, "$1$2") // *em* / _em_ → em
    .replace(/^\s*(?:[-*+]|\d+[.)])\s+/gm, "") // list bullets
    .replace(/^\s*#{1,6}\s*/gm, "") // headings
    .replace(/^\s*>\s*/gm, "") // blockquote markers
    .replace(/\s+/g, " ")
    .trim();
  if (!s) return "";
  s = s.charAt(0).toUpperCase() + s.slice(1);
  if (!/[.!?)\]"']$/.test(s)) s += ".";
  return s;
}

/**
 * Derive the lever for a check (QA F16).
 *
 * The channel is a property of the REGISTRY the check is scored in, not of its id
 * prefix. GEO-01, GEO-02, GEO-17 and GEO-20 are entries in the SEARCH score
 * registry (eligibility, on-page, structure buckets), but reading the prefix made
 * them AI-only — the presenter mapped that to the AI channel and the "Search
 * engines" tab silently dropped four of its seventeen checks, so a client reading
 * that tab believed the category was clean when it wasn't.
 *
 * A "BOTH-" prefix is still authoritative: BOTH-05 lives only in SEO_CHECKS, and
 * demoting it to search-only would be the same mis-filing in the other direction.
 * Ids that sit in BOTH registries come out with a different lever per registry and
 * are promoted to "BOTH" by dedupeGapsByRecId, which is where they belong.
 */
export function leverFromId(id: string, fallback: Lever): Lever {
  return id.split(/[-:]/)[0].toUpperCase() === "BOTH" ? "BOTH" : fallback;
}

/** Deterministic check-id → actuator fix_action map (machine-appliable fixes only). */
const FIX_ACTION_BY_ID: Record<string, FixAction> = {
  "SEO-02": "meta_title",
  "SEO-06": "meta_description",
  "BOTH-07": "canonical",
  "BOTH-09": "sitemap",
  "GEO-20": "sitemap",
  "GEO-19": "image_alt",
  "BOTH-01": "indexing",
  "GEO-01": "indexing",
  "GEO-08": "indexing",
  "GEO-41": "indexing",
  "GEO-24": "indexing",
  "GEO-23": "indexing",
};

export function fixActionFor(id: string): FixAction {
  return FIX_ACTION_BY_ID[id.split(/[-:]/).slice(0, 2).join("-")] ?? FIX_ACTION_BY_ID[id.split(":")[0]] ?? "manual";
}

/** Off-site entity work is advisory; index-reach needs a connector; everything else is agent-direct. */
function deliveryForBucket(bucket: string): Delivery {
  if (bucket === "offsiteEntity") return "advisory";
  if (bucket === "indexReach") return "existing-product";
  return "agent-direct";
}

/** Coarse, opaque target-scope hint per bucket (never a live URL). */
function targetForBucket(bucket: string): string {
  if (bucket === "offsiteEntity") return "off-site";
  if (bucket === "indexReach") return "sitemap.xml / search index";
  if (bucket === "freshness") return "sitemap.xml + content pages";
  return "site-wide";
}

/** Failing site checks (norm < 1) → prioritized gap/issue list in the run-record shape. */
export function computeCheckGaps(
  registry: CheckDef[],
  checks: SeoGeoCheck[],
  fallbackLever: Lever,
): VisibilityGap[] {
  const defs = new Map(registry.map((d) => [d.id, d] as const));
  return checks
    .filter((c) => c.tier === "MEASURED" && c.norm < 1)
    .map((c) => {
      const def = defs.get(c.id);
      const weight = def?.weight ?? 2;
      const lift = (1 - Math.min(Math.max(c.norm, 0), 1)) * weight;
      const bucket = def?.bucket ?? c.bucket;
      return {
        id: c.id,
        lever: leverFromId(c.id, fallbackLever),
        title: def?.label ?? c.label,
        severity: severityFromLift(lift),
        evidence: c.evidence,
        confidence: c.confidence,
        fixAction: fixActionFor(c.id),
        target: targetForBucket(bucket),
        delivery: deliveryForBucket(bucket),
        benchmark: def?.label ?? c.label,
        measured: c.evidence,
        scoreLift: Math.round(lift * 10) / 10,
        productRef: null,
        artifactRef: null,
      };
    })
    .sort((a, b) => b.scoreLift - a.scoreLift);
}

/**
 * Collapse gaps that describe the SAME defect (QA F11).
 *
 * Nine check ids sit in BOTH registries with different labels and different
 * weights (BOTH-01, BOTH-02, BOTH-03, BOTH-09, BOTH-16, GEO-01, GEO-02, GEO-17,
 * GEO-20), and the audit prompt instructs the model to return every id from both.
 * The pipeline then runs computeCheckGaps once per registry, so one real defect
 * emitted two cards — and because severity is (1 − norm) × registry weight, and the
 * weights differ between registries, the two cards carried DIFFERENT priority chips
 * for the identical underlying problem (sitemap: important vs moderate; freshness:
 * important vs urgent; scannable sections: urgent vs moderate).
 *
 * Survivor keeps the higher scoreLift (hence the higher severity, which derives from
 * it) and is promoted to lever "BOTH" when the group disagrees — a defect that both
 * registries measure genuinely affects both channels, and channel "both" already
 * renders under both filter tabs.
 *
 * Keyed on the FULL id, not `id.split(":")[0]` as the spec's shorthand suggested:
 * the competitor-visibility gaps are per-engine (`GEO-27:chatgpt`,
 * `GEO-11:gemini`), and prefix-keying would silently merge five engines' findings
 * into one card. Registry duplicates carry bare ids, so full-id keying collapses
 * exactly the duplicates and nothing else.
 */
export function dedupeGapsByRecId(gaps: VisibilityGap[]): VisibilityGap[] {
  const byId = new Map<string, VisibilityGap>();
  const levers = new Map<string, Set<Lever>>();
  const order: string[] = [];
  for (const gap of gaps) {
    const seenLevers = levers.get(gap.id) ?? new Set<Lever>();
    seenLevers.add(gap.lever);
    levers.set(gap.id, seenLevers);
    const held = byId.get(gap.id);
    if (!held) {
      byId.set(gap.id, gap);
      order.push(gap.id);
    } else if (gap.scoreLift > held.scoreLift) {
      byId.set(gap.id, gap);
    }
  }
  return order.map((id) => {
    const gap = byId.get(id)!;
    const seen = levers.get(id)!;
    return seen.size > 1 ? { ...gap, lever: "BOTH" as Lever } : gap;
  });
}

/**
 * Competitor-vs-client visibility gaps computed from the multi-engine capture.
 * The a3 agent does not emit explicit gap values, so this is the utility logic that
 * derives them from the collected competitor vs client data (per requirement).
 */
export function computeVisibilityGaps(perEngine: PerEngineVisibility[]): VisibilityGap[] {
  const gaps: VisibilityGap[] = [];
  for (const e of perEngine) {
    if (e.captureTier === "UNAVAILABLE") continue;
    // Gaps reflect CATEGORY visibility (real market reality), not brand-prompt
    // inflation. Read through the shared accessor, not `e.category` directly, so a
    // record predating that field degrades to its full-set figures like every other
    // category-scoped surface instead of throwing (CD-B3/CD-J1 directive 3).
    const c = categoryMetrics(e);
    if (c.promptsMeasured === 0) continue;
    const label = ENGINE_LABELS[e.engine];
    const src = e.source ?? undefined;

    // Off-site visibility fixes are advisory content/outreach work, never a
    // machine-appliable on-page action.
    const base = { delivery: "advisory" as Delivery, fixAction: "manual" as FixAction, target: "off-site", confidence: "CONFIRMED" as const, source: src, productRef: null, artifactRef: null };

    if (c.topCompetitor && c.topCompetitor.shareOfVoice > c.shareOfVoice) {
      const delta = c.topCompetitor.shareOfVoice - c.shareOfVoice;
      // F22: one scale. A leader holding 100% to your 0% is the total miss = 10.
      const sovLift = visibilityLift(delta, 100, 10);
      gaps.push({
        ...base,
        id: `GEO-27:${e.engine}`,
        lever: "GEO",
        title: `Share-of-voice gap on ${label}: ${c.topCompetitor.name} leads by ${Math.round(delta)} pts`,
        severity: severityFromLift(sovLift),
        measured: `${Math.round(c.shareOfVoice)}% share of voice (vs ${c.topCompetitor.name} at ${Math.round(c.topCompetitor.shareOfVoice)}%)`,
        benchmark: `≥ ${Math.round(c.topCompetitor.shareOfVoice)}% (match category leader)`,
        scoreLift: sovLift,
        evidence: `Measured across ${c.promptsMeasured} category questions answered by ${label}`,
      });
    }
    if (c.mentionRate < TARGET_MENTION) {
      // Never named at all is the total miss = 10 → urgent, as before, but now
      // derived from the number the list is sorted by rather than set beside it.
      const mentionLift = visibilityLift(TARGET_MENTION - c.mentionRate, TARGET_MENTION, 10);
      gaps.push({
        ...base,
        id: `GEO-35:${e.engine}`,
        lever: "GEO",
        title: `Low named-mention rate on ${label}`,
        severity: severityFromLift(mentionLift),
        // F133: counts, with the denominator, in the same unit the engine cards and
        // the citation footer use — never a bare percentage against an unstated set.
        measured: `Named in ${Math.round(c.mentionRate * c.promptsMeasured)} of ${c.promptsMeasured} ${label} category answers`,
        benchmark: `≥ ${TARGET_MENTION * 100}% of category answers`,
        scoreLift: mentionLift,
        evidence: `${c.promptsMeasured} category questions probed on ${label}`,
      });
    }
    if (c.citationRate < TARGET_CITE) {
      // Never cited at all is important, not urgent — weight 6 puts a total miss
      // at the top of the "high" band, matching the severity this gap always had.
      const citeLift = visibilityLift(TARGET_CITE - c.citationRate, TARGET_CITE, 6);
      gaps.push({
        ...base,
        id: `GEO-11:${e.engine}`,
        lever: "GEO",
        title: `Site never cited as a source by ${label}`,
        severity: severityFromLift(citeLift),
        measured: `Cited in ${Math.round(c.citationRate * c.promptsMeasured)} of ${c.promptsMeasured} ${label} category answers`,
        benchmark: `≥ ${TARGET_CITE * 100}% citation share`,
        scoreLift: citeLift,
        evidence: `${c.promptsMeasured} category questions probed on ${label}`,
      });
    }
  }
  return gaps.sort((a, b) => b.scoreLift - a.scoreLift);
}

/* ── Client-facing recommendations (dev-handoff §3b) ──────────────── */

/** The control a plan item renders (dev-handoff §3b action_kind). */
export type ActionKind = "one_click" | "review_approve" | "connect" | "guided_manual";
export type RecImpact = "high" | "medium" | "low";

/**
 * A CLIENT-FACING action-plan item (dev-handoff §3b `recommendations[]`). This is the
 * ONLY plan shape a client ever sees — it deliberately excludes every internal
 * producer/actuator field (§4: no fix_action, delivery, confidence, evidence, target,
 * id). Those stay on the internal VisibilityGap and are resolved server-side.
 */
export interface Recommendation {
  /** Opaque id (client never sees it rendered; used server-side to resolve the fix). */
  recId: string;
  /** Plain-English, verb-first action title (QA Fix 7 — no thresholds/HTML attrs). */
  title: string;
  /** One-line "what it entails" shown on hover/expand (QA Fix 7). */
  description: string;
  /** Owner + interaction model line, e.g. "Karos SEO & GEO · we draft, you approve". */
  owner: string;
  vertical: Lever;
  impact: RecImpact;
  /** Which control the row renders. */
  actionKind: ActionKind;
  /** Where the fix lands ("site" | "off-site" | "search-console"). */
  targetPlatform: string;
  /** Whether the owning product is live (chip is actionable) vs advisory. */
  live: boolean;
}

const MACHINE_APPLIABLE: ReadonlySet<FixAction> = new Set([
  "meta_title",
  "meta_description",
  "canonical",
  "sitemap",
  "image_alt",
  "indexing",
  "schema",
  "og_image",
]);

function actionKindFor(gap: VisibilityGap): ActionKind {
  if (gap.delivery === "advisory") return "guided_manual";
  if (gap.delivery === "existing-product") return "connect"; // needs a connected credential (e.g. GSC)
  return MACHINE_APPLIABLE.has(gap.fixAction) ? "one_click" : "review_approve";
}

function impactFor(severity: GapSeverity): RecImpact {
  return severity === "critical" || severity === "high" ? "high" : severity === "medium" ? "medium" : "low";
}

/**
 * Plain-English client copy per a3 rec id (QA Fix 7 — the Sitti one-pager voice: a verb-first
 * action title + what it entails). Keyed by the id prefix (before any ":").
 *
 * THE COPY BAR (CD-J1 directive 5). Every line here is read by a client who is being
 * asked to click Approve, and the Karos Labs list is the standard: "Add short
 * plain-English summaries under your main headings so AI engines can quote you" —
 * not "Answer capsules: 40–60 word summary under key H2s". Concretely:
 *
 *   - OUTCOME FIRST, MECHANISM ONLY FOR STAFF. Say what changes for them and why it
 *     matters. The thresholds, attribute names and protocol vocabulary belong to the
 *     staff-only technical block on the gap behind this row, which carries the
 *     measured value and the benchmark verbatim — so nothing is lost by leaving them
 *     out here, and the client is not asked to approve a spec they can't read.
 *   - NO NUMERIC SPECS in client copy ("under 60 characters", "120–180 words",
 *     "40–60 word"). A client cannot act on a threshold; they are approving that we
 *     go and fix it.
 *   - NO MARKUP OR PROTOCOL NAMES (H1, canonical tag, noindex, alt text, crawler,
 *     index, robots.txt). Describe the thing in words a non-specialist owns.
 *   - NO PRODUCT HISTORY, no client-specific nouns. These strings are shared by every
 *     client; one of them used to name "the guides page" from the account it was
 *     written for.
 *
 * Ids are STABLE — approvals persist against them (`approvedRecIds`). Rewording an
 * entry is safe; renaming a key silently orphans an approval.
 *
 * COVERAGE IS THE CONTRACT (QA F9): every id in SEO_CHECKS and GEO_READINESS_CHECKS must
 * have an entry here, because an uncovered id used to fall through to the internal
 * registry label — client-facing card titles like "LCP p75 ≤ 2.5s". Pinned by a unit test
 * in src/lib/__tests__/seo-geo.test.ts; add copy here whenever you add a check.
 * Ids the audit model invents that are in neither registry get REC_FALLBACK, never the
 * model's own label.
 */
export const REC_COPY: Record<string, { title: string; description: string }> = {
  "BOTH-07": { title: "Stop your pages handing their credit to another page", description: "One of your pages tells search engines that a different page is the real version of it, so everything it earns is credited elsewhere. Pointing it back at itself keeps the credit where the work is." },
  "SEO-02": { title: "Tighten your page titles", description: "Your page titles are being cut off in search results. Make each one shorter, different from the others, and lead with the words buyers actually type." },
  "SEO-06": { title: "Write the summary that appears under your search result", description: "The blurb under your link in search results is missing, cut off, or repeated across pages. A clear, distinct summary per page is what makes someone click yours instead of the next one." },
  "GEO-17": { title: "Give every page one clear headline", description: "Each page should open with a single headline that says what the page is about. Search and AI engines read it first to decide what the page answers." },
  "GEO-20": { title: "Show when your pages were really updated", description: "The dates you publish for engines don't match when the pages actually changed. Engines stop trusting those dates, and genuinely fresh work stops reading as fresh." },
  "GEO-02": { title: "Open each page with a short, quotable answer", description: "Start each page with a few plain sentences answering the question it's about, complete on their own. That opening is what AI assistants lift and quote." },
  "GEO-03": { title: "Back up what your pages claim", description: "Add real numbers, named sources, and quotes to each section. Evidence is what makes an engine quote your page instead of somebody else's." },
  "GEO-09": { title: "Put a real author and real numbers on your pages", description: "Pages that say who wrote them, show where their facts came from, and include at least one figure of your own get trusted and credited. Anonymous pages get passed over." },
  "BOTH-16": { title: "Break your pages into short, scannable sections", description: "Long unbroken text gives engines nothing clean to pull out. Shorter sections, each opening with a one-line explanation, are what they lift answers from." },
  "GEO-22": { title: "Use your buyers' questions as your headings", description: "Phrase key headings as the questions people actually ask, each followed by a short direct answer. That's how an AI matches your page to what someone asked it." },
  "GEO-25": { title: "Establish a clear public record of who you are", description: "Create a Wikidata entry (and a Wikipedia article once you qualify) so every engine knows which company you are and stops confusing you with similarly-named ones." },
  "GEO-04": { title: "Get talked about on sites engines trust", description: "Get named on independent, reputable sites. Engines repeat what trusted third parties say about you far more readily than what you say about yourself." },
  "GEO-14": { title: "Build a review presence you don't own", description: "Get reviews across several independent platforms, so \"are they any good?\" is answered by more than your own website." },
  "BOTH-01": { title: "Make sure your pages can be listed at all", description: "Some pages are either failing to load for engines or carrying an instruction telling them not to list the page. Until that's cleared, no other work can make those pages appear." },
  "GEO-27": { title: "Close the gap with the competitor engines name most", description: "A competitor you track is named far more often than you on the questions buyers actually ask. Earning mentions in the sources those answers draw from is what closes it." },
  "GEO-35": { title: "Get named when buyers ask about your category", description: "Buyers asking about your category — without naming you — rarely hear about you. Comparison pages of your own, plus getting mentioned on other people's sites, is what changes that." },
  "GEO-11": { title: "Get the engines quoting your site", description: "The engines don't yet use your site as a source when they answer questions about your category. Pages with clear facts and clear sourcing are the ones they quote." },
  // ── QA F9: the 22 registry ids that used to fall through to their engineering label ──
  "BOTH-01b": { title: "Clear the hidden 'do not list' flags", description: "Some pages carry an instruction telling engines not to list or quote them. Remove it from the pages you want buyers to find." },
  "BOTH-02": { title: "Serve your main content as plain HTML", description: "Content that only appears after a login, behind a paywall, or once scripts run is invisible to engines. They read the raw page, so anything they can't see doesn't count." },
  "BOTH-03": { title: "Make your content original", description: "Pages that closely echo what already ranks give engines no reason to pick yours. Add your own data, examples, and point of view." },
  "BOTH-05": { title: "Link your important pages to each other", description: "Each priority page should link out to a few others on your site. Internal links show engines which pages matter and how they relate." },
  "BOTH-09": { title: "Publish a clean map of your site", description: "Engines rely on a list of every page you want found. Yours needs to be readable, easy for them to locate, and free of pages you've already asked them to skip." },
  "BOTH-11": { title: "Show first-hand experience", description: "Say what you actually did, tested, or measured, and show your own numbers. Engines increasingly favour content with real experience behind it." },
  "BOTH-13": { title: "Publish on a steady cadence", description: "Gaps longer than a month make a site look dormant. A predictable publishing rhythm keeps engines coming back to check for new answers." },
  "BOTH-19": { title: "Make the phone version match the desktop one", description: "Phone visitors should get the same content with no sideways scrolling. Search and AI engines judge your site on its mobile version." },
  "BOTH-21": { title: "Give each page one job", description: "A page chasing several topics at once wins none of them. Keep one clear purpose per page and drop repeated keyword padding." },
  "SEO-04a": { title: "Speed up how fast your pages appear", description: "Your main content should be visible within about two and a half seconds. Slow pages lose readers before they read anything." },
  "SEO-04b": { title: "Make your pages respond faster to taps", description: "When someone taps or clicks, the page should react almost immediately. Lag here frustrates visitors and counts against you in search." },
  "SEO-04c": { title: "Stop your pages jumping while they load", description: "Content that shifts as images and banners arrive makes people mis-tap. Reserve the space they'll occupy so the page settles as it loads." },
  "GEO-01": { title: "Let search engines and AI assistants read your site", description: "One settings file on your site decides who is allowed to read it. If the search engines and AI assistants are turned away there, nothing else you do can make you appear." },
  "GEO-07": { title: "Point your public record at your own website", description: "Your Wikidata entry should list your real website as the official one. While it doesn't, engines credit your work to whichever site is listed instead." },
  "GEO-08": { title: "Get listed where ChatGPT looks", description: "ChatGPT finds pages through Bing and through its own reader. Missing from either means it can't surface you even when you're the right answer." },
  "GEO-10": { title: "Let AI assistants read your about pages", description: "Your about and company pages are where engines learn who you are. Blocking them leaves the assistants guessing at your identity." },
  "GEO-18": { title: "Name the things you're actually talking about", description: "Use the real names of your products, places, people, and partners instead of vague wording, so engines can connect your pages to what buyers ask about. Naturally — not stuffed in." },
  "GEO-19": { title: "Use your own images, and describe them", description: "Swap stock photography for your own visuals, and add a written description to each one so engines can tell what the image shows." },
  "GEO-23": { title: "Get your pages into Brave's search results", description: "Brave searches its own independent set of pages, which some assistants draw on. Being absent there is a blind spot no other fix covers." },
  "GEO-24": { title: "Get your pages into Bing's search results", description: "Bing feeds several AI assistants. Submitting your site and switching on its fast-update option gets new pages picked up in days rather than weeks." },
  "GEO-37": { title: "Keep your most important pages current", description: "Your about page and main topic pages should be revisited every few months. Engines treat pages left untouched for a long time as less reliable." },
  "GEO-41": { title: "Confirm Google can list and quote you", description: "Check your pages are in Google's index and that you haven't opted out of its AI answers — that opt-out is easy to leave switched on by accident." },
};

/**
 * Last-resort client copy for an id in neither registry nor REC_COPY (the audit model
 * occasionally invents one). Deliberately says nothing specific rather than echoing the
 * model's own label into a client-facing card title (QA F3c / F9).
 */
const REC_FALLBACK = {
  title: "A technical finding your team is reviewing",
  description:
    "Our audit flagged something on your site that doesn't map to a standard check yet. Your Karos team reviews it and turns it into a plain-English action on your next refresh.",
} as const;

function ownerFor(actionKind: ActionKind): string {
  switch (actionKind) {
    case "connect":
      return "You connect · we handle the rest";
    case "guided_manual":
      return "Advisory · we draft the kit, a person ships it";
    default:
      return "Karos SEO & GEO · we draft, you approve";
  }
}

/**
 * Derive the client-safe action plan from the internal gaps. Deduped, ordered by score
 * lift (highest impact first). The internal gap fields never cross into the returned
 * objects — only the §3b render contract does; titles/descriptions are plain-English.
 */
/** Display order for the plan's impact badges (QA F22). */
const SEVERITY_ORDER: Record<GapSeverity, number> = { critical: 0, high: 1, medium: 2, low: 3 };

export function buildRecommendations(gaps: VisibilityGap[], limit = 10): Recommendation[] {
  const seen = new Set<string>();
  const out: Recommendation[] = [];
  // F22: the client's plan is headed "Ordered by expected impact on your scores",
  // so the impact badge on a row must agree with where that row sits. Severity
  // first, lift as the tie-breaker — same rule as the staff gap list.
  const ordered = [...gaps].sort(
    (a, b) =>
      (SEVERITY_ORDER[a.severity] ?? 4) - (SEVERITY_ORDER[b.severity] ?? 4) ||
      b.scoreLift - a.scoreLift,
  );
  for (const gap of ordered) {
    // REC_COPY covers every registry id (pinned by test); REC_FALLBACK catches
    // model-invented ids so a raw engineering label can never become a card title (F9).
    const copy = REC_COPY[gap.id.split(":")[0]] ?? REC_FALLBACK;
    const title = copy.title;
    const key = title.toLowerCase().trim();
    if (seen.has(key)) continue;
    seen.add(key);
    const actionKind = actionKindFor(gap);
    out.push({
      recId: gap.id,
      title,
      // Never `gap.benchmark` — that is the internal registry label (F3b/F9).
      description: copy.description,
      owner: ownerFor(actionKind),
      vertical: gap.lever,
      impact: impactFor(gap.severity),
      actionKind,
      targetPlatform: actionKind === "connect" ? "search-console" : gap.target === "off-site" ? "off-site" : "site",
      live: gap.delivery !== "advisory",
    });
    if (out.length >= limit) break;
  }
  return out;
}

/* ── Answer grid + citation leaderboard (PDF/report contract) ─────── */

/** Buyer-intent taxonomy from the a3 report (the DISC/COMP/PROB/BRAND/NAV tags). */
export type PromptIntent = "discovery" | "comparison" | "problem" | "brand" | "navigational";

/** Short label used in the report grid (matches the PDF's DISC/COMP/PROB/BRAND/NAV). */
export const INTENT_LABELS: Record<PromptIntent, string> = {
  discovery: "DISC",
  comparison: "COMP",
  problem: "PROB",
  brand: "BRAND",
  navigational: "NAV",
};

export interface IntentPrompt {
  prompt: string;
  intent: PromptIntent;
}

/**
 * Deterministically classify a buyer-intent prompt into the a3 taxonomy. Order is
 * significant, mirroring the PDF:
 *   navigational (points at the site) → comparison ("X alternative"/"best app",
 *   which stays COMP even when it names the brand, e.g. "Workfrom alternative") →
 *   brand (names the client, no comparison signal) → problem ("how/near me/right
 *   now") → discovery (the default "best X"). A bare "?" is NOT treated as problem —
 *   most discovery/comparison queries are also questions.
 */
export function classifyIntent(prompt: string, gazetteer: Gazetteer): PromptIntent {
  const p = prompt.toLowerCase();
  if ((gazetteer.clientDomain && p.includes(gazetteer.clientDomain)) || /\bofficial (site|website)\b/.test(p)) {
    return "navigational";
  }
  if (/\b(vs\.?|alternative|compare|comparison|best app|app to|apps? (for|to)|which app)\b/.test(p)) return "comparison";
  if (gazetteer.client.some((a) => findMention(prompt, a) >= 0)) return "brand";
  if (/\b(how (do|can|to)|near me|right now|can i find|where can i)\b/.test(p)) return "problem";
  return "discovery";
}

export function tagPromptIntents(prompts: string[], gazetteer: Gazetteer): IntentPrompt[] {
  return prompts.map((prompt) => ({ prompt, intent: classifyIntent(prompt, gazetteer) }));
}

/* ── The question plan (methodology v2 — CD-J1 directive 1) ───────────
 *
 * WHY A FIXED PLAN AT ALL. Before this, the final question set was whatever
 * survived the drafter: the model returned a pool, the pool was deduped, and the
 * per-intent quota took "up to" its share of whatever was there. A thin pool in one
 * intent produced a short set, and a set of a different SHAPE — so one client was
 * measured on 8 branded + 12 category questions and the next on 4 + 11. Every
 * client-facing ratio hangs off those denominators, which made "named in 0 of 12"
 * and "named in 0 of 16" incomparable numbers wearing the same clothes. Neither the
 * client nor we could say what a score meant, and no two clients could be compared.
 *
 * THE COUNTS, AND WHY THESE ONES. The plan below is the a3 Phase-1 quota that the
 * generator was already aiming at — 6 discovery + 5 comparison + 5 problem branded
 * off 3 brand + 1 navigational — now a floor as well as a ceiling. It is deliberately
 * category-heavy: 16 of the 20 questions never say the client's name.
 *
 *   - CATEGORY questions (16) are the measurement. Every client-vs-competitor number
 *     in the product is computed on these alone (CD-B3), because a question that
 *     contains your name names you by construction. 16 is the largest category block
 *     that fits a 20-question run, and a bigger denominator is a steadier score:
 *     one lucky answer moves a 16-question rate by 6 points, a 12-question rate by 8.
 *   - BRANDED questions (4) are a control, not a score. They answer "do the engines
 *     know who this brand is at all?", which is the difference between a visibility
 *     problem and a recognition problem. 4 is enough to read that signal; spending
 *     more of the run on questions the client is guaranteed to win buys nothing.
 *
 * (The directive floated "e.g. 8 branded + 12 category" as an illustration of the
 * FORM. Implemented as the generator's own natural sizes, per the same sentence,
 * because moving four questions from the category block to the branded one shrinks
 * the only denominator anyone is scored on in order to grow the one nobody is.)
 *
 * THE CONTRACT. A capture MUST emit exactly these counts — `buildQuestionSet` pads
 * from a deterministic template bank and trims to the quota, so a thin or lopsided
 * model pool can no longer change the shape of the measurement. Engine failures are
 * a DISPLAY concern and never shrink a denominator: see `computePresence`, where a
 * question no engine answered is counted as planned-but-not-measured rather than
 * dropped out of the set.
 */
export const INTENT_QUOTA: Record<PromptIntent, number> = {
  discovery: 6,
  comparison: 5,
  problem: 5,
  brand: 3,
  navigational: 1,
};

/** Intents whose questions never name the client — the measurement base (CD-B3). */
export const CATEGORY_INTENTS: readonly PromptIntent[] = ["discovery", "comparison", "problem"];
/** Intents whose questions name the client by construction — the control block. */
export const BRANDED_INTENTS: readonly PromptIntent[] = ["brand", "navigational"];

const sumQuota = (intents: readonly PromptIntent[]) =>
  intents.reduce((a, i) => a + INTENT_QUOTA[i], 0);

/** Category (non-branded) questions every capture must ask: 16. */
export const PLANNED_CATEGORY_QUESTIONS = sumQuota(CATEGORY_INTENTS);
/** Branded questions every capture must ask: 4. */
export const PLANNED_BRANDED_QUESTIONS = sumQuota(BRANDED_INTENTS);
/** Total questions every capture must ask: 20. */
export const PLANNED_QUESTIONS_TOTAL = PLANNED_CATEGORY_QUESTIONS + PLANNED_BRANDED_QUESTIONS;

/**
 * Version of the question methodology a snapshot was measured under, stamped onto
 * the record so an old capture is read by its own rules rather than reinterpreted
 * by today's (the CD-B4 legacy discipline). Bump this whenever the plan above, or
 * what counts toward a denominator, changes.
 *
 * v2 (2026-07-29) is the first version with a fixed plan; anything without a stamp
 * was measured under "whatever the drafter returned" and its denominators are
 * descriptive of that one run, not of a standard.
 */
export const SEO_GEO_METHODOLOGY_VERSION = "q2-2026-07-29";

/** Word-set of a prompt (ignoring stop-word noise would over-merge; keep it simple). */
function tokenSet(s: string): Set<string> {
  return new Set(s.toLowerCase().replace(/[^a-z0-9\s]/g, " ").split(/\s+/).filter(Boolean));
}

function jaccard(a: Set<string>, b: Set<string>): number {
  if (!a.size || !b.size) return 0;
  let inter = 0;
  for (const x of a) if (b.has(x)) inter++;
  return inter / (a.size + b.size - inter);
}

/**
 * Drop near-duplicate prompts (a3 Phase-1 dedupe). Uses word-set Jaccard — robust for the
 * short questions here where ordered n-grams under-fire — keeping the first of any pair
 * whose overlap ≥ `threshold` (so "best cafes to work from in X" and "best cafes to work
 * from around X" don't both survive).
 */
export function dedupeNearDuplicates(prompts: string[], threshold = 0.7): string[] {
  const kept: Array<{ p: string; ts: Set<string> }> = [];
  for (const p of prompts) {
    const ts = tokenSet(p);
    if (kept.some((k) => jaccard(k.ts, ts) >= threshold)) continue;
    kept.push({ p, ts });
  }
  return kept.map((k) => k.p);
}

/**
 * Select a balanced final prompt set from a larger pool by per-intent quota (a3 Phase-1),
 * then backfill any shortfall from the leftovers. Preserves input order within each intent.
 */
export function selectByIntentQuota(prompts: string[], gazetteer: Gazetteer, total: number): string[] {
  const byIntent = new Map<PromptIntent, string[]>();
  for (const p of prompts) {
    const intent = classifyIntent(p, gazetteer);
    (byIntent.get(intent) ?? byIntent.set(intent, []).get(intent)!).push(p);
  }
  const out: string[] = [];
  for (const [intent, quota] of Object.entries(INTENT_QUOTA) as Array<[PromptIntent, number]>) {
    out.push(...(byIntent.get(intent) ?? []).slice(0, quota));
  }
  if (out.length < total) {
    // Backfill from CATEGORY leftovers only — never exceed the brand/nav caps (that cap is
    // the whole point: it keeps the comparison category-heavy).
    const used = new Set(out);
    for (const p of prompts) {
      if (out.length >= total) break;
      if (used.has(p)) continue;
      const intent = classifyIntent(p, gazetteer);
      if (intent === "brand" || intent === "navigational") continue;
      out.push(p);
      used.add(p);
    }
  }
  return out.slice(0, total);
}

/** Fixed iteration order over the plan — never `Object.keys`, so the emitted set
 *  is byte-identical for identical inputs regardless of object-key ordering. */
const PLAN_ORDER: readonly PromptIntent[] = [...CATEGORY_INTENTS, ...BRANDED_INTENTS];

/** Case/punctuation-insensitive identity for a question (dedupe across pool + bank). */
function questionKey(prompt: string): string {
  return prompt.toLowerCase().replace(/[^a-z0-9]+/g, " ").trim();
}

/** How many questions of each intent a set actually contains. */
export function countByIntent(prompts: string[], gazetteer: Gazetteer): Record<PromptIntent, number> {
  const counts: Record<PromptIntent, number> = {
    discovery: 0, comparison: 0, problem: 0, brand: 0, navigational: 0,
  };
  for (const p of prompts) counts[classifyIntent(p, gazetteer)] += 1;
  return counts;
}

/**
 * Build the frozen question set to the fixed plan (methodology v2): exactly
 * INTENT_QUOTA[intent] questions per intent, drawn from `pool` first and padded
 * from `templates` when the pool is thin. Trimming and padding are both
 * deterministic — same pool, same bank, same set, every run.
 *
 * A template is only accepted into the slot it was filed under if the classifier
 * agrees it belongs there. That check is the point: the plan, the intent tags shown
 * in the report, and the branded/category denominators are all produced by
 * `classifyIntent`, so a question that the bank calls "brand" and the classifier
 * calls "comparison" would put the emitted shape back out of step with the
 * displayed one — the exact drift this plan exists to remove.
 *
 * An intent can still finish short if its template bank is exhausted (only
 * reachable when a caller passes a bank smaller than the quota). The set is
 * returned as built rather than backfilled from another intent: a short block is
 * visible as a short block, where padding it with the wrong kind of question would
 * silently restore the variable-shape problem. Callers verify with `countByIntent`.
 */
export function buildQuestionSet(
  pool: string[],
  gazetteer: Gazetteer,
  templates: Partial<Record<PromptIntent, string[]>> = {},
): string[] {
  const byIntent = new Map<PromptIntent, string[]>();
  for (const p of pool) {
    const intent = classifyIntent(p, gazetteer);
    const bucket = byIntent.get(intent);
    if (bucket) bucket.push(p);
    else byIntent.set(intent, [p]);
  }

  const used = new Set<string>();
  const out: string[] = [];
  for (const intent of PLAN_ORDER) {
    const quota = INTENT_QUOTA[intent];
    const picked: string[] = [];
    const take = (candidates: string[], requireIntent: boolean) => {
      for (const p of candidates) {
        if (picked.length >= quota) return;
        const key = questionKey(p);
        if (!key || used.has(key)) continue;
        if (requireIntent && classifyIntent(p, gazetteer) !== intent) continue;
        used.add(key);
        picked.push(p);
      }
    };
    // Pool entries are already bucketed by the same classifier — no re-check needed.
    take(byIntent.get(intent) ?? [], false);
    take(templates[intent] ?? [], true);
    out.push(...picked);
  }
  return out;
}

/** One (question × engine) cell state, matching the PDF grid's dot legend. */
export type CellState = "named_first" | "named" | "cited_not_named" | "absent" | "unavailable";

export interface AnswerCell {
  engine: EngineId;
  source: ProviderSource | null;
  tier: CaptureTier;
  state: CellState;
}

export interface QuestionRow {
  prompt: string;
  intent: PromptIntent;
  /** One cell per engine, in the given roster order. */
  cells: AnswerCell[];
}

function cellState(probe: GeoProbe | undefined): CellState {
  if (!probe || probe.captureTier === "UNAVAILABLE") return "unavailable";
  if (probe.brandFirst) return "named_first";
  if (probe.brandMentioned) return "named";
  if (probe.brandCited) return "cited_not_named"; // ghost citation
  return "absent";
}

/**
 * Build the per-question × per-engine answer grid — the PDF's central matrix.
 * Rows follow the prompt set order; cells follow the engine roster order.
 */
export function buildAnswerGrid(
  intentPrompts: IntentPrompt[],
  engines: EngineId[],
  probes: GeoProbe[],
): QuestionRow[] {
  const byKey = new Map<string, GeoProbe>();
  for (const p of probes) byKey.set(`${p.prompt} ${p.engine}`, p);
  return intentPrompts.map(({ prompt, intent }) => ({
    prompt,
    intent,
    cells: engines.map((engine) => {
      const probe = byKey.get(`${prompt} ${engine}`);
      return {
        engine,
        source: probe?.source ?? ENGINE_PROVIDERS[engine],
        tier: probe?.captureTier ?? "UNAVAILABLE",
        state: cellState(probe),
      };
    }),
  }));
}

/** Domain citation leaderboard entry ("who the engines quote instead"). */
export interface CitationLeader {
  domain: string;
  citations: number;
  isClient: boolean;
}

/**
 * Count every cited domain across all measured answers → the "who the engines quote"
 * leaderboard. The client's own domain is flagged and always retained.
 */
export function computeCitationLeaderboard(probes: GeoProbe[], gazetteer: Gazetteer, limit = 12): CitationLeader[] {
  const counts = new Map<string, number>();
  for (const p of probes) {
    if (p.captureTier === "UNAVAILABLE") continue;
    for (const d of p.citations) counts.set(d, (counts.get(d) ?? 0) + 1);
  }
  const client = gazetteer.clientDomain;
  const rows = [...counts.entries()]
    .map(([domain, citations]) => ({
      domain,
      citations,
      isClient: !!client && (domain === client || domain.endsWith(`.${client}`)),
    }))
    .sort((a, b) => b.citations - a.citations);
  const top = rows.slice(0, limit);
  // Ensure the client's own line is present even if it falls outside the top N.
  if (client && !top.some((r) => r.isClient)) {
    const clientRow = rows.find((r) => r.isClient);
    if (clientRow) top.push(clientRow);
  }
  return top;
}

/** Client citation summary: cited in N answers, named in M, ghost = N − M. */
export interface CitationSummary {
  totalMeasuredAnswers: number;
  answersCited: number;
  answersNamed: number;
  ghostCitations: number;
}

export function computeCitationSummary(probes: GeoProbe[]): CitationSummary {
  const measured = probes.filter((p) => p.captureTier !== "UNAVAILABLE");
  const answersCited = measured.filter((p) => p.brandCited).length;
  const answersNamed = measured.filter((p) => p.brandMentioned).length;
  const ghost = measured.filter((p) => p.brandCited && !p.brandMentioned).length;
  return {
    totalMeasuredAnswers: measured.length,
    answersCited,
    answersNamed,
    ghostCitations: ghost,
  };
}

/** Competitors named across measured answers, with counts (desc). */
export function computeCompetitorsNamed(
  probes: GeoProbe[],
  gazetteer: Gazetteer,
): Array<{ name: string; mentions: number }> {
  const counts = new Map<string, number>(Object.keys(gazetteer.competitors).map((c) => [c, 0]));
  for (const p of probes) {
    if (p.captureTier === "UNAVAILABLE") continue;
    for (const b of p.mentionedBrands) if (counts.has(b)) counts.set(b, (counts.get(b) ?? 0) + 1);
  }
  return [...counts.entries()]
    .map(([name, mentions]) => ({ name, mentions }))
    .filter((r) => r.mentions > 0)
    .sort((a, b) => b.mentions - a.mentions);
}

/* ── Discovered brands (open extraction from the answers) ─────────── */

/**
 * A brand the engines named in their answers that is NOT on the tracked roster.
 * Candidates are proposed by one extraction pass over the raw answer texts, then
 * every count below is deterministically re-verified with the same word-boundary
 * matcher used for roster brands — the model proposes, findMention counts.
 * This is the discovery signal that feeds LLM-aware competitor selection.
 */
export interface DiscoveredBrand {
  name: string;
  /** Primary website when resolvable (from answer citations or extraction). */
  url?: string;
  /** Measured answers (across engines, all prompt intents) naming the brand. */
  mentions: number;
  /** Per-engine mention counts over CATEGORY prompts only — like-for-like with
   *  the client-vs-competitor comparison denominators. Engines with ≥1 mention. */
  perEngine: Array<{ engine: EngineId; mentions: number }>;
}

/**
 * Deterministically count a candidate brand across raw answers. Pure so the UI
 * and tests can re-derive counts; returns per-engine breakdown plus the total
 * number of answers that name the brand.
 */
export function countBrandInAnswers(
  answers: Array<{ engine: EngineId; answerText: string; captureTier: CaptureTier }>,
  aliases: string[],
): { mentions: number; perEngine: Array<{ engine: EngineId; mentions: number }> } {
  const perEngine = new Map<EngineId, number>();
  let mentions = 0;
  for (const a of answers) {
    if (a.captureTier === "UNAVAILABLE" || !a.answerText.trim()) continue;
    if (aliases.some((alias) => findMention(a.answerText, alias) >= 0)) {
      mentions += 1;
      perEngine.set(a.engine, (perEngine.get(a.engine) ?? 0) + 1);
    }
  }
  return {
    mentions,
    perEngine: [...perEngine.entries()].map(([engine, m]) => ({ engine, mentions: m })),
  };
}

/* ── Snapshot trust (call directive B4) ───────────────────────────── */

/**
 * Stamped onto every snapshot the pipeline writes. Bump this whenever a change
 * makes older snapshots non-comparable with new ones, so the UI can say so
 * instead of presenting stale maths as current.
 *
 * 2026-07-28 covers the QA-sweep measurement changes: category-only client-vs-
 * competitor scoring and citations (CD-B3, F10), Perplexity/Copilot dropped from
 * the engine roster (CD-B2), registry-duplicate gaps collapsed (F11), levers taken
 * from the registry rather than the id prefix (F16), and one severity scale across
 * all gap types (F22). A snapshot without this stamp was measured under the old
 * rules; its numbers are historical, not wrong-but-current.
 *
 * 2026-07-29 adds question methodology v2 (CD-J1): a fixed question plan every
 * capture must emit, and denominators that count what was ASKED rather than what
 * happened to come back. That changes what a presence ratio MEANS, so snapshots
 * measured before it are not comparable with ones measured after — which is exactly
 * what this stamp exists to say. See SEO_GEO_METHODOLOGY_VERSION.
 */
export const SEO_GEO_PIPELINE_VERSION = "2026-07-29";

/**
 * The team treats captures before the 2026-07-23/24 SEO/GEO redeploy as
 * unreliable (call directive B4). Used only to word the legacy notice — the
 * version stamp above is what decides trust, because a hardcoded date stops being
 * meaningful the moment the pipeline changes again.
 */
export const SNAPSHOT_TRUST_CUTOFF = Date.UTC(2026, 6, 23);

/* ── Stored insights record ───────────────────────────────────────── */

/**
 * The full SEO & GEO insight set for one client — one Firestore doc per client
 * (`clientSeoGeo` collection, doc ID = clientId), written by the onboarding pipeline
 * and rendered as comparative graphs in the client analytics UI.
 */
export interface SeoGeoInsights {
  clientId: string;
  capturedAt: number;
  /** Pipeline that produced this snapshot (CD-B4). Absent on anything captured
   *  before version stamping — those are shown as legacy, never as current. */
  pipelineVersion?: string;
  /** Headline KPIs (0–100 ints, measured-only per the grade rule). */
  seoScore: number;
  seoDataCoveragePct: number;
  geoReadiness: number;
  geoReadinessCoveragePct: number;
  geoVisibilityIndex: number;
  geoVisibilityCoveragePct: number;
  /** Append-only series of past geoVisibilityIndex values (oldest→newest), for the
   *  trend line + delta (dev-handoff §3a: series[20,34] → big number + "+14" + sparkline).
   *  Maintained by the data layer on write; the agent leaves it undefined. */
  visibilityHistory?: number[];
  /** The visibility scoring model label (run-record `geo_visibility_model`). */
  geoVisibilityModel: string;
  /** First-party MEASURED engines behind the visibility index. */
  geoVisibilityEnginesMeasured: number;
  /** Engines included in the visibility mean this run. */
  geoVisibilityEnginesScored: number;
  /** Total engines in the roster (for the "N of M" disclosure). */
  geoVisibilityEnginesTotal: number;
  /** Client share among the locked roster across all measured answers, % (run-record `roster_share_pct`). */
  rosterSharePct: number;
  /** Question methodology this capture was measured under (CD-J1). Absent on
   *  anything captured before the fixed question plan — those denominators
   *  describe one run rather than a standard, and render under their own rules. */
  methodologyVersion?: string;
  /** Brand named in non-brand/category prompts (run-record `category_presence`). */
  categoryPresence: PresenceCount;
  /** Brand named in brand/nav prompts (run-record `brand_presence`). */
  brandPresence: PresenceCount;
  /** Per-engine sub-metrics with provider provenance — the chart series. */
  perEngine: PerEngineVisibility[];
  /** Prioritized SEO + GEO gaps/issues (site checks + competitor visibility deltas), run-record `issues[]` shape.
   *  INTERNAL — never render raw to a client (dev-handoff §4). Use `recommendations` for the client view. */
  gaps: VisibilityGap[];
  /** Client-facing action plan derived from `gaps` (dev-handoff §3b). Safe to render to clients. */
  recommendations: Recommendation[];
  /** recIds the client/staff has approved for the team to execute (QA Fix 6). Mutated by
   *  approveSeoGeoRecommendation, not the capture run. */
  approvedRecIds?: string[];
  /** Audited site checks (evidence trail for the scores). */
  seoChecks: SeoGeoCheck[];
  geoChecks: SeoGeoCheck[];
  /** The frozen buyer-intent prompt set used for this capture. */
  promptSet: string[];
  /** The prompt set tagged with the DISC/COMP/PROB/BRAND/NAV intent taxonomy. */
  intentPrompts: IntentPrompt[];
  /** Per-question × per-engine answer grid — the report's central matrix. */
  answerGrid: QuestionRow[];
  /** Domain citation leaderboard across all measured answers ("who the engines quote"). */
  citationLeaderboard: CitationLeader[];
  /** Client citation summary (cited/named/ghost across measured answers). */
  citationSummary: CitationSummary;
  /** Competitors named across measured answers, with counts. */
  competitorsNamed: Array<{ name: string; mentions: number }>;
  /** Non-roster brands the engines named this run (open extraction, verified counts).
   *  Absent on snapshots captured before brand discovery shipped. */
  discoveredBrands?: DiscoveredBrand[];
  /** Roster used for share-of-voice (client first). */
  roster: string[];
  updatedAt: number;
  /**
   * Set ONLY when this snapshot was hand-imported through the admin Ops Import
   * page instead of being measured by a portal pipeline run. Absent means the
   * portal measured it itself — which is why this is an optional field and not
   * a defaulted one: every snapshot written before Ops Import existed is a
   * genuine machine capture, and must keep reading as one.
   *
   * Deliberately NOT named `source`: `PerEngineVisibility.source` already means
   * `ProviderSource` ("OpenAI" | "Gemini" | "Anthropic") one level down, and a
   * top-level field of the same name reading "local-import" would be a trap.
   *
   * This does NOT participate in the trust/legacy verdict. `buildSnapshotTrust`
   * keys off `pipelineVersion` alone, and an import carries through whatever
   * version the capture actually declared — it never restamps. So the legacy
   * banner keeps meaning "measured under superseded rules", and provenance
   * answers the separate question of where the run happened.
   *
   * The next real pipeline capture overwrites the doc and drops this field.
   * That is correct: a machine capture must not inherit an import's provenance.
   */
  importedFrom?: {
    source: "local-import";
    /** Epoch millis the import landed — NOT `capturedAt`, which stays the measurement time. */
    importedAt: number;
    /** Display name of the admin who clicked Import. */
    importedBy?: string;
    /** Bundle filename the snapshot came from, for the audit trail. */
    file?: string;
  };
}
