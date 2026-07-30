"use server";

import { revalidatePath } from "next/cache";
import { listAssets } from "@/lib/data";
import { requireStaff } from "./_shared";
import { scheduleAssetAction } from "./asset-actions";
import { planBulkSchedule } from "@/lib/bulk-schedule";
import { chainFamilyFor, startOfDayMs } from "@/lib/post-chain";

/**
 * "Auto-Schedule Bulk Batch (1/day)" — takes every unscheduled bulk-uploaded
 * clip for a client (draft, meta.bulkUpload, no scheduledAt yet) and spreads
 * them one per day starting at `startAtMs`, skipping days already occupied by
 * this client's other social-family content and weekend days TikTok doesn't
 * post on (see bulk-schedule.ts).
 */
export async function bulkScheduleClipsAction(
  clientId: string,
  startAtMs: number,
): Promise<{ scheduled: number }> {
  await requireStaff();

  const all = await listAssets({ clientId });
  const pending = all
    .filter((a) => a.status === "draft" && a.meta?.bulkUpload === true && a.scheduledAt == null)
    .sort((a, b) => a.createdAt - b.createdAt);

  const occupiedDayStarts = new Set(
    all
      .filter((a) => a.scheduledAt != null && chainFamilyFor(a.type) === "social")
      .map((a) => startOfDayMs(a.scheduledAt as number)),
  );

  const platform = "tiktok";
  const assignments = planBulkSchedule(
    pending.map((a) => a.id),
    { startDayMs: startAtMs, platform, occupiedDayStarts },
  );

  for (const assignment of assignments) {
    await scheduleAssetAction(assignment.id, assignment.scheduledAt, platform, "manual");
  }

  revalidatePath("/assets");
  revalidatePath(`/clients/${clientId}`);
  revalidatePath(`/clients/${clientId}/assets`);
  return { scheduled: assignments.length };
}
