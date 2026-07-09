"use client";

import { useState, useMemo } from "react";
import { Icon } from "@/components/icon";
import { cn } from "@/lib/utils";
import { AssetDetailModal } from "@/components/asset-detail-modal";
import type { Asset, Agent, Job } from "@/lib/types";

/* ── Types ───────────────────────────────────────────────────────────── */

/**
 * kind maps the three-tier publishing flow (+ agent suggestions) onto chips:
 *   published   — went live (auto cron or Publish Now)
 *   scheduled   — auto/manual item awaiting its slot
 *   placeholder — calendar-only roadmap entry (never auto-posted)
 *   suggested   — draft with an agent-recommended slot, not yet scheduled
 */
type EventKind = "published" | "scheduled" | "placeholder" | "suggested";

interface CalendarEvent {
  assetId: string;
  title: string;
  scheduledAt: number;
  kind: EventKind;
  mode?: string;
  agentColor: string;
  platform?: string;
}

/* ── Constants ───────────────────────────────────────────────────────── */

const DAY_LABELS = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];
const MONTH_NAMES = [
  "January", "February", "March", "April", "May", "June",
  "July", "August", "September", "October", "November", "December",
];

/* Event chips render in our palette, not platform colors (brand §11). */
const PLATFORM_COLORS: Record<string, string> = {
  instagram: "#FF6B2C",
  facebook: "#FF6B2C",
  linkedin: "#FF6B2C",
  twitter: "#FF6B2C",
  youtube: "#FF6B2C",
};

/* ── Event builder ───────────────────────────────────────────────────── */

function eventKind(a: Asset): EventKind | null {
  if (a.status === "published" && (a.scheduledAt != null || a.publishedAt != null)) return "published";
  // Approving a draft onto the calendar and legacy "scheduled" both land here.
  if ((a.status === "scheduled" || a.status === "approved") && a.scheduledAt != null) {
    return a.publishMode === "placeholder" ? "placeholder" : "scheduled";
  }
  // Draft with an agent-recommended slot — advisory until someone schedules it.
  if (a.status === "draft" && a.recommendedAt != null) return "suggested";
  return null;
}

function buildEvents(assets: Asset[], jobs: Job[], agents: Agent[]): CalendarEvent[] {
  const agentById = new Map(agents.map((a) => [a.id, a]));
  const agentByJob = new Map(jobs.map((j) => [j.id, j.agentId]));

  return assets
    .map((a): CalendarEvent | null => {
      const kind = eventKind(a);
      if (!kind) return null;
      const agentId = a.agentId ?? (a.jobId ? agentByJob.get(a.jobId) : undefined);
      const agent = agentId ? agentById.get(agentId) : undefined;
      const platformColor = a.scheduledPlatform ? PLATFORM_COLORS[a.scheduledPlatform] : undefined;
      const at =
        kind === "suggested"
          ? a.recommendedAt!
          : (a.scheduledAt ?? a.publishedAt!);
      return {
        assetId: a.id,
        title: a.title,
        scheduledAt: at,
        kind,
        mode: a.publishMode,
        agentColor: platformColor ?? agent?.color ?? "#FF6B2C",
        platform: a.scheduledPlatform,
      };
    })
    .filter((e): e is CalendarEvent => e != null)
    .sort((a, b) => a.scheduledAt - b.scheduledAt);
}

/* ── Event chip ──────────────────────────────────────────────────────── */

/** Chip styling per kind: published = live green, scheduled = upcoming info,
    placeholder = neutral roadmap entry, suggested = faint advisory. */
const KIND_CHIP_CLASS: Record<EventKind, string> = {
  published: "bg-success/15 text-success",
  scheduled: "border border-dashed border-info/50 bg-info/10 text-info",
  placeholder: "border border-dashed border-muted-2/50 bg-foreground/[0.04] text-muted",
  suggested: "border border-dotted border-neon/40 bg-neon/5 text-muted-2 italic",
};

const KIND_TOOLTIP: Record<EventKind, string> = {
  published: "Published",
  scheduled: "Scheduled",
  placeholder: "Placeholder (not auto-posted)",
  suggested: "Agent-suggested slot (draft)",
};

const MODE_TOOLTIP: Record<string, string> = {
  auto: "auto-publish",
  manual: "manual push",
};

function EventChip({ event, onOpen }: { event: CalendarEvent; onOpen: (assetId: string) => void }) {
  const timeStr = new Date(event.scheduledAt).toLocaleTimeString([], {
    hour: "numeric",
    minute: "2-digit",
  });
  const modeStr = event.kind === "scheduled" && event.mode ? MODE_TOOLTIP[event.mode] : undefined;

  return (
    <button
      type="button"
      onClick={() => onOpen(event.assetId)}
      className={cn(
        "flex w-full items-center gap-1 rounded px-1 py-0.5 text-[10px] leading-tight truncate text-left transition-opacity hover:opacity-80 focus:outline-none focus:ring-1 focus:ring-neon/50",
        KIND_CHIP_CLASS[event.kind],
      )}
      title={`${KIND_TOOLTIP[event.kind]}${modeStr ? ` · ${modeStr}` : ""} — ${event.title} · ${timeStr}${event.platform ? ` on ${event.platform}` : ""} · click for details`}
    >
      <div className="h-1.5 w-1.5 shrink-0 rounded-full bg-current opacity-70" />
      <span className="truncate">{event.title}</span>
    </button>
  );
}

/* ── Main component ──────────────────────────────────────────────────── */

export function ContentCalendar({
  assets,
  jobs,
  agents,
}: {
  assets: Asset[];
  jobs: Job[];
  agents: Agent[];
}) {
  const today = new Date();
  const [viewYear, setViewYear] = useState(today.getFullYear());
  const [viewMonth, setViewMonth] = useState(today.getMonth());
  const [openAssetId, setOpenAssetId] = useState<string | null>(null);

  const events = useMemo(() => buildEvents(assets, jobs, agents), [assets, jobs, agents]);
  const assetById = useMemo(() => new Map(assets.map((a) => [a.id, a])), [assets]);
  const openAsset = openAssetId ? assetById.get(openAssetId) ?? null : null;

  const totalDays = new Date(viewYear, viewMonth + 1, 0).getDate();
  const firstDayOfWeek = new Date(viewYear, viewMonth, 1).getDay();
  const totalCells = Math.ceil((firstDayOfWeek + totalDays) / 7) * 7;

  const scheduledCount = events.filter(
    (e) => e.kind === "scheduled" || e.kind === "placeholder",
  ).length;
  const publishedCount = events.filter((e) => e.kind === "published").length;
  const suggestedCount = events.filter((e) => e.kind === "suggested").length;

  function eventsForDay(day: number): CalendarEvent[] {
    return events.filter((e) => {
      const d = new Date(e.scheduledAt);
      return (
        d.getFullYear() === viewYear &&
        d.getMonth() === viewMonth &&
        d.getDate() === day
      );
    });
  }

  function prevMonth() {
    if (viewMonth === 0) {
      setViewYear((y) => y - 1);
      setViewMonth(11);
    } else {
      setViewMonth((m) => m - 1);
    }
  }

  function nextMonth() {
    if (viewMonth === 11) {
      setViewYear((y) => y + 1);
      setViewMonth(0);
    } else {
      setViewMonth((m) => m + 1);
    }
  }

  const isCurrentMonth =
    viewYear === today.getFullYear() && viewMonth === today.getMonth();

  const isEmpty = events.length === 0 && scheduledCount === 0;

  return (
    <div className="overflow-hidden rounded-[var(--radius)] border border-border bg-surface">
      {/* Header */}
      <div className="flex items-center justify-between border-b border-border px-4 py-3">
        <div className="flex items-center gap-2.5">
          <div className="flex h-7 w-7 items-center justify-center rounded-md border border-foreground/10 bg-foreground/[0.04]">
            <Icon name="Calendar" className="h-3.5 w-3.5 text-foreground/70" />
          </div>
          <div>
            <p className="text-sm font-medium leading-tight">Content Calendar</p>
            <p className="text-[11px] text-muted-2">
              {isEmpty && "Nothing scheduled yet"}
              {[
                scheduledCount > 0 ? `${scheduledCount} scheduled` : null,
                publishedCount > 0 ? `${publishedCount} published` : null,
                suggestedCount > 0 ? `${suggestedCount} suggested` : null,
              ]
                .filter(Boolean)
                .join(" · ")}
            </p>
          </div>
        </div>

        {/* Month navigation */}
        <div className="flex items-center gap-1">
          <button
            onClick={prevMonth}
            className="flex h-7 w-7 items-center justify-center rounded-lg text-muted transition-colors hover:bg-surface-2 hover:text-foreground"
          >
            <Icon name="ChevronLeft" className="h-4 w-4" />
          </button>
          <span className="w-[138px] text-center text-sm font-medium">
            {MONTH_NAMES[viewMonth]} {viewYear}
          </span>
          <button
            onClick={nextMonth}
            className="flex h-7 w-7 items-center justify-center rounded-lg text-muted transition-colors hover:bg-surface-2 hover:text-foreground"
          >
            <Icon name="ChevronRight" className="h-4 w-4" />
          </button>
        </div>
      </div>

      {/* Day-of-week header row */}
      <div className="grid grid-cols-7 border-b border-border">
        {DAY_LABELS.map((d) => (
          <div
            key={d}
            className="py-1.5 text-center text-[10px] font-mono font-medium uppercase tracking-[0.14em] text-muted-2"
          >
            {d}
          </div>
        ))}
      </div>

      {/* Calendar grid */}
      <div className="grid grid-cols-7">
        {Array.from({ length: totalCells }, (_, i) => {
          const day = i - firstDayOfWeek + 1;
          const isValid = day >= 1 && day <= totalDays;
          const isToday = isValid && isCurrentMonth && day === today.getDate();
          const dayEvents = isValid ? eventsForDay(day) : [];
          const isLastCol = (i + 1) % 7 === 0;

          return (
            <div
              key={i}
              className={cn(
                "min-h-[68px] border-b border-r border-border p-1",
                !isValid && "bg-surface-deep",
                isToday && "bg-foreground/[0.04]",
                isLastCol && "border-r-0",
              )}
            >
              {isValid && (
                <>
                  <p
                    className={cn(
                      "mb-1 flex h-5 w-5 items-center justify-center rounded-full text-[11px] font-medium leading-none",
                      isToday
                        ? "bg-primary text-primary-foreground font-bold"
                        : "text-muted-2",
                    )}
                  >
                    {day}
                  </p>
                  <div className="space-y-[3px]">
                    {dayEvents.slice(0, 3).map((e) => (
                      <EventChip key={e.assetId} event={e} onOpen={setOpenAssetId} />
                    ))}
                    {dayEvents.length > 3 && (
                      <p className="pl-1 text-[9px] text-muted-2">
                        +{dayEvents.length - 3} more
                      </p>
                    )}
                  </div>
                </>
              )}
            </div>
          );
        })}
      </div>

      {/* Legend */}
      <div className="flex flex-wrap items-center gap-x-5 gap-y-1 border-t border-border px-4 py-2">
        <div className="flex items-center gap-1.5 text-[11px] text-muted-2">
          <div className="h-2.5 w-3.5 rounded-sm border border-dashed border-info/60 bg-info/10" />
          Scheduled
        </div>
        <div className="flex items-center gap-1.5 text-[11px] text-muted-2">
          <div className="h-2.5 w-3.5 rounded-sm bg-success opacity-80" />
          Published
        </div>
        <div className="flex items-center gap-1.5 text-[11px] text-muted-2">
          <div className="h-2.5 w-3.5 rounded-sm border border-dashed border-muted-2/60 bg-foreground/[0.04]" />
          Placeholder
        </div>
        <div className="flex items-center gap-1.5 text-[11px] text-muted-2">
          <div className="h-2.5 w-3.5 rounded-sm border border-dotted border-neon/50 bg-neon/5" />
          Suggested
        </div>
      </div>

      <AssetDetailModal
        asset={openAsset}
        agents={agents}
        open={openAsset != null}
        onClose={() => setOpenAssetId(null)}
      />
    </div>
  );
}
