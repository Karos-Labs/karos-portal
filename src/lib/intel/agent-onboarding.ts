import "server-only";

import type {
  Client,
  ClientContextDoc,
  ContextDocTier,
  ContextDocType,
} from "@/lib/types";

/**
 * SCRUM-272 (T-B20) — the path the 13 context documents take after cutover.
 *
 * D1 (SCRUM-277) was answered by Tomer on 2026-08-28 (decision 5 of the record
 * on SCRUM-333): option 1 ("keep the generator as a separate path") and option 3
 * ("derive them from the intel output") both lose. The hardcoded onboarding
 * pipeline goes, and onboarding is rebuilt on the REAL Intel Report and SEO/GEO
 * agents in the new agent-engine.
 *
 * The decision also carries the constraint that is the whole risk of it, quoted
 * verbatim from the record:
 *
 *   "the output must be written in exactly the same shape, to exactly the same
 *    Firestore location the system already reads from. The wrapper and every
 *    existing query stay identical. […] A rewrite that changes the read path as
 *    a side effect turns one ticket into a migration."
 *
 * This module is that constraint made executable. It contains:
 *
 *   1. CONTEXT_DOC_SET_CONTRACT — the (docType, tier) rows and the stored field
 *      set, read out of the code that already reads them, not out of the ticket.
 *   2. assertContextDocSetShape — a gate the new path must pass BEFORE the
 *      write. It is the only thing standing between "we swapped the producer"
 *      and "we silently migrated the read path".
 *   3. composeContextDocsFromAgentReports — the pure mapping from the two real
 *      agent-engine deliverables (`intel-report`, `seo-geo-report`) to the eight
 *      generated documents.
 *   4. runAgentOnboarding — dispatch → await deliverables → compose → condense →
 *      ASSERT → write, through `replaceClientContextDocs`, which is not touched.
 *
 * A NOTE ON THE NUMBER 13. The ticket, D1 and this file's own predecessor all
 * say "the 13 context documents". The code says otherwise and the code wins:
 * `runOnboardPipeline` writes SIX internal rows, TWO internal-only rows and up
 * to SIX client-tier condensations (empty ones dropped) — 8 distinct documents,
 * up to 14 stored rows. pipeline.ts's own two comments contradict each other on
 * this ("the 6 public docs" in the header, "5 public docs" at phase 3). The
 * contract below is derived from `runOnboardPipeline`'s executable write, so a
 * document count is never load-bearing here: the (docType, tier) set is.
 */

/* ── The contract ─────────────────────────────────────────────────── */

/**
 * The six documents that exist at tier `internal` AND, condensed, at tier
 * `client`. Order is the order `client-documents.tsx`'s DOC_TABS renders.
 */
export const INTERNAL_CONTEXT_DOC_TYPES = [
  "brand-voice",
  "market-strategy",
  "competitor-analysis",
  "product-information",
  "branding-guidelines",
  "target-audience",
] as const satisfies readonly ContextDocType[];

/**
 * The two documents that are NEVER published to a client-role reader. Their
 * tier is `internal-only` and there is no client-tier counterpart — see
 * `ClientContextDoc`'s own tier rules and `pickDoc` in client-documents.tsx.
 */
export const INTERNAL_ONLY_CONTEXT_DOC_TYPES = [
  "client-guidelines",
  "action-plan",
] as const satisfies readonly ContextDocType[];

export type OnboardingDocType =
  | (typeof INTERNAL_CONTEXT_DOC_TYPES)[number]
  | (typeof INTERNAL_ONLY_CONTEXT_DOC_TYPES)[number];

/**
 * Exactly the keys `replaceClientContextDocs` is handed today, and therefore
 * exactly the keys a `clientContextDocs` row written by onboarding may carry.
 *
 * `sources`/`summary`/`summaryVersion` are deliberately ABSENT: onboarding has
 * never written them (`summary` is filled later by generateDocSummaryAction,
 * and a version-0 summary written at creation would present a stale cache as
 * fresh). Writing a field the old path never wrote is a shape change, which is
 * what the constraint forbids — so the guard rejects extra keys rather than
 * tolerating them.
 */
export const STORED_CONTEXT_DOC_FIELDS = [
  "clientId",
  "docType",
  "tier",
  "content",
  "version",
  "createdAt",
  "updatedAt",
] as const;

/** One (docType, tier) row the read path serves, and whether it is required. */
export interface ContextDocRowContract {
  docType: OnboardingDocType;
  tier: ContextDocTier;
  /**
   * `false` only for the client-tier condensations: `runOnboardPipeline` drops
   * a condensation whose content came back empty rather than putting a row in
   * the client's nav that opens onto an empty panel. That behaviour is part of
   * the shape the read path expects, so the new path keeps it.
   */
  required: boolean;
}

export const CONTEXT_DOC_SET_CONTRACT: readonly ContextDocRowContract[] = [
  ...INTERNAL_CONTEXT_DOC_TYPES.map(
    (docType): ContextDocRowContract => ({ docType, tier: "internal", required: true }),
  ),
  ...INTERNAL_ONLY_CONTEXT_DOC_TYPES.map(
    (docType): ContextDocRowContract => ({ docType, tier: "internal-only", required: true }),
  ),
  ...INTERNAL_CONTEXT_DOC_TYPES.map(
    (docType): ContextDocRowContract => ({ docType, tier: "client", required: false }),
  ),
];

/** A row as `replaceClientContextDocs` takes it — no Firestore id yet. */
export type StoredContextDoc = Omit<ClientContextDoc, "id">;

export class ContextDocShapeError extends Error {
  readonly violations: readonly string[];
  constructor(violations: readonly string[]) {
    super(
      `Context-document set violates the stored shape (SCRUM-272 / D1):\n  - ${violations.join("\n  - ")}`,
    );
    this.name = "ContextDocShapeError";
    this.violations = violations;
  }
}

/**
 * THE GATE. Throws unless `docs` is byte-for-byte the shape the existing read
 * path serves. Called immediately before `replaceClientContextDocs`, so a
 * producer that drifts fails the run instead of rewriting the collection.
 *
 * What makes it fail — every clause below has a case in
 * `src/lib/__tests__/agent-onboarding-shape.test.ts` that trips it:
 *
 *   - a required (docType, tier) row missing,
 *   - a (docType, tier) row that is not in the contract at all,
 *   - a duplicate (docType, tier),
 *   - `client-guidelines`/`action-plan` published at tier "client" (the no-leak
 *     boundary — the single most damaging thing a rewrite of this path can do),
 *   - a row whose clientId is empty or belongs to another client,
 *   - a field the old path never wrote (e.g. `sources`, or a new `agentRunId`),
 *   - a missing field,
 *   - empty content,
 *   - a version that is not a positive integer,
 *   - a non-finite createdAt/updatedAt.
 */
export function assertContextDocSetShape(
  docs: readonly StoredContextDoc[],
  clientId: string,
): void {
  const violations: string[] = [];

  const contractKeys = new Set(
    CONTEXT_DOC_SET_CONTRACT.map((row) => `${row.docType}::${row.tier}`),
  );
  const seen = new Set<string>();
  const allowedFields = new Set<string>(STORED_CONTEXT_DOC_FIELDS);

  for (const doc of docs) {
    const key = `${doc.docType}::${doc.tier}`;

    if (!contractKeys.has(key)) {
      violations.push(
        `row ${key} is not part of the stored context-document set — the read path does not serve it`,
      );
    }
    if (seen.has(key)) violations.push(`duplicate row ${key}`);
    seen.add(key);

    if (doc.clientId !== clientId) {
      violations.push(`row ${key} carries clientId ${JSON.stringify(doc.clientId)}, expected ${JSON.stringify(clientId)}`);
    }

    const present = Object.keys(doc as Record<string, unknown>);
    for (const field of present) {
      if (!allowedFields.has(field)) {
        violations.push(
          `row ${key} carries field ${JSON.stringify(field)}, which onboarding has never written — that is a shape change`,
        );
      }
    }
    for (const field of STORED_CONTEXT_DOC_FIELDS) {
      if (!present.includes(field)) violations.push(`row ${key} is missing field ${JSON.stringify(field)}`);
    }

    if (typeof doc.content !== "string" || doc.content.trim() === "") {
      violations.push(`row ${key} has empty content`);
    }
    if (!Number.isInteger(doc.version) || doc.version < 1) {
      violations.push(`row ${key} has version ${String(doc.version)}; expected a positive integer`);
    }
    for (const stamp of ["createdAt", "updatedAt"] as const) {
      if (!Number.isFinite(doc[stamp])) {
        violations.push(`row ${key} has a non-finite ${stamp}`);
      }
    }
  }

  for (const row of CONTEXT_DOC_SET_CONTRACT) {
    if (!row.required) continue;
    if (!seen.has(`${row.docType}::${row.tier}`)) {
      violations.push(`required row ${row.docType}::${row.tier} is missing`);
    }
  }

  if (violations.length) throw new ContextDocShapeError(violations);
}

/* ── The two real agent deliverables ──────────────────────────────── */

/**
 * `intel-report-agent`'s deliverable, by the field names `materialize.ts`
 * already reads off it (`materializeIntelReport`). Typed loosely on purpose:
 * this is a cross-repo wire shape, and a field the engine stops sending must
 * degrade to an omitted section, never to a thrown type error mid-onboarding.
 */
export type IntelReportDeliverable = Record<string, unknown>;

/** `seo-geo-agent`'s deliverable, same provenance (`materializeSeoGeoReport`). */
export type SeoGeoReportDeliverable = Record<string, unknown>;

function str(v: unknown): string | undefined {
  return typeof v === "string" && v.trim() ? v.trim() : undefined;
}

function rec(v: unknown): Record<string, unknown> {
  return v && typeof v === "object" && !Array.isArray(v) ? (v as Record<string, unknown>) : {};
}

function objArray(v: unknown): Record<string, unknown>[] {
  return Array.isArray(v) ? v.filter((e): e is Record<string, unknown> => Boolean(e) && typeof e === "object") : [];
}

function strArray(v: unknown): string[] {
  return Array.isArray(v) ? v.map((e) => (typeof e === "string" ? e.trim() : "")).filter(Boolean) : [];
}

function bullets(items: readonly string[]): string | undefined {
  return items.length ? items.map((i) => `- ${i}`).join("\n") : undefined;
}

function section(heading: string, body: string | undefined): string | undefined {
  return body ? `## ${heading}\n\n${body}` : undefined;
}

function joinBlocks(blocks: readonly (string | undefined)[]): string {
  return blocks.filter((b): b is string => Boolean(b && b.trim())).join("\n\n");
}

/**
 * One document: a title plus its sections, or the EMPTY STRING when no section
 * had anything behind it.
 *
 * Returning `""` rather than a lone `# Title` is deliberate and load-bearing.
 * A heading is non-empty text, so a document that is only a heading would sail
 * through the shape gate's content check and be stored as a client's ground
 * truth — the gate would be structurally incapable of catching the one failure
 * it exists for (an engine that answered with nothing). The emptiness has to be
 * visible to the check, so it is produced here.
 */
function document(title: string, sections: readonly (string | undefined)[]): string {
  const body = joinBlocks(sections);
  return body ? `${title}\n\n${body}` : "";
}

function labelledList(rows: readonly Record<string, unknown>[], labelKeys: readonly string[], valueKey?: string): string | undefined {
  const lines = rows
    .map((row) => {
      const label = labelKeys.map((k) => str(row[k])).find(Boolean);
      if (!label) return undefined;
      const value = valueKey === undefined ? undefined : row[valueKey];
      return typeof value === "number" ? `- ${label}: ${value}` : `- ${label}`;
    })
    .filter((l): l is string => Boolean(l));
  return lines.length ? lines.join("\n") : undefined;
}

/**
 * SCRUM-274 (T-B19). `ir.brandVoiceArchetypes` is `Array<{ company, archetype
 * }>` on the real deliverable (`packages/tools/karos-intel/src/types.ts`'s
 * `BrandVoiceArchetypeSchema` in agent-engine), not `string[]` — verified
 * directly against the ref clone while wiring this cutover. A plain
 * `strArray()` read (the pre-cutover code here) silently drops every row,
 * since none of them satisfy `typeof e === "string"`.
 */
function brandVoiceArchetypeList(rows: readonly Record<string, unknown>[]): string | undefined {
  const lines = rows
    .map((row) => {
      const archetype = str(row["archetype"]);
      if (!archetype) return undefined;
      const company = str(row["company"]);
      return company ? `- ${company}: ${archetype}` : `- ${archetype}`;
    })
    .filter((l): l is string => Boolean(l));
  return lines.length ? lines.join("\n") : undefined;
}

/**
 * SCRUM-274 (T-B19). `ir.brandVoiceRows` is `Array<{ dimension: string,
 * scores: Record<string, string> }>` on the real deliverable
 * (`BrandVoiceRowSchema`, same file) — a per-dimension row with one score PER
 * COMPANY, not the flat `{ attribute/label/name, score: number }` shape
 * `labelledList` expects. Kept tolerant of that older shape too (falls back
 * to a bare numeric `score` field) in case a differently-shaped fixture is
 * ever fed through, but the real shape is read correctly first.
 */
function brandVoiceAttributeList(rows: readonly Record<string, unknown>[]): string | undefined {
  const lines = rows
    .map((row) => {
      const label = str(row["dimension"]) ?? str(row["attribute"]) ?? str(row["label"]) ?? str(row["name"]);
      if (!label) return undefined;
      const scores = rec(row["scores"]);
      const perCompany = Object.entries(scores)
        .filter((e): e is [string, string] => typeof e[1] === "string" && e[1].trim().length > 0)
        .map(([company, score]) => `${company}: ${score}`);
      if (perCompany.length) return `- ${label} — ${perCompany.join(", ")}`;
      const value = row["score"];
      return typeof value === "number" ? `- ${label}: ${value}` : `- ${label}`;
    })
    .filter((l): l is string => Boolean(l));
  return lines.length ? lines.join("\n") : undefined;
}

/**
 * SCRUM-274 (T-B19). `ir.customerSentiment` is `CustomerSentimentEntry[]` —
 * `{ company, rating?, ratingLabel?, responseTime?, wouldReturn? }` — on the
 * real deliverable (`CustomerSentimentEntrySchema`, same file), not a
 * pre-rendered string. A plain `str()` read (the pre-cutover code here)
 * always returns `undefined` for an array, which combined with the
 * `promptSet` fix below is why `target-audience` used to compose EMPTY
 * against real agent-engine output — both of its sections read a field that
 * was never a string. See this ticket's report for the full finding.
 */
function customerSentimentList(rows: readonly Record<string, unknown>[]): string | undefined {
  const lines = rows
    .map((row) => {
      const company = str(row["company"]);
      if (!company) return undefined;
      const rating = str(row["rating"]);
      const ratingLabel = str(row["ratingLabel"]);
      const parts = [
        rating ? (ratingLabel ? `${rating} (${ratingLabel})` : rating) : undefined,
        str(row["responseTime"]) ? `response time ${str(row["responseTime"])}` : undefined,
        str(row["wouldReturn"]) ? `would return: ${str(row["wouldReturn"])}` : undefined,
      ].filter((p): p is string => Boolean(p));
      return parts.length ? `- ${company} — ${parts.join(", ")}` : `- ${company}`;
    })
    .filter((l): l is string => Boolean(l));
  return lines.length ? lines.join("\n") : undefined;
}

/**
 * The eight generated documents, composed from the two agent deliverables.
 *
 * Every section here is sourced from a field this repo already reads off the
 * same deliverable in `materialize.ts`, or — where SCRUM-274 (T-B19) found
 * `materialize.ts` itself only pass the field through untouched (`meta`) —
 * verified directly against the real, current Zod schemas in agent-engine's
 * ref clone (`packages/tools/karos-intel/src/types.ts`,
 * `agents/seo-geo-agent/src/workflow/types.ts`). Six field-path mismatches
 * against those real shapes were fixed as part of this ticket (see the
 * `brandVoiceArchetypeList`/`brandVoiceAttributeList`/`customerSentimentList`
 * helpers above and the `competitors`/`promptSetPrompts` locals below, each
 * with its own comment) — this is the check against inventing a wire shape
 * the engine does not send. A document that ends up with no content
 * at all is returned as an empty string and the caller's shape gate rejects the
 * run: an onboarding that produces a blank ground-truth document must fail
 * loudly, not store a placeholder for every downstream agent to read.
 */
/** Personas as the intel report now emits them (intel-report-craft@5 `targetAudience`). */
function personaBlock(p: Record<string, unknown>): string {
  const line = (label: string, v: unknown) => {
    const text = str(v);
    return text ? `- **${label}:** ${text}` : undefined;
  };
  const list = (label: string, v: unknown) => {
    const items = strArray(v);
    return items.length ? `- **${label}:** ${items.join("; ")}` : undefined;
  };
  const title = `### ${str(p["label"]) ?? "Persona"}${p["isPrimary"] === true ? " (primary)" : ""}`;
  return joinBlocks([
    title,
    line("Demographics & firmographics", p["firmographics"]),
    line("Role in the buying committee", p["role"]),
    list("Core pain points", p["painPoints"]),
    list("Success metrics they are judged on", p["successMetrics"]),
    list("Incumbent tools & methods", p["incumbentTools"]),
    list("Where the incumbents fall short", p["incumbentShortfalls"]),
    list("Switching triggers", p["switchingTriggers"]),
    list("Channels & formats that reach them", p["channels"]),
    list("Trust builders", p["trustBuilders"]),
    list("Vocabulary they use", p["vocabulary"]),
    list("How they describe the problem", p["problemPhrases"]),
    list("How they describe the ideal outcome", p["outcomePhrases"]),
    list("Words & phrases to avoid in copy", p["avoidPhrases"]),
  ]);
}

/** One competitor profile in the shape legacy's "Competitor Profiles" section carried. */
function competitorProfile(c: Record<string, unknown>): string | undefined {
  const name = str(c["company"]);
  if (!name) return undefined;
  const url = str(c["url"]);
  const facts = [
    str(c["marketTier"]) ? `**Market tier:** ${str(c["marketTier"])}` : undefined,
    str(c["overlap"]) ? `**Overlap with us:** ${str(c["overlap"])}` : undefined,
    str(c["threatLevel"]) ? `**Threat level:** ${str(c["threatLevel"])}` : undefined,
    str(c["founded"]) ? `**Founded:** ${str(c["founded"])}` : undefined,
    str(c["scale"]) ? `**Scale:** ${str(c["scale"])}` : undefined,
    str(c["positioning"]) ? `**Positioning:** ${str(c["positioning"])}` : undefined,
    strArray(c["keyStrengths"]).length ? `**Key strengths:** ${strArray(c["keyStrengths"]).join("; ")}` : undefined,
    strArray(c["keyWeaknesses"]).length ? `**Key weaknesses:** ${strArray(c["keyWeaknesses"]).join("; ")}` : undefined,
  ].filter((f): f is string => Boolean(f));
  return joinBlocks([`### ${name}${url ? ` (${url})` : ""}${c["deepDive"] === true ? " — deep dive" : ""}`, facts.join("\n")]);
}

/** A recommendation with its description and priority, not just its title. */
function recommendationBlock(r: Record<string, unknown>): string | undefined {
  const title = str(r["title"]) ?? str(r["recommendation"]) ?? str(r["id"]);
  if (!title) return undefined;
  const priority = str(r["priorityLabel"]) ?? (typeof r["priority"] === "number" ? `P${r["priority"]}` : undefined);
  const tag = str(r["tag"]);
  const head = `**${title}**${priority ? ` — ${priority}` : ""}${tag ? ` · ${tag}` : ""}`;
  const desc = str(r["description"]);
  return desc ? `${head}\n${desc}` : head;
}

/** A fired SEO/GEO recommendation with what it targets and what it is worth. */
function firedBlock(r: Record<string, unknown>): string | undefined {
  const title = str(r["recommendation"]) ?? str(r["title"]) ?? str(r["recId"]);
  if (!title) return undefined;
  const meta = [
    str(r["recId"]),
    str(r["fireState"]) ? `state ${str(r["fireState"])}` : undefined,
    str(r["impact"]) ? `impact ${str(r["impact"])}` : undefined,
    str(r["effort"]) ? `effort ${str(r["effort"])}` : undefined,
    typeof r["scoreLift"] === "number" ? `+${r["scoreLift"]} pts` : undefined,
  ].filter((m): m is string => Boolean(m));
  return `**${title}**${meta.length ? ` (${meta.join(", ")})` : ""}`;
}

function dimensionScoreList(rows: readonly Record<string, unknown>[]): string | undefined {
  if (!rows.length) return undefined;
  const lines = rows
    .map((r) => {
      const label = str(r["label"]) ?? str(r["dimension"]) ?? str(r["key"]);
      const score = r["score"];
      return label && typeof score === "number" ? `- ${label}: ${score}/100` : undefined;
    })
    .filter((l): l is string => Boolean(l));
  return lines.length ? lines.join("\n") : undefined;
}

/**
 * Compose every context document from the two research deliverables.
 *
 * Each document is a fixed template over the deliverables' fields — no model
 * call, so a document can never say something the research did not. The
 * 2026-09-05 revision exists because the first template used a fraction of
 * what the intel report carries: eight competitors with positioning, tier,
 * strengths and weaknesses were rendered as a bullet list of names; the SEO
 * and GEO analyses were dropped; recommendations lost their descriptions and
 * priorities; and target-audience had NO audience in it at all (the report
 * had no such field — intel-report-craft@5 adds `targetAudience`). The
 * documents were the right shape and a third of the substance.
 *
 * These documents are what every other agent reads as its picture of the
 * client, so a field the report bothered to ground is a field the agents
 * should see.
 */
export function composeContextDocsFromAgentReports(input: {
  client: Pick<Client, "id" | "name">;
  intelReport: IntelReportDeliverable;
  seoGeo: SeoGeoReportDeliverable;
}): Record<OnboardingDocType, string> {
  const { client, intelReport: ir, seoGeo: sg } = input;
  const swot = rec(ir["swot"]);
  const seoScore = rec(sg["seoScore"])["score"];
  const geoScore = rec(sg["geoReadiness"])["score"];
  const visibilityIndex = rec(rec(sg["visibility"])["byN"])["index"];
  const header = (title: string) => `# ${title} — ${client.name}`;
  const scoreLine = [
    typeof seoScore === "number" ? `SEO ${seoScore}` : undefined,
    typeof geoScore === "number" ? `GEO readiness ${geoScore}` : undefined,
    typeof visibilityIndex === "number" ? `AI visibility index ${visibilityIndex}` : undefined,
  ]
    .filter((p): p is string => Boolean(p))
    .join(" · ");
  const overall =
    typeof ir["overallScore"] === "number"
      ? `**Overall intel score: ${ir["overallScore"]}/100${str(ir["overallGrade"]) ? ` (grade ${str(ir["overallGrade"])})` : ""}**`
      : undefined;

  const recommendations = objArray(ir["recommendations"]);
  const fired = objArray(sg["firedRecommendations"]);
  const competitors = objArray(ir["competitors"]);
  const rankings = objArray(ir["competitorRankings"]);
  const dimensionScores = objArray(ir["dimensionScores"]);
  const promptSetPrompts = objArray(rec(sg["promptSet"])["prompts"]);
  const targetAudience = rec(ir["targetAudience"]);
  const personas = objArray(targetAudience["personas"]);
  const swotBlock = joinBlocks(
    (["strengths", "weaknesses", "opportunities", "threats"] as const).map((key) => {
      const list = bullets(strArray(swot[key]));
      return list ? `**${key[0]!.toUpperCase()}${key.slice(1)}**\n${list}` : undefined;
    }),
  );
  const rankingLines = rankings
    .map((r) => {
      const name = str(r["company"]) ?? str(r["name"]);
      const score = r["score"];
      const grade = str(r["grade"]);
      const rank = r["rank"];
      if (!name || typeof score !== "number") return undefined;
      const strongest = str(r["bestDimension"]);
      const weakest = str(r["weakestDimension"]);
      return `- ${typeof rank === "number" ? `#${rank} ` : ""}${name}: ${score}/100${grade ? ` (${grade})` : ""}${strongest ? ` — strongest in ${strongest}` : ""}${weakest ? `, weakest in ${weakest}` : ""}`;
    })
    .filter((l): l is string => Boolean(l));
  const rankingList = rankingLines.length ? rankingLines.join("\n") : undefined;
  const scoreHeader = [overall, scoreLine ? `**${scoreLine}**` : undefined].filter((p): p is string => Boolean(p)).join("\n") || undefined;

  return {
    "brand-voice": document(header("Brand Voice"), [
      section("Brand analysis", str(ir["brandAnalysis"])),
      section("Voice territory", str(ir["brandVoiceTerritory"])),
      section("Archetypes", brandVoiceArchetypeList(objArray(ir["brandVoiceArchetypes"]))),
      section("Voice attributes", brandVoiceAttributeList(objArray(ir["brandVoiceRows"]))),
      section("Brand synchronization update", str(ir["brandSynchronizationUpdate"])),
    ]),
    "market-strategy": document(header("Market Strategy"), [
      scoreHeader,
      section("Dimension scores", dimensionScoreList(dimensionScores)),
      section("Positioning", str(ir["positioningAnalysis"])),
      section("Growth", str(ir["growthAnalysis"])),
      section("Whitespace opportunities", bullets(strArray(ir["whitespaceOpportunities"]))),
      section("SEO & discoverability", str(ir["seoAnalysis"])),
      section("GEO & AI discoverability", str(ir["geoAnalysis"])),
      section("Search and answer-engine visibility", str(sg["narrative"])),
      section("Strategic recommendations", joinBlocks(recommendations.map(recommendationBlock))),
    ]),
    "competitor-analysis": document(header("Competitor Analysis"), [
      competitors.length ? `**Competitors analysed: ${competitors.length}**` : undefined,
      section("Competitive ranking", rankingList),
      section("Competitor profiles", joinBlocks(competitors.map(competitorProfile))),
      section("SWOT", swotBlock),
      section("Share of voice in AI answers", labelledList(objArray(rec(sg["visibility"])["engines"]), ["engine", "label", "name"], "mentions")),
    ]),
    "product-information": document(header("Product Information"), [
      section("Positioning", str(ir["positioningAnalysis"])),
      section("Content analysis", str(ir["contentAnalysis"])),
      section("Conversion analysis", str(ir["conversionAnalysis"])),
      section("Voice territory", str(ir["brandVoiceTerritory"])),
    ]),
    "branding-guidelines": document(header("Branding Guidelines"), [
      section("Brand analysis", str(ir["brandAnalysis"])),
      section("Brand synchronization update", str(ir["brandSynchronizationUpdate"])),
      section("Voice territory", str(ir["brandVoiceTerritory"])),
    ]),
    "target-audience": document(header("Target Audience"), [
      section("Summary", str(targetAudience["summary"])),
      personas.length ? joinBlocks(personas.map(personaBlock)) : undefined,
      section("Evidence", bullets(strArray(targetAudience["evidence"]))),
      section("Customer sentiment", customerSentimentList(objArray(ir["customerSentiment"]))),
      section("Buyer-intent prompt set", bullets(promptSetPrompts.map((p) => str(p["promptText"]) ?? str(p["prompt"]) ?? str(p["text"]) ?? "").filter(Boolean))),
    ]),
    "client-guidelines": document(header("Client Guidelines"), [
      overall,
      section("Dimension scores", dimensionScoreList(dimensionScores)),
      section("Standing recommendations", joinBlocks(recommendations.map(recommendationBlock))),
      section("Brand synchronization update", str(ir["brandSynchronizationUpdate"])),
    ]),
    "action-plan": document(header("Action Plan"), [
      section("From the intel report", joinBlocks(recommendations.map(recommendationBlock))),
      section("From the SEO/GEO audit", joinBlocks(fired.map(firedBlock))),
      section("Prepared fixes", labelledList(objArray(sg["fixDrafts"]), ["title", "target", "id"])),
    ]),
  };
}

export const INTEL_REPORT_DELIVERABLE_KIND = "intel-report";
export const SEO_GEO_DELIVERABLE_KIND = "seo-geo-report";

export interface AgentOnboardingDeps {
  getClient: (clientId: string) => Promise<Client | null>;
  dispatchResearchAgents: (
    client: Client,
    options: { runSpecificContext?: string },
  ) => Promise<{
    intelReport: { agentEngineRunId?: string; error?: string; skipped?: true; reason?: string };
    seoGeo: { agentEngineRunId?: string; error?: string; skipped?: true; reason?: string };
  }>;
  getDeliverable: (runId: string, kind: string) => Promise<unknown>;
  condense: (client: Client, docTypes: ContextDocType[], internal: Record<string, string>) => Promise<{ docType: ContextDocType; content: string }[]>;
  replaceDocs: (clientId: string, docs: StoredContextDoc[]) => Promise<void>;
  /**
   * Project the freshly written documents (and the client's brand + profile)
   * into the agent-engine workspace the engine's tools read from. Optional and
   * best-effort: absent in tests, a no-op when the workspace bucket is not
   * configured, never allowed to fail the run. See `context-doc-projection.ts`.
   */
  projectDocs?: (clientId: string, docs: StoredContextDoc[]) => Promise<void>;
  now: () => number;
  sleep: (ms: number) => Promise<void>;
}

export interface AgentOnboardingOptions {
  /** How long to wait for each agent-engine deliverable before failing the run. */
  deliverableTimeoutMs?: number;
  /** Gap between deliverable polls. */
  pollIntervalMs?: number;
  /**
   * Run-scoped instructions a person typed for THIS run, forwarded to both
   * agents as `customPrompt`. Absent for a scheduled or automatic run, which
   * nobody typed at.
   */
  runSpecificContext?: string;
}

/**
 * Agent-based onboarding: the post-cutover producer of the context documents.
 *
 * Both agent-engine runs must deliver. There is deliberately no degraded mode
 * that writes documents from one report, and none that writes them from
 * nothing: these documents are the ground truth every downstream agent reads,
 * and `runOnboardPipeline` already treated a majority research failure as fatal
 * rather than generating "hallucination-bait". Same rule, new producer.
 *
 * The write itself goes through `replaceClientContextDocs` unchanged — same
 * function, same `clientContextDocs` collection, same batch delete-then-set.
 * Nothing in this module knows the collection name, which is the point: it
 * cannot move the read path even by accident.
 */
export async function runAgentOnboarding(
  clientId: string,
  deps: AgentOnboardingDeps,
  options: AgentOnboardingOptions = {},
): Promise<{ docsWritten: number }> {
  const research = await dispatchAndAwaitResearch(clientId, deps, options);
  return writeContextDocsFromResearch(research, deps);
}

/** One client's two research deliverables, plus the client they describe. */
export interface AgentResearchDeliverables {
  client: Client;
  intelReport: unknown;
  seoGeo: unknown;
}

/**
 * The first half of the run: dispatch both agents, then wait for both
 * deliverables.
 *
 * Split out of `runAgentOnboarding` so `runIntelReportPipeline` can store the
 * Intel Report itself between the two halves. That ordering is not cosmetic —
 * it is the one Phase A used to provide for free. The report was stored the
 * moment it existed and the context-document pipeline ran after it, so a
 * context-doc failure left the client with a report; folding the report write
 * in after `writeContextDocsFromResearch` would quietly make it fatal to the
 * report too.
 *
 * The dispatch is also what makes the run visible: each call creates a real
 * `jobs` document before anything is awaited, which is why both jobs now appear
 * in the Jobs list within seconds of pressing Regenerate rather than after six
 * minutes of in-process generation.
 */
export async function dispatchAndAwaitResearch(
  clientId: string,
  deps: AgentOnboardingDeps,
  options: AgentOnboardingOptions = {},
): Promise<AgentResearchDeliverables> {
  const deliverableTimeoutMs = options.deliverableTimeoutMs ?? 15 * 60_000;
  const pollIntervalMs = options.pollIntervalMs ?? 15_000;

  const client = await deps.getClient(clientId);
  if (!client) throw new Error(`Client not found: ${clientId}`);

  const dispatched = await deps.dispatchResearchAgents(client, {
    ...(options.runSpecificContext ? { runSpecificContext: options.runSpecificContext } : {}),
  });
  const runIdFor = (name: "intelReport" | "seoGeo"): string => {
    const result = dispatched[name];
    if (result.agentEngineRunId) return result.agentEngineRunId;
    const why = result.skipped ? (result.reason ?? "skipped") : (result.error ?? "no run id returned");
    throw new Error(`Agent-based onboarding could not dispatch ${name}: ${why}`);
  };
  const intelRunId = runIdFor("intelReport");
  const seoGeoRunId = runIdFor("seoGeo");

  const [intelReport, seoGeo] = await Promise.all([
    awaitDeliverable(deps, intelRunId, INTEL_REPORT_DELIVERABLE_KIND, deliverableTimeoutMs, pollIntervalMs),
    awaitDeliverable(deps, seoGeoRunId, SEO_GEO_DELIVERABLE_KIND, deliverableTimeoutMs, pollIntervalMs),
  ]);

  return { client, intelReport, seoGeo };
}

/** The second half: compose the eight context documents and write them. */
export async function writeContextDocsFromResearch(
  research: AgentResearchDeliverables,
  deps: Pick<AgentOnboardingDeps, "condense" | "replaceDocs" | "projectDocs" | "now">,
): Promise<{ docsWritten: number }> {
  const { client, intelReport, seoGeo } = research;
  const clientId = client.id;

  const generated = composeContextDocsFromAgentReports({ client, intelReport: rec(intelReport), seoGeo: rec(seoGeo) });

  const internalContents: Record<string, string> = {};
  for (const docType of INTERNAL_CONTEXT_DOC_TYPES) internalContents[docType] = generated[docType];

  // Client tier: the same condensation pass the read path has always been
  // served from, over the new internal documents. Empty condensations are
  // dropped exactly as before, so a client never gets a nav row that opens onto
  // an empty panel.
  const condensed = (await deps.condense(client, [...INTERNAL_CONTEXT_DOC_TYPES], internalContents)).filter(
    (doc) => doc.content.trim().length > 0,
  );

  const now = deps.now();
  const docs: StoredContextDoc[] = [
    ...INTERNAL_CONTEXT_DOC_TYPES.map((docType) => ({
      clientId,
      docType,
      tier: "internal" as ContextDocTier,
      content: generated[docType],
      version: 1,
      createdAt: now,
      updatedAt: now,
    })),
    ...INTERNAL_ONLY_CONTEXT_DOC_TYPES.map((docType) => ({
      clientId,
      docType,
      tier: "internal-only" as ContextDocTier,
      content: generated[docType],
      version: 1,
      createdAt: now,
      updatedAt: now,
    })),
    ...condensed.map((doc) => ({
      clientId,
      docType: doc.docType,
      tier: "client" as ContextDocTier,
      content: doc.content,
      version: 1,
      createdAt: now,
      updatedAt: now,
    })),
  ];

  // The gate, before the write and not after it. A set that fails here has
  // never touched Firestore.
  assertContextDocSetShape(docs, clientId);

  await deps.replaceDocs(clientId, docs);
  if (deps.projectDocs) {
    // Best-effort by contract: the documents are already stored; what fails
    // here is only their copy in the engine workspace, and the engine has its
    // own mirror fallback for that.
    await deps.projectDocs(clientId, docs).catch((err: unknown) => {
      console.error(`[agent-onboarding] context-doc projection failed for ${clientId} (non-fatal):`, err);
    });
  }
  return { docsWritten: docs.length };
}

async function awaitDeliverable(
  deps: Pick<AgentOnboardingDeps, "getDeliverable" | "now" | "sleep">,
  runId: string,
  kind: string,
  timeoutMs: number,
  pollIntervalMs: number,
): Promise<unknown> {
  const deadline = deps.now() + timeoutMs;
  let lastTransient: unknown;
  for (;;) {
    let deliverable: unknown;
    try {
      deliverable = await deps.getDeliverable(runId, kind);
      lastTransient = undefined;
    } catch (e) {
      // A POLL FAILURE IS NOT A RUN FAILURE.
      //
      // This loop runs for up to 70 minutes at 15-second intervals — around
      // 280 requests to a Cloud Run service that scales to zero and is
      // redeployed during the day. Any single one of them failing used to
      // abort the whole pipeline, and on 2026-09-03 exactly that happened: a
      // deploy of agent-engine restarted the service mid-wait, one poll came
      // back `fetch failed`, and a run whose agents were both still working
      // was recorded against the client as `aiProcessingError: "fetch
      // failed"`. Over that many attempts a transient failure is not an edge
      // case, it is the expected weather.
      //
      // The deadline is still the only thing that ends this loop, so a
      // genuinely unreachable engine fails at the same moment it always did —
      // it just carries the reason with it now, instead of the timeout
      // message pretending the deliverable merely never arrived.
      // A credential failure is NOT transient — retrying it for 70 minutes
      // just delays a misconfiguration by 70 minutes. Matched by name rather
      // than `instanceof`: this module takes every runtime dependency through
      // injected `deps` precisely so the run stays drivable in a test with no
      // Firestore and no engine client, and importing the error class to
      // narrow one branch would give that up for nothing.
      if (e instanceof Error && e.name === "AgentEngineCredentialError") throw e;
      lastTransient = e;
    }
    if (deliverable !== undefined && deliverable !== null) return deliverable;
    if (deps.now() >= deadline) {
      const because =
        lastTransient !== undefined
          ? ` The last poll failed with: ${lastTransient instanceof Error ? lastTransient.message : String(lastTransient)}`
          : "";
      throw new Error(
        `Agent-based onboarding timed out waiting for the "${kind}" deliverable of agent-engine run ${runId} ` +
          `after ${Math.round(timeoutMs / 1000)}s. Refusing to write context documents without it.${because}`,
      );
    }
    await deps.sleep(pollIntervalMs);
  }
}

/**
 * The production wiring, as a value.
 *
 * Kept as a thin factory so the run above stays drivable in a test without a
 * Firestore, a Pub/Sub topic or a model call — the alternative is a function
 * nobody can prove anything about. Exported (not just consumed by
 * `runAgentOnboardingForClient` below) because `runIntelReportPipeline` drives
 * the two halves separately and needs the same deps for both, and building them
 * twice would mean two `dispatchResearchAgents` closures where there must be
 * exactly one dispatch.
 */
export async function agentOnboardingDeps(): Promise<AgentOnboardingDeps> {
  const [{ getClient, replaceClientContextDocs }, { dispatchOnboardingResearchAgents }, { getAgentEngineDeliverable }, { condenseDocs }, { RESEARCH_ENGINE_RULES, METRICS_RULES }] =
    await Promise.all([
      import("@/lib/data"),
      import("@/lib/agent-engine/dispatch-research-agents"),
      import("@/lib/agent-engine/client"),
      import("./condense"),
      import("./brain"),
    ]);

  const rules = [RESEARCH_ENGINE_RULES, "", METRICS_RULES].filter(Boolean).join("\n");

  return {
    getClient,
    dispatchResearchAgents: (client, dispatchOptions) => dispatchOnboardingResearchAgents(client, dispatchOptions),
    getDeliverable: (runId, kind) => getAgentEngineDeliverable(runId, kind),
    condense: (client, docTypes, internal) => condenseDocs(client, docTypes, internal, rules),
    replaceDocs: (id, docs) => replaceClientContextDocs(id, docs),
    projectDocs: async (id) => {
      // Read the stored rows back rather than projecting the in-memory ones:
      // the projection wants Firestore ids and versions for provenance, and
      // `replaceClientContextDocs` has just assigned them.
      const [{ projectClientToWorkspace }, { listClientContextDocs }, freshClient] = await Promise.all([
        import("@/lib/agent-engine/context-doc-projection"),
        import("@/lib/data"),
        getClient(id),
      ]);
      if (!freshClient) return;
      await projectClientToWorkspace(freshClient, await listClientContextDocs(id));
    },
    now: () => Date.now(),
    sleep: (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
  };
}

export async function runAgentOnboardingForClient(
  clientId: string,
  options: AgentOnboardingOptions = {},
): Promise<{ docsWritten: number }> {
  return runAgentOnboarding(clientId, await agentOnboardingDeps(), options);
}
