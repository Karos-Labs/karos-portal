/**
 * [T-B17/SCRUM-270] The structured renderer for `intel-report-agent`'s
 * deliverable.
 *
 * `materializeIntelReport` (./materialize.ts) used to build this asset's
 * `content` by hand-flattening the deliverable into markdown-ish text —
 * `joinBlocks` string concatenation and manual `- ${key}: ${score}/100`
 * lines, built and read inline, with no typed intermediate shape at all. This
 * module replaces that: every field is parsed into a small typed record
 * first (`RenderedDimension`, `RenderedRecommendation`, a validated
 * `RenderedSwot`), and the markdown is built from THOSE — proper headings,
 * a real dimension-scores table, recommendations grouped and numbered —
 * rather than being assembled and consumed as one undifferentiated string in
 * the same breath.
 *
 * No established wire contract exists for this deliverable (grepped: nothing
 * in this repo or its docs pins `intel-report-agent`'s exact field shape the
 * way C2/C3 pin seo-geo's or the wire brief's). Every parser here is
 * therefore defensive by the same convention every other cross-boundary
 * reader in `materialize.ts` already follows — asked for, never asserted, so
 * a payload whose shape drifted renders a thinner report, never a throw.
 */

/* ────────────────────── generic value helpers ───────────────────── */
/**
 * Deliberately re-declared rather than imported from `materialize.ts`: that
 * module has no exports for these (they are its own private plumbing), and
 * duplicating five two-line helpers is cheaper than opening that module's
 * internals just to share them. Keep both copies in sync if either changes
 * shape.
 */

function str(value: unknown): string | undefined {
  return typeof value === "string" && value.trim().length > 0 ? value.trim() : undefined;
}

function num(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

function strArray(value: unknown): string[] | undefined {
  if (!Array.isArray(value)) return undefined;
  const items = value.filter((v): v is string => typeof v === "string" && v.trim().length > 0);
  return items.length > 0 ? items : undefined;
}

function rec(value: unknown): Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value) ? (value as Record<string, unknown>) : {};
}

function objArray(value: unknown): Record<string, unknown>[] {
  return Array.isArray(value) ? value.map(rec) : [];
}

function firstOf(...candidates: unknown[]): string | undefined {
  for (const candidate of candidates) {
    const value = str(candidate);
    if (value) return value;
  }
  return undefined;
}

/* ────────────────────── typed intermediate shapes ───────────────────── */

/** One dimension score, parsed off whichever label field the deliverable used. */
export interface RenderedDimension {
  label: string;
  score: number;
  /** 0-100 weight, when the deliverable carried one. Not every payload does. */
  weight?: number;
}

/** One recommendation, parsed defensively — see the module doc comment. */
export interface RenderedRecommendation {
  title: string;
  description?: string;
  priority?: number;
  priorityLabel?: string;
  tag?: string;
}

/** One SWOT arm's items, only present when the deliverable actually carried some. */
export interface RenderedSwot {
  strengths?: string[];
  weaknesses?: string[];
  opportunities?: string[];
  threats?: string[];
}

const ANALYSIS_SECTIONS = [
  ["Content & Messaging", "contentAnalysis"],
  ["Conversion Optimization", "conversionAnalysis"],
  ["SEO & Discoverability", "seoAnalysis"],
  ["GEO & AI Visibility", "geoAnalysis"],
  ["Competitive Positioning", "positioningAnalysis"],
  ["Brand & Trust", "brandAnalysis"],
  ["Growth & Strategy", "growthAnalysis"],
  ["Brand Synchronization Update", "brandSynchronizationUpdate"],
] as const;

const SWOT_ARMS = ["strengths", "weaknesses", "opportunities", "threats"] as const;

/* ────────────────────── parsing ───────────────────── */

function parseDimension(raw: Record<string, unknown>): RenderedDimension | undefined {
  const label = firstOf(raw["label"], raw["key"], raw["dimension"], raw["name"]);
  const score = num(raw["score"]);
  if (!label || score === undefined) return undefined;
  return { label, score, weight: num(raw["weight"]) };
}

function parseRecommendation(raw: Record<string, unknown>): RenderedRecommendation | undefined {
  // No field name is pinned by any known contract (see module doc comment),
  // so every plausible title-bearing field is tried before giving up on the
  // record entirely — the same "ask, don't assert" idiom `materializeSeoGeoReport`
  // already applies to its own recommendation records one file over.
  const title = firstOf(raw["title"], raw["recommendation"], raw["name"], raw["headline"], raw["id"]);
  if (!title) return undefined;
  return {
    title,
    description: firstOf(raw["description"], raw["detail"], raw["body"]),
    priority: num(raw["priority"]),
    priorityLabel: firstOf(raw["priorityLabel"], raw["priority_label"]),
    tag: firstOf(raw["tag"], raw["category"]),
  };
}

function parseSwot(raw: unknown): RenderedSwot {
  const swot = rec(raw);
  const out: RenderedSwot = {};
  for (const arm of SWOT_ARMS) {
    const items = strArray(swot[arm]);
    if (items) out[arm] = items;
  }
  return out;
}

/* ────────────────────── rendering ───────────────────── */

/** A markdown table for the dimension scores — a `Weight` column only when at least one row actually carries one. */
function renderDimensionTable(dimensions: readonly RenderedDimension[]): string | undefined {
  if (dimensions.length === 0) return undefined;
  const hasWeight = dimensions.some((d) => d.weight !== undefined);
  const header = hasWeight ? "| Dimension | Score | Weight |\n|---|---|---|" : "| Dimension | Score |\n|---|---|";
  const rows = dimensions.map((d) =>
    hasWeight ? `| ${d.label} | ${d.score}/100 | ${d.weight !== undefined ? `${d.weight}%` : "—"} |` : `| ${d.label} | ${d.score}/100 |`,
  );
  return [header, ...rows].join("\n");
}

/** The overall-assessment section: score/grade line, then the dimension table. Omitted entirely when neither is present. */
function renderOverallSection(overallScore: number | undefined, overallGrade: string | undefined, dimensions: readonly RenderedDimension[]): string | undefined {
  const scoreLine =
    overallScore !== undefined ? `**Overall score: ${overallScore}/100${overallGrade ? ` (Grade ${overallGrade})` : ""}**` : undefined;
  const table = renderDimensionTable(dimensions);
  const body = [scoreLine, table].filter((part): part is string => Boolean(part)).join("\n\n");
  return body ? `## Overall Assessment\n\n${body}` : undefined;
}

/** The seven (plus one) prose analysis sections, one heading each, only for the ones the deliverable actually carried. */
function renderAnalysisSections(deliverable: Record<string, unknown>): string[] {
  return ANALYSIS_SECTIONS.map(([label, field]) => {
    const body = str(deliverable[field]);
    return body ? `## ${label}\n\n${body}` : undefined;
  }).filter((section): section is string => Boolean(section));
}

/** The SWOT section — one `###` sub-heading per non-empty arm, the whole section omitted when every arm is empty. */
function renderSwotSection(swot: RenderedSwot): string | undefined {
  const arms = SWOT_ARMS.map((arm) => {
    const items = swot[arm];
    if (!items) return undefined;
    const label = arm[0]!.toUpperCase() + arm.slice(1);
    return `### ${label}\n\n${items.map((i) => `- ${i}`).join("\n")}`;
  }).filter((arm): arm is string => Boolean(arm));
  return arms.length > 0 ? `## SWOT Analysis\n\n${arms.join("\n\n")}` : undefined;
}

/**
 * The recommendations section — grouped by `priorityLabel` (falling back to
 * `Priority ${priority}`, then a single unlabeled group when neither is
 * present), numbered within each group, same grouping shape
 * `generateReportHtml` (report-parser.ts's HTML renderer) already uses for
 * the portal's own in-house report so a reviewer sees the same structure in
 * both places.
 */
function renderRecommendationsSection(recommendations: readonly RenderedRecommendation[]): string | undefined {
  if (recommendations.length === 0) return undefined;

  const groups = new Map<string, RenderedRecommendation[]>();
  for (const r of recommendations) {
    const key = r.priorityLabel ?? (r.priority !== undefined ? `Priority ${r.priority}` : "Recommendations");
    const bucket = groups.get(key) ?? [];
    bucket.push(r);
    groups.set(key, bucket);
  }

  const groupBlocks = Array.from(groups.entries()).map(([label, items]) => {
    const lines = items.map((r, i) => {
      const tagSuffix = r.tag ? ` [${r.tag}]` : "";
      const descLine = r.description ? `\n   ${r.description}` : "";
      return `${i + 1}. **${r.title}**${tagSuffix}${descLine}`;
    });
    // A single unlabeled group renders with no redundant sub-heading — only
    // multiple groups (real priority tiers) get their own `###`.
    return groups.size > 1 ? `### ${label}\n\n${lines.join("\n")}` : lines.join("\n");
  });

  return `## Recommendations\n\n${groupBlocks.join("\n\n")}`;
}

export interface IntelReportRender {
  title: string;
  content: string;
}

/**
 * Renders one `intel-report-agent` deliverable into reviewer-readable
 * markdown, through typed field access rather than the ad hoc string
 * concatenation this replaces.
 *
 * Every section is independently optional and omitted (never rendered as an
 * empty heading) when the deliverable did not carry it — a deliverable with
 * none of these fields renders to an empty string, exactly as before, so a
 * still-thin payload degrades to nothing rather than to broken markdown.
 */
export function renderIntelReport(deliverable: Record<string, unknown>): IntelReportRender {
  const overallScore = num(deliverable["overallScore"]);
  const overallGrade = str(deliverable["overallGrade"]);
  const dimensions = objArray(deliverable["dimensionScores"])
    .map(parseDimension)
    .filter((d): d is RenderedDimension => d !== undefined);
  const recommendations = objArray(deliverable["recommendations"])
    .map(parseRecommendation)
    .filter((r): r is RenderedRecommendation => r !== undefined);
  const swot = parseSwot(deliverable["swot"]);

  const sections = [
    renderOverallSection(overallScore, overallGrade, dimensions),
    ...renderAnalysisSections(deliverable),
    renderSwotSection(swot),
    renderRecommendationsSection(recommendations),
  ].filter((section): section is string => Boolean(section));

  return {
    title: overallGrade ? `Competitive intelligence report (${overallGrade})` : "Competitive intelligence report",
    content: sections.join("\n\n"),
  };
}
