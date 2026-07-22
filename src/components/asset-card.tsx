"use client";

import { useEffect, useState, useRef } from "react";
import type { KeyboardEvent } from "react";
import { useRouter } from "next/navigation";
import { Card, Badge, Button, Textarea } from "@/components/ui";
import { Icon } from "@/components/icon";
import { ImageLightbox } from "@/components/image-lightbox";
import { CopyCaptionButton } from "@/components/copy-caption-button";
import { assetImages } from "@/lib/asset-images";
import {
  updateAssetAction,
  approveAssetAction,
  recommendAssetScheduleAction,
  unscheduleAssetAction,
  publishAssetNowAction,
  markAssetPostedAction,
} from "@/lib/actions";
import { PUBLISHABLE_PLATFORMS, PLATFORM_LABELS, PLATFORM_REGISTRY } from "@/lib/integrations/platforms";
import { templateForAsset } from "@/lib/post-chain";
import { relativeTime, cn } from "@/lib/utils";
import type { Asset, PublishMode } from "@/lib/types";

/* ── Constants ───────────────────────────────────────────────────────── */

const TYPE_ICON: Record<string, string> = {
  instagram_post: "Camera",
  email: "Mail",
  article: "Newspaper",
  social_post: "Share2",
  note: "FileText",
};

const MODE_LABELS: Record<PublishMode, string> = {
  auto: "Auto-publish",
  manual: "Manual push",
  placeholder: "Placeholder",
};

// Slide metadata used by the carousel and rendering logic
type SlideMeta = { role?: string; headline?: string; body?: string | null; imageUrl?: string | null; attribution?: string | null };


/** epoch millis → value for <input type="datetime-local"> in the user's timezone */
function toLocalInputValue(t: number): string {
  const d = new Date(t);
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

/* ── Status badge tone ───────────────────────────────────────────────── */

function statusTone(status: Asset["status"]): "warning" | "neon" | "info" | "neutral" {
  if (status === "draft") return "warning";
  if (status === "approved") return "neon";
  if (status === "scheduled") return "info";
  return "neutral";
}

/* ── Pre-approval panel ──────────────────────────────────────────────── */

/**
 * The pre-approval step for a draft: pick the publishing tier (auto/manual/
 * placeholder) and the publication slot, then Approve. Approving stamps the asset
 * onto the content calendar at the chosen time. Auto-publish is only offered when
 * the agent's channel integration is connected and active for this client.
 */
function ApprovePanel({
  asset,
  connectedPlatforms,
  agentChannels,
  onDone,
}: {
  asset: Asset;
  connectedPlatforms: string[];
  agentChannels?: string[];
  onDone: () => void;
}) {
  const router = useRouter();
  const compatiblePlatforms = PUBLISHABLE_PLATFORMS[asset.type] ?? [];
  // The agent's declared channels narrow which platforms this asset targets; without
  // any, fall back to every platform the asset type can publish to.
  const channelPlatforms =
    agentChannels && agentChannels.length
      ? agentChannels.filter((p) => compatiblePlatforms.includes(p))
      : compatiblePlatforms;
  const availablePlatforms = connectedPlatforms.filter((p) => channelPlatforms.includes(p));
  const canAuto = availablePlatforms.length > 0;

  // eslint-disable-next-line react-hooks/purity -- initial values only; component mounts once per open
  const now = Date.now();
  const minDatetime = toLocalInputValue(now + 60_000);
  const recommended =
    asset.recommendedAt && asset.recommendedAt > now + 60_000 ? asset.recommendedAt : null;
  const [datetime, setDatetime] = useState(
    recommended ? toLocalInputValue(recommended) : minDatetime,
  );
  const [mode, setMode] = useState<PublishMode>(canAuto ? "auto" : "placeholder");
  const [platform, setPlatform] = useState(availablePlatforms[0] ?? "");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  // AI recommendation aware of the client's calendar density (fetched on open).
  const [aiRec, setAiRec] = useState<{ at: number; reason: string } | null>(null);
  const [recLoading, setRecLoading] = useState(true);

  useEffect(() => {
    let cancelled = false;
    recommendAssetScheduleAction(asset.id)
      .then((rec) => {
        if (cancelled || !rec) return;
        setAiRec(rec);
        // Only auto-fill if the user hasn't already picked a custom time.
        if (rec.at > Date.now() + 60_000) setDatetime(toLocalInputValue(rec.at));
      })
      .catch(() => {})
      .finally(() => {
        if (!cancelled) setRecLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [asset.id]);

  const suggestedAt = aiRec?.at ?? recommended;
  const suggestedReason = aiRec?.reason ?? asset.recommendedReason;
  const usingSuggested = suggestedAt != null && datetime === toLocalInputValue(suggestedAt);
  const showPlatformPicker = mode !== "placeholder" && availablePlatforms.length > 0;

  const modeOptions: { id: PublishMode; label: string; hint: string; disabled?: boolean }[] = [
    {
      id: "auto",
      label: MODE_LABELS.auto,
      hint: "Posts automatically at the scheduled time",
      disabled: !canAuto,
    },
    {
      id: "manual",
      label: MODE_LABELS.manual,
      hint: "On the calendar, you push it live with Publish Now",
    },
    {
      id: "placeholder",
      label: MODE_LABELS.placeholder,
      hint: "Calendar-only roadmap item. Karos never posts it",
    },
  ];

  async function handleApprove() {
    if (!datetime) return;
    setBusy(true);
    setError(null);
    try {
      await approveAssetAction(asset.id, {
        scheduledAt: new Date(datetime).getTime(),
        platform: mode === "placeholder" ? undefined : platform || undefined,
        publishMode: mode,
      });
      router.refresh();
      onDone();
    } catch (e) {
      setError(e instanceof Error ? e.message : "Approval failed");
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="mt-3 space-y-2.5 rounded-md border border-border bg-surface-2 p-3">
      <p className="text-[11px] font-mono font-medium uppercase tracking-[0.14em] text-muted-2">
        Approve &amp; add to content calendar
      </p>

      {/* Publishing tier */}
      <div className="flex flex-wrap gap-1.5">
        {modeOptions.map((opt) => (
          <button
            key={opt.id}
            onClick={() => !opt.disabled && setMode(opt.id)}
            disabled={opt.disabled}
            title={opt.disabled ? "Connect this agent's channel integration to enable auto-publishing" : opt.hint}
            className={cn(
              "rounded-md border px-2.5 py-1.5 text-[11px] font-medium transition-colors",
              mode === opt.id
                ? "border-neon/60 bg-neon/10 text-neon"
                : "border-border text-muted hover:text-foreground",
              opt.disabled && "cursor-not-allowed opacity-40",
            )}
          >
            {opt.label}
          </button>
        ))}
      </div>
      <p className="text-[11px] text-muted-2">
        {modeOptions.find((o) => o.id === mode)?.hint}
      </p>

      <div className="flex flex-wrap items-end gap-2">
        {/* Date + time */}
        <div className="min-w-[180px] flex-1">
          <label className="mb-1 block text-[11px] text-muted-2">Date &amp; time</label>
          <input
            type="datetime-local"
            value={datetime}
            min={minDatetime}
            onChange={(e) => setDatetime(e.target.value)}
            className="h-8 w-full rounded-md border border-border bg-surface px-2.5 text-xs text-foreground focus:outline-none focus:ring-2 focus:ring-neon/40"
          />
        </div>

        {/* Platform picker (auto/manual modes with connected platforms) */}
        {showPlatformPicker && (
          <div className="min-w-[130px]">
            <label className="mb-1 block text-[11px] text-muted-2">Platform</label>
            <select
              value={platform}
              onChange={(e) => setPlatform(e.target.value)}
              className="h-8 w-full rounded-md border border-border bg-surface px-2.5 text-xs text-foreground focus:outline-none focus:ring-2 focus:ring-neon/40"
            >
              {availablePlatforms.map((p) => (
                <option key={p} value={p}>
                  {PLATFORM_LABELS[p] ?? p}
                </option>
              ))}
            </select>
          </div>
        )}
      </div>

      {/* AI recommendation (calendar-density aware) */}
      {recLoading ? (
        <p className="flex items-center gap-1.5 text-[11px] text-muted-2">
          <Icon name="Loader" className="h-3 w-3 shrink-0 animate-spin text-neon" />
          Finding an optimal slot…
        </p>
      ) : (
        suggestedAt != null && (
          <p className="flex items-center gap-1.5 text-[11px] text-muted-2">
            <Icon name="Sparkles" className="h-3 w-3 shrink-0 text-neon" />
            <span>
              {usingSuggested ? "Using the recommended slot" : "AI recommends "}
              {!usingSuggested && (
                <button
                  onClick={() => setDatetime(toLocalInputValue(suggestedAt))}
                  className="font-medium text-neon hover:underline"
                >
                  {new Date(suggestedAt).toLocaleString([], {
                    month: "short",
                    day: "numeric",
                    hour: "numeric",
                    minute: "2-digit",
                  })}
                </button>
              )}
              {suggestedReason ? ` — ${suggestedReason}` : ""}
            </span>
          </p>
        )
      )}

      {!canAuto && compatiblePlatforms.length > 0 && (
        <p className="text-[11px] text-muted-2">
          <Icon name="AlertCircle" className="mr-1 inline h-3 w-3 text-warning" />
          Connect{" "}
          {channelPlatforms.map((p) => PLATFORM_LABELS[p] ?? p).join(" or ")}{" "}
          in the Integrations tab to enable auto-publishing.
        </p>
      )}

      {error && (
        <p className="rounded-md border border-danger/30 bg-danger/10 px-2.5 py-1.5 text-[11px] text-danger">
          {error}
        </p>
      )}

      <div className="flex gap-2">
        <Button size="sm" onClick={handleApprove} loading={busy} disabled={!datetime}>
          <Icon name="Check" className="h-3.5 w-3.5" />
          Approve
        </Button>
        <Button size="sm" variant="ghost" onClick={onDone}>
          Cancel
        </Button>
      </div>
    </div>
  );
}

/* ── Main component ──────────────────────────────────────────────────── */

function Carousel({ slides, onOpenLightbox }: { slides: SlideMeta[]; onOpenLightbox: (i: number) => void }) {
  const containerRef = useRef<HTMLDivElement | null>(null);
  const slideRefs = useRef<Array<HTMLDivElement | null>>([]);
  const [currentIndex, setCurrentIndex] = useState(0);

  useEffect(() => {
    const observer = new IntersectionObserver(
      (entries) => {
        for (const e of entries) {
          if (e.isIntersecting) {
            const idx = Number((e.target as HTMLElement).dataset?.slideIndex ?? -1);
            if (!Number.isNaN(idx) && idx >= 0) setCurrentIndex(idx);
          }
        }
      },
      { root: containerRef.current, threshold: 0.5 },
    );
    slideRefs.current.forEach((el) => el && observer.observe(el));
    return () => observer.disconnect();
  }, []);

  function scrollToIndex(i: number) {
    const el = slideRefs.current[i];
    if (el && containerRef.current) {
      el.scrollIntoView({ behavior: "smooth", block: "nearest", inline: "center" });
      setCurrentIndex(i);
      // focus the slide for screen readers
      try { el.focus({ preventScroll: true }); } catch {};
    }
  }

  function onKeyDown(e: KeyboardEvent) {
    if (e.key === "ArrowRight") {
      e.preventDefault();
      scrollToIndex(Math.min(currentIndex + 1, slides.length - 1));
    } else if (e.key === "ArrowLeft") {
      e.preventDefault();
      scrollToIndex(Math.max(currentIndex - 1, 0));
    } else if (e.key === "Home") {
      e.preventDefault();
      scrollToIndex(0);
    } else if (e.key === "End") {
      e.preventDefault();
      scrollToIndex(slides.length - 1);
    }
  }

  return (
    <div>
      <div
        ref={containerRef}
        tabIndex={0}
        role="region"
        aria-roledescription="carousel"
        aria-label={`Carousel with ${slides.length} slides`}
        onKeyDown={onKeyDown}
        className="flex overflow-x-auto snap-x snap-mandatory gap-4 pb-2 focus:outline-none"
      >
        {slides.map((s, i) => (
          <div
            key={i}
            ref={(el) => { slideRefs.current[i] = el; }}
            data-slide-index={i}
            tabIndex={-1}
            role="group"
            aria-roledescription="slide"
            aria-label={`Slide ${i + 1} of ${slides.length}`}
            className="snap-start shrink-0 w-full max-w-[420px] rounded-lg bg-surface-2 p-2"
          >
            {s.imageUrl ? (
              <button
                type="button"
                onClick={() => onOpenLightbox(i)}
                className="group relative block h-48 w-full overflow-hidden rounded-lg border border-border focus:outline-none focus:ring-2 focus:ring-neon/50"
                title="View full size"
              >
                {/* eslint-disable-next-line @next/next/no-img-element */}
                <img src={s.imageUrl} alt={s.headline ?? `Slide ${i + 1}`} className="h-full w-full object-cover transition-transform group-hover:scale-105" />
                <span className="absolute inset-0 flex items-center justify-center bg-black/0 text-white opacity-0 transition-opacity group-hover:bg-black/30 group-hover:opacity-100">
                  <Icon name="Maximize2" className="h-5 w-5" />
                </span>
              </button>
            ) : (
              <div className="flex h-48 items-center justify-center overflow-hidden rounded-lg border border-dashed border-border text-center text-[10px] text-muted-2">
                no photo
              </div>
            )}
            <div className="mt-2 min-w-0">
              <p className="text-xs font-medium">
                {s.headline ? `${i + 1}. ${s.headline}` : `Slide ${i + 1}`}
                {s.role ? <span className="text-muted-2"> · {s.role}</span> : null}
              </p>
              {s.body ? <p className="mt-0.5 whitespace-pre-wrap text-xs text-muted">{s.body}</p> : null}
              {s.attribution ? <p className="mt-1 text-[10px] text-muted-2">{s.attribution}</p> : null}
            </div>
          </div>
        ))}
      </div>

      {/* Visible dot indicators — keyboard focusable */}
      <div className="mt-2 flex items-center justify-center gap-2">
        {slides.map((_, i) => (
          <button
            key={i}
            onClick={() => scrollToIndex(i)}
            aria-label={`Go to slide ${i + 1}`}
            aria-current={currentIndex === i ? "true" : undefined}
            className={cn(
              "h-2 w-2 rounded-full transition-colors",
              currentIndex === i ? "bg-neon" : "bg-border/60",
            )}
          />
        ))}
      </div>
    </div>
  );
}

export function AssetCard({
  asset,
  canApprove,
  connectedPlatforms,
  agentChannels,
}: {
  asset: Asset;
  canApprove?: boolean;
  connectedPlatforms?: string[];
  /** The generating agent's distribution channels — gate auto-publish to these platforms. */
  agentChannels?: string[];
}) {
  const router = useRouter();
  const [open, setOpen] = useState(false);
  const [editing, setEditing] = useState(false);
  const [approving, setApproving] = useState(false);
  const [content, setContent] = useState(asset.content);
  const [busy, setBusy] = useState(false);

  const hashtags = (asset.meta?.hashtags as string[] | undefined) ?? [];
  const imageConcept = asset.meta?.imageConcept as string | undefined;
  const [publishError, setPublishError] = useState<string | null>(asset.publishError ?? null);
  // Surfaces failures from approve / save / unschedule so those actions don't fail silently.
  const [actionError, setActionError] = useState<string | null>(null);

  // Manual push available when a connected platform can carry this asset type.
  const compatibleConnected = (PUBLISHABLE_PLATFORMS[asset.type] ?? []).filter((p) =>
    (connectedPlatforms ?? []).includes(p),
  );
  const canPublishNow =
    canApprove && compatibleConnected.length > 0 && asset.status !== "published";

  // Marking a by-hand post live needs no integration and no staff role — it's a
  // statement about what the user already did, and for a client posting from
  // their phone it's the ONLY thing that can move the asset off "approved".
  // Drafts are excluded (nothing's been approved to post yet) as are
  // placeholders (roadmap entries that were never meant to go out).
  const canMarkPosted =
    (asset.status === "approved" || asset.status === "scheduled" || asset.status === "delivered") &&
    asset.publishMode !== "placeholder";

  // Notes have no scheduling dimension; everything else can land on the calendar.
  const calendarEligible = asset.type !== "note";

  // Content-engine carousels carry their slides (each with its own photo) in
  // meta.slides; a plain post has only the single cover `asset.imageUrl`.
  type SlideMeta = { role?: string; headline?: string; body?: string | null; imageUrl?: string | null; attribution?: string | null };
  const metaSlides = (asset.meta?.slides as SlideMeta[] | undefined)?.filter(Boolean) ?? [];

  // Every photo in the post, from whichever meta shape the ingest path left
  // behind — assetImages() is the one definition shared with the download
  // route and the lightbox. This card used to re-derive its own narrower
  // fallback (meta.artifacts / meta.images only) and render the cover from
  // asset.imageUrl alone, so an import whose photos landed in meta.files —
  // which is every lab import whose files the importer didn't classify as
  // images — drew a card with no preview at all while its Download button
  // happily offered the very photos the card wasn't showing.
  const galleryImages = assetImages(asset);
  const [lightboxIndex, setLightboxIndex] = useState<number | null>(null);

  // When the webhook didn't write structured meta.slides, treat the recovered
  // photos as the slide list so a multi-photo post shows the whole post and
  // not just its cover.
  const fallbackSlides: SlideMeta[] =
    metaSlides.length > 0 ? [] : galleryImages.map((g) => ({ imageUrl: g.url }));

  // Only treat as a carousel when there's genuinely more than one photo;
  // single-photo posts keep the cleaner full-width single-image rendering.
  const slides = metaSlides.length > 0 ? metaSlides : fallbackSlides.length > 1 ? fallbackSlides : [];
  const isCarousel = slides.length > 0;
  const photoCount = slides.filter((s) => s.imageUrl).length;

  // The single-photo cover: an explicit imageUrl wins, else the lone recovered
  // photo (assetImages already applies that precedence).
  const coverImageUrl = galleryImages.length === 1 ? galleryImages[0].url : null;

  // Deliverables that aren't photos and aren't the caption — a reference doc's
  // .pdf, a run's data.json. When they're ALL an asset has, they're the only
  // thing standing between the reader and an empty card, so name them.
  type MetaFile = { name?: string; relPath?: string; url?: string };
  const attachments = [
    ...((asset.meta?.files as MetaFile[] | undefined) ?? []),
    ...((asset.meta?.artifacts as MetaFile[] | undefined) ?? []),
  ].filter((f): f is MetaFile & { url: string } => typeof f?.url === "string");
  const hasPreview = Boolean(asset.content) || isCarousel || coverImageUrl != null;

  // Rich per-slide copy (headline/body/role/attribution) only exists on
  // content-engine posts; used to flesh out the expanded view. Each maps back
  // to its gallery index so its thumbnail opens the matching photo.
  type SlideMeta = { role?: string; headline?: string; body?: string | null; imageUrl?: string | null; attribution?: string | null };
  const richSlides = ((asset.meta?.slides as SlideMeta[] | undefined) ?? []).filter(
    (s) => s && (s.headline || s.body || s.attribution),
  );
  const galleryIndexForUrl = (url?: string | null) =>
    url ? galleryImages.findIndex((g) => g.url === url) : -1;

  // Template/format chip (e.g. "By The Numbers") — data-driven, legacy-safe.
  const template = templateForAsset(asset);
  // Resolve a primary platform (scheduledPlatform, fallback to agent channels)
  const primaryPlatform = asset.scheduledPlatform ?? (asset.channels && asset.channels.length ? asset.channels[0] : undefined);
  const platformConfig = PLATFORM_REGISTRY.find((p) => p.id === primaryPlatform);

  // Locked upcoming post: a future-dated deliverable the client can't open yet.
  // The server already redacted content/images/meta before this reached the
  // browser; render a placeholder with no content, images, or controls, and no
  // expand affordance. (Staff never receive locked assets.)
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
      <Card className="overflow-hidden">
        <div className="flex items-start gap-3">
          <div className="flex h-9 w-9 shrink-0 items-center justify-center rounded-md border border-foreground/10 bg-foreground/[0.04] text-muted-2">
            <Icon name="Lock" className="h-4 w-4" />
          </div>
          <div className="min-w-0 flex-1">
            <div className="flex items-center gap-2">
              {template && <Badge tone="neutral">{template.name}</Badge>}
              <p className="truncate text-sm font-medium text-muted">Upcoming post</p>
            </div>
            <p className="mt-1.5 flex items-center gap-1.5 text-xs text-muted-2">
              <Icon name="CalendarClock" className="h-3.5 w-3.5 shrink-0" />
              {unlockStr ? `Unlocks ${unlockStr}` : "Unlocks on its scheduled date"}
            </p>
          </div>
        </div>
      </Card>
    );
  }


  /** Approve a non-schedulable draft (e.g. a note) straight through — no calendar slot. */
  async function handleSimpleApprove() {
    setBusy(true);
    setActionError(null);
    try {
      await approveAssetAction(asset.id);
      router.refresh();
    } catch (e) {
      setActionError(e instanceof Error ? e.message : "Approval failed");
    } finally {
      setBusy(false);
    }
  }

  /** Record a by-hand post. See markAssetPostedAction — this is the only route
   *  to "published" that doesn't go through a platform integration. */
  async function handleMarkPosted() {
    setBusy(true);
    setActionError(null);
    try {
      const result = await markAssetPostedAction(asset.id);
      if (!result.ok) setActionError(result.error);
      else router.refresh();
    } catch (e) {
      setActionError(e instanceof Error ? e.message : "Couldn't mark this as posted");
    } finally {
      setBusy(false);
    }
  }

  async function saveEdit() {
    setBusy(true);
    setActionError(null);
    try {
      await updateAssetAction(asset.id, { content });
      setEditing(false);
      router.refresh();
    } catch (e) {
      setActionError(e instanceof Error ? e.message : "Couldn't save your changes");
    } finally {
      setBusy(false);
    }
  }

  async function handleUnschedule() {
    setBusy(true);
    setActionError(null);
    try {
      await unscheduleAssetAction(asset.id);
      router.refresh();
    } catch (e) {
      setActionError(e instanceof Error ? e.message : "Couldn't unschedule this asset");
    } finally {
      setBusy(false);
    }
  }

  async function handlePublishNow() {
    setBusy(true);
    setPublishError(null);
    try {
      const res = await publishAssetNowAction(asset.id, asset.scheduledPlatform);
      if (res.ok) {
        router.refresh();
      } else {
        setPublishError(res.error);
      }
    } finally {
      setBusy(false);
    }
  }

  return (
    <Card className="overflow-hidden">
      <div className="flex items-start gap-3">
        <div className="flex items-center gap-2">
            <div className="flex h-9 w-9 shrink-0 items-center justify-center rounded-md border border-foreground/10 bg-foreground/[0.04] text-foreground/70">
              <Icon name={TYPE_ICON[asset.type] ?? "FileText"} className="h-4 w-4" />
            </div>
            {platformConfig ? (
              <div className="flex h-7 w-7 items-center justify-center rounded-md text-white" style={{ background: platformConfig.color }}>
                <Icon name={platformConfig.icon} className="h-4 w-4" />
              </div>
            ) : null}
          </div>
        <div className="min-w-0 flex-1">
          <div className="flex items-center justify-between gap-2">
            <div className="flex min-w-0 items-center gap-2">
              <p className="truncate text-sm font-medium">{asset.title}</p>
              {template && (
                <Badge tone="neutral" className="shrink-0">
                  {template.name}
                </Badge>
              )}
            </div>
            <Badge tone={statusTone(asset.status)} className="shrink-0">
              {asset.status}
            </Badge>
          </div>
          <div className="group/caption relative">
            <p
              className={cn(
                "mt-1 whitespace-pre-wrap text-sm text-muted",
                asset.content && "pr-12",
                !open && "line-clamp-2",
              )}
            >
              {asset.content}
            </p>
            <CopyCaptionButton asset={asset} className="absolute right-0 top-0" />
          </div>

          {isCarousel ? (
            <div className="mt-2">
              <div className="flex gap-2 overflow-x-auto pb-1">
                {galleryImages.map((img, i) => (
                  <div key={i} className="w-28 shrink-0">
                    <button
                      type="button"
                      onClick={() => setLightboxIndex(i)}
                      className="group relative block h-36 w-28 overflow-hidden rounded-lg border border-border focus:outline-none focus:ring-2 focus:ring-neon/50"
                      title="View full size"
                    >
                      {/* eslint-disable-next-line @next/next/no-img-element */}
                      <img src={img.url} alt={img.caption ?? `Slide ${i + 1}`} className="h-full w-full object-cover transition-transform group-hover:scale-105" />
                      <span className="absolute inset-0 flex items-center justify-center bg-black/0 text-white opacity-0 transition-opacity group-hover:bg-black/30 group-hover:opacity-100">
                        <Icon name="Maximize2" className="h-5 w-5" />
                      </span>
                    </button>
                    <p className="mt-1 line-clamp-2 text-[10px] text-muted-2">{img.caption ?? `Slide ${i + 1}`}</p>
                  </div>
                ))}
              </div>
              <p className="mt-1 text-[10px] text-muted-2">
                {galleryImages.length} photos · tap a photo to view &amp; download
              </p>
            </div>
          ) : coverImageUrl ? (
            <button
              type="button"
              onClick={() => setLightboxIndex(0)}
              className="group relative mt-2 block w-full max-w-sm overflow-hidden rounded-lg border border-border focus:outline-none focus:ring-2 focus:ring-neon/50"
              title="View full size"
            >
              {/* eslint-disable-next-line @next/next/no-img-element */}
              <img src={coverImageUrl} alt={asset.title} className="w-full" />
              <span className="absolute right-2 top-2 flex items-center gap-1 rounded-md bg-black/50 px-2 py-1 text-[11px] text-white opacity-0 transition-opacity group-hover:opacity-100">
                <Icon name="Maximize2" className="h-3 w-3" />
                View
              </span>
            </button>
          ) : null}

          {/* No caption and no photo. Show the deliverables by name rather than
              the empty body this used to render — an asset always has SOMETHING
              (that's why it exists), it just isn't always inlineable. */}
          {!hasPreview && (
            <div className="mt-2 rounded-lg border border-dashed border-border px-3 py-2.5">
              {attachments.length > 0 ? (
                <ul className="space-y-1">
                  {attachments.map((f, i) => (
                    <li key={i}>
                      <a
                        href={f.url}
                        target="_blank"
                        rel="noreferrer"
                        className="inline-flex items-center gap-1.5 text-xs text-muted transition-colors hover:text-foreground"
                      >
                        <Icon name="FileText" className="h-3.5 w-3.5 shrink-0" />
                        <span className="truncate">{f.name ?? f.relPath ?? "Attachment"}</span>
                      </a>
                    </li>
                  ))}
                </ul>
              ) : (
                <p className="text-xs text-muted-2">No preview — this asset has no caption or photos yet.</p>
              )}
            </div>
          )}

          {open && (
            <>
              {hashtags.length > 0 && (
                <p className="mt-2 text-xs text-muted">
                  {hashtags.map((h) => "#" + h).join(" ")}
                </p>
              )}
              {isCarousel && (
                <div className="mt-2">
                  <div className="relative">
                    {/* Accessible carousel: keyboard navigation, ARIA roles, and visible dot indicators */}
                    <Carousel slides={slides} onOpenLightbox={(i) => setLightboxIndex(galleryIndexForSlide(i))} />
                  </div>
                  <p className="mt-1 text-[10px] text-muted-2">
                    {slides.length} slides · {photoCount} with photos
                    {photoCount > 0 && " · swipe to view & download"}
                  </p>
                </div>
              )}
              {!isCarousel && imageConcept && (
                <p className="mt-2 rounded-lg bg-surface-2 p-2 text-xs text-muted">
                  <span className="font-medium text-foreground">Visual: </span>
                  {imageConcept}
                </p>
              )}
              {editing && (
                <div className="mt-3 space-y-2">
                  <Textarea
                    value={content}
                    onChange={(e) => setContent(e.target.value)}
                    className="min-h-[120px]"
                  />
                  <div className="flex gap-2">
                    <Button size="sm" onClick={saveEdit} loading={busy}>
                      Save
                    </Button>
                    <Button
                      size="sm"
                      variant="ghost"
                      onClick={() => {
                        setEditing(false);
                        setContent(asset.content);
                      }}
                    >
                      Cancel
                    </Button>
                  </div>
                </div>
              )}
            </>
          )}

          {/* Scheduled info strip — shown for scheduled and approved-on-calendar assets */}
          {(asset.status === "scheduled" || asset.status === "approved") && asset.scheduledAt && (
            <div className="mt-2 flex items-center gap-2 rounded-md border border-border bg-surface-2 px-2.5 py-1.5">
              <Icon
                name={asset.publishMode === "placeholder" ? "CalendarDays" : "Clock"}
                className="h-3.5 w-3.5 shrink-0 text-info"
              />
              <p className="text-xs text-muted-2">
                {MODE_LABELS[asset.publishMode ?? "auto"]} ·{" "}
                <span className="font-medium text-foreground">
                  {new Date(asset.scheduledAt).toLocaleString([], {
                    month: "short",
                    day: "numeric",
                    hour: "numeric",
                    minute: "2-digit",
                  })}
                </span>
                {asset.scheduledPlatform && asset.publishMode !== "placeholder" && (
                  <>
                    {" "}
                    on{" "}
                    <span className="font-medium text-foreground">
                      {PLATFORM_LABELS[asset.scheduledPlatform] ?? asset.scheduledPlatform}
                    </span>
                  </>
                )}
              </p>
              {canApprove && (
                <button
                  onClick={handleUnschedule}
                  disabled={busy}
                  className="ml-auto text-[11px] text-muted-2 transition-colors hover:text-danger disabled:opacity-50"
                >
                  Unschedule
                </button>
              )}
            </div>
          )}

          {/* Last publish failure (manual push or auto cron) */}
          {publishError && asset.status !== "published" && (
            <div className="mt-2 flex items-start gap-2 rounded-md border border-danger/30 bg-danger/10 px-2.5 py-1.5">
              <Icon name="AlertCircle" className="mt-0.5 h-3.5 w-3.5 shrink-0 text-danger" />
              <p className="text-xs text-danger">Publish failed: {publishError}</p>
            </div>
          )}

          {/* Approve / save / unschedule failure */}
          {actionError && (
            <div className="mt-2 flex items-start gap-2 rounded-md border border-danger/30 bg-danger/10 px-2.5 py-1.5">
              <Icon name="AlertCircle" className="mt-0.5 h-3.5 w-3.5 shrink-0 text-danger" />
              <p className="text-xs text-danger">{actionError}</p>
            </div>
          )}

          {/* Pre-approval panel (mode + slot) */}
          {approving && canApprove && (
            <ApprovePanel
              asset={asset}
              connectedPlatforms={connectedPlatforms ?? []}
              agentChannels={agentChannels ?? asset.channels}
              onDone={() => setApproving(false)}
            />
          )}

          <div className="mt-3 flex flex-wrap items-center gap-2">
            <button
              onClick={() => setOpen((o) => !o)}
              className="text-xs text-muted hover:text-foreground"
            >
              {open ? "Collapse" : "Expand"}
            </button>
            <span className="text-xs text-muted-2">· {relativeTime(asset.createdAt)}</span>
            {galleryImages.length > 0 && (
              <a
                href={`/api/assets/${asset.id}/download`}
                download
                className="inline-flex items-center gap-1 text-xs text-muted transition-colors hover:text-foreground"
                title={
                  galleryImages.length > 1
                    ? `Download all ${galleryImages.length} photos as a zip`
                    : "Download photo"
                }
              >
                <Icon name="Download" className="h-3.5 w-3.5" />
                {galleryImages.length > 1 ? `Download all (${galleryImages.length})` : "Download"}
              </a>
            )}
            {asset.status === "draft" && asset.recommendedAt && (
              <span
                className="inline-flex items-center gap-1 text-xs text-muted-2"
                title={asset.recommendedReason ?? "Agent-recommended publish time"}
              >
                · <Icon name="Sparkles" className="h-3 w-3 text-neon/70" />
                {new Date(asset.recommendedAt).toLocaleString([], {
                  month: "short",
                  day: "numeric",
                  hour: "numeric",
                  minute: "2-digit",
                })}
              </span>
            )}

            <div className="ml-auto flex gap-1.5">
              {canApprove && !editing && (
                <Button
                  size="sm"
                  variant="outline"
                  onClick={() => {
                    setOpen(true);
                    setEditing(true);
                    setApproving(false);
                  }}
                >
                  <Icon name="Pencil" className="h-3.5 w-3.5" />
                </Button>
              )}
              {canPublishNow && (
                <Button
                  size="sm"
                  variant="outline"
                  onClick={handlePublishNow}
                  loading={busy}
                  title={`Push live now via ${
                    PLATFORM_LABELS[asset.scheduledPlatform ?? compatibleConnected[0]] ??
                    "the connected platform"
                  }`}
                >
                  <Icon name="Send" className="h-3.5 w-3.5" />
                  Publish Now
                </Button>
              )}
              {canMarkPosted && (
                <Button
                  size="sm"
                  variant="outline"
                  onClick={handleMarkPosted}
                  loading={busy}
                  title="You posted this yourself — mark it live so the calendar and status reflect it"
                >
                  <Icon name="CheckCheck" className="h-3.5 w-3.5" />
                  Mark as posted
                </Button>
              )}
              {canApprove && asset.status === "draft" && !approving && (
                <div className="flex items-center gap-2">
                  <Button
                    size="sm"
                    onClick={() => {
                      if (calendarEligible) {
                        setApproving(true);
                        setEditing(false);
                      } else {
                        handleSimpleApprove();
                      }
                    }}
                    loading={busy}
                  >
                    <Icon name="Check" className="h-3.5 w-3.5" />
                    Approve
                  </Button>
                  {!editing && (
                    <Button size="sm" variant="outline" onClick={() => { setOpen(true); setEditing(true); setApproving(false); }}>
                      <Icon name="Pencil" className="h-3.5 w-3.5" />
                      Edit
                    </Button>
                  )}
                </div>
              )}
            </div>
          </div>
        </div>
      </div>

      {lightboxIndex !== null && galleryImages.length > 0 && (
        <ImageLightbox
          images={galleryImages}
          index={lightboxIndex}
          onIndexChange={setLightboxIndex}
          onClose={() => setLightboxIndex(null)}
          downloadUrl={`/api/assets/${asset.id}/download`}
        />
      )}
    </Card>
  );
}
