"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { Card, Badge, Button, Textarea } from "@/components/ui";
import { Icon } from "@/components/icon";
import { updateAssetAction, scheduleAssetAction, unscheduleAssetAction } from "@/lib/actions";
import { relativeTime, cn } from "@/lib/utils";
import type { Asset } from "@/lib/types";

/* ── Constants ───────────────────────────────────────────────────────── */

const TYPE_ICON: Record<string, string> = {
  instagram_post: "Camera",
  email: "Mail",
  article: "Newspaper",
  social_post: "Share2",
  note: "FileText",
};

// Which social platforms can auto-publish each asset type
const PUBLISHABLE_PLATFORMS: Record<string, string[]> = {
  instagram_post: ["instagram"],
  social_post: ["twitter", "linkedin", "facebook"],
  article: ["linkedin"],
  email: [],
  note: [],
};

const PLATFORM_LABELS: Record<string, string> = {
  instagram: "Instagram",
  facebook: "Facebook",
  linkedin: "LinkedIn",
  twitter: "X (Twitter)",
  youtube: "YouTube",
};

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

  // eslint-disable-next-line react-hooks/purity -- initial value only; component mounts once per modal open
  const minDatetime = new Date(Date.now() + 60_000).toISOString().slice(0, 16);
  const [datetime, setDatetime] = useState(minDatetime);
  const [platform, setPlatform] = useState(availablePlatforms[0] ?? "");
  const [busy, setBusy] = useState(false);

  async function handleSchedule() {
    if (!datetime) return;
    setBusy(true);
    try {
      await scheduleAssetAction(
        asset.id,
        new Date(datetime).getTime(),
        platform || undefined,
      );
      router.refresh();
      onDone();
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="mt-3 space-y-2.5 rounded-[10px] border border-border bg-surface-2/50 p-3">
      <p className="text-[11px] font-semibold uppercase tracking-wider text-muted-2">
        Schedule for later
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
            className="h-8 w-full rounded-[8px] border border-border bg-surface px-2.5 text-xs text-foreground focus:outline-none focus:ring-2 focus:ring-neon/40"
          />
        </div>

        {/* Platform picker (only when platforms are available) */}
        {availablePlatforms.length > 0 && (
          <div className="min-w-[130px]">
            <label className="mb-1 block text-[11px] text-muted-2">Platform</label>
            <select
              value={platform}
              onChange={(e) => setPlatform(e.target.value)}
              className="h-8 w-full rounded-[8px] border border-border bg-surface px-2.5 text-xs text-foreground focus:outline-none focus:ring-2 focus:ring-neon/40"
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

      {availablePlatforms.length === 0 && compatiblePlatforms.length > 0 && (
        <p className="text-[11px] text-muted-2">
          <Icon name="AlertCircle" className="mr-1 inline h-3 w-3 text-warning" />
          Connect{" "}
          {compatiblePlatforms.map((p) => PLATFORM_LABELS[p] ?? p).join(" or ")}{" "}
          in the Integrations tab to enable auto-publishing.
        </p>
      )}

      <div className="flex gap-2">
        <Button
          size="sm"
          onClick={handleSchedule}
          loading={busy}
          disabled={!datetime || (compatiblePlatforms.length > 0 && availablePlatforms.length === 0)}
        >
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
  const hasSchedulablePlatforms = (PUBLISHABLE_PLATFORMS[asset.type] ?? []).length > 0;

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

  return (
    <Card className="overflow-hidden">
      <div className="flex items-start gap-3">
        <div className="flex h-9 w-9 shrink-0 items-center justify-center rounded-[10px] bg-neon-soft text-neon">
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
                <p className="mt-2 text-xs text-neon-dim">
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
            <div className="mt-2 flex items-center gap-2 rounded-[8px] border border-border bg-surface-2/50 px-2.5 py-1.5">
              <Icon name="Clock" className="h-3.5 w-3.5 shrink-0 text-neon" />
              <p className="text-xs text-muted-2">
                Scheduled for{" "}
                <span className="font-medium text-foreground">
                  {new Date(asset.scheduledAt).toLocaleString([], {
                    month: "short",
                    day: "numeric",
                    hour: "numeric",
                    minute: "2-digit",
                  })}
                </span>
                {asset.scheduledPlatform && (
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
              {canApprove && asset.status === "draft" && !scheduling && (
                <>
                  <Button
                    size="sm"
                    variant="outline"
                    onClick={() => {
                      setScheduling(true);
                      setEditing(false);
                    }}
                    disabled={!hasSchedulablePlatforms}
                    title={
                      hasSchedulablePlatforms
                        ? "Schedule for auto-publishing"
                        : "This asset type cannot be auto-published"
                    }
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
