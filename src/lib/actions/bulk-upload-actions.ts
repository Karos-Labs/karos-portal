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

  const platform = "tiktok";
  const assignments = planBulkSchedule(
    pending.map((a) => a.id),
    { startDayMs: startAtMs, platform, pace: resolveDailyPace(client?.dailyPace), occupied },
  );

  for (const assignment of assignments) {
    await scheduleAssetAction(assignment.id, assignment.scheduledAt, platform, "manual");
  }

  revalidatePath("/assets");
  revalidatePath(`/clients/${clientId}`);
  revalidatePath(`/clients/${clientId}/assets`);
  return { scheduled: assignments.length };
}
