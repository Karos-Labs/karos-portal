import type { ActionKind, FixAction, Lever } from "@/lib/seo-geo";
import { KNOWN_ENGINE_PRODUCT_IDS, isKnownEngineProductId } from "./product-mapping";

/**
 * [C2] Contract — routable recommendation shape (SCRUM-210).
 *
 * PROBLEM. agent-engine's `seo-geo-agent` fires recommendations off a
 * catalog (`packages/tools/karos-seo-geo/src/config/rec-catalog.data.ts` in
 * agent-engine — 75 records, independently re-counted (top-level-key regex
 * and a brace-depth walk on the exported object literal, both agreeing on
 * 75; the ticket's stated 75 was right, a prior reading of 72 was wrong)
 * that carries, per record, `check` (the failing
 * check — the evidence), `lever` (SEO/GEO/BOTH), and `product_ref` — plus,
 * going forward, which of three categories owns the fix and (when we own it)
 * which engine product runs it. Today's wire shape
 * (`packages/tools/karos-seo-geo/src/recommend.ts`'s `FiredRecommendation`,
 * verified by reading that file directly) is ten fields of scoring output —
 * `recId`, `recommendation`, `fireState`, `worstNorm`, `scoreLift`, `impact`,
 * `effort`, `delivery`, `priorityScore`, `hardOverride` — and NONE of the
 * catalog's routable hints (`recommend.ts`'s own `RecCatalogEntry` type only
 * ever reads `recommendation`/`impact`/`effort`/`delivery`/`source` off each
 * catalog row — verified directly, there is no `check`/`lever`/`product_ref`
 * anywhere in that file). `materializeSeoGeoReport` (./materialize.ts) used
 * to read exactly that ten-field shape and turn it into a recId + a prose
 * bullet; there was nothing else in the payload TO keep.
 *
 * VOCABULARY. `FixAction` and `ActionKind` are NOT redefined here — they are
 * `@/lib/seo-geo`'s own unions (`FixAction` for the client-facing SaaS
 * action-plan, `ActionKind` for its render control), which this ticket
 * declares canonical for BOTH repos. Do not invent a third spelling of
 * either; if agent-engine's copy of these two unions ever needs a new
 * member, `seo-geo.ts` gets it first and this file's `KNOWN_FIX_ACTIONS` /
 * `KNOWN_ACTION_KINDS` (below) is the portal half of the cross-repo contract
 * that would then need updating on both sides. That "or else" is checked for
 * real: `__tests__/routable-recommendation.test.ts` parses `@/lib/seo-geo.ts`'s
 * own `FixAction`/`ActionKind` type-alias declarations off the AST (not a
 * second hand-copied literal list standing in for them) and fails if this
 * file's arrays and that live union disagree in either direction — see that
 * test file's own doc comment for why an earlier version of this pin was a
 * no-op.
 *
 * `RecOwner` IS new here — the three-way split the original requirement
 * asked for. `client_manual` is the fail-safe default: an unclassified
 * recommendation must never be treated as something the platform runs
 * automatically.
 */

/** The three categories a routable recommendation's fix can land in. */
export type RecOwner = "karos_agent" | "karos_tool" | "client_manual";

const KNOWN_REC_OWNERS: ReadonlySet<RecOwner> = new Set(["karos_agent", "karos_tool", "client_manual"]);

/** Fail-safe default per the ticket: an unmapped/unrecognized record never runs anything automatically. */
const DEFAULT_REC_OWNER: RecOwner = "client_manual";

/**
 * The canonical `FixAction` members, transcribed from `@/lib/seo-geo`'s own
 * union. Pinned against that union's live AST (not a second hand-copy of it)
 * by `__tests__/routable-recommendation.test.ts` — see that file. This is the
 * portal half of "checked by a contract test on both sides" — agent-engine
 * keeps the matching half once its copy of the catalog carries `fix_action`.
 */
export const KNOWN_FIX_ACTIONS: readonly FixAction[] = [
  "meta_title",
  "meta_description",
  "schema",
  "og_image",
  "canonical",
  "image_alt",
  "sitemap",
  "indexing",
  "manual",
];

/** Same transcription, for `ActionKind`. */
export const KNOWN_ACTION_KINDS: readonly ActionKind[] = ["one_click", "review_approve", "connect", "guided_manual"];

const FIX_ACTION_SET: ReadonlySet<string> = new Set(KNOWN_FIX_ACTIONS);
const ACTION_KIND_SET: ReadonlySet<string> = new Set(KNOWN_ACTION_KINDS);

/** Never-classified fallback: a fix action nobody can act on. Same convention as `fixActionFor` in seo-geo.ts. */
const DEFAULT_FIX_ACTION: FixAction = "manual";
/** Never-classified fallback: matches `client_manual`'s own "advisory, human-shipped" default action kind. */
const DEFAULT_ACTION_KIND: ActionKind = "guided_manual";

/**
 * agent-engine's `FiredRecommendation` (`packages/tools/karos-seo-geo/src/recommend.ts`),
 * transcribed field-for-field. `impact`/`effort`/`delivery` are kept as the
 * loose `string` they are on that side (raw catalog JSON values —
 * `"critical"|"high"|"medium"|"low"`, `"quick"|"medium"|"heavy"`,
 * `"agent-direct"|"existing-product"|"new-product"` today, per that file's
 * own `IMPACT_W`/`EFFORT_W`/`DELIVERABILITY_BONUS` tables — but narrowing
 * them here would be inventing a fourth spelling of a union this contract
 * does not own).
 */
export interface FiredRecommendation {
  recId: string;
  recommendation: string;
  fireState: "pass" | "approaching" | "fail";
  worstNorm: number;
  scoreLift: number;
  impact: string;
  effort: string;
  delivery: string;
  priorityScore: number;
  hardOverride: boolean;
}

/**
 * [C2] SHAPE. Extends `FiredRecommendation` rather than replacing it — every
 * scoring field a `FiredRecommendation` carries stays exactly as-is. Adds:
 *
 *   - what the catalog already holds and the old wire shape discarded:
 *     `check` (the failing check / evidence), `lever`, `productRef`.
 *   - the routing this ticket exists to add: `fixAction`, `actionKind`,
 *     `owner`, `targetPlatform?`, `engineProductId?`.
 *
 * `engineProductId` is present ONLY when `owner === "karos_agent"`, and only
 * ever a `KNOWN_ENGINE_PRODUCT_IDS` value (rule 2). `owner === "karos_agent"`
 * with no `engineProductId` is, per the ticket, a build error on the
 * engine's mapping table — this side cannot enforce a build error against a
 * wire payload at runtime, so `toRoutableRecommendation` below fails safe
 * instead: it downgrades that record to `client_manual` and drops the
 * invalid id rather than ever routing to a product nobody validated (rule
 * 3, read defensively).
 */
export interface RoutableRecommendation extends FiredRecommendation {
  /** The failing check / the evidence (catalog `check`). */
  check: string;
  lever: Lever;
  /** `product_ref.folder` is a LAB folder name, not an engine productId — never derive one from it (rule 1). */
  productRef: { id: string; folder: string; status: string } | null;
  fixAction: FixAction;
  actionKind: ActionKind;
  owner: RecOwner;
  targetPlatform?: string;
  /** Only present, and only trusted, when `owner === "karos_agent"`. */
  engineProductId?: string;
}

function isNonEmptyString(v: unknown): v is string {
  return typeof v === "string" && v.trim().length > 0;
}

function isFiniteNumber(v: unknown): v is number {
  return typeof v === "number" && Number.isFinite(v);
}

function asFireState(v: unknown): FiredRecommendation["fireState"] | undefined {
  return v === "pass" || v === "approaching" || v === "fail" ? v : undefined;
}

function asProductRef(v: unknown): RoutableRecommendation["productRef"] {
  if (typeof v !== "object" || v === null) return null;
  const r = v as Record<string, unknown>;
  if (!isNonEmptyString(r.id) || !isNonEmptyString(r.folder) || !isNonEmptyString(r.status)) return null;
  return { id: r.id, folder: r.folder, status: r.status };
}

function asFixAction(v: unknown): FixAction {
  return typeof v === "string" && FIX_ACTION_SET.has(v) ? (v as FixAction) : DEFAULT_FIX_ACTION;
}

function asActionKind(v: unknown): ActionKind {
  return typeof v === "string" && ACTION_KIND_SET.has(v) ? (v as ActionKind) : DEFAULT_ACTION_KIND;
}

function asLever(v: unknown): Lever {
  return v === "SEO" || v === "GEO" || v === "BOTH" ? v : "BOTH";
}

/**
 * Did this RAW wire record actually carry a recognized `owner`, before any
 * fail-safe default is applied?
 *
 * Exists so a caller (`materializeSeoGeoReport`) can tell "the engine has not
 * started sending owner data yet, so every record parsed to `client_manual`
 * only because that is the fail-safe default" apart from "the engine
 * genuinely classified this one as `client_manual`" — `toRoutableRecommendation`
 * itself can't surface that distinction, because by design it normalizes both
 * cases to the same `owner: "client_manual"` output. Today (2026-08), agent-engine's
 * `seo-geo-agent` writes no `owner`/`fixAction`/`engineProductId` fields on
 * ANY fired recommendation at all (verified directly against
 * `create-seo-geo-agent-workflow.ts`'s `firedRecommendations: recommendations`
 * assignment, itself a bare `FiredRecommendation[]` from `recommend.ts`) — so
 * this returns `false` for every real payload until T-A4/SCRUM-257 ships the
 * mapping table on that side.
 */
export function hasClassifiedOwner(raw: unknown): boolean {
  if (typeof raw !== "object" || raw === null) return false;
  return KNOWN_REC_OWNERS.has((raw as Record<string, unknown>).owner as RecOwner);
}

/**
 * Parse one raw fired-recommendation record off the wire into a
 * `RoutableRecommendation`, or `undefined` if it isn't even a valid
 * `FiredRecommendation` (missing `recId`/`recommendation` — nothing
 * downstream can render a recommendation with no id and no prose).
 *
 * FAIL-SAFE BY CONSTRUCTION (the ticket's "DEFAULT FOR AN UNMAPPED RECORD IS
 * client_manual", extended from "unmapped in the catalog" to "malformed on
 * the wire" — the same failure mode from this side of the boundary):
 *
 *   - `owner` missing or not one of the three known values -> `client_manual`.
 *   - `owner === "karos_agent"` but `engineProductId` missing or not a
 *     `KNOWN_ENGINE_PRODUCT_IDS` member -> downgraded to `client_manual`,
 *     `engineProductId` dropped. A record this module cannot verify as
 *     routable to a real product is never treated as routable.
 *   - `fixAction`/`actionKind` missing or unrecognized -> the same
 *     never-guess fallback `fixActionFor` uses in seo-geo.ts (`"manual"`),
 *     paired with `"guided_manual"` — advisory, human-shipped, matching
 *     what an unclassified owner already means.
 */
export function toRoutableRecommendation(raw: unknown): RoutableRecommendation | undefined {
  if (typeof raw !== "object" || raw === null) return undefined;
  const r = raw as Record<string, unknown>;
  if (!isNonEmptyString(r.recId) || !isNonEmptyString(r.recommendation)) return undefined;

  const fireState = asFireState(r.fireState) ?? "fail";
  const worstNorm = isFiniteNumber(r.worstNorm) ? r.worstNorm : 0;
  const scoreLift = isFiniteNumber(r.scoreLift) ? r.scoreLift : 0;
  const priorityScore = isFiniteNumber(r.priorityScore) ? r.priorityScore : 0;

  const rawOwner = KNOWN_REC_OWNERS.has(r.owner as RecOwner) ? (r.owner as RecOwner) : DEFAULT_REC_OWNER;
  const rawEngineProductId = isNonEmptyString(r.engineProductId) ? r.engineProductId : undefined;
  const engineProductIdValid = rawOwner === "karos_agent" && isKnownEngineProductId(rawEngineProductId);

  // Rule 3, read defensively: karos_agent without a verifiable engineProductId
  // is not routable, so it is not karos_agent — never a silent guess at which
  // product to run.
  const owner: RecOwner = rawOwner === "karos_agent" && !engineProductIdValid ? "client_manual" : rawOwner;
  const engineProductId = owner === "karos_agent" ? rawEngineProductId : undefined;

  return {
    recId: r.recId,
    recommendation: r.recommendation,
    fireState,
    worstNorm,
    scoreLift,
    impact: isNonEmptyString(r.impact) ? r.impact : "medium",
    effort: isNonEmptyString(r.effort) ? r.effort : "medium",
    delivery: isNonEmptyString(r.delivery) ? r.delivery : "existing-product",
    priorityScore,
    hardOverride: r.hardOverride === true,
    check: isNonEmptyString(r.check) ? r.check : "",
    lever: asLever(r.lever),
    productRef: asProductRef(r.productRef),
    fixAction: asFixAction(r.fixAction),
    actionKind: asActionKind(r.actionKind),
    owner,
    targetPlatform: isNonEmptyString(r.targetPlatform) ? r.targetPlatform : undefined,
    engineProductId,
  };
}

/** Every `RecOwner` bucket, always present (even empty) so a caller never has to guard a missing key. */
export type RecommendationsByOwner = Record<RecOwner, RoutableRecommendation[]>;

/**
 * THE SPRAYER (acceptance #3: "classifies into the three categories with
 * zero ifs on a specific recId"). This function's only signal is
 * `rec.owner` — already normalized and fail-safed by
 * `toRoutableRecommendation` above — so it is structurally incapable of
 * branching on a recId: it never reads `.recId` at all. Verified by
 * `__tests__/routable-recommendation.test.ts` feeding recIds this function
 * (and this repo) has never seen and asserting they still land correctly.
 */
export function groupRecommendationsByOwner(recs: readonly RoutableRecommendation[]): RecommendationsByOwner {
  const out: RecommendationsByOwner = { karos_agent: [], karos_tool: [], client_manual: [] };
  for (const rec of recs) {
    out[rec.owner].push(rec);
  }
  return out;
}

export { KNOWN_ENGINE_PRODUCT_IDS };
