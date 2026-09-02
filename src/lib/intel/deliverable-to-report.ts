import "server-only";

import type { ClientCompetitor, CustomerSentimentEntry } from "@/lib/types";
import type { ParsedReport } from "@/lib/report-parser";
import { renderIntelReport } from "@/lib/agent-engine/intel-report-render";

/**
 * Turns one `intel-report-agent` deliverable into the `ParsedReport` the portal
 * has always stored — the piece that lets Phase A go.
 *
 * Until now `runIntelReportPipeline` produced a `ParsedReport` the only way it
 * could: generate the whole report as markdown in-process from
 * `DEFAULT_INTEL_PROMPT`, then regex it back apart (`parseMarkdownReport`).
 * That round trip is what this module replaces. `intel-report-agent` already
 * emits every one of those fields as typed structured output — RFC-05 §4 was
 * explicitly a port of `DEFAULT_INTEL_PROMPT`, and SCRUM-267 (T-A18) then made
 * the engine's own persisted record "BE the portal's `ClientReport`, field for
 * field". So the mapping below is a rename, not a reconstruction: no model
 * call, no markdown, no regex.
 *
 * ## Why it is still defensive
 *
 * The deliverable is schema-validated on the way out (`IntelReportOutputSchema`
 * in agent-engine's `packages/tools/karos-intel/src/types.ts`), so in principle
 * every field is present and well-typed. It is read defensively anyway, for the
 * reason every other cross-repo reader in `src/lib/agent-engine/` is: the two
 * repos deploy independently, and a deliverable written by an older engine
 * revision should render a thinner report, never throw in the middle of a
 * pipeline that has already paid for two agent runs. `ParsedReport`'s fields
 * are all required, so "thinner" means the same empty-string/empty-array
 * defaults `parseMarkdownReport` produced for a section the model omitted.
 */

/* ────────────────────── value helpers ───────────────────── */

function str(value: unknown): string {
  return typeof value === "string" && value.trim().length > 0 ? value.trim() : "";
}

function num(value: unknown): number {
  return typeof value === "number" && Number.isFinite(value) ? value : 0;
}

function rec(value: unknown): Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

function objArray(value: unknown): Record<string, unknown>[] {
  return Array.isArray(value) ? value.map(rec) : [];
}

function strArray(value: unknown): string[] {
  return Array.isArray(value) ? value.filter((v): v is string => typeof v === "string" && v.trim().length > 0) : [];
}

/* ────────────────────── the dimension table ───────────────────── */

/**
 * The eight scored dimensions: the engine's key, the portal's label, the weight.
 *
 * Three facts that have to agree, and now do so in one place. The keys and
 * weights are `DIMENSION_WEIGHTS` in agent-engine's `karos-intel` package
 * (`contentMessaging` 15, `conversion` 15, `seo` 12, `geo` 8, `positioning` 15,
 * `brand` 10, `growth` 10, `social` 15 — summing to 100). The labels are the
 * exact strings `DEFAULT_INTEL_PROMPT`'s own Dimension Scores table used
 * (`brain.ts`, the numbered scoring list and the markdown template under it),
 * which is what `parseDimensionScores` read out of the generated markdown and
 * therefore what every `ClientReport` already in Firestore stores.
 *
 * Keeping the legacy labels is deliberate. A stored report renders its
 * dimension rows from this string, so switching to the camelCase key would make
 * every historical report and every new one disagree on screen for no gain.
 */
export const INTEL_DIMENSIONS = [
  { key: "contentMessaging", label: "Content & Messaging", weight: 15 },
  { key: "conversion", label: "Conversion Optimization", weight: 15 },
  { key: "seo", label: "SEO & Discoverability", weight: 12 },
  { key: "geo", label: "GEO & AI Discoverability", weight: 8 },
  { key: "positioning", label: "Competitive Positioning", weight: 15 },
  { key: "brand", label: "Brand & Trust", weight: 10 },
  { key: "growth", label: "Growth & Strategy", weight: 10 },
  { key: "social", label: "Social Media & Community", weight: 15 },
] as const;

const DIMENSION_BY_KEY: ReadonlyMap<string, (typeof INTEL_DIMENSIONS)[number]> = new Map(
  INTEL_DIMENSIONS.map((d) => [d.key, d]),
);

/**
 * The deliverable's dimension scores, in the fixed table order above.
 *
 * Ordered by the table rather than by the array as it arrived, so the rendered
 * report reads in the same order every time regardless of what order the model
 * emitted. A key the table does not know is kept rather than dropped — it is
 * real scored judgment, and losing it silently would be worse than showing it
 * last with the weight the deliverable itself carried.
 */
function mapDimensionScores(value: unknown): ParsedReport["dimensionScores"] {
  const rows = objArray(value);
  const byKey = new Map(rows.map((row) => [str(row["dimension"]), row]));

  const known = INTEL_DIMENSIONS.flatMap((dimension) => {
    const row = byKey.get(dimension.key);
    if (!row) return [];
    return [{ dimension: dimension.label, weight: dimension.weight, score: num(row["score"]) }];
  });

  const unknown = rows
    .filter((row) => !DIMENSION_BY_KEY.has(str(row["dimension"])))
    .map((row) => ({
      dimension: str(row["dimension"]),
      weight: num(row["weight"]),
      score: num(row["score"]),
    }))
    .filter((row) => row.dimension !== "");

  return [...known, ...unknown];
}

/* ────────────────────── row mappers ───────────────────── */

const MARKET_TIERS = new Set(["Leader", "Challenger", "Niche", "Other"]);
const OVERLAPS = new Set(["High", "Medium", "Low-Med", "Low"]);
const THREAT_LEVELS = new Set(["HIGH", "MEDIUM", "LOW"]);

type CompetitorRow = ParsedReport["competitorRows"][number];

/**
 * One competitor row.
 *
 * `marketTier`/`overlap`/`threatLevel` are literal unions on the portal's
 * `ClientCompetitor`, and the engine validates them against the same three sets
 * (`MARKET_TIERS`/`OVERLAPS`/`THREAT_LEVELS` in `karos-intel`'s types). They are
 * re-checked here rather than cast, because a cast would let a drifted engine
 * write a value the portal's own union says cannot exist into Firestore — the
 * one failure this whole module is positioned to prevent. An unrecognised tier
 * or overlap falls back to the neutral member; an unrecognised threat level is
 * dropped, since it is optional and has no neutral member.
 */
function mapCompetitor(raw: Record<string, unknown>): CompetitorRow | undefined {
  const company = str(raw["company"]);
  if (!company) return undefined;

  const marketTier = str(raw["marketTier"]);
  const overlap = str(raw["overlap"]);
  const threatLevel = str(raw["threatLevel"]);

  return {
    company,
    ...(str(raw["url"]) ? { url: str(raw["url"]) } : {}),
    ...(str(raw["founded"]) ? { founded: str(raw["founded"]) } : {}),
    marketTier: (MARKET_TIERS.has(marketTier) ? marketTier : "Other") as ClientCompetitor["marketTier"],
    ...(str(raw["minInvestment"]) ? { minInvestment: str(raw["minInvestment"]) } : {}),
    overlap: (OVERLAPS.has(overlap) ? overlap : "Low") as ClientCompetitor["overlap"],
    deepDive: raw["deepDive"] === true,
    ...(str(raw["positioning"]) ? { positioning: str(raw["positioning"]) } : {}),
    ...(str(raw["scale"]) ? { scale: str(raw["scale"]) } : {}),
    keyStrengths: strArray(raw["keyStrengths"]),
    keyWeaknesses: strArray(raw["keyWeaknesses"]),
    ...(THREAT_LEVELS.has(threatLevel) ? { threatLevel: threatLevel as ClientCompetitor["threatLevel"] } : {}),
  };
}

function mapCompetitorRankings(value: unknown): ParsedReport["competitorRankings"] {
  return objArray(value)
    .map((raw) => ({
      company: str(raw["company"]),
      score: num(raw["score"]),
      grade: str(raw["grade"]),
      rank: num(raw["rank"]),
      bestDimension: str(raw["bestDimension"]),
      weakestDimension: str(raw["weakestDimension"]),
    }))
    .filter((row) => row.company !== "");
}

function mapRecommendations(value: unknown): ParsedReport["recommendations"] {
  return objArray(value)
    .map((raw) => ({
      number: num(raw["number"]),
      title: str(raw["title"]),
      description: str(raw["description"]),
      priority: num(raw["priority"]),
      priorityLabel: str(raw["priorityLabel"]),
      tag: str(raw["tag"]),
    }))
    .filter((row) => row.title !== "");
}

function mapBrandVoiceRows(value: unknown): ParsedReport["brandVoiceRows"] {
  return objArray(value)
    .map((raw) => {
      const scores: Record<string, string> = {};
      for (const [company, score] of Object.entries(rec(raw["scores"]))) {
        if (typeof score === "string" && score.trim()) scores[company] = score.trim();
      }
      return { dimension: str(raw["dimension"]), scores };
    })
    .filter((row) => row.dimension !== "");
}

function mapCustomerSentiment(value: unknown): CustomerSentimentEntry[] {
  return objArray(value)
    .map((raw) => ({
      company: str(raw["company"]),
      ...(str(raw["rating"]) ? { rating: str(raw["rating"]) } : {}),
      ...(str(raw["ratingLabel"]) ? { ratingLabel: str(raw["ratingLabel"]) } : {}),
      ...(str(raw["responseTime"]) ? { responseTime: str(raw["responseTime"]) } : {}),
      ...(str(raw["wouldReturn"]) ? { wouldReturn: str(raw["wouldReturn"]) } : {}),
    }))
    .filter((row) => row.company !== "");
}

/* ────────────────────── the mapping ───────────────────── */

/** `YYYY-MM-DD`, the format `parseMarkdownReport` read out of the report header. */
function defaultReportDate(at: number): string {
  return new Date(at).toISOString().slice(0, 10);
}

/**
 * Map an `intel-report-agent` deliverable onto `ParsedReport`.
 *
 * Everything downstream — `buildClientReport`, `generateReportHtml`,
 * `replaceReportCompetitors` — is unchanged and unaware that the report no
 * longer came from markdown. That is the point of landing on `ParsedReport`
 * rather than writing a second `ClientReport` builder: there is exactly one
 * definition of what a stored report looks like, and this feeds it.
 *
 * `overallScore`/`overallGrade` come off the deliverable, not from arithmetic
 * here. The engine computes them deterministically from the dimension scores
 * (`karos-intel`'s `scoring.ts`) precisely so no model — and no second
 * implementation like this one — restates the weighted sum and gets it wrong.
 */
export function parsedReportFromDeliverable(
  deliverable: Record<string, unknown>,
  options: { fallbackUrl?: string; now: number },
): ParsedReport {
  return {
    reportDate: str(deliverable["reportDate"]) || defaultReportDate(options.now),
    url: str(deliverable["url"]) || str(options.fallbackUrl),
    businessType: str(deliverable["businessType"]),
    founded: str(deliverable["founded"]),
    authorization: str(deliverable["authorization"]),
    cnpj: str(deliverable["cnpj"]),
    minInvestment: str(deliverable["minInvestment"]),
    techStack: str(deliverable["techStack"]),
    reportStatus: str(deliverable["reportStatus"]),
    overallScore: num(deliverable["overallScore"]),
    overallGrade: str(deliverable["overallGrade"]),
    dimensionScores: mapDimensionScores(deliverable["dimensionScores"]),
    competitorRankings: mapCompetitorRankings(deliverable["competitorRankings"]),
    contentAnalysis: str(deliverable["contentAnalysis"]),
    conversionAnalysis: str(deliverable["conversionAnalysis"]),
    seoAnalysis: str(deliverable["seoAnalysis"]),
    geoAnalysis: str(deliverable["geoAnalysis"]),
    positioningAnalysis: str(deliverable["positioningAnalysis"]),
    brandAnalysis: str(deliverable["brandAnalysis"]),
    growthAnalysis: str(deliverable["growthAnalysis"]),
    swot: {
      strengths: strArray(rec(deliverable["swot"])["strengths"]),
      weaknesses: strArray(rec(deliverable["swot"])["weaknesses"]),
      opportunities: strArray(rec(deliverable["swot"])["opportunities"]),
      threats: strArray(rec(deliverable["swot"])["threats"]),
    },
    recommendations: mapRecommendations(deliverable["recommendations"]),
    brandVoiceRows: mapBrandVoiceRows(deliverable["brandVoiceRows"]),
    brandVoiceArchetypes: objArray(deliverable["brandVoiceArchetypes"])
      .map((raw) => ({ company: str(raw["company"]), archetype: str(raw["archetype"]) }))
      .filter((row) => row.company !== ""),
    brandVoiceTerritory: str(deliverable["brandVoiceTerritory"]),
    customerSentiment: mapCustomerSentiment(deliverable["customerSentiment"]),
    whitespaceOpportunities: strArray(deliverable["whitespaceOpportunities"]),
    competitorRows: objArray(deliverable["competitors"])
      .map(mapCompetitor)
      .filter((row): row is CompetitorRow => row !== undefined),
  };
}

/**
 * The markdown stored as `ClientReport.rawMarkdown`.
 *
 * `rawMarkdown` used to be the literal model output the whole report was parsed
 * out of — the source of truth. It is now a rendering of the structured
 * deliverable, which inverts that relationship: the fields are authoritative
 * and this is a view of them. Kept because the field is required on
 * `ClientReport` and several surfaces read it, and rendered through the same
 * `renderIntelReport` the run's own reviewable asset uses, so the report a
 * reviewer reads on the job and the one stored on the client cannot diverge.
 */
export function rawMarkdownFromDeliverable(deliverable: Record<string, unknown>): string {
  return renderIntelReport(deliverable).content;
}
