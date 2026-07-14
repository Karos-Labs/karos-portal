"use client";

import { useState } from "react";
import { Icon } from "@/components/icon";
import { cn } from "@/lib/utils";
import { groupIntoCampaignCapsules, type CampaignCapsule } from "@/lib/campaign-capsules";
import type { Asset } from "@/lib/types";

/** Asset-type → lucide icon for the piece chips (mirrors the detail modal). */
const TYPE_ICON: Record<string, string> = {
  instagram_post: "Camera",
  email: "Mail",
  article: "Newspaper",
  social_post: "Share2",
  note: "FileText",
};

/** Status → judgment-scale color for the progression dots. */
function statusColor(status: Asset["status"]): string {
  if (status === "published" || status === "delivered") return "var(--success)";
  if (status === "scheduled" || status === "approved") return "var(--info)";
  return "var(--muted-2)";
}

function shortDate(t: number | null): string {
  if (t == null) return "unscheduled";
  return new Date(t).toLocaleDateString([], { month: "short", day: "numeric" });
}

/**
 * Campaign Capsules — aggregates calendar assets sharing a campaignId into
 * unified, expandable cards showing the campaign's cross-channel journey and
 * scheduling progression at a glance, instead of scattering the pieces across
 * the grid. Renders nothing when there are no campaigns.
 */
export function CampaignCapsules({
  assets,
  onOpen,
}: {
  assets: Asset[];
  onOpen: (assetId: string) => void;
}) {
  const { capsules } = groupIntoCampaignCapsules(assets);
  if (capsules.length === 0) return null;

  return (
    <div className="mb-4 space-y-2">
      <div className="flex items-center gap-2">
        <Icon name="Boxes" className="h-3.5 w-3.5 text-neon" />
        <p className="font-mono text-[10px] uppercase tracking-[0.14em] text-muted-2">
          Campaign capsules ({capsules.length})
        </p>
      </div>
      <div className="space-y-2">
        {capsules.map((c) => (
          <Capsule key={c.campaignId} capsule={c} onOpen={onOpen} />
        ))}
      </div>
    </div>
  );
}

function Capsule({ capsule, onOpen }: { capsule: CampaignCapsule; onOpen: (id: string) => void }) {
  const [open, setOpen] = useState(true);
  const range =
    capsule.firstAt != null
      ? `${shortDate(capsule.firstAt)}${capsule.lastAt && capsule.lastAt !== capsule.firstAt ? ` → ${shortDate(capsule.lastAt)}` : ""}`
      : "unscheduled";

  return (
    <div className="overflow-hidden rounded-[var(--radius)] border border-neon/25 bg-neon-soft/30">
      {/* Header */}
      <button
        type="button"
        onClick={() => setOpen((o) => !o)}
        className="flex w-full items-center gap-2.5 px-3 py-2 text-left transition-colors hover:bg-neon-soft/50"
      >
        <div className="flex h-6 w-6 shrink-0 items-center justify-center rounded-md bg-neon/15 text-neon">
          <Icon name="Boxes" className="h-3.5 w-3.5" />
        </div>
        <div className="min-w-0 flex-1">
          <p className="truncate text-sm font-medium text-foreground">{capsule.title}</p>
          <p className="text-[11px] text-muted-2">
            {capsule.assets.length} piece{capsule.assets.length === 1 ? "" : "s"}
            {capsule.platforms.length > 0 ? ` · ${capsule.platforms.join(", ")}` : ""} · {range}
          </p>
        </div>
        <Icon
          name={open ? "ChevronUp" : "ChevronDown"}
          className="h-4 w-4 shrink-0 text-muted-2"
        />
      </button>

      {/* Cross-channel journey */}
      {open && (
        <div className="flex items-stretch gap-1 overflow-x-auto border-t border-neon/15 px-3 py-2.5">
          {capsule.assets.map((a, i) => (
            <div key={a.id} className="flex items-center gap-1">
              <button
                type="button"
                onClick={() => onOpen(a.id)}
                className="flex w-36 shrink-0 flex-col gap-1 rounded-md border border-border bg-surface-2 px-2 py-1.5 text-left transition-colors hover:border-border-strong"
                title={a.title}
              >
                <div className="flex items-center gap-1.5">
                  <Icon name={TYPE_ICON[a.type] ?? "FileText"} className="h-3 w-3 shrink-0 text-muted-2" />
                  <span
                    className="h-1.5 w-1.5 shrink-0 rounded-full"
                    style={{ backgroundColor: statusColor(a.status) }}
                  />
                  <span className="truncate text-[10px] uppercase tracking-wide text-muted-2">
                    {a.scheduledPlatform ?? a.type.replace(/_/g, " ")}
                  </span>
                </div>
                <span className="truncate text-[11px] font-medium text-foreground">{a.title}</span>
                <span className="text-[10px] text-muted-2">{shortDate(scheduleOf(a))}</span>
              </button>
              {i < capsule.assets.length - 1 && (
                <Icon name="ArrowRight" className={cn("h-3 w-3 shrink-0 text-neon/50")} />
              )}
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

function scheduleOf(a: Asset): number | null {
  return a.scheduledAt ?? a.recommendedAt ?? a.publishedAt ?? null;
}
