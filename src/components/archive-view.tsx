"use client";

import { useCallback, useMemo, useState } from "react";
import { useSearchParams } from "next/navigation";
import { AgentIdentity } from "@/components/agent-identity";
import { AssetDetailModal } from "@/components/asset-detail-modal";
import { Badge, EmptyState } from "@/components/ui";
import { Icon } from "@/components/icon";
import { assetImages, assetVideos } from "@/lib/asset-images";
import { agentLabelForAsset } from "@/lib/post-chain";
import { cn, relativeTime } from "@/lib/utils";
import type { Asset } from "@/lib/types";

const STATUS_TONE: Record<Asset["status"], "neutral" | "success" | "warning" | "info"> = {
  draft: "warning",
  approved: "success",
  scheduled: "info",
  published: "success",
  delivered: "success",
};

/** Client vocabulary for the stored status — "published" reads as "Posted". */
const STATUS_LABEL: Record<Asset["status"], string> = {
  draft: "Draft",
  approved: "Approved",
  scheduled: "Scheduled",
  published: "Posted",
  delivered: "Delivered",
};

interface AgentGroup {
  name: string;
  assets: Asset[];
  latestAt: number;
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
  agentNameByJobId,
  viewerIsClient = false,
}: {
  assets: Asset[];
  /** jobId → agent display name, for attributing job-produced assets. */
  agentNameByJobId: Record<string, string>;
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

  const agentNameFor = useCallback(
    (asset: Asset) =>
      (asset.jobId ? agentNameByJobId[asset.jobId] : undefined) ??
      agentLabelForAsset(asset) ??
      "Other content",
    [agentNameByJobId],
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
    return [...byAgent.entries()]
      .map(([name, list]) => ({
        name,
        assets: [...list].sort((a, b) => b.createdAt - a.createdAt),
        latestAt: Math.max(...list.map((a) => a.createdAt)),
      }))
      .sort((a, b) => b.latestAt - a.latestAt);
  }, [agent, agentNameFor, assets, search, status]);

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
              {STATUS_LABEL[option]}
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
                <h3 className="min-w-0 truncate text-base font-medium text-foreground">{group.name}</h3>
                <Badge tone="neutral">{group.assets.length}</Badge>
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
                      <ArchiveTile key={asset.id} asset={asset} onOpen={() => setOpenAssetId(asset.id)} />
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

function ArchiveTile({ asset, onOpen }: { asset: Asset; onOpen: () => void }) {
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
          <span className="text-[11px] text-muted-2">{relativeTime(asset.createdAt)}</span>
          <Badge tone={STATUS_TONE[asset.status]}>{STATUS_LABEL[asset.status] ?? asset.status}</Badge>
        </div>
      </div>
    </button>
  );
}
