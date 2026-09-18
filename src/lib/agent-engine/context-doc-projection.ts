import "server-only";

import { createHash } from "node:crypto";
import type { BrandingGuidelines, Client, ClientContextDoc, ContextDocTier } from "@/lib/types";
import { clientCategoryValue } from "@/lib/utils";
import { isWorkspaceWriterConfigured, writeWorkspaceJson } from "./workspace-writer";

/**
 * Projects what the portal knows about a client into the files agent-engine's
 * own tools READ, at the moment the portal has something fresh to say.
 *
 * ## The gap this closes
 *
 * agent-engine's `client.getContextDoc` reads
 * `clients/<slug>/context/<docType>.json` — the one-file-per-doc-type
 * projection C1 (SCRUM-209) defines. Its writer, S-A14, never shipped. So on
 * every real deployment that path was empty, intel-report-agent's
 * `01c-load-target-audience`/`01d-load-market-strategy` came back empty for
 * clients whose portal held both documents, and every intel report ran
 * "degraded" — grounded in neither the audience nor the strategy the client
 * had written down. Found on prep 2026-09-05.
 *
 * `knowledge-sync.ts` mirrors the same documents to `knowledge/context-docs.json`,
 * but only from the reconcile cron, which prep does not run. This writes the
 * projection directly, from the two places the portal produces fresh brand and
 * context: the end of a Regenerate, and a branding refresh.
 *
 * ## What is written
 *
 * - `context/<docType>.json` for each of C1's doc types the client has, as
 *   `{ markdown, source }` — the `internal` tier when it exists (the agents are
 *   internal readers; `client` is the condensed public-facing form), else
 *   `client`. `source` carries real provenance: the Firestore doc id, version,
 *   tier, a content hash, and `projectedBy: "karoscmo"`.
 * - `client/brand.json` from the client's branding guidelines. The engine's
 *   copy was seeded once and never refreshed — prep's intel report described
 *   Karos Labs' background as `#242429` a day after the portal had corrected it
 *   to `#1a1a1a`.
 * - `client/profile.json` from the client record.
 *
 * ## Failure posture
 *
 * Never throws. Unconfigured writer, no `agentsRepoSlug`, or a bucket error all
 * mean "nothing projected", reported in the result and logged — a Regenerate
 * must not fail because a side-channel to the engine did.
 */

/** C1's v1 set — mirrors `CONTEXT_DOC_TYPES` in agent-engine's `get-context-doc.ts`. */
export const PROJECTED_CONTEXT_DOC_TYPES = [
  "brand-voice",
  "market-strategy",
  "competitor-analysis",
  "product-information",
  "branding-guidelines",
  "target-audience",
  "x",
  "linkedin",
  "reddit",
] as const;
type ProjectedDocType = (typeof PROJECTED_CONTEXT_DOC_TYPES)[number];

/** Keep each projected document within what the engine's prompts can carry — the same cap `knowledge-sync.ts` uses. */
const CONTENT_CAP = 6_000;

const PROJECTED_BY = "karoscmo";

export interface ProjectionResult {
  projected: boolean;
  contextDocs: number;
  brand: boolean;
  profile: boolean;
  reason?: string;
}

/** The shape `client.getContextDoc` reads back — kept in step with agent-engine's `ClientContextDocSource`. */
export interface ProjectedContextDoc {
  markdown: string;
  source: {
    firestoreDocId: string;
    docVersion: number;
    tier: string;
    projectedAt: string;
    projectedBy: string;
    contentHash: string;
  };
}

/** The loose shape agent-engine's `client.getBrand` reads — see `packages/tools/karos-client/src/get-brand.ts`. */
export interface ProjectedBrand {
  /**
   * The client's brand-voice STATEMENT — `Client.brandVoice` — because that is
   * what the engine reads this field as. `readBrandVoiceField`
   * (`@agent-engine/workflow`) pulls `brand.voice` out as a first-class
   * `brandVoice: "..."` drafting input, and every channel's copy step threads
   * it into its prompt.
   *
   * It used to be `toneKeywords.join(", ")`. So the one field the whole fleet
   * reads as "how does this brand sound" was delivering five adjectives —
   * "Innovative, Precise, Disruptive, Forward-thinking, Intelligent" — while
   * the client's actual voice spec (sentence unit, banned words, banned
   * punctuation, person and tense, the verbatim CTA line) sat unprojected on
   * the client record. The keywords are still projected, under their own name.
   */
  voice?: string;
  /** `BrandingGuidelines.toneKeywords`, as the list it is. */
  toneKeywords?: string[];
  colors?: string[];
  logoUrl?: string;
  tagline?: string;
  fonts?: { heading?: string; body?: string };
  dominantColors?: Array<{ hex: string; role?: string; dominanceRank: number }>;
  visualStyle?: string;
  guidelines?: string;
  /**
   * `Client.forbiddenTerms` — T-A11 / SCRUM-240. The producer for
   * `gate.brandCompliance`, which reads `clientContext.brand.forbiddenTerms`
   * and, until this was written, received `[]` on every run in the fleet.
   *
   * OMITTED WHEN EMPTY rather than projected as `[]`. The engine's gate reports
   * `configStatus: "unconfigured"` when it gets nothing, which is the honest
   * answer for a client whose brand rules were never entered; writing an empty
   * array would say the same thing in a shape that reads like a configured
   * client who happens to ban nothing. Absent and empty mean the same to the
   * gate, so the one that cannot be misread is the one to send.
   */
  forbiddenTerms?: string[];
  projectedAt: string;
  projectedBy: string;
}

/** The shape agent-engine's `client.getProfile` reads — see `get-profile.ts`. */
export interface ProjectedProfile {
  name: string;
  industry?: string;
  website?: string;
  description?: string;
  /** Bare hostnames only — the engine matches citations against these. */
  domains?: string[];
  projectedAt: string;
  projectedBy: string;
}

const TIER_PREFERENCE: readonly ContextDocTier[] = ["internal", "client"];

/**
 * One document per C1 type: the richest tier the client has. Internal-only
 * tiers (`action-plan`, `client-guidelines`) are not in C1's set and are not
 * projected — the engine never reads them.
 */
export function selectDocsForProjection(docs: readonly ClientContextDoc[]): ClientContextDoc[] {
  const chosen = new Map<ProjectedDocType, ClientContextDoc>();
  for (const docType of PROJECTED_CONTEXT_DOC_TYPES) {
    for (const tier of TIER_PREFERENCE) {
      const candidate = docs.find((d) => d.docType === docType && d.tier === tier && d.content.trim().length > 0);
      if (candidate) {
        chosen.set(docType, candidate);
        break;
      }
    }
  }
  return [...chosen.values()];
}

function cap(content: string): string {
  return content.length > CONTENT_CAP ? `${content.slice(0, CONTENT_CAP)}\n\n[truncated]` : content;
}

export function toProjectedContextDoc(doc: ClientContextDoc, projectedAt: string): ProjectedContextDoc {
  const markdown = cap(doc.content);
  return {
    markdown,
    source: {
      firestoreDocId: doc.id,
      docVersion: doc.version,
      tier: doc.tier,
      projectedAt,
      projectedBy: PROJECTED_BY,
      contentHash: createHash("sha256").update(markdown, "utf8").digest("hex"),
    },
  };
}

/**
 * The brand as the engine should see it. `colors` is the flat list its loose
 * `ClientBrand` contract has always carried; `dominantColors` is the role-bearing
 * form the portal actually maintains, so an engine that learns to read roles
 * gets them without another projection change.
 */
export function toProjectedBrand(
  /**
   * `Partial` because a client can now reach this function with no branding at
   * all: `forbiddenTerms` rides on `brand.json` and is entered on the settings
   * page, which a client fills in long before anyone runs the branding step.
   * Every field read below was already optional — the only required key on
   * `BrandingGuidelines` is `updatedAt`, which this projection does not read.
   */
  g: Partial<BrandingGuidelines>,
  projectedAt: string,
  /**
   * The parts of the brand that live on the CLIENT rather than in the branding
   * guidelines. An object rather than a third and fourth positional string,
   * because these two arrived one ticket apart and a third will arrive the same
   * way — `toProjectedBrand(g, at, voice, terms, ...)` is how a call site ends
   * up passing `undefined` into the wrong slot.
   */
  fromClient: { brandVoice?: string; forbiddenTerms?: readonly string[] } = {},
): ProjectedBrand {
  const { brandVoice } = fromClient;
  const forbiddenTerms = (fromClient.forbiddenTerms ?? []).filter((t) => t.trim().length > 0);
  const dominant = (g.dominantColors ?? []).filter((c) => typeof c.hex === "string" && c.hex.length > 0);
  const colors = dominant.length > 0 ? dominant.map((c) => c.hex.toLowerCase()) : [g.primaryAccent, g.secondaryAccent, g.brandNeutralDark, g.brandNeutralLight].filter((c): c is string => Boolean(c));
  // The statement first; the keywords only when there is no statement, so a
  // client whose branding has run but whose voice was never written still
  // projects something rather than nothing.
  const keywords = (g.toneKeywords ?? []).filter((k) => k.trim().length > 0);
  const voice = brandVoice?.trim() || keywords.join(", ") || undefined;
  return {
    ...(voice ? { voice } : {}),
    ...(keywords.length > 0 ? { toneKeywords: keywords } : {}),
    ...(colors.length > 0 ? { colors } : {}),
    ...(g.logoUrl ? { logoUrl: g.logoUrl } : {}),
    ...(g.fontHeading || g.fontBody ? { fonts: { ...(g.fontHeading ? { heading: g.fontHeading } : {}), ...(g.fontBody ? { body: g.fontBody } : {}) } } : {}),
    ...(dominant.length > 0 ? { dominantColors: dominant.map((c) => ({ hex: c.hex.toLowerCase(), ...(c.role ? { role: c.role } : {}), dominanceRank: c.dominanceRank })) } : {}),
    ...(g.visualStyle ? { visualStyle: g.visualStyle } : {}),
    ...(g.guidelines ? { guidelines: cap(g.guidelines) } : {}),
    ...(forbiddenTerms.length > 0 ? { forbiddenTerms: [...forbiddenTerms] } : {}),
    projectedAt,
    projectedBy: PROJECTED_BY,
  };
}

function hostnameOf(url: string | undefined): string | undefined {
  if (!url) return undefined;
  try {
    return new URL(url.startsWith("http") ? url : `https://${url}`).hostname.replace(/^www\./, "");
  } catch {
    return undefined;
  }
}

export function toProjectedProfile(client: Client, projectedAt: string): ProjectedProfile {
  const industry = clientCategoryValue(client) ?? undefined;
  const domain = hostnameOf(client.website);
  return {
    name: client.name,
    ...(industry ? { industry } : {}),
    ...(client.website ? { website: client.website } : {}),
    ...(client.description ? { description: client.description } : {}),
    // A hostname, never an email: prep's seeded profile carried
    // `domains: ["hello@karoslabs.com"]`, which no citation will ever match.
    ...(domain ? { domains: [domain] } : {}),
    projectedAt,
    projectedBy: PROJECTED_BY,
  };
}

export interface ProjectionDeps {
  isConfigured: () => boolean;
  write: (objectPath: string, value: unknown) => Promise<void>;
  now: () => number;
}

const productionDeps: ProjectionDeps = {
  isConfigured: isWorkspaceWriterConfigured,
  write: writeWorkspaceJson,
  now: () => Date.now(),
};

/**
 * Write the client's context docs, brand and profile into the engine workspace.
 * Docs are optional so a branding-only refresh can project brand + profile
 * without re-reading every document.
 */
export async function projectClientToWorkspace(
  client: Client,
  docs: readonly ClientContextDoc[] | undefined,
  deps: ProjectionDeps = productionDeps,
): Promise<ProjectionResult> {
  const slug = client.agentsRepoSlug;
  if (!slug) return { projected: false, contextDocs: 0, brand: false, profile: false, reason: "client has no agentsRepoSlug" };
  if (!deps.isConfigured()) return { projected: false, contextDocs: 0, brand: false, profile: false, reason: "AGENT_ENGINE_WORKSPACE_BUCKET is not set" };

  const projectedAt = new Date(deps.now()).toISOString();
  const prefix = `clients/${slug}`;
  const writes: Array<Promise<void>> = [];

  const selected = docs ? selectDocsForProjection(docs) : [];
  for (const doc of selected) {
    writes.push(deps.write(`${prefix}/context/${doc.docType}.json`, toProjectedContextDoc(doc, projectedAt)));
  }
  // Guidelines OR forbidden terms — NOT guidelines alone. `forbiddenTerms`
  // rides on `brand.json` because that is where `gate.brandCompliance` reads
  // it, but a client can have banned vocabulary long before anyone runs the
  // branding step; gating the whole file on `brandingGuidelines` would leave
  // exactly those clients' gate unconfigured with the rules sitting filled in
  // on the settings page, which is the failure this ticket exists to end.
  const hasForbiddenTerms = (client.forbiddenTerms ?? []).some((t) => t.trim().length > 0);
  const brand =
    client.brandingGuidelines || hasForbiddenTerms
      ? toProjectedBrand(client.brandingGuidelines ?? {}, projectedAt, { brandVoice: client.brandVoice, forbiddenTerms: client.forbiddenTerms })
      : null;
  if (brand) writes.push(deps.write(`${prefix}/client/brand.json`, brand));
  writes.push(deps.write(`${prefix}/client/profile.json`, toProjectedProfile(client, projectedAt)));

  try {
    await Promise.all(writes);
    console.info(`[context-doc-projection] ${slug} — projected ${selected.length} context doc(s), brand=${Boolean(brand)}, profile=true`);
    return { projected: true, contextDocs: selected.length, brand: Boolean(brand), profile: true };
  } catch (err) {
    // A bucket the runtime identity cannot write is a deployment gap, not a
    // reason to fail the run that noticed it. Say so loudly and move on.
    console.error(`[context-doc-projection] ${slug} — projection failed (non-fatal): ${(err as Error).message}`);
    return { projected: false, contextDocs: 0, brand: false, profile: false, reason: (err as Error).message };
  }
}
