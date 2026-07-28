"use client";

import { useMemo, useState } from "react";
import { AgentIdentity } from "@/components/agent-identity";
import { AssetDetailModal } from "@/components/asset-detail-modal";
import { Badge, EmptyState } from "@/components/ui";
import { Icon } from "@/components/icon";
import { assetImages, assetVideos } from "@/lib/asset-images";
import { agentLabelForAsset } from "@/lib/post-chain";
import { relativeTime } from "@/lib/utils";
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

/**
 * The Workspace "Archive" tab, grouped per agent and carrying the agent's real
 * platform mark. A tile opens the same detail modal the calendar uses — which
 * mounts the per-draft reader for agent draft batches (pick / edit / skip) and
 * is otherwise read-only; approval itself stays on the staff Library.
 *
 * For a client the set is POSTED work from the last ~30 days only — the filter
 * runs server-side in TasksBody (F149/A4); this component only has to talk
 * about it honestly. Staff see the client's full library.
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
  const [openAssetId, setOpenAssetId] = useState<string | null>(null);

  const groups = useMemo<AgentGroup[]>(() => {
    const byAgent = new Map<string, Asset[]>();
    for (const asset of assets) {
      const name =
        (asset.jobId ? agentNameByJobId[asset.jobId] : undefined) ??
        agentLabelForAsset(asset) ??
        "Other content";
      (byAgent.get(name) ?? byAgent.set(name, []).get(name)!).push(asset);
    }
    return [...byAgent.entries()]
      .map(([name, list]) => ({
        name,
        assets: [...list].sort((a, b) => b.createdAt - a.createdAt),
        latestAt: Math.max(...list.map((a) => a.createdAt)),
      }))
      .sort((a, b) => b.latestAt - a.latestAt);
  }, [assets, agentNameByJobId]);

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
      {groups.map((group) => (
        <section key={group.name}>
          <div className="mb-3 flex items-center gap-3">
            <AgentIdentity identity={group.name} size="sm" />
            <h3 className="min-w-0 truncate text-base font-medium text-foreground">{group.name}</h3>
            <Badge tone="neutral">{group.assets.length}</Badge>
          </div>
          <div className="grid gap-3 @xl:grid-cols-2 @4xl:grid-cols-3">
            {group.assets.map((asset) => (
              <ArchiveTile key={asset.id} asset={asset} onOpen={() => setOpenAssetId(asset.id)} />
            ))}
          </div>
        </section>
      ))}

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
