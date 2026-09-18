import "server-only";

import { getClient } from "@/lib/data";
import { syncSlotPostedForAsset } from "@/lib/client-agent-slots";
import { learningTargetForAsset, recordLearningFeedback } from "@/lib/agent-engine/learning-feedback";
import { addXDraftFeedbackAction } from "@/lib/actions/x-agent-actions";
import type { Asset } from "@/lib/types";

/**
 * EVERYTHING THAT FOLLOWS A POST — one function, because it had four callers
 * and each of them did a different subset (04 Build plan B1, SCRUM-493).
 *
 * An asset becomes published through four doors, and only one of them was
 * doing the bookkeeping:
 *
 * | door | slot stamp | X option row | learning loop |
 * | --- | --- | --- | --- |
 * | `markAssetPostedAction` — the client says they posted it by hand | yes | yes | yes |
 * | `/api/publish` — the autopilot cron | **no** | **no** | **no** |
 * | `publishAssetNowAction` — staff push it now | **no** | **no** | **no** |
 * | `/api/analytics/sync` — we notice it went out on the platform | yes | **no** | **no** |
 *
 * ## What that cost, and it is not small
 *
 * **Every automatically published post taught the loop nothing.** The subject
 * row stayed `drafted` with no `posted_at` for the rest of its life, and the
 * feedback log never heard that the draft went out as written — so the one
 * signal the loop has that an agent got it RIGHT was recorded only when a human
 * happened to press the manual button. D35 offers autopilot on Instagram, X and
 * TikTok, which is to say on the three platforms the loop most needs to learn.
 *
 * A "posted" row is not bookkeeping. `feedbackForPrompt` puts the last N
 * feedback rows in front of the next draft, so a log made only of skips and
 * edits tells the next run that everything it writes gets changed or dropped.
 *
 * ## Why one function rather than three more call sites
 *
 * Because that is how it got this way. Each of the three things below was added
 * to the door its author was standing in front of, and nothing made the other
 * three doors grow it too. A single `afterAssetPosted` is the thing a fifth
 * door has to call, and `asset-posted.test.ts` asserts that every door does.
 *
 * ## Best-effort throughout, one catch each
 *
 * The post is already live by the time any of this runs — it is out on the
 * platform and cannot be taken back by a failed write here. So a control plane
 * that is down, a slot that cannot be stamped or an option row that will not
 * write must not fail the publish, and must not stop the other two either,
 * which is why each limb carries its own catch rather than sharing one.
 */
export async function afterAssetPosted(asset: Asset, opts?: { actor?: string }): Promise<void> {
  // The slot this asset fulfils records that its day happened. Derived and
  // out-of-band: a slot that misses the stamp is re-derived on the next pass.
  await syncSlotPostedForAsset({ clientId: asset.clientId, assetId: asset.id }).catch((e) =>
    console.error("[asset-posted] slot posted sync failed:", e),
  );

  await recordPostedOptionFeedback(asset).catch((e) => console.error("[asset-posted] option feedback failed:", e));

  await recordPostedToLearning(asset, opts).catch((e) => console.error("[asset-posted] learning feedback failed:", e));
}

/**
 * Record that a picked X option was actually posted (§4.5c).
 *
 * Only applies to assets materialized by `pickAgentSlotOptionAction` — they
 * carry the option ref, the account and the batch they came from in `meta`.
 * Anything else returns silently.
 *
 * `posted_with_edits` carries the final text, which is the most valuable row in
 * the whole log: it is the client showing, not telling, exactly how the agent's
 * draft fell short. Edit detection is the flag stamped at pick time rather than
 * a re-comparison here. `originalText` (also stamped at pick time, into
 * `meta.originalText` — see pickAgentSlotOptionAction) rides along so the row
 * carries a real before/after diff instead of depending on the batch asset,
 * which can go stale or be re-imported, to still hold the original later.
 */
async function recordPostedOptionFeedback(asset: Asset): Promise<void> {
  const meta = asset.meta ?? {};
  const draftRef = typeof meta.optionRef === "string" ? meta.optionRef : null;
  const accountTitle = typeof meta.xAccountTitle === "string" ? meta.xAccountTitle : null;
  if (!draftRef || !accountTitle) return;

  const edited = meta.edited === true;
  const originalText = typeof meta.originalText === "string" ? meta.originalText : undefined;
  await addXDraftFeedbackAction({
    clientId: asset.clientId,
    accountTitle,
    ...(typeof meta.pickedFromAssetId === "string" ? { assetId: meta.pickedFromAssetId } : {}),
    draftRef,
    action: edited ? "posted_with_edits" : "posted",
    ...(edited ? { finalText: asset.content, ...(originalText ? { originalText } : {}) } : {}),
  });
}

/**
 * C7 §2.3 — the call that makes a post mean something to the agent, and the
 * one all three automatic doors were missing.
 *
 * `posted_with_edits` whenever the agent's own text was stashed into
 * `meta.engineOriginalContent` by the first edit and the content has moved
 * since; `posted` otherwise. The middleware refuses half an edit pair, and
 * `postLearningFeedback` already downgrades rather than sending one — so a
 * missing original costs the pair, never the fact that it was posted.
 *
 * `recordLearningFeedback` keys the event on the asset id plus the action, and
 * the middleware dedupes on that, so an asset that is published by the cron and
 * then marked posted by hand appends ONE row rather than two.
 */
async function recordPostedToLearning(asset: Asset, opts?: { actor?: string }): Promise<void> {
  if (!learningTargetForAsset(asset)) return;
  const client = await getClient(asset.clientId);
  if (!client) return;

  const original = asset.meta?.engineOriginalContent;
  const edited = typeof original === "string" && original !== asset.content;
  await recordLearningFeedback(
    client,
    asset,
    edited
      ? {
          action: "posted_with_edits",
          originalText: original,
          finalText: asset.content,
          ...(opts?.actor ? { actor: opts.actor } : {}),
        }
      : { action: "posted", ...(opts?.actor ? { actor: opts.actor } : {}) },
  );
}
