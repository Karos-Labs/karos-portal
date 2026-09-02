/**
 * WHICH ASSET TYPE A DELIVERED RUN BECOMES — and the one fence that stops a
 * draft-only deliverable landing on a publishable one.
 *
 * The type is not a label. `PUBLISHABLE_PLATFORMS` is keyed by it, so the type
 * decides whether the asset card offers "Publish now", whether the schedule form
 * lists channels, and whether the auto-publish cron will push the text to
 * whichever platform the client has connected. A Reddit reply typed
 * `social_post` is therefore offered to twitter, linkedin and tiktok —
 * a reply written for one thread, cross-posted to three strangers' feeds.
 *
 * REDDIT IS DRAFT-ONLY BY HARD PRODUCT RULE: a human always posts the reply from
 * their own account, and no posting code path exists or may be added. That rule
 * was pinned for the lab-import path (`guessAssetType`, which checks Reddit
 * BEFORE its social bucket for exactly this reason) and for the platform map
 * itself — and missed on the webhook, where `metadata.asset_type` could name any
 * whitelisted type including `social_post`. One rule, written twice, one copy
 * missed.
 *
 * ALL THREE RUNTIME DERIVATIONS NOW GO THROUGH THIS MODULE, and they are named
 * rather than counted so the claim can be checked:
 *
 *   the agent-service webhook  → `deliverableAssetType` (metadata hint + identity)
 *   MCP `upload_asset`         → `deliverableAssetType` (the agent's own argument)
 *   a lab-repo import          → `labImportAssetType`   (folder name + item text)
 *
 * The third arrived last and was the reason this paragraph used to be false: it
 * claimed every runtime-derived type came through here while the lab import went
 * its own way, keyed to a FOLDER NAME and never reading the deliverable. That set
 * is pinned in platforms-publishable.test.ts, which scans every `createAsset`
 * call in src/ and fails on a fourth derivation nobody has reviewed.
 *
 * Client-safe (no server-only import) so the guard suite can call it directly
 * rather than asserting about source text.
 */

import { PUBLISHABLE_PLATFORMS } from "@/lib/integrations/platforms";
import { parseRedditDrafts } from "@/lib/reddit-drafts";
import type { AssetType, WireTaskType } from "@/lib/types";

/**
 * The asset type each task type's deliverable lands as.
 *
 * KEYED BY `WireTaskType`, not `ManagedTaskType`, and the difference is
 * load-bearing: the retired `newsletter_issue` row stays. This map is read on
 * the DELIVERY path, so it has to answer for a v1 job that was already queued
 * when the service was cut — dropping the row would land that issue as a
 * slot-less `note` in the library instead of an `email`, on the one run nobody
 * can re-fire because the product no longer exists.
 */
const TASK_TYPE_ASSET_TYPE = {
  social_post: "social_post",
  /** RETIRED product, drain-only. See the note above before removing. */
  newsletter_issue: "email",
  blog_article: "article",
  landing_page: "note",
  // Custom agents produce any shape, so the slot-less library note is the safe
  // default; the submitter can hint the real type (below).
  custom: "note",
} as const satisfies Record<WireTaskType, AssetType>;

/**
 * Asset types a `custom` run may REQUEST via `metadata.asset_type` — a hint is
 * honored only if it is one of these, otherwise the task-type default stands.
 * A whitelist rather than a cast: the value arrives over the wire.
 */
const VALID_HINT_TYPES = new Set<AssetType>([
  "social_post",
  "instagram_post",
  "email",
  "article",
  "note",
]);

/**
 * Where a draft-only deliverable lands. "note" is the only type in
 * PUBLISHABLE_PLATFORMS with no targets that also carries no channel semantics
 * of its own, and it is what `guessAssetType` already gives an imported Reddit
 * run — so a live run and an imported one land on the same type.
 *
 * NOT self-verifying: nothing here can prove "note" stays target-less, because
 * that is a property of another module's table. The pin lives in
 * platforms-publishable.test.ts, which asserts it of THIS constant — add a
 * publish target to `note` and that suite goes red.
 */
export const DRAFT_ONLY_ASSET_TYPE: AssetType = "note";

/** Whether an asset of this type can be pushed to any platform at all. */
export function hasPublishTargets(type: AssetType): boolean {
  return (PUBLISHABLE_PLATFORMS[type] ?? []).length > 0;
}

/**
 * Any identity string that names Reddit. LOOSE on purpose (rule: match the
 * shape, not one spelling): the exact-key predicates elsewhere
 * (`isRedditAgent`, `isRedditAgentIdentity`) answer "is this THE karos Reddit
 * agent doc", which is a different question from "is this deliverable a Reddit
 * reply" — a per-client instance, a renamed agent or a second Reddit agent would
 * all pass those and still be a Reddit reply.
 *
 * Over-matching is the safe direction and is the deliberate trade — but the trade
 * is NOT the cheap one this note used to quote ("costs a staff member one
 * asset-type edit"). THERE IS NO ASSET-TYPE EDIT ANYWHERE IN THE PRODUCT.
 * `updateAssetAction` names only content, title and status, and builds its patch
 * field by field so nothing else can reach the write; and no `updateAsset` call in
 * the tree passes a `type` — platforms-publishable.test.ts pins both, reporting
 * every payload whose keys are not visible at the call, with one it can pin only
 * by inspection rather than by type (`...schedule`, and the residual is written
 * down there). Nor is there a per-asset delete — assets go only with their whole
 * client, through `deleteClientCascade`.
 *
 * So an over-match is PERMANENT for the deliverable it catches: an agent whose
 * name merely mentions Reddit produces a slot-less library note, that note stays
 * a note, and the only route back to a schedulable post is a fresh run whose
 * identity does not say Reddit — or posting it by hand from the note's text,
 * which is what a draft-only deliverable expects anyway. That unrecoverability is
 * why the MCP upload path no longer feeds this regex the CALLER'S OWN title
 * (lib/mcp/tools.ts): a fence with no undo may only be asked of the run's
 * identity, never of free text somebody typed. Under-matching cross-posts one
 * thread's reply to four strangers' feeds, which is the product rule itself
 * broken; this is the cost we choose over that one.
 */
const REDDIT_IDENTITY = /reddit/i;

/**
 * Whether this deliverable is draft-only — asked of the DELIVERABLE, not of the
 * route it arrived on, so it holds for a path nobody has written yet.
 *
 * TWO INDEPENDENT ASKS, because either alone has a hole:
 *
 *  1. THE TEXT. `parseRedditDrafts` is the same predicate every Reddit surface
 *     already uses to recognise a batch (the asset card, the detail modal, the
 *     agent detail page), and it is exact: the batch carries its own heading.
 *     Blind when the text is absent — an image-only run, or a run whose primary
 *     text failed to re-host.
 *  2. THE IDENTITY. The strings that travel with the delivery: the agent's name,
 *     the job title, the platform hint, the agent key when one is echoed. Loose,
 *     so it survives a rename of the doc but not a rename away from the word.
 *
 * Fails closed in the sense that matters: EITHER saying yes is enough.
 */
export function isDraftOnlyDeliverable(deliverable: {
  content?: string | null;
  identity?: readonly (string | null | undefined)[];
}): boolean {
  if (deliverable.content && parseRedditDrafts(deliverable.content) !== null) return true;
  return (deliverable.identity ?? []).some(
    (s) => typeof s === "string" && REDDIT_IDENTITY.test(s),
  );
}

/**
 * The asset type for a delivered run: the task type's default, the submitter's
 * whitelisted hint when there is one — and then the draft-only fence over
 * whatever those produced.
 *
 * The fence is applied to the RESULT rather than to the hint, and unconditionally
 * rather than only for `custom` runs. Keyed to the answer ("is this deliverable
 * about to become publishable?") instead of to the argument that happened to
 * cause it, so a future third source of the type is fenced without being listed
 * here.
 */
export function deliverableAssetType(run: {
  /** `WireTaskType`, so a draining v1 run still resolves its real asset type. */
  taskType: WireTaskType;
  /** `metadata.asset_type` as it arrived, unvalidated. */
  hint?: string | null;
  /** The deliverable's primary text, when the run produced one. */
  content?: string | null;
  /** Strings that name the producing agent — see isDraftOnlyDeliverable. */
  identity?: readonly (string | null | undefined)[];
}): AssetType {
  const hinted = run.hint as AssetType | undefined;
  const base =
    run.taskType === "custom" && hinted && VALID_HINT_TYPES.has(hinted)
      ? hinted
      : (TASK_TYPE_ASSET_TYPE[run.taskType] ?? DRAFT_ONLY_ASSET_TYPE);

  if (hasPublishTargets(base) && isDraftOnlyDeliverable(run)) return DRAFT_ONLY_ASSET_TYPE;
  return base;
}

/**
 * THE THIRD RUNTIME SOURCE OF AN ASSET TYPE: a lab-repo import.
 *
 * Here rather than beside `guessAssetType` because this module is the one home
 * for the draft-only fence, and until this existed the module's own claim to be
 * "the copy every runtime-derived type goes through" was false — the lab import
 * was the third path and only two went through it.
 *
 * `guessAssetType` reads the lab-repo FOLDER NAME, which is a location rather
 * than the deliverable (it does check Reddit before its social bucket, so a
 * folder called `reddit-agent` already lands draft-only). What it cannot see is a
 * Reddit batch exported under any other folder name — `social-replies`, say —
 * which was typed `social_post`, and `PUBLISHABLE_PLATFORMS` then offers a reply
 * written for one thread to twitter, linkedin and tiktok.
 *
 * So the folder's answer is the base and the fence is applied over it with BOTH
 * halves: the item's own text, and the folder name as identity. Same shape as
 * `deliverableAssetType` above — fence the RESULT, not the argument.
 *
 * Takes the folder-derived type as a PARAMETER rather than calling
 * `guessAssetType` itself: that helper lives in the lab-outputs module, which
 * this one must not depend on (the fence is imported by client components).
 */
export function labImportAssetType(
  folderAssetType: AssetType,
  agentFolder: string,
  content?: string | null,
): AssetType {
  if (!hasPublishTargets(folderAssetType)) return folderAssetType;
  return isDraftOnlyDeliverable({ content, identity: [agentFolder] })
    ? DRAFT_ONLY_ASSET_TYPE
    : folderAssetType;
}
