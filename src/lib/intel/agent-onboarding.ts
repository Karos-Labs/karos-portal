import "server-only";

import type {
  BrandingGuidelines,
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
 *      ASSERT → write, through `replaceClientContextDocs`, which replaces the
 *      contract's rows and no others.
 *   5. writeLabContextDocsFromResearch — the same second half for a LAB client
 *      (`isLabProfileClient`), whose internal documents are curated in the
 *      karos-agents lab and must survive the run. It writes the generated
 *      `action-plan` row and the client-tier condensations of the lab's own
 *      documents, row by row, and never deletes or replaces anything else. The
 *      constraint holds per row there: each row it writes is a (docType, tier)
 *      of the contract below with exactly the stored field set, gated by
 *      `assertLabContextDocWriteShape` before the first write.
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

/**
 * The (docType, tier) rows onboarding may write and, since 2026-09-11, the only
 * rows its replace deletes — `agentOnboardingDeps` passes this as the scope. A
 * pair added here is wiped and rewritten on every run; a row at any pair left
 * out (the agent profiles, meeting notes) is never touched.
 */
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
  const violations = contextDocViolations(docs, clientId, CONTEXT_DOC_SET_CONTRACT, outsideStoredSet);
  if (violations.length) throw new ContextDocShapeError(violations);
}

const contractKey = (row: { docType: string; tier: string }) => `${row.docType}::${row.tier}`;

const STORED_SET_KEYS: ReadonlySet<string> = new Set(CONTEXT_DOC_SET_CONTRACT.map(contractKey));

function outsideStoredSet(key: string): string {
  return `row ${key} is not part of the stored context-document set — the read path does not serve it`;
}

/**
 * THE LAB-MODE WRITE SET: every (docType, tier) row a lab client's run may
 * write, and nothing else.
 *
 * The generated `action-plan` (internal-only) is required — it is the one
 * document that exists only because the research ran. The client-tier
 * condensations are optional, exactly as they are in the full set: an empty one
 * is dropped and the row the client already has stays. Every internal row is
 * absent on purpose — the lab wrote those — and so is `client-guidelines` at
 * any tier: the lab's is curated, and the composed one would replace it with
 * the report's standing recommendations.
 *
 * A strict subset of CONTEXT_DOC_SET_CONTRACT, so a lab run can only ever write
 * rows the read path already serves.
 */
export const LAB_CONTEXT_DOC_WRITE_CONTRACT: readonly ContextDocRowContract[] = [
  { docType: "action-plan", tier: "internal-only", required: true },
  ...INTERNAL_CONTEXT_DOC_TYPES.map(
    (docType): ContextDocRowContract => ({ docType, tier: "client", required: false }),
  ),
];

/**
 * The gate for a lab client's run, called before the first write. The row
 * rules are `assertContextDocSetShape`'s, word for word; what differs is which
 * rows may appear, and that the set needs no internal row because it writes
 * none.
 */
export function assertLabContextDocWriteShape(
  docs: readonly StoredContextDoc[],
  clientId: string,
): void {
  const violations = contextDocViolations(docs, clientId, LAB_CONTEXT_DOC_WRITE_CONTRACT, (key) =>
    STORED_SET_KEYS.has(key)
      ? `row ${key} belongs to the lab — a lab client's run writes only the action plan and the client-tier condensations`
      : outsideStoredSet(key),
  );
  if (violations.length) throw new ContextDocShapeError(violations);
}

/**
 * Every way `docs` misses `contract`. Shared by both gates so the row rules
 * cannot drift apart: `outsideContract` words the one violation whose meaning
 * depends on which set is being checked.
 */
function contextDocViolations(
  docs: readonly StoredContextDoc[],
  clientId: string,
  contract: readonly ContextDocRowContract[],
  outsideContract: (key: string) => string,
): string[] {
  const violations: string[] = [];

  const contractKeys = new Set(contract.map(contractKey));
  const seen = new Set<string>();
  const allowedFields = new Set<string>(STORED_CONTEXT_DOC_FIELDS);

  for (const doc of docs) {
    const key = contractKey(doc);

    if (!contractKeys.has(key)) violations.push(outsideContract(key));
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

  for (const row of contract) {
    if (!row.required) continue;
    if (!seen.has(contractKey(row))) {
      violations.push(`required row ${row.docType}::${row.tier} is missing`);
    }
  }

  return violations;
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

/**
 * A `###` heading inside a section. The structured blocks
 * (`brandVoiceSpec`, `productInformation`) render several labelled lists under
 * one `##`, and using `##` for those too would put "Never say this" at the
 * same level as "How this brand sounds" in the portal's document outline.
 */
function subsection(heading: string, body: string | undefined): string | undefined {
  return body ? `### ${heading}\n\n${body}` : undefined;
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
 * The client's own branding-guidelines markdown, pushed one heading level
 * down so its `## Brand Voice` / `## Do's` / `## Don'ts` sit UNDER the
 * section that introduces them instead of competing with the document's own
 * `##` sections. Nothing else about the text is touched — it is the client's
 * copy, not ours to rewrite.
 */
function demoteHeadings(markdown: string | undefined): string | undefined {
  const text = str(markdown);
  return text ? text.replace(/^(#{1,5}) /gm, "$1# ") : undefined;
}

/**
 * The brand's palette as the brand kit stores it: `dominantColors` first (the
 * ranked field every new write populates), falling back to the four legacy
 * scalars for a client whose kit predates it. Each line carries the role the
 * kit recorded, because "#ff6b2c" alone does not tell a design agent whether
 * it may fill a background with it.
 */
function paletteList(bg: BrandingGuidelines | undefined): string | undefined {
  if (!bg) return undefined;
  const ranked = (bg.dominantColors ?? [])
    .map((c) => {
      const hex = str(c?.hex);
      if (!hex) return undefined;
      const role = str(c?.role);
      return role ? `- ${hex} — ${role}` : `- ${hex}`;
    })
    .filter((l): l is string => Boolean(l));
  if (ranked.length) return ranked.join("\n");
  const legacy = (
    [
      ["Primary accent", bg.primaryAccent ?? bg.primaryColor],
      ["Secondary accent", bg.secondaryAccent ?? bg.secondaryColor],
      ["Neutral dark", bg.brandNeutralDark ?? bg.uiBackground],
      ["Neutral light", bg.brandNeutralLight ?? bg.uiText],
    ] as const
  )
    .map(([label, hex]) => (str(hex) ? `- ${label}: ${str(hex)}` : undefined))
    .filter((l): l is string => Boolean(l));
  return legacy.length ? legacy.join("\n") : undefined;
}

/** Heading font and body font, on one line each, when the kit names them. */
function typographyList(bg: BrandingGuidelines | undefined): string | undefined {
  const lines = (
    [
      ["Headings", bg?.fontHeading],
      ["Body", bg?.fontBody],
    ] as const
  )
    .map(([label, font]) => (str(font) ? `- ${label}: ${str(font)}` : undefined))
    .filter((l): l is string => Boolean(l));
  return lines.length ? lines.join("\n") : undefined;
}

/**
 * The phrases the audience's own personas say to avoid, deduplicated across
 * personas. This is the one piece of the ICP blueprint that is an instruction
 * to the writer rather than a description of the reader, which is why
 * `client-guidelines` — the internal-only "how we write for this client" row —
 * carries it rather than `target-audience`.
 */
function avoidPhraseList(personas: readonly Record<string, unknown>[]): string | undefined {
  const seen = new Set<string>();
  for (const p of personas) for (const phrase of strArray(p["avoidPhrases"])) seen.add(phrase);
  return seen.size ? [...seen].map((p) => `- ${p}`).join("\n") : undefined;
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
/**
 * `brandVoiceSpec` (intel-report-craft@7) rendered as the rules a writer
 * follows. Each sub-list is dropped when the report had nothing for it, so a
 * thin spec produces a short document rather than a scaffold of empty
 * headings.
 */
function voiceSpecBlock(spec: Record<string, unknown>): string | undefined {
  const dimensions = objArray(spec["dimensions"])
    .map((d) => {
      const scale = str(d["scale"]);
      const position = str(d["position"]);
      if (!scale || !position) return undefined;
      const shifts = str(d["shiftsWhen"]);
      return `- **${scale}:** ${position}${shifts ? ` — shifts when ${shifts}` : ""}`;
    })
    .filter((l): l is string => Boolean(l));
  const platforms = objArray(spec["platformVoice"])
    .map((row) => {
      const platform = str(row["platform"]);
      const guidance = str(row["guidance"]);
      return platform && guidance ? `- **${platform}:** ${guidance}` : undefined;
    })
    .filter((l): l is string => Boolean(l));
  const ctas = objArray(spec["ctaTaxonomy"])
    .map((row) => {
      const situation = str(row["situation"]);
      const cta = str(row["cta"]);
      return situation && cta ? `- ${situation} → ${cta}` : undefined;
    })
    .filter((l): l is string => Boolean(l));

  return joinBlocks([
    str(spec["voiceInOneLine"]),
    subsection("Voice adjectives", bullets(strArray(spec["adjectives"]))),
    subsection("Where the voice sits", dimensions.length ? dimensions.join("\n") : undefined),
    subsection("Sentence mechanics", bullets(strArray(spec["sentenceMechanics"]))),
    subsection("Say this", bullets(strArray(spec["preferredTerms"]))),
    subsection("Never say this", bullets(strArray(spec["bannedTerms"]))),
    subsection("By platform", platforms.length ? platforms.join("\n") : undefined),
    subsection("Which CTA, when", ctas.length ? ctas.join("\n") : undefined),
    subsection("On-voice lines", bullets(strArray(spec["samplePhrases"]))),
  ]);
}

/**
 * `messaging` (intel-report-craft@8) — what to say and in what order. The
 * hierarchy renders LAST of the prose fields and first in importance: a list
 * of pillars in no order is a list an agent picks from at random.
 */
function messagingBlock(m: Record<string, unknown>): string | undefined {
  const props = objArray(m["valuePropositions"])
    .map((v) => {
      const audience = str(v["audience"]);
      const promise = str(v["promise"]);
      if (!audience || !promise) return undefined;
      const proof = str(v["proof"]);
      return `- **${audience}:** ${promise}${proof ? ` _(${proof})_` : ""}`;
    })
    .filter((l): l is string => Boolean(l));
  const pillars = objArray(m["messagingPillars"])
    .map((row) => {
      const pillar = str(row["pillar"]);
      const meaning = str(row["whatItMeans"]);
      if (!pillar) return undefined;
      const proof = strArray(row["proofPoints"]);
      const when = str(row["whenToLead"]);
      return joinBlocks([
        `**${pillar}**${meaning ? ` — ${meaning}` : ""}`,
        proof.length ? proof.map((p) => `- ${p}`).join("\n") : undefined,
        when ? `_Lead with this when:_ ${when}` : undefined,
      ]);
    })
    .filter((b): b is string => Boolean(b));
  const channels = objArray(m["channelPriorities"])
    .map((row) => {
      const channel = str(row["channel"]);
      const role = str(row["role"]);
      if (!channel || !role) return undefined;
      const cadence = str(row["cadence"]);
      return `- **${channel}:** ${role}${cadence ? ` — ${cadence}` : ""}`;
    })
    .filter((l): l is string => Boolean(l));

  return joinBlocks([
    str(m["positioningStatement"]),
    subsection("Value propositions", props.length ? props.join("\n") : undefined),
    subsection("Messaging pillars", pillars.length ? joinBlocks(pillars) : undefined),
    subsection("What leads, what supports", str(m["messageHierarchy"])),
    subsection("Each channel's job", channels.length ? channels.join("\n") : undefined),
  ]);
}

/**
 * `visualDirection` (intel-report-craft@8) — the rules a renderer needs and a
 * palette cannot give it.
 */
function visualDirectionBlock(v: Record<string, unknown>): string | undefined {
  const imagery = rec(v["imagery"]);
  return joinBlocks([
    subsection("Logo usage", bullets(strArray(v["logoUsage"]))),
    subsection(
      "Imagery",
      joinBlocks([
        str(imagery["direction"]),
        strArray(imagery["subjects"]).length ? `**In the picture:** ${strArray(imagery["subjects"]).join("; ")}` : undefined,
        strArray(imagery["avoid"]).length ? `**Never:** ${strArray(imagery["avoid"]).join("; ")}` : undefined,
      ]),
    ),
    subsection("Iconography", str(v["iconography"])),
    subsection("Layout & composition", str(v["layout"])),
    subsection("Motion", str(v["motion"])),
  ]);
}

/** What is observably true on each surface the category competes on. */
function platformRealityList(rows: readonly Record<string, unknown>[]): string | undefined {
  const lines = rows
    .map((row) => {
      const platform = str(row["platform"]);
      const observation = str(row["observation"]);
      if (!platform || !observation) return undefined;
      const implication = str(row["implication"]);
      return `- **${platform}:** ${observation}${implication ? ` → ${implication}` : ""}`;
    })
    .filter((l): l is string => Boolean(l));
  return lines.length ? lines.join("\n") : undefined;
}

/** Companies not competing today, and the signal that would change that. */
function watchList(rows: readonly Record<string, unknown>[]): string | undefined {
  const lines = rows
    .map((row) => {
      const company = str(row["company"]);
      const why = str(row["why"]);
      if (!company || !why) return undefined;
      const signal = str(row["signal"]);
      return `- **${company}:** ${why}${signal ? ` _Watch for:_ ${signal}` : ""}`;
    })
    .filter((l): l is string => Boolean(l));
  return lines.length ? lines.join("\n") : undefined;
}

/** One offering, as the site names it. */
function offeringBlock(o: Record<string, unknown>): string | undefined {
  const name = str(o["name"]);
  const whatItIs = str(o["whatItIs"]);
  if (!name) return undefined;
  const who = str(o["whoItIsFor"]);
  return `- **${name}**${whatItIs ? ` — ${whatItIs}` : ""}${who ? ` _(for ${who})_` : ""}`;
}

/** Questions buyers ask, answered from the client's own material. */
function faqBlock(rows: readonly Record<string, unknown>[]): string | undefined {
  const entries = rows
    .map((row) => {
      const q = str(row["question"]);
      const a = str(row["answer"]);
      return q && a ? `**${q}**\n${a}` : undefined;
    })
    .filter((e): e is string => Boolean(e));
  return entries.length ? entries.join("\n\n") : undefined;
}

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

/**
 * The same recommendation as one line — title, priority, tag, no description.
 *
 * `market-strategy` and `action-plan` were both rendering the FULL block, and
 * on the real Karos Labs report that was nine long paragraphs printed twice:
 * more duplicated text than either document had of its own, and the single
 * biggest reason the eight documents read as one report reshuffled. The
 * action plan is the document that exists FOR these, so it keeps them whole;
 * the strategy document states what the strategy implies and points at them.
 */
function recommendationHeadline(r: Record<string, unknown>): string | undefined {
  const title = str(r["title"]) ?? str(r["recommendation"]) ?? str(r["id"]);
  if (!title) return undefined;
  const priority = str(r["priorityLabel"]) ?? (typeof r["priority"] === "number" ? `P${r["priority"]}` : undefined);
  const tag = str(r["tag"]);
  return `- ${title}${priority || tag ? ` — ${[priority, tag].filter(Boolean).join(" · ")}` : ""}`;
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
  /**
   * `brandVoice` and `brandingGuidelines` are read here, not just `name`.
   * They are the client's OWN statement of how it sounds and looks - written
   * by the branding step, editable by hand in the portal - and they are what
   * a writing agent actually needs. The intel report cannot supply them and
   * must not: its brand fields are a COMPETITIVE read (see the `brand-voice`
   * entry below), and for three prompt versions those fields were the entire
   * `brand-voice` document while the client's own voice spec sat unread on
   * the client record.
   */
  client: Pick<Client, "id" | "name" | "brandVoice" | "brandingGuidelines">;
  intelReport: IntelReportDeliverable;
  seoGeo: SeoGeoReportDeliverable;
}): Record<OnboardingDocType, string> {
  const { client, intelReport: ir, seoGeo: sg } = input;
  const bg = client.brandingGuidelines;
  const swot = rec(ir["swot"]);
  const visibilityIndex = rec(rec(sg["visibility"])["byN"])["index"];
  const header = (title: string) => `# ${title} — ${client.name}`;
  // A score with its coverage and measured-basis figure when the engine
  // reported them (2026-09-07+): "SEO 62 (90% of checks measured; 69 on the
  // checks that ran)". The bare score counts an unmeasured check as zero, so
  // on its own it understates a site that passed everything the audit saw.
  const scoreWithBasis = (label: string, breakdown: Record<string, unknown>): string | undefined => {
    const score = breakdown["score"];
    if (typeof score !== "number") return undefined;
    const coverage = breakdown["dataCoveragePct"];
    const basis = breakdown["measuredBasisScore"];
    const detail = [
      typeof coverage === "number" ? `${Math.round(coverage)}% of checks measured` : undefined,
      typeof basis === "number" ? `${basis} on the checks that ran` : undefined,
    ].filter((p): p is string => Boolean(p));
    return `${label} ${score}${detail.length ? ` (${detail.join("; ")})` : ""}`;
  };
  const scoreLine = [
    scoreWithBasis("SEO", rec(sg["seoScore"])),
    scoreWithBasis("GEO readiness", rec(sg["geoReadiness"])),
    typeof visibilityIndex === "number" ? `AI visibility index ${visibilityIndex}` : undefined,
  ]
    .filter((p): p is string => Boolean(p))
    .join(" · ");
  const measuredFacts = strArray(sg["measuredFacts"]);
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
  // intel-report-craft@7. Both optional on the report, both the reason their
  // documents existed at all.
  const voiceSpec = rec(ir["brandVoiceSpec"]);
  const productInfo = rec(ir["productInformation"]);
  // intel-report-craft@8.
  const messaging = rec(ir["messaging"]);
  const visualDirection = rec(ir["visualDirection"]);
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

  /**
   * The `brand-voice` document's real sections, named here so the fallback
   * below can ask whether any of them survived. Order is the order a writer
   * needs them: the spec first, the rules that qualify it second, then where
   * the voice sits in the market.
   */
  const voiceSections = [
    section("How this brand sounds", str(client.brandVoice)),
    // The researched spec (intel-report-craft@7): the rules a writer applies
    // to a sentence. It sits UNDER the client's own statement rather than
    // replacing it — the client record is hand-editable and an edit there must
    // survive a research run, while this block carries what the record has no
    // room for: dimensions, mechanics, per-platform voice, CTA taxonomy.
    section("Voice spec", voiceSpecBlock(voiceSpec)),
    section("Voice rules", demoteHeadings(bg?.guidelines)),
    section("Tone keywords", bullets(bg?.toneKeywords ?? [])),
    // The agent's contribution to this document: where the voice SITS in the
    // market. That is a statement about the client, unlike the two
    // per-company comparison tables, so it stays.
    section("Voice territory", str(ir["brandVoiceTerritory"])),
  ];

  return {
    /**
     * WHAT THIS DOCUMENT IS FOR: every publishing agent reads it to sound
     * like this brand. So it leads with the brand's own voice spec and its
     * do/don't rules, and the competitive material is not here at all.
     *
     * Until this revision it was composed from `brandAnalysis`,
     * `brandVoiceArchetypes` and `brandVoiceRows` - three fields the intel
     * prompt defines as a COMPARISON across companies (`intel-report-craft`
     * section 7: "comparing against at least one named competitor"; the
     * schemas are literally `{ company, archetype }` and `{ dimension,
     * scores: one per company }`). The result was a "Brand Voice" document
     * whose Archetypes section listed four competitors and whose Voice
     * attributes section was a five-way table, with no rule a writer could
     * follow - while `client.brandVoice`, a precise spec of sentence unit,
     * banned words, person, tense and CTA, was never read. Those two
     * comparison sections now live in `competitor-analysis`, where a
     * per-company table belongs.
     */
    "brand-voice": document(header("Brand Voice"), [
      ...voiceSections,
      /**
       * Every source above is optional — a client can reach onboarding before
       * the branding step has run, and `brandVoiceTerritory` is optional in
       * the intel schema. The old composition could not be empty because it
       * led with the always-required `brandAnalysis`, so dropping that field
       * from here would otherwise let a brand-less client fail the shape gate
       * and take the whole onboarding down with it.
       *
       * The fallback is `brandAnalysis` rather than fixed text on purpose:
       * it still comes from the deliverable, so a run where the engine
       * genuinely answered with nothing still composes empty and the gate
       * still fires. That is the one failure this document's emptiness
       * exists to catch.
       */
      voiceSections.some(Boolean) ? undefined : section("Brand analysis", str(ir["brandAnalysis"])),
    ]),
    "market-strategy": document(header("Market Strategy"), [
      scoreHeader,
      // The message architecture leads: it is the prescriptive part, and an
      // agent that reads only the top of this document should come away with
      // what to say rather than with how the market looks.
      section("What we say", messagingBlock(messaging)),
      section("Dimension scores", dimensionScoreList(dimensionScores)),
      section("Positioning", str(ir["positioningAnalysis"])),
      section("Growth", str(ir["growthAnalysis"])),
      section("Whitespace opportunities", bullets(strArray(ir["whitespaceOpportunities"]))),
      section("SEO & discoverability", str(ir["seoAnalysis"])),
      section("GEO & AI discoverability", str(ir["geoAnalysis"])),
      section("Search and answer-engine visibility", str(sg["narrative"])),
      // What the engine actually observed on the site - the facts behind the
      // scores, so an agent reading this document can say "8 of 8 audited
      // pages carry structured data" instead of only "SEO 62".
      section("Measured site facts", bullets(measuredFacts)),
      // The buyer-intent prompt set: the queries this brand is scored on in
      // AI answers. It used to be appended to `target-audience`, where it was
      // the only SEO/GEO material in an ICP document and read as filler. It
      // belongs beside the visibility narrative it is measured against.
      section(
        "Buyer-intent prompt set",
        bullets(promptSetPrompts.map((p) => str(p["promptText"]) ?? str(p["prompt"]) ?? str(p["text"]) ?? "").filter(Boolean)),
      ),
      // Headlines only — the action plan carries them in full. See
      // `recommendationHeadline`.
      section(
        "What this implies, in priority order",
        recommendations.length
          ? joinBlocks([
              bullets(recommendations.map(recommendationHeadline).filter((l): l is string => Boolean(l)).map((l) => l.replace(/^- /, ""))),
              "_Each one is written out in full, with what it targets, in the Action Plan._",
            ])
          : undefined,
      ),
    ]),
    "competitor-analysis": document(header("Competitor Analysis"), [
      competitors.length ? `**Competitors analysed: ${competitors.length}**` : undefined,
      section("Competitive ranking", rankingList),
      section("Competitor profiles", joinBlocks(competitors.map(competitorProfile))),
      // Moved here from `brand-voice`: both fields are per-company rows, so
      // this is the document whose shape they fit.
      section("Brand-voice archetypes", brandVoiceArchetypeList(objArray(ir["brandVoiceArchetypes"]))),
      section("Brand-voice comparison", brandVoiceAttributeList(objArray(ir["brandVoiceRows"]))),
      // Per-company review-platform ratings - also a competitor table, and
      // also previously filed under `target-audience`.
      section("Customer sentiment", customerSentimentList(objArray(ir["customerSentiment"]))),
      section("Per-platform reality", platformRealityList(objArray(ir["perPlatformReality"]))),
      section("Watch list", watchList(objArray(ir["watchList"]))),
      section("SWOT", swotBlock),
      section("Share of voice in AI answers", labelledList(objArray(rec(sg["visibility"])["engines"]), ["engine", "label", "name"], "mentions")),
    ]),
    /**
     * What the client SELLS, which is what an agent opening this document is
     * looking for. Until `productInformation` existed (intel-report-craft@7)
     * this was three assessments of the client's marketing, from which no
     * agent could learn what the product does, what it is called, what it
     * costs, or which claims it may not make.
     *
     * The three analyses stay, below the product itself: they are a real read
     * of how the offer is currently presented, and they are what this document
     * falls back to when the report has no product block.
     */
    "product-information": document(header("Product Information"), [
      section("What this is", str(productInfo["whatItDoes"])),
      section("Offerings", joinBlocks(objArray(productInfo["offerings"]).map(offeringBlock))),
      section("How they charge", str(productInfo["businessModel"])),
      section("What the site asks for", bullets(strArray(productInfo["primaryCtas"]))),
      section("Proof points", bullets(strArray(productInfo["proofPoints"]))),
      // Above the analyses on purpose: an agent that reads only the top of
      // this document must still see what it is not allowed to claim.
      section("Do not misstate", bullets(strArray(productInfo["doNotMisstate"]))),
      section("Questions buyers ask", faqBlock(objArray(productInfo["faq"]))),
      section("Technical signals", bullets(strArray(productInfo["techSignals"]))),
      // `positioningAnalysis` used to render here too, verbatim from
      // `market-strategy`. It is a market read, not a product fact, and with
      // `messaging.positioningStatement` now leading the strategy document
      // there is nothing this document loses by pointing rather than copying.
      section("Content analysis", str(ir["contentAnalysis"])),
      section("Conversion analysis", str(ir["conversionAnalysis"])),
    ]),
    /**
     * The brand KIT - palette, type, visual style - which is what an agent
     * opening "Branding Guidelines" is looking for, and which the client
     * record has always held. This document previously contained three
     * sections, all three byte-for-byte copies of `brand-voice`'s, and not
     * one colour or font.
     */
    "branding-guidelines": document(header("Branding Guidelines"), [
      section("Palette", paletteList(bg)),
      section("Typography", typographyList(bg)),
      section("Visual style", str(bg?.visualStyle)),
      // The researched rules a renderer needs: logo usage, imagery direction,
      // iconography, layout, motion. The palette above says what colour; this
      // says what the picture is of.
      section("Art direction", visualDirectionBlock(visualDirection)),
      // The agent's read of how consistently that kit is actually applied,
      // and what the competitive findings imply for it. Both are about the
      // brand's identity rather than its copy, so this is their one home.
      section("Brand analysis", str(ir["brandAnalysis"])),
      section("Recommended updates", str(ir["brandSynchronizationUpdate"])),
    ]),
    "target-audience": document(header("Target Audience"), [
      section("Summary", str(targetAudience["summary"])),
      personas.length ? joinBlocks(personas.map(personaBlock)) : undefined,
      // The one part of the blueprint addressed to the WRITER rather than
      // describing the reader (lab profile section 8), so it sits above the
      // evidence rather than buried under it.
      section("How to appeal to them", bullets(strArray(targetAudience["rulesForContentAgents"]))),
      section("Evidence", bullets(strArray(targetAudience["evidence"]))),
      /**
       * `targetAudience` is optional in the intel schema — the prompt tells
       * the model to omit it rather than invent an audience the evidence does
       * not reach — so this document has to survive its absence. It used to,
       * by carrying the SEO/GEO prompt set and the per-company sentiment
       * table unconditionally, which is why an ICP document could look full
       * while containing no ICP at all.
       *
       * The prompt set comes back here only when there is no persona, and
       * under a heading that says what it actually is. A question a buyer
       * types is real audience evidence; it is not a persona, and the
       * document should not imply otherwise.
       */
      personas.length || str(targetAudience["summary"])
        ? undefined
        : section(
            "What buyers are asking (no persona in this report)",
            bullets(promptSetPrompts.map((p) => str(p["promptText"]) ?? str(p["prompt"]) ?? str(p["text"]) ?? "").filter(Boolean)),
          ),
    ]),
    /**
     * Internal-only: how we write FOR this client, as opposed to what we know
     * about them. Previously it repeated `market-strategy`'s entire
     * recommendation list and `brand-voice`'s synchronization update, and had
     * nothing of its own.
     */
    "client-guidelines": document(header("Client Guidelines"), [
      overall,
      section("Dimension scores", dimensionScoreList(dimensionScores)),
      section("Never write", avoidPhraseList(personas)),
      // Repeated from `product-information` deliberately, and the only
      // repetition in the set: this is the list whose cost of being missed is
      // a claim the client has to retract, and `client-guidelines` is the row
      // staff read before briefing a run.
      section("Claims we must not make", bullets(strArray(productInfo["doNotMisstate"]))),
      section("Known weaknesses to work around", bullets(strArray(swot["weaknesses"]))),
    ]),
    "action-plan": document(header("Action Plan"), [
      section("From the intel report", joinBlocks(recommendations.map(recommendationBlock))),
      section("From the SEO/GEO audit", joinBlocks(fired.map(firedBlock))),
      section("Measured site facts", bullets(measuredFacts)),
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
    intelReport: { jobId?: string; agentEngineRunId?: string; error?: string; skipped?: true; reason?: string };
    seoGeo: { jobId?: string; agentEngineRunId?: string; error?: string; skipped?: true; reason?: string };
  }>;
  getDeliverable: (runId: string, kind: string) => Promise<unknown>;
  condense: (client: Client, docTypes: ContextDocType[], internal: Record<string, string>) => Promise<{ docType: ContextDocType; content: string }[]>;
  replaceDocs: (clientId: string, docs: StoredContextDoc[]) => Promise<void>;
  /**
   * Every stored row of one client, any tier (production: `listClientContextDocs`).
   * A lab client's run reads the lab's own documents from here; the full
   * replace never needs it.
   */
  listDocs: (clientId: string) => Promise<ClientContextDoc[]>;
  /**
   * Create or overwrite ONE row keyed on (clientId, docType, tier) — a lab
   * client's only write (production: `upsertClientContextDoc`, the wrapper
   * `refreshClientContextDocsAction` writes the client tier through).
   */
  upsertDoc: (doc: StoredContextDoc) => Promise<void>;
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
 * The write itself goes through `replaceClientContextDocs` — same function,
 * same `clientContextDocs` collection, same one-batch delete-then-set — and the
 * delete is scoped to CONTEXT_DOC_SET_CONTRACT's rows. A row at any other
 * (docType, tier) belongs to another writer (the agent profiles, meeting notes)
 * and comes through the run untouched.
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
  /**
   * The `jobs` documents the two dispatches created, when the dispatch said.
   * `runIntelReportPipeline` materializes the SEO/GEO job through this id so the
   * capture lands when the run does.
   */
  jobIds?: { intelReport?: string; seoGeo?: string };
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

  return {
    client,
    intelReport,
    seoGeo,
    jobIds: {
      ...(dispatched.intelReport.jobId ? { intelReport: dispatched.intelReport.jobId } : {}),
      ...(dispatched.seoGeo.jobId ? { seoGeo: dispatched.seoGeo.jobId } : {}),
    },
  };
}

/** The second half: compose the eight context documents and write them. */
export async function writeContextDocsFromResearch(
  research: AgentResearchDeliverables,
  deps: Pick<AgentOnboardingDeps, "condense" | "replaceDocs" | "projectDocs" | "listDocs" | "now">,
): Promise<{ docsWritten: number }> {
  const { client, intelReport, seoGeo } = research;
  const clientId = client.id;

  const composed = composeContextDocsFromAgentReports({ client, intelReport: rec(intelReport), seoGeo: rec(seoGeo) });

  /**
   * CARRY-FORWARD. A document the research could not fill keeps the content
   * the client already has, instead of replacing a real document with nothing.
   *
   * This path is a REPLACE: `replaceClientContextDocs` deletes the contract's
   * rows and writes the new set in one batch. So a step that failed, returned
   * an empty field, or a deliverable that never arrived used to have exactly
   * two possible endings — a blank row stored as the client's ground truth, or
   * (since the gate) a `ContextDocShapeError` that failed the whole run and
   * left nothing refreshed. Neither is acceptable for a document eight agents
   * read on every run.
   *
   * The rule is narrow on purpose: substitution happens ONLY when the composed
   * document is blank. A composed document that has content always wins, so a
   * successful run still replaces its predecessor completely and a stale
   * document can never outlive research that actually spoke.
   *
   * When there is no prior row either — a brand-new client whose research
   * returned nothing — the document stays empty and the gate still fails the
   * run. That case has nothing to preserve, and failing loudly is right.
   */
  const previous = new Map((await deps.listDocs(clientId)).map((d) => [`${d.docType}::${d.tier}`, d.content] as const));
  const preserved: string[] = [];
  const contentFor = (docType: OnboardingDocType, tier: ContextDocTier): string => {
    if (composed[docType].trim()) return composed[docType];
    const carried = previous.get(`${docType}::${tier}`)?.trim();
    if (!carried) return composed[docType];
    preserved.push(`${docType}::${tier}`);
    return carried;
  };

  const generated: Record<OnboardingDocType, string> = { ...composed };
  for (const docType of INTERNAL_CONTEXT_DOC_TYPES) generated[docType] = contentFor(docType, "internal");
  for (const docType of INTERNAL_ONLY_CONTEXT_DOC_TYPES) generated[docType] = contentFor(docType, "internal-only");
  if (preserved.length) {
    // Loud, because the alternative reading of a quiet run is that the
    // research refreshed every document, and here it did not.
    console.warn(
      `[agent-onboarding] ${client.name}: the research produced no content for ${preserved.join(", ")} — kept the stored document(s) rather than replacing them with nothing`,
    );
  }

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

/**
 * The second half for a LAB client (`isLabProfileClient`): the lab curated this
 * client's internal documents, so the research may add to them and may not
 * replace them.
 *
 * Exactly two kinds of row are written, each through `upsertDoc` keyed on
 * (clientId, docType, tier):
 *
 *   - the generated `action-plan`, tier internal-only. It is the one document
 *     that exists only because the research ran; the lab has none.
 *   - the client-tier condensations, refreshed from the lab's EXISTING internal
 *     documents — the pass `refreshClientContextDocsAction` runs
 *     (`refreshClientCondensedDocs` is `condenseDocs` over these same six types,
 *     with the same rules), versions bumped and createdAt kept. One difference,
 *     on purpose: a condensation that came back empty is dropped, as the full
 *     run drops it, and the client keeps the copy it already had.
 *
 * Nothing else is touched. The internal documents and `client-guidelines` at
 * whatever tier the lab import put it: no row is deleted and none is
 * rewritten. Meeting notes and agent profiles are no longer a point of
 * difference from the full path either — `writeContextDocsFromResearch`'s
 * delete-then-set is scoped to the onboarding contract now, so it leaves those
 * rows alone too.
 */
export async function writeLabContextDocsFromResearch(
  research: AgentResearchDeliverables,
  deps: Pick<AgentOnboardingDeps, "condense" | "listDocs" | "upsertDoc" | "projectDocs" | "now">,
): Promise<{ docsWritten: number }> {
  const { client, intelReport, seoGeo } = research;
  const clientId = client.id;

  const generated = composeContextDocsFromAgentReports({ client, intelReport: rec(intelReport), seoGeo: rec(seoGeo) });

  const existing = await deps.listDocs(clientId);
  const stored = (docType: string, tier: ContextDocTier) =>
    existing.find((doc) => doc.docType === docType && doc.tier === tier);

  // The condensation reads the lab's documents as they stand, never the
  // research's composition of them.
  const internalContents: Record<string, string> = {};
  for (const docType of INTERNAL_CONTEXT_DOC_TYPES) {
    const doc = stored(docType, "internal");
    if (doc) internalContents[docType] = doc.content;
  }
  const missing = INTERNAL_CONTEXT_DOC_TYPES.filter((docType) => !internalContents[docType]?.trim());
  if (missing.length) {
    // Not generated in their place: the lab owns them. Re-importing is the fix.
    console.warn(`[agent-onboarding] lab client ${clientId} has no internal ${missing.join(", ")}; no client-tier copy refreshed for them`);
  }
  const condensed = (await deps.condense(client, [...INTERNAL_CONTEXT_DOC_TYPES], internalContents)).filter(
    (doc) => doc.content.trim().length > 0,
  );

  const now = deps.now();
  const row = (docType: ContextDocType, tier: ContextDocTier, content: string): StoredContextDoc => {
    const prev = stored(docType, tier);
    return {
      clientId,
      docType,
      tier,
      content,
      version: prev && Number.isInteger(prev.version) && prev.version > 0 ? prev.version + 1 : 1,
      createdAt: prev && Number.isFinite(prev.createdAt) ? prev.createdAt : now,
      updatedAt: now,
    };
  };
  const docs: StoredContextDoc[] = [
    row("action-plan", "internal-only", generated["action-plan"]),
    ...condensed.map((doc) => row(doc.docType, "client", doc.content)),
  ];

  // The gate, before the first write. A lab run that tried to write an
  // internal row, or a blank action plan, has touched nothing.
  assertLabContextDocWriteShape(docs, clientId);

  await Promise.all(docs.map((doc) => deps.upsertDoc(doc)));
  if (deps.projectDocs) {
    // Same posture as the full run: the rows are stored, and this is only
    // their copy in the engine workspace. The production projection re-reads
    // every stored row, so the engine sees the lab's documents beside these.
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
  const [
    { getClient, replaceClientContextDocs, listClientContextDocs, upsertClientContextDoc },
    { dispatchOnboardingResearchAgents },
    { getAgentEngineDeliverable },
    { condenseDocs },
    { RESEARCH_ENGINE_RULES, METRICS_RULES },
  ] =
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
    // The contract is also the delete scope: rows at any other (docType, tier)
    // — agent profiles, meeting notes — are not this run's to remove.
    replaceDocs: (id, docs) => replaceClientContextDocs(id, docs, CONTEXT_DOC_SET_CONTRACT),
    listDocs: (id) => listClientContextDocs(id),
    upsertDoc: (doc) => upsertClientContextDoc(doc),
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
