"use server";

import { revalidatePath } from "next/cache";
import {
  getAsset,
  listAssets,
  updateAsset,
  clearAssetSchedule,
  markAssetPublished,
  listClientIntegrations,
  markIntegrationExpired,
  claimAssetForPublish,
  releaseAssetPublishClaim,
} from "@/lib/data";
import { getCurrentUser } from "@/lib/auth";
import { requireStaff } from "./_shared";
import {
  TokenExpiredError,
  inferPlatform,
  publishAssetToPlatform,
} from "@/lib/integrations/publishers";
import { PUBLISHABLE_PLATFORMS } from "@/lib/integrations/platforms";
import { recommendPublishTimeWithDensity } from "@/lib/scheduling";
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
  }
  await updateAsset(id, { ...patch, updatedAt: Date.now() });
  revalidatePath("/assets");
  revalidatePath(`/clients/${asset.clientId}`);
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
  const patch: Partial<Asset> = { status: "approved", updatedAt: Date.now() };

  if (opts?.scheduledAt != null) {
    const publishMode: PublishMode = opts.publishMode ?? (opts.platform ? "auto" : "placeholder");
    if (publishMode === "auto") {
      if (!opts.platform) throw new Error("Auto-publish requires a target platform");
      // Enforce: auto-publish only when the required integration is connected and active.
      const integrations = await listClientIntegrations(asset.clientId);
      const active = integrations.find(
        (i) => i.platform === opts.platform && i.status !== "expired",
      );
      if (!active) {
        throw new Error(
          `Connect an active ${opts.platform} integration to auto-publish — or approve as manual/placeholder`,
        );
      }
    }
    patch.scheduledAt = opts.scheduledAt;
    patch.publishMode = publishMode;
    if (opts.platform) patch.scheduledPlatform = opts.platform;
  } else if (
    asset.scheduledAt != null &&
    asset.publishMode !== "manual" &&
    asset.publishMode !== "placeholder"
  ) {
    // Cron-safety: approving a chain-dated draft (it already carries a
    // scheduledAt) without an explicit slot must never leave it cron-eligible —
    // absent == legacy "auto", and a stale explicit "auto" left over from a
    // revert-to-draft is just as dangerous. Force "manual" so publishing
    // stays an explicit staff action.
    patch.publishMode = "manual";
  }

  await updateAsset(id, patch);
  revalidatePath("/assets");
  revalidatePath(`/clients/${asset.clientId}`);
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
 * Manual push (tier "manual"): publish an asset to a platform right now through
 * our API integration, regardless of the auto-publish toggle or any schedule.
 * Returns a result object instead of throwing so the card can render the error inline.
 */
export async function publishAssetNowAction(
  id: string,
  platform?: string,
): Promise<{ ok: true; platform: string } | { ok: false; error: string }> {
  await requireStaff();
  const asset = await getAsset(id);
  if (!asset) throw new Error("Asset not found");
  if (asset.status === "published") return { ok: false, error: "Already published" };

  const integrations = await listClientIntegrations(asset.clientId);
  const valid = integrations.filter((i) => i.status !== "expired");
  const target =
    platform ??
    asset.scheduledPlatform ??
    inferPlatform(asset.type, valid.map((i) => i.platform));

  if (!target) {
    return { ok: false, error: "No compatible platform connected — connect one in the Integrations tab" };
  }
  const integration = valid.find((i) => i.platform === target);
  if (!integration) {
    return { ok: false, error: `No active ${target} integration — connect or re-connect it first` };
  }

  // Atomically claim so a concurrent auto-cron tick (or a double-clicked button)
  // can't push this same asset in parallel and post it twice.
  const claimed = await claimAssetForPublish(id);
  if (!claimed) {
    return { ok: false, error: "This asset is already being published — give it a moment." };
  }

  try {
    await publishAssetToPlatform(target, integration, asset);
  } catch (e) {
    await releaseAssetPublishClaim(id).catch(() => {});
    const message = e instanceof Error ? e.message : "Unknown error";
    if (e instanceof TokenExpiredError) {
      await markIntegrationExpired(asset.clientId, target).catch(() => {});
    }
    await updateAsset(id, { publishError: message, updatedAt: Date.now() }).catch(() => {});
    return { ok: false, error: message };
  }

  await markAssetPublished(id);
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
