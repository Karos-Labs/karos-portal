"use client";

import { useMemo, useState } from "react";
import { AgentIdentity } from "@/components/agent-identity";
import { AssetDetailModal } from "@/components/asset-detail-modal";
import { Badge, EmptyState } from "@/components/ui";
import { Icon } from "@/components/icon";
import { assetImages } from "@/lib/asset-images";
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

interface AgentGroup {
  name: string;
  assets: Asset[];
  latestAt: number;
}

/**
 * The Workspace "Archive" tab: every asset the agents have produced for this
 * client, grouped per agent and carrying the agent's real platform mark.
 * Read-only — review/approval stays on the staff Library; a tile opens the
 * same detail modal the calendar uses.
 */
export function ArchiveView({
  assets,
  agentNameByJobId,
}: {
  assets: Asset[];
  /** jobId → agent display name, for attributing job-produced assets. */
  agentNameByJobId: Record<string, string>;
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
        title="Nothing archived yet"
        description="Everything your agents produce lands here, organized per agent."
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
          <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
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
  return (
    <button
      type="button"
      onClick={onOpen}
      className="group flex flex-col overflow-hidden rounded-[var(--radius)] border border-border bg-surface text-left transition-all duration-150 hover:-translate-y-0.5 hover:border-border-strong hover:shadow-lg"
    >
      {thumb ? (
        <div className="aspect-[4/3] w-full overflow-hidden border-b border-border bg-surface-2">
          {/* eslint-disable-next-line @next/next/no-img-element */}
          <img src={thumb.url} alt="" className="h-full w-full object-cover transition-transform duration-200 group-hover:scale-[1.02]" />
        </div>
      ) : (
        <div className="flex h-24 w-full items-center justify-center border-b border-border bg-surface-2 text-muted-2">
          <Icon name="FileText" className="h-6 w-6" />
        </div>
      )}
      <div className="flex min-w-0 flex-1 flex-col gap-1 p-3">
        <p className="truncate text-sm font-medium text-foreground">{asset.title}</p>
        <div className="mt-auto flex items-center justify-between gap-2">
          <span className="text-[11px] text-muted-2">{relativeTime(asset.createdAt)}</span>
          <Badge tone={STATUS_TONE[asset.status]}>{asset.status}</Badge>
        </div>
      </div>
    </button>
  );
}
