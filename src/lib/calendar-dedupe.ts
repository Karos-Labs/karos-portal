/**
 * Presentation-layer defence against duplicate calendar cells.
 *
 * The calendar renders whatever it is handed: `calendar-body.tsx` maps assets
 * 1:1 into `CalendarPost` and `run-calendar.tsx` buckets those by day. So one
 * duplicated Firestore document is one duplicated square on the month grid —
 * which is exactly what the product owner scrolled past on the 30 Jul call
 * ("this is duplicated, this also"), on data that pre-dated the bulk upload he
 * ran later in the same session.
 *
 * The write-side hole that produced those duplicates is closed separately (the
 * "complete" step of api/assets/bulk-upload is idempotent on `meta.gcsPath`,
 * and `importLabRunAction` is idempotent on `meta.labRun` — both against a
 * deterministic Firestore id, see `lib/data.ts`'s `createAsset` overload).
 * This module is the other half: production already holds the documents those
 * holes created before their fixes landed, no cleanup has run, and a client
 * refreshing their calendar must not see them. Nothing here deletes anything —
 * survivors are chosen for RENDER only, and every document stays where it is.
 *
 * TWO SIGNALS REACH THE SCREEN, and each has to be a fact rather than a guess,
 * because the cost of a wrong merge is a client's real post disappearing:
 *
 *   gcsPath — two documents of one client pointing at the same object in the
 *   bucket WHOSE PLACEMENT AGREES. The shared path alone is not enough. Using
 *   one clip twice is ordinary work here — the same podcast cut scheduled for
 *   two different days is two real posts, and collapsing that pair would show
 *   one and silently hide the other. So a shared-path set only collapses when
 *   at most one day is claimed across it: every copy sits on that day, or has
 *   no placement at all. Two dated copies on different days stay two posts.
 *
 *   labRun — two documents of one client importing the same lab-generated
 *   item. Placement agreement is NOT required here: a lab-import item is a
 *   one-shot generated deliverable with no legitimate "reuse on a different
 *   day" (unlike a clip, nothing schedules the same generated carousel twice
 *   on purpose — see `assetLabRun`'s docstring), so any shared labRun collapses
 *   regardless of which days the copies landed on.
 *
 * The title/day rule below is REPORTING ONLY and never runs on the render path.
 * Two posts on one day whose titles normalise alike is the ordinary shape of a
 * templated content plan, not evidence of a replay. A heuristic may tell staff
 * about a suspicion — it may not take a post off a client's screen. It exists
 * for `scripts/find-duplicate-assets.ts`, which prints it for a human and never
 * deletes from it.
 *
 * Deliberately NOT a scheduling decision. Reconciling a client's dates is the
 * slot planner's job and must land as one change against real data; merging
 * identical cells is presentation and nothing more.
 */

import { postKind, type CalendarKindInput } from "@/lib/calendar-kind";

/** Which signal grouped a set of assets together. */
export type DuplicateKind = "gcsPath" | "labRun" | "titleDay";

/**
 * Minimal shape this needs from an Asset — kept narrow (same reasoning as
 * `CalendarKindInput`) so a script can pass a raw Firestore document and a
 * server component can pass a domain `Asset` without either taking a
 * dependency on the other.
 */
export interface CalendarDedupeAsset {
  id: string;
  clientId: string;
  title: string;
  status?: CalendarKindInput["status"];
  scheduledAt?: number;
  publishedAt?: number;
  publishMode?: string;
  publishError?: string;
  createdAt: number;
  meta?: Record<string, unknown>;
}

export interface DuplicateGroup<T extends CalendarDedupeAsset> {
  kind: DuplicateKind;
  clientId: string;
  /** Human-readable identity of the group (the gcsPath, or "YYYY-MM-DD · title"). */
  label: string;
  /** Every member, in the order they appeared in the input. */
  members: T[];
  /** The copy `dedupeCalendarAssets` keeps and the cleanup script would preserve. */
  survivor: T;
}

/**
 * Key separator. PRINTABLE on purpose: a `\0` separator makes the whole file
 * binary to git (unreviewable in a diff) and silently defeats plain `grep` —
 * src/lib/seo-geo.ts already does exactly that to us, and one instance of that
 * trap in the repo is one too many.
 *
 * Unambiguous despite being an ordinary character: each key is
 * `clientId | <fixed tag> | …`, the tag sits at a fixed position, and the
 * free-form segment (a gcsPath, a normalised title) is always LAST — so a "|"
 * inside it has nothing after it to shift. Only a clientId containing the
 * separator could forge a collision, and these are Firestore document ids.
 */
const KEY_SEP = "|";

/** The durable GCS object this asset was registered from, when it has one. */
export function assetGcsPath(a: CalendarDedupeAsset): string | null {
  const path = a.meta?.gcsPath;
  return typeof path === "string" && path.trim() !== "" ? path.trim() : null;
}

/**
 * The lab-import item this asset came from, when it has one — the same
 * `${agentFolder}/${runName}#${itemKey}` identity `importLabRunAction` checks
 * before creating (lib/actions/lab-output-actions.ts), and its durable
 * per-item id in `lib/lab-outputs-shared.ts`'s `labImportAssetId`. A gcsPath
 * asset and a labRun asset are two different ingest paths (bulk-uploaded clip
 * vs. lab-imported deliverable) so an asset never carries both; treated as the
 * exact parallel of `assetGcsPath` below.
 */
export function assetLabRun(a: CalendarDedupeAsset): string | null {
  const run = a.meta?.labRun;
  return typeof run === "string" && run.trim() !== "" ? run.trim() : null;
}

/**
 * The day bucket, in UTC.
 *
 * Deliberately not the viewer's zone: a zone-dependent key would group
 * differently on a server in Tel Aviv than on one in London, and "which post
 * did the calendar hide" must not depend on where the render happened. A UTC
 * boundary can only ever split a pair across two buckets — it can never merge
 * two posts that are a day apart — so the error direction is "collapse less",
 * which is the safe one for anything that hides content.
 */
export function calendarDayKey(ms: number): string {
  return new Date(ms).toISOString().slice(0, 10);
}

/** Case- and whitespace-insensitive title, so "Clip 3 " and "clip 3" are one title. */
export function normalizeDedupeTitle(title: string): string {
  return (title ?? "").trim().replace(/\s+/g, " ").toLowerCase();
}

/**
 * The instant the calendar would place this asset on, or null if it has none.
 *
 * Mirrors what calendar-body actually reads for a post's day — a published post
 * carries `publishedAt` and frequently no `scheduledAt` at all, so anything
 * that asks "is this copy placed?" has to ask it through here. Reading
 * `scheduledAt` alone would rank a published post BELOW an undated stray and
 * take real, already-published work off the grid.
 */
export function calendarPlacedAt(a: CalendarDedupeAsset): number | null {
  if (typeof a.scheduledAt === "number") return a.scheduledAt;
  if (typeof a.publishedAt === "number") return a.publishedAt;
  return null;
}

/**
 * Whether this copy is one the calendar would draw at all (`postKind` is the
 * single owner of that question). A document with no status — a raw Firestore
 * row the cleanup script handed over without one — cannot be judged, so it
 * counts as not eligible and simply never outranks a copy that is.
 */
export function showsOnCalendar(a: CalendarDedupeAsset): boolean {
  if (!a.status) return false;
  return (
    postKind({
      status: a.status,
      scheduledAt: a.scheduledAt,
      publishedAt: a.publishedAt,
      publishMode: a.publishMode,
      publishError: a.publishError,
    }) != null
  );
}

function createdAtOf(a: CalendarDedupeAsset): number {
  return typeof a.createdAt === "number" && Number.isFinite(a.createdAt) ? a.createdAt : 0;
}

/**
 * Which of two copies of the same post the calendar keeps. Total and
 * deterministic — a tie broken by chance would reshuffle the grid on every
 * refresh, and "the duplicate moved" is a worse bug than the duplicate.
 *
 *   0. A copy the calendar would actually draw beats one it would not. A
 *      survivor that is not calendar-eligible must never suppress one that is;
 *      that is how a fix for duplicates ends up removing real content.
 *   1. Then a copy with a placement (`calendarPlacedAt`, so publishedAt counts)
 *      beats one without. The placed copy owns a square; an unplaced twin is a
 *      stray.
 *   2. Then the oldest `createdAt` — the original, not the replay that copied it.
 *   3. Then the lexicographically smaller document id. Firestore ids are
 *      arbitrary, but they are stable, which is the whole point of this rung:
 *      two replays written inside the same millisecond still resolve the same
 *      way on every load.
 *
 * Negative when `a` should survive.
 */
export function compareSurvivors(a: CalendarDedupeAsset, b: CalendarDedupeAsset): number {
  const aShown = showsOnCalendar(a) ? 0 : 1;
  const bShown = showsOnCalendar(b) ? 0 : 1;
  if (aShown !== bShown) return aShown - bShown;

  const aPlaced = calendarPlacedAt(a) == null ? 1 : 0;
  const bPlaced = calendarPlacedAt(b) == null ? 1 : 0;
  if (aPlaced !== bPlaced) return aPlaced - bPlaced;

  const aCreated = createdAtOf(a);
  const bCreated = createdAtOf(b);
  if (aCreated !== bCreated) return aCreated - bCreated;

  return a.id < b.id ? -1 : a.id > b.id ? 1 : 0;
}

/** The survivor of a non-empty group, under `compareSurvivors`. */
export function pickSurvivor<T extends CalendarDedupeAsset>(members: T[]): T {
  return members.reduce((best, m) => (compareSurvivors(m, best) < 0 ? m : best));
}

/** A set of documents that look like copies of one another. */
interface CandidateSet<T extends CalendarDedupeAsset> {
  kind: DuplicateKind;
  clientId: string;
  label: string;
  members: T[];
}

/**
 * The shared-path key. Always client-scoped, so two clients whose object paths
 * somehow collided never merge.
 */
function sharedPathKey(a: CalendarDedupeAsset): { key: string; label: string } | null {
  const gcsPath = assetGcsPath(a);
  if (!gcsPath) return null;
  return { key: `${a.clientId}${KEY_SEP}gcs${KEY_SEP}${gcsPath}`, label: gcsPath };
}

/**
 * The lab-import equivalent of `sharedPathKey`. `importLabRunAction` closes
 * the sequential-replay shape of this race at the write side
 * (`createAssetIfAbsent` on a deterministic id) but that guard did not exist
 * when the documents already in production were written, so the render path
 * needs the same defence `sharedPathKey` gives bulk-uploaded clips.
 */
function sharedLabRunKey(a: CalendarDedupeAsset): { key: string; label: string } | null {
  const labRun = assetLabRun(a);
  if (!labRun) return null;
  return { key: `${a.clientId}${KEY_SEP}labrun${KEY_SEP}${labRun}`, label: labRun };
}

/**
 * The reporting-only key: same client, same day, same normalised title, and no
 * gcsPath at all (the older duplicates, from before bulk upload existed). It
 * needs a real title and a real placement — an untitled asset, or one with no
 * place on the calendar, groups with nothing rather than pooling with every
 * other blank.
 */
function titleDayKey(a: CalendarDedupeAsset): { key: string; label: string } | null {
  if (assetGcsPath(a)) return null;
  const at = calendarPlacedAt(a);
  const title = normalizeDedupeTitle(a.title);
  if (at == null || title === "") return null;
  const day = calendarDayKey(at);
  return {
    key: `${a.clientId}${KEY_SEP}day${KEY_SEP}${day}${KEY_SEP}${title}`,
    label: `${day} · ${a.title}`,
  };
}

/** Bucket by a key, preserving the order each bucket first appeared in. */
function bucketBy<T extends CalendarDedupeAsset>(
  assets: T[],
  kind: DuplicateKind,
  keyOf: (a: T) => { key: string; label: string } | null,
): CandidateSet<T>[] {
  const order: CandidateSet<T>[] = [];
  const byKey = new Map<string, CandidateSet<T>>();

  for (const a of assets) {
    const keyed = keyOf(a);
    if (!keyed) continue;
    const existing = byKey.get(keyed.key);
    if (existing) {
      existing.members.push(a);
      continue;
    }
    const bucket: CandidateSet<T> = { kind, clientId: a.clientId, label: keyed.label, members: [a] };
    byKey.set(keyed.key, bucket);
    order.push(bucket);
  }

  return order;
}

/**
 * Narrow one shared-path bucket down to the sets that actually look like a
 * replay, by asking whether the copies agree about WHERE they sit.
 *
 *   - At most one day claimed across the bucket (every copy on that day, or
 *     undated, or all of them undated) — one post written more than once.
 *     Collapse.
 *   - Two or more days claimed — the clip is deliberately reused. Each day
 *     keeps its own post; copies within a single day are still replays of each
 *     other and collapse among themselves. An undated stray is left alone here,
 *     because there is no honest way to say which of the days it belongs to.
 */
function splitByPlacement<T extends CalendarDedupeAsset>(bucket: CandidateSet<T>): CandidateSet<T>[] {
  if (bucket.members.length < 2) return [bucket];

  const byDay = new Map<string, T[]>();
  const undated: T[] = [];
  for (const m of bucket.members) {
    const at = calendarPlacedAt(m);
    if (at == null) {
      undated.push(m);
      continue;
    }
    const day = calendarDayKey(at);
    const onDay = byDay.get(day);
    if (onDay) onDay.push(m);
    else byDay.set(day, [m]);
  }

  if (byDay.size <= 1) return [bucket];

  const split: CandidateSet<T>[] = [];
  for (const [day, members] of byDay) {
    split.push({ ...bucket, label: `${bucket.label} · ${day}`, members });
  }
  for (const stray of undated) {
    split.push({ ...bucket, label: `${bucket.label} · undated`, members: [stray] });
  }
  return split;
}

/** The only signal allowed to hide a post: shared object path, agreeing placement. */
function sharedPathSets<T extends CalendarDedupeAsset>(assets: T[]): CandidateSet<T>[] {
  return bucketBy(assets, "gcsPath", sharedPathKey).flatMap(splitByPlacement);
}

/**
 * Same identity-sharing defence, keyed on the lab-import item instead of a GCS
 * object path — but WITHOUT `splitByPlacement`. That split exists because
 * reusing a bulk-uploaded clip on two different days is ordinary, ongoing work
 * (the same podcast cut, scheduled twice on purpose) — so gcsPath duplicates
 * only collapse when every copy agrees on where it sits.
 *
 * A lab-import item has no such legitimate reuse: `importLabRunAction` mints
 * one item per generated deliverable and there is no staff action that
 * schedules that same generated carousel a second time on a different day —
 * dates are assigned by the post-create chain reflow, never chosen per item.
 * So two assets sharing one `meta.labRun` are always copies of the SAME
 * import, however far apart the reflow happened to land them (the race this
 * closes creates exactly that shape: a retry's items pick up wherever the
 * chain planner's next open slot was, which is rarely the day right after the
 * original's).
 */
function sharedLabRunSets<T extends CalendarDedupeAsset>(assets: T[]): CandidateSet<T>[] {
  return bucketBy(assets, "labRun", sharedLabRunKey);
}

/**
 * Every group holding more than one copy, high-confidence (`gcsPath`) groups
 * first and the reporting-only heuristic after them. Used by the cleanup script
 * to print a plan for a human; the calendar itself only ever calls
 * `dedupeCalendarAssets`, which does not consider `titleDay` at all.
 */
export function findDuplicateGroups<T extends CalendarDedupeAsset>(assets: T[]): DuplicateGroup<T>[] {
  return [...sharedPathSets(assets), ...sharedLabRunSets(assets), ...bucketBy(assets, "titleDay", titleDayKey)]
    .filter((s) => s.members.length > 1)
    .map((s) => ({
      kind: s.kind,
      clientId: s.clientId,
      label: s.label,
      members: s.members,
      survivor: pickSurvivor(s.members),
    }));
}

/**
 * The input with the non-survivor of every replay set removed, in the input's
 * own order — each surviving asset keeps its own position, so dropping a copy
 * never reorders the rest.
 *
 * Empty input, a single asset, and an asset that matches no set all pass
 * straight through untouched.
 */
export function dedupeCalendarAssets<T extends CalendarDedupeAsset>(assets: T[]): T[] {
  const suppressed = new Set<string>();
  for (const set of [...sharedPathSets(assets), ...sharedLabRunSets(assets)]) {
    if (set.members.length < 2) continue;
    const survivor = pickSurvivor(set.members);
    for (const m of set.members) if (m.id !== survivor.id) suppressed.add(m.id);
  }
  return suppressed.size === 0 ? assets : assets.filter((a) => !suppressed.has(a.id));
}
