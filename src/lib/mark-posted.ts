/**
 * WHY AN ASSET MAY NOT BE MARKED AS POSTED — the rule, once.
 *
 * "Mark as posted" is the client's own attestation that they published
 * something by hand (see `markAssetPostedAction`). Three paths reached that one
 * action carrying three different eligibility rules:
 *
 *   · the asset card (staff Assets list, job detail) tested status and
 *     placeholder and nothing else, so a FUTURE-DATED post showed an enabled
 *     button that failed on click with "This post is scheduled for a later
 *     day";
 *   · `MarkPostedRow` (detail modal, calendar day card) added `asset.locked`,
 *     which only a CLIENT's payload ever carries — `redactLockedAsset` stamps
 *     it, and staff are handed assets un-redacted — so it had the same dead
 *     button for staff, and declared itself "the ONE client-side transcription"
 *     of the rule besides;
 *   · the server action had the real rule, and still does.
 *
 * This module is the rule. It is a plain module — not the "use client"
 * component and not the "use server" action file — precisely so both sides can
 * import the same body.
 *
 * THE SERVER STILL CHECKS. A hidden button is not a guard: a server action is a
 * public endpoint, and `markAssetPostedAction` refuses on its own before it
 * writes anything (it also refuses a publish claim it is racing, which is a
 * fact about timing rather than about the asset and so is not here). What this
 * removes is three ANSWERS to one question, not the server's obligation to ask
 * it.
 *
 * It is deliberately the publish rule plus one clause, rather than a fourth
 * list of statuses: "which work has been signed off" is `assetPublishBlock`,
 * and the by-hand attestation refuses exactly the set the live push refuses,
 * for the same reasons in the same order.
 */

import type { Asset } from "@/lib/types";
import { type AssetPublishBlock, assetPublishBlock } from "@/lib/asset-visibility";
import { isAssetUnlockedForClient } from "@/lib/post-chain";

/**
 * `AssetPublishBlock`'s three reasons plus the one that is specific to an
 * attestation: a post whose day has not come cannot have been posted.
 */
export type MarkPostedBlock = AssetPublishBlock | "locked";

/** What the asset must carry for the rule to be answerable. */
export type MarkPostedSubject = Pick<
  Asset,
  "status" | "publishMode" | "scheduledAt" | "publishedAt" | "locked"
>;

/**
 * Why this asset may not be marked as posted, or null when it may.
 *
 * The "locked" clause has two halves and needs both:
 *
 *  · `locked` is the SERVER's own verdict, stamped by `redactLockedAsset` on
 *    the redacted placeholder a client receives for a future-dated post. It is
 *    never stored on a document, so it is only ever present on a payload the
 *    server has already decided to withhold — which makes it the strongest
 *    signal available in a browser, and free of any clock.
 *  · `isAssetUnlockedForClient` is the day comparison itself, and it is what
 *    answers for STAFF, who receive assets un-redacted and so never carry the
 *    flag.
 *
 * Neither subsumes the other, and asking both is the fail-closed order: any one
 * of them saying "not yet" is enough.
 *
 * `now` is the caller's clock. On the server that is the server's; in a client
 * component it is the browser's, and the day boundary each of them uses is its
 * own (see `startOfDayMs` in lib/scheduling for what that costs). Inside the
 * offset between the two the button can be offered a few hours before the
 * server will accept it — the server refuses and the message says why, which is
 * the direction that is merely annoying rather than wrong.
 */
export function markPostedBlock(a: MarkPostedSubject, now: number): MarkPostedBlock | null {
  const publish = assetPublishBlock(a);
  if (publish !== null) return publish;
  if (a.locked === true) return "locked";
  if (!isAssetUnlockedForClient(a, now)) return "locked";
  return null;
}

/** May this asset be marked as posted right now? THE predicate behind the control. */
export function canMarkAssetPosted(a: MarkPostedSubject, now: number): boolean {
  return markPostedBlock(a, now) === null;
}
