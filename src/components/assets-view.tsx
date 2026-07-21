"use client";

import { useMemo, useState } from "react";
import { Badge } from "@/components/ui";
import { Icon } from "@/components/icon";
import { EmptyState } from "@/components/ui";
import { AssetCard } from "@/components/asset-card";
import { ContentCalendar } from "@/components/content-calendar";
import { TodaySection } from "@/components/today-section";
import { cn } from "@/lib/utils";
import type { Asset } from "@/lib/types";

type View = "calendar" | "library";

const STATUS_ORDER: Asset["status"][] = ["draft", "approved", "scheduled", "delivered", "published"];
const STATUS_LABEL: Record<Asset["status"], string> = {
  draft: "Awaiting review",
  approved: "Approved",
  scheduled: "Scheduled",
  delivered: "Delivered",
  published: "Published",
};
const STATUS_TONE: Record<Asset["status"], "warning" | "success" | "info"> = {
  draft: "warning",
  approved: "success",
  scheduled: "info",
  delivered: "success",
  published: "success",
};

/**
 * Client-facing Assets view — a segmented toggle between the deliverable calendar
 * (primary: scheduled + published content across all agents, plus a "Today"
 * strip) and the full asset archive. Calendar leads so clients land on what's
 * planned; the Assets tab is the secondary browse-everything view.
 */
export function AssetsView({
  assets,
  canApprove = false,
  viewerIsClient = false,
  initialView = "calendar",
  initialStatus,
  clientNames,
}: {
  assets: Asset[];
  /** Staff-only: show approve/schedule controls on each card. Clients never approve. */
  canApprove?: boolean;
  /** Client viewers get locked placeholders + "drafted you this" attribution. */
  viewerIsClient?: boolean;
  /** Lets a contextual link open the relevant part of the library directly. */
  initialView?: View;
  initialStatus?: Asset["status"];
  /** Present on the staff-wide view so cards retain their client context. */
  clientNames?: Record<string, string>;
}) {
  const [view, setView] = useState<View>(initialView);
  const [status, setStatus] = useState<Asset["status"] | "all">(initialStatus ?? "all");
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

  return (
    <>
      {/* Segmented toggle */}
      <div className="mb-5 inline-flex items-center gap-1 rounded-lg border border-border bg-surface-2 p-1">
        {(
          [
            { id: "calendar", label: "Calendar", icon: "Calendar" },
            { id: "library", label: "Assets", icon: "FolderOpen" },
          ] as { id: View; label: string; icon: string }[]
        ).map((tab) => (
          <button
            key={tab.id}
            onClick={() => setView(tab.id)}
            className={cn(
              "flex items-center justify-center gap-2 rounded-md px-4 py-2 text-sm font-medium transition-all duration-150",
              view === tab.id
                ? "bg-surface shadow-[0_1px_4px_rgba(0,0,0,0.3)] text-foreground"
                : "text-muted hover:text-foreground",
            )}
          >
            <Icon name={tab.icon} className="h-3.5 w-3.5" />
            {tab.label}
          </button>
        ))}
      </div>

      {view === "calendar" ? (
        <>
          <ContentCalendar assets={assets} viewerIsClient={viewerIsClient} />
          <TodaySection assets={assets} viewerIsClient={viewerIsClient} />
        </>
      ) : assets.length === 0 ? (
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
              {STATUS_ORDER.map((option) => <option key={option} value={option}>{STATUS_LABEL[option]}</option>)}
            </select>
            {channels.length > 0 && (
              <select
                aria-label="Filter assets by channel"
                value={channel}
                onChange={(event) => setChannel(event.target.value)}
                className="h-8 rounded-md border border-border bg-surface px-2 text-xs capitalize text-foreground focus:outline-none focus:ring-2 focus:ring-neon/40"
              >
                <option value="all">All channels</option>
                {channels.map((option) => <option key={option} value={option}>{option}</option>)}
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
              <section key={group.status} aria-label={STATUS_LABEL[group.status]}>
                <div className="mb-3 flex items-center gap-2">
                  <Badge tone={STATUS_TONE[group.status]}>{STATUS_LABEL[group.status]}</Badge>
                  <span className="text-xs text-muted-2">{group.items.length}</span>
                </div>
                <div className="grid items-start gap-3 lg:grid-cols-2">
                  {group.items.map((asset) => (
                    <div key={asset.id}>
                      {clientNames?.[asset.clientId] && (
                        <div className="mb-1"><Badge tone="neutral">{clientNames[asset.clientId]}</Badge></div>
                      )}
                      <AssetCard asset={asset} canApprove={canApprove} />
                    </div>
                  ))}
                </div>
              </section>
            ))
          )}
        </div>
      )}
    </>
  );
}
