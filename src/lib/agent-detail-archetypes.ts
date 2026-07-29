import "server-only";

import { dateKeyInZone, shiftDateKey } from "@/lib/client-agents";
import { projectRunOccurrences } from "@/lib/scheduled-runs";
import { runtimeTimeZone } from "@/lib/run-cadence";
import { resolveContentIdentity } from "@/lib/agent-identity-map";
import { clientDeliveryStamp, getClientArchiveAssets } from "@/lib/asset-visibility";
import { assetVideos } from "@/lib/asset-images";
import { parseRedditDrafts, type RedditParsedAccount } from "@/lib/reddit-drafts";
import type { ClientAgentIdentity } from "@/lib/agent-identity-map";
import type { TemplateDetail } from "@/components/client-agents/types";
import type {
  Asset,
  ClientAgent,
  ClientAgentTemplate,
  Job,
  PlannedScheduledRun,
} from "@/lib/types";

/**
 * The per-archetype projections behind the agent detail page (CD-I1).
 *
 * SAME DOCTRINE AS client-agent-rows.ts, and for the same reason: everything
 * returned here is serialized into the RSC payload a browser receives, so
 * redaction that happens at render time has already lost. The clip gallery and
 * the daily finder are new SHAPES, not new permissions — a client sees exactly
 * what the archive rules already let them see, arranged so the product is
 * legible instead of being a list of titles.
 *
 * The three archetypes share their attribution (`agentProducedAssets`) rather
 * than each joining assets to agents their own way. Asset carries no
 * clientAgentId, so "who made this" is a real resolution with four rungs, and
 * three subtly different copies of it is how one surface starts crediting a
 * post to an agent that did not write it (F147).
 */

/* ────────────────────────── shared attribution ────────────────────────── */

/**
 * Everything this agent has produced that THIS viewer may see.
 *
 * DELIVERED WORK ONLY for a client (A3/A4): `getClientArchiveAssets` drops
 * drafts, future-dated posts and launch deliverables rather than mapping them
 * through a placeholder — the placeholder keeps `createdAt` and a template
 * name, which under a "what it has made for you" heading renders a whole
 * generated batch as seven posts all made in the same minute. Staff keep
 * everything, including drafts, because reviewing drafts is their job.
 *
 * Attribution runs through `resolveContentIdentity`, the one helper that knows
 * how an asset, its job and an umbrella relate. The two direct rungs are
 * checked first because they are cheaper and exact; the fourth rung (the agent
 * NAME) is what keeps the pre-umbrella flagship agents attributed at all.
 */
export function agentProducedAssets(args: {
  assets: Asset[];
  jobs: Job[];
  agent: { id: string; name: string };
  umbrella: ClientAgent | null;
  umbrellas: ClientAgentIdentity[];
  viewerIsClient: boolean;
  now: number;
}): Asset[] {
  const jobById = new Map(args.jobs.map((job) => [job.id, job]));
  const visible = args.viewerIsClient
    ? getClientArchiveAssets(args.assets, { now: args.now })
    : args.assets;
  return visible.filter((asset) => {
    const job = asset.jobId ? (jobById.get(asset.jobId) ?? null) : null;
    if (
      job &&
      (job.customAgentId === args.agent.id ||
        (args.umbrella && job.clientAgentId === args.umbrella.id))
    ) {
      return true;
    }
    const identity = resolveContentIdentity({ asset, job }, args.umbrellas);
    if (args.umbrella) return identity.clientAgentId === args.umbrella.id;
    return identity.label === args.agent.name;
  });
}

/**
 * The stamp a deliverable row prints for this viewer.
 *
 * Client rows carry the DELIVERY moment, never the generation instant — a week
 * of "daily" posts shares one `createdAt`, so printing it publishes the batch
 * shape on every surface that lists deliverables.
 */
export function deliverableStamp(asset: Asset, viewerIsClient: boolean): number {
  return viewerIsClient ? clientDeliveryStamp(asset) : asset.createdAt;
}

/* ─────────────────── the template click-through (CD-K1) ────────────────── */

/** How many posts one template's expansion keeps. */
export const TEMPLATE_POSTS_SHOWN = 6;

/**
 * Every post this agent made under each of its templates, joined on
 * `Asset.templateKey` — the key `ClientAgentTemplate.key` was defined to equal.
 *
 * `assets` MUST already be `agentProducedAssets` output. That is the whole
 * safety of this function and the reason it lives in this module rather than
 * beside the component that renders it: for a client that set has already been
 * through `getClientArchiveAssets`, so a template's history inherits the
 * delivered-work-only filter instead of re-deriving one. A version of this that
 * read `listAssets` and filtered on `templateKey` alone would hand a client
 * every draft in the batch the moment they opened a format — the A3/A4 failure
 * in its most direct form, on the one surface that groups work by the stream
 * that produced it.
 *
 * `postCount` counts what this VIEWER may see, not what exists. It is therefore
 * a count of delivered work for a client and of everything for staff, which is
 * the same split every other number on the page already carries.
 *
 * Retired templates are included: a client who has posts under a stream that
 * was later retired still needs somewhere for them to appear. Which templates
 * are OFFERED is `visibleTemplates`' decision, upstream of this.
 */
export function templateDetails(args: {
  templates: ClientAgentTemplate[];
  assets: Asset[];
  viewerIsClient: boolean;
  perTemplate?: number;
}): Record<string, TemplateDetail> {
  const cap = args.perTemplate ?? TEMPLATE_POSTS_SHOWN;
  const byKey = new Map<string, Asset[]>();
  for (const asset of args.assets) {
    const key = asset.templateKey;
    if (!key) continue;
    const bucket = byKey.get(key);
    if (bucket) bucket.push(asset);
    else byKey.set(key, [asset]);
  }

  const details: Record<string, TemplateDetail> = {};
  for (const template of args.templates) {
    const posts = (byKey.get(template.key) ?? [])
      .map((asset) => ({
        id: asset.id,
        // The archive rows settle on the same fallback, so a titleless
        // deliverable reads the same wherever it is listed.
        title: asset.title || "Untitled",
        at: deliverableStamp(asset, args.viewerIsClient),
      }))
      .sort((a, b) => b.at - a.at);
    details[template.key] = {
      key: template.key,
      ...(template.rationale ? { rationale: template.rationale } : {}),
      addedAt: template.addedAt,
      source: template.source,
      posts: posts.slice(0, cap),
      postCount: posts.length,
    };
  }
  return details;
}

/* ──────────────────────────── the daily strip ─────────────────────────── */

/**
 * One day on a daily-cadence agent's calendar strip.
 *
 * INTENT ONLY, exactly as the template-calendar week strip is (§4.1): a day
 * carries a date and a constant label, never a count, never a "found / not
 * found" mark for a day that has not happened. The whole point of the strip is
 * to answer "when does it go looking", and answering "and here is what it will
 * find" is the one thing it must never do.
 */
export interface FinderDay {
  dateKey: string;
  /** True for the viewer's current day in the SCHEDULE's zone (F108). */
  isToday: boolean;
  /** True once the day has passed — the strip greys it rather than dropping it. */
  isPast: boolean;
}

/**
 * The days this agent goes looking, from its own schedule.
 *
 * Albert on the Reddit agent: "it will find a thread every day… fully connected
 * to the calendar itself." That connection is the SCHEDULE, projected — not an
 * invented daily rhythm. The Reddit agent fires at most five weekdays a week
 * (REDDIT_MAX_RUNS_PER_WEEK), so a strip that painted seven days would promise
 * two the agent never works.
 *
 * Day boundaries come from the schedule's stored IANA zone, the F108 contract —
 * reading them in the container's zone shifts the whole strip by a day for any
 * client who is not where the server is.
 */
export function finderDays(args: {
  run: PlannedScheduledRun | null;
  now: number;
  zone: string;
  /** How many days back the strip keeps for context. */
  lookbackDays?: number;
  horizonDays?: number;
}): FinderDay[] {
  const todayKey = dateKeyInZone(args.now, args.zone);
  const lookback = args.lookbackDays ?? 3;
  const horizon = args.horizonDays ?? 7;

  const keys = new Set<string>();
  // Recent days always appear, whether or not a fire is still projected for
  // them: `nextRunAt` only ever points forward, so a projection alone would
  // render a strip that begins in the future and never contains today.
  for (let back = lookback; back >= 1; back -= 1) {
    keys.add(shiftDateKey(todayKey, -back));
  }
  keys.add(todayKey);

  if (args.run && args.run.status !== "completed") {
    for (const at of projectRunOccurrences(args.run, {
      from: args.now,
      horizonDays: horizon,
      ...(args.run.timeZone ? { timeZone: args.run.timeZone } : {}),
    })) {
      keys.add(dateKeyInZone(at, args.zone));
    }
  }

  return [...keys]
    .sort()
    .map((dateKey) => ({
      dateKey,
      isToday: dateKey === todayKey,
      isPast: dateKey < todayKey,
    }));
}

/* ────────────────────────────── clip maker ────────────────────────────── */

export interface ClipMakerView {
  /**
   * The deliverables that are actually playable, newest first — the hero.
   *
   * `assetVideos` is the ONLY runtime video discriminator in this codebase
   * (`Asset` has no kind field and `AssetType` is video-agnostic), and it is
   * the same call the archive tile and the detail modal make. A locked or
   * future-dated asset can never appear here even by accident:
   * `redactLockedAsset` builds its copy by whitelist and does not carry
   * `videoUrl` forward, so a redacted clip resolves to zero videos — and
   * `agentProducedAssets` has already dropped it for a client anyway.
   */
  clips: Asset[];
  /**
   * Everything else this agent produced — the caption docs, the notes, the
   * run reports. A clip maker still writes things; they just are not the
   * product, so they sit under the gallery rather than replacing it.
   */
  documents: Asset[];
  /** The days a schedule will cut a clip on. Empty when there is no schedule. */
  scheduledDays: FinderDay[];
}

/**
 * Project a clip maker's assets into the deliverables-first view.
 *
 * NO TEMPLATE ROWS ANYWHERE, by construction: this view has no template field
 * to render one from. That is deliberate rather than incidental — `branded-shorts`
 * binds with no chain family and `slotMode: "single"`, so it generates no slots
 * and has no template registry, and a page that offered format rows for it
 * would be inventing streams the agent does not have (the same failure the
 * legacy panel documents for the umbrella-less shape).
 */
export function buildClipMakerView(args: {
  assets: Asset[];
  run: PlannedScheduledRun | null;
  now: number;
  zone?: string;
}): ClipMakerView {
  const clips: Asset[] = [];
  const documents: Asset[] = [];
  for (const asset of args.assets) {
    // ONE answer to "is this a clip", shared with the archive tile and the
    // detail modal. A predicate of this page's own — or one injected by its
    // caller — is a second answer, and the surface that disagrees is the one
    // that shows a client an empty gallery beside a video they can play.
    if (assetVideos(asset).length > 0) clips.push(asset);
    else documents.push(asset);
  }
  const zone = args.zone ?? args.run?.timeZone ?? runtimeTimeZone();
  return {
    clips,
    documents,
    scheduledDays: args.run ? finderDays({ run: args.run, now: args.now, zone }) : [],
  };
}

/* ───────────────────────────── daily finder ───────────────────────────── */

/**
 * One batch of finds, as a browser may receive it.
 *
 * The markdown is parsed HERE rather than in the reader component. Both do the
 * same parse — `parseRedditDrafts` is pure and client-safe, which is why the
 * asset modal can call it in the browser — but doing it at the boundary means
 * the payload carries the parsed shape instead of the whole raw document, and
 * it is the boundary that decides which assets get parsed at all.
 */
export interface FinderBatch {
  assetId: string;
  jobId?: string;
  /** When this batch reached the viewer (delivery for clients, generation for staff). */
  at: number;
  accounts: RedditParsedAccount[];
}

export interface DailyFinderView {
  /** The current day in the schedule's zone — what "today" means on this page. */
  todayKey: string;
  zone: string;
  /**
   * TODAY's finds, and only today's (churn A3/A4).
   *
   * A daily finder that showed tomorrow's thread would be saying out loud that
   * tomorrow's work already exists — the same fact the slot model exists to
   * keep indistinguishable. For a client the set is additionally archive-only,
   * so an unapproved draft never appears here however recently it landed.
   */
  today: FinderBatch[];
  /** Everything older, newest first — the per-agent archive. */
  earlier: FinderBatch[];
  days: FinderDay[];
  /**
   * This agent's output that is NOT a draft batch — run reports, notes.
   *
   * The common chassis promises "the documents it produced", and a finder page
   * that listed only its finds would quietly drop everything else the agent
   * wrote. Kept as a separate partition so the finds are never listed twice
   * under two headings.
   */
  documents: Asset[];
}

/**
 * Project the Reddit agent's assets into the daily-finder view.
 *
 * `assets` must already be this agent's (agentProducedAssets) — this function
 * decides WHICH DAY each batch belongs to and nothing about whose it is.
 */
export function buildDailyFinderView(args: {
  assets: Asset[];
  jobs: Job[];
  run: PlannedScheduledRun | null;
  viewerIsClient: boolean;
  now: number;
  zone?: string;
}): DailyFinderView {
  const zone = args.zone ?? args.run?.timeZone ?? runtimeTimeZone();
  const todayKey = dateKeyInZone(args.now, zone);
  const jobById = new Map(args.jobs.map((job) => [job.id, job]));

  const batches: Array<FinderBatch & { dateKey: string }> = [];
  const documents: Asset[] = [];
  for (const asset of args.assets) {
    const accounts = parseRedditDrafts(asset.content ?? "")?.accounts ?? null;
    // Not every asset this agent produced is a draft batch — a run can also
    // emit a report. Anything the reader cannot render is left to the generic
    // deliverables list rather than shown as an empty find.
    if (!accounts || accounts.length === 0) {
      documents.push(asset);
      continue;
    }
    const at = deliverableStamp(asset, args.viewerIsClient);
    const job = asset.jobId ? jobById.get(asset.jobId) : undefined;
    batches.push({
      assetId: asset.id,
      ...(job ? { jobId: job.id } : {}),
      at,
      accounts,
      dateKey: dateKeyInZone(at, zone),
    });
  }
  batches.sort((a, b) => b.at - a.at);

  const strip = (batch: FinderBatch & { dateKey: string }): FinderBatch => ({
    assetId: batch.assetId,
    ...(batch.jobId ? { jobId: batch.jobId } : {}),
    at: batch.at,
    accounts: batch.accounts,
  });

  return {
    todayKey,
    zone,
    today: batches.filter((b) => b.dateKey === todayKey).map(strip),
    earlier: batches.filter((b) => b.dateKey !== todayKey).map(strip),
    days: finderDays({ run: args.run, now: args.now, zone }),
    documents,
  };
}
