"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { Card, Badge, Button, Textarea } from "@/components/ui";
import { Icon } from "@/components/icon";
import {
  updateAssetAction,
  scheduleAssetAction,
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

/* ── Schedule section ────────────────────────────────────────────────── */

function ScheduleSection({
  asset,
  connectedPlatforms,
  onDone,
}: {
  asset: Asset;
  connectedPlatforms: string[];
  onDone: () => void;
}) {
  const router = useRouter();
  const compatiblePlatforms = PUBLISHABLE_PLATFORMS[asset.type] ?? [];
  const availablePlatforms = connectedPlatforms.filter((p) =>
    compatiblePlatforms.includes(p),
  );
  const canAuto = availablePlatforms.length > 0;

  // eslint-disable-next-line react-hooks/purity -- initial values only; component mounts once per open
  const now = Date.now();
  const minDatetime = toLocalInputValue(now + 60_000);
  // Pre-fill with the agent's recommended slot when it's still in the future.
  const recommended =
    asset.recommendedAt && asset.recommendedAt > now + 60_000 ? asset.recommendedAt : null;
  const [datetime, setDatetime] = useState(
    recommended ? toLocalInputValue(recommended) : minDatetime,
  );
  const [mode, setMode] = useState<PublishMode>(canAuto ? "auto" : "placeholder");
  const [platform, setPlatform] = useState(availablePlatforms[0] ?? "");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const usingRecommended = recommended != null && datetime === toLocalInputValue(recommended);
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
      hint: "On the calendar — you push it live with Publish Now",
    },
    {
      id: "placeholder",
      label: MODE_LABELS.placeholder,
      hint: "Calendar-only roadmap item — Karos never posts it",
    },
  ];

  async function handleSchedule() {
    if (!datetime) return;
    setBusy(true);
    setError(null);
    try {
      await scheduleAssetAction(
        asset.id,
        new Date(datetime).getTime(),
        mode === "placeholder" ? undefined : platform || undefined,
        mode,
      );
      router.refresh();
      onDone();
    } catch (e) {
      setError(e instanceof Error ? e.message : "Scheduling failed");
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="mt-3 space-y-2.5 rounded-md border border-border bg-surface-2 p-3">
      <p className="text-[11px] font-mono font-medium uppercase tracking-[0.14em] text-muted-2">
        Add to content calendar
      </p>

      {/* Publishing tier */}
      <div className="flex flex-wrap gap-1.5">
        {modeOptions.map((opt) => (
          <button
            key={opt.id}
            onClick={() => !opt.disabled && setMode(opt.id)}
            disabled={opt.disabled}
            title={opt.disabled ? "Connect a compatible platform to enable auto-publishing" : opt.hint}
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

      {/* Agent recommendation */}
      {recommended != null && (
        <p className="flex items-center gap-1.5 text-[11px] text-muted-2">
          <Icon name="Sparkles" className="h-3 w-3 shrink-0 text-neon" />
          <span>
            {usingRecommended ? "Using the agent-recommended slot" : "Agent recommends "}
            {!usingRecommended && (
              <button
                onClick={() => setDatetime(toLocalInputValue(recommended))}
                className="font-medium text-neon hover:underline"
              >
                {new Date(recommended).toLocaleString([], {
                  month: "short",
                  day: "numeric",
                  hour: "numeric",
                  minute: "2-digit",
                })}
              </button>
            )}
            {asset.recommendedReason ? ` — ${asset.recommendedReason}` : ""}
          </span>
        </p>
      )}

      {!canAuto && compatiblePlatforms.length > 0 && (
        <p className="text-[11px] text-muted-2">
          <Icon name="AlertCircle" className="mr-1 inline h-3 w-3 text-warning" />
          Connect{" "}
          {compatiblePlatforms.map((p) => PLATFORM_LABELS[p] ?? p).join(" or ")}{" "}
          in the Integrations tab to enable auto-publishing.
        </p>
      )}

      {error && (
        <p className="rounded-md border border-danger/30 bg-danger/10 px-2.5 py-1.5 text-[11px] text-danger">
          {error}
        </p>
      )}

      <div className="flex gap-2">
        <Button size="sm" onClick={handleSchedule} loading={busy} disabled={!datetime}>
          <Icon name="CalendarClock" className="h-3.5 w-3.5" />
          Approve &amp; Schedule
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
}: {
  asset: Asset;
  canApprove?: boolean;
  connectedPlatforms?: string[];
}) {
  const router = useRouter();
  const [open, setOpen] = useState(false);
  const [editing, setEditing] = useState(false);
  const [scheduling, setScheduling] = useState(false);
  const [content, setContent] = useState(asset.content);
  const [busy, setBusy] = useState(false);

  const hashtags = (asset.meta?.hashtags as string[] | undefined) ?? [];
  const imageConcept = asset.meta?.imageConcept as string | undefined;
  const [publishError, setPublishError] = useState<string | null>(asset.publishError ?? null);

  // Manual push available when a connected platform can carry this asset type.
  const compatibleConnected = (PUBLISHABLE_PLATFORMS[asset.type] ?? []).filter((p) =>
    (connectedPlatforms ?? []).includes(p),
  );
  const canPublishNow =
    canApprove && compatibleConnected.length > 0 && asset.status !== "published";

  // Content-engine carousels carry their slides (each with its own photo) in
  // meta.slides; a plain post has only the single cover `asset.imageUrl`.
  type SlideMeta = { role?: string; headline?: string; body?: string | null; imageUrl?: string | null; attribution?: string | null };
  const slides = (asset.meta?.slides as SlideMeta[] | undefined)?.filter(Boolean) ?? [];
  const isCarousel = slides.length > 0;
  const photoCount = slides.filter((s) => s.imageUrl).length;

  async function setStatus(status: "approved" | "delivered" | "published") {
    setBusy(true);
    try {
      await updateAssetAction(asset.id, { status });
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
          <p className={`mt-1 whitespace-pre-wrap text-sm text-muted ${open ? "" : "line-clamp-2"}`}>
            {asset.content}
          </p>

          {isCarousel ? (
            <div className="mt-2">
              <div className="flex gap-2 overflow-x-auto pb-1">
                {slides.map((s, i) => (
                  <div key={i} className="w-28 shrink-0">
                    {s.imageUrl ? (
                      // eslint-disable-next-line @next/next/no-img-element
                      <img src={s.imageUrl} alt={s.headline ?? `Slide ${i + 1}`} className="h-36 w-28 rounded-lg border border-border object-cover" />
                    ) : (
                      <div className="flex h-36 w-28 items-center justify-center rounded-lg border border-dashed border-border text-center text-[10px] text-muted-2">
                        no photo
                      </div>
                    )}
                    <p className="mt-1 line-clamp-2 text-[10px] text-muted-2">{i + 1}. {s.headline}</p>
                  </div>
                ))}
              </div>
              <p className="mt-1 text-[10px] text-muted-2">{slides.length} slides · {photoCount} with photos</p>
            </div>
          ) : asset.imageUrl ? (
            // eslint-disable-next-line @next/next/no-img-element
            <img
              src={asset.imageUrl}
              alt={asset.title}
              className="mt-2 w-full max-w-sm rounded-lg border border-border"
            />
          ) : null}

          {open && (
            <>
              {hashtags.length > 0 && (
                <p className="mt-2 text-xs text-muted">
                  {hashtags.map((h) => "#" + h).join(" ")}
                </p>
              )}
              {isCarousel && (
                <div className="mt-2 space-y-2">
                  {slides.map((s, i) => (
                    <div key={i} className="flex gap-2 rounded-lg bg-surface-2 p-2">
                      {s.imageUrl ? (
                        // eslint-disable-next-line @next/next/no-img-element
                        <img src={s.imageUrl} alt="" className="h-24 w-20 shrink-0 rounded border border-border object-cover" />
                      ) : null}
                      <div className="min-w-0">
                        <p className="text-xs font-medium">
                          {i + 1}. {s.headline}
                          {s.role ? <span className="text-muted-2"> · {s.role}</span> : null}
                        </p>
                        {s.body ? <p className="mt-0.5 whitespace-pre-wrap text-xs text-muted">{s.body}</p> : null}
                        {s.attribution ? <p className="mt-1 text-[10px] text-muted-2">{s.attribution}</p> : null}
                      </div>
                    </div>
                  ))}
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

          {/* Scheduled info strip */}
          {asset.status === "scheduled" && asset.scheduledAt && (
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
              <button
                onClick={handleUnschedule}
                disabled={busy}
                className="ml-auto text-[11px] text-muted-2 transition-colors hover:text-danger disabled:opacity-50"
              >
                Unschedule
              </button>
            </div>
          )}

          {/* Last publish failure (manual push or auto cron) */}
          {publishError && asset.status !== "published" && (
            <div className="mt-2 flex items-start gap-2 rounded-md border border-danger/30 bg-danger/10 px-2.5 py-1.5">
              <Icon name="AlertCircle" className="mt-0.5 h-3.5 w-3.5 shrink-0 text-danger" />
              <p className="text-xs text-danger">Publish failed: {publishError}</p>
            </div>
          )}

          {/* Scheduling form */}
          {scheduling && canApprove && (
            <ScheduleSection
              asset={asset}
              connectedPlatforms={connectedPlatforms ?? []}
              onDone={() => setScheduling(false)}
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
                    setScheduling(false);
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
              {canApprove && asset.status === "draft" && !scheduling && (
                <>
                  <Button
                    size="sm"
                    variant="outline"
                    onClick={() => {
                      setScheduling(true);
                      setEditing(false);
                    }}
                    title="Put this on the content calendar — auto-publish, manual push, or placeholder"
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
              )}
              {canApprove && asset.status === "draft" && scheduling && (
                <Button
                  size="sm"
                  onClick={() => setStatus("approved")}
                  loading={busy}
                >
                  <Icon name="Check" className={cn("h-3.5 w-3.5", scheduling && "opacity-50")} />
                  Approve now
                </Button>
              )}
            </div>
          </div>
        </div>
      </div>
    </Card>
  );
}
