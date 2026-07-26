"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { Modal } from "@/components/modal";
import { Badge } from "@/components/ui";
import { Icon } from "@/components/icon";
import { AudienceSimulation } from "@/components/audience-simulation";
import { CopyCaptionButton } from "@/components/copy-caption-button";
import { markAssetPostedAction } from "@/lib/actions";
import { PLATFORM_LABELS } from "@/lib/integrations/platforms";
import { assetImages } from "@/lib/asset-images";
import { cn } from "@/lib/utils";
import { templateForAsset } from "@/lib/post-chain";
import type { Asset } from "@/lib/types";

const TYPE_ICON: Record<string, string> = {
  instagram_post: "Camera",
  email: "Mail",
  article: "Newspaper",
  social_post: "Share2",
  note: "FileText",
};

const MODE_LABELS: Record<string, string> = {
  auto: "Auto-publish",
  manual: "Manual push",
  placeholder: "Placeholder",
};

function statusTone(status: Asset["status"]): "warning" | "neon" | "info" | "neutral" {
  if (status === "draft") return "warning";
  if (status === "approved") return "neon";
  if (status === "scheduled") return "info";
  return "neutral";
}

function fmt(t: number): string {
  return new Date(t).toLocaleString([], {
    weekday: "short",
    month: "short",
    day: "numeric",
    hour: "numeric",
    minute: "2-digit",
  });
}

/** Native download action for an asset's photos — anchors to the shared download route
 *  (single image, or a zip when the asset carries a carousel). */
export function AssetDownloadButtons({ asset, className }: { asset: Asset; className?: string }) {
  if (asset.locked) return null;
  const images = assetImages(asset);
  if (images.length === 0) return null;
  return (
    <div className={className ?? "flex flex-wrap gap-1.5"}>
      <a
        href={`/api/assets/${asset.id}/download`}
        download
        className="inline-flex items-center gap-1.5 rounded-md border border-border px-2.5 py-1.5 text-[11px] font-medium text-muted transition-colors hover:border-border-strong hover:text-foreground"
      >
        <Icon name="Camera" className="h-3.5 w-3.5" />
        <Icon name="Download" className="h-3 w-3" />
        {images.length > 1 ? `Download all (${images.length})` : "Download"}
      </a>
    </div>
  );
}

type SlideMeta = {
  role?: string;
  headline?: string;
  body?: string | null;
  imageUrl?: string | null;
  attribution?: string | null;
};

/**
 * Read-only detail view of a single asset — full output content plus all its
 * metadata (status, channels, schedule, platform, publish mode). Opened from the
 * content calendar when a scheduled item is clicked.
 */
export function AssetDetailModal({
  asset,
  open,
  onClose,
}: {
  asset: Asset | null;
  open: boolean;
  onClose: () => void;
}) {
  const [tab, setTab] = useState<"details" | "simulation">("details");
  if (!asset) return null;

  const template = templateForAsset(asset);

  // Defensive lock guard: the calendar/Today never open a locked asset, but if
  // one reaches here (belt-and-braces) show only the template placeholder + the
  // unlock date — never content, images, hashtags, or the download buttons.
  if (asset.locked) {
    const unlockStr =
      asset.scheduledAt != null
        ? new Date(asset.scheduledAt).toLocaleDateString([], {
            weekday: "short",
            month: "short",
            day: "numeric",
          })
        : null;
    return (
      <Modal open={open} onClose={onClose} title={template?.name ?? "Upcoming post"} className="max-w-md">
        <div className="flex flex-col items-center gap-3 py-6 text-center">
          <div className="flex h-12 w-12 items-center justify-center rounded-full border border-border bg-surface-2 text-muted-2">
            <Icon name="Lock" className="h-5 w-5" />
          </div>
          {template && <Badge tone="neutral">{template.name}</Badge>}
          <p className="text-sm font-medium text-foreground">Upcoming post</p>
          <p className="max-w-xs text-xs text-muted-2">
            {unlockStr
              ? `This deliverable unlocks on ${unlockStr}. You'll be able to view and download it then.`
              : "This deliverable unlocks on its scheduled date."}
          </p>
        </div>
      </Modal>
    );
  }

  const hashtags = (asset.meta?.hashtags as string[] | undefined) ?? [];
  const imageConcept = asset.meta?.imageConcept as string | undefined;
  const slides = (asset.meta?.slides as SlideMeta[] | undefined)?.filter(Boolean) ?? [];
  const channels = asset.channels ?? [];
  const when = asset.scheduledAt ?? asset.recommendedAt;
  const images = assetImages(asset);
  // The lead photo whenever this isn't a structured meta.slides carousel. NOT
  // `length === 1`: a post with several photos and no meta.slides (every
  // multi-photo lab import) would then show nothing at all, where the old
  // asset.imageUrl-only cover at least showed the first one. The rest stay
  // reachable via Download all below.
  const coverImageUrl = images.length > 0 ? images[0].url : null;

  return (
    <Modal open={open} onClose={onClose} title={asset.title} className="max-w-2xl">
      {/* Tabs */}
      <div className="mb-4 flex gap-1 border-b border-border">
        <TabButton active={tab === "details"} onClick={() => setTab("details")} icon="FileText">
          Details
        </TabButton>
        <TabButton active={tab === "simulation"} onClick={() => setTab("simulation")} icon="Users">
          Audience Simulation
        </TabButton>
      </div>

      {tab === "simulation" ? (
        <AudienceSimulation key={asset.id} clientId={asset.clientId} assetId={asset.id} />
      ) : (
      <div className="space-y-4">
        {/* Status + template + type row */}
        <div className="flex flex-wrap items-center gap-2">
          <Badge tone={statusTone(asset.status)}>{asset.status}</Badge>
          {template && <Badge tone="neutral">{template.name}</Badge>}
          <span className="inline-flex items-center gap-1.5 text-xs text-muted-2">
            <Icon name={TYPE_ICON[asset.type] ?? "FileText"} className="h-3.5 w-3.5" />
            {asset.type.replace(/_/g, " ")}
          </span>
        </div>

        {/* Metadata grid */}
        <div className="grid gap-3 rounded-md border border-border bg-surface-2 p-3 sm:grid-cols-2">
          {when != null && (
            <Meta
              icon={asset.scheduledAt != null ? "CalendarClock" : "Sparkles"}
              label={asset.scheduledAt != null ? "Scheduled for" : "Recommended slot"}
              value={fmt(when)}
            />
          )}
          {asset.publishMode && (
            <Meta icon="Settings2" label="Publishing" value={MODE_LABELS[asset.publishMode] ?? asset.publishMode} />
          )}
          {asset.scheduledPlatform && (
            <Meta icon="Send" label="Platform" value={PLATFORM_LABELS[asset.scheduledPlatform] ?? asset.scheduledPlatform} />
          )}
          <Meta
            icon="Share2"
            label="Channels"
            value={channels.length ? channels.map((c) => PLATFORM_LABELS[c] ?? c).join(", ") : "-"}
          />
        </div>

        {asset.recommendedReason && asset.scheduledAt == null && (
          <p className="flex items-start gap-1.5 text-[11px] text-muted-2">
            <Icon name="Sparkles" className="mt-0.5 h-3 w-3 shrink-0 text-neon" />
            {asset.recommendedReason}
          </p>
        )}

        {/* Cover image (non-carousel). Sourced from assetImages() rather than
            asset.imageUrl alone, which missed any import whose photos landed in
            meta.files — the same gap that rendered those assets' cards blank. */}
        {slides.length === 0 && coverImageUrl && (
          // eslint-disable-next-line @next/next/no-img-element
          <img src={coverImageUrl} alt={asset.title} className="w-full rounded-lg border border-border" />
        )}

        {/* Content */}
        <div>
          <div className="mb-1.5 flex items-center justify-between gap-2">
            <p className="text-[10px] font-mono font-medium uppercase tracking-[0.14em] text-muted-2">Content</p>
            {/* Posting happens by hand from a phone, and this modal is the
                phone's way into a post — so copy is a primary action here, not
                the card's hover-revealed icon. */}
            <CopyCaptionButton asset={asset} variant="full" />
          </div>
          <p className="whitespace-pre-wrap text-sm text-foreground/90">{asset.content}</p>
        </div>

        {hashtags.length > 0 && (
          <p className="text-xs text-muted">{hashtags.map((h) => "#" + h).join(" ")}</p>
        )}

        {imageConcept && (
          <p className="rounded-lg bg-surface-2 p-2 text-xs text-muted">
            <span className="font-medium text-foreground">Visual: </span>
            {imageConcept}
          </p>
        )}

        {/* Carousel slides */}
        {slides.length > 0 && (
          <div className="space-y-2">
            {slides.map((s, i) => (
              <div key={i} className="flex gap-2 rounded-lg bg-surface-2 p-2">
                {s.imageUrl && (
                  // eslint-disable-next-line @next/next/no-img-element
                  <img src={s.imageUrl} alt="" className="h-24 w-20 shrink-0 rounded border border-border object-cover" />
                )}
                <div className="min-w-0">
                  <p className="text-xs font-medium">
                    {i + 1}. {s.headline}
                    {s.role ? <span className="text-muted-2"> · {s.role}</span> : null}
                  </p>
                  {s.body ? <p className="mt-0.5 whitespace-pre-wrap text-xs text-muted">{s.body}</p> : null}
                </div>
              </div>
            ))}
          </div>
        )}

        {/* Downloads */}
        {images.length > 0 && (
          <div className="border-t border-border pt-3">
            <p className="mb-2 text-[10px] font-mono font-medium uppercase tracking-[0.14em] text-muted-2">Download</p>
            <AssetDownloadButtons asset={asset} />
          </div>
        )}

        <MarkPostedRow asset={asset} />
      </div>
      )}
    </Modal>
  );
}

/**
 * "I posted this myself." The calendar → modal path is how a post gets read on
 * a phone, and posting is done by hand from there (copy the caption, paste it
 * into the platform), so this is where the loop has to be closed — without it
 * nothing the user does can ever move the asset off approved/scheduled.
 */
function MarkPostedRow({ asset }: { asset: Asset }) {
  const router = useRouter();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const eligible =
    (asset.status === "approved" || asset.status === "scheduled" || asset.status === "delivered") &&
    asset.publishMode !== "placeholder";
  if (!eligible) return null;

  async function markPosted() {
    setBusy(true);
    setError(null);
    try {
      const result = await markAssetPostedAction(asset.id);
      if (!result.ok) setError(result.error);
      else router.refresh();
    } catch (e) {
      setError(e instanceof Error ? e.message : "Couldn't mark this as posted");
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="border-t border-border pt-3">
      <p className="mb-2 text-[10px] font-mono font-medium uppercase tracking-[0.14em] text-muted-2">
        Already posted it?
      </p>
      <button
        type="button"
        onClick={markPosted}
        disabled={busy}
        className="inline-flex h-11 items-center gap-1.5 rounded-md border border-border px-3 text-xs font-medium text-muted transition-colors hover:border-border-strong hover:text-foreground disabled:opacity-60"
      >
        <Icon name="CheckCheck" className="h-3.5 w-3.5" />
        {busy ? "Marking…" : "Mark as posted"}
      </button>
      <p className="mt-1.5 text-[11px] text-muted-2">
        Moves it to Published so the calendar shows what&apos;s live.
      </p>
      {error && <p className="mt-1.5 text-[11px] text-danger">{error}</p>}
    </div>
  );
}

function TabButton({
  active,
  onClick,
  icon,
  children,
}: {
  active: boolean;
  onClick: () => void;
  icon: string;
  children: React.ReactNode;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      className={cn(
        "-mb-px flex items-center gap-1.5 border-b-2 px-3 py-2 text-sm font-medium transition-colors",
        active
          ? "border-neon text-foreground"
          : "border-transparent text-muted-2 hover:text-muted",
      )}
    >
      <Icon name={icon} className="h-3.5 w-3.5" />
      {children}
    </button>
  );
}

function Meta({ icon, label, value }: { icon: string; label: string; value: string }) {
  return (
    <div className="flex items-start gap-2">
      <Icon name={icon} className="mt-0.5 h-3.5 w-3.5 shrink-0 text-muted-2" />
      <div className="min-w-0">
        <p className="text-[10px] uppercase tracking-wide text-muted-2">{label}</p>
        <p className="truncate text-xs font-medium text-foreground">{value}</p>
      </div>
    </div>
  );
}
