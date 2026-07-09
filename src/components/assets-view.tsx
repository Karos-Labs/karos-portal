"use client";

import { useState } from "react";
import { Icon } from "@/components/icon";
import { EmptyState } from "@/components/ui";
import { AssetCard } from "@/components/asset-card";
import { ContentCalendar } from "@/components/content-calendar";
import { cn } from "@/lib/utils";
import type { Asset } from "@/lib/types";

type View = "library" | "calendar";

/**
 * Client-facing Assets view — a segmented toggle between the full asset library
 * and the deliverable calendar (scheduled + published content across all agents).
 */
export function AssetsView({
  assets,
  canApprove = false,
}: {
  assets: Asset[];
  /** Staff-only: show approve/schedule controls on each card. Clients never approve. */
  canApprove?: boolean;
}) {
  const [view, setView] = useState<View>("library");

  return (
    <>
      {/* Segmented toggle */}
      <div className="mb-5 inline-flex items-center gap-1 rounded-lg border border-border bg-surface-2 p-1">
        {(
          [
            { id: "library", label: "Assets", icon: "FolderOpen" },
            { id: "calendar", label: "Calendar", icon: "Calendar" },
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

      {view === "library" ? (
        assets.length === 0 ? (
          <EmptyState
            icon={<Icon name="FolderOpen" className="h-7 w-7" />}
            title="Nothing here yet"
            description="Your deliverables will show up here as your team creates them."
          />
        ) : (
          <div className="grid gap-3 lg:grid-cols-2">
            {assets.map((a) => (
              <AssetCard key={a.id} asset={a} canApprove={canApprove} />
            ))}
          </div>
        )
      ) : (
        <ContentCalendar assets={assets} />
      )}
    </>
  );
}
