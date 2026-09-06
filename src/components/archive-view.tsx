"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import Link from "next/link";
import { AgentIdentity } from "@/components/agent-identity";
import { AssetDetailModal } from "@/components/asset-detail-modal";
import { Badge, EmptyState } from "@/components/ui";
import { Icon } from "@/components/icon";
import { assetImages, assetVideos } from "@/lib/asset-images";
// The client's vocabulary for a stored status ("published" reads as "Posted")
// used to be a local const here. It is shared now because the publish cron's
// ordering-hold message interpolated the RAW enum into a sentence a client
// reads, and one map is the only way those two agree.
import { CLIENT_ASSET_STATUS_LABEL, clientAssetStatusLabel } from "@/lib/asset-status-copy";
import { clientDeliveryStamp } from "@/lib/asset-visibility";
import { offeredStatesFor } from "@/lib/client-state-domain";
import { agentLabelForAsset, templateForAsset } from "@/lib/post-chain";
import { cn, relativeTime } from "@/lib/utils";
import type { Asset } from "@/lib/types";

const STATUS_TONE: Record<Asset["status"], "neutral" | "success" | "warning" | "info"> = {
  draft: "warning",
  approved: "success",
  scheduled: "info",
  published: "success",
  delivered: "success",
};

interface AgentGroup {
  name: string;
  assets: Asset[];
  latestAt: number;
  /** Distinct template streams in this group, most-used first (F148). */
  templates: Array<{ key: string; name: string; count: number }>;
}

/** Template chips shown on a group header before the "+N" overflow. */
const GROUP_TEMPLATE_CHIPS = 3;

/**
 * The template streams present in one agent's deliverables, most-used first.
 *
 * F148's complaint was that a client's template set is "rendered nowhere as a
 * group" - the agent designs three or four named formats for them, the detail
 * modal shows one on a single post, and nowhere does the client see that their
 * agent produces several distinct streams. The archive is where the whole body
 * of work is, so it is where the streams become visible.
 */
function templatesOf(assets: Asset[]): AgentGroup["templates"] {
  const counts = new Map<string, { key: string; name: string; count: number }>();
  for (const asset of assets) {
    const template = templateForAsset(asset);
    if (!template) continue;
    const existing = counts.get(template.key);
    if (existing) existing.count += 1;
    else counts.set(template.key, { key: template.key, name: template.name, count: 1 });
  }
  return [...counts.values()].sort(
    (a, b) => b.count - a.count || a.name.localeCompare(b.name),
  );
}

/** Tiles shown per agent group before "Show all N" (QA F66). */
const GROUP_PAGE_SIZE = 12;

/* The filter's options used to be a hand-typed `STATUS_ORDER` of all five
   statuses, and "Draft" was one of them — on a list whose own server-side
   projection (`isInClientArchive`) rejects a draft outright, so a client
   selecting it could only ever empty the page. The options now come from
   `offeredStatesFor("archive", …)`, which derives them by asking that projection,
   so the control and the set it filters cannot disagree. Staff still get all
   five: their view is the full library. */

/**
 * The Workspace "Archive" tab, grouped per agent and carrying the agent's real
 * platform mark. A tile opens the same detail modal the calendar uses - which
 * mounts the per-draft reader for agent draft batches (pick / edit / skip) and
 * is otherwise read-only; approval itself stays on the staff Library.
 *
 * For a client the set is POSTED work from the last ~30 days only - the filter
 * runs server-side in TasksBody (F149/A4); this component only has to talk
 * about it honestly. Staff see the client's full library.
 *
 * The control bar (status / agent / search) mirrors the staff AssetsView strip:
 * the client used to get one uncontrolled wall of every tile ever produced
 * (QA F66). All three filters are component-local state.
 *
 * `status` used to seed from a `?status=` search param "so other surfaces can
 * deep link into a slice", with a manual same-route re-read to go with it —
 * removed 2026-07-31 (QA #138), along with the twin reader on /assets.
 *
 * THE CONTRACT ALREADY DECAYED ONCE, which is the argument for deleting it
 * rather than keeping it warm. A producing link did exist: af1b404 (2026-07-21)
 * added `href="/assets?view=library&status=draft"` to client-home-overview.tsx
 * in the same commit that added the /assets reader it fed. 350a1a2 (2026-07-28,
 * QA F97) re-pointed that dashboard row at the archive and dropped the param,
 * leaving both readers with no producer — so what was deleted here is a param
 * whose one caller had already been removed a week earlier, not a path nobody
 * had got round to using. A reader kept alive past its last producer is the
 * shape that rots: it type-checks, it renders, and the next person to write a
 * deep link inherits re-read logic no test has ever exercised.
 *
 * Verify with `git log -S'status=draft' -- src/components/client-home-overview.tsx`
 * before re-adding it; reintroduce it WITH its producer and a test.
 *
 * ── REINTRODUCED 2026-09, ON EXACTLY THOSE TERMS ─────────────────────────
 *
 * The `status` value below is the reader (seeded from `?status=` by the page,
 * held by the calendar); the producer is the "Content by status"
 * chart (client-analytics.tsx's `statusHref`), which is on the same reader's
 * Reporting tab two clicks from here and whose entire purpose is to open this
 * list narrowed to the bar they pressed. Both ends are pinned by
 * content-status-deeplink.test.ts, which fails if either the link stops
 * carrying the param or this prop stops seeding the filter.
 *
 * CONTROLLED SINCE THE REVIEW WAVE (2026-09), which is not the re-reading
 * reader that was deleted. The values are held by the host (run-calendar.tsx),
 * mirrored into the URL by it, and handed back down; this component renders
 * them and reports every change. The deleted version's fault was that it
 * re-read the route BEHIND the reader's back; the fault the seed-only version
 * had is the mirror image — leaving the archive and returning, or stepping
 * Back, remounted this list on the FIRST load's props while the URL went on
 * claiming filters that were no longer in force. A single owner has neither.
 *
 * The value also cannot be a state this list rejects — the host narrows it
 * through `offeredStatesFor("archive", …)`, the same function that builds the
 * dropdown, so a deep link to "draft" degrades to the unfiltered list for a
 * client rather than to an empty one.
 *
 * SCOPE: this is about the `?status=` param on these two surfaces. `?tab=`
 * (F97, progress-view.tsx) is a separate, genuinely-used param and is
 * unaffected; no claim is made here about search params elsewhere.
 */
export function ArchiveView({
  assets,
  agentLabelByAssetId,
  viewerIsClient,
  status,
  agent,
  search,
  onFiltersChange,
  agentsHref,
  initialAssetId,
  onAssetOpened,
}: {
  assets: Asset[];
  /**
   * assetId → the ONE name this asset's group heading carries, resolved on the
   * server through the §7.3 identity helper (F147). The join used to happen
   * here, off a jobId → job.agentName map, which is how the archive came to
   * head a group "Social posts (IG/TikTok)" while the same client's agent page
   * called that stream "Instagram Agent".
   */
  agentLabelByAssetId: Record<string, string>;
  /**
   * Which reader this is. Drives the copy, the stamp, and — since the filter
   * became derived — which statuses the dropdown offers.
   *
   * REQUIRED, no default. It defaulted to `false`, which meant a mount that
   * forgot it got the STAFF answer silently: staff copy, the generation stamp,
   * and now every status option including one a client's archive can never
   * hold. A defaulted viewer flag is the cheapest way to lose a disclosure rule,
   * and every live mount (settings/page.tsx, run-calendar.tsx) already passes it.
   */
  viewerIsClient: boolean;
  /**
   * The three filters, as VALUES (review wave, 2026-09). `status` is narrowed by
   * the host through `offeredStatesFor("archive", …)`; `agent` is a label this
   * archive actually holds, or "all"; `search` is free text. All three are
   * required — a defaulted filter is how a remount silently showed a different
   * list from the one the URL described.
   */
  status: Asset["status"] | "all";
  agent: string;
  search: string;
  /**
   * Reports every change, immediately: the host owns the values, so nothing
   * moves on this screen until it hands them back. It is also the host that
   * puts them in the URL (flow audit 2026-09, R5 — the calendar does, with a
   * debounced `replaceState`), which is why nothing is debounced here.
   */
  onFiltersChange: (filters: {
    status: Asset["status"] | "all";
    agent: string;
    search: string;
  }) => void;
  /**
   * Where "See your agents" goes from the never-had-anything empty state
   * (flow audit 2026-09, R9). Omitted on a mount with no single client in
   * scope — the staff cross-client overview — and the empty state then simply
   * carries no action rather than a link to a page that does not exist.
   */
  agentsHref?: string;
  /**
   * THE ITEM THIS PAGE WAS OPENED FOR (portal feedback round 6, decision 8).
   *
   * `/calendar?view=archive&asset={id}` — validated and threaded down by the
   * host, and read ONCE, into this state's initial value: the archive is where
   * a client's finished work lives, and until this existed no single deliverable
   * had a URL, so the setup ladder's "Open your first post" and any future "your
   * post is ready" row could only point at the list.
   *
   * An id this list does not hold simply opens nothing — the modal's asset is a
   * lookup, and the archive's own projection (drafts, future-dated posts and
   * anything past 30 days are not in it) is the authority on what it can show.
   * And it reports nothing either: see `onAssetOpened`.
   */
  initialAssetId?: string;
  /**
   * Fired when a deliverable is actually OPEN — a click or the seed above, and
   * only once the id has resolved to an asset this list holds (round 6 review,
   * D2). An `?asset=` id the archive cannot show fires nothing.
   *
   * The host does two things with it: it drops `?asset=` from the URL (the modal
   * is a gesture, not a view Back should restore) and, for a client, it writes
   * action 05 — "See your first output", which was proxied by "an output
   * exists" until this event existed to record.
   */
  onAssetOpened?: (assetId: string) => void;
}) {
  const [openAssetId, setOpenAssetId] = useState<string | null>(initialAssetId ?? null);
  const handleOpenAsset = useCallback((assetId: string) => setOpenAssetId(assetId), []);
  const [expanded, setExpanded] = useState<Set<string>>(new Set());
  const [collapsed, setCollapsed] = useState<Set<string>>(new Set());

  // One place where "a filter moved" becomes "tell the host", so a fourth
  // filter cannot be added and silently left out of the URL.
  const setFilters = useCallback(
    (next: Partial<{ status: Asset["status"] | "all"; agent: string; search: string }>) =>
      onFiltersChange({ status, agent, search, ...next }),
    [onFiltersChange, status, agent, search],
  );

  // The resolver already answered for every asset in the payload and never
  // returns an empty label; the local fallbacks stay only so a hand-assembled
  // caller can't render a blank heading.
  const agentNameFor = useCallback(
    (asset: Asset) =>
      agentLabelByAssetId[asset.id] ?? agentLabelForAsset(asset) ?? "Other content",
    [agentLabelByAssetId],
  );

  const agentNames = useMemo(
    () => [...new Set(assets.map(agentNameFor))].sort((a, b) => a.localeCompare(b)),
    [assets, agentNameFor],
  );

  const groups = useMemo<AgentGroup[]>(() => {
    const query = search.trim().toLowerCase();
    const byAgent = new Map<string, Asset[]>();
    for (const asset of assets) {
      if (status !== "all" && asset.status !== status) continue;
      if (query && !asset.title.toLowerCase().includes(query)) continue;
      const name = agentNameFor(asset);
      if (agent !== "all" && name !== agent) continue;
      (byAgent.get(name) ?? byAgent.set(name, []).get(name)!).push(asset);
    }
    // A3/A4: a client's rows are ordered - and stamped - by when the work
    // reached them, not by when it was generated. Ordering by `createdAt` while
    // printing the delivery time would also leave the tiles visibly out of
    // sequence with their own timestamps.
    const stampOf = (a: Asset) => (viewerIsClient ? clientDeliveryStamp(a) : a.createdAt);
    return [...byAgent.entries()]
      .map(([name, list]) => ({
        name,
        assets: [...list].sort((a, b) => stampOf(b) - stampOf(a)),
        latestAt: Math.max(...list.map(stampOf)),
        templates: templatesOf(list),
      }))
      .sort((a, b) => b.latestAt - a.latestAt);
  }, [agent, agentNameFor, assets, search, status, viewerIsClient]);

  function toggleGroup(name: string) {
    setCollapsed((prev) => {
      const next = new Set(prev);
      if (next.has(name)) next.delete(name);
      else next.add(name);
      return next;
    });
  }

  const openAsset = openAssetId ? assets.find((a) => a.id === openAssetId) ?? null : null;

  /**
   * "A DELIVERABLE WAS OPENED" MEANS THE MODAL HAS ONE (round 6 review, D2).
   *
   * Keyed on the RESOLVED asset, which is the only thing that can answer the
   * question the event claims to answer. It used to be two channels: the click
   * handler fired it, and a second effect fired it on mount for `initialAssetId`
   * — blindly, before the lookup, so a stale or hand-typed `?asset=` id opened
   * nothing at all and still told the host a deliverable had been read (a
   * Firestore write for action 05, on a modal with no asset in it).
   *
   * One effect covers both routes because both end in the same place: a click
   * sets the state, a deep link seeds it, and either way this fires exactly
   * once per id that actually resolves to an asset in the list.
   */
  const openedAssetId = openAsset?.id ?? null;
  useEffect(() => {
    if (!openedAssetId) return;
    onAssetOpened?.(openedAssetId);
  }, [openedAssetId, onAssetOpened]);

  if (assets.length === 0) {
    return (
      <EmptyState
        icon={<Icon name="Archive" className="h-7 w-7" />}
        title={viewerIsClient ? "Nothing here yet" : "Nothing archived yet"}
        description={
          viewerIsClient
            ? "Work your Karos team has approved shows up here, and stays for 30 days after you mark it posted."
            : "Everything the agents produce lands here, organized per agent."
        }
        // R9: an empty region should offer the control that starts the task
        // which would populate it. Nothing has ever landed in this archive, so
        // that control is not in the archive — it is the agents that make the
        // work. (The panel's own "Back to calendar" sits directly above this,
        // which is why the action here is the other direction rather than a
        // second way back to the page the reader is already on.)
        {...(agentsHref
          ? {
              action: (
                <Link
                  href={agentsHref}
                  className="inline-flex h-9 items-center justify-center gap-2 rounded-md border border-border px-3.5 text-xs font-medium text-muted transition-colors hover:border-border-strong hover:text-foreground"
                >
                  <Icon name="Bot" className="h-3.5 w-3.5" />
                  See your agents
                </Link>
              ),
            }
          : {})}
      />
    );
  }

  return (
    <div className="space-y-8">
      {/* Same control strip the staff assets list has had all along. */}
      <div className="flex flex-wrap items-center gap-2 rounded-lg border border-border bg-surface-2 p-2">
        <span className="px-1 text-[10px] font-mono font-medium uppercase tracking-[0.12em] text-muted-2">
          Filter
        </span>
        <select
          aria-label="Filter deliverables by status"
          value={status}
          onChange={(e) => setFilters({ status: e.target.value as Asset["status"] | "all" })}
          className="h-8 rounded-md border border-border bg-surface px-2 text-xs text-foreground focus:outline-none focus:ring-2 focus:ring-neon/40"
        >
          <option value="all">All statuses</option>
          {offeredStatesFor("archive", viewerIsClient).map((option) => (
            <option key={option} value={option}>
              {CLIENT_ASSET_STATUS_LABEL[option]}
            </option>
          ))}
        </select>
        {agentNames.length > 1 && (
          <select
            aria-label="Filter deliverables by agent"
            value={agent}
            onChange={(e) => setFilters({ agent: e.target.value })}
            className="h-8 rounded-md border border-border bg-surface px-2 text-xs text-foreground focus:outline-none focus:ring-2 focus:ring-neon/40"
          >
            <option value="all">All agents</option>
            {agentNames.map((name) => (
              <option key={name} value={name}>
                {name}
              </option>
            ))}
          </select>
        )}
        <input
          value={search}
          onChange={(e) => setFilters({ search: e.target.value })}
          placeholder="Search by title"
          aria-label="Search deliverables by title"
          className="h-8 min-w-[160px] flex-1 rounded-md border border-border bg-surface px-2 text-xs text-foreground placeholder:text-muted-2 focus:outline-none focus:ring-2 focus:ring-neon/40"
        />
        <span className="px-1 text-[11px] text-muted-2">Newest first</span>
      </div>

      {groups.length === 0 ? (
        <EmptyState
          icon={<Icon name="SearchX" className="h-7 w-7" />}
          title="No matching deliverables"
          description="Try clearing a filter to see more."
          // R9 again, and here the direct control is unambiguous: this list is
          // empty because of the three filters above it, so the action is the
          // one that undoes them. "Try clearing a filter" told the reader what
          // to do and made them do it themselves, three controls at a time.
          action={
            <button
              type="button"
              onClick={() => onFiltersChange({ status: "all", agent: "all", search: "" })}
              className="inline-flex h-9 items-center justify-center gap-2 rounded-md border border-border px-3.5 text-xs font-medium text-muted transition-colors hover:border-border-strong hover:text-foreground"
            >
              <Icon name="X" className="h-3.5 w-3.5" />
              Clear filters
            </button>
          }
        />
      ) : (
        groups.map((group) => {
          const isCollapsed = collapsed.has(group.name);
          const showAll = expanded.has(group.name);
          const visible = showAll ? group.assets : group.assets.slice(0, GROUP_PAGE_SIZE);
          const hidden = group.assets.length - visible.length;
          return (
            <section key={group.name}>
              <button
                type="button"
                onClick={() => toggleGroup(group.name)}
                aria-expanded={!isCollapsed}
                className="mb-3 flex w-full items-center gap-3 text-left"
              >
                <AgentIdentity identity={group.name} size="sm" />
                <h3 className="min-w-0 shrink-0 truncate text-base font-medium text-foreground">
                  {group.name}
                </h3>
                <Badge tone="neutral">{group.assets.length}</Badge>
                {/* The agent's template streams, as a group (F148). Without
                    this a client's formats exist only one-post-at-a-time in the
                    detail modal, and the fact that their agent writes several
                    distinct streams is visible nowhere. Most-used first, capped
                    so a long set cannot push the count off the row. */}
                {group.templates.length > 0 && (
                  <span className="hidden min-w-0 flex-wrap items-center gap-1 @lg:flex">
                    {group.templates.slice(0, GROUP_TEMPLATE_CHIPS).map((template) => (
                      <span
                        key={template.key}
                        className="truncate rounded-[4px] border border-border bg-surface-2 px-1.5 py-0.5 text-[10px] text-muted-2"
                      >
                        {template.name}
                      </span>
                    ))}
                    {group.templates.length > GROUP_TEMPLATE_CHIPS && (
                      <span className="text-[10px] text-muted-2">
                        +{group.templates.length - GROUP_TEMPLATE_CHIPS}
                      </span>
                    )}
                  </span>
                )}
                <Icon
                  name="ChevronDown"
                  className={cn(
                    "ml-auto h-4 w-4 shrink-0 text-muted-2 transition-transform",
                    isCollapsed && "-rotate-90",
                  )}
                />
              </button>
              {!isCollapsed && (
                <>
                  <div className="grid gap-3 @xl:grid-cols-2 @4xl:grid-cols-3">
                    {visible.map((asset) => (
                      <ArchiveTile
                        key={asset.id}
                        asset={asset}
                        viewerIsClient={viewerIsClient}
                        onOpen={() => handleOpenAsset(asset.id)}
                      />
                    ))}
                  </div>
                  {/* "Show all" was ONE-WAY (flow audit 2026-09, R17): a group
                      of 200 expanded on one press and there was no way back to
                      the twelve, on the one screen whose whole job is to be
                      scanned. The reverse is the same control, so it sits in
                      the same place and reads as the same affordance. */}
                  {showAll && group.assets.length > GROUP_PAGE_SIZE ? (
                    <button
                      type="button"
                      onClick={() =>
                        setExpanded((prev) => {
                          const next = new Set(prev);
                          next.delete(group.name);
                          return next;
                        })
                      }
                      className="mt-2 inline-flex items-center gap-1 rounded-md text-xs text-muted transition-colors hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-foreground/25"
                    >
                      Show fewer
                      <Icon name="ChevronUp" className="h-3.5 w-3.5" />
                    </button>
                  ) : hidden > 0 ? (
                    <button
                      type="button"
                      onClick={() => setExpanded((prev) => new Set(prev).add(group.name))}
                      className="mt-2 inline-flex items-center gap-1 rounded-md text-xs text-muted transition-colors hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-foreground/25"
                    >
                      Show all {group.assets.length} · {hidden} more
                      <Icon name="ChevronDown" className="h-3.5 w-3.5" />
                    </button>
                  ) : null}
                </>
              )}
            </section>
          );
        })
      )}

      <AssetDetailModal
        asset={openAsset}
        open={openAsset != null}
        onClose={() => setOpenAssetId(null)}
        viewerIsClient={viewerIsClient}
      />
    </div>
  );
}

function ArchiveTile({
  asset,
  viewerIsClient,
  onOpen,
}: {
  asset: Asset;
  /** Drives which moment the tile's timestamp names. */
  viewerIsClient: boolean;
  onOpen: () => void;
}) {
  const thumb = assetImages(asset)[0];
  // Clips get their own tile treatment so a video deliverable reads as one
  // before it is opened (QA F150).
  const hasVideo = assetVideos(asset).length > 0;
  return (
    <button
      type="button"
      onClick={onOpen}
      /* round 6 (rule 3): a tile that opens something hovers with ONE fill
         step and the accent hairline (`row-lift`), and does not move. It used
         to rise 2px and bloom a shadow, so a grid of them rippled under the
         cursor — in this brand the hover is a colour event. `focus-ring` is
         the portal's one focus treatment (globals.css). */
      className="focus-ring row-lift flex flex-col overflow-hidden rounded-[var(--radius)] border border-border bg-surface text-left"
    >
      {thumb ? (
        <div className="relative aspect-[4/3] w-full overflow-hidden border-b border-border bg-surface-2">
          {/* eslint-disable-next-line @next/next/no-img-element */}
          <img src={thumb.url} alt="" className="h-full w-full object-cover" />
          {hasVideo && (
            <span className="absolute inset-0 flex items-center justify-center bg-black/25 text-white">
              <Icon name="Play" className="h-8 w-8" />
            </span>
          )}
        </div>
      ) : (
        <div className="flex h-24 w-full items-center justify-center border-b border-border bg-surface-2 text-muted-2">
          <Icon name={hasVideo ? "Play" : "FileText"} className="h-6 w-6" />
        </div>
      )}
      <div className="flex min-w-0 flex-1 flex-col gap-1 p-3">
        <p className="truncate text-sm font-medium text-foreground">{asset.title}</p>
        <div className="mt-auto flex items-center justify-between gap-2">
          {/* `createdAt` is the GENERATION instant, and a whole week of
              "daily" posts shares one - so a client's archive printed five
              tiles reading "3 hours ago", which states the batch outright
              (A3/A4). Posted work carries its posting time and everything else
              the moment it was approved; staff keep the generation stamp,
              which for them is the fact worth knowing. */}
          <span className="text-[11px] text-muted-2">
            {relativeTime(viewerIsClient ? clientDeliveryStamp(asset) : asset.createdAt)}
          </span>
          <Badge tone={STATUS_TONE[asset.status]}>{clientAssetStatusLabel(asset.status)}</Badge>
        </div>
      </div>
    </button>
  );
}
