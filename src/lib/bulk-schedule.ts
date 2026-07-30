/**
 * Pure "1 clip per day" sequencer for bulk-uploaded video clips.
 *
 * Deliberately separate from `planClientChain` (post-chain.ts): that planner
 * only re-dates assets carrying chain provenance (an orderKey or
 * meta.source==="lab-import") and mixes them into the client's whole social
 * chain. Bulk-uploaded clips are staff-picked and staff-dated by construction
 * — they don't need (and shouldn't get) chain provenance — so this is a
 * simpler, standalone day-cursor that only ever looks at the batch it's given.
 *
 * Reuses the same day/slot math and weekend policy as the chain planner
 * (startOfDayMs/chainSlotForDay from post-chain.ts, chainAllowsDay from
 * scheduling.ts) so a bulk batch lands on the same kind of days a chain-
 * planned post would.
 *
 * CLIENT-SAFE: no firebase-admin, no data.ts. Importable by server actions,
 * API routes, and the CLI script (scripts/upload-local-clips.ts) alike.
 */

import { chainAllowsDay } from "@/lib/scheduling";
import { chainSlotForDay, startOfDayMs } from "@/lib/post-chain";

function nextDayStart(dayStartMs: number): number {
  const d = new Date(dayStartMs);
  d.setDate(d.getDate() + 1);
  d.setHours(0, 0, 0, 0);
  return d.getTime();
}

export interface BulkScheduleAssignment {
  id: string;
  scheduledAt: number;
}

/**
 * Assigns each id in order to the next available day starting at
 * `opts.startDayMs`, skipping days already occupied (by the id itself having
 * no conflict logic — occupancy is purely `opts.occupiedDayStarts`, e.g. this
 * client's other already-scheduled social content) and weekend days the
 * platform doesn't post on (chainAllowsDay).
 */
export function planBulkSchedule(
  ids: string[],
  opts: {
    startDayMs: number;
    platform?: string;
    /** Server-local day starts (startOfDayMs) already booked for this client/family. */
    occupiedDayStarts?: Set<number>;
  },
): BulkScheduleAssignment[] {
  const occupied = new Set(opts.occupiedDayStarts ?? []);
  let cursor = startOfDayMs(opts.startDayMs);
  const assignments: BulkScheduleAssignment[] = [];

  for (const id of ids) {
    while (occupied.has(cursor) || !chainAllowsDay("social_post", opts.platform, new Date(cursor).getDay())) {
      cursor = nextDayStart(cursor);
    }
    assignments.push({ id, scheduledAt: chainSlotForDay(cursor) });
    occupied.add(cursor);
    cursor = nextDayStart(cursor);
  }

  return assignments;
}

/**
 * Best-effort platform-format tags from a clip's filename — informational
 * (meta.formatTags), distinct from `channels` which stays a real,
 * publish-integration platform id (see bulk-upload route). Defaults to all
 * three when nothing in the name narrows it down, since a generic podcast
 * clip works across TikTok, YouTube Shorts, and Instagram Reels alike.
 */
export function detectFormatTags(filename: string): string[] {
  const lower = filename.toLowerCase();
  const tags: string[] = [];
  if (lower.includes("tiktok")) tags.push("TikTok");
  if (lower.includes("short")) tags.push("Shorts");
  if (lower.includes("reel")) tags.push("Reels");
  return tags.length > 0 ? tags : ["TikTok", "Shorts", "Reels"];
}
