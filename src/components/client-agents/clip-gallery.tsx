"use client";

import { useState } from "react";
import { Badge } from "@/components/ui";
import { Icon } from "@/components/icon";
import { AssetDetailModal } from "@/components/asset-detail-modal";
import { assetImages, assetVideos } from "@/lib/asset-images";
import { clientDeliveryStamp } from "@/lib/asset-visibility";
import { relativeTime } from "@/lib/utils";
import type { Asset } from "@/lib/types";

/**
 * The clip maker's deliverables, FIRST (CD-I1 archetype 2).
 *
 * Albert's ask is that each agent's page be "a logical UI… based on what each
 * of the agents does", and what this one does is make video. A list of titles
 * and timestamps — which is what the generic detail page gave it — is not a way
 * to look at a video: you cannot tell a good cut from a bad one, or even that
 * the deliverable IS a video, without opening something. So the gallery is the
 * hero and everything else on the page sits under it.
 *
 * NOTHING IS RE-IMPLEMENTED HERE. The tiles are the archive tile's treatment
 * (poster + play badge), and opening one mounts the SAME AssetDetailModal every
 * other deliverable surface opens — which already carries the F150 video-player
 * render, the caption copy button and the download affordances. A second player
 * on this page would be a second place for the video path to drift, and F150
 * exists precisely because that path was missing once already.
 *
 * SAFE BY CONSTRUCTION for a client viewer: the assets reaching this component
 * have passed `getClientArchiveAssets`, so drafts, launch deliverables and
 * future-dated posts were dropped server-side rather than filtered at render.
 * A locked asset could not render a clip even if one slipped through —
 * `redactLockedAsset` builds its copy by whitelist and never carries `videoUrl`.
 */
export function ClipGallery({
  clips,
  viewerIsClient,
  connectedPlatforms,
  canApprove = false,
  emptyHint,
}: {
  clips: Asset[];
  viewerIsClient: boolean;
  connectedPlatforms?: string[];
  /** Staff only — the modal's approve control. */
  canApprove?: boolean;
  /** What happens next, when there is nothing yet. */
  emptyHint: string;
}) {
  const [open, setOpen] = useState<Asset | null>(null);

  if (clips.length === 0) {
    return (
      <div className="rounded-[var(--radius)] border border-border bg-surface-2/50 px-4 py-6 text-center">
        <Icon name="Video" className="mx-auto h-7 w-7 text-muted-2" />
        {/* Honest, and specific about the next step. "No clips yet" on its own
            is a dead end; the client's question is always "so what happens
            now", and the answer differs by whether the agent has what it needs
            to cut from — which is why the caller passes the line. */}
        <p className="mt-2 text-sm text-foreground">No clips yet</p>
        <p className="mx-auto mt-1 max-w-md text-xs leading-relaxed text-muted-2">{emptyHint}</p>
      </div>
    );
  }

  return (
    <>
      <ul className="grid grid-cols-2 gap-2.5 sm:grid-cols-3 sm:gap-3">
        {clips.map((asset) => (
          <li key={asset.id}>
            <ClipTile asset={asset} viewerIsClient={viewerIsClient} onOpen={() => setOpen(asset)} />
          </li>
        ))}
      </ul>
      <AssetDetailModal
        asset={open}
        open={open !== null}
        onClose={() => setOpen(null)}
        canPublish={canApprove}
        {...(connectedPlatforms ? { connectedPlatforms } : {})}
      />
    </>
  );
}

function ClipTile({
  asset,
  viewerIsClient,
  onOpen,
}: {
  asset: Asset;
  viewerIsClient: boolean;
  onOpen: () => void;
}) {
  const poster = assetImages(asset)[0];
  const count = assetVideos(asset).length;
  return (
    <button
      type="button"
      onClick={onOpen}
      className="group flex w-full flex-col overflow-hidden rounded-[var(--radius)] border border-border bg-surface text-left transition-all duration-150 hover:-translate-y-0.5 hover:border-neon/50 hover:shadow-lg focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-neon/60"
    >
      <div className="relative aspect-[9/16] w-full overflow-hidden border-b border-border bg-black/60">
        {poster ? (
          // eslint-disable-next-line @next/next/no-img-element
          <img
            src={poster.url}
            alt=""
            className="h-full w-full object-cover transition-transform duration-200 group-hover:scale-[1.02]"
          />
        ) : null}
        <span className="absolute inset-0 flex items-center justify-center bg-black/25 text-white transition-colors group-hover:bg-black/15">
          <Icon name="Play" className="h-8 w-8" />
        </span>
        {count > 1 && (
          <span className="absolute right-1.5 top-1.5 rounded-md bg-black/70 px-1.5 py-0.5 text-[10px] text-white">
            {count} cuts
          </span>
        )}
      </div>
      <div className="p-2.5">
        <p className="truncate text-xs text-foreground">{asset.title || "Untitled clip"}</p>
        <div className="mt-1 flex flex-wrap items-center gap-1.5">
          {/* Staff keep the workflow state; a client's set is delivered work
              only, so a status chip there would only ever read one value. */}
          {!viewerIsClient && <Badge tone="neutral">{asset.status}</Badge>}
          {/* The DELIVERY moment for a client, never the generation instant:
              a whole batch shares one `createdAt`, so printing it under a
              gallery of "your clips" publishes the batch shape (A3/A4). Staff
              keep the generation time — for them it is the fact worth
              knowing. */}
          <span className="text-[11px] text-muted-2">
            {relativeTime(viewerIsClient ? clientDeliveryStamp(asset) : asset.createdAt)}
          </span>
        </div>
      </div>
    </button>
  );
}
