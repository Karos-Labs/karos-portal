"use client";

import { Modal } from "@/components/modal";
import { Badge } from "@/components/ui";
import { Icon } from "@/components/icon";
import { PLATFORM_LABELS } from "@/lib/integrations/platforms";
import type { Asset, Agent } from "@/lib/types";

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

/** Which native download formats apply to this asset, by MIME type. */
function downloadFormats(asset: Asset): Array<{ format: string; label: string; icon: string }> {
  const out: Array<{ format: string; label: string; icon: string }> = [];
  const isVideo = asset.mimeType?.startsWith("video/");
  const videoMeta = (asset.meta?.videoUrl as string | undefined) ?? (asset.meta?.mediaUrl as string | undefined);
  if (asset.imageUrl && !isVideo) out.push({ format: "image", label: "Image (.jpg)", icon: "Camera" });
  if (isVideo || videoMeta) out.push({ format: "video", label: "Video", icon: "Video" });
  if (asset.content?.trim()) out.push({ format: "text", label: "Text (.txt)", icon: "FileText" });
  return out;
}

/** Native download actions for an asset — anchors to the same-origin download route. */
export function AssetDownloadButtons({ asset, className }: { asset: Asset; className?: string }) {
  const formats = downloadFormats(asset);
  if (formats.length === 0) return null;
  return (
    <div className={className ?? "flex flex-wrap gap-1.5"}>
      {formats.map((f) => (
        <a
          key={f.format}
          href={`/api/assets/${asset.id}/download?format=${f.format}`}
          download
          className="inline-flex items-center gap-1.5 rounded-md border border-border px-2.5 py-1.5 text-[11px] font-medium text-muted transition-colors hover:border-border-strong hover:text-foreground"
        >
          <Icon name={f.icon} className="h-3.5 w-3.5" />
          <Icon name="Download" className="h-3 w-3" />
          {f.label}
        </a>
      ))}
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
  agents,
  open,
  onClose,
}: {
  asset: Asset | null;
  agents?: Agent[];
  open: boolean;
  onClose: () => void;
}) {
  if (!asset) return null;

  const agent = asset.agentId ? agents?.find((a) => a.id === asset.agentId) : undefined;
  const hashtags = (asset.meta?.hashtags as string[] | undefined) ?? [];
  const imageConcept = asset.meta?.imageConcept as string | undefined;
  const slides = (asset.meta?.slides as SlideMeta[] | undefined)?.filter(Boolean) ?? [];
  const channels = asset.channels ?? [];
  const when = asset.scheduledAt ?? asset.recommendedAt;

  return (
    <Modal open={open} onClose={onClose} title={asset.title} className="max-w-2xl">
      <div className="space-y-4">
        {/* Status + type row */}
        <div className="flex flex-wrap items-center gap-2">
          <Badge tone={statusTone(asset.status)}>{asset.status}</Badge>
          <span className="inline-flex items-center gap-1.5 text-xs text-muted-2">
            <Icon name={TYPE_ICON[asset.type] ?? "FileText"} className="h-3.5 w-3.5" />
            {asset.type.replace(/_/g, " ")}
          </span>
          {agent && (
            <span className="inline-flex items-center gap-1.5 text-xs text-muted-2">
              <Icon name={agent.icon} className="h-3.5 w-3.5" />
              {agent.name}
            </span>
          )}
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
            value={channels.length ? channels.map((c) => PLATFORM_LABELS[c] ?? c).join(", ") : "—"}
          />
        </div>

        {asset.recommendedReason && asset.scheduledAt == null && (
          <p className="flex items-start gap-1.5 text-[11px] text-muted-2">
            <Icon name="Sparkles" className="mt-0.5 h-3 w-3 shrink-0 text-neon" />
            {asset.recommendedReason}
          </p>
        )}

        {/* Cover image (non-carousel) */}
        {slides.length === 0 && asset.imageUrl && (
          // eslint-disable-next-line @next/next/no-img-element
          <img src={asset.imageUrl} alt={asset.title} className="w-full rounded-lg border border-border" />
        )}

        {/* Content */}
        <div>
          <p className="mb-1.5 text-[10px] font-mono font-medium uppercase tracking-[0.14em] text-muted-2">Content</p>
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
        <div className="border-t border-border pt-3">
          <p className="mb-2 text-[10px] font-mono font-medium uppercase tracking-[0.14em] text-muted-2">Download</p>
          <AssetDownloadButtons asset={asset} />
        </div>
      </div>
    </Modal>
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
