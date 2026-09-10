/**
 * WHAT IS ON A CLIENT'S CALENDAR — one projection, two readers.
 *
 * The calendar page built this inline: pass everything through the client
 * redaction boundary, dedupe the documents the bulk-upload replay hole minted,
 * classify each survivor with `postKind`. Three steps in three modules, in the
 * order they have to run.
 *
 * The daily digest (AF-19) has to say what a client's day holds, and the ruling
 * is that the mail is DRIVEN BY the calendar rather than kept in step with it.
 * A second copy of those steps in the cron would be exactly the shape that
 * ruling forbids: two answers to "what does this client see today", drifting the
 * first time one of them is tightened. So the sequence lives here and the
 * calendar page calls it, which is what makes "synced" true by construction
 * rather than by inspection.
 *
 * THE ORDER IS LOAD-BEARING, and each step's own module says why:
 *  1. `getClientLibraryAssets({forClient})` — THE server security boundary. A
 *     future-dated post becomes a whitelist-redacted placeholder before it can
 *     cross to a browser, or into an email. It also carries drafts through
 *     ("pending work is reviewable"), and a client's calendar keeps them for the
 *     same reason — see `isClientCalendarStatus`'s docstring for the reversal:
 *     a client's calendar and dashboard now show the same pending work staff
 *     see, so there is no longer a draft-exclusion step here by default.
 *  2. `dedupeCalendarAssets`, keyed on the RAW documents. The redacted copies
 *     carry no `meta`, so the `gcsPath` the decision rests on is gone from them
 *     (see the note at the mapping below).
 *  3. `postKind` — null means "not a calendar entity", which is the last filter.
 *
 * `opts.excludeDrafts` IS THE ONE NAMED EXCEPTION to the reversal above, for a
 * caller that PUSHES rather than displays. The daily digest (AF-19) emails a
 * client's inbox unprompted; the in-app calendar and dashboard are something a
 * client chooses to open. The product decision to show a client their own team's
 * pending drafts did not extend to proactively mailing them about it, so the
 * digest cron opts into this flag and nothing else does — see its own call site
 * in app/api/daily-digest/route.ts.
 *
 * CLIENT-SAFE: no firebase-admin, no data.ts. Timestamps are epoch millis.
 */

import type { Asset } from "@/lib/types";
import { getClientLibraryAssets, type AssetViewer } from "@/lib/asset-visibility";
import { dedupeCalendarAssets } from "@/lib/calendar-dedupe";
import { postKind, type CalendarAssetKind } from "@/lib/calendar-kind";

/**
 * The assets a viewer's calendar is drawn from, projected and deduped.
 *
 * `isClient` false is the staff path and is a straight dedupe of what it was
 * given: staff read the calendar un-redacted and see internal drafts, exactly as
 * before this function existed. `isClient` true now sees the same drafts too —
 * `getClientLibraryAssets` already carries drafts through for the client
 * library, and the calendar no longer filters them out first — UNLESS the
 * caller asks for `excludeDrafts` (the daily digest's own opt-in; see the module
 * docstring above).
 */
export function clientVisibleCalendarAssets(
  scopedAssets: Asset[],
  opts: { isClient: boolean; now: number; viewer?: AssetViewer; excludeDrafts?: boolean },
): Asset[] {
  const scoped = opts.excludeDrafts
    ? scopedAssets.filter((a) => a.status !== "draft")
    : scopedAssets;
  const visible = opts.isClient
    ? getClientLibraryAssets(scoped, { forClient: true, now: opts.now, viewer: opts.viewer })
    : scoped;

  // Grouped on the UNREDACTED assets, then returned as the visible copies. A
  // client's future-dated posts reach `visible` as placeholders whose meta is
  // stripped to `{locked}`, so keying off those would compare two blanks. Each
  // visible asset is mapped back to its own pre-redaction twin for the decision,
  // and only the survivors' ids come back out.
  const rawById = new Map(scoped.map((a) => [a.id, a]));
  const survivorIds = new Set(
    dedupeCalendarAssets(visible.map((a) => rawById.get(a.id) ?? a)).map((a) => a.id),
  );
  return visible.filter((a) => survivorIds.has(a.id));
}

/** One calendar entry: the projected asset, its chip kind, and the day it sits on. */
export interface CalendarEntry {
  asset: Asset;
  kind: CalendarAssetKind;
  /** The instant the calendar places it at (published time, else its slot). */
  at: number;
}

/**
 * Every calendar entry for a viewer, in day order.
 *
 * `postKind` returning null drops the asset — an undated draft or an approved
 * item nobody put on a date is not a calendar entity.
 */
export function clientCalendarEntries(
  scopedAssets: Asset[],
  opts: { isClient: boolean; now: number; viewer?: AssetViewer; excludeDrafts?: boolean },
): CalendarEntry[] {
  return clientVisibleCalendarAssets(scopedAssets, opts)
    .map((asset): CalendarEntry | null => {
      const kind = postKind(asset);
      if (!kind) return null;
      const at = kind === "published" ? (asset.publishedAt ?? asset.scheduledAt!) : asset.scheduledAt!;
      return { asset, kind, at };
    })
    .filter((e): e is CalendarEntry => e != null)
    .sort((a, b) => a.at - b.at);
}

/**
 * The entries falling inside one half-open window `[fromMs, toMs)`.
 *
 * Half-open because the caller's window is a calendar DAY and a day's last
 * millisecond and the next day's first are the same boundary: an inclusive end
 * would put a midnight item on both days.
 */
export function calendarEntriesInWindow(
  entries: CalendarEntry[],
  fromMs: number,
  toMs: number,
): CalendarEntry[] {
  return entries.filter((e) => e.at >= fromMs && e.at < toMs);
}
