"use client";

import { useState, useMemo } from "react";
import { Icon } from "@/components/icon";
import { cn } from "@/lib/utils";
import type { Asset, Agent, Job } from "@/lib/types";

/* ── Types ───────────────────────────────────────────────────────────── */

interface CalendarEvent {
  assetId: string;
  title: string;
  scheduledAt: number;
  status: "scheduled" | "published";
  agentColor: string;
  platform?: string;
}

/* ── Constants ───────────────────────────────────────────────────────── */

const DAY_LABELS = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];
const MONTH_NAMES = [
  "January", "February", "March", "April", "May", "June",
  "July", "August", "September", "October", "November", "December",
];

const PLATFORM_COLORS: Record<string, string> = {
  instagram: "#E1306C",
  facebook: "#1877F2",
  linkedin: "#0A66C2",
  twitter: "#000000",
  youtube: "#FF0000",
};

/* ── Event builder ───────────────────────────────────────────────────── */

function buildEvents(assets: Asset[], jobs: Job[], agents: Agent[]): CalendarEvent[] {
  const agentById = new Map(agents.map((a) => [a.id, a]));
  const agentByJob = new Map(jobs.map((j) => [j.id, j.agentId]));

  return assets
    .filter(
      (a): a is Asset & { scheduledAt: number } =>
        (a.status === "scheduled" || a.status === "published") && a.scheduledAt != null,
    )
    .map((a) => {
      const agentId = a.agentId ?? (a.jobId ? agentByJob.get(a.jobId) : undefined);
      const agent = agentId ? agentById.get(agentId) : undefined;
      const platformColor = a.scheduledPlatform ? PLATFORM_COLORS[a.scheduledPlatform] : undefined;
      return {
        assetId: a.id,
        title: a.title,
        scheduledAt: a.scheduledAt,
        status: a.status as "scheduled" | "published",
        agentColor: platformColor ?? agent?.color ?? "#2dff9e",
        platform: a.scheduledPlatform,
      };
    })
    .sort((a, b) => a.scheduledAt - b.scheduledAt);
}

/* ── Event chip ──────────────────────────────────────────────────────── */

function EventChip({ event }: { event: CalendarEvent }) {
  const isScheduled = event.status === "scheduled";
  const timeStr = new Date(event.scheduledAt).toLocaleTimeString([], {
    hour: "numeric",
    minute: "2-digit",
  });

  return (
    <div
      className={cn(
        "flex items-center gap-1 rounded px-1 py-0.5 text-[10px] leading-tight truncate cursor-default",
        isScheduled ? "border border-dashed" : "",
      )}
      style={{
        borderColor: isScheduled ? event.agentColor + "70" : "transparent",
        background: event.agentColor + (isScheduled ? "18" : "2e"),
        color: event.agentColor,
      }}
      title={`${event.title} · ${timeStr}${event.platform ? ` on ${event.platform}` : ""}`}
    >
      <div
        className={cn(
          "h-1.5 w-1.5 shrink-0 rounded-full",
          isScheduled && "opacity-60",
        )}
        style={{ background: event.agentColor }}
      />
      <span className="truncate">{event.title}</span>
    </div>
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

  const events = useMemo(() => buildEvents(assets, jobs, agents), [assets, jobs, agents]);

  const totalDays = new Date(viewYear, viewMonth + 1, 0).getDate();
  const firstDayOfWeek = new Date(viewYear, viewMonth, 1).getDay();
  const totalCells = Math.ceil((firstDayOfWeek + totalDays) / 7) * 7;

  const scheduledCount = events.filter((e) => e.status === "scheduled").length;
  const publishedCount = events.filter((e) => e.status === "published").length;

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

  if (events.length === 0 && scheduledCount === 0) {
    return (
      <div className="flex items-center gap-3 rounded-[10px] border border-dashed border-border bg-surface-2/40 p-4">
        <div className="flex h-8 w-8 shrink-0 items-center justify-center rounded-[8px] bg-neon-soft">
          <Icon name="Calendar" className="h-4 w-4 text-neon" />
        </div>
        <div>
          <p className="text-sm font-medium">Content Calendar</p>
          <p className="text-xs text-muted-2">
            Approve &amp; Schedule a draft to populate the calendar.
          </p>
        </div>
      </div>
    );
  }

  return (
    <div className="overflow-hidden rounded-[var(--radius)] border border-border bg-surface">
      {/* Header */}
      <div className="flex items-center justify-between border-b border-border px-4 py-3">
        <div className="flex items-center gap-2.5">
          <div className="flex h-7 w-7 items-center justify-center rounded-[7px] bg-neon-soft">
            <Icon name="Calendar" className="h-3.5 w-3.5 text-neon" />
          </div>
          <div>
            <p className="text-sm font-medium leading-tight">Content Calendar</p>
            <p className="text-[11px] text-muted-2">
              {scheduledCount > 0 && `${scheduledCount} scheduled`}
              {scheduledCount > 0 && publishedCount > 0 && " · "}
              {publishedCount > 0 && `${publishedCount} published`}
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
      <div className="grid grid-cols-7 border-b border-border bg-surface-2/30">
        {DAY_LABELS.map((d) => (
          <div
            key={d}
            className="py-1.5 text-center text-[10px] font-semibold uppercase tracking-wider text-muted-2"
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
                !isValid && "bg-surface-2/20",
                isToday && "bg-neon/[0.04]",
                isLastCol && "border-r-0",
              )}
            >
              {isValid && (
                <>
                  <p
                    className={cn(
                      "mb-1 flex h-5 w-5 items-center justify-center rounded-full text-[11px] font-medium leading-none",
                      isToday
                        ? "bg-neon text-background font-bold"
                        : "text-muted-2",
                    )}
                  >
                    {day}
                  </p>
                  <div className="space-y-[3px]">
                    {dayEvents.slice(0, 3).map((e) => (
                      <EventChip key={e.assetId} event={e} />
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
      <div className="flex items-center gap-5 border-t border-border px-4 py-2">
        <div className="flex items-center gap-1.5 text-[11px] text-muted-2">
          <div className="h-2.5 w-3.5 rounded-sm border border-dashed border-muted-2 opacity-60" />
          Scheduled
        </div>
        <div className="flex items-center gap-1.5 text-[11px] text-muted-2">
          <div className="h-2.5 w-3.5 rounded-sm bg-neon opacity-70" />
          Published
        </div>
      </div>
    </div>
  );
}
