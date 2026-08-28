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
 * The eight generated documents, composed from the two agent deliverables.
 *
 * Every section here is sourced from a field this repo already reads off the
 * same deliverable in `materialize.ts` — that is the check against inventing a
 * wire shape the engine does not send. A document that ends up with no content
 * at all is returned as an empty string and the caller's shape gate rejects the
 * run: an onboarding that produces a blank ground-truth document must fail
 * loudly, not store a placeholder for every downstream agent to read.
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
  const header = (title: string) => `# ${title} — ${client.name}`;

  const scoreLine = [
    typeof seoScore === "number" ? `SEO ${seoScore}` : undefined,
    typeof geoScore === "number" ? `GEO readiness ${geoScore}` : undefined,
  ]
    .filter((p): p is string => Boolean(p))
    .join(" · ");

  const recommendations = objArray(ir["recommendations"]);
  const fired = objArray(sg["firedRecommendations"]);

  return {
    "brand-voice": document(header("Brand Voice"), [
      section("Brand analysis", str(ir["brandAnalysis"])),
      section("Voice territory", str(ir["brandVoiceTerritory"])),
      section("Archetypes", bullets(strArray(ir["brandVoiceArchetypes"]))),
      section("Voice attributes", labelledList(objArray(ir["brandVoiceRows"]), ["attribute", "label", "name"], "score")),
    ]),

    "market-strategy": document(header("Market Strategy"), [
      scoreLine ? `**${scoreLine}**` : undefined,
      section("Positioning", str(ir["positioningAnalysis"])),
      section("Growth", str(ir["growthAnalysis"])),
      section("Whitespace opportunities", bullets(strArray(ir["whitespaceOpportunities"]))),
      section("Search and answer-engine visibility", str(sg["narrative"])),
    ]),

    "competitor-analysis": document(header("Competitor Analysis"), [
      typeof ir["competitorCount"] === "number" ? `**Competitors analysed: ${ir["competitorCount"]}**` : undefined,
      section("Rankings", labelledList(objArray(ir["competitorRankings"]), ["name", "competitor", "label"], "score")),
      section("Tracked competitors", bullets(strArray(ir["competitors"]))),
      section(
        "SWOT",
        joinBlocks(
          (["strengths", "weaknesses", "opportunities", "threats"] as const).map((key) => {
            const list = bullets(strArray(swot[key]));
            return list ? `**${key[0]!.toUpperCase()}${key.slice(1)}**\n${list}` : undefined;
          }),
        ),
      ),
      section("Share of voice in AI answers", labelledList(objArray(rec(sg["visibility"])["engines"]), ["engine", "label", "name"], "mentions")),
    ]),

    "product-information": document(header("Product Information"), [
      section("Content analysis", str(ir["contentAnalysis"])),
      section("Conversion analysis", str(ir["conversionAnalysis"])),
    ]),

    "branding-guidelines": document(header("Branding Guidelines"), [
      section("Brand analysis", str(ir["brandAnalysis"])),
      section("Brand synchronization update", str(ir["brandSynchronizationUpdate"])),
      section("Voice territory", str(ir["brandVoiceTerritory"])),
    ]),

    "target-audience": document(header("Target Audience"), [
      section("Customer sentiment", str(ir["customerSentiment"])),
      section("Buyer-intent prompt set", bullets(objArray(sg["promptSet"]).map((p) => str(p["prompt"]) ?? str(p["text"]) ?? "").filter(Boolean))),
    ]),

    "client-guidelines": document(header("Client Guidelines"), [
      section("Dimension scores", labelledList(objArray(ir["dimensionScores"]), ["label", "key", "dimension"], "score")),
      section("Standing recommendations", labelledList(recommendations, ["title", "recommendation", "id"])),
    ]),

    "action-plan": document(header("Action Plan"), [
      section("From the intel report", labelledList(recommendations, ["title", "recommendation", "id"])),
      section("From the SEO/GEO audit", labelledList(fired, ["title", "recommendation", "id"])),
      section("Prepared fixes", labelledList(objArray(sg["fixDrafts"]), ["title", "target", "id"])),
    ]),
  };
}

/* ── The run ──────────────────────────────────────────────────────── */

/** The engine `kind` each product writes through `ledger.writeDeliverable`. Must match `PRODUCT_DELIVERABLE_KINDS` in materialize.ts exactly — anything else 404s. */
export const INTEL_REPORT_DELIVERABLE_KIND = "intel-report";
export const SEO_GEO_DELIVERABLE_KIND = "seo-geo-report";

export interface AgentOnboardingDeps {
  getClient: (clientId: string) => Promise<Client | null>;
  dispatchResearchAgents: (client: Client) => Promise<{
    intelReport: { agentEngineRunId?: string; error?: string; skipped?: true; reason?: string };
    seoGeo: { agentEngineRunId?: string; error?: string; skipped?: true; reason?: string };
  }>;
  getDeliverable: (runId: string, kind: string) => Promise<unknown>;
  condense: (client: Client, docTypes: ContextDocType[], internal: Record<string, string>) => Promise<{ docType: ContextDocType; content: string }[]>;
  replaceDocs: (clientId: string, docs: StoredContextDoc[]) => Promise<void>;
  now: () => number;
  sleep: (ms: number) => Promise<void>;
}

export interface AgentOnboardingOptions {
  /** How long to wait for each agent-engine deliverable before failing the run. */
  deliverableTimeoutMs?: number;
  /** Gap between deliverable polls. */
  pollIntervalMs?: number;
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
  const deliverableTimeoutMs = options.deliverableTimeoutMs ?? 15 * 60_000;
  const pollIntervalMs = options.pollIntervalMs ?? 15_000;

  const client = await deps.getClient(clientId);
  if (!client) throw new Error(`Client not found: ${clientId}`);

  const dispatched = await deps.dispatchResearchAgents(client);
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
  for (;;) {
    const deliverable = await deps.getDeliverable(runId, kind);
    if (deliverable !== undefined && deliverable !== null) return deliverable;
    if (deps.now() >= deadline) {
      throw new Error(
        `Agent-based onboarding timed out waiting for the "${kind}" deliverable of agent-engine run ${runId} ` +
          `after ${Math.round(timeoutMs / 1000)}s. Refusing to write context documents without it.`,
      );
    }
    await deps.sleep(pollIntervalMs);
  }
}

/**
 * The production wiring of `runAgentOnboarding`. Kept as a thin factory so the
 * run above stays drivable in a test without a Firestore, a Pub/Sub topic or a
 * model call — the alternative is a function nobody can prove anything about.
 */
export async function runAgentOnboardingForClient(
  clientId: string,
  options: AgentOnboardingOptions = {},
): Promise<{ docsWritten: number }> {
  const [{ getClient, replaceClientContextDocs }, { dispatchOnboardingResearchAgents }, { getAgentEngineDeliverable }, { condenseDocs }, { RESEARCH_ENGINE_RULES, METRICS_RULES }] =
    await Promise.all([
      import("@/lib/data"),
      import("@/lib/agent-engine/dispatch-research-agents"),
      import("@/lib/agent-engine/client"),
      import("./condense"),
      import("./brain"),
    ]);

  const rules = [RESEARCH_ENGINE_RULES, "", METRICS_RULES].filter(Boolean).join("\n");

  return runAgentOnboarding(
    clientId,
    {
      getClient,
      dispatchResearchAgents: (client) => dispatchOnboardingResearchAgents(client),
      getDeliverable: (runId, kind) => getAgentEngineDeliverable(runId, kind),
      condense: (client, docTypes, internal) => condenseDocs(client, docTypes, internal, rules),
      replaceDocs: (id, docs) => replaceClientContextDocs(id, docs),
      now: () => Date.now(),
      sleep: (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
    },
    options,
  );
}
