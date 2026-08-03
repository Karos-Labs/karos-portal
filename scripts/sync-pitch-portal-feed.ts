/**
 * CD-M / AF-19 — make the Pitch by Deel portal calendar mirror the daily email.
 *
 * Albert's routine (`~/The Pitch Auto/portal-feed/portal_daily_email.py`) mails
 * the client TWO podcast clips and ONE Instagram carousel every day. The portal
 * shows one clip a day, title-only, with no video attached. This script closes
 * that gap so the calendar and the mail are the same content, day for day.
 *
 *   npx tsx scripts/sync-pitch-portal-feed.ts                 # DRY RUN (default)
 *   npx tsx scripts/sync-pitch-portal-feed.ts --apply         # uploads + writes
 *   --feed-root PATH     the routine folder (default ~/The Pitch Auto/portal-feed)
 *   --client ID          another client id (see THE CLIENT GUARD below)
 *   --today YYYY-MM-DD   pin "today" (past/future boundary); default the host's day
 *   --slot-hour N        hour of the day slot; default CHAIN_SLOT_HOUR (11)
 *   --limit N            plan only the first N calendar days (rehearsal)
 *
 * DRY RUN IS THE DEFAULT ON PURPOSE, and it is not offline: it READS production
 * Firestore and the storage bucket so the plan it prints is the real one (how
 * many clips are already in the bucket, which assets already match). It writes
 * nothing, uploads nothing, and mutates nothing. Read the plan first.
 *
 * ── THE PAIRING RULE (verified against sent-log.json, 12/12 days) ─────────────
 * `publish-queue.json` is a flat list of 227 clips, one entry per POSITION, each
 * carrying a `date` from its own one-clip-a-day generation. The mail does not
 * use that date: `clips_for_day(queue, order)` takes the queue entry whose date
 * is the mail's day, reads its `order` N, and sends queue POSITIONS 2(N-1) and
 * 2(N-1)+1 (0-based). So the calendar day that the queue calls order N holds the
 * clips the queue calls order 2N-1 and 2N, and the queue burns two positions a
 * day. 227 positions therefore cover 114 calendar days, not 227.
 *
 * `sent-log.json` records what actually went out per day and OUTRANKS the rule
 * for any day it names (that is the definition of "mirror the email"). Today
 * both agree on every day they share, so the override changes nothing yet - it
 * is here because the moment a day is re-sent by hand with PORTAL_DATE or
 * IG_ITEM, the log is the only record of it.
 *
 * The mail runs `lead-days.txt` days AHEAD of the host date (2 today), so
 * sent-log holds entries for dates that have not arrived. Those are still
 * FUTURE calendar days: what decides published-vs-scheduled here is the day
 * itself against `--today`, never whether a mail has gone out.
 *
 * ── THE ONE KEY EVERYTHING HANGS ON ──────────────────────────────────────────
 * `meta.labRun` — `tiktok-agent/2026-07-23-podcast-clips-02#judges/alex-bouaziz-01`,
 * exactly the string publish-queue.json already carries per entry and exactly
 * what the lab importer writes (scripts/import-lab-client.ts) and treats as
 * "already imported". Its part after "#" is the routine's own `clips/<pool>/<item>`
 * id, so ONE identifier spans the routine folder, the bucket path and the
 * Firestore document. Re-runs converge on it: an asset is matched by item id,
 * then labRun, then orderKey, and every asset this script writes is stamped with
 * `meta.portalFeedItem` so a second run recognises its own work even if a human
 * later retitles or re-dates the document.
 *
 * NOTHING IS DELETED AND NOTHING IS CREATED FOR A CAROUSEL. Assets that match no
 * queue entry are printed as SURPLUS for a human to judge; a script that guessed
 * which of a client's real posts to unpublish is not a synchroniser.
 *
 * ── THE VIDEO SHAPE, AND WHY NOT `meta.gcsPath` ──────────────────────────────
 * The clips live in FIREBASE STORAGE under the lab-import convention
 * (`lab-imports/<clientId>/<runKey>/<item>/clip.mp4`), not in GCS_MEDIA_BUCKET.
 * `assetVideos` (lib/asset-images) reads four places; the lab import's own is
 * `meta.files[]`, and that is what this mirrors: a `{name,relPath,url,bytes}`
 * entry for clip.mp4 whose url is a durable Firebase download URL (a
 * `?alt=media&token=` link with no TTL), plus `mimeType: "video/mp4"`.
 *
 * `meta.gcsPath` is deliberately NOT set, and that is a correctness rule rather
 * than a preference: `resolveAssetVideoSource` re-signs a gcsPath against
 * GCS_MEDIA_BUCKET, so a Firebase-Storage path stored there would be signed
 * against the wrong bucket and the signer would NOT throw — the player would
 * follow a valid-looking URL to a 404 instead of falling back to the durable
 * link. Leaving it unset takes the `origin: "stored"` branch, which redirects to
 * the token URL and plays. It also keeps `dedupeCalendarAssets` out of it
 * entirely (that only ever collapses on a shared gcsPath), so a day may hold two
 * clips without either being hidden.
 *
 * ── WHAT THE CHAIN NEEDS (checked, not assumed) ──────────────────────────────
 *  · `scheduledAt` is `chainSlotForDay` — local midnight + CHAIN_SLOT_HOUR (11),
 *    the same slot post-chain assigns, so a day this script fills is
 *    indistinguishable from one the planner filled. An asset that is already on
 *    the right DAY keeps its exact stored instant, hour included.
 *  · `orderKey` is the queue's own (`<run>#<NNN>`), which sorts slot A before
 *    slot B within a day and keeps every clip in generation order across days.
 *  · Every asset written lands non-draft WITH a `scheduledAt`, which is PINNED
 *    under `planClientChain`'s reflow mode - a later reflow can never move it.
 *  · `publishMode` is never written as "auto". The /api/publish cron drains
 *    status IN [scheduled, approved] AND publishMode IN {auto, absent}, so
 *    "manual" is what keeps a synced future day from auto-posting.
 *  · `paceLaneFor` books these in the CLIP lane (they have a video), so the
 *    client record needs `dailyPace.clipsPerDay >= 2` or the chain will still
 *    plan future imports one clip a day. The script REPORTS the stored pace and
 *    never writes it: AF-19 makes pace staff-editable configuration.
 *
 * ── THE CLIENT GUARD ─────────────────────────────────────────────────────────
 * The routine folder describes ONE client. With no `--client` the script uses
 * the hardcoded Pitch by Deel id and nothing else; pointing it at another client
 * takes an explicit `--client <id>`, because every day plan in here comes from
 * files that have no idea another client exists.
 *
 * Bootstrap (env before firebase-admin, dynamic import, `require.main` guard)
 * follows scripts/backfill-client-agents.ts, so importing this module for a test
 * can never open a Firestore connection. Planning is PURE and exported; the
 * impure half only reads files, probes the bucket, and writes.
 */

import { existsSync, readFileSync, statSync } from "node:fs";
import { homedir } from "node:os";
import path from "node:path";

import { assetVideos } from "@/lib/asset-images";
import { resolveDailyPace } from "@/lib/daily-pace";
import { CHAIN_SLOT_HOUR, chainSlotForDay, startOfDayMs, templateFromItemKey } from "@/lib/post-chain";
import type { Asset, AssetType, Client } from "@/lib/types";

const ROOT = path.resolve(__dirname, "..");

/* ═════════════════════════ constants ═════════════════════════ */

/** Pitch by Deel. The routine folder describes this client and no other. */
export const PBD_CLIENT_ID = "jzgdl738dq7DclAdqky1";

/** Albert's routine folder. READ-ONLY to this script, always. */
export const DEFAULT_FEED_ROOT = path.join(homedir(), "The Pitch Auto", "portal-feed");

/**
 * Asset type for a clip this script CREATES, used only when the client holds no
 * clip asset to copy the shape from. The live shape wins whenever there is one
 * (`deriveClipShape`), which is the point: `guessAssetType("tiktok-agent")`
 * answers "instagram_post" while the documents in production are "social_post",
 * and a synchroniser must agree with the data rather than with the function that
 * did not write it.
 */
export const FALLBACK_CLIP_TYPE: AssetType = "social_post";

export const CREATED_BY = "sync-pitch-portal-feed-script";

/* ═════════════════════════ routine file shapes ═════════════════════════ */

/** One position in publish-queue.json. `date` is its generation date, NOT its calendar day. */
export interface QueueDay {
  order: number;
  date: string;
  item: string;
  pool: string;
  person: string;
  company?: string;
  show?: string;
  labRun: string;
  orderKey: string;
}

export interface PublishQueue {
  run?: string;
  agent?: string;
  days: QueueDay[];
}

/** One day in ig-queue.json. Here `date` IS the calendar day (carousel_for_day matches on it). */
export interface IgDay {
  order: number;
  date: string;
  item: string;
  category?: string;
  labRun: string;
  orderKey: string;
}

export interface IgQueue {
  run?: string;
  agent?: string;
  days: IgDay[];
}

/**
 * One day in sent-log.json. Two shapes live in the file: the pre-2026-07-22
 * single-clip mail (`clip` + `ig`) and the current pair mail (`clips` +
 * `carousel`). Both are read; only the current one occurs inside the queue's
 * date range.
 */
export interface SentDay {
  day?: number;
  clips?: string[];
  clip?: string;
  carousel?: string | null;
  ig?: string;
  resend_note?: string;
}

export type SentLog = Record<string, SentDay>;

/** A clip's files on disk, as the routine keeps them. */
export interface LocalClip {
  caption: string;
  about: string;
  mp4Path: string;
  mp4Bytes: number;
}

/* ═════════════════════════ pure: the pairing rule ═════════════════════════ */

/**
 * The two queue POSITIONS (0-based indexes into days[]) a calendar day of order
 * N carries. Literally `clips_for_day`'s `[2*(order-1), 2*(order-1)+1]`.
 */
export function pairIndexesForOrder(order: number): [number, number] {
  return [2 * (order - 1), 2 * (order - 1) + 1];
}

/** The day's clips under the pairing rule, dropping positions past the queue's end. */
export function queueClipsForOrder(days: QueueDay[], order: number): QueueDay[] {
  return pairIndexesForOrder(order)
    .filter((i) => i >= 0 && i < days.length)
    .map((i) => days[i]);
}

/**
 * The queue entries that are CALENDAR DAYS: one per date the mail can run on.
 * A queue entry whose order N has no clip at position 2(N-1) is past the end of
 * the content and is not a day at all — 227 positions make 114 days, the last of
 * which holds a single clip.
 */
export function calendarDays(days: QueueDay[]): QueueDay[] {
  return days.filter((d) => queueClipsForOrder(days, d.order).length > 0);
}

/** `<agent>/<run>#<pool>/<item>` split into its two halves. */
export function splitLabRun(labRun: string): { runKey: string; item: string } {
  const hash = labRun.indexOf("#");
  if (hash < 0) return { runKey: labRun, item: "" };
  return { runKey: labRun.slice(0, hash), item: labRun.slice(hash + 1) };
}

/** Where the day's clips come from, and every disagreement, named. */
export interface DayClips {
  clips: QueueDay[];
  source: "sent-log" | "queue-rule";
  /** sent-log items with no matching queue entry - reported, never guessed at. */
  unresolvedSentItems: string[];
  /** true when the log named a different pair than the rule would have. */
  overridesRule: boolean;
}

/**
 * The day's two clips: what was SENT when the log knows, the pairing rule
 * otherwise.
 *
 * A log entry naming items the queue does not contain does not silently become a
 * shorter day: whatever it did resolve is used, the rest are reported, and a log
 * entry that resolves to nothing at all falls back to the rule with the misses
 * still named.
 */
export function resolveDayClips(day: QueueDay, days: QueueDay[], sentLog: SentLog): DayClips {
  const rule = queueClipsForOrder(days, day.order);
  const entry = sentLog[day.date];
  const sentItems = entry?.clips ?? (entry?.clip ? [entry.clip] : []);
  if (sentItems.length === 0) {
    return { clips: rule, source: "queue-rule", unresolvedSentItems: [], overridesRule: false };
  }

  const byItem = new Map(days.map((d) => [d.item, d]));
  const resolved: QueueDay[] = [];
  const unresolved: string[] = [];
  for (const item of sentItems) {
    const hit = byItem.get(item);
    if (hit) resolved.push(hit);
    else unresolved.push(item);
  }
  if (resolved.length === 0) {
    return { clips: rule, source: "queue-rule", unresolvedSentItems: unresolved, overridesRule: false };
  }
  const sameAsRule =
    resolved.length === rule.length && resolved.every((c, i) => c.item === rule[i].item);
  return {
    clips: resolved,
    source: "sent-log",
    unresolvedSentItems: unresolved,
    overridesRule: !sameAsRule,
  };
}

/** The carousel a calendar day carries, and whether the log agrees with the queue. */
export interface DayCarousel {
  entry: IgDay | null;
  /** The folder NAME the log recorded (sent-log stores the leaf, not the path). */
  sentName: string | null;
  /** false only when both exist and disagree. */
  agrees: boolean;
}

export function resolveDayCarousel(date: string, igDays: IgDay[], sentLog: SentLog): DayCarousel {
  const entry = igDays.find((d) => d.date === date) ?? null;
  const logged = sentLog[date];
  const sentName = logged?.carousel ?? logged?.ig ?? null;
  if (!entry || !sentName) return { entry, sentName, agrees: true };
  const tail = entry.item.split("/").pop() ?? entry.item;
  return { entry, sentName, agrees: tail === sentName };
}

/* ═════════════════════════ pure: dates, paths, urls ═════════════════════════ */

/**
 * The day's publication instant: local midnight + `hour`. Identical to
 * `chainSlotForDay(startOfDayMs(thatDay))` at the default hour, which is pinned
 * by a test rather than asserted here — a slot this script invents that the
 * chain would not have chosen is the whole failure mode.
 *
 * Runtime-local like every other date in this codebase (see scheduling.ts): the
 * SEQUENCE of days is invariant across hosts, only the stored hour shifts, so
 * run this where the intended calendar day is the host's.
 */
export function slotForDate(date: string, hour: number = CHAIN_SLOT_HOUR): number {
  const dayStart = dayStartForDate(date);
  // The default hour goes through the chain's OWN function rather than
  // reimplementing it, so "the slot this script writes" and "the slot the
  // planner would have written" cannot drift apart by construction.
  if (hour === CHAIN_SLOT_HOUR) return chainSlotForDay(dayStart);
  const d = new Date(dayStart);
  d.setHours(hour, 0, 0, 0);
  return d.getTime();
}

/** Local midnight of a YYYY-MM-DD. */
export function dayStartForDate(date: string): number {
  const [y, m, d] = date.split("-").map(Number);
  return new Date(y, m - 1, d, 0, 0, 0, 0).getTime();
}

/**
 * Where a clip's mp4 lives in Firebase Storage. The lab importer's own
 * convention — `lab-imports/<clientId>/<agent>/<run>/<pool>/<item>/<file>` — so
 * a clip already uploaded by an import is found rather than duplicated.
 */
export function clipObjectPath(clientId: string, labRun: string): string {
  const { runKey, item } = splitLabRun(labRun);
  return `lab-imports/${clientId}/${runKey}/${item}/clip.mp4`;
}

/** The durable Firebase download URL for an object, exactly as `uploadBytes` mints it. */
export function firebaseDownloadUrl(bucket: string, objectPath: string, token: string): string {
  return `https://firebasestorage.googleapis.com/v0/b/${bucket}/o/${encodeURIComponent(objectPath)}?alt=media&token=${token}`;
}

/* ═════════════════════════ pure: matching ═════════════════════════ */

/**
 * Every identity an existing asset claims, strongest first. `item:` is the
 * routine's own id and the only one that survives a re-import; `orderKey:` is
 * the weakest because the queue's `<run>#NNN` form carries a position rather
 * than a name.
 */
export function assetMatchKeys(a: Pick<Asset, "meta" | "orderKey">): string[] {
  const keys: string[] = [];
  const meta = a.meta ?? {};
  const marker = meta.portalFeedItem;
  if (typeof marker === "string" && marker) keys.push(`item:${marker}`);
  const labRun = meta.labRun;
  if (typeof labRun === "string" && labRun.includes("#")) {
    keys.push(`labRun:${labRun}`);
    keys.push(`item:${splitLabRun(labRun).item}`);
  }
  if (typeof a.orderKey === "string" && a.orderKey.includes("#")) {
    keys.push(`orderKey:${a.orderKey}`);
    const tail = a.orderKey.slice(a.orderKey.indexOf("#") + 1);
    if (tail.includes("/")) keys.push(`item:${tail}`);
  }
  return [...new Set(keys)];
}

/** The same identities from the queue's side, in the same priority order. */
export function queueMatchKeys(q: Pick<QueueDay, "labRun" | "orderKey">): string[] {
  return [`item:${splitLabRun(q.labRun).item}`, `labRun:${q.labRun}`, `orderKey:${q.orderKey}`];
}

/** ig-queue entries match on exactly the same two strong keys. */
export function igMatchKeys(q: Pick<IgDay, "labRun" | "orderKey">): string[] {
  return [`item:${splitLabRun(q.labRun).item}`, `labRun:${q.labRun}`, `orderKey:${q.orderKey}`];
}

/** An index from every claimed identity to the assets claiming it. */
export function buildMatchIndex<T extends Pick<Asset, "meta" | "orderKey">>(
  assets: T[],
): Map<string, T[]> {
  const index = new Map<string, T[]>();
  for (const a of assets) {
    for (const key of assetMatchKeys(a)) {
      const list = index.get(key);
      if (list) list.push(a);
      else index.set(key, [a]);
    }
  }
  return index;
}

export interface MatchResult<T> {
  asset: T | null;
  /** Which key matched, for the report. */
  via: string | null;
  /** Set when one identity named more than one document. Never auto-resolved. */
  ambiguous: T[] | null;
}

/** First key that hits, in priority order. More than one hit on a key is an ambiguity. */
export function matchOne<T>(index: Map<string, T[]>, keys: string[], taken: Set<T>): MatchResult<T> {
  for (const key of keys) {
    const hits = (index.get(key) ?? []).filter((a) => !taken.has(a));
    if (hits.length === 1) return { asset: hits[0], via: key, ambiguous: null };
    if (hits.length > 1) return { asset: null, via: key, ambiguous: hits };
  }
  return { asset: null, via: null, ambiguous: null };
}

/* ═════════════════════════ pure: the plan ═════════════════════════ */

/** What the bucket holds for one clip, as probed (or, in a test, as stubbed). */
export interface BucketClipState {
  objectPath: string;
  exists: boolean;
  /** Durable download URL when the object exists AND carries a token. */
  url: string | null;
  sizeBytes?: number;
}

/** The shape a created clip copies from the client's own documents. */
export interface ClipShape {
  type: AssetType;
  channels?: string[];
  scheduledPlatform?: string;
  /** The template chip the client's existing clips already carry, when they agree. */
  templateKey?: string;
  templateName?: string;
  /** How the shape was decided, for the report. */
  source: "live-assets" | "fallback";
}

/**
 * The type/channels/platform/template a NEW clip should carry, taken by majority
 * from the clip assets this client already has. Copying beats deriving: whatever
 * the import actually wrote is what the rest of the product already renders, and
 * `guessAssetType("tiktok-agent")` disagrees with it.
 *
 * The template is copied rather than derived per item ON PURPOSE.
 * `templateFromItemKey("judges/alex-bouaziz-01")` would mint one template per
 * clip, which is a new chip on every card and a new series for
 * `blockingPredecessor` to reason about. It is only used when the client has no
 * clip to copy from at all.
 */
export function deriveClipShape(matched: Asset[]): ClipShape {
  if (matched.length === 0) return { type: FALLBACK_CLIP_TYPE, source: "fallback" };
  const tally = new Map<AssetType, number>();
  for (const a of matched) tally.set(a.type, (tally.get(a.type) ?? 0) + 1);
  const type = [...tally.entries()].sort((a, b) => b[1] - a[1])[0][0];
  const sample = matched.find((a) => a.type === type) ?? matched[0];
  const templates = new Map<string, { name: string; n: number }>();
  for (const a of matched) {
    if (!a.templateKey) continue;
    const hit = templates.get(a.templateKey);
    if (hit) hit.n++;
    else templates.set(a.templateKey, { name: a.templateName ?? a.templateKey, n: 1 });
  }
  const template = [...templates.entries()].sort((a, b) => b[1].n - a[1].n)[0];
  return {
    type,
    ...(sample.channels && sample.channels.length > 0 ? { channels: [...sample.channels] } : {}),
    ...(sample.scheduledPlatform ? { scheduledPlatform: sample.scheduledPlatform } : {}),
    ...(template ? { templateKey: template[0], templateName: template[1].name } : {}),
    source: "live-assets",
  };
}

export type ClipActionKind = "unchanged" | "update" | "create" | "blocked";

export interface ClipAction {
  kind: ClipActionKind;
  date: string;
  slot: "a" | "b";
  item: string;
  person: string;
  /** The document being updated, when there is one. */
  assetId: string | null;
  /** Which identity matched it. */
  via: string | null;
  /** Field names this run would change (update), or write fresh (create). */
  changes: string[];
  /** The merge patch / new document. Empty for "unchanged" and "blocked". */
  payload: Record<string, unknown>;
  /** Why nothing can be done. Only set for "blocked". */
  blockedReason?: string;
  /** True when the mp4 still has to be uploaded before this can be applied. */
  needsUpload: boolean;
}

export type CarouselStatus =
  | "ok"
  | "redate"
  | "restatus"
  | "missing"
  | "ambiguous"
  /** No ig-queue entry for a day INSIDE the carousel queue's date range. A gap. */
  | "no-queue-entry"
  /**
   * The day is past the last carousel in ig-queue.json. Not a fault: the clip
   * queue runs 114 days and the carousel queue 43, and the mail itself says so
   * ("The carousel queue is used up; the next batch is in production"). Counted
   * apart from the faults so a summary does not read as 71 problems.
   */
  | "queue-exhausted";

export interface CarouselAction {
  date: string;
  status: CarouselStatus;
  item: string | null;
  assetId: string | null;
  changes: string[];
  payload: Record<string, unknown>;
  note?: string;
}

export interface DayPlan {
  date: string;
  order: number;
  past: boolean;
  source: DayClips["source"];
  overridesRule: boolean;
  clips: ClipAction[];
  carousel: CarouselAction;
  notes: string[];
}

export interface FeedPlan {
  clientId: string;
  days: DayPlan[];
  shape: ClipShape;
  /** Clip items whose mp4 is not in the bucket yet, in plan order. */
  uploads: Array<{ item: string; objectPath: string; localPath: string; bytes: number }>;
  /**
   * Objects already in the bucket with no `firebaseStorageDownloadTokens` on
   * them. `--apply` adds a token rather than re-uploading 12 MB to mint one.
   */
  tokenBackfills: Array<{ item: string; objectPath: string }>;
  /** Assets that matched no queue or ig entry. Reported, never touched. */
  surplus: Array<{ id: string; title: string; scheduledAt?: number; reason: string }>;
  ambiguities: string[];
}

export interface PlanInput {
  clientId: string;
  bucket: string;
  queue: PublishQueue;
  ig: IgQueue;
  sentLog: SentLog;
  /** Every asset of this client, unfiltered. */
  assets: Asset[];
  /** Per clip item: what the routine folder holds. Missing ⇒ the clip cannot be attached. */
  localClips: Map<string, LocalClip>;
  /** Per clip item: what the bucket holds. Missing ⇒ treated as absent. */
  bucketState: Map<string, BucketClipState>;
  /** Epoch millis. Days strictly before this day are "past". */
  todayMs: number;
  now: number;
  slotHour?: number;
  /** Plan only the first N calendar days. */
  limitDays?: number;
}

/** Does this asset look like one of the routine's clips (rather than a carousel)? */
function claimsRun(a: Pick<Asset, "meta" | "orderKey">, runKey: string): boolean {
  const labRun = a.meta?.labRun;
  if (typeof labRun === "string" && labRun.startsWith(`${runKey}#`)) return true;
  const orderKey = a.orderKey;
  const runName = runKey.split("/").pop() ?? runKey;
  return typeof orderKey === "string" && orderKey.startsWith(`${runName}#`);
}

/** The clip.mp4 entry of a meta.files list, replaced or appended, other files untouched. */
export function mergeClipFile(
  files: unknown,
  entry: { name: string; relPath: string; url: string; bytes: number },
): Array<Record<string, unknown>> {
  const existing = Array.isArray(files) ? (files as Array<Record<string, unknown>>) : [];
  const out = existing.filter((f) => String(f?.name ?? f?.relPath ?? "").toLowerCase() !== "clip.mp4");
  out.push({ ...entry });
  return out;
}

/**
 * The whole plan, from files and documents to patches. Pure: same inputs, same
 * output, no clock of its own and no I/O — which is what lets the pairing rule,
 * the sent-log override and the idempotence key be tested against fixtures
 * lifted straight out of the routine folder.
 */
export function planPortalFeed(input: PlanInput): FeedPlan {
  const hour = input.slotHour ?? CHAIN_SLOT_HOUR;
  const days = input.queue.days;
  const runKey = days.length > 0 ? splitLabRun(days[0].labRun).runKey : "";
  const igRunKey = input.ig.days.length > 0 ? splitLabRun(input.ig.days[0].labRun).runKey : "";
  const todayStart = startOfDayMs(input.todayMs);

  const clipCandidates = input.assets.filter((a) => claimsRun(a, runKey));
  const igCandidates = input.assets.filter((a) => claimsRun(a, igRunKey));
  const clipIndex = buildMatchIndex(clipCandidates);
  const igIndex = buildMatchIndex(igCandidates);
  const takenClips = new Set<Asset>();
  const takenIg = new Set<Asset>();
  const ambiguities: string[] = [];

  // Matching runs BEFORE shaping, so a created clip copies the type/channels the
  // client's own documents carry rather than a guess from the agent folder.
  const allDays = calendarDays(days);
  const planned = input.limitDays != null ? allDays.slice(0, input.limitDays) : allDays;
  const resolutions = planned.map((day) => {
    const resolved = resolveDayClips(day, days, input.sentLog);
    // Each clip carries its own match, so the shaping pass and the planning pass
    // cannot drift out of step (a shared cursor between two loops would).
    const matches = resolved.clips.map((clip) => {
      const hit = matchOne(clipIndex, queueMatchKeys(clip), takenClips);
      if (hit.asset) takenClips.add(hit.asset);
      if (hit.ambiguous) {
        ambiguities.push(
          `clip ${clip.item}: ${hit.ambiguous.length} documents claim ${hit.via} (${hit.ambiguous.map((a) => a.id).join(", ")})`,
        );
      }
      return { clip, asset: hit.asset, via: hit.via };
    });
    return { day, resolved, matches };
  });
  const shape = deriveClipShape(
    resolutions.flatMap((r) => r.matches.map((m) => m.asset)).filter((a): a is Asset => a != null),
  );

  const uploads = new Map<string, { item: string; objectPath: string; localPath: string; bytes: number }>();
  const dayPlans: DayPlan[] = [];

  for (const { day, resolved, matches } of resolutions) {
    const past = dayStartForDate(day.date) < todayStart;
    const slot = slotForDate(day.date, hour);
    const notes: string[] = [];
    if (resolved.overridesRule) notes.push("sent-log names a different pair than the queue rule");
    for (const miss of resolved.unresolvedSentItems) {
      notes.push(`sent-log item "${miss}" is not in the queue`);
      ambiguities.push(`${day.date}: sent-log item "${miss}" is not in publish-queue.json`);
    }
    if (resolved.clips.length < 2) notes.push(`only ${resolved.clips.length} clip(s) available for this day`);

    const clipActions: ClipAction[] = [];
    for (let i = 0; i < resolved.clips.length; i++) {
      const clip = resolved.clips[i];
      const slotName: "a" | "b" = i === 0 ? "a" : "b";
      const match = matches[i];
      clipActions.push(
        planClipAction({
          clip,
          slotName,
          date: day.date,
          slotMs: slot,
          past,
          asset: match?.asset ?? null,
          via: match?.via ?? null,
          shape,
          local: input.localClips.get(clip.item) ?? null,
          bucket: input.bucketState.get(clip.item) ?? null,
          clientId: input.clientId,
          now: input.now,
          uploads,
        }),
      );
    }

    dayPlans.push({
      date: day.date,
      order: day.order,
      past,
      source: resolved.source,
      overridesRule: resolved.overridesRule,
      clips: clipActions,
      carousel: planCarouselAction({
        date: day.date,
        past,
        slotMs: slot,
        igDays: input.ig.days,
        sentLog: input.sentLog,
        index: igIndex,
        taken: takenIg,
        now: input.now,
      }),
      notes,
    });
  }

  const surplus: FeedPlan["surplus"] = [];
  for (const a of clipCandidates) {
    if (takenClips.has(a)) continue;
    surplus.push({
      id: a.id,
      title: a.title,
      ...(a.scheduledAt != null ? { scheduledAt: a.scheduledAt } : {}),
      reason: "clip asset matching no planned queue entry",
    });
  }
  for (const a of igCandidates) {
    if (takenIg.has(a)) continue;
    surplus.push({
      id: a.id,
      title: a.title,
      ...(a.scheduledAt != null ? { scheduledAt: a.scheduledAt } : {}),
      reason: "carousel asset matching no ig-queue entry",
    });
  }

  // Keyed by item, because a hand re-send can put one clip on two days and the
  // token only has to be written once.
  const tokenBackfills = new Map<string, { item: string; objectPath: string }>();
  for (const { resolved } of resolutions) {
    for (const clip of resolved.clips) {
      const state = input.bucketState.get(clip.item);
      if (state?.exists && !state.url) {
        tokenBackfills.set(clip.item, { item: clip.item, objectPath: state.objectPath });
      }
    }
  }

  return {
    clientId: input.clientId,
    days: dayPlans,
    shape,
    uploads: [...uploads.values()],
    tokenBackfills: [...tokenBackfills.values()],
    surplus,
    ambiguities,
  };
}

function planClipAction(args: {
  clip: QueueDay;
  slotName: "a" | "b";
  date: string;
  slotMs: number;
  past: boolean;
  asset: Asset | null;
  via: string | null;
  shape: ClipShape;
  local: LocalClip | null;
  bucket: BucketClipState | null;
  clientId: string;
  now: number;
  uploads: Map<string, { item: string; objectPath: string; localPath: string; bytes: number }>;
}): ClipAction {
  const { clip, asset, local, bucket } = args;
  const objectPath = clipObjectPath(args.clientId, clip.labRun);
  const base = {
    date: args.date,
    slot: args.slotName,
    item: clip.item,
    person: clip.person,
    assetId: asset?.id ?? null,
    via: args.via,
  };

  const hasObject = bucket?.exists === true;
  const videoUrl = hasObject ? bucket?.url ?? null : null;
  let needsUpload = false;
  if (!hasObject) {
    if (!local) {
      return {
        ...base,
        kind: "blocked",
        changes: [],
        payload: {},
        needsUpload: false,
        blockedReason: `no clip.mp4 in the bucket and none at clips/${clip.item}/`,
      };
    }
    needsUpload = true;
    args.uploads.set(clip.item, {
      item: clip.item,
      objectPath,
      localPath: local.mp4Path,
      bytes: local.mp4Bytes,
    });
  }

  // The clip's own bytes decide the meta.files entry; the bucket's reported size
  // is the fallback for an object this run did not upload.
  const bytes = local?.mp4Bytes ?? bucket?.sizeBytes ?? 0;
  const caption = local?.caption ?? "";
  const about = local?.about ?? "";
  // The client's own chip when it has one; the per-item derivation only when
  // there is nothing to copy (see deriveClipShape).
  const template = args.shape.templateKey
    ? { key: args.shape.templateKey, name: args.shape.templateName ?? args.shape.templateKey }
    : templateFromItemKey(clip.item);
  const marker = {
    portalFeedItem: clip.item,
    portalFeedSlot: args.slotName,
    portalFeedDate: args.date,
    portalFeedSyncedAt: args.now,
  };

  if (!asset) {
    const doc: Record<string, unknown> = {
      clientId: args.clientId,
      jobId: null,
      agentId: null,
      type: args.shape.type,
      title: clip.person,
      content: caption,
      meta: {
        source: "lab-import",
        labRun: clip.labRun,
        agentFolder: splitLabRun(clip.labRun).runKey.split("/")[0],
        ...(about ? { about } : {}),
        files: mergeClipFile(null, {
          name: "clip.mp4",
          relPath: "clip.mp4",
          // A blocked clip never reaches here; an upload's URL is stitched in at
          // apply time (the token does not exist until the object does).
          url: videoUrl ?? "",
          bytes,
        }),
        ...marker,
      },
      imageUrl: null,
      mimeType: "video/mp4",
      ...(args.shape.channels ? { channels: args.shape.channels } : {}),
      ...(args.shape.scheduledPlatform ? { scheduledPlatform: args.shape.scheduledPlatform } : {}),
      status: args.past ? "published" : "scheduled",
      scheduledAt: args.slotMs,
      ...(args.past ? { publishedAt: args.slotMs } : {}),
      publishMode: "manual",
      ...(template ? { templateKey: template.key, templateName: template.name } : {}),
      orderKey: clip.orderKey,
      createdBy: CREATED_BY,
      createdAt: args.now,
      updatedAt: args.now,
    };
    return {
      ...base,
      kind: "create",
      changes: ["title", "content", "meta.files", "scheduledAt", "status", "orderKey"],
      payload: doc,
      needsUpload,
    };
  }

  const patch: Record<string, unknown> = {};
  const metaPatch: Record<string, unknown> = { ...marker };
  const changes: string[] = [];

  if (asset.title !== clip.person) {
    patch.title = clip.person;
    changes.push("title");
  }
  // Only fill an EMPTY body. A caption a human replaced in the portal is a
  // deliberate edit, and overwriting it would make the sync destructive.
  if (caption && !asset.content?.trim()) {
    patch.content = caption;
    changes.push("content");
  }
  if (typeof asset.meta?.labRun !== "string") {
    metaPatch.labRun = clip.labRun;
    changes.push("meta.labRun");
  }
  if (typeof asset.meta?.agentFolder !== "string") {
    metaPatch.agentFolder = splitLabRun(clip.labRun).runKey.split("/")[0];
    changes.push("meta.agentFolder");
  }
  if (about && typeof asset.meta?.about !== "string") {
    metaPatch.about = about;
    changes.push("meta.about");
  }
  const alreadyPlayable = videoUrl != null && assetVideos(asset).some((v) => v.url === videoUrl);
  if (!alreadyPlayable) {
    metaPatch.files = mergeClipFile(asset.meta?.files, {
      name: "clip.mp4",
      relPath: "clip.mp4",
      url: videoUrl ?? "",
      bytes,
    });
    changes.push("meta.files");
    if (!asset.imageUrl && asset.mimeType !== "video/mp4") {
      patch.mimeType = "video/mp4";
      changes.push("mimeType");
    }
  }
  if (asset.orderKey !== clip.orderKey) {
    patch.orderKey = clip.orderKey;
    changes.push("orderKey");
  }
  // templateKey is NOT reconciled on an existing document. It is the chip a
  // client already sees and the series `blockingPredecessor` gates on, and the
  // queue has no opinion about it - re-deriving one per item here would split a
  // single "podcast clip" series into 227 series of one.

  // DAY semantics, not instant semantics: an asset already on the right day keeps
  // the exact time it was given (including whatever hour a human chose), and only
  // a wrong day is rewritten - to the same hour it already had.
  const currentAt = asset.scheduledAt ?? asset.publishedAt ?? null;
  const onRightDay = currentAt != null && startOfDayMs(currentAt) === startOfDayMs(args.slotMs);
  if (!onRightDay) {
    const keepHour = currentAt != null ? new Date(currentAt).getHours() : null;
    const target = keepHour != null ? slotForDate(args.date, keepHour) : args.slotMs;
    patch.scheduledAt = target;
    changes.push("scheduledAt");
    if (args.past) {
      patch.publishedAt = target;
      changes.push("publishedAt");
    }
  } else if (args.past && asset.publishedAt == null) {
    patch.publishedAt = currentAt;
    changes.push("publishedAt");
  }

  const wantStatus = args.past ? "published" : "scheduled";
  // A published past day is left published; an approved future day is already a
  // calendar entity under postKind, so it is not churned to "scheduled".
  const statusOk = args.past
    ? asset.status === "published"
    : asset.status === "scheduled" || asset.status === "approved";
  if (!statusOk) {
    patch.status = wantStatus;
    changes.push("status");
  }
  if (asset.publishMode == null) {
    patch.publishMode = "manual";
    changes.push("publishMode");
  }
  if (args.shape.scheduledPlatform && !asset.scheduledPlatform) {
    patch.scheduledPlatform = args.shape.scheduledPlatform;
    changes.push("scheduledPlatform");
  }

  if (changes.length === 0) {
    return { ...base, kind: "unchanged", changes: [], payload: {}, needsUpload };
  }
  patch.meta = { ...(asset.meta ?? {}), ...metaPatch };
  patch.updatedAt = args.now;
  return { ...base, kind: "update", changes, payload: patch, needsUpload };
}

function planCarouselAction(args: {
  date: string;
  past: boolean;
  slotMs: number;
  igDays: IgDay[];
  sentLog: SentLog;
  index: Map<string, Asset[]>;
  taken: Set<Asset>;
  now: number;
}): CarouselAction {
  const { entry, sentName, agrees } = resolveDayCarousel(args.date, args.igDays, args.sentLog);
  if (!entry) {
    const lastCarousel = args.igDays.length > 0 ? args.igDays[args.igDays.length - 1].date : "";
    const exhausted = lastCarousel !== "" && args.date > lastCarousel;
    return {
      date: args.date,
      status: exhausted ? "queue-exhausted" : "no-queue-entry",
      item: null,
      assetId: null,
      changes: [],
      payload: {},
      ...(sentName ? { note: `sent-log recorded "${sentName}" but ig-queue.json has no entry for this day` } : {}),
    };
  }
  const hit = matchOne(args.index, igMatchKeys(entry), args.taken);
  if (hit.ambiguous) {
    return {
      date: args.date,
      status: "ambiguous",
      item: entry.item,
      assetId: null,
      changes: [],
      payload: {},
      note: `${hit.ambiguous.length} documents claim ${hit.via} (${hit.ambiguous.map((a) => a.id).join(", ")})`,
    };
  }
  if (!hit.asset) {
    return {
      date: args.date,
      status: "missing",
      item: entry.item,
      assetId: null,
      changes: [],
      payload: {},
      note: "no portal asset for this carousel; carousels are never created by this script",
    };
  }
  args.taken.add(hit.asset);
  const asset = hit.asset;

  // A carousel is only ever re-dated when the queue and the log agree about what
  // that day held. Two sources naming different carousels is exactly the case a
  // script must hand back rather than pick a winner in.
  if (!agrees) {
    return {
      date: args.date,
      status: "ambiguous",
      item: entry.item,
      assetId: asset.id,
      changes: [],
      payload: {},
      note: `ig-queue says "${entry.item}" and sent-log says "${sentName}"; date left alone`,
    };
  }

  const patch: Record<string, unknown> = {};
  const changes: string[] = [];
  const currentAt = asset.scheduledAt ?? asset.publishedAt ?? null;
  const onRightDay = currentAt != null && startOfDayMs(currentAt) === startOfDayMs(args.slotMs);
  if (!onRightDay) {
    const keepHour = currentAt != null ? new Date(currentAt).getHours() : null;
    const target = keepHour != null ? slotForDate(args.date, keepHour) : args.slotMs;
    patch.scheduledAt = target;
    changes.push("scheduledAt");
    if (args.past) {
      patch.publishedAt = target;
      changes.push("publishedAt");
    }
  } else if (args.past && asset.publishedAt == null) {
    patch.publishedAt = currentAt;
    changes.push("publishedAt");
  }
  const statusOk = args.past
    ? asset.status === "published"
    : asset.status === "scheduled" || asset.status === "approved";
  if (!statusOk) {
    patch.status = args.past ? "published" : "scheduled";
    changes.push("status");
  }
  if (asset.publishMode == null) {
    patch.publishMode = "manual";
    changes.push("publishMode");
  }

  if (changes.length === 0) {
    return { date: args.date, status: "ok", item: entry.item, assetId: asset.id, changes: [], payload: {} };
  }
  patch.updatedAt = args.now;
  return {
    date: args.date,
    status: changes.includes("scheduledAt") ? "redate" : "restatus",
    item: entry.item,
    assetId: asset.id,
    changes,
    payload: patch,
  };
}

/* ═════════════════════════ pure: reporting ═════════════════════════ */

function pad(s: string, n: number): string {
  return s.length >= n ? s.slice(0, n) : s + " ".repeat(n - s.length);
}

function clipCell(a: ClipAction | undefined): string {
  if (!a) return pad("(none)", 34);
  const tag =
    a.kind === "create" ? "NEW" : a.kind === "update" ? "UPD" : a.kind === "blocked" ? "!!!" : "ok ";
  return pad(`${tag} ${a.person}${a.needsUpload ? " +up" : ""}`, 34);
}

/** The per-day table the dry run prints. Pure so its shape is testable. */
export function renderPlanTable(plan: FeedPlan): string[] {
  const lines: string[] = [];
  lines.push(
    `${pad("date", 12)}${pad("d", 4)}${pad("when", 10)}${pad("clip A", 34)}${pad("clip B", 34)}carousel`,
  );
  for (const day of plan.days) {
    const carousel =
      day.carousel.status === "ok"
        ? "ok"
        : day.carousel.status === "queue-exhausted"
          ? "-"
          : `${day.carousel.status}${day.carousel.item ? ` (${day.carousel.item})` : ""}`;
    lines.push(
      pad(day.date, 12) +
        pad(String(day.order), 4) +
        pad(day.past ? "posted" : "scheduled", 10) +
        clipCell(day.clips[0]) +
        clipCell(day.clips[1]) +
        carousel,
    );
    for (const note of day.notes) lines.push(`${" ".repeat(16)}note: ${note}`);
    if (day.carousel.note) lines.push(`${" ".repeat(16)}carousel: ${day.carousel.note}`);
    for (const clip of day.clips) {
      if (clip.kind === "blocked") lines.push(`${" ".repeat(16)}blocked ${clip.item}: ${clip.blockedReason}`);
    }
  }
  return lines;
}

export interface PlanTotals {
  days: number;
  clipsPlanned: number;
  create: number;
  update: number;
  unchanged: number;
  blocked: number;
  uploads: number;
  uploadBytes: number;
  carouselOk: number;
  carouselChanged: number;
  carouselProblem: number;
  /** Days past the end of the carousel queue. Expected, not a fault. */
  carouselExhausted: number;
  surplus: number;
  /** Objects already in the bucket that carry no Firebase download token yet. */
  tokensNeeded: number;
}

export function planTotals(plan: FeedPlan): PlanTotals {
  const t: PlanTotals = {
    days: plan.days.length,
    clipsPlanned: 0,
    create: 0,
    update: 0,
    unchanged: 0,
    blocked: 0,
    uploads: plan.uploads.length,
    uploadBytes: plan.uploads.reduce((n, u) => n + u.bytes, 0),
    carouselOk: 0,
    carouselChanged: 0,
    carouselProblem: 0,
    carouselExhausted: 0,
    surplus: plan.surplus.length,
    tokensNeeded: plan.tokenBackfills.length,
  };
  for (const day of plan.days) {
    for (const clip of day.clips) {
      t.clipsPlanned++;
      if (clip.kind === "create") t.create++;
      else if (clip.kind === "update") t.update++;
      else if (clip.kind === "unchanged") t.unchanged++;
      else t.blocked++;
    }
    if (day.carousel.status === "ok") t.carouselOk++;
    else if (day.carousel.status === "redate" || day.carousel.status === "restatus") t.carouselChanged++;
    else if (day.carousel.status === "queue-exhausted") t.carouselExhausted++;
    else t.carouselProblem++;
  }
  return t;
}

/* ═════════════════════════ impure: routine folder ═════════════════════════ */

function readJson<T>(file: string): T {
  return JSON.parse(readFileSync(file, "utf8")) as T;
}

function readTextIfPresent(file: string): string {
  return existsSync(file) ? readFileSync(file, "utf8").trim() : "";
}

/** Everything the routine folder holds for the clip items this plan needs. */
export function readLocalClips(feedRoot: string, items: Iterable<string>): Map<string, LocalClip> {
  const out = new Map<string, LocalClip>();
  for (const item of items) {
    const dir = path.join(feedRoot, "clips", item);
    const mp4 = path.join(dir, "clip.mp4");
    if (!existsSync(mp4)) continue;
    out.set(item, {
      caption: readTextIfPresent(path.join(dir, "caption.txt")),
      about: readTextIfPresent(path.join(dir, "about.txt")),
      mp4Path: mp4,
      mp4Bytes: statSync(mp4).size,
    });
  }
  return out;
}

/* ═════════════════════════ impure: main ═════════════════════════ */

function loadEnv() {
  for (const name of [".env.local", ".env"]) {
    const file = path.join(ROOT, name);
    if (!existsSync(file)) continue;
    for (const line of readFileSync(file, "utf8").split("\n")) {
      const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*?)\s*$/);
      if (!m) continue;
      let v = m[2];
      if ((v.startsWith('"') && v.endsWith('"')) || (v.startsWith("'") && v.endsWith("'"))) {
        v = v.slice(1, -1);
      }
      if (!(m[1] in process.env)) process.env[m[1]] = v;
    }
  }
}

function argValue(argv: string[], name: string): string | null {
  const eq = argv.find((a) => a.startsWith(`--${name}=`));
  if (eq) return eq.slice(name.length + 3);
  const i = argv.indexOf(`--${name}`);
  return i >= 0 && i + 1 < argv.length && !argv[i + 1].startsWith("--") ? argv[i + 1] : null;
}

function serviceAccount(): { projectId: string; clientEmail: string; privateKey: string } {
  const raw = process.env.FIREBASE_SERVICE_ACCOUNT_KEY;
  if (raw) {
    const p = JSON.parse(raw) as { project_id: string; client_email: string; private_key: string };
    return { projectId: p.project_id, clientEmail: p.client_email, privateKey: p.private_key };
  }
  const projectId = process.env.FIREBASE_PROJECT_ID;
  const clientEmail = process.env.FIREBASE_CLIENT_EMAIL;
  const privateKey = process.env.FIREBASE_PRIVATE_KEY?.replace(/\\n/g, "\n");
  if (!projectId || !clientEmail || !privateKey) {
    throw new Error(
      "No Firebase credentials. Set FIREBASE_SERVICE_ACCOUNT_KEY or the three discrete FIREBASE_* vars in .env.local",
    );
  }
  return { projectId, clientEmail, privateKey };
}

async function main() {
  const argv = process.argv.slice(2);
  const apply = argv.includes("--apply");
  const feedRoot = path.resolve(argValue(argv, "feed-root") ?? DEFAULT_FEED_ROOT);
  const clientArg = argValue(argv, "client");
  const clientId = clientArg ?? PBD_CLIENT_ID;
  const todayArg = argValue(argv, "today");
  const slotHourArg = argValue(argv, "slot-hour");
  const limitArg = argValue(argv, "limit");
  const slotHour = slotHourArg ? Number.parseInt(slotHourArg, 10) : CHAIN_SLOT_HOUR;
  const limitDays = limitArg ? Number.parseInt(limitArg, 10) : undefined;

  if (clientArg && clientArg !== PBD_CLIENT_ID) {
    console.log(
      `NOTE: --client ${clientArg} overrides the built-in Pitch by Deel id. The feed files at\n` +
        `      ${feedRoot} describe one client; make sure it is this one.\n`,
    );
  }
  if (!Number.isInteger(slotHour) || slotHour < 0 || slotHour > 23) {
    console.error(`--slot-hour must be 0..23 (got ${slotHourArg})`);
    process.exit(1);
  }
  for (const file of ["publish-queue.json", "ig-queue.json", "sent-log.json"]) {
    if (!existsSync(path.join(feedRoot, file))) {
      console.error(`Feed folder ${feedRoot} has no ${file}. Pass --feed-root PATH.`);
      process.exit(1);
    }
  }

  loadEnv();
  const bucketName = process.env.NEXT_PUBLIC_FIREBASE_STORAGE_BUCKET;
  if (!bucketName) {
    console.error("NEXT_PUBLIC_FIREBASE_STORAGE_BUCKET is not set (the clips live in Firebase Storage)");
    process.exit(1);
  }

  const queue = readJson<PublishQueue>(path.join(feedRoot, "publish-queue.json"));
  const ig = readJson<IgQueue>(path.join(feedRoot, "ig-queue.json"));
  const sentLog = readJson<SentLog>(path.join(feedRoot, "sent-log.json"));

  console.log(
    apply
      ? "APPLYING Pitch by Deel portal-feed sync\n"
      : "DRY RUN. Reads Firestore and the bucket, writes nothing. Pass --apply to write.\n",
  );
  console.log(`  feed root: ${feedRoot}`);
  console.log(`  client:    ${clientId}`);
  console.log(`  bucket:    ${bucketName}`);
  console.log(`  queue:     ${queue.days.length} clip positions -> ${calendarDays(queue.days).length} calendar days`);
  console.log(`  carousels: ${ig.days.length} days (${ig.days[0]?.date} .. ${ig.days[ig.days.length - 1]?.date})`);
  console.log(`  sent-log:  ${Object.keys(sentLog).length} recorded days\n`);

  const { initializeApp, cert } = await import("firebase-admin/app");
  const { getFirestore } = await import("firebase-admin/firestore");
  const { Storage } = await import("@google-cloud/storage");
  const sa = serviceAccount();
  initializeApp({ credential: cert(sa) });
  const db = getFirestore();
  db.settings({ ignoreUndefinedProperties: true });
  const bucket = new Storage({
    projectId: sa.projectId,
    credentials: { client_email: sa.clientEmail, private_key: sa.privateKey },
  }).bucket(bucketName);

  const clientSnap = await db.collection("clients").doc(clientId).get();
  if (!clientSnap.exists) {
    console.error(`Client ${clientId} not found`);
    process.exit(1);
  }
  const client = clientSnap.data() as Client;
  const assetsSnap = await db.collection("assets").where("clientId", "==", clientId).get();
  const assets = assetsSnap.docs.map((d) => ({ id: d.id, ...(d.data() as Omit<Asset, "id">) }));
  console.log(`  read ${assets.length} assets for ${client.name ?? clientId}\n`);

  // Which clip items this run needs, so only those are read off disk and probed.
  const days = calendarDays(queue.days);
  const planning = limitDays != null ? days.slice(0, limitDays) : days;
  const wantedItems = new Set<string>();
  for (const day of planning) {
    for (const clip of resolveDayClips(day, queue.days, sentLog).clips) wantedItems.add(clip.item);
  }
  const localClips = readLocalClips(feedRoot, wantedItems);
  console.log(`  ${localClips.size}/${wantedItems.size} clip items have a local clip.mp4`);

  // A 404 means "upload it". ANY OTHER failure (IAM, wrong bucket, network) must
  // not be read as absence: that would mistake a permissions problem for an empty
  // bucket and re-upload 3 GB over objects that are already there. Non-404s are
  // collected and block --apply instead.
  process.stdout.write(`  probing the bucket for ${wantedItems.size} clip objects`);
  const bucketState = new Map<string, BucketClipState>();
  const probeErrors: string[] = [];
  let probed = 0;
  for (const item of wantedItems) {
    const labRun = queue.days.find((d) => d.item === item)?.labRun ?? "";
    const objectPath = clipObjectPath(clientId, labRun);
    const file = bucket.file(objectPath);
    try {
      const [meta] = await file.getMetadata();
      const token = String(meta.metadata?.firebaseStorageDownloadTokens ?? "").split(",")[0];
      bucketState.set(item, {
        objectPath,
        exists: true,
        url: token ? firebaseDownloadUrl(bucketName, objectPath, token) : null,
        sizeBytes: Number(meta.size ?? 0),
      });
    } catch (err) {
      const code = (err as { code?: number }).code;
      if (code !== 404) probeErrors.push(`${item}: ${(err as Error).message}`);
      bucketState.set(item, { objectPath, exists: false, url: null });
    }
    if (++probed % 25 === 0) process.stdout.write(".");
  }
  process.stdout.write("\n");
  if (probeErrors.length > 0) {
    console.log(`\n  ! ${probeErrors.length} bucket probe(s) failed for a reason other than "not found":`);
    for (const e of probeErrors.slice(0, 5)) console.log(`      ${e}`);
    console.log("    Those clips read as absent below, which is almost certainly wrong.");
  }
  console.log("");

  const now = Date.now();
  const todayMs = todayArg ? dayStartForDate(todayArg) : now;
  const plan = planPortalFeed({
    clientId,
    bucket: bucketName,
    queue,
    ig,
    sentLog,
    assets,
    localClips,
    bucketState,
    todayMs,
    now,
    slotHour,
    ...(limitDays != null ? { limitDays } : {}),
  });

  for (const line of renderPlanTable(plan)) console.log(line);

  const totals = planTotals(plan);
  const pace = resolveDailyPace(client.dailyPace);
  console.log("\n── Summary ─────────────────────────────────────────────");
  console.log(`   Calendar days:  ${totals.days}   (${todayArg ?? new Date(todayMs).toISOString().slice(0, 10)} is the past/future line)`);
  console.log(`   Clips planned:  ${totals.clipsPlanned}   new ${totals.create} · updated ${totals.update} · already right ${totals.unchanged} · blocked ${totals.blocked}`);
  console.log(
    `   Uploads:        ${totals.uploads} clip(s), ${(totals.uploadBytes / 1e6).toFixed(0)} MB` +
      `${totals.tokensNeeded > 0 ? ` · ${totals.tokensNeeded} object(s) need a download token added` : ""}`,
  );
  console.log(
    `   Carousels:      ok ${totals.carouselOk} · changed ${totals.carouselChanged} · needs a human ${totals.carouselProblem}` +
      ` · ${totals.carouselExhausted} day(s) past the end of the carousel queue`,
  );
  console.log(`   Surplus:        ${totals.surplus} asset(s) matching nothing in the queues (never touched)`);
  console.log(
    `   Client pace:    clips/day ${pace.clipsPerDay}, posts/day ${pace.postsPerDay}` +
      `${pace.configured ? "" : " (UNCONFIGURED: the two lanes share one slot a day)"}`,
  );
  if (pace.clipsPerDay < 2) {
    console.log("   ! Set dailyPace.clipsPerDay to 2 on the client, or the chain still plans future clips one a day.");
  }
  console.log("────────────────────────────────────────────────────────");

  if (plan.surplus.length > 0) {
    console.log(`\nSURPLUS (${plan.surplus.length}) - matched no queue entry. Judge these by hand:`);
    for (const s of plan.surplus.slice(0, 40)) {
      const when = s.scheduledAt ? new Date(s.scheduledAt).toISOString().slice(0, 10) : "undated";
      console.log(`   ${s.id}  ${when}  ${s.title}   [${s.reason}]`);
    }
    if (plan.surplus.length > 40) console.log(`   ... and ${plan.surplus.length - 40} more`);
  }
  if (plan.ambiguities.length > 0) {
    console.log(`\nAMBIGUITIES (${plan.ambiguities.length}) - nothing was decided for these:`);
    for (const a of plan.ambiguities) console.log(`   ${a}`);
  }

  if (!apply) {
    console.log("\nDRY RUN complete. Nothing was written. Re-run with --apply once the plan reads right.");
    return;
  }
  if (probeErrors.length > 0) {
    console.error(
      `\nREFUSING TO APPLY: ${probeErrors.length} bucket probe(s) failed for a reason other than "not found",\n` +
        "so the plan cannot tell an absent clip from an unreadable one and would re-upload over live objects.\n" +
        "Fix the bucket access and re-run the dry run first.",
    );
    process.exit(1);
  }

  // ── uploads ────────────────────────────────────────────────────────
  // Idempotent by construction: the plan only lists objects the probe found
  // missing, and each upload sets its own Firebase download token so the URL is
  // durable rather than a 7-day signed link.
  const { randomUUID } = await import("node:crypto");
  const urlByItem = new Map<string, string>();
  for (const [item, state] of bucketState) {
    if (state.exists && state.url) urlByItem.set(item, state.url);
  }
  // An object that exists but predates the token convention gets one added
  // rather than 12 MB re-uploaded to mint one.
  for (const backfill of plan.tokenBackfills) {
    const token = randomUUID();
    await bucket.file(backfill.objectPath).setMetadata({
      metadata: { firebaseStorageDownloadTokens: token },
    });
    urlByItem.set(backfill.item, firebaseDownloadUrl(bucketName, backfill.objectPath, token));
    console.log(`  token added: ${backfill.objectPath}`);
  }
  if (plan.uploads.length > 0) {
    console.log(`\nUploading ${plan.uploads.length} clip(s), ${(totals.uploadBytes / 1e6).toFixed(0)} MB total`);
  }
  let uploaded = 0;
  for (const up of plan.uploads) {
    const token = randomUUID();
    await bucket.upload(up.localPath, {
      destination: up.objectPath,
      // Resumable above 5 MB: the median clip is 12 MB and the largest 36 MB, so
      // a dropped connection mid-batch resumes instead of restarting.
      resumable: up.bytes > 5 * 1024 * 1024,
      contentType: "video/mp4",
      metadata: { contentType: "video/mp4", metadata: { firebaseStorageDownloadTokens: token } },
    });
    urlByItem.set(up.item, firebaseDownloadUrl(bucketName, up.objectPath, token));
    uploaded++;
    console.log(`  [${uploaded}/${plan.uploads.length}] ${up.item} (${(up.bytes / 1e6).toFixed(1)} MB)`);
  }

  // ── writes ─────────────────────────────────────────────────────────
  // The URL of a just-uploaded object did not exist at planning time, so it is
  // stitched into the payload here. Everything else was decided by the planner.
  let created = 0;
  let updated = 0;
  let batch = db.batch();
  let pending = 0;
  const flush = async () => {
    if (pending === 0) return;
    await batch.commit();
    batch = db.batch();
    pending = 0;
  };

  for (const day of plan.days) {
    for (const clip of day.clips) {
      if (clip.kind === "unchanged" || clip.kind === "blocked") continue;
      const url = urlByItem.get(clip.item);
      const payload = withClipUrl(clip.payload, url ?? "");
      if (clip.kind === "create") {
        batch.set(db.collection("assets").doc(), payload);
        created++;
      } else if (clip.assetId) {
        batch.set(db.collection("assets").doc(clip.assetId), payload, { merge: true });
        updated++;
      }
      if (++pending >= 400) await flush();
    }
    const c = day.carousel;
    if ((c.status === "redate" || c.status === "restatus") && c.assetId) {
      batch.set(db.collection("assets").doc(c.assetId), c.payload, { merge: true });
      updated++;
      if (++pending >= 400) await flush();
    }
  }
  await flush();

  console.log(`\nAPPLIED. ${created} clip(s) created, ${updated} document(s) updated, ${uploaded} clip(s) uploaded.`);
  console.log("  Open the client calendar: every day from 2026-07-24 should now read two clips plus one carousel.");
}

/** Stitch a just-minted download URL into the clip.mp4 entry of a payload. */
export function withClipUrl(payload: Record<string, unknown>, url: string): Record<string, unknown> {
  const meta = payload.meta;
  if (!url || typeof meta !== "object" || meta === null) return payload;
  const m = meta as Record<string, unknown>;
  if (!Array.isArray(m.files)) return payload;
  const files = (m.files as Array<Record<string, unknown>>).map((f) =>
    String(f?.name ?? "").toLowerCase() === "clip.mp4" && !f.url ? { ...f, url } : f,
  );
  return { ...payload, meta: { ...m, files } };
}

if (require.main === module) {
  main().catch((e) => {
    console.error(e);
    process.exit(1);
  });
}
