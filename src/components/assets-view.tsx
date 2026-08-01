"use client";

import { useMemo, useState } from "react";
import { Badge } from "@/components/ui";
import { Icon } from "@/components/icon";
import { EmptyState } from "@/components/ui";
import { AssetCard } from "@/components/asset-card";
// The staff register. These words were a local const here; they are unchanged
// byte for byte, and this is now the only place they are written down — the
// analytics chart was printing a third, drifted set of them to the same reader
// (see asset-status-copy.ts).
import { STAFF_ASSET_STATUS_LABEL } from "@/lib/asset-status-copy";
import { platformLabel } from "@/lib/integrations/platforms";
import type { Asset } from "@/lib/types";

const STATUS_ORDER: Asset["status"][] = ["draft", "approved", "scheduled", "delivered", "published"];
const STATUS_TONE: Record<Asset["status"], "warning" | "success" | "info"> = {
  draft: "warning",
  approved: "success",
  scheduled: "info",
  delivered: "success",
  published: "success",
};

/**
 * Assets library view. Calendar moved to the dedicated /calendar route so all
 * calendar interactions and post detail modal behavior live in one source.
 */
export function AssetsView({
  assets,
  canApprove = false,
  clientNames,
  connectedPlatformsByClient,
}: {
  assets: Asset[];
  /** Staff-only: show approve/schedule controls on each card. Clients never approve. */
  canApprove?: boolean;
  /** Present on the staff-wide view so cards retain their client context. */
  clientNames?: Record<string, string>;
  /**
   * Staff-only, keyed by client: the platforms a post can actually be pushed to.
   * Without it AssetCard's "Publish Now" can never render, so the approve panel's
   * "Manual push" tier names a control that does not exist on this list (F107).
   * Platform ids only — never integration records, which carry decrypted tokens.
   */
  connectedPlatformsByClient?: Record<string, string[]>;
}) {
  const [status, setStatus] = useState<Asset["status"] | "all">("all");
  const channels = useMemo(
    () => [...new Set(assets.flatMap((asset) => asset.channels ?? []))].sort(),
    [assets],
  );
  const [channel, setChannel] = useState("all");
  const groupedAssets = useMemo(() => {
    const matching = assets
      .filter((asset) => status === "all" || asset.status === status)
      .filter((asset) => channel === "all" || asset.channels?.includes(channel))
      .sort((a, b) => (b.updatedAt ?? b.createdAt) - (a.updatedAt ?? a.createdAt));

    return STATUS_ORDER.flatMap((groupStatus) => {
      const items = matching.filter((asset) => asset.status === groupStatus);
      return items.length ? [{ status: groupStatus, items }] : [];
    });
  }, [assets, channel, status]);

  return assets.length === 0 ? (
    <EmptyState
      icon={<Icon name="FolderOpen" className="h-7 w-7" />}
      title="Nothing here yet"
      description="Your deliverables will show up here as your team creates them."
    />
  ) : (
    <div className="space-y-6">
      <div className="flex flex-wrap items-center gap-2 rounded-lg border border-border bg-surface-2 p-2">
        <span className="px-1 text-[10px] font-mono font-medium uppercase tracking-[0.12em] text-muted-2">Filter</span>
        <select
          aria-label="Filter assets by status"
          value={status}
          onChange={(event) => setStatus(event.target.value as Asset["status"] | "all")}
          className="h-8 rounded-md border border-border bg-surface px-2 text-xs text-foreground focus:outline-none focus:ring-2 focus:ring-neon/40"
        >
          <option value="all">All statuses</option>
          {STATUS_ORDER.map((option) => <option key={option} value={option}>{STAFF_ASSET_STATUS_LABEL[option]}</option>)}
        </select>
        {channels.length > 0 && (
          <select
            aria-label="Filter assets by channel"
            value={channel}
            onChange={(event) => setChannel(event.target.value)}
            className="h-8 rounded-md border border-border bg-surface px-2 text-xs text-foreground focus:outline-none focus:ring-2 focus:ring-neon/40"
          >
            <option value="all">All channels</option>
            {/*
              `platformLabel`, not the bare id under CSS `capitalize` — which
              title-cases the first letter of each word and so printed "Linkedin"
              and "Tiktok", misspelling both brands. That is QA F122, recorded
              against the connected-channels card and fixed there; this filter was
              the copy that was missed. The class went with the id: it cannot stay
              once the text is a real label, or "X (Twitter)" would be re-cased too.
            */}
            {channels.map((option) => (
              <option key={option} value={option}>
                {platformLabel(option)}
              </option>
            ))}
          </select>
        )}
        <span className="ml-auto px-1 text-[11px] text-muted-2">Newest first</span>
      </div>

      {groupedAssets.length === 0 ? (
        <EmptyState
          icon={<Icon name="SearchX" className="h-7 w-7" />}
          title="No matching assets"
          description="Try clearing a filter to see more deliverables."
        />
      ) : (
        groupedAssets.map((group) => (
          <section key={group.status} aria-label={STAFF_ASSET_STATUS_LABEL[group.status]}>
            <div className="mb-3 flex items-center gap-2">
              <Badge tone={STATUS_TONE[group.status]}>{STAFF_ASSET_STATUS_LABEL[group.status]}</Badge>
              <span className="text-xs text-muted-2">{group.items.length}</span>
            </div>
            <div className="grid items-start gap-3 lg:grid-cols-2">
              {group.items.map((asset) => (
                <div key={asset.id}>
                  {clientNames?.[asset.clientId] && (
                    <div className="mb-1"><Badge tone="neutral">{clientNames[asset.clientId]}</Badge></div>
                  )}
                  <AssetCard
                    asset={asset}
                    canApprove={canApprove}
                    {...(connectedPlatformsByClient?.[asset.clientId]
                      ? { connectedPlatforms: connectedPlatformsByClient[asset.clientId] }
                      : {})}
                  />
                </div>
              ))}
            </div>
          </section>
        ))
      )}
    </div>
  );
}
