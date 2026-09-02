"use client";

import { useState } from "react";
import { AssetDetailModal } from "@/components/asset-detail-modal";
import { ContextGroundingNotice } from "@/components/context-grounding-notice";
import { Badge, Button } from "@/components/ui";
import { Icon } from "@/components/icon";
import { relativeTime } from "@/lib/utils";
import type { Asset } from "@/lib/types";

/**
 * The "What it has made for you" rows on the agent detail page, with a way IN.
 *
 * These rows used to be inert — a title, a stamp, and one small "Open your
 * Workspace" text link under the whole list, so reaching any single deliverable
 * meant leaving the page and finding it again in the archive. Each row now
 * carries its own View-output control, which opens the SAME detail modal the
 * archive and the calendar use (AssetDetailModal — the one that mounts the
 * per-draft pick/edit/skip reader for agent draft batches). One modal, one
 * reader, reached from one more place; nothing is re-implemented here.
 *
 * The set arrives ALREADY projected for the viewer (a client's rows are their
 * archive set — delivered work only), and the stamp arrives precomputed by the
 * page for the same reason it always was: `deliverableStamp` picks the client
 * delivery time for a client and the generation instant for staff, and that
 * choice belongs to the boundary that knows the viewer (A3/A4).
 */
export function AgentArchiveRows({
  rows,
  viewerIsClient,
}: {
  /**
   * Each row carries EITHER the page's resolved display title (viewer-gated,
   * see the page's rowTitleFields) OR a `fallbackNoun` — the produced-work
   * noun this component dates itself, client-side, so the day is in the
   * viewer's timezone like the relative stamp beside it. The stored
   * asset.title is never re-read here.
   *
   * `runLabel` is the staff-only operator name for the run that produced the
   * row (B4, parity pass 2026-09). It used to be concatenated INTO `title`,
   * which replaced the client's primary text rather than adding to it; it is
   * its own muted span now, so the row's first words are the same for both
   * readers. The page passes it for staff only.
   */
  rows: Array<{
    asset: Asset;
    at: number;
    title?: string;
    fallbackNoun?: string;
    runLabel?: string;
  }>;
  viewerIsClient: boolean;
}) {
  const [openAssetId, setOpenAssetId] = useState<string | null>(null);
  const openAsset = rows.find((row) => row.asset.id === openAssetId)?.asset ?? null;

  return (
    <>
      <ul className="space-y-1.5">
        {rows.map(({ asset, at, title, fallbackNoun, runLabel }) => (
          <li
            key={asset.id}
            className="flex flex-wrap items-center gap-x-3 gap-y-2 rounded-[var(--radius)] border border-border bg-surface-2/50 px-3 py-2"
          >
            <span className="min-w-0 flex-1 basis-40 truncate text-xs text-foreground">
              {title ??
                (fallbackNoun
                  ? `${fallbackNoun} · ${new Date(at).toLocaleDateString([], { month: "short", day: "numeric" })}`
                  : "Untitled")}
            </span>
            {/* B4: additive, and after the shared title rather than inside it. */}
            {runLabel && <span className="shrink-0 text-[11px] text-muted-2">{runLabel}</span>}
            {asset.templateName && <Badge tone="neutral">{asset.templateName}</Badge>}
            {/* SCRUM-404: on the ROW, not only inside the modal. A list that
                hides this until you click reads as though every row were
                equally grounded, which is the thing the marker exists to stop.
                The full note (reason + missing documents) is in the modal this
                row opens. */}
            {asset.contextGrounding && <ContextGroundingNotice grounding={asset.contextGrounding} variant="chip" />}
            <span className="shrink-0 text-[11px] text-muted-2">{relativeTime(at)}</span>
            {/* Orange-outline, not variant="accent": the accent is THE one
                rationed solid-orange CTA per screen ("Create a new post" on
                this page), and up to eight of these render at once. The neon
                border/text keeps the control unmistakably the brand action
                color without out-shouting the page's actual conversion CTA —
                same ration the ledger's own compact-row precedents keep
                (outputs-hub's rows open this very modal from a plain title). */}
            <Button
              size="sm"
              variant="outline"
              className="border-neon/40 text-neon hover:border-neon/70 hover:bg-neon/10"
              onClick={() => setOpenAssetId(asset.id)}
            >
              <Icon name="Eye" className="h-3.5 w-3.5" />
              View output
            </Button>
          </li>
        ))}
      </ul>

      <AssetDetailModal
        asset={openAsset}
        open={openAsset != null}
        onClose={() => setOpenAssetId(null)}
        viewerIsClient={viewerIsClient}
      />
    </>
  );
}
