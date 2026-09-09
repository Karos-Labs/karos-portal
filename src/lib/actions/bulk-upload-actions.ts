"use server";

import { revalidatePath } from "next/cache";
import { getClient, listAssets } from "@/lib/data";
import { requireStaff } from "./_shared";
import { scheduleAssetAction } from "./asset-actions";
import { planBulkSchedule, type OccupiedDay } from "@/lib/bulk-schedule";
import { paceLaneFor, resolveDailyPace } from "@/lib/daily-pace";
import { chainFamilyFor, startOfDayMs } from "@/lib/post-chain";

/**
 * "Auto-Schedule Bulk Batch" — takes every unscheduled bulk-uploaded clip for a
 * client (draft, meta.bulkUpload, no scheduledAt yet) and spreads them across
 * days starting at `startAtMs`, at the client's own clip pace (default one a
 * day), skipping days already filled by this client's other social-family
 * content and weekend days TikTok doesn't post on (see bulk-schedule.ts).
 */
export async function bulkScheduleClipsAction(
  clientId: string,
  startAtMs: number,
): Promise<{ scheduled: number }> {
  await requireStaff();

  const [all, client] = await Promise.all([
    listAssets({ clientId }),
    getClient(clientId).catch(() => null),
  ]);
  const pending = all
    .filter((a) => a.status === "draft" && a.meta?.bulkUpload === true && a.scheduledAt == null)
    .sort((a, b) => a.createdAt - b.createdAt);

  // Each dated social asset books the lane it actually is, so a paced client's
  // clip day is not filled by that day's post (and an unpaced client's still is
  // — the ledger ignores the lane when no pace is stored).
  const occupied: OccupiedDay[] = all
    .filter((a) => a.scheduledAt != null && chainFamilyFor(a.type) === "social")
    .map((a) => ({ lane: paceLaneFor(a), dayStartMs: startOfDayMs(a.scheduledAt as number) }));

  /**
   * EACH ASSET BOOKS ITS OWN CHANNEL (2026-09).
   *
   * This was a single `const platform = "tiktok"` for the whole batch, and it
   * was right while the uploader took video only. It accepts images now, which
   * register against `instagram` (see DEFAULT_CHANNEL in the bulk-upload
   * route), so a flat "tiktok" would have scheduled a client's still photos to
   * TikTok — a wrong-platform booking made silently, by a helper button.
   *
   * Read off `channels[0]`, which is what registration writes and what a staff
   * member editing the asset afterwards changes. The `?? "tiktok"` keeps the
   * historical answer for a row with no channel at all rather than passing
   * `undefined` into `scheduleAssetAction`.
   */
  const platformFor = (assetId: string): string =>
    pending.find((a) => a.id === assetId)?.channels?.[0] ?? "tiktok";
  const platformById = Object.fromEntries(pending.map((a) => [a.id, platformFor(a.id)]));

  const assignments = planBulkSchedule(
    pending.map((a) => a.id),
    {
      startDayMs: startAtMs,
      // Still passed: it is the fallback for an id `platformById` does not name,
      // and the planner's own signature keeps it optional for uniform batches.
      platform: "tiktok",
      platformById,
      pace: resolveDailyPace(client?.dailyPace),
      occupied,
    },
  );

  for (const assignment of assignments) {
    await scheduleAssetAction(
      assignment.id,
      assignment.scheduledAt,
      platformFor(assignment.id),
      "manual",
    );
  }

  revalidatePath("/assets");
  revalidatePath(`/clients/${clientId}`);
  revalidatePath(`/clients/${clientId}/assets`);
  return { scheduled: assignments.length };
}
