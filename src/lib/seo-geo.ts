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

/** The five answer engines from the a3 spec. Only engines with a wired provider are probed. */
export type EngineId = "chatgpt" | "gemini" | "claude" | "perplexity" | "copilot";

/** Which model provider actually produced a data point (multi-model provenance). */
export type ProviderSource = "OpenAI" | "Gemini" | "Anthropic";

/** Capture tier per the a3 grade-data-only rule. Set at capture time, never upgraded. */
export type CaptureTier = "MEASURED" | "MEASURED_grounded" | "ESTIMATED" | "UNAVAILABLE";

export const ENGINE_LABELS: Record<EngineId, string> = {
  chatgpt: "ChatGPT",
  gemini: "Gemini",
  claude: "Claude",
  perplexity: "Perplexity",
  copilot: "Copilot",
};

/** Engine → provider that answers for it in this platform (null = no connector wired yet). */
export const ENGINE_PROVIDERS: Record<EngineId, ProviderSource | null> = {
  chatgpt: "OpenAI",
  gemini: "Gemini",
  claude: "Anthropic",
  perplexity: null,
  copilot: null,
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
function aliasesFromWebsite(url: string | undefined | null): string[] {
  const domain = rootDomain(url);
  if (!domain) return [];
  const aliases = [domain];
  const label = domain.split(".")[0];
  if (label.length >= 4) aliases.push(label);
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
function normalizeBrandKey(name: string, url?: string): string {
  const domainRoot = rootDomain(url)?.split(".")[0];
  if (domainRoot && domainRoot.length >= 3) return domainRoot;
  return name
    .toLowerCase()
    .replace(/\b(ai|agency|consulting|labs?|studio|inc|llc|ltd|co|group|the|and|&)\b/g, "")
    .replace(/[^a-z0-9]/g, "");
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

/** Per-engine geo-score-v3 sub-score, 0..1 (each signal normalized to 0..1 first). */
export function engineVisibilityScore(e: PerEngineVisibility): number {
  return (
    APPEARANCE_LED_WEIGHTS.appearance * clamp01(e.mentionRate) +
    APPEARANCE_LED_WEIGHTS.citation * clamp01(e.citationRate) +
    APPEARANCE_LED_WEIGHTS.firstPosition * clamp01(e.firstPositionRate) +
    APPEARANCE_LED_WEIGHTS.shareOfRoster * clamp01(e.shareOfVoice / 100) +
    APPEARANCE_LED_WEIGHTS.sentiment * clamp01((e.netSentiment + 1) / 2)
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
  const live = perEngine.filter((e) => e.captureTier !== "UNAVAILABLE" && e.promptsMeasured > 0);
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
 * @param isCategory optional predicate marking a prompt as a category (non-brand,
 *   non-navigational) question. When supplied, only those prompts count toward the
 *   share — brand/nav prompts name the client by construction and would otherwise
 *   inflate this to a near-meaningless number even when competitor shares are 0
 *   (QA Fix 2: same like-for-like rule as computePerEngineVisibility's `category`).
 */
export function computeRosterSharePct(
  probes: GeoProbe[],
  gazetteer: Gazetteer,
  isCategory?: (prompt: string) => boolean,
): number {
  const clientName = gazetteer.client[0];
  const roster = [clientName, ...Object.keys(gazetteer.competitors)];
  const counts = new Map<string, number>(roster.map((b) => [b, 0]));
  for (const p of probes) {
    if (p.captureTier === "UNAVAILABLE") continue;
    if (isCategory && !isCategory(p.prompt)) continue;
    for (const b of p.mentionedBrands) counts.set(b, (counts.get(b) ?? 0) + 1);
  }
  const total = [...counts.values()].reduce((a, b) => a + b, 0);
  return total ? Math.round(((counts.get(clientName) ?? 0) / total) * 1000) / 10 : 0;
}

/** Brand-prompt vs category-prompt presence (run-record `brand_presence` / `category_presence`). */
export interface PresenceBreakdown {
  brand: { named: number; total: number };
  category: { named: number; total: number };
}

/**
 * Split the prompt set into brand/nav prompts (those that name the client) and
 * category prompts (those that don't), then count in how many the brand actually
 * appeared across measured engines. Mirrors the a3 "4 of 4 brand / 0 of 16 category".
 */
export function computePresence(probes: GeoProbe[], gazetteer: Gazetteer): PresenceBreakdown {
  const isBrandPrompt = (prompt: string) => gazetteer.client.some((a) => findMention(prompt, a) >= 0);
  const byPrompt = new Map<string, { brand: boolean; named: boolean }>();
  for (const p of probes) {
    if (p.captureTier === "UNAVAILABLE") continue;
    const cur = byPrompt.get(p.prompt) ?? { brand: isBrandPrompt(p.prompt), named: false };
    if (p.brandMentioned) cur.named = true;
    byPrompt.set(p.prompt, cur);
  }
  const brand = { named: 0, total: 0 };
  const category = { named: 0, total: 0 };
  for (const v of byPrompt.values()) {
    const bucket = v.brand ? brand : category;
    bucket.total += 1;
    if (v.named) bucket.named += 1;
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

function severityFromLift(lift: number): GapSeverity {
  if (lift >= 7) return "critical";
  if (lift >= 4) return "high";
  if (lift >= 2) return "medium";
  return "low";
}

/** Derive the lever from an a3 rec id prefix (BOTH-* → BOTH), falling back per registry. */
export function leverFromId(id: string, fallback: Lever): Lever {
  const prefix = id.split(/[-:]/)[0].toUpperCase();
  return prefix === "BOTH" ? "BOTH" : prefix === "SEO" ? "SEO" : prefix === "GEO" ? "GEO" : fallback;
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
 * Competitor-vs-client visibility gaps computed from the multi-engine capture.
 * The a3 agent does not emit explicit gap values, so this is the utility logic that
 * derives them from the collected competitor vs client data (per requirement).
 */
export function computeVisibilityGaps(perEngine: PerEngineVisibility[]): VisibilityGap[] {
  const gaps: VisibilityGap[] = [];
  for (const e of perEngine) {
    if (e.captureTier === "UNAVAILABLE") continue;
    // Gaps reflect CATEGORY visibility (real market reality), not brand-prompt inflation.
    const c = e.category;
    if (c.promptsMeasured === 0) continue;
    const label = ENGINE_LABELS[e.engine];
    const src = e.source ?? undefined;

    // Off-site visibility fixes are advisory content/outreach work, never a
    // machine-appliable on-page action.
    const base = { delivery: "advisory" as Delivery, fixAction: "manual" as FixAction, target: "off-site", confidence: "CONFIRMED" as const, source: src, productRef: null, artifactRef: null };

    if (c.topCompetitor && c.topCompetitor.shareOfVoice > c.shareOfVoice) {
      const delta = c.topCompetitor.shareOfVoice - c.shareOfVoice;
      gaps.push({
        ...base,
        id: `GEO-27:${e.engine}`,
        lever: "GEO",
        title: `Share-of-voice gap on ${label}: ${c.topCompetitor.name} leads by ${Math.round(delta)} pts`,
        severity: delta >= 40 ? "critical" : delta >= 20 ? "high" : delta >= 10 ? "medium" : "low",
        measured: `${Math.round(c.shareOfVoice)}% share of voice (vs ${c.topCompetitor.name} at ${Math.round(c.topCompetitor.shareOfVoice)}%)`,
        benchmark: `≥ ${Math.round(c.topCompetitor.shareOfVoice)}% (match category leader)`,
        scoreLift: Math.round(delta) / 10,
        evidence: `Measured across ${c.promptsMeasured} category questions answered by ${label}`,
      });
    }
    if (c.mentionRate < TARGET_MENTION) {
      gaps.push({
        ...base,
        id: `GEO-35:${e.engine}`,
        lever: "GEO",
        title: `Low named-mention rate on ${label}`,
        severity: c.mentionRate === 0 ? "critical" : c.mentionRate < 0.15 ? "high" : "medium",
        measured: `Named in ${Math.round(c.mentionRate * 100)}% of category answers`,
        benchmark: `≥ ${TARGET_MENTION * 100}% of category answers`,
        scoreLift: Math.round((TARGET_MENTION - c.mentionRate) * 15 * 10) / 10,
        evidence: `${c.promptsMeasured} category questions probed on ${label}`,
      });
    }
    if (c.citationRate < TARGET_CITE) {
      gaps.push({
        ...base,
        id: `GEO-11:${e.engine}`,
        lever: "GEO",
        title: `Site never cited as a source by ${label}`,
        severity: c.citationRate === 0 ? "high" : "medium",
        measured: `Cited in ${Math.round(c.citationRate * 100)}% of category answers`,
        benchmark: `≥ ${TARGET_CITE * 100}% citation share`,
        scoreLift: Math.round((TARGET_CITE - c.citationRate) * 35 * 10) / 10,
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
 * action title + what it entails). Keyed by the id prefix (before any ":"). Anything not
 * mapped falls back to the internal gap title (still readable, just less polished).
 */
const REC_COPY: Record<string, { title: string; description: string }> = {
  "BOTH-07": { title: "Point your guides hub at itself", description: "The guides page currently tells search engines its canonical version is the homepage, so Google credits the homepage instead. Point the canonical tag at the guides hub." },
  "SEO-02": { title: "Tighten your page titles", description: "Keep titles under 60 characters, unique per page, with the main keyword near the front so they aren't cut off in results." },
  "SEO-06": { title: "Fix your meta descriptions", description: "Rewrite each description to 120–158 characters - long enough to use the space, short enough not to be truncated - and make each one unique." },
  "GEO-17": { title: "Give every page one clear headline", description: "Each page needs exactly one main heading (H1); search and AI engines use it to understand what the page is about." },
  "GEO-20": { title: "Fix your freshness signals", description: "Make each page's sitemap date match its real on-page updated date, so engines trust when the content actually changed." },
  "GEO-02": { title: "Add a short answer at the top of each guide", description: "Open each guide with a self-contained 40–60 word answer to the question it targets - AI assistants lift these directly." },
  "GEO-03": { title: "Add evidence to your content", description: "Add statistics, cited sources, and quotes to each section - evidence is what makes an engine quote your page over another." },
  "GEO-09": { title: "Add authorship and original data", description: "Add a named author, inline citations, and at least one original statistic per page so engines trust and attribute your content." },
  "BOTH-16": { title: "Make your sections scannable", description: "Keep sections to roughly 120–180 words with a clear one-line definition, so engines can extract clean answers." },
  "GEO-22": { title: "Use question-style headings", description: "Phrase key headings as the questions buyers actually ask, each followed by a short direct answer - that's how AI matches pages to prompts." },
  "GEO-25": { title: "Establish a clear entity record", description: "Create a Wikidata item (and a Wikipedia article once notable) so every engine knows which brand you are and stops confusing you with similarly-named ones." },
  "GEO-04": { title: "Earn authoritative mentions", description: "Get named on independent, reputable sites - engines repeat what trusted third parties say about you." },
  "GEO-14": { title: "Build a third-party review presence", description: "Get reviews across several independent platforms so 'is X any good' resolves to more than your own listing." },
  "BOTH-01": { title: "Make every page indexable", description: "Ensure pages return 200 and carry no noindex/nosnippet directive so search and AI engines can use them." },
  "GEO-27": { title: "Close the share-of-voice gap on category questions", description: "A tracked competitor is named far more often than you on the questions buyers actually ask. Earn mentions in the sources those answers draw from." },
  "GEO-35": { title: "Get named on category questions", description: "You're rarely named when buyers ask category questions (not your brand by name). Owned comparison content plus third-party mentions fix this." },
  "GEO-11": { title: "Earn citations from the engines", description: "The engines don't yet cite your site as a source on category answers. Quotable, evidence-backed pages turn into citations." },
};

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
export function buildRecommendations(gaps: VisibilityGap[], limit = 10): Recommendation[] {
  const seen = new Set<string>();
  const out: Recommendation[] = [];
  for (const gap of [...gaps].sort((a, b) => b.scoreLift - a.scoreLift)) {
    const copy = REC_COPY[gap.id.split(":")[0]];
    const title = copy?.title ?? gap.title;
    const key = title.toLowerCase().trim();
    if (seen.has(key)) continue;
    seen.add(key);
    const actionKind = actionKindFor(gap);
    out.push({
      recId: gap.id,
      title,
      description: copy?.description ?? gap.benchmark ?? "",
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

/** Per-intent target counts for a 20-prompt set (a3 Phase-1 quota — keeps the set
 *  balanced and caps brand/nav so the comparison stays category-heavy). */
export const INTENT_QUOTA: Record<PromptIntent, number> = {
  discovery: 6,
  comparison: 5,
  problem: 5,
  brand: 3,
  navigational: 1,
};

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

/* ── Stored insights record ───────────────────────────────────────── */

/**
 * The full SEO & GEO insight set for one client — one Firestore doc per client
 * (`clientSeoGeo` collection, doc ID = clientId), written by the onboarding pipeline
 * and rendered as comparative graphs in the client analytics UI.
 */
export interface SeoGeoInsights {
  clientId: string;
  capturedAt: number;
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
  /** Brand named in non-brand/category prompts (run-record `category_presence`). */
  categoryPresence: { named: number; total: number };
  /** Brand named in brand/nav prompts (run-record `brand_presence`). */
  brandPresence: { named: number; total: number };
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
  /** Roster used for share-of-voice (client first). */
  roster: string[];
  updatedAt: number;
}
