"use client";

import { useCallback, useMemo, useState } from "react";
import { useSearchParams } from "next/navigation";
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
 * group" — the agent designs three or four named formats for them, the detail
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

const STATUS_ORDER: Asset["status"][] = ["draft", "approved", "scheduled", "published", "delivered"];

/**
 * The Workspace "Archive" tab, grouped per agent and carrying the agent's real
 * platform mark. A tile opens the same detail modal the calendar uses — which
 * mounts the per-draft reader for agent draft batches (pick / edit / skip) and
 * is otherwise read-only; approval itself stays on the staff Library.
 *
 * For a client the set is POSTED work from the last ~30 days only — the filter
 * runs server-side in TasksBody (F149/A4); this component only has to talk
 * about it honestly. Staff see the client's full library.
 *
 * The control bar (status / agent / search) mirrors the staff AssetsView strip:
 * the client used to get one uncontrolled wall of every tile ever produced
 * (QA F66). `status` seeds from ?status= so other surfaces can deep link into
 * a slice — composed with F97's ?tab=archive.
 */
export function ArchiveView({
  assets,
  agentLabelByAssetId,
  viewerIsClient = false,
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
  /** Drives the copy only — the posted-only filter is applied on the server. */
  viewerIsClient?: boolean;
}) {
  const searchParams = useSearchParams();
  const [openAssetId, setOpenAssetId] = useState<string | null>(null);
  const statusParam = searchParams.get("status");
  const [status, setStatus] = useState<Asset["status"] | "all">(() =>
    STATUS_ORDER.includes(statusParam as Asset["status"]) ? (statusParam as Asset["status"]) : "all",
  );
  const [agent, setAgent] = useState<string>("all");
  const [search, setSearch] = useState("");
  const [expanded, setExpanded] = useState<Set<string>>(new Set());
  const [collapsed, setCollapsed] = useState<Set<string>>(new Set());

  // Same-route deep link (?status=) has to be re-read when it changes, since
  // the component re-renders rather than remounting.
  const [prevStatusParam, setPrevStatusParam] = useState(statusParam);
  if (prevStatusParam !== statusParam) {
    setPrevStatusParam(statusParam);
    setStatus(
      STATUS_ORDER.includes(statusParam as Asset["status"]) ? (statusParam as Asset["status"]) : "all",
    );
  }

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
    // A3/A4: a client's rows are ordered — and stamped — by when the work
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
          onChange={(e) => setStatus(e.target.value as Asset["status"] | "all")}
          className="h-8 rounded-md border border-border bg-surface px-2 text-xs text-foreground focus:outline-none focus:ring-2 focus:ring-neon/40"
        >
          <option value="all">All statuses</option>
          {STATUS_ORDER.map((option) => (
            <option key={option} value={option}>
              {CLIENT_ASSET_STATUS_LABEL[option]}
            </option>
          ))}
        </select>
        {agentNames.length > 1 && (
          <select
            aria-label="Filter deliverables by agent"
            value={agent}
            onChange={(e) => setAgent(e.target.value)}
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
          onChange={(e) => setSearch(e.target.value)}
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
                        onOpen={() => setOpenAssetId(asset.id)}
                      />
                    ))}
                  </div>
                  {hidden > 0 && (
                    <button
                      type="button"
                      onClick={() => setExpanded((prev) => new Set(prev).add(group.name))}
                      className="mt-2 inline-flex items-center gap-1 rounded-md text-xs text-muted transition-colors hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-foreground/25"
                    >
                      Show all {group.assets.length} · {hidden} more
                      <Icon name="ChevronDown" className="h-3.5 w-3.5" />
                    </button>
                  )}
                </>
              )}
            </section>
          );
        })
      )}

      <AssetDetailModal asset={openAsset} open={openAsset != null} onClose={() => setOpenAssetId(null)} />
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
      className="group flex flex-col overflow-hidden rounded-[var(--radius)] border border-border bg-surface text-left transition-all duration-150 hover:-translate-y-0.5 hover:border-border-strong hover:shadow-lg"
    >
      {thumb ? (
        <div className="relative aspect-[4/3] w-full overflow-hidden border-b border-border bg-surface-2">
          {/* eslint-disable-next-line @next/next/no-img-element */}
          <img src={thumb.url} alt="" className="h-full w-full object-cover transition-transform duration-200 group-hover:scale-[1.02]" />
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
              "daily" posts shares one — so a client's archive printed five
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
