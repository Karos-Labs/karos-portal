"use client";

import { useMemo, useState } from "react";
import { useRouter } from "next/navigation";
import { Icon } from "@/components/icon";
import { Badge, Button } from "@/components/ui";
import { ImageLightbox } from "@/components/image-lightbox";
import { AssetDetailModal } from "@/components/asset-detail-modal";
import { ScheduleRunModal } from "@/components/schedule-run-modal";
import { setPlannedRunStatusAction, deletePlannedRunAction } from "@/lib/actions/planned-run-actions";
import { cn } from "@/lib/utils";
import type { AssetImage } from "@/lib/asset-images";
import type { Asset, AssetType, JobStatus, PlannedRunCadence } from "@/lib/types";

/* ── Serializable shapes built by the calendar page ──────────────────── */

export interface RunAssetView {
  id: string;
  type: AssetType;
  title: string;
  textPreview: string;
  images: AssetImage[];
}

export interface CalendarRun {
  /** jobId (past) or scheduledRunId (scheduled). */
  id: string;
  kind: "past" | "scheduled";
  clientId: string;
  /** Set for staff overview (admin / employee across clients). */
  clientName?: string;
  /** Run date (past: job time) or next fire (scheduled). */
  at: number;
  /** The agent's display name/color/icon. */
  productName: string;
  productColor: string;
  productIcon: string;
  // past
  jobStatus?: JobStatus;
  assets?: RunAssetView[];
  /** Every image across the run's assets, in order — feeds the run lightbox. */
  images?: AssetImage[];
  // scheduled
  cadence?: PlannedRunCadence;
  cadenceLabel?: string;
  /** The free-text request this run fires each time. */
  prompt?: string;
  agentDescription?: string;
}

/** Repo agent option for the schedule-a-run form. */
export interface ScheduleAgentOption {
  id: string;
  name: string;
  description: string;
  icon: string;
  color: string;
}

export interface CalendarPost {
  assetId: string;
  clientId: string;
  clientName?: string;
  title: string;
  at: number;
  kind: "scheduled" | "published" | "placeholder";
  images: AssetImage[];
  textPreview: string;
}

export interface CalendarClientOption {
  id: string;
  name: string;
}

/* ── Constants ───────────────────────────────────────────────────────── */

const DAY_LABELS = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];
const MONTH_NAMES = [
  "January", "February", "March", "April", "May", "June",
  "July", "August", "September", "October", "November", "December",
];

function dayKey(at: number): string {
  const d = new Date(at);
  return `${d.getFullYear()}-${d.getMonth()}-${d.getDate()}`;
}

function timeStr(at: number): string {
  return new Date(at).toLocaleTimeString([], { hour: "numeric", minute: "2-digit" });
}

/* ── Chips ───────────────────────────────────────────────────────────── */

function RunChip({ run }: { run: CalendarRun }) {
  const scheduled = run.kind === "scheduled";
  const failed = run.jobStatus === "failed";
  return (
    <div
      className={cn(
        "flex items-center gap-1 rounded px-1 py-0.5 text-[10px] leading-tight truncate",
        scheduled
          ? "border border-dashed bg-foreground/[0.03]"
          : failed
            ? "bg-danger/15 text-danger"
            : "text-foreground",
      )}
      style={
        scheduled
          ? { borderColor: run.productColor + "88", color: run.productColor }
          : failed
            ? undefined
            : { background: run.productColor + "22", color: run.productColor }
      }
      title={`${scheduled ? "Scheduled" : "Ran"} · ${run.productName} · ${timeStr(run.at)}${run.clientName ? ` - ${run.clientName}` : ""}`}
    >
      <Icon name={run.productIcon} className="h-2.5 w-2.5 shrink-0" />
      <span className="truncate">{run.productName}</span>
    </div>
  );
}

const POST_CHIP_CLASS: Record<CalendarPost["kind"], string> = {
  published: "bg-success/15 text-success",
  scheduled: "border border-dashed border-info/50 bg-info/10 text-info",
  placeholder: "border border-dashed border-muted-2/50 bg-foreground/[0.04] text-muted",
};

function PostChip({
  post,
  onOpen,
}: {
  post: CalendarPost;
  onOpen: (assetId: string) => void;
}) {
  return (
    <button
      type="button"
      onClick={(event) => {
        event.stopPropagation();
        onOpen(post.assetId);
      }}
      className={cn(
        "flex w-full items-center gap-1 rounded px-1 py-0.5 text-[10px] leading-tight truncate text-left transition-opacity hover:opacity-80 focus:outline-none focus:ring-1 focus:ring-neon/50",
        POST_CHIP_CLASS[post.kind],
      )}
      title={`${post.kind === "published" ? "Published" : post.kind === "scheduled" ? "Scheduled post" : "Placeholder"} · ${post.title} · ${timeStr(post.at)}`}
    >
      <div className="h-1.5 w-1.5 shrink-0 rounded-full bg-current opacity-70" />
      <span className="truncate">{post.title}</span>
    </button>
  );
}

/* ── Day detail ──────────────────────────────────────────────────────── */

function ScheduledRunCard({
  run,
  canManage,
}: {
  run: CalendarRun;
  canManage: boolean;
}) {
  const router = useRouter();
  const [busy, setBusy] = useState(false);

  async function cancel() {
    if (busy) return;
    setBusy(true);
    await deletePlannedRunAction(run.id);
    router.refresh();
  }
  async function pause() {
    if (busy) return;
    setBusy(true);
    await setPlannedRunStatusAction(run.id, "paused");
    router.refresh();
  }

  return (
    <div className="rounded-lg border border-border bg-surface p-3">
      <div className="flex items-start gap-2.5">
        <div
          className="flex h-8 w-8 shrink-0 items-center justify-center rounded-md"
          style={{ background: run.productColor + "22", color: run.productColor }}
        >
          <Icon name={run.productIcon} className="h-4 w-4" />
        </div>
        <div className="min-w-0 flex-1">
          <div className="flex flex-wrap items-center gap-2">
            <p className="text-sm font-medium">{run.productName}</p>
            <Badge tone="info">Upcoming</Badge>
            {run.clientName && <Badge tone="neutral">{run.clientName}</Badge>}
          </div>
          <p className="mt-0.5 text-xs text-muted-2">{run.cadenceLabel} · fires {timeStr(run.at)}</p>
          {run.agentDescription && <p className="mt-1.5 text-xs text-muted-2">{run.agentDescription}</p>}
          <div className="mt-2.5 border-t border-border pt-2">
            <p className="mb-1 text-[11px] font-medium uppercase tracking-wide text-muted-2">Will run</p>
            <p className="text-xs italic text-muted">
              {run.prompt ? `“${run.prompt}”` : "Runs the agent's default playbook."}
            </p>
          </div>
          {canManage && (
            <div className="mt-3 flex gap-2">
              <Button size="sm" variant="ghost" onClick={pause} loading={busy}>Pause</Button>
              <Button size="sm" variant="danger" onClick={cancel} loading={busy}>Cancel</Button>
            </div>
          )}
        </div>
      </div>
    </div>
  );
}

function PastRunCard({
  run,
  onOpenLightbox,
}: {
  run: CalendarRun;
  onOpenLightbox: (images: AssetImage[], index: number) => void;
}) {
  const images = run.images ?? [];
  const textAssets = (run.assets ?? []).filter((a) => a.images.length === 0 && a.textPreview);
  const statusTone =
    run.jobStatus === "failed" ? "danger" : run.jobStatus === "delivered" || run.jobStatus === "approved" ? "success" : "neutral";

  return (
    <div className="rounded-lg border border-border bg-surface p-3">
      <div className="flex items-start gap-2.5">
        <div
          className="flex h-8 w-8 shrink-0 items-center justify-center rounded-md"
          style={{ background: run.productColor + "22", color: run.productColor }}
        >
          <Icon name={run.productIcon} className="h-4 w-4" />
        </div>
        <div className="min-w-0 flex-1">
          <div className="flex flex-wrap items-center gap-2">
            <p className="text-sm font-medium">{run.productName}</p>
            <Badge tone={statusTone}>{run.jobStatus === "review" ? "Ready to review" : (run.jobStatus ?? "done")}</Badge>
            {run.clientName && <Badge tone="neutral">{run.clientName}</Badge>}
          </div>
          <p className="mt-0.5 text-xs text-muted-2">Ran {timeStr(run.at)}</p>

          {run.jobStatus === "failed" ? (
            <p className="mt-2 text-xs text-danger">The run failed and produced no assets.</p>
          ) : images.length === 0 && textAssets.length === 0 ? (
            <p className="mt-2 text-xs text-muted-2">No client-facing assets from this run.</p>
          ) : null}

          {/* Image gallery — click any to slide through the whole run */}
          {images.length > 0 && (
            <div className="mt-2.5 flex flex-wrap gap-1.5">
              {images.map((img, i) => (
                <button
                  key={img.url + i}
                  onClick={() => onOpenLightbox(images, i)}
                  className="h-16 w-16 overflow-hidden rounded-md border border-border transition-opacity hover:opacity-80"
                  title={img.caption ?? `Image ${i + 1}`}
                >
                  {/* eslint-disable-next-line @next/next/no-img-element */}
                  <img src={img.url} alt="" className="h-full w-full object-cover" />
                </button>
              ))}
            </div>
          )}

          {/* Text deliverables (articles, emails, captions) */}
          {textAssets.length > 0 && (
            <div className="mt-2.5 space-y-1.5">
              {textAssets.map((a) => (
                <div key={a.id} className="rounded-md border border-border bg-surface-2 p-2">
                  <p className="text-xs font-medium text-foreground">{a.title}</p>
                  <p className="mt-0.5 line-clamp-2 text-[11px] text-muted-2">{a.textPreview}</p>
                </div>
              ))}
            </div>
          )}
        </div>
      </div>
    </div>
  );
}

function PostCard({
  post,
  onOpenLightbox,
  onOpenDetails,
}: {
  post: CalendarPost;
  onOpenLightbox: (images: AssetImage[], index: number) => void;
  onOpenDetails: (assetId: string) => void;
}) {
  const tone = post.kind === "published" ? "success" : post.kind === "scheduled" ? "info" : "neutral";
  const label = post.kind === "published" ? "Published" : post.kind === "scheduled" ? "Scheduled" : "Placeholder";
  return (
    <div
      onClick={() => onOpenDetails(post.assetId)}
      role="button"
      tabIndex={0}
      onKeyDown={(event) => {
        if (event.key === "Enter" || event.key === " ") {
          event.preventDefault();
          onOpenDetails(post.assetId);
        }
      }}
      className="flex w-full items-start gap-2.5 rounded-lg border border-border bg-surface p-3 text-left transition-colors hover:bg-surface-2 focus:outline-none focus:ring-1 focus:ring-neon/50"
    >
      {post.images[0] ? (
        <button
          type="button"
          onClick={() => onOpenLightbox(post.images, 0)}
          onMouseDown={(event) => event.stopPropagation()}
          onClickCapture={(event) => event.stopPropagation()}
          className="h-12 w-12 shrink-0 overflow-hidden rounded-md border border-border transition-opacity hover:opacity-80"
        >
          {/* eslint-disable-next-line @next/next/no-img-element */}
          <img src={post.images[0].url} alt="" className="h-full w-full object-cover" />
        </button>
      ) : (
        <div className="flex h-12 w-12 shrink-0 items-center justify-center rounded-md border border-border bg-surface-2 text-muted-2">
          <Icon name="FileText" className="h-5 w-5" />
        </div>
      )}
      <div className="min-w-0 flex-1">
        <div className="flex flex-wrap items-center gap-2">
          <p className="truncate text-sm font-medium">{post.title}</p>
          <Badge tone={tone}>{label}</Badge>
          {post.clientName && <Badge tone="neutral">{post.clientName}</Badge>}
        </div>
        <p className="mt-0.5 text-xs text-muted-2">{timeStr(post.at)}</p>
        {post.textPreview && <p className="mt-1 line-clamp-2 text-[11px] text-muted-2">{post.textPreview}</p>}
      </div>
    </div>
  );
}

/* ── Main component ──────────────────────────────────────────────────── */

export function RunCalendar({
  runs,
  posts,
  assets,
  canSchedule = false,
  clients = [],
  agents = [],
  defaultClientId,
}: {
  runs: CalendarRun[];
  posts: CalendarPost[];
  assets: Asset[];
  /** Staff on their own clients — shows the "Schedule a run" button + management controls. */
  canSchedule?: boolean;
  clients?: CalendarClientOption[];
  agents?: ScheduleAgentOption[];
  defaultClientId?: string;
}) {
  const today = useMemo(() => new Date(), []);
  const [viewYear, setViewYear] = useState(today.getFullYear());
  const [viewMonth, setViewMonth] = useState(today.getMonth());
  const [selectedKey, setSelectedKey] = useState<string | null>(null);
  const [lightbox, setLightbox] = useState<{ images: AssetImage[]; index: number } | null>(null);
  const [openAssetId, setOpenAssetId] = useState<string | null>(null);
  const [scheduleOpen, setScheduleOpen] = useState(false);
  const assetById = useMemo(() => new Map(assets.map((a) => [a.id, a])), [assets]);
  const openAsset = openAssetId ? assetById.get(openAssetId) ?? null : null;

  const runsByDay = useMemo(() => {
    const m = new Map<string, CalendarRun[]>();
    for (const r of runs) {
      const k = dayKey(r.at);
      (m.get(k) ?? m.set(k, []).get(k)!).push(r);
    }
    return m;
  }, [runs]);

  const postsByDay = useMemo(() => {
    const m = new Map<string, CalendarPost[]>();
    for (const p of posts) {
      const k = dayKey(p.at);
      (m.get(k) ?? m.set(k, []).get(k)!).push(p);
    }
    return m;
  }, [posts]);

  const totalDays = new Date(viewYear, viewMonth + 1, 0).getDate();
  const firstDayOfWeek = new Date(viewYear, viewMonth, 1).getDay();
  const totalCells = Math.ceil((firstDayOfWeek + totalDays) / 7) * 7;
  const isCurrentMonth = viewYear === today.getFullYear() && viewMonth === today.getMonth();

  const upcomingCount = runs.filter((r) => r.kind === "scheduled").length;
  const pastCount = runs.filter((r) => r.kind === "past").length;

  function prevMonth() {
    setSelectedKey(null);
    if (viewMonth === 0) { setViewYear((y) => y - 1); setViewMonth(11); } else setViewMonth((m) => m - 1);
  }
  function nextMonth() {
    setSelectedKey(null);
    if (viewMonth === 11) { setViewYear((y) => y + 1); setViewMonth(0); } else setViewMonth((m) => m + 1);
  }

  const selectedRuns = selectedKey ? (runsByDay.get(selectedKey) ?? []) : [];
  const selectedPosts = selectedKey ? (postsByDay.get(selectedKey) ?? []) : [];
  const selectedScheduled = selectedRuns.filter((r) => r.kind === "scheduled").sort((a, b) => a.at - b.at);
  const selectedPast = selectedRuns.filter((r) => r.kind === "past").sort((a, b) => b.at - a.at);

  const selectedLabel = selectedKey
    ? (() => {
        const [y, m, d] = selectedKey.split("-").map(Number);
        return new Date(y, m, d).toLocaleDateString([], { weekday: "long", month: "long", day: "numeric" });
      })()
    : "";

  const openLightbox = (images: AssetImage[], index: number) => setLightbox({ images, index });

  return (
    <div className="space-y-4">
      <div className="overflow-hidden rounded-[var(--radius)] border border-border bg-surface">
        {/* Header */}
        <div className="flex items-center justify-between gap-3 border-b border-border px-4 py-3">
          <div className="flex items-center gap-2.5">
            <div className="flex h-7 w-7 items-center justify-center rounded-md border border-foreground/10 bg-foreground/[0.04]">
              <Icon name="CalendarClock" className="h-3.5 w-3.5 text-foreground/70" />
            </div>
            <div>
              <p className="text-sm font-medium leading-tight">Agent Calendar</p>
              <p className="text-[11px] text-muted-2">
                {upcomingCount === 0 && pastCount === 0
                  ? "No runs yet"
                  : [
                      upcomingCount > 0 ? `${upcomingCount} upcoming` : null,
                      pastCount > 0 ? `${pastCount} completed` : null,
                    ].filter(Boolean).join(" · ")}
              </p>
            </div>
          </div>

          <div className="flex items-center gap-3">
            {canSchedule && (
              <Button size="sm" variant="accent" onClick={() => setScheduleOpen(true)}>
                <Icon name="Plus" className="h-3.5 w-3.5" />
                Schedule a run
              </Button>
            )}
            <div className="flex items-center gap-1">
              <button onClick={prevMonth} className="flex h-7 w-7 items-center justify-center rounded-lg text-muted transition-colors hover:bg-surface-2 hover:text-foreground">
                <Icon name="ChevronLeft" className="h-4 w-4" />
              </button>
              <span className="w-[130px] text-center text-sm font-medium">{MONTH_NAMES[viewMonth]} {viewYear}</span>
              <button onClick={nextMonth} className="flex h-7 w-7 items-center justify-center rounded-lg text-muted transition-colors hover:bg-surface-2 hover:text-foreground">
                <Icon name="ChevronRight" className="h-4 w-4" />
              </button>
            </div>
          </div>
        </div>

        {/* Day-of-week header */}
        <div className="grid grid-cols-7 border-b border-border">
          {DAY_LABELS.map((d) => (
            <div key={d} className="py-1.5 text-center text-[10px] font-mono font-medium uppercase tracking-[0.14em] text-muted-2">{d}</div>
          ))}
        </div>

        {/* Grid */}
        <div className="grid grid-cols-7">
          {Array.from({ length: totalCells }, (_, i) => {
            const day = i - firstDayOfWeek + 1;
            const isValid = day >= 1 && day <= totalDays;
            const isToday = isValid && isCurrentMonth && day === today.getDate();
            const key = isValid ? `${viewYear}-${viewMonth}-${day}` : "";
            const dayRuns = isValid ? (runsByDay.get(key) ?? []) : [];
            const dayPosts = isValid ? (postsByDay.get(key) ?? []) : [];
            const chipCount = dayRuns.length + dayPosts.length;
            const isLastCol = (i + 1) % 7 === 0;
            const isSelected = key !== "" && key === selectedKey;

            return (
              <div
                key={i}
                onClick={() => {
                  if (!isValid || chipCount === 0) return;
                  setSelectedKey(key);
                }}
                role={isValid && chipCount > 0 ? "button" : undefined}
                tabIndex={isValid && chipCount > 0 ? 0 : -1}
                onKeyDown={(event) => {
                  if (!isValid || chipCount === 0) return;
                  if (event.key === "Enter" || event.key === " ") {
                    event.preventDefault();
                    setSelectedKey(key);
                  }
                }}
                className={cn(
                  "min-h-[84px] border-b border-r border-border p-1 text-left align-top transition-colors",
                  !isValid && "bg-surface-deep",
                  isToday && "bg-foreground/[0.04]",
                  isSelected && "bg-neon-soft/40 ring-1 ring-inset ring-neon/40",
                  isValid && chipCount > 0 && "cursor-pointer hover:bg-surface-2",
                  isLastCol && "border-r-0",
                )}
              >
                {isValid && (
                  <>
                    <span className={cn(
                      "mb-1 flex h-5 w-5 items-center justify-center rounded-full text-[11px] font-medium leading-none",
                      isToday ? "bg-primary text-primary-foreground font-bold" : "text-muted-2",
                    )}>
                      {day}
                    </span>
                    <div className="space-y-[3px]">
                      {dayRuns.slice(0, 3).map((r) => <RunChip key={r.kind + r.id} run={r} />)}
                    {dayRuns.length < 3 &&
                      dayPosts
                        .slice(0, 3 - dayRuns.length)
                        .map((p) => (
                          <PostChip key={p.assetId} post={p} onOpen={setOpenAssetId} />
                        ))}
                    {chipCount > 3 && <p className="pl-1 text-[9px] text-muted-2">+{chipCount - 3} more</p>}
                  </div>
                </>
              )}
              </div>
            );
          })}
        </div>

        {/* Legend */}
        <div className="flex flex-wrap items-center gap-x-5 gap-y-1 border-t border-border px-4 py-2">
          <LegendDot className="border border-dashed border-neon/60 bg-neon/5" label="Scheduled run" />
          <LegendDot className="bg-neon opacity-80" label="Completed run" />
          <LegendDot className="border border-dashed border-info/60 bg-info/10" label="Scheduled post" />
          <LegendDot className="bg-success opacity-80" label="Published" />
        </div>
      </div>

      {/* Day detail */}
      {selectedKey && (
        <div className="rounded-[var(--radius)] border border-border bg-surface-2/40 p-4">
          <div className="mb-3 flex items-center justify-between">
            <h3 className="text-sm font-semibold">{selectedLabel}</h3>
            <button onClick={() => setSelectedKey(null)} className="rounded-md p-1 text-muted-2 hover:bg-surface-2 hover:text-foreground" aria-label="Close">
              <Icon name="X" className="h-4 w-4" />
            </button>
          </div>

          {selectedScheduled.length + selectedPast.length + selectedPosts.length === 0 ? (
            <p className="text-xs text-muted-2">Nothing on this day.</p>
          ) : (
            <div className="space-y-4">
              {selectedScheduled.length > 0 && (
                <Section title="Upcoming runs">
                  {selectedScheduled.map((r) => (
                    <ScheduledRunCard key={r.id} run={r} canManage={canSchedule} />
                  ))}
                </Section>
              )}
              {selectedPast.length > 0 && (
                <Section title="Completed runs">
                  {selectedPast.map((r) => <PastRunCard key={r.id} run={r} onOpenLightbox={openLightbox} />)}
                </Section>
              )}
              {selectedPosts.length > 0 && (
                <Section title="Posts">
                  {selectedPosts.sort((a, b) => a.at - b.at).map((p) => (
                    <PostCard
                      key={p.assetId}
                      post={p}
                      onOpenLightbox={openLightbox}
                      onOpenDetails={setOpenAssetId}
                    />
                  ))}
                </Section>
              )}
            </div>
          )}
        </div>
      )}

      {lightbox && (
        <ImageLightbox
          images={lightbox.images}
          index={lightbox.index}
          onIndexChange={(i) => setLightbox((s) => (s ? { ...s, index: i } : s))}
          onClose={() => setLightbox(null)}
        />
      )}

      <AssetDetailModal asset={openAsset} open={openAsset != null} onClose={() => setOpenAssetId(null)} />

      {scheduleOpen && (
        <ScheduleRunModal
          clients={clients}
          agents={agents}
          defaultClientId={defaultClientId}
          onClose={() => setScheduleOpen(false)}
        />
      )}
    </div>
  );
}

function LegendDot({ className, label }: { className: string; label: string }) {
  return (
    <div className="flex items-center gap-1.5 text-[11px] text-muted-2">
      <div className={cn("h-2.5 w-3.5 rounded-sm", className)} />
      {label}
    </div>
  );
}

function Section({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <div>
      <p className="mb-2 text-[11px] font-medium uppercase tracking-wide text-muted-2">{title}</p>
      <div className="space-y-2">{children}</div>
    </div>
  );
}
