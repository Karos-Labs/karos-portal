import type { RecOwner } from "./routable-recommendation";

/**
 * [SCRUM-392] The ratified answer to "does every `RecOwner` have somewhere
 * that actually runs it?" — decided 2026-09-01, replacing what had been an
 * unratified guess (T-B14/SCRUM-259's own `TASK_OWNER_BY_REC_OWNER` mapping,
 * flagged explicitly at merge as "an assumption... neither C2 nor C4 has a
 * ratified answer").
 *
 * ## The question this ticket was opened to answer
 *
 * C2/SCRUM-210 defines `RecOwner` as a three-way split: `karos_agent` (our
 * agent runs it), `karos_tool` (a tool or connector does it, not a full
 * agent), `client_manual` (the client acts). `karos_agent` has a real
 * dispatch path (`dispatch-recommendation-run.ts`'s
 * `dispatchSeoGeoRecommendationRun`, T-B15/SCRUM-260). `client_manual` needs
 * no runner by definition. `karos_tool` had nothing — a recommendation
 * classified `karos_tool` was routed to a category that could not execute
 * it, and in practice behaved exactly like `client_manual` without saying
 * so, on the strength of an unratified guess (T-B14) rather than a decision.
 *
 * ## What was actually checked before ratifying
 *
 * The obvious candidate runner was inspected end to end, per this ticket's
 * own instruction, before writing any code: agent-engine's
 * `packages/tools/karos-seo-fix` (`dispatchSeoFix`, SCRUM-261/T-A17) —
 * "produces a reviewable artefact per `fixAction`... precisely 'a tool does
 * it, not a full agent'."
 *
 * It does not satisfy `karos_tool` end to end. Read directly
 * (`packages/tools/karos-seo-fix/src/dispatch.ts` and `types.ts`,
 * agent-engine):
 *
 *   - `dispatchSeoFix` is a pure, synchronous function. It has no
 *     persistence of its own — its own `SeoFixDispatchSuccess.artifactRef`
 *     doc says outright this is "not yet a real persisted path... left to
 *     whichever caller resolves that scope," and no caller in either repo
 *     resolves it.
 *   - It has no site-fetch and no CMS credential (its own scope guard,
 *     SCRUM-261) — every `SeoFixProposal` is templated off already-computed
 *     recommendation prose, never a real diff against the client's live
 *     page, and nothing anywhere applies the proposal it returns.
 *   - Most tellingly: its own doc comment states that every non-`connect`
 *     `owner` — `karos_agent`, `karos_tool`, AND `client_manual` — "gets the
 *     same artifact-shaped-by-`fixAction` treatment." It does not
 *     distinguish `karos_tool` from `client_manual` at all; wiring it in for
 *     `karos_tool` would produce the identical kind of output
 *     `client_manual` already gets today (a proposal for a human to act on),
 *     not the autonomous "a tool does it" execution `RecOwner`'s own doc
 *     comment describes.
 *
 * So: `karos_tool` is real as a CLASSIFICATION (a recommendation can
 * genuinely need "a connector, once linked" rather than either full-agent
 * execution or a client acting with no tooling at all — see
 * `routable-recommendation-tasks.ts`'s own "connect" `actionKind` handling,
 * which already gives these records a distinct task shape) but is
 * ASPIRATIONAL as an EXECUTION path: no tool-runner primitive exists for it
 * in either repo today, T-A17 is not that primitive, and building one is out
 * of this ticket's scope (same call `dispatch-recommendation-run.ts`'s own
 * T-B15 author already reached independently — this ticket ratifies that
 * finding as the project's decided answer instead of leaving it as one
 * module's unlinked observation).
 *
 * ## The ratified mapping
 *
 * `karos_tool` falls back to `client_managed` exactly as T-B14 already
 * shipped (`TASK_OWNER_BY_REC_OWNER` in `routable-recommendation-tasks.ts`)
 * — that mapping is now RATIFIED, not guessed. No code changed there; only
 * its status did.
 */
export interface RecOwnerRunStatus {
  readonly owner: RecOwner;
  /** Does approving a recommendation with this owner actually dispatch something today? */
  readonly hasRunPath: boolean;
  /** Required when `hasRunPath` is false — why this owner needs no runner, or doesn't have one yet. Never empty: an undocumented gap is exactly what this table exists to close. */
  readonly rationale: string;
}

export const REC_OWNER_RUN_STATUS: Readonly<Record<RecOwner, RecOwnerRunStatus>> = {
  karos_agent: {
    owner: "karos_agent",
    hasRunPath: true,
    rationale:
      "dispatchSeoGeoRecommendationRun (dispatch-recommendation-run.ts, T-B15/SCRUM-260) dispatches a real " +
      "agent-engine run — mode 'apply' for one_click, 'draft' for review_approve — once " +
      "SEO_GEO_RECOMMENDATION_RUN_DISPATCH_ENABLED is set and the record carries a verified engineProductId.",
  },
  karos_tool: {
    owner: "karos_tool",
    hasRunPath: false,
    rationale:
      "SCRUM-392 (ratified 2026-09-01): T-A17/dispatchSeoFix (agent-engine, packages/tools/karos-seo-fix) was " +
      "inspected and found artifact-only — it produces the identical kind of output for karos_tool as it does " +
      "for client_manual, has no persistence, and applies nothing. No tool-runner primitive exists in either " +
      "repo. Every karos_tool-owned recommendation is treated as client_managed (see " +
      "routable-recommendation-tasks.ts's TASK_OWNER_BY_REC_OWNER) until one is built — the classification is " +
      "real, the automatic-execution meaning of it is aspirational.",
  },
  client_manual: {
    owner: "client_manual",
    hasRunPath: false,
    rationale: "By definition (C2/SCRUM-210) — the client ships the fix themselves; approving this category never dispatches anything, flag or no flag.",
  },
};

/**
 * Every `RecOwner` this contract defines has a row above — derived from the
 * table's own keys (never a second, hand-copied list) so a `RecOwner` member
 * added without a row here is a `tsc` error against `Record<RecOwner, ...>`
 * above, not a silent gap this array could fail to reflect.
 */
export const REC_OWNERS_WITH_DOCUMENTED_RUN_STATUS = Object.keys(REC_OWNER_RUN_STATUS) as readonly RecOwner[];
