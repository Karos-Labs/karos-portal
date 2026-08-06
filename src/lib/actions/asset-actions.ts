"use server";

import { revalidatePath } from "next/cache";
import {
  getAsset,
  getJob,
  listAssets,
  updateAsset,
  updateJob,
  clearAssetSchedule,
  clearAssetPublish,
  deleteAsset,
  markAssetPublished,
  listClientIntegrations,
  markIntegrationExpired,
  claimAssetForPublish,
  releaseAssetPublishClaim,
  reconcileAssetPublished,
  getClientSettings,
  PUBLISH_CLAIM_TTL_MS,
} from "@/lib/data";
import { getCurrentUser } from "@/lib/auth";
import { requireStaff } from "./_shared";
import {
  TokenExpiredError,
  inferPlatform,
  publishAssetToPlatform,
} from "@/lib/integrations/publishers";
import { PUBLISHABLE_PLATFORMS } from "@/lib/integrations/platforms";
import { integrationIsUsable } from "@/lib/integration-status";
import { recommendPublishTimeWithDensity, sameLocalDay } from "@/lib/scheduling";
import { chainFamilyFor } from "@/lib/post-chain";
import { type MarkPostedBlock, markPostedBlock } from "@/lib/mark-posted";
import {
  type AssetPublishBlock,
  assetPublishBlock,
  isLaunchDeliverable,
  isTestRunAsset,
} from "@/lib/asset-visibility";
import { syncSlotPostedForAsset } from "@/lib/client-agent-slots";
import { addXDraftFeedbackAction } from "@/lib/actions/x-agent-actions";
import type { Asset, PublishMode } from "@/lib/types";

/** Load the asset and verify the caller may act on it. Shared guard for the actions below. */
async function requireAssetAccess(id: string): Promise<Asset> {
  const user = await getCurrentUser();
  if (!user || user.disabled) throw new Error("Unauthorized");
  const asset = await getAsset(id);
  if (!asset) throw new Error("Asset not found");
  if (user.role === "CLIENT_USER" && asset.clientId !== user.clientId) throw new Error("Forbidden");
  return asset;
}

export async function updateAssetAction(id: string, patch: { content?: string; title?: string; status?: "draft" | "approved" | "delivered" | "published" }) {
  const user = await getCurrentUser();
  if (!user || user.disabled) throw new Error("Unauthorized");
  const asset = await getAsset(id);
  if (!asset) throw new Error("Asset not found");
  if (user.role === "CLIENT_USER") {
    // Own assets only — and never status: approval is what publishes a draft
    // to the client's Library, so it stays a staff-only transition.
    if (asset.clientId !== user.clientId) throw new Error("Forbidden");
    if (patch.status !== undefined) throw new Error("Forbidden");
    // Defense in depth: a launch deliverable or Control Room Test Run is
    // staff-only working material by construction (asset-visibility.ts) — a
    // client must never be able to read-then-overwrite one even if some other
    // path (e.g. a chat tool) ever hands them the id.
    if (isLaunchDeliverable(asset) || isTestRunAsset(asset)) throw new Error("Forbidden");
  }
  // BUILT FIELD BY FIELD, NEVER SPREAD — and `type` is why.
  //
  // A server action's parameter list is a COMPILE-TIME claim about this repo's
  // own callers, not a check on the wire: the arguments arrive as a POST body
  // and nothing validates them at runtime. So `updateAsset(id, { ...patch })`
  // wrote whatever the caller sent — data.ts merges the object as given — and
  // the `{ content?, title?, status? }` signature stopped none of it. The field
  // that mattered is `type`: PUBLISHABLE_PLATFORMS is keyed by it, so re-typing
  // a Reddit reply `social_post` AFTER creation puts it on every publish surface
  // and inside the auto-publish cron's reach, which is the hard product rule
  // (Reddit is draft-only) broken from the one direction its fence cannot see —
  // `deliverableAssetType` decides the type once, at creation, and nothing
  // re-asks the question on a write. Nor is there an un-fencing to undo it with:
  // no asset-type edit exists anywhere in the product.
  //
  // Picking each named field one at a time is what makes "an asset's type never
  // changes after creation" TRUE rather than asserted, and widening the
  // signature the only way to widen what can be written. The scan in
  // platforms-publishable.test.ts fails on any patch reaching `updateAsset`
  // whose keys it cannot read at the call — a spread of this parameter included.
  await updateAsset(id, {
    ...(patch.content !== undefined ? { content: patch.content } : {}),
    ...(patch.title !== undefined ? { title: patch.title } : {}),
    ...(patch.status !== undefined ? { status: patch.status } : {}),
    updatedAt: Date.now(),
  });
  revalidatePath("/assets");
  revalidatePath(`/clients/${asset.clientId}`);
}

/**
 * Clear a Control Room Test Run's `meta.testRun` flag and let it enter the
 * normal draft pipeline — the one path a test asset can reach a client
 * through, and only by explicit staff action. Reflows the chain once
 * afterward (mirrors the webhook's own reflow-on-creation, which test assets
 * skip) so it picks up a real chain date like any other draft would have.
 */
export async function promoteTestAssetAction(id: string): Promise<{ error?: string }> {
  await requireStaff();
  const asset = await getAsset(id);
  if (!asset) return { error: "Asset not found" };
  if (asset.meta?.testRun !== true) return { error: "This asset isn't a test run." };
  await updateAsset(id, { meta: { ...asset.meta, testRun: false }, updatedAt: Date.now() });
  const { reflowClientChain } = await import("@/lib/chain");
  await reflowClientChain(asset.clientId).catch(() => {});
  revalidatePath(`/clients/${asset.clientId}/agents`);
  revalidatePath("/calendar");
  return {};
}

/**
 * Dismiss a Control Room Test Run from the "needs review" view. Non-destructive
 * — this codebase never hard-deletes assets (aging-out elsewhere is a VIEW
 * filter, not a delete; see asset-visibility.ts) — so this only flags the
 * asset as reviewed via `meta.testDismissed` rather than adding this
 * codebase's first delete path for a test artifact nobody else can see anyway.
 */
export async function dismissTestAssetAction(id: string): Promise<{ error?: string }> {
  await requireStaff();
  const asset = await getAsset(id);
  if (!asset) return { error: "Asset not found" };
  if (asset.meta?.testRun !== true) return { error: "This asset isn't a test run." };
  await updateAsset(id, { meta: { ...asset.meta, testDismissed: true }, updatedAt: Date.now() });
  revalidatePath(`/clients/${asset.clientId}/agents`);
  return {};
}

/**
 * Put an asset on the content calendar with a publish time.
 *
 * mode selects the publishing tier:
 *   auto        — the publish cron posts it at scheduledAt (platform required)
 *   manual      — calendar item the user pushes via "Publish Now"
 *   placeholder — calendar-only roadmap entry; never touches platform APIs
 *
 * Defaults preserve pre-tier behavior: platform given ⇒ auto, none ⇒ placeholder.
 */
export async function scheduleAssetAction(
  id: string,
  scheduledAt: number,
  platform?: string,
  mode?: PublishMode,
): Promise<void> {
  await requireStaff();
  const asset = await getAsset(id);
  if (!asset) throw new Error("Asset not found");
  // Same reasoning as approveAssetAction: this would hand a Test Run a real
  // scheduledAt, which puts it on the CLIENT'S calendar (postKind() has no
  // way to tell it apart from a real scheduled post once dated) — strictly
  // worse than the archive leak, since it never even needs "approved" first.
  if (isTestRunAsset(asset)) {
    throw new Error("This is a Test Run draft. Use Promote (Control Room → Outputs) instead of scheduling it directly.");
  }
  const publishMode: PublishMode = mode ?? (platform ? "auto" : "placeholder");
  if (publishMode === "auto" && !platform) {
    throw new Error("Auto-publish requires a target platform");
  }
  await updateAsset(id, {
    status: "scheduled",
    scheduledAt,
    publishMode,
    ...(platform ? { scheduledPlatform: platform } : {}),
    updatedAt: Date.now(),
  });
  revalidatePath("/assets");
  revalidatePath(`/clients/${asset.clientId}`);
}

/**
 * Move an already-approved/scheduled post's publish date, from the CLIENT'S
 * own side — the Copilot chat's `/reschedule-post` command.
 *
 * Deliberately narrower than `scheduleAssetAction`: it only ever touches
 * `scheduledAt`. Status, `publishMode` and `scheduledPlatform` are untouched,
 * because those are the staff QC gate (`approveAssetAction`) and the
 * auto-publish integration checks it runs — a client moving a date is not a
 * client re-approving content or re-deciding how it goes out, and letting this
 * action brush either would reopen a gate that exists specifically so AI
 * content is never scheduled without a human having looked at it first.
 *
 * Refuses on:
 *  - anything but `approved`/`scheduled` (a draft/review asset was never
 *    blessed onto the calendar, so there is nothing here to "move" yet);
 *  - a time in the past;
 *  - a claimed-for-publish window (mirrors the race guard `markAssetPostedAction`
 *    already uses — moving the date of a post the cron may be mid-publishing
 *    right now would not stop that publish, only make the record wrong);
 *  - a same-day collision with another of this client's approved/scheduled
 *    assets in the same content-chain family (`chainFamilyFor`) — the
 *    one-post-per-day-per-family invariant `post-chain.ts` enforces at
 *    generation time would otherwise silently break the moment a client
 *    could pick an arbitrary new day by hand.
 */
export async function clientRescheduleAssetAction(
  id: string,
  newScheduledAt: number,
): Promise<{ ok: true } | { ok: false; error: string }> {
  const asset = await requireAssetAccess(id);

  // Same defense-in-depth as updateAssetAction: staff-only working material
  // (a launch deliverable, a Control Room Test Run) is never a client's to
  // move, even if it somehow carries an approved/scheduled status.
  if (isLaunchDeliverable(asset) || isTestRunAsset(asset)) {
    return { ok: false, error: "This output isn't available to reschedule." };
  }

  if (asset.status !== "approved" && asset.status !== "scheduled") {
    return {
      ok: false,
      error: "Only an already-approved or scheduled post can be moved. This one is still in review.",
    };
  }
  if (newScheduledAt <= Date.now()) {
    return { ok: false, error: "Pick a time in the future." };
  }
  if (asset.publishClaimedAt != null && Date.now() - asset.publishClaimedAt < PUBLISH_CLAIM_TTL_MS) {
    return { ok: false, error: "This post is being published right now. Give it a moment, then try again." };
  }

  const family = chainFamilyFor(asset.type);
  if (family) {
    const siblings = await listAssets({ clientId: asset.clientId });
    const collision = siblings.some(
      (s) =>
        s.id !== asset.id &&
        (s.status === "approved" || s.status === "scheduled") &&
        chainFamilyFor(s.type) === family &&
        s.scheduledAt != null &&
        sameLocalDay(s.scheduledAt, newScheduledAt),
    );
    if (collision) {
      return {
        ok: false,
        error: "That day already has another post scheduled in this content family. Pick a different day.",
      };
    }
  }

  await updateAsset(id, { scheduledAt: newScheduledAt, updatedAt: Date.now() });
  revalidatePath("/assets");
  revalidatePath(`/clients/${asset.clientId}`);
  return { ok: true };
}

/** The asset's target platform preference: an explicit schedule wins, else the first
 *  agent channel compatible with the asset type. */
function preferredPlatform(asset: Asset): string | undefined {
  if (asset.scheduledPlatform) return asset.scheduledPlatform;
  const compatible = PUBLISHABLE_PLATFORMS[asset.type] ?? [];
  return (asset.channels ?? []).find((c) => compatible.includes(c));
}

/**
 * AI-recommended optimal publish slot for a draft, aware of the client's current
 * calendar density and past scheduling. Reads the client's already-booked
 * publications and returns a slot the user can accept or override in the approve
 * flow. Returns null only when the asset type has no scheduling dimension (e.g. note).
 */
export async function recommendAssetScheduleAction(
  id: string,
): Promise<{ at: number; reason: string } | null> {
  const asset = await requireAssetAccess(id);
  const all = await listAssets({ clientId: asset.clientId });
  const scheduled = all
    .filter((a) => a.id !== id && a.scheduledAt != null)
    .map((a) => a.scheduledAt as number);
  return recommendPublishTimeWithDensity({
    assetType: asset.type,
    platform: preferredPlatform(asset),
    scheduled,
  });
}

/**
 * Approve a draft. When a slot is supplied the asset is placed on the content
 * calendar at that time (status → approved, publishMode selected pre-approval):
 *   auto        — cron auto-posts at scheduledAt (requires an active integration)
 *   manual      — on the calendar; the user pushes it live with Publish Now
 *   placeholder — calendar-only roadmap entry
 * Non-schedulable assets (no slot) simply transition to approved.
 */
export async function approveAssetAction(
  id: string,
  opts?: { scheduledAt?: number; platform?: string; publishMode?: PublishMode },
): Promise<void> {
  // Approval is a staff-only gate: requireAssetAccess alone would let a client
  // approve their own asset (and via opts.platform arm auto-publish).
  await requireStaff();
  const asset = await requireAssetAccess(id);
  // A Test Run has its own graduation path (promoteTestAssetAction, which also
  // reflows the chain) — approving it here directly would flip it out of
  // "draft" without clearing meta.testRun, defeating the whole point of the
  // flag. The plain review queue shows no TEST badge, so this is the gate
  // that actually stops the mis-click rather than relying on staff noticing.
  if (isTestRunAsset(asset)) {
    throw new Error("This is a Test Run draft. Use Promote (Control Room → Outputs) instead of Approve.");
  }
  // `Omit<…, "type">`, and named for this one action, because this object is
  // handed to `updateAsset` as a whole: the compiler is what refuses a `type` on
  // it (see updateAssetAction's note — re-typing an asset defeats the
  // creation-time draft-only fence), and the distinctive name is what stops the
  // pin that exempts THIS payload in platforms-publishable.test.ts from
  // exempting some other function's `patch` as well.
  const approvalPatch: Omit<Partial<Asset>, "type"> = { status: "approved", updatedAt: Date.now() };

  if (opts?.scheduledAt != null) {
    const publishMode: PublishMode = opts.publishMode ?? (opts.platform ? "auto" : "placeholder");
    if (publishMode === "auto") {
      if (!opts.platform) throw new Error("Auto-publish requires a target platform");
      // Enforce: auto-publish only when the client opted-in and the required
      // integration is connected and active.
      const settings = await getClientSettings(asset.clientId);
      if (!settings?.autoScheduleEnabled) {
        throw new Error(
          `Client has not enabled auto-scheduling - approve as manual/placeholder or enable in Client Settings`,
        );
      }
      const integrations = await listClientIntegrations(asset.clientId);
      const active = integrations.find(
        (i) => i.platform === opts.platform && integrationIsUsable(i),
      );
      if (!active) {
        throw new Error(
          `Connect an active ${opts.platform} integration to auto-publish - or approve as manual/placeholder`,
        );
      }
    }
    approvalPatch.scheduledAt = opts.scheduledAt;
    approvalPatch.publishMode = publishMode;
    if (opts.platform) approvalPatch.scheduledPlatform = opts.platform;
  } else {
    // No explicit opts scheduledAt supplied — attempt to preserve any candidate
    // scheduling (imported scheduledAt or agent recommendedAt) and, if an
    // active integration exists for the preferred platform, mark it auto.
    const candidateAt = asset.scheduledAt ?? (asset as unknown as { recommendedAt?: number }).recommendedAt ?? null;
    if (candidateAt != null) {
      // Decide platform preference and whether an active integration exists
      const platform = preferredPlatform(asset);
      const settings = await getClientSettings(asset.clientId);
      const allowAuto = settings?.autoScheduleEnabled === true;
      const integrations = await listClientIntegrations(asset.clientId);
      const active =
        allowAuto && platform
          ? integrations.find((i) => i.platform === platform && integrationIsUsable(i))
          : undefined;

      approvalPatch.scheduledAt = candidateAt;
      if (active) {
        approvalPatch.publishMode = "auto";
        if (platform) approvalPatch.scheduledPlatform = platform;
      } else {
        // No usable integration or client opted out — keep safety: land on the
        // calendar but require an explicit Publish Now (manual) so nothing posts
        // without a connection or an opt-in.
        approvalPatch.publishMode = "manual";
        if (platform) approvalPatch.scheduledPlatform = platform;
      }
    } else if (
      asset.scheduledAt != null &&
      asset.publishMode !== "manual" &&
      asset.publishMode !== "placeholder"
    ) {
      // Cron-safety: approving a chain-dated draft without any candidate slot
      // must never leave it cron-eligible — force manual.
      approvalPatch.publishMode = "manual";
    }
  }

  await updateAsset(id, approvalPatch);
  await closeProducingJobIfReviewed(asset);
  revalidatePath("/assets");
  revalidatePath(`/clients/${asset.clientId}`);
  revalidatePath(`/clients/${asset.clientId}/agents`);
}

/**
 * Move a run out of "review" once every deliverable it produced has been
 * approved.
 *
 * Approving a deliverable used to write the deliverable and nothing else, so a
 * job sat on "review" forever — and the amber "N ready" pill on the agent card,
 * which counts runs in review, could never go down no matter how many times the
 * drafts were reviewed. It also left "approved"/"delivered" unreachable states
 * on the run badge. Best-effort: a failure here must not undo an approval that
 * has already been written, so it is logged, not thrown.
 */
async function closeProducingJobIfReviewed(asset: Asset): Promise<void> {
  if (!asset.jobId) return;
  try {
    const job = await getJob(asset.jobId);
    if (!job || job.status !== "review" || job.assetIds.length === 0) return;
    const siblings = await Promise.all(
      job.assetIds.map((assetId) => (assetId === asset.id ? null : getAsset(assetId))),
    );
    // The asset just written is approved by construction; every other one must
    // already be past "draft" (approved, scheduled, delivered, or published).
    // A missing sibling — deleted since the run — cannot hold the run open.
    const outstanding = siblings.some((sibling) => sibling != null && sibling.status === "draft");
    if (outstanding) return;
    await updateJob(job.id, { status: "approved" });
  } catch (error) {
    console.error("[approveAsset] could not close producing job", asset.jobId, error);
  }
}

/**
 * What we tell the user when the attestation rule refuses, keyed by reason so
 * the message cannot drift from the rule (same shape as PUBLISH_REFUSAL below).
 * Rendered verbatim next to the button: sentence case, no internal vocabulary,
 * each one names the way out.
 *
 * The control hides itself for every one of these, so a person only reaches
 * this text from a stale page or a direct call — which is exactly why it has to
 * read like something written for them.
 */
const MARK_POSTED_REFUSAL: Record<MarkPostedBlock, string> = {
  published: "Already marked as posted",
  placeholder: "This is a placeholder. Put it on the calendar before marking it posted",
  unapproved: "Only an approved, scheduled, or delivered post can be marked as posted",
  locked: "This post is scheduled for a later day. You can mark it posted on the day it goes out.",
};

/**
 * "I posted this myself" — record that an asset went live by hand.
 *
 * Every other route to "published" runs through a platform integration: the
 * auto-publish cron, publishAssetNowAction, and the analytics reconciler each
 * require a connected account, and shouldReconcilePublished deliberately
 * excludes manual-mode assets. So a client who copies the caption and posts
 * from their phone — no integration anywhere in the loop — had NO path to
 * "published" at all, and their assets sat on approved/scheduled forever with
 * the portal unable to say what was live and what was still waiting.
 *
 * This is the human-in-the-loop half of that transition, so unlike the other
 * publish actions it is deliberately NOT staff-only: the person who did the
 * posting is usually the client, and requireAssetAccess already confines them
 * to their own client's assets. It touches no platform API — it only records
 * what the user is telling us already happened.
 */
export async function markAssetPostedAction(
  id: string,
): Promise<{ ok: true } | { ok: false; error: string }> {
  const asset = await requireAssetAccess(id);
  // THE rule — `markPostedBlock`, the same body the control asks before it
  // renders. Every clause of it is load-bearing on this side of the wire, and a
  // hidden button is not a guard: a server action is a public endpoint.
  //
  //  · status: without it a CLIENT_USER could force one of their own DRAFTS
  //    straight to published — self-approving unreviewed work and completing
  //    the parent staff task with it — since force skips
  //    shouldReconcilePublished, which is what would otherwise reject a draft.
  //    (Compare updateAssetAction and approveAssetAction, which keep every
  //    other status transition staff-only for exactly this reason.)
  //  · locked/future-dated: without it a client could attest their way through
  //    the whole pre-generated batch — one click per future day — and each flip
  //    to published ends redactLockedAsset's redaction, revealing title,
  //    content and images ahead of time (churn rule A3/A4).
  const block = markPostedBlock(asset, Date.now());
  if (block !== null) return { ok: false, error: MARK_POSTED_REFUSAL[block] };
  // Don't race an in-flight push: the auto-cron may be mid-publish under a
  // claim right now, and flipping status to published here wouldn't stop it —
  // we'd attest "already posted by hand" AND post again for real.
  if (asset.publishClaimedAt != null && Date.now() - asset.publishClaimedAt < PUBLISH_CLAIM_TTL_MS) {
    return { ok: false, error: "This post is being published right now. Give it a moment." };
  }

  const { changed } = await reconcileAssetPublished(id, Date.now(), null, { force: true });
  if (!changed) return { ok: false, error: "Already marked as posted" };

  // The slot this asset fulfils records that its day happened (§3). Derived,
  // out-of-band and best-effort: the asset is live either way, and a slot that
  // misses the stamp is re-derived on the next pass.
  await syncSlotPostedForAsset({ clientId: asset.clientId, assetId: id }).catch((e) =>
    console.error("[assets] slot posted sync failed:", e),
  );

  // §4.5c — the chosen option's own learning-log row. "Picked" and "actually
  // posted" are different facts: the pick wrote the losers' rows immediately,
  // but the winner only earns a `posted` row when the client says they posted
  // it. Recording the pick as posted would teach the agent that everything it
  // drafts goes out. Best-effort for the same reason as above.
  await recordPostedOptionFeedback(asset).catch((e) =>
    console.error("[assets] option feedback failed:", e),
  );

  revalidatePath("/assets");
  revalidatePath(`/clients/${asset.clientId}`);
  return { ok: true };
}

/** Revert a scheduled asset back to draft and clear its schedule. */
export async function unscheduleAssetAction(id: string): Promise<void> {
  await requireStaff();
  const asset = await getAsset(id);
  if (!asset) throw new Error("Asset not found");
  await clearAssetSchedule(id);
  revalidatePath("/assets");
  revalidatePath(`/clients/${asset.clientId}`);
}

/**
 * Revert a published post back to draft — unscheduleAssetAction's
 * counterpart, one status further back. Staff-only, same gate as
 * publishAssetNowAction: this is a decision about a client's live-looking
 * post, not a client's to make. Purely an internal state change — no platform
 * integration exposes a way to un-post through us, so the post itself stays
 * live wherever it was actually published; this only stops Karos calling it
 * published and clears the schedule so it can be reworked and pushed again
 * from scratch.
 */
export async function unpublishAssetAction(
  id: string,
): Promise<{ ok: true } | { ok: false; error: string }> {
  await requireStaff();
  const asset = await getAsset(id);
  if (!asset) return { ok: false, error: "Asset not found" };
  if (asset.status !== "published") {
    return { ok: false, error: "Only a published post can be unpublished" };
  }
  await clearAssetPublish(id);
  revalidatePath("/assets");
  revalidatePath("/calendar");
  revalidatePath(`/clients/${asset.clientId}`);
  return { ok: true };
}

/**
 * Permanently delete a post's record. Staff-only, same gate as publishing it
 * in the first place. Karos otherwise never hard-deletes an asset (ageing out
 * of the client archive is a VIEW filter — see asset-visibility.ts); this is
 * the one exception, for a mistaken or unwanted post someone wants gone from
 * the workspace entirely. Removes only Karos's own record: no platform
 * integration exposes a way to remove an already-live post, so this never
 * reaches back to what's actually posted on LinkedIn/X/etc. — only what Karos
 * still tracks about it.
 */
export async function deleteAssetAction(
  id: string,
): Promise<{ ok: true } | { ok: false; error: string }> {
  await requireStaff();
  const asset = await getAsset(id);
  if (!asset) return { ok: true }; // already gone
  await deleteAsset(id);
  revalidatePath("/assets");
  revalidatePath("/calendar");
  revalidatePath(`/clients/${asset.clientId}`);
  return { ok: true };
}

/**
 * What we tell the user when the shared publish rule refuses. Rendered verbatim
 * next to the button, so: sentence case, no internal vocabulary, and each one
 * names the way out. Keyed by reason so the message can't drift from the rule.
 */
const PUBLISH_REFUSAL: Record<AssetPublishBlock, string> = {
  published: "Already published",
  placeholder: "This is a calendar-only placeholder. Karos never posts it.",
  unapproved: "Only an approved, scheduled, or delivered post can be published. Approve it first.",
};

/**
 * Manual push (tier "manual"): publish an asset to a platform right now through
 * our API integration, regardless of the auto-publish toggle or any schedule.
 * Returns a result object instead of throwing so the card can render the error inline.
 *
 * THE gate. This is the only control in the portal that posts to a client's live
 * social account, and it used to refuse nothing but an already-published asset —
 * so a placeholder ("Karos never posts it") and an unapproved draft both went
 * out for real if anything called it, and two of the three surfaces offering the
 * button did exactly that. Eligibility is now `assetPublishBlock`, the same rule
 * the card and the detail modal ask, because a hidden button is not a guard: a
 * server action is a public endpoint (see markAssetPostedAction, which learned
 * this for the far cheaper by-hand attestation).
 */
export async function publishAssetNowAction(
  id: string,
  platform?: string,
): Promise<{ ok: true; platform: string } | { ok: false; error: string }> {
  await requireStaff();
  const asset = await getAsset(id);
  if (!asset) throw new Error("Asset not found");
  const block = assetPublishBlock(asset);
  if (block) return { ok: false, error: PUBLISH_REFUSAL[block] };

  const integrations = await listClientIntegrations(asset.clientId);
  const valid = integrations.filter((i) => integrationIsUsable(i));
  const target =
    platform ??
    asset.scheduledPlatform ??
    inferPlatform(asset.type, valid.map((i) => i.platform));

  if (!target) {
    return { ok: false, error: "No compatible platform connected. Connect one in the Integrations tab" };
  }
  const integration = valid.find((i) => i.platform === target);
  if (!integration) {
    return { ok: false, error: `No active ${target} integration. Connect or re-connect it first` };
  }

  // Atomically claim so a concurrent auto-cron tick (or a double-clicked button)
  // can't push this same asset in parallel and post it twice.
  const claimed = await claimAssetForPublish(id);
  if (!claimed) {
    return { ok: false, error: "This asset is already being published. Give it a moment." };
  }

  let publishResult: { postId: string | null };
  try {
    publishResult = await publishAssetToPlatform(target, integration, asset);
  } catch (e) {
    await releaseAssetPublishClaim(id).catch(() => {});
    // STORED RAW, ON PURPOSE, and this is the note that stops the next reader
    // sanitizing it here. `publishError` is the platform SDK's own exception and
    // it is the only thing that says which integration broke — staff read the
    // asset un-projected and need it. A client never does: both client asset
    // projections run it through `clientSafePublishError` (lib/asset-visibility)
    // before it can cross the RSC boundary, so the collapse happens where the
    // reader is known rather than where the string is written. Sanitizing at the
    // write would destroy the diagnostic for everyone and fix nothing.
    //
    // The returned copy is raw for the same reason and is safe for a different
    // one: this action is `requireStaff()`, so only an operator ever reads it.
    const message = e instanceof Error ? e.message : "Unknown error";
    if (e instanceof TokenExpiredError) {
      await markIntegrationExpired(asset.clientId, target).catch(() => {});
    }
    await updateAsset(id, { publishError: message, updatedAt: Date.now() }).catch(() => {});
    return { ok: false, error: message };
  }

  await markAssetPublished(id, publishResult.postId);
  // Keep the calendar truthful: a manual push without a prior schedule still
  // lands on today's date, and the platform is recorded for the event chip.
  await updateAsset(id, {
    ...(asset.scheduledAt ? {} : { scheduledAt: Date.now() }),
    scheduledPlatform: target,
    publishMode: asset.publishMode ?? "manual",
    updatedAt: Date.now(),
  });

  revalidatePath("/assets");
  revalidatePath(`/clients/${asset.clientId}`);
  return { ok: true, platform: target };
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
