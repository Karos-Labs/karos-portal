"use server";

import { revalidatePath } from "next/cache";

import { createAsset, getAsset } from "@/lib/data";
import {
  claimAgentSlotOptionPick,
  getAgentSlot,
  getClientAgent,
  updateAgentSlot,
} from "@/lib/data-client-agents";
import { resolveUmbrellaSchedule } from "@/lib/client-agent-slots";
import { clientAgentRunRefusal } from "@/lib/client-agent-gate";
import { addXDraftFeedbackAction } from "@/lib/actions/x-agent-actions";
import { parseXDrafts } from "@/lib/x-drafts";
import { notPickedReason, optionText, resolveOptions } from "@/lib/x-options";
import { OPTIONS_TEMPLATE_KEY, dateKeyInZone } from "@/lib/client-agents";
import { runtimeTimeZone } from "@/lib/run-cadence";
import { logActivity, requireClientAccess } from "./_shared";

/** A picked option's text may be edited, but not turned into an essay. */
const MAX_PICK_CHARS = 4_000;

/**
 * The client picks one of a day's three options (§4.5c).
 *
 * WHAT A PICK IS. It is not a run — nothing is generated, nothing is charged
 * (§6.1: "picking is feedback, not generation"). It is the client choosing
 * which already-drafted direction becomes their post for that day, optionally
 * editing it first.
 *
 * MATERIALIZATION is what makes everything downstream work unchanged. The
 * chosen option becomes its OWN asset — approved, manual-publish, dated to the
 * slot's day — so mark-as-posted, the posted archive, the calendar and
 * analytics all operate on a per-day asset exactly as they do for every other
 * post. The batch asset stays staff-side history. Without this, every one of
 * those surfaces would need a second code path for X.
 *
 * IDEMPOTENT PER SLOT, by CLAIM. A double-press, a retry after a flaky response
 * or two tabs must not mint two assets for one day — and a read-then-write
 * check cannot promise that, since both callers read "not picked yet" before
 * either writes. The winner is decided inside a transaction on the slot doc
 * (claimAgentSlotOptionPick), the same shape as claimExternalJobCompletion,
 * which exists for the identical single-delivery problem on jobs.
 *
 * THE NEGATIVE SIGNALS ARE WRITTEN AT PICK TIME, not asked for later. The
 * client already told us everything by choosing — the unchosen options are
 * rejected by implication, and a row per unchosen ref lands in the learning log
 * (x-agent-context serializes XDraftFeedback into every future X run) with no
 * further client effort. The chosen one's `posted` row comes later, from
 * mark-as-posted, because "picked" and "actually posted" are different facts
 * and conflating them would teach the agent that everything it drafts gets
 * posted.
 */
export async function pickAgentSlotOptionAction(input: {
  clientId: string;
  slotId: string;
  optionRef: string;
  /** Present when the client edited before confirming. */
  finalText?: string | null;
}): Promise<{ assetId?: string; error?: string }> {
  const user = await requireClientAccess(input.clientId);

  const slot = await getAgentSlot(input.slotId);
  if (!slot || slot.clientId !== input.clientId) return { error: "That day isn't on your plan." };
  if (slot.kind !== "options") return { error: "That day isn't a pick-one day." };
  if (slot.optionPick) return { error: "You've already chosen for that day." };
  if (!(slot.optionRefs ?? []).includes(input.optionRef)) {
    return { error: "That option isn't one of today's." };
  }

  const umbrella = await getClientAgent(slot.clientAgentId);
  if (!umbrella || umbrella.clientId !== input.clientId) {
    return { error: "That day isn't on your plan." };
  }

  const blocked = await clientAgentRunRefusal({
    user,
    clientId: input.clientId,
    customAgentId: umbrella.customAgentId,
  });
  if (blocked) return { error: blocked };

  // THE CHURN GATE, server-side (A3/A4). A future day's options must not be
  // pickable — offering them would confirm that tomorrow's posts already exist,
  // which is the one thing the whole slot model keeps indistinguishable. The
  // day boundary is the schedule's zone, not the container's (F108).
  const schedule = await resolveUmbrellaSchedule(umbrella);
  const zone = schedule?.timeZone ?? runtimeTimeZone();
  const todayKey = dateKeyInZone(Date.now(), zone);
  if (slot.dateKey > todayKey) return { error: "That day hasn't arrived yet." };

  // The batch the options were drawn from, still the slot's asset pre-pick.
  const batchAsset = slot.assetId ? await getAsset(slot.assetId) : null;
  if (!batchAsset) return { error: "Those options are no longer available." };
  const batch = parseXDrafts(batchAsset.content ?? "");
  if (!batch) return { error: "Those options are no longer available." };
  const options = resolveOptions(batch, slot.optionRefs ?? []);
  const chosen = options.find((o) => o.ref === input.optionRef);
  if (!chosen) return { error: "That option is no longer available." };

  const edited = typeof input.finalText === "string" && input.finalText.trim().length > 0;
  const original = optionText(chosen);
  const content = (edited ? (input.finalText as string) : original).trim().slice(0, MAX_PICK_CHARS);
  if (!content) return { error: "A post can't be empty." };

  const now = Date.now();

  // THE CLAIM (B6). The optionPick check above is a pre-flight courtesy that
  // gives a fast, friendly error; it is NOT the guard. Two tabs both read null
  // before either writes, and both would mint a post for the same day. The
  // winner is decided inside a transaction on the slot doc.
  //
  // The asset is created only after winning, and the failure modes are not
  // symmetric. Claim-then-crash costs ONE DAY: the slot reads as chosen with no
  // asset behind it, the client cannot re-pick, and un-sticking it needs a
  // direct edit to the slot doc — bad, but bounded, silent to everyone else,
  // and confined to a window of milliseconds. Asset-then-crash would leave a
  // real post the client never confirmed, duplicable on every retry. Given the
  // choice, lose the day rather than publish something nobody picked.
  const claimed = await claimAgentSlotOptionPick(slot.id, {
    optionRef: chosen.ref,
    ...(chosen.direction ? { direction: chosen.direction } : {}),
    pickedAt: now,
    pickedBy: user.uid,
    edited,
    // Captured here, at the one moment it's guaranteed correct — the batch
    // asset it came from can go stale or be re-imported later (§4.5c).
    originalText: original,
  });
  if (!claimed) return { error: "You've already chosen for that day." };

  // Dated to the slot's DAY, and never into the future: markAssetPostedAction
  // refuses an asset whose day has not arrived, so a materialized post the
  // client cannot then mark as posted would be a dead end. The pick already
  // proved the day has arrived, so "now" is the honest instant within it.
  const assetId = await createAsset({
    clientId: input.clientId,
    type: "social_post",
    title: `${chosen.direction} · ${slot.dateKey}`,
    content,
    status: "approved",
    publishMode: "manual",
    scheduledAt: now,
    channels: ["x"],
    templateKey: OPTIONS_TEMPLATE_KEY,
    templateName: "Daily post",
    meta: {
      clientAgentId: umbrella.id,
      slotId: slot.id,
      optionRef: chosen.ref,
      pickedFromAssetId: batchAsset.id,
      xAccountTitle: chosen.account,
      edited,
      // The drafted text before this pick's edit — carried here so mark-as-posted
      // (recordPostedOptionFeedback) can pass it into XDraftFeedback without
      // re-touching the slot doc or depending on the batch asset staying around.
      originalText: original,
    },
    createdBy: user.uid,
    createdAt: now,
    updatedAt: now,
  });

  // The slot now points at the materialized post, not the batch. The pick
  // itself was already written by the claim above — this only completes it.
  await updateAgentSlot(slot.id, { assetId, status: "generated" });

  // Negative signals for everything they did not choose — final at pick time.
  // Best-effort: a learning-log write must never cost the client their post.
  await Promise.all(
    options
      .filter((o) => o.ref !== chosen.ref)
      .map((o) =>
        addXDraftFeedbackAction({
          clientId: input.clientId,
          accountTitle: o.account,
          assetId: batchAsset.id,
          draftRef: o.ref,
          action: "not_posted",
          reason: notPickedReason(chosen.ref),
        }).catch(() => undefined),
      ),
  );

  void logActivity({
    clientId: input.clientId,
    timestamp: now,
    type: "CAMPAIGN_CREATED",
    title: `Picked ${chosen.direction} for ${slot.dateKey}`,
    actor: user.name,
    actorRole: user.role === "CLIENT_USER" ? "client" : "staff",
    metadata: { clientAgentId: umbrella.id, slotId: slot.id, optionRef: chosen.ref, edited },
  });

  revalidatePath(`/clients/${input.clientId}/agents`);
  return { assetId };
}
