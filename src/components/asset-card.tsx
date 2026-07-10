"use client";

import { useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import { Card, Badge, Button, Textarea } from "@/components/ui";
import { Icon } from "@/components/icon";
import { ImageLightbox } from "@/components/image-lightbox";
import { assetImages } from "@/lib/asset-images";
import {
  updateAssetAction,
  approveAssetAction,
  recommendAssetScheduleAction,
  unscheduleAssetAction,
  publishAssetNowAction,
} from "@/lib/actions";
import { PUBLISHABLE_PLATFORMS, PLATFORM_LABELS } from "@/lib/integrations/platforms";
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
  const [copied, setCopied] = useState(false);

  async function copyCaption() {
    const hashtags = (asset.meta?.hashtags as string[] | undefined) ?? [];
    const text = hashtags.length
      ? `${asset.content}\n\n${hashtags.map((h) => "#" + h).join(" ")}`
      : asset.content;
    try {
      await navigator.clipboard.writeText(text);
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    } catch {
      /* clipboard blocked — no-op */
    }
  }

  const hashtags = (asset.meta?.hashtags as string[] | undefined) ?? [];
  const imageConcept = asset.meta?.imageConcept as string | undefined;
  const [publishError, setPublishError] = useState<string | null>(asset.publishError ?? null);

  // Manual push available when a connected platform can carry this asset type.
  const compatibleConnected = (PUBLISHABLE_PLATFORMS[asset.type] ?? []).filter((p) =>
    (connectedPlatforms ?? []).includes(p),
  );
  const canPublishNow =
    canApprove && compatibleConnected.length > 0 && asset.status !== "published";

  // Notes have no scheduling dimension; everything else can land on the calendar.
  const calendarEligible = asset.type !== "note";

  // Every photo in the post — handles content-engine slides, agent-service
  // artifacts, and lab-imported meta.images/files — as the single source of
  // truth for both the on-card strip and the lightbox/download route.
  const galleryImages = assetImages(asset);
  const isCarousel = galleryImages.length > 1;
  const [lightboxIndex, setLightboxIndex] = useState<number | null>(null);

  // Rich per-slide copy (headline/body/role/attribution) only exists on
  // content-engine posts; used to flesh out the expanded view. Each maps back
  // to its gallery index so its thumbnail opens the matching photo.
  type SlideMeta = { role?: string; headline?: string; body?: string | null; imageUrl?: string | null; attribution?: string | null };
  const richSlides = ((asset.meta?.slides as SlideMeta[] | undefined) ?? []).filter(
    (s) => s && (s.headline || s.body || s.attribution),
  );
  const galleryIndexForUrl = (url?: string | null) =>
    url ? galleryImages.findIndex((g) => g.url === url) : -1;

  async function setStatus(status: "approved" | "delivered" | "published") {
    setBusy(true);
    try {
      await updateAssetAction(asset.id, { status });
      router.refresh();
    } finally {
      setBusy(false);
    }
  }

  /** Approve a non-schedulable draft (e.g. a note) straight through — no calendar slot. */
  async function handleSimpleApprove() {
    setBusy(true);
    try {
      await approveAssetAction(asset.id);
      router.refresh();
    } finally {
      setBusy(false);
    }
  }

  async function saveEdit() {
    setBusy(true);
    try {
      await updateAssetAction(asset.id, { content });
      setEditing(false);
      router.refresh();
    } finally {
      setBusy(false);
    }
  }

  async function handleUnschedule() {
    setBusy(true);
    try {
      await unscheduleAssetAction(asset.id);
      router.refresh();
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
        <div className="flex h-9 w-9 shrink-0 items-center justify-center rounded-md border border-foreground/10 bg-foreground/[0.04] text-foreground/70">
          <Icon name={TYPE_ICON[asset.type] ?? "FileText"} className="h-4 w-4" />
        </div>
        <div className="min-w-0 flex-1">
          <div className="flex items-center justify-between gap-2">
            <p className="truncate text-sm font-medium">{asset.title}</p>
            <Badge tone={statusTone(asset.status)}>{asset.status}</Badge>
          </div>
          <div className="group/caption relative">
            <p className={`mt-1 whitespace-pre-wrap text-sm text-muted ${open ? "pr-8" : "line-clamp-2"}`}>
              {asset.content}
            </p>
            {asset.content && (
              <button
                type="button"
                onClick={copyCaption}
                title="Copy caption"
                className="absolute right-0 top-0 rounded-md border border-border bg-surface p-1.5 text-muted-2 opacity-0 transition-opacity hover:text-foreground focus:opacity-100 group-hover/caption:opacity-100"
              >
                <Icon name={copied ? "Check" : "Copy"} className={cn("h-3.5 w-3.5", copied && "text-neon")} />
              </button>
            )}
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
          ) : galleryImages.length === 1 ? (
            <button
              type="button"
              onClick={() => setLightboxIndex(0)}
              className="group relative mt-2 block w-full max-w-sm overflow-hidden rounded-lg border border-border focus:outline-none focus:ring-2 focus:ring-neon/50"
              title="View full size"
            >
              {/* eslint-disable-next-line @next/next/no-img-element */}
              <img src={galleryImages[0].url} alt={asset.title} className="w-full" />
              <span className="absolute right-2 top-2 flex items-center gap-1 rounded-md bg-black/50 px-2 py-1 text-[11px] text-white opacity-0 transition-opacity group-hover:opacity-100">
                <Icon name="Maximize2" className="h-3 w-3" />
                View
              </span>
            </button>
          ) : null}

          {open && (
            <>
              {hashtags.length > 0 && (
                <p className="mt-2 text-xs text-muted">
                  {hashtags.map((h) => "#" + h).join(" ")}
                </p>
              )}
              {richSlides.length > 0 && (
                <div className="mt-2 space-y-2">
                  {richSlides.map((s, i) => {
                    const gi = galleryIndexForUrl(s.imageUrl);
                    return (
                      <div key={i} className="flex gap-2 rounded-lg bg-surface-2 p-2">
                        {s.imageUrl && gi >= 0 ? (
                          <button
                            type="button"
                            onClick={() => setLightboxIndex(gi)}
                            className="h-24 w-20 shrink-0 overflow-hidden rounded border border-border focus:outline-none focus:ring-2 focus:ring-neon/50"
                            title="View full size"
                          >
                            {/* eslint-disable-next-line @next/next/no-img-element */}
                            <img src={s.imageUrl} alt="" className="h-full w-full object-cover" />
                          </button>
                        ) : null}
                        <div className="min-w-0">
                          <p className="text-xs font-medium">
                            {s.headline ? `${i + 1}. ${s.headline}` : `Slide ${i + 1}`}
                            {s.role ? <span className="text-muted-2"> · {s.role}</span> : null}
                          </p>
                          {s.body ? <p className="mt-0.5 whitespace-pre-wrap text-xs text-muted">{s.body}</p> : null}
                          {s.attribution ? <p className="mt-1 text-[10px] text-muted-2">{s.attribution}</p> : null}
                        </div>
                      </div>
                    );
                  })}
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
              {canApprove && asset.status === "draft" && !approving && (
                calendarEligible ? (
                  <>
                    <Button
                      size="sm"
                      onClick={() => {
                        setApproving(true);
                        setEditing(false);
                      }}
                      title="Put this on the content calendar: auto-publish, manual push, or placeholder"
                    >
                      <Icon name="Clock" className="h-3.5 w-3.5" />
                      Schedule
                    </Button>
                    <Button
                      size="sm"
                      onClick={() => setStatus("approved")}
                      loading={busy}
                    >
                      <Icon name="Check" className="h-3.5 w-3.5" />
                      Approve
                    </Button>
                  </>
                ) : (
                  <Button size="sm" onClick={handleSimpleApprove} loading={busy}>
                    <Icon name="Check" className="h-3.5 w-3.5" />
                    Approve
                  </Button>
                )
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
