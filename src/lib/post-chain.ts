/**
 * The content chain — pure, deterministic per-day planning.
 *
 * Every schedulable asset carries a stable lexicographic `orderKey`
 * reconstructing internal lab generation order (`${runName}#${itemKey}`; run
 * names lead with YYYY-MM-DD), and `planClientChain` assigns assets to
 * server-local calendar days per client PER FAMILY (social / email / article
 * chains are independent, so one Instagram post and one newsletter may share a
 * day). HOW MANY a day holds is the client's own pace (lib/daily-pace), which
 * defaults to the one-per-day this planner has always done. The planner only
 * ever proposes dates — it never touches
 * status, so the /api/publish cron (status IN [scheduled, approved] only) can
 * never pick up a chain-planned draft.
 *
 * CLIENT-SAFE: no firebase-admin, no data.ts. May be imported by client
 * components, server actions, and scripts alike. All day math is runtime-local
 * and comes from scheduling.ts — see the re-export below. Timestamps are epoch
 * millis.
 */

import type { Asset, AssetType, ClientDailyPace, ManagedTaskType } from "@/lib/types";
import { MANAGED_PRODUCTS, getManagedProduct } from "@/lib/agent-service/products";
import { chainAllowsDay, startOfDayMs } from "@/lib/scheduling";
import { createDayLedger, paceLaneFor, resolveDailyPace, type PaceLane } from "@/lib/daily-pace";

/* ────────────────────────── day / slot math ────────────────────────── */

/**
 * The local-day primitives, RE-EXPORTED, not restated.
 *
 * This file used to carry its own `sameLocalDay` beside scheduling.ts's — two
 * exported functions, identical semantics, different bodies, and only one of
 * them with a production caller. Both import paths stay live (this module is
 * where the chain's callers already look for day math), but there is one body,
 * in scheduling.ts, and its docstring is where the runtime-timezone cost is
 * written down.
 */
export { startOfDayMs, sameLocalDay } from "@/lib/scheduling";

/** Hour of day (runtime-local) at which chain-assigned posts are slotted. */
export const CHAIN_SLOT_HOUR = 11;

/** The chain publication slot within a day: local midnight + CHAIN_SLOT_HOUR. */
export function chainSlotForDay(dayStartMs: number): number {
  const d = new Date(dayStartMs);
  d.setHours(CHAIN_SLOT_HOUR, 0, 0, 0);
  return d.getTime();
}

/** The following server-local midnight (DST-safe: uses Date#setDate, not +86400000). */
function nextDayStart(dayStartMs: number): number {
  const d = new Date(dayStartMs);
  d.setDate(d.getDate() + 1);
  d.setHours(0, 0, 0, 0);
  return d.getTime();
}

/* ─────────────────────────── chain families ────────────────────────── */

/**
 * Chains are planned per content family so a client can receive e.g. one
 * Instagram post AND one newsletter on the same day.
 */
export type ChainFamily = "social" | "email" | "article";

/** Which chain (if any) an asset type belongs to. "note" and unknown types are never chained. */
export function chainFamilyFor(type: AssetType): ChainFamily | null {
  switch (type) {
    case "instagram_post":
    case "social_post":
      return "social";
    case "email":
      return "email";
    case "article":
      return "article";
    default:
      return null;
  }
}

/** True for every asset type that participates in a content chain. */
export function isChainSchedulable(type: AssetType): boolean {
  return chainFamilyFor(type) !== null;
}

/* ──────────────────────────── order keys ───────────────────────────── */

/** Leading date (YYYY-MM-DD) or index (01-, 2., 3_) prefix on a lab item folder name. */
const ITEM_PREFIX_RE = /^(\d{4}-\d{2}-\d{2}|\d+)([-_.]|$)/;

/**
 * Order key for a lab-imported item: `${runName}#${itemKey}`. Run names lead
 * with YYYY-MM-DD and item keys keep their zero-padded/date prefix, so plain
 * localeCompare reproduces internal generation order. When the item folder has
 * NO date/number prefix but the run's data.json carried an internal date, the
 * date is injected so bare-slug items still sort by their internal date.
 */
export function orderKeyForLabItem(runName: string, itemKey: string, internalDate?: string): string {
  if (internalDate && !ITEM_PREFIX_RE.test(itemKey)) {
    return `${runName}#${internalDate}-${itemKey}`;
  }
  return `${runName}#${itemKey}`;
}

/**
 * Order key for non-lab sources (agent-service webhook, MCP): ISO timestamp +
 * unique suffix. Leads with a date like lab keys, so cross-source sorting
 * interleaves chronologically.
 */
export function orderKeyForCreatedAt(createdAt: number, uniq: string): string {
  return `${new Date(createdAt).toISOString()}#${uniq}`;
}

/**
 * Best-available order key for any asset, including legacy ones written before
 * orderKey existed: stored orderKey → meta.labRun (shape
 * `${agentFolder}/${runName}#${itemKey}`, agent folder stripped) → createdAt+id.
 */
export function deriveOrderKey(a: Pick<Asset, "orderKey" | "meta" | "createdAt" | "id">): string {
  if (typeof a.orderKey === "string" && a.orderKey.length > 0) return a.orderKey;
  const labRun = a.meta?.labRun;
  if (typeof labRun === "string" && labRun.includes("#")) {
    const slash = labRun.indexOf("/");
    return slash >= 0 ? labRun.slice(slash + 1) : labRun;
  }
  return orderKeyForCreatedAt(a.createdAt, a.id);
}

/* ─────────────────────────── the planner ───────────────────────────── */

export interface ChainAssignment {
  id: string;
  /** The designated chain slot (day start + CHAIN_SLOT_HOUR, server-local). */
  scheduledAt: number;
  /** deriveOrderKey(asset) — persisted alongside so legacy assets get backfilled. */
  orderKey: string;
}

const MANAGED_TASK_TYPES = new Set<string>(MANAGED_PRODUCTS.map((p) => p.taskType));

function metaString(a: Pick<Asset, "meta">, key: string): string | null {
  const v = a.meta?.[key];
  return typeof v === "string" ? v : null;
}

/**
 * Provenance guard: only assets the chain system created (or that already
 * carry a chain orderKey) may ever be (re-)dated. Legacy assets from removed
 * systems (e.g. meta.source === "content-engine") are never chain-assigned —
 * but their dated instances still occupy their family's days (see
 * planClientChain) so the chain never double-books a staff-filled day.
 *
 * A bare managed meta.taskType does NOT qualify: webhook assets created since
 * the chain shipped carry an orderKey, while pre-chain staff-dated managed
 * singles (no order signal) must keep the dates staff gave them.
 */
function hasChainProvenance(a: Pick<Asset, "meta" | "orderKey">): boolean {
  if (metaString(a, "source") === "lab-import") return true;
  return typeof a.orderKey === "string" && a.orderKey.length > 0;
}

/**
 * Plan a client's content chains — pure and deterministic (no Date.now()
 * inside; same inputs → same outputs; planning its own output emits nothing).
 *
 * Per family:
 *   PINNED (never moved):
 *     mode "reflow" (default, runtime): published assets (status or
 *       publishedAt), any non-draft asset with a scheduledAt (staff-booked),
 *       and drafts whose scheduledAt day is on/before today (already
 *       client-visible).
 *     mode "migrate" (one-off script): published assets, plus anything dated
 *       strictly before the chain start day.
 *   IGNORED entirely: publishMode "placeholder" roadmap items — they are
 *     calendar decorations, never chain candidates and never day occupancy.
 *   CANDIDATES: chain-schedulable, non-pinned, chain-provenance assets, not in
 *     opts.skipIds; drafts only in "reflow", any status in "migrate". Sorted by
 *     deriveOrderKey (id tiebreak).
 *   OCCUPANCY: every non-candidate (pinned or provenance-excluded or skipped)
 *     with a date books startOfDayMs(scheduledAt ?? publishedAt) in ITS LANE
 *     (clip / post, see lib/daily-pace) for its family.
 *
 * A day cursor PER LANE walks from opts.startDayMs ?? today, skipping days that
 * lane has already filled, assigning chainSlotForDay(day) to each candidate in
 * order. With no pace configured the two lanes share one counter per day, so the
 * pair of cursors reproduces the single one-per-day cursor exactly. Assignments
 * are emitted ONLY when they change the asset (different scheduledAt, or stored
 * orderKey missing/different), so re-planning planned output is a no-op.
 */
export function planClientChain(
  assets: Asset[],
  opts: {
    now: number;
    mode?: "reflow" | "migrate";
    startDayMs?: number;
    /**
     * Asset ids excluded from candidacy (dates untouched) while still counting
     * toward day occupancy — the migration's --skip flag (e.g. a post the data
     * says is unposted but a human knows went out).
     */
    skipIds?: string[];
    /** Restrict planning to these families (e.g. the migration's --family social). */
    families?: ChainFamily[];
    /**
     * The client's stored pace. Absent ⇒ one item a day, which is what this
     * planner did before the field existed — so every caller that has no client
     * record in hand (scripts, tests) keeps the old behaviour by saying nothing.
     */
    pace?: ClientDailyPace | null;
  },
): ChainAssignment[] {
  const mode = opts.mode ?? "reflow";
  const startDay = startOfDayMs(opts.startDayMs ?? opts.now);
  const today = startOfDayMs(opts.now);
  const skip = new Set(opts.skipIds ?? []);
  const familyFilter = opts.families ? new Set(opts.families) : null;
  const pace = resolveDailyPace(opts.pace);

  const isPinned = (a: Asset): boolean => {
    if (a.status === "published" || a.publishedAt != null) return true;
    if (mode === "migrate") {
      return a.scheduledAt != null && startOfDayMs(a.scheduledAt) < startDay;
    }
    // reflow: staff-booked dates and already-client-visible drafts never move.
    if (a.scheduledAt == null) return false;
    if (a.status !== "draft") return true;
    return startOfDayMs(a.scheduledAt) <= today;
  };

  const isCandidate = (a: Asset): boolean => {
    if (skip.has(a.id)) return false;
    if (a.publishMode === "placeholder") return false;
    if (!hasChainProvenance(a)) return false;
    if (isPinned(a)) return false;
    if (mode === "reflow" && a.status !== "draft") return false;
    return true;
  };

  const assignments: ChainAssignment[] = [];
  const familyOrder: ChainFamily[] = ["social", "email", "article"];

  for (const family of familyOrder) {
    if (familyFilter && !familyFilter.has(family)) continue;
    // Placeholders AND reference docs (overview/explainer items like
    // "template-ideas") are removed from the family entirely: never candidates,
    // never day occupancy — they are not calendar entities.
    const familyAssets = assets.filter(
      (a) =>
        chainFamilyFor(a.type) === family &&
        a.publishMode !== "placeholder" &&
        !isReferenceDocAsset(a),
    );
    if (familyAssets.length === 0) continue;

    const candidates = familyAssets
      .filter(isCandidate)
      .sort((a, b) => {
        const cmp = deriveOrderKey(a).localeCompare(deriveOrderKey(b));
        return cmp !== 0 ? cmp : a.id.localeCompare(b.id);
      });

    const ledger = createDayLedger(pace);
    for (const a of familyAssets) {
      if (candidates.includes(a)) continue;
      const at = a.scheduledAt ?? a.publishedAt;
      if (at != null) ledger.book(paceLaneFor(a), startOfDayMs(at));
    }

    // ONE CURSOR PER LANE. A single cursor cannot serve two ceilings: the moment
    // a day holds two clips and one post, "the next free day" is a different
    // date for each lane, and interleaving clips and posts through one pointer
    // would push each kind past days its own lane still has room on. The two
    // start together and only ever move forward.
    const cursors: Record<PaceLane, number> = { clip: startDay, post: startDay };
    for (const a of candidates) {
      const lane = paceLaneFor(a);
      let cursor = cursors[lane];
      // Skip days this lane has already filled in this family AND weekend days
      // this asset's platform doesn't post on (chainAllowsDay) — a weekday-only
      // platform rolls forward to the next weekday instead of landing on a dead
      // weekend.
      while (ledger.isFull(lane, cursor) || !chainAllowsDay(a.type, a.scheduledPlatform, new Date(cursor).getDay())) {
        cursor = nextDayStart(cursor);
      }
      const slot = chainSlotForDay(cursor);
      ledger.book(lane, cursor);
      // The cursor STAYS on the day it just used rather than stepping past it:
      // a day with room left for this lane is where the next one of these goes.
      // At the default ceiling of 1 the loop above steps off it immediately, so
      // this is the same walk as before.
      cursors[lane] = cursor;
      const derived = deriveOrderKey(a);
      if (a.scheduledAt !== slot || a.orderKey !== derived) {
        assignments.push({ id: a.id, scheduledAt: slot, orderKey: derived });
      }
    }
  }

  return assignments;
}

/* ─────────────────────── publish ordering gate ─────────────────────── */

/**
 * The earlier post in this asset's SERIES that hasn't gone out yet, or null when
 * the asset is clear to publish.
 *
 * The chain plans a client's posts into a deliberate order (deriveOrderKey), but
 * nothing downstream ever enforced it: the publish cron selects on
 * `scheduledAt` alone, so a post whose predecessor was still sitting in drafts
 * published anyway and a numbered series went out starting at no. 2. Sequence is
 * the whole point of a series — "the playbook, no. 2" is wrong if no. 1 never
 * ran — so ordering has to be checked at the moment of publishing, not just at
 * planning time.
 *
 * Scoped to the TEMPLATE, not the whole chain family. A family-wide rule reads
 * as stricter but is unusable: a backlog of un-approved chain drafts is the
 * normal steady state after every lab import, so any post staff deliberately
 * rushed ahead of that backlog would be held forever with no way out. A
 * template ("Playbook", "By The Numbers") is what actually carries a numbered
 * sequence, and it's what the reported break was. An asset with no template has
 * no series identity, so nothing can be established about its order and it is
 * never held.
 *
 * A candidate is blocked by any asset that is:
 *   • the same template, for the same client, in the same chain family, and
 *   • a real calendar entity (not a placeholder, not a reference doc), and
 *   • part of the chain (hasChainProvenance — legacy assets from removed
 *     systems carry no order signal and must not wedge the queue), and
 *   • ordered before it (deriveOrderKey, id tiebreak — matching planClientChain
 *     exactly, so the gate agrees with the plan), and
 *   • not published.
 *
 * `assets` must be the candidate's whole client, unfiltered — a predecessor the
 * caller filtered out is a predecessor the gate can't see.
 *
 * This holds the post rather than reordering it: publishing out of order is
 * public and permanent, while holding is visible and reversible. The hold
 * releases as soon as the predecessor publishes. It does NOT release by
 * unscheduling the predecessor — clearAssetSchedule reverts it to "draft",
 * which is still an unpublished state and still blocks — so a series truly
 * abandoned mid-way holds its successors until someone publishes or deletes the
 * predecessor. That's deliberate (the alternative is posting the series out of
 * order), and the caller names the blocker so the hold is actionable.
 */
export function blockingPredecessor(candidate: Asset, assets: Asset[]): Asset | null {
  const family = chainFamilyFor(candidate.type);
  if (family === null) return null;
  if (candidate.publishMode === "placeholder") return null;
  if (!hasChainProvenance(candidate)) return null;

  const series = templateForAsset(candidate);
  if (series === null || isReferenceDocSlug(series.key)) return null;

  const candidateKey = deriveOrderKey(candidate);
  const isBefore = (a: Asset): boolean => {
    const cmp = deriveOrderKey(a).localeCompare(candidateKey);
    return cmp !== 0 ? cmp < 0 : a.id.localeCompare(candidate.id) < 0;
  };

  const blockers = assets.filter(
    (a) =>
      a.id !== candidate.id &&
      a.clientId === candidate.clientId &&
      chainFamilyFor(a.type) === family &&
      templateForAsset(a)?.key === series.key &&
      a.publishMode !== "placeholder" &&
      !isReferenceDocAsset(a) &&
      hasChainProvenance(a) &&
      a.status !== "published" &&
      isBefore(a),
  );
  if (blockers.length === 0) return null;

  // Report the nearest predecessor: it's the one that has to move first, and
  // naming it is what makes the hold actionable.
  return blockers.sort((a, b) => {
    const cmp = deriveOrderKey(b).localeCompare(deriveOrderKey(a));
    return cmp !== 0 ? cmp : b.id.localeCompare(a.id);
  })[0];
}

/* ─────────────────────── client-facing gating ──────────────────────── */

/**
 * Whether a client may see this asset's actual content. Locked = future-dated:
 * the asset unlocks at midnight of its scheduledAt day. Published and undated
 * (legacy) assets are always visible.
 *
 * WHOSE MIDNIGHT: `startOfDayMs`'s, i.e. the calling runtime's own zone. Every
 * caller that decides what CROSSES to a browser runs on the server, so the
 * boundary a client experiences is the server's. One caller runs on both sides
 * — `markPostedBlock`, which the attestation control asks before it renders and
 * the server action asks before it writes — and inside the offset between the
 * two clocks they can disagree; the server's answer is the one that counts.
 */
export function isAssetUnlockedForClient(
  a: Pick<Asset, "status" | "scheduledAt" | "publishedAt">,
  now: number,
): boolean {
  if (a.status === "published" || a.publishedAt != null) return true;
  if (a.scheduledAt == null) return true;
  return startOfDayMs(a.scheduledAt) <= now;
}

/* ───────────────────────────── templates ───────────────────────────── */

function titleCaseWords(slug: string): string {
  return slug
    .split(/[-_\s]+/)
    .filter(Boolean)
    .map((w) => w.charAt(0).toUpperCase() + w.slice(1))
    .join(" ");
}

/**
 * Template identity from a lab item folder name: strips the same date/index
 * prefixes as humanizeItemName (lab-outputs-shared.ts), then slugs the rest.
 * "01-by-the-numbers" → { key: "by-the-numbers", name: "By The Numbers" }.
 *
 * `knownKeys` (the template keys this client already has): after
 * prefix-stripping, a slug that starts with a known key + "-" collapses to
 * that key — longest match wins — so one-off run slugs like
 * "voce-sabia-renda-fixa-nao-e-sem-risco" land on the existing "voce-sabia"
 * template instead of minting a new one.
 */
export function templateFromItemKey(
  itemKey: string,
  knownKeys?: string[],
): { key: string; name: string } | null {
  if (itemKey === "run") return null;
  const cleaned = itemKey
    .replace(/^\d{4}-\d{2}-\d{2}[-_]?/, "") // run-name date prefix
    .replace(/^\d+[-_.]?\s*/, "") // item index prefix
    .trim();
  if (!cleaned) return null;
  const slug = cleaned
    .toLowerCase()
    .replace(/[_\s]+/g, "-")
    .replace(/-+/g, "-")
    .replace(/^-|-$/g, "");
  if (!slug) return null;
  if (knownKeys && knownKeys.length > 0) {
    const match = knownKeys
      .filter((k) => k.length > 0 && (slug === k || slug.startsWith(`${k}-`)))
      .sort((a, b) => b.length - a.length)[0];
    if (match) return { key: match, name: titleCaseWords(match) };
  }
  return { key: slug, name: titleCaseWords(slug) };
}

/**
 * Template chip for any asset, legacy included: stored templateKey/Name pair →
 * lab item key (meta.labRun's part after "#") → managed product name
 * (meta.taskType) → null.
 */
export function templateForAsset(
  a: Pick<Asset, "templateKey" | "templateName" | "meta" | "type">,
  knownKeys?: string[],
): { key: string; name: string } | null {
  if (typeof a.templateKey === "string" && a.templateKey.length > 0) {
    return { key: a.templateKey, name: a.templateName ?? titleCaseWords(a.templateKey) };
  }
  const labRun = a.meta?.labRun;
  if (typeof labRun === "string") {
    const hash = labRun.indexOf("#");
    if (hash >= 0) {
      const fromKey = templateFromItemKey(labRun.slice(hash + 1), knownKeys);
      if (fromKey) return fromKey;
    }
  }
  const taskType = metaString(a, "taskType");
  if (taskType !== null && MANAGED_TASK_TYPES.has(taskType)) {
    const product = getManagedProduct(taskType as ManagedTaskType);
    return { key: taskType, name: product.name };
  }
  return null;
}

/* ─────────────────────── reference docs ─────────────────────────────── */

/**
 * First-round lab runs usually ship an overview/"read this first" item that
 * DESCRIBES the proposed templates (slug "template-ideas" or similar). It is
 * documentation, not a posting template: reference docs are never chain
 * candidates (no calendar day) and never appear in a client's template list —
 * they stay in the library as plain undated deliverables.
 */
const REFERENCE_DOC_SLUGS = new Set([
  "template-ideas",
  "template-idea",
  "template-overview",
  "templates-overview",
  "read-me-first",
]);

export function isReferenceDocSlug(slug: string): boolean {
  return REFERENCE_DOC_SLUGS.has(slug);
}

export function isReferenceDocAsset(
  a: Pick<Asset, "templateKey" | "templateName" | "meta" | "type">,
): boolean {
  const template = templateForAsset(a);
  return template !== null && isReferenceDocSlug(template.key);
}

/* ─────────────────────────── agent labels ──────────────────────────── */

/**
 * Which managed product family produced an asset. Asset-based (lab-imported
 * content has no job yet still counts): meta.taskType → lab agent-folder
 * keywords → asset type. Table kept local so this file stays client-safe.
 */
export function productForAsset(a: Pick<Asset, "meta" | "type">): ManagedTaskType | null {
  const taskType = metaString(a, "taskType");
  if (taskType !== null && MANAGED_TASK_TYPES.has(taskType)) return taskType as ManagedTaskType;
  const folder = metaString(a, "agentFolder")?.toLowerCase();
  if (folder) {
    if (folder.includes("instagram") || folder.includes("social")) return "social_post";
    if (folder.includes("newsletter") || folder.includes("email")) return "newsletter_issue";
    if (folder.includes("blog") || folder.includes("article")) return "blog_article";
    if (folder.includes("landing")) return "landing_page";
  }
  switch (a.type) {
    case "instagram_post":
    case "social_post":
      return "social_post";
    case "email":
      return "newsletter_issue";
    case "article":
      return "blog_article";
    default:
      return null;
  }
}

/**
 * Human label for "who drafted this": the humanized lab agent folder
 * ("instagram-agent" → "Instagram agent"), else the managed product name.
 * Fully data-driven — no client or agent names hardcoded.
 */
export function agentLabelForAsset(a: Pick<Asset, "agentId" | "meta" | "type">): string | null {
  const folder = metaString(a, "agentFolder");
  if (folder) {
    const words = folder.replace(/[-_]+/g, " ").trim();
    if (words) return words.charAt(0).toUpperCase() + words.slice(1).toLowerCase();
  }
  const product = productForAsset(a);
  if (product) return getManagedProduct(product).name;
  return null;
}
