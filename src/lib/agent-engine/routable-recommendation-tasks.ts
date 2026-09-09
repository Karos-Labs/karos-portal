import { resolveRecCopy } from "@/lib/seo-geo";
import type { ClientTask, ClientTaskAction, ClientTaskMetadata, TaskOwner, TaskPriority, TaskSource } from "@/lib/types";
import { isKnownEngineProductId } from "./product-mapping";
import type { RecOwner, RoutableRecommendation } from "./routable-recommendation";

/**
 * [C2/C4, SCRUM-259/T-B14] Recommendations to typed tasks.
 *
 * PROBLEM. `toRoutableRecommendation` (routable-recommendation.ts, T-A4/C2)
 * parses agent-engine's fired recommendations into a typed, routable shape —
 * `owner`/`fixAction`/`actionKind` carry the classification `recommend.ts`
 * used to discard — and `materializeSeoGeoReport` (materialize.ts) already
 * exposes the parsed array as `meta.routableRecommendations` on the
 * materialized `seo-geo-report` Asset. Nothing converts one of those parsed
 * records into a `ClientTask` a client actually sees on their task board:
 * `createClientTask` (data.ts) has six call sites as of 2026-08-30
 * (agent-swarm.ts, campaign-engine.ts, task-actions.ts ×2, the chat route
 * ×2) and NONE of them reads `clientReports`/`clientSeoGeo`/
 * `routableRecommendations` — confirmed directly against every call site.
 * This module is that missing converter.
 *
 * THE DISPATCH RULE (SCRUM-210's own acceptance #3, carried forward): a
 * recommendation's `owner` and `fixAction`/`actionKind` — never its `recId` —
 * decide the shape of the task it becomes. `TASK_OWNER_BY_REC_OWNER` and
 * `routableRecommendationToTaskInput` below read only those three fields (plus
 * `impact`/`targetPlatform`/`engineProductId`, all generic wire data); neither
 * function contains a `recId === "..."` branch or a `case "REC-ID"` arm, and
 * `__tests__/routable-recommendation-tasks.test.ts` feeds recIds this module
 * has never seen to prove that.
 *
 * OWNER MAPPING (RATIFIED — SCRUM-392, 2026-09-01. Originally shipped here as
 * an unratified assumption per EXEC-CONTEXT: "neither C2 nor C4 has a
 * ratified answer for how `RecOwner`'s three buckets land on
 * `ClientTask.owner`'s two." SCRUM-392 inspected the obvious candidate
 * runner for `karos_tool` — T-A17/`dispatchSeoFix` — found it artifact-only
 * (identical output for `karos_tool` and `client_manual`, no persistence, no
 * apply step; see `rec-owner-run-status.ts`'s full account), and ratified
 * this mapping as the project's decided answer rather than a guess.)
 * `RecOwner` and `TaskOwner` are DIFFERENT fields answering different
 * questions — this file's own doc, and `ClientTask.owner`'s, both say so — so
 * this is a deliberate design decision, not a rename:
 *
 *   - "karos_agent" (the platform runs the fix)      -> "karos_managed"
 *   - "karos_tool"  (a connector runs it once linked) -> "client_managed"
 *   - "client_manual" (the client ships it by hand)   -> "client_managed"
 *
 * "karos_tool" landing on "client_managed" rather than "karos_managed" is the
 * one non-obvious call, and it follows an EXISTING precedent in this
 * codebase rather than inventing one: the chat route's own task generator
 * already models "the client needs to connect an integration before we can
 * act" as `owner: "client_managed"` plus `completionTrigger:
 * "integration_connected:<platform>"` (`app/api/clients/[id]/chat/route.ts`,
 * the `/connect|re-?auth/i` branch) — a "connect" task sits on the client's
 * side of the board until they complete the connection, exactly what
 * `RecOwner`'s own doc comment describes for "karos_tool" ("a tool or
 * connector does it, not a full agent" — but a client has to link it first).
 * This module makes that same call generically, off `actionKind === "connect"`
 * rather than a title regex, and sets the same `completionTrigger` shape.
 *
 * WHAT THIS MODULE DELIBERATELY DOES NOT DO. It does not dispatch the actual
 * fix — a "karos_agent" task this module creates carries
 * `metadata.agentEngineProductId` for `dispatch-recommendation-run.ts`'s
 * `dispatchSeoGeoRecommendationRun` (T-B15/SCRUM-260) to read on approval;
 * this converter only builds the task. It does not run the
 * duplicate-title / karos-queue-capacity pipeline the swarm and chat-route
 * call sites share (`findDuplicateReason`, `queueCapacitySkipNote`,
 * `MAX_ACTIVE_TASKS`) — see `createTasksFromSeoGeoReportAction`
 * (seo-geo-task-actions.ts) for the idempotency this module's own caller
 * uses instead (skip a recId that already has a task), a narrower and
 * sufficient guard for a source that always re-fires the same finite set of
 * catalog recIds rather than free-text titles.
 */

/**
 * The task-board counterpart of `groupRecommendationsByOwner`'s sprayer — one
 * dispatch table, no recId. Ratified SCRUM-392 — see `rec-owner-run-status.ts`
 * for whether each `RecOwner` actually has a run path today, which is a
 * separate question this table does not answer by itself.
 */
const TASK_OWNER_BY_REC_OWNER: Record<RecOwner, TaskOwner> = {
  karos_agent: "karos_managed",
  karos_tool: "client_managed",
  client_manual: "client_managed",
};

export function taskOwnerForRecOwner(owner: RecOwner): TaskOwner {
  return TASK_OWNER_BY_REC_OWNER[owner];
}

/**
 * `FiredRecommendation.impact` is the raw catalog string
 * (`"critical"|"high"|"medium"|"low"`, per `routable-recommendation.ts`'s own
 * doc comment) — never narrowed to a closed union upstream, so this map has a
 * fallback for anything else the wire sends. Mirrors `impactFor`'s
 * `GapSeverity -> RecImpact` collapse in seo-geo.ts (critical/high -> high),
 * without importing that function directly since it takes a `GapSeverity`,
 * not this raw catalog string.
 */
const PRIORITY_BY_IMPACT: Record<string, TaskPriority> = {
  critical: "high",
  high: "high",
  medium: "medium",
  low: "low",
};

export function priorityForImpact(impact: string): TaskPriority {
  return PRIORITY_BY_IMPACT[impact] ?? "medium";
}

/** Same `{high: 80, medium: 50, low: 25}` default every other createClientTask call site derives its weight from. */
const WEIGHT_BY_PRIORITY: Record<TaskPriority, number> = { high: 80, medium: 50, low: 25 };

/**
 * Neither `TaskSource` (types.ts) nor its own display map
 * (`task-ticket-modal.tsx`'s `SOURCE_META`) has a member for this pipeline —
 * `brand_audit` is already spoken for by a different chatbot-widget quick
 * action (a brand-positioning audit, not a technical SEO/GEO one;
 * `components/chatbot-widget.tsx`'s "Brand Visibility Audit" trigger) and
 * reusing it here would mislabel this task's origin in that UI. `"custom"`
 * plus an explicit `sourceLabel` is the existing generic escape hatch
 * (`ClientTask.sourceLabel`, already used by the chat route's own gmail-
 * sourced tasks for the same reason) rather than widening the shared
 * `TaskSource` union for one caller — flagged in this ticket's report as a
 * finding rather than done silently.
 */
export const SEO_GEO_TASK_SOURCE: TaskSource = "custom";
export const SEO_GEO_TASK_SOURCE_LABEL = "SEO & GEO visibility report";

export interface RoutableRecommendationTaskContext {
  clientId: string;
  createdBy: string;
  /** Defaults to `Date.now()` — overridable so a caller (or a test) can pin `createdAt`/`updatedAt`. */
  now?: number;
}

/**
 * Convert one parsed, routable recommendation into the `ClientTask` shape
 * `createClientTask` (data.ts) expects, generically dispatching on
 * `owner`/`fixAction`/`actionKind` — see this module's own header for why
 * that is the whole point and how it is checked.
 */
export function routableRecommendationToTaskInput(
  rec: RoutableRecommendation,
  ctx: RoutableRecommendationTaskContext,
): Omit<ClientTask, "id"> {
  const now = ctx.now ?? Date.now();
  const copy = resolveRecCopy(rec.recId);
  const priority = priorityForImpact(rec.impact);
  const owner = taskOwnerForRecOwner(rec.owner);
  const action: ClientTaskAction = { fixAction: rec.fixAction, actionKind: rec.actionKind };

  const metadata: ClientTaskMetadata = {
    recId: rec.recId,
    action,
  };

  // Rule 3 read again, defensively, at this second boundary: `engineProductId`
  // only ever means something (and is only ever trusted) when the record is
  // ACTUALLY karos_agent-owned AND the id is a real, known engine product —
  // never derived from, or gated on, which recId this happens to be.
  if (rec.owner === "karos_agent" && isKnownEngineProductId(rec.engineProductId)) {
    metadata.agentEngineProductId = rec.engineProductId;
  }

  // Generic dispatch on actionKind, not on owner or recId: "connect" is the
  // one actionKind that means "the client has to link something before this
  // can move" (seo-geo.ts's own actionKindFor: delivery === "existing-product"
  // -> "connect"), so it is the one actionKind that gets the same
  // integration-action shape the chat route already gives a client "connect
  // your X" task (see header) — a platform tag, the `integration_action`
  // execution-surface discriminator `execution-engine.ts`'s `resolveTaskType`
  // already reads, and the auto-complete hook `task-sync.ts` already wires
  // for `integration_connected:<platform>`.
  if (rec.actionKind === "connect" && rec.targetPlatform) {
    metadata.platform = rec.targetPlatform;
    metadata.type = "integration_action";
    metadata.completionTrigger = `integration_connected:${rec.targetPlatform}`;
  }

  return {
    clientId: ctx.clientId,
    title: copy.title,
    description: copy.description,
    status: "pending",
    priority,
    source: SEO_GEO_TASK_SOURCE,
    sourceLabel: SEO_GEO_TASK_SOURCE_LABEL,
    owner,
    weight: WEIGHT_BY_PRIORITY[priority],
    metadata,
    createdBy: ctx.createdBy,
    createdAt: now,
    updatedAt: now,
  };
}

/**
 * Batch form — every recommendation, minus any whose `recId` is already
 * represented in `existingRecIds` (the idempotency guard
 * `createTasksFromSeoGeoReportAction` builds from the client's current task
 * board, so re-running this after a fresh report capture never duplicates a
 * task for a finding the board already has).
 */
export function routableRecommendationsToTaskInputs(
  recs: readonly RoutableRecommendation[],
  ctx: RoutableRecommendationTaskContext,
  existingRecIds: ReadonlySet<string> = new Set(),
): Array<Omit<ClientTask, "id">> {
  return recs
    .filter((rec) => !existingRecIds.has(rec.recId))
    .map((rec) => routableRecommendationToTaskInput(rec, ctx));
}
