"use client";

import { useMemo, useState } from "react";
import { Badge } from "@/components/ui";
import { Icon } from "@/components/icon";
import { AssetDetailModal } from "@/components/asset-detail-modal";
import {
  sameLocalDay,
  templateForAsset,
  agentLabelForAsset,
  isAssetUnlockedForClient,
} from "@/lib/post-chain";
import { formatTimeHM, formatDayLong } from "@/lib/date-format";
import type { Asset } from "@/lib/types";

/* Same type→icon map the cards use — brand-neutral lucide glyphs (no brand marks). */
const TYPE_ICON: Record<string, string> = {
  instagram_post: "Camera",
  email: "Mail",
  article: "Newspaper",
  social_post: "Share2",
  note: "FileText",
};

/**
 * "Today" strip beneath the content calendar: every asset whose designated slot
 * (scheduledAt, or publishedAt for already-live posts) falls on the current
 * server-local day, each labelled by the agent that drafted it
 * ("Instagram agent drafted you this"). Unlocked rows open the detail modal;
 * a locked row (future post that somehow lands here) stays non-interactive.
 *
 * Renders nothing when the day is empty.
 */
export function TodaySection({
  assets,
  viewerIsClient = false,
}: {
  assets: Asset[];
  viewerIsClient?: boolean;
}) {
  // Snapshot "now" once at mount (lazy initializer keeps the memo pure), mirroring
  // the calendar so both agree on which day is "today" within a session.
  const [nowMs] = useState(() => Date.now());
  const [openAssetId, setOpenAssetId] = useState<string | null>(null);

  const rows = useMemo(
    () =>
      assets
        .map((a) => ({ a, at: a.scheduledAt ?? a.publishedAt ?? null }))
        .filter((r): r is { a: Asset; at: number } => r.at != null && sameLocalDay(r.at, nowMs))
        .sort((x, y) => x.at - y.at)
        .map((r) => r.a),
    [assets, nowMs],
  );

  const assetById = useMemo(() => new Map(assets.map((a) => [a.id, a])), [assets]);
  const openAsset = openAssetId ? assetById.get(openAssetId) ?? null : null;

  if (rows.length === 0) return null;

  return (
    <div className="mt-4 overflow-hidden rounded-[var(--radius)] border border-border bg-surface">
      <div className="flex items-center gap-2.5 border-b border-border px-4 py-2.5">
        <p className="font-mono text-[10px] font-medium uppercase tracking-[0.14em] text-muted-2">
          Today
        </p>
        {/* Wall-clock text: format is deterministic, but the timezone is the
            renderer's — suppress so the browser's value wins without a
            hydration error when the server runs in another tz (prod = UTC). */}
        <span className="text-[11px] text-muted-2" suppressHydrationWarning>
          {formatDayLong(nowMs)}
        </span>
        <span className="ml-auto text-[11px] text-muted-2">
          {rows.length} {rows.length === 1 ? "post" : "posts"}
        </span>
      </div>

      <ul className="divide-y divide-border">
        {rows.map((a) => (
          <TodayRow
            key={a.id}
            asset={a}
            viewerIsClient={viewerIsClient}
            locked={a.locked === true || (viewerIsClient && !isAssetUnlockedForClient(a, nowMs))}
            onOpen={() => setOpenAssetId(a.id)}
          />
        ))}
      </ul>

      <AssetDetailModal
        asset={openAsset}
        open={openAsset != null}
        onClose={() => setOpenAssetId(null)}
      />
    </div>
  );
}

function TodayRow({
  asset,
  viewerIsClient,
  locked,
  onOpen,
}: {
  asset: Asset;
  viewerIsClient: boolean;
  locked: boolean;
  onOpen: () => void;
}) {
  const template = templateForAsset(asset);
  const agent = agentLabelForAsset(asset);
  const attribution = agent
    ? viewerIsClient
      ? `${agent} drafted you this`
      : `${agent} drafted this`
    : viewerIsClient
      ? "Drafted for you"
      : "Drafted";
  const timeStr = asset.scheduledAt != null ? formatTimeHM(asset.scheduledAt) : null;

  const body = (
    <>
      <div className="flex h-8 w-8 shrink-0 items-center justify-center rounded-md border border-foreground/10 bg-foreground/[0.04] text-foreground/70">
        <Icon name={locked ? "Lock" : (TYPE_ICON[asset.type] ?? "FileText")} className="h-4 w-4" />
      </div>
      <div className="min-w-0 flex-1">
        <div className="flex items-center gap-2">
          {template && (
            <Badge tone="neon" className="shrink-0">
              {template.name}
            </Badge>
          )}
          <p className="truncate text-sm font-medium">{locked ? "Upcoming post" : asset.title}</p>
        </div>
        <p className="mt-0.5 truncate text-[11px] text-muted-2" suppressHydrationWarning>
          {attribution}
          {timeStr ? ` · ${timeStr}` : ""}
        </p>
      </div>
      {!locked && <Icon name="ChevronRight" className="h-4 w-4 shrink-0 text-muted-2" />}
    </>
  );

  if (locked) {
    return <li className="flex items-center gap-3 px-4 py-2.5 opacity-80">{body}</li>;
  }

  return (
    <li>
      <button
        type="button"
        onClick={onOpen}
        className="flex w-full items-center gap-3 px-4 py-2.5 text-left transition-colors hover:bg-surface-2 focus:outline-none focus-visible:bg-surface-2"
      >
        {body}
      </button>
    </li>
  );
}
