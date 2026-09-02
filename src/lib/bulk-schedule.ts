/**
 * Pure day sequencer for bulk-uploaded video clips.
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
 * planned post would — and the same DayLedger (lib/daily-pace), so the client's
 * pace means one thing across both planners. It used to be "1 clip per day",
 * structurally; it is now `clipsPerDay`, defaulting to 1.
 *
 * CLIENT-SAFE: no firebase-admin, no data.ts. Importable by server actions,
 * API routes, and the CLI script (scripts/upload-local-clips.ts) alike.
 */

import { chainAllowsDay } from "@/lib/scheduling";
import { chainSlotForDay, startOfDayMs } from "@/lib/post-chain";
import {
  createDayLedger,
  LEGACY_PACE,
  type PaceLane,
  type ResolvedPace,
} from "@/lib/daily-pace";

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

/** One already-booked day, and which lane of it the booking claimed. */
export interface OccupiedDay {
  lane: PaceLane;
  dayStartMs: number;
}

/**
 * Assigns each id in order to the next day whose CLIP lane still has room,
 * starting at `opts.startDayMs`, skipping weekend days the platform doesn't post
 * on (chainAllowsDay).
 *
 * The batch is clips by definition (this is the bulk clip uploader's planner),
 * so every id here books the clip lane. `opts.occupied` is the client's other
 * already-dated social content WITH its lane, which is what lets a paced client
 * put two clips and a post on one day while an unpaced one keeps the single slot
 * a day it has always had: with no pace, the ledger drops the lane from its key
 * and any dated post fills the day for clips too.
 *
 * ── THE PLATFORM CAN NOW DIFFER PER ID (2026-09) ─────────────────────────
 *
 * `opts.platform` was one value for the whole batch, which was true while the
 * uploader accepted video only and booked every file to TikTok. It accepts
 * images now, and those register against Instagram, so a batch is genuinely
 * mixed — and `chainAllowsDay` is a PER-PLATFORM question (which weekdays that
 * platform posts on). One value for a mixed batch would have skipped the wrong
 * days for half of it.
 *
 * `platformById` overrides `opts.platform` for the ids it names and is optional,
 * so a caller with a uniform batch passes nothing and gets exactly today's
 * walk. THE LANE IS STILL "clip" for every id: the pace lanes are a product
 * decision about how much a client posts per day, not a media-type
 * classification, and quietly giving images their own lane here would change
 * how much content a paced client receives.
 */
export function planBulkSchedule(
  ids: string[],
  opts: {
    startDayMs: number;
    platform?: string;
    /** Per-id platform, overriding `platform` where present. */
    platformById?: Readonly<Record<string, string | undefined>>;
    /** The client's resolved pace. Absent ⇒ one item a day, as before. */
    pace?: ResolvedPace;
    /** This client's other already-scheduled social content, by day and lane. */
    occupied?: readonly OccupiedDay[];
  },
): BulkScheduleAssignment[] {
  const ledger = createDayLedger(opts.pace ?? LEGACY_PACE);
  for (const booked of opts.occupied ?? []) {
    ledger.book(booked.lane, startOfDayMs(booked.dayStartMs));
  }
  let cursor = startOfDayMs(opts.startDayMs);
  const assignments: BulkScheduleAssignment[] = [];

  for (const id of ids) {
    const platform = opts.platformById?.[id] ?? opts.platform;
    while (
      ledger.isFull("clip", cursor) ||
      !chainAllowsDay("social_post", platform, new Date(cursor).getDay())
    ) {
      cursor = nextDayStart(cursor);
    }
    assignments.push({ id, scheduledAt: chainSlotForDay(cursor) });
    ledger.book("clip", cursor);
    // Stays on the day while the clip lane has room. At the default ceiling of 1
    // the loop above steps off it immediately, which is the old walk.
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
