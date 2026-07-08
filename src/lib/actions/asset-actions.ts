"use server";

import { revalidatePath } from "next/cache";
import {
  getAsset,
  updateAsset,
  clearAssetSchedule,
  markAssetPublished,
  listClientIntegrations,
  markIntegrationExpired,
} from "@/lib/data";
import { getCurrentUser } from "@/lib/auth";
import { requireStaff } from "./_shared";
import {
  TokenExpiredError,
  inferPlatform,
  publishAssetToPlatform,
} from "@/lib/integrations/publishers";
import type { PublishMode } from "@/lib/types";

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

  try {
    await publishAssetToPlatform(target, integration, asset);
  } catch (e) {
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
