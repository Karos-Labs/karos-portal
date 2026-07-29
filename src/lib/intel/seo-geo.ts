import "server-only";

import { streamText, stepCountIs } from "ai";
import { anthropic } from "@ai-sdk/anthropic";
import { MODELS } from "@/lib/constants";
import type { Client } from "@/lib/types";
import {
  ENGINE_LABELS,
  ENGINE_PROVIDERS,
  GEO_READINESS_CHECKS,
  PLANNED_QUESTIONS_TOTAL,
  SEO_CHECKS,
  SEO_GEO_METHODOLOGY_VERSION,
  SEO_GEO_PIPELINE_VERSION,
  analyzeAnswer,
  buildQuestionSet,
  countByIntent,
  buildGazetteer,
  categoryMetrics,
  computeCheckGaps,
  computeCheckScore,
  countBrandInAnswers,
  INTENT_LABELS,
  buildAnswerGrid,
  buildRecommendations,
  classifyIntent,
  dedupeGapsByRecId,
  dedupeNearDuplicates,
  normalizeBrandKey,
  normalizeEvidence,
  rootDomain,
  computeCitationLeaderboard,
  computeCitationSummary,
  computeCompetitorsNamed,
  computePerEngineVisibility,
  computePresence,
  presenceCounts,
  computeRosterSharePct,
  computeVisibilityGaps,
  computeVisibilityIndex,
  tagPromptIntents,
  type DiscoveredBrand,
  type EngineAnswer,
  type EngineId,
  type Gazetteer,
  type GeoProbe,
  type IntentPrompt,
  type PromptIntent,
  type SeoGeoCheck,
  type SeoGeoInsights,
  type VisibilityGap,
} from "@/lib/seo-geo";
import { configuredEngines, probeEngine } from "./seo-geo-providers";
import { logger } from "@/services/logger";

/**
 * SEO & GEO research vertical for the onboarding pipeline — the platform port of
 * the karos-agents lab product a3 (products/onboarding/step-02-seo-geo).
 *
 * Two agents, matching the lab's two phases:
 *   1. Site audit (Sonnet + live web tools): technical SEO + GEO-readiness checks,
 *      each with real evidence (URL, HTTP code, observed value) → seo_score +
 *      geo_readiness via the ported a3 scoring weights.
 *   2. Visibility capture (multi-model): buyer-intent prompts asked to OpenAI,
 *      Gemini and Claude; deterministic gazetteer parsing → per-engine visibility,
 *      share-of-voice vs competitors, and computed gap values. Every data point
 *      carries the provider that produced it (source: "OpenAI" | "Gemini" | "Anthropic").
 */

/** Engines probed per run — the a3 five-engine roster, filtered to wired connectors. */
/** Tracked engines (CD-B2: Perplexity and Copilot removed — no wired provider). */
const ENGINE_ROSTER: EngineId[] = ["chatgpt", "gemini", "claude"];

/**
 * Questions per capture run — the fixed plan, not a ceiling (CD-J1 directive 1).
 * Derived from INTENT_QUOTA rather than restated, so the number here and the shape
 * `buildQuestionSet` enforces can never disagree. Cost/latency is bounded by
 * CAPTURE_CONCURRENCY (probes fan out in bounded batches, not all at once).
 */
const PROMPT_SET_SIZE = PLANNED_QUESTIONS_TOTAL;

/** Max concurrent engine probes — bounds the N prompts × M engines fan-out so a
 *  20-question run doesn't fire 60 simultaneous API calls into rate limits. */
const CAPTURE_CONCURRENCY = 8;

/** Max competitors in the share-of-voice roster (a3 confirms 3–8). */
const MAX_ROSTER_COMPETITORS = 6;

// The audit emits a ~900-word brief PLUS a ~40-entry JSON check block. With live
// web-tool overhead this can exceed a tight budget and truncate the JSON mid-block
// (the old cause of "no JSON check block"). Give it full headroom.
const AUDIT_MAX_TOKENS = 16_000;

/* ── Helpers ──────────────────────────────────────────────────────── */

function todayISO(): string {
  return new Date().toISOString().slice(0, 10);
}

/** Map over items with a bounded number of concurrent workers, preserving input order. */
async function mapWithConcurrency<T, R>(items: T[], limit: number, fn: (item: T) => Promise<R>): Promise<R[]> {
  const results = new Array<R>(items.length);
  let next = 0;
  const worker = async () => {
    while (next < items.length) {
      const i = next++;
      results[i] = await fn(items[i]);
    }
  };
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker));
  return results;
}

/**
 * Robustly extract the checks JSON from a model response. Tolerant of: ```json or
 * bare ``` fences (any case), an UNTERMINATED fence (model truncated before the
 * closing ```), and raw unfenced JSON. Prefers a block that actually contains the
 * check keys. Returns null only when no `{…"seoChecks"…}` object can be recovered.
 */
function extractJsonBlock(text: string): string | null {
  const hasKeys = (s: string) => s.includes("seoChecks") || s.includes("geoChecks");

  // 1. Properly fenced blocks (```json … ``` or ``` … ```), last matching one wins.
  const fenced = [...text.matchAll(/```(?:json)?\s*([\s\S]*?)```/gi)].map((m) => m[1].trim());
  for (let i = fenced.length - 1; i >= 0; i--) if (hasKeys(fenced[i])) return fenced[i];

  // 2. Unterminated fence — the model started ```json but got cut off before ```.
  const open = text.lastIndexOf("```json");
  if (open >= 0) {
    const tail = text.slice(open + "```json".length).replace(/```\s*$/, "").trim();
    if (hasKeys(tail)) return tail;
  }

  // 3. Unfenced: brace-match the object that contains the check keys.
  const anchor = text.search(/"?seoChecks"?\s*:/);
  if (anchor >= 0) {
    const start = text.lastIndexOf("{", anchor);
    if (start >= 0) {
      let depth = 0;
      for (let i = start; i < text.length; i++) {
        if (text[i] === "{") depth++;
        else if (text[i] === "}" && --depth === 0) return text.slice(start, i + 1).trim();
      }
      // Truncated object: return what we have; JSON.parse will fail and trigger the retry.
      return text.slice(start).trim();
    }
  }
  return null;
}

/** Pull the first JSON array literal out of a model response (tolerates code fences + prose). */
function extractJsonArray(text: string): string | null {
  const unfenced = text.replace(/```(?:json)?/gi, "").replace(/```/g, "");
  const start = unfenced.indexOf("[");
  const end = unfenced.lastIndexOf("]");
  return start >= 0 && end > start ? unfenced.slice(start, end + 1) : null;
}

/** JSON.parse that tolerates trailing commas (the most common LLM JSON glitch). */
function tolerantJsonParse(s: string): unknown {
  try {
    return JSON.parse(s);
  } catch {
    return JSON.parse(s.replace(/,(\s*[}\]])/g, "$1"));
  }
}

const VALID_TIERS = new Set(["MEASURED", "ESTIMATED", "PENDING"]);
const VALID_CONFIDENCE = new Set(["CONFIRMED", "LIKELY", "HYPOTHESIS"]);

function sanitizeChecks(raw: unknown): SeoGeoCheck[] {
  if (!Array.isArray(raw)) return [];
  const out: SeoGeoCheck[] = [];
  for (const item of raw) {
    if (!item || typeof item !== "object") continue;
    const c = item as Record<string, unknown>;
    const norm = Number(c.norm);
    if (typeof c.id !== "string" || !Number.isFinite(norm)) continue;
    out.push({
      id: c.id,
      bucket: typeof c.bucket === "string" ? c.bucket : "",
      label: typeof c.label === "string" ? c.label : c.id,
      // QA F3a: the model's free-text evidence is markdown-stripped and
      // sentence-cased HERE (server boundary), never at render — it lands on the
      // persisted snapshot and every downstream surface reads it.
      evidence: normalizeEvidence(typeof c.evidence === "string" ? c.evidence : ""),
      norm: Math.min(Math.max(norm, 0), 1),
      tier: VALID_TIERS.has(String(c.tier)) ? (c.tier as SeoGeoCheck["tier"]) : "PENDING",
      confidence: VALID_CONFIDENCE.has(String(c.confidence))
        ? (c.confidence as SeoGeoCheck["confidence"])
        : "HYPOTHESIS",
    });
  }
  return out;
}

function checklistBlock(defs: Array<{ id: string; bucket: string; label: string }>): string {
  return defs.map((d) => `- ${d.id} · bucket:${d.bucket} · ${d.label}`).join("\n");
}

/* ── Agent 1: SEO + GEO-readiness site audit ──────────────────────── */

interface AuditResult {
  brief: string;
  seoChecks: SeoGeoCheck[];
  geoChecks: SeoGeoCheck[];
}

async function runSiteAudit(client: Client, rules: string): Promise<AuditResult> {
  const auditStream = streamText({
    model: anthropic(MODELS.SONNET),
    system: `${rules}\n\nYou are a senior technical SEO and GEO (generative engine optimization) auditor with LIVE web access. You measure, you never guess: every check verdict cites what you actually observed this run (a URL, an HTTP behavior, a literal element). What you could not measure is marked PENDING — never a fabricated pass or fail. Findings are labeled CONFIRMED (verified from fetched data), LIKELY (strong signal, not directly verified), or HYPOTHESIS (pattern-based inference).`,
    tools: {
      web_search: anthropic.tools.webSearch_20250305({ maxUses: 10 }),
      web_fetch: anthropic.tools.webFetch_20250910({ maxUses: 12, maxContentTokens: 6000 }),
    },
    // Continue past Anthropic pause_turn while the audit crawls (default stepCountIs(1)
    // would stop at the first pause with an empty, JSON-less stub).
    stopWhen: stepCountIs(24),
    messages: [
      {
        role: "user",
        content: `Audit the search and AI-answer readiness of ${client.name} (${client.website ?? "no website"}).

MEASUREMENT PLAN (execute in order):
1. Fetch the homepage — capture title tag, meta description, H1 count, heading structure, visible dateModified/schema, internal links, content structure (section lengths, answer capsules under H2s), image alt coverage.
2. Fetch /robots.txt — check rules for Googlebot, Bingbot, OAI-SearchBot, PerplexityBot, ClaudeBot; find the Sitemap: line.
3. Fetch the sitemap URL — verify it returns valid XML.
4. Fetch 2-3 key inner pages (about, pricing, blog/services) — same on-page checks; note evidence density (stats, cited sources, quotes, bylines) and freshness signals.
5. Search for the brand's off-site entity footprint: Wikipedia/Wikidata presence, review-platform ratings, authoritative mentions.

Then evaluate EVERY check in both registries below. For each check output:
- "id" and "bucket" exactly as listed
- "norm": 0 to 1 (1 = fully passes the target; fractional = partial)
- "tier": "MEASURED" only if you directly observed the evidence THIS run via fetch/search; "ESTIMATED" if inferred from partial signals; "PENDING" if it cannot be measured with the tools available (e.g. CrUX p75 field data, Bing/Brave index counts, backlink exports)
- "evidence": the concrete observation ("robots.txt (fetched ${todayISO()}) has no Disallow for ClaudeBot", "homepage title is 74 chars: '…'")
- "confidence": CONFIRMED / LIKELY / HYPOTHESIS

SEO SCORE CHECKS:
${checklistBlock(SEO_CHECKS)}

GEO READINESS CHECKS:
${checklistBlock(GEO_READINESS_CHECKS)}

OUTPUT FORMAT — two parts, in this order:
1. A markdown audit brief: "## Technical SEO Findings" and "## GEO Readiness Findings" — the most important observations, each with its evidence, labeled "web-observed (URL, ${todayISO()})", plus the top fixes you would prioritize and why. Keep it under 900 words.
2. A single fenced \`\`\`json block:
{
  "seoChecks": [ { "id": "...", "bucket": "...", "label": "...", "norm": 0.0, "tier": "MEASURED", "evidence": "...", "confidence": "CONFIRMED" }, ... ],
  "geoChecks": [ ...same shape, one entry per GEO readiness check... ]
}
Every check id from both registries MUST appear exactly once in the JSON. The JSON block must be the last thing in your output.`,
      },
    ],
    maxOutputTokens: AUDIT_MAX_TOKENS,
  });

  const text = await auditStream.text;
  logger.trackStream(auditStream, {
    clientId: client.id, agentId: null, agentName: "SEO/GEO Site Audit",
    modelName: MODELS.SONNET, operation: "seo_audit",
  });
  const json = extractJsonBlock(text);
  if (!json) throw new Error("Site audit returned no JSON check block");

  let parsed: { seoChecks?: unknown; geoChecks?: unknown };
  try {
    parsed = tolerantJsonParse(json) as { seoChecks?: unknown; geoChecks?: unknown };
  } catch (err) {
    throw new Error(`Site audit JSON block failed to parse: ${err instanceof Error ? err.message : String(err)}`);
  }

  const seoChecks = sanitizeChecks(parsed.seoChecks);
  const geoChecks = sanitizeChecks(parsed.geoChecks);
  const measuredCount = [...seoChecks, ...geoChecks].filter((c) => c.tier === "MEASURED").length;
  // Integrity gate: an audit that measured nothing is a failed audit, not a low score.
  if (measuredCount < 5) {
    throw new Error(`Site audit produced only ${measuredCount} MEASURED checks — treated as a failed crawl`);
  }

  const brief = text.replace(/```json[\s\S]*?```/g, "").trim();
  return { brief, seoChecks, geoChecks };
}

/* ── Agent 2: buyer-intent prompt set + multi-engine capture ──────── */

/**
 * Clean a generated prompt set before it's frozen (QA Fix 4 + Fix 9). The original a3
 * spec runs draft → tag/dedupe/quota → client approval; the portal port compressed that
 * into one call, which let a "site:" search operator and a stale year reach the grid.
 * This post-filter enforces the guardrails deterministically:
 *  - drop search operators ("site:", "inurl:", …) — they aren't buyer questions
 *  - strip hardcoded years (and any preposition they leave dangling) — no stale-dating
 *  - dedupe near-identical questions
 *  - sentence-case (first letter up; brand names/acronyms mid-string preserved)
 */
function sanitizePromptSet(prompts: string[]): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const raw of prompts) {
    let p = raw.trim();
    if (/\b(site|inurl|intitle|filetype|intext)\s*:/i.test(p)) continue; // search operators aren't questions
    p = p
      .replace(/\b(19|20)\d{2}\b/g, "") // stale years
      .replace(/\s+(in|for|of|on|during|by)\s*([?.!,]|$)/i, "$2") // dangling preposition after a removed year
      .replace(/\s{2,}/g, " ")
      .replace(/\s+([?.!,])/g, "$1")
      .trim();
    if (p.length < 8) continue;
    p = p.charAt(0).toUpperCase() + p.slice(1); // sentence case
    const key = p.toLowerCase().replace(/[^a-z0-9]+/g, " ").trim();
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(p);
  }
  return out;
}

/**
 * The deterministic template bank, filed by intent. Two jobs:
 *
 *  1. PADDING (CD-J1 directive 1). The plan requires exactly INTENT_QUOTA[intent]
 *     questions per intent; when the drafter returns a thin or lopsided pool,
 *     `buildQuestionSet` tops the short blocks up from here. Each block is
 *     deliberately longer than its quota so padding cannot run dry after the
 *     dedupe pass drops a template that duplicates a drafted question.
 *  2. FALLBACK. When generation fails outright, the same bank IS the question set.
 *
 * Every entry is written so `classifyIntent` files it where this bank does —
 * category templates never contain the client's name, brand templates always do,
 * and the navigational ones carry the bare domain or "official site".
 */
function questionTemplates(client: Client): Record<PromptIntent, string[]> {
  const category = client.industry?.trim() || "this category";
  const name = client.name;
  const domain = client.website?.replace(/^https?:\/\//, "").replace(/\/.*$/, "") || name;
  return {
    discovery: [
      `What are the best ${category} companies right now?`,
      `Who are the most trusted names in ${category}?`,
      `Top-rated ${category} providers`,
      `Which ${category} provider should I choose and why?`,
      `What should I look for when picking a ${category} provider?`,
      `Who are the leading ${category} providers people recommend?`,
      `What are the most popular ${category} options?`,
      `Who is worth considering for ${category}?`,
    ],
    comparison: [
      `Compare the top ${category} options for a new customer`,
      `Best app or tool for ${category}`,
      `${name} alternatives`,
      `What are the alternatives worth comparing in ${category}?`,
      `Which app to use for ${category}?`,
      `Compare pricing and features across ${category} providers`,
      `Best apps for ${category} compared`,
    ],
    problem: [
      `How do I choose a ${category} provider near me?`,
      `I need help with ${category} right now — where do I start?`,
      `How do I get started with ${category}?`,
      `How can I fix a bad experience with ${category}?`,
      `Where can I find a reliable ${category} provider?`,
      `How do I know if a ${category} provider is any good?`,
      `How to switch ${category} providers?`,
    ],
    brand: [
      `What is ${name}?`,
      `Is ${name} good?`,
      `Is ${name} worth it?`,
      `${name} reviews`,
      `What do customers say about ${name}?`,
    ],
    navigational: [`${name} official site`, `${domain}`],
  };
}

/**
 * Deterministic fallback prompt set when generation fails — never blocks the capture.
 * Built from the same bank and the same plan as a successful run, so a degraded run
 * is measured on the SAME SHAPE as a healthy one: the client's denominators do not
 * depend on whether the drafter happened to answer.
 */
function fallbackPromptSet(client: Client, gazetteer: Gazetteer): string[] {
  return buildQuestionSet([], gazetteer, questionTemplates(client));
}

/** Candidate pool the drafter is asked for (larger than the final set — the quota pass trims it). */
const PROMPT_POOL_SIZE = 32;

/**
 * Generate the frozen buyer-intent question set via the a3 Phase-1 pipeline:
 *   Sonnet drafts a candidate POOL from the client's real vocabulary
 *     → shingle-dedupe near-duplicates
 *     → sanitize (strip search operators / hardcoded years, sentence-case)
 *     → fill the FIXED question plan, padding short blocks from the template bank
 *     → freeze.
 *
 * CD-J1 directive 1: the set this returns is the plan or nothing — every client is
 * measured on the same 16 category + 4 branded questions, whatever the drafter
 * returned. The model supplies the client's real vocabulary; it does not get to
 * decide how much of the client we measure. A pool too thin to fill the plan is
 * topped up rather than shipped short, and a run that under-fills anyway is logged
 * with the shape it actually emitted (never silently accepted as the standard).
 *
 * (The interactive client keep/edit/delete approval SCREEN is a separate stateful
 * workflow; the automated onboarding run drafts, tags, dedupes and fills here.)
 */
async function generatePromptSet(client: Client, competitors: string[], gazetteer: Gazetteer): Promise<string[]> {
  try {
    const draftStream = streamText({
      model: anthropic(MODELS.SONNET), // Sonnet drafts (a3 Phase 1); tagging/dedupe/quota are deterministic
      system:
        "You write realistic, high-intent questions that real buyers type into AI assistants (ChatGPT, Gemini, Claude). Questions are in the language the client's customers actually use and never embed the answer. Draft a generous, varied pool — the platform trims and balances it.",
      messages: [
        {
          role: "user",
          content: `Client: ${client.name} (${client.website ?? "no website"})
Industry: ${client.industry ?? "unknown"}
Description: ${client.description ?? "—"}
Known competitors: ${competitors.join(", ") || "—"}

Draft ${PROMPT_POOL_SIZE} candidate buyer-intent questions covering the FULL intent taxonomy:
- discovery: "best X", "top X", "where to X" — asked BEFORE knowing any brand
- comparison: "best app/tool for X", "X vs alternatives", "${client.name} alternative"
- problem: "how do I …", "… near me", "I need … right now"
- brand: a few that name ${client.name} directly ("what is ${client.name}", "is ${client.name} good")
- navigational: the brand or bare domain name (e.g. "${client.name} reviews")
Weight the pool toward discovery/comparison/problem (that's where real market visibility is measured).

STRICT RULES:
- Each is a natural question a person types. NO search operators ("site:", "inurl:", etc.).
- NO hardcoded years or dates. Sentence case. Avoid near-duplicates.

Return ONLY a fenced \`\`\`json block containing an array of ${PROMPT_POOL_SIZE} strings.`,
        },
      ],
      maxOutputTokens: 1400,
    });
    const text = await draftStream.text;
    logger.trackStream(draftStream, {
      clientId: client.id, agentId: null, agentName: "GEO Prompt Set (draft)",
      modelName: MODELS.SONNET, operation: "geo_promptset",
    });
    // Bare JSON array (no seoChecks/geoChecks keys) → generic array extractor.
    const json = extractJsonArray(text);
    if (json) {
      const arr = tolerantJsonParse(json) as unknown;
      if (Array.isArray(arr)) {
        const raw = arr.filter((p): p is string => typeof p === "string" && p.trim().length > 8);
        // dedupe near-duplicates → sanitize (operators/years/case) → fill the plan.
        const cleaned = sanitizePromptSet(dedupeNearDuplicates(raw));
        const selected = buildQuestionSet(cleaned, gazetteer, questionTemplates(client));
        if (selected.length === PROMPT_SET_SIZE) return selected;
        // Under-filled: the bank ran dry for some intent. Say so with the shape, so
        // a short set is diagnosable from the logs rather than showing up months
        // later as one client whose denominators don't match anyone else's.
        console.warn(
          `[seo-geo] Question plan under-filled for ${client.id}: ${selected.length}/${PROMPT_SET_SIZE}`,
          countByIntent(selected, gazetteer),
        );
        if (selected.length >= 3) return selected;
      }
    }
    throw new Error("prompt set could not be parsed or was too small");
  } catch (err) {
    console.warn("[seo-geo] Prompt-set generation failed — using deterministic fallback:", err);
    return fallbackPromptSet(client, gazetteer);
  }
}

interface CaptureResult {
  probes: GeoProbe[];
  promptSet: string[];
  roster: string[];
  /** Raw engine answers — retained for the brand-discovery pass, never persisted. */
  answers: EngineAnswer[];
}

async function runVisibilityCapture(
  client: Client,
  competitors: Array<{ company: string; url?: string }>,
): Promise<CaptureResult> {
  const roster = competitors.slice(0, MAX_ROSTER_COMPETITORS);
  const gazetteer = buildGazetteer(client.name, client.website, roster);
  const promptSet = await generatePromptSet(client, roster.map((c) => c.company), gazetteer);

  const live = new Set(configuredEngines());
  const engines = ENGINE_ROSTER.filter((e) => live.has(e));
  if (engines.length === 0) {
    throw new Error(
      "GEO visibility capture has no configured engines — set OPENAI_API_KEY / GEMINI_API_KEY (ANTHROPIC_API_KEY is required platform-wide)",
    );
  }

  // Fan out every prompt to every configured engine, but bounded to CAPTURE_CONCURRENCY
  // so a 20-question run doesn't fire 60 simultaneous API calls into provider rate
  // limits. probeEngine never throws; a dead engine yields UNAVAILABLE cells.
  const jobs = engines.flatMap((engine) => promptSet.map((prompt) => ({ engine, prompt })));
  const answers = await mapWithConcurrency(jobs, CAPTURE_CONCURRENCY, ({ engine, prompt }) =>
    probeEngine(engine, prompt, client.id),
  );

  const probes = answers.map((a) => analyzeAnswer(a, gazetteer));
  const measured = probes.filter((p) => p.captureTier !== "UNAVAILABLE");
  if (measured.length === 0) {
    throw new Error("GEO visibility capture failed: every engine call errored — no measured answers this run");
  }

  return { probes, promptSet, roster: [client.name, ...roster.map((c) => c.company)], answers };
}

/* ── Brand discovery (open extraction from the raw answers) ────────── */

/** Max candidate brands the extraction may propose (before verification). */
const DISCOVERY_CANDIDATE_CAP = 24;
/** A discovered brand must be named in at least this many answers to be kept. */
const DISCOVERY_MIN_MENTIONS = 2;
/** Max discovered brands persisted per run. */
const DISCOVERY_KEEP = 10;
/** Per-answer char budget fed to the extraction call (brands cluster early in answers). */
const DISCOVERY_ANSWER_CHARS = 1200;

/**
 * Find brands the engines named that are NOT on the tracked roster. The gazetteer
 * only counts roster brands, so without this pass an engine-dominant rival the
 * intel report missed is invisible — exactly the brand we most need to track.
 *
 * One model call proposes candidate entities from the raw answer texts; every
 * count is then re-derived deterministically with the same word-boundary matcher
 * used for roster brands (the model proposes, findMention counts). URLs come from
 * the extraction or from a cited domain whose label matches the brand.
 * Best-effort: any failure returns [] and never blocks the capture.
 */
async function discoverAnswerBrands(
  client: Client,
  answers: EngineAnswer[],
  gazetteer: Gazetteer,
  isCategoryPrompt: (prompt: string) => boolean,
): Promise<DiscoveredBrand[]> {
  const usable = answers.filter((a) => a.captureTier !== "UNAVAILABLE" && a.answerText.trim());
  if (usable.length === 0) return [];
  // CD-B3: discovery counts — total AND per-engine — are category-only, so "Also
  // named by the engines" shares its denominator with the comparison rows and no
  // branded question can promote a brand into the candidate list. The full answer
  // corpus is still what the extraction pass reads (more text, better candidates);
  // only the counting is scoped.
  const usableCategory = usable.filter((a) => isCategoryPrompt(a.prompt));

  const rosterKeys = new Set<string>([
    normalizeBrandKey(gazetteer.client[0], gazetteer.clientDomain ?? undefined),
    ...gazetteer.client.map((a) => normalizeBrandKey(a)),
    ...Object.entries(gazetteer.competitors).flatMap(([name, aliases]) => [
      normalizeBrandKey(name),
      ...aliases.map((a) => normalizeBrandKey(a)),
    ]),
  ]);

  const corpus = usable
    .map((a) => `[${a.engine}] Q: ${a.prompt}\n${a.answerText.slice(0, DISCOVERY_ANSWER_CHARS)}`)
    .join("\n---\n");

  try {
    const { generateObject } = await import("ai");
    const { z } = await import("zod");
    const schema = z.object({
      brands: z.array(
        z.object({
          name: z.string().describe("The brand/company/product name exactly as it appears in the answers."),
          url: z.string().optional().describe("Primary website domain, e.g. 'example.com'. Omit only if genuinely unknown."),
        }),
      ),
    });

    const excluded = [gazetteer.client[0], ...Object.keys(gazetteer.competitors)].join(", ");
    const { object, usage } = await generateObject({
      model: anthropic(MODELS.SONNET),
      schema,
      system:
        "You extract competitor brand names from AI-assistant answers for a market-visibility tracker. " +
        "Return ONLY real companies/brands/products that the answers recommend or name as options in the category — " +
        "no generic terms, no place names, no publications quoted as sources, no feature names. " +
        `Return at most ${DISCOVERY_CANDIDATE_CAP} distinct brands.`,
      prompt: `Client (never include): ${gazetteer.client.join(" / ")}\nAlready tracked (never include): ${excluded || "—"}\n\nANSWERS:\n${corpus}\n\nExtract every OTHER brand the answers name as an option in this category.`,
      maxOutputTokens: 1200,
    });

    logger.logUsage({
      clientId: client.id, agentId: null, agentName: "GEO Brand Discovery",
      modelName: MODELS.SONNET, operation: "geo_brand_discovery",
      inputTokens: usage.inputTokens ?? 0, outputTokens: usage.outputTokens ?? 0,
    });

    const seen = new Set<string>();
    const verified: DiscoveredBrand[] = [];
    for (const cand of object.brands.slice(0, DISCOVERY_CANDIDATE_CAP)) {
      const name = cand.name.trim();
      if (name.length < 2) continue;
      const key = normalizeBrandKey(name, cand.url);
      if (!key || rosterKeys.has(key) || seen.has(key)) continue;
      seen.add(key);

      // Deterministic recount with the same alias expansion roster brands get.
      const domain = rootDomain(cand.url);
      const aliases = [name, ...(domain ? [domain] : [])];
      const label = domain?.split(".")[0];
      if (label && label.length >= 4) aliases.push(label);
      const counts = countBrandInAnswers(usableCategory, aliases);
      if (counts.mentions < DISCOVERY_MIN_MENTIONS) continue;
      const categoryCounts = counts;

      // URL fallback: a cited domain whose label matches the brand key.
      let url = domain ?? undefined;
      if (!url) {
        const cited = usable
          .flatMap((a) => a.citations)
          .find((d) => normalizeBrandKey(d.split(".")[0]) === key);
        if (cited) url = cited;
      }

      verified.push({ name, ...(url ? { url } : {}), mentions: counts.mentions, perEngine: categoryCounts.perEngine });
    }

    return verified.sort((a, b) => b.mentions - a.mentions).slice(0, DISCOVERY_KEEP);
  } catch (err) {
    console.warn("[seo-geo] Brand discovery failed (non-fatal):", err);
    return [];
  }
}

/* ── Brief builders (markdown fed to downstream doc generation) ───── */

function pct(v: number): string {
  return `${Math.round(v * 100)}%`;
}

function buildSeoBrief(audit: AuditResult, insights: SeoGeoInsights): string {
  const seoGaps = insights.gaps.filter((g) => g.lever === "SEO").slice(0, 8);
  return [
    `## SEO Snapshot (measured ${todayISO()})`,
    `- **SEO score: ${insights.seoScore}/100** (data coverage ${insights.seoDataCoveragePct}% — MEASURED checks only)`,
    `- **GEO readiness: ${insights.geoReadiness}/100** (data coverage ${insights.geoReadinessCoveragePct}%)`,
    "",
    audit.brief,
    "",
    seoGaps.length
      ? "## Prioritized SEO Gaps (computed, score-lift ordered)\n" +
        seoGaps
          .map((g) => `- [${g.severity.toUpperCase()}] ${g.title} — measured: ${g.measured} (confidence: ${g.confidence})`)
          .join("\n")
      : "",
  ]
    .filter(Boolean)
    .join("\n");
}

function buildGeoBrief(insights: SeoGeoInsights): string {
  const lines: string[] = [
    `## AI Answer-Engine Visibility (multi-model capture, ${todayISO()})`,
    "",
    `Buyer-intent prompts were asked live to each configured answer engine. Every row below is labeled with the model provider that produced it — treat the provider label as data provenance.`,
    "",
    `- **GEO visibility index: ${insights.geoVisibilityIndex}/100** (${insights.geoVisibilityModel})`,
    `- Engines measured: ${insights.geoVisibilityEnginesMeasured} of ${insights.geoVisibilityEnginesTotal} first-party (${insights.geoVisibilityEnginesScored} scored this run)`,
    `- Roster share of voice (client vs tracked competitors): ${insights.rosterSharePct}%`,
    // Counts are "named of MEASURED, out of PLANNED" — a question the engines
    // failed on is reported as unmeasured, never quietly removed from the
    // denominator (CD-J1 directive 1).
    ...(() => {
      const b = presenceCounts(insights.brandPresence);
      const c = presenceCounts(insights.categoryPresence);
      const tail = (p: { notMeasured: number }) => (p.notMeasured > 0 ? ` (${p.notMeasured} not measured)` : "");
      return [
        `- Brand-query presence: named in ${b.named}/${b.measured} of ${b.planned} branded questions${tail(b)} · Category presence: named in ${c.named}/${c.measured} of ${c.planned} category questions${tail(c)}`,
      ];
    })(),
    "",
    // CD-B3: every rate in this table is CATEGORY-scoped. Branded prompts name
    // the client by construction, so the full-set figures ran high and disagreed
    // with the tile, the engine cards and the score, all of which read
    // `categoryMetrics` — the same accessor used here, legacy fallback included.
    "All rates below are measured over CATEGORY (non-brand) prompts only — branded questions name the client by construction and never feed a client-vs-competitor number.",
    "",
    "| Engine | Provider (source) | Tier | Named in category answers | Share of voice | Cited as source | Ranked first | Leading competitor |",
    "|---|---|---|---|---|---|---|---|",
  ];
  for (const e of insights.perEngine) {
    if (e.captureTier === "UNAVAILABLE") {
      lines.push(`| ${ENGINE_LABELS[e.engine]} | ${e.source ?? "—"} | UNAVAILABLE | — | — | — | — | — |`);
      continue;
    }
    const c = categoryMetrics(e);
    lines.push(
      `| ${ENGINE_LABELS[e.engine]} | ${e.source} | ${e.captureTier} | ${pct(c.mentionRate)} | ${Math.round(c.shareOfVoice)}% | ${pct(c.citationRate)} | ${pct(c.firstPositionRate)} | ${c.topCompetitor ? `${c.topCompetitor.name} (${Math.round(c.topCompetitor.shareOfVoice)}% SOV)` : "—"} |`,
    );
  }

  // Client citation summary + ghost citations (cited but not named).
  const cs = insights.citationSummary;
  lines.push(
    "",
    `**Your citations:** cited as a source in ${cs.answersCited} of ${cs.totalMeasuredAnswers} measured CATEGORY answers, named in ${cs.answersNamed}. That leaves ${cs.ghostCitations} ghost citations (your content used without crediting you) to convert into named recommendations.`,
  );

  // "Who the engines quote instead" — citation-domain leaderboard.
  if (insights.citationLeaderboard.length) {
    lines.push(
      "",
      "## Who the engines quote (citation leaderboard, across measured CATEGORY answers)",
      ...insights.citationLeaderboard.map(
        (r) => `- ${r.domain}${r.isClient ? " (you)" : ""}: ${r.citations} citation${r.citations === 1 ? "" : "s"}`,
      ),
    );
  }
  if (insights.competitorsNamed.length) {
    lines.push(
      "",
      "Competitors named in the category answers: " +
        insights.competitorsNamed.map((c) => `${c.name} (${c.mentions})`).join(", "),
    );
  }
  if (insights.discoveredBrands?.length) {
    lines.push(
      "",
      "Brands named by the engines that are NOT on the tracked roster (measured category mention counts — candidates for competitor tracking): " +
        insights.discoveredBrands.map((b) => `${b.name} (${b.mentions})`).join(", "),
    );
  }

  const geoGaps = insights.gaps.filter((g) => g.lever === "GEO").slice(0, 8);
  if (geoGaps.length) {
    lines.push(
      "",
      "## Search-Visibility Gaps (computed from client-vs-competitor capture data)",
      ...geoGaps.map(
        (g) =>
          `- [${g.severity.toUpperCase()}] ${g.title} — ${g.measured}; target: ${g.target}${g.source ? ` (source: ${g.source})` : ""}`,
      ),
    );
  }

  // Frozen prompt set, grouped by the intent taxonomy (DISC/COMP/PROB/BRAND/NAV).
  lines.push("", "## Frozen prompt set by intent (what buyers asked)");
  for (const intent of ["discovery", "comparison", "problem", "brand", "navigational"] as const) {
    const rows = insights.intentPrompts.filter((ip) => ip.intent === intent);
    if (rows.length) {
      lines.push(`**${INTENT_LABELS[intent]}**`, ...rows.map((ip) => `- "${ip.prompt}"`));
    }
  }
  lines.push("", `Roster for share-of-voice: ${insights.roster.join(", ")}.`);
  return lines.join("\n");
}

/* ── Public orchestrator ──────────────────────────────────────────── */

export interface SeoGeoResearch {
  /** Markdown SEO brief — flows into downstream context-document generation. */
  seoBrief: string;
  /** Markdown GEO brief — flows into downstream context-document generation. */
  geoBrief: string;
  /** Structured metrics + gaps, persisted for the comparative-graph UI. */
  insights: SeoGeoInsights;
}

/**
 * Run the full SEO/GEO research vertical: site audit + multi-engine visibility
 * capture in parallel, then score, compute gaps, and compose the two briefs.
 *
 * Resilience matches the other research verticals: the audit gets one retry;
 * individual engine failures degrade to UNAVAILABLE cells; only a total failure
 * (no audit AND no capture) throws to the caller.
 */
export async function runSeoGeoResearch(
  client: Client,
  rules: string,
  competitors: Array<{ company: string; url?: string }> = [],
): Promise<SeoGeoResearch> {
  const auditWithRetry = async (): Promise<AuditResult> => {
    try {
      return await runSiteAudit(client, rules);
    } catch (err) {
      console.warn("[seo-geo] Site audit attempt 1/2 failed:", err);
      return runSiteAudit(client, rules);
    }
  };

  const [auditResult, captureResult] = await Promise.allSettled([
    auditWithRetry(),
    runVisibilityCapture(client, competitors),
  ]);

  if (auditResult.status === "rejected" && captureResult.status === "rejected") {
    throw new Error(
      `SEO/GEO research failed on both legs — audit: ${String(auditResult.reason)}; capture: ${String(captureResult.reason)}`,
    );
  }

  const audit: AuditResult =
    auditResult.status === "fulfilled"
      ? auditResult.value
      : { brief: "> RESEARCH UNAVAILABLE: the technical site audit failed for this run. Do NOT fabricate SEO findings.", seoChecks: [], geoChecks: [] };

  const capture: CaptureResult =
    captureResult.status === "fulfilled"
      ? captureResult.value
      : { probes: [], promptSet: [], roster: [client.name], answers: [] };

  if (auditResult.status === "rejected") console.error("[seo-geo] Site audit failed after retry:", auditResult.reason);
  if (captureResult.status === "rejected") console.error("[seo-geo] Visibility capture failed:", captureResult.reason);

  // Score + gaps (pure maths over the frozen run data).
  const gazetteer = buildGazetteer(
    client.name,
    client.website,
    competitors.slice(0, MAX_ROSTER_COMPETITORS),
  );
  // Brand + navigational prompts name the client and guarantee mentions; the
  // client-vs-competitor comparison must be like-for-like on CATEGORY prompts (QA Fix 2).
  const isCategoryPrompt = (prompt: string) => {
    const intent = classifyIntent(prompt, gazetteer);
    return intent !== "brand" && intent !== "navigational";
  };
  const perEngine = ENGINE_ROSTER.map((engine) => {
    const computed = computePerEngineVisibility(engine, capture.probes, gazetteer, isCategoryPrompt);
    // Engines with no wired connector surface as explicit UNAVAILABLE columns.
    return computed.promptsTotal > 0 ? computed : { ...computed, source: ENGINE_PROVIDERS[engine] };
  });

  const seoScore = computeCheckScore(SEO_CHECKS, audit.seoChecks);
  const geoReadiness = computeCheckScore(GEO_READINESS_CHECKS, audit.geoChecks);
  // enginesTotal is the ENGINE roster (a3's five), not the competitor roster.
  const visibility = computeVisibilityIndex(perEngine, ENGINE_ROSTER.length);
  // Presence split uses the SAME intent classifier as the per-engine category
  // metrics, so the panel's "N category / M brand questions" subtitle can never
  // disagree with its own engine cards (previously presence used a raw alias
  // match while the cards used classifyIntent — off-by-one subtitles).
  //
  // CD-J1: the frozen question set is the denominator. A question every engine
  // failed on stays in its bucket as planned-but-not-measured instead of dropping
  // out and shrinking the ratio the client is shown.
  const presence = computePresence(
    capture.probes,
    gazetteer,
    (prompt) => !isCategoryPrompt(prompt),
    capture.promptSet,
  );
  const rosterSharePct = computeRosterSharePct(capture.probes, gazetteer, isCategoryPrompt);

  // Open brand discovery: which brands did the engines name that we do NOT track?
  // Feeds LLM-aware competitor selection (competitor-sync) + the panel's
  // "also named by the engines" list. Best-effort, never blocks the run.
  const discoveredBrands = await discoverAnswerBrands(client, capture.answers, gazetteer, isCategoryPrompt);

  // PDF/report contract: intent-tagged prompts, the per-question × per-engine grid,
  // the citation-domain leaderboard, ghost-citation summary, and competitors named.
  //
  // CD-B3: every client-vs-competitor number is measured on CATEGORY questions only.
  // Branded and navigational prompts name the client (and often only the client) by
  // construction, so counting them hands the client an unfair advantage over every
  // tracked competitor and shows them a biased score. The answer grid keeps the FULL
  // prompt set — it is the methodology exhibit, and its whole job is to show which
  // questions were asked and how each one landed, branded ones included.
  const categoryProbes = capture.probes.filter((p) => isCategoryPrompt(p.prompt));
  const intentPrompts: IntentPrompt[] = tagPromptIntents(capture.promptSet, gazetteer);
  const answerGrid = buildAnswerGrid(intentPrompts, ENGINE_ROSTER, capture.probes);
  const citationLeaderboard = computeCitationLeaderboard(categoryProbes, gazetteer);
  const citationSummary = computeCitationSummary(categoryProbes);
  const competitorsNamed = computeCompetitorsNamed(categoryProbes, gazetteer);

  // QA F11: the two registries share nine ids, and the audit prompt asks the model
  // for every id from both — so one real defect emitted two cards with different
  // priority chips. Collapsed here, at the source, so gaps[], recommendations[] and
  // both markdown briefs all see one row per defect.
  const gaps: VisibilityGap[] = dedupeGapsByRecId(
    [
      ...computeCheckGaps(SEO_CHECKS, audit.seoChecks, "SEO"),
      ...computeCheckGaps(GEO_READINESS_CHECKS, audit.geoChecks, "GEO"),
      ...computeVisibilityGaps(perEngine),
    ].sort((a, b) => b.scoreLift - a.scoreLift),
  );

  const now = Date.now();
  const insights: SeoGeoInsights = {
    clientId: client.id,
    capturedAt: now,
    // CD-B4: stamp what measured this, so the panel can tell current results from
    // ones computed under superseded rules rather than presenting both as fact.
    pipelineVersion: SEO_GEO_PIPELINE_VERSION,
    // CD-J1: and stamp the question methodology, so a snapshot's denominators are
    // always read by the rules that produced them. Old captures keep rendering as
    // what they were — a description of one run — instead of being reinterpreted
    // as a short measurement against today's fixed plan.
    methodologyVersion: SEO_GEO_METHODOLOGY_VERSION,
    seoScore: seoScore.score,
    seoDataCoveragePct: seoScore.dataCoveragePct,
    geoReadiness: geoReadiness.score,
    geoReadinessCoveragePct: geoReadiness.dataCoveragePct,
    geoVisibilityIndex: visibility.index,
    geoVisibilityCoveragePct: visibility.dataCoveragePct,
    geoVisibilityModel: visibility.model,
    geoVisibilityEnginesMeasured: visibility.enginesMeasured,
    geoVisibilityEnginesScored: visibility.enginesScored,
    geoVisibilityEnginesTotal: visibility.enginesTotal,
    rosterSharePct,
    categoryPresence: presence.category,
    brandPresence: presence.brand,
    perEngine,
    gaps,
    recommendations: buildRecommendations(gaps),
    seoChecks: audit.seoChecks,
    geoChecks: audit.geoChecks,
    promptSet: capture.promptSet,
    intentPrompts,
    answerGrid,
    citationLeaderboard,
    citationSummary,
    competitorsNamed,
    discoveredBrands,
    roster: capture.roster,
    updatedAt: now,
  };

  return {
    seoBrief: buildSeoBrief(audit, insights),
    geoBrief:
      capture.probes.length > 0
        ? buildGeoBrief(insights)
        : "> RESEARCH UNAVAILABLE: the AI answer-engine visibility capture failed for this run. Do NOT fabricate GEO visibility findings — use '—' for any visibility metric.",
    insights,
  };
}
