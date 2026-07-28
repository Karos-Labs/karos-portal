"use client";

import { useId, useState } from "react";
import Link from "next/link";
import { Badge, EmptyState } from "@/components/ui";
import { Icon } from "@/components/icon";
import { cn } from "@/lib/utils";
import { TONE_COLORS } from "./tones";
import type { GapChannel, GapView } from "./presenter";

/**
 * "What we're fixing" — interactive gap cards (SCRUM-52 fixes 1 + 5).
 * Receives fully humanized GapView rows from the presenter (plain data only);
 * this file owns filter/expand state and the funnel chip into the client's
 * agents page (SCRUM-52 amendment).
 */

/** QA F144: same word set as the presenter's channel chips — "search engines"
 *  read as AI search to the team that built it, so it reads that way to a client. */
const FILTERS: Array<{ id: "all" | GapChannel; label: string }> = [
  { id: "all", label: "All" },
  { id: "search", label: "Search results" },
  { id: "ai", label: "AI answers" },
];

const COLLAPSED_COUNT = 8;

function GapCard({ gap }: { gap: GapView }) {
  const [open, setOpen] = useState(false);
  const panelId = useId();
  return (
    <li
      className="rounded-md border border-border bg-surface-2"
      style={{ borderLeft: `3px solid ${TONE_COLORS[gap.severityTone]}` }}
    >
      <button
        type="button"
        aria-expanded={open}
        aria-controls={panelId}
        onClick={() => setOpen((o) => !o)}
        className="flex w-full items-start justify-between gap-2 rounded-md px-3 py-2 text-left focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-foreground/25"
      >
        <span className="min-w-0">
          <span className="flex flex-wrap items-center gap-1.5">
            <Badge tone={gap.severityTone}>{gap.severityLabel}</Badge>
            <Badge tone="neutral">{gap.channelLabel}</Badge>
            <span className="text-sm font-medium text-foreground">{gap.title}</span>
          </span>
          {open && gap.technicalLabel && (
            <span className="mt-0.5 block font-mono text-[10px] text-muted-2">
              {gap.technicalLabel}
            </span>
          )}
          {!open && (
            <span className="mt-1 block truncate text-xs text-muted">
              What we found: {gap.foundLine}
            </span>
          )}
        </span>
        <Icon
          name="ChevronDown"
          className={cn(
            "mt-0.5 h-4 w-4 shrink-0 text-muted-2 transition-transform motion-reduce:transition-none",
            open && "rotate-180",
          )}
        />
      </button>
      {open && (
        <div id={panelId} className="space-y-2.5 border-t border-border px-3 py-2.5">
          <div>
            <p className="font-mono text-[10px] uppercase tracking-[0.08em] text-muted-2">What we found</p>
            <p className="mt-0.5 text-xs text-muted">{gap.foundLine}</p>
            {gap.evidence && <p className="mt-0.5 text-xs text-muted-2">{gap.evidence}</p>}
          </div>
          {gap.goalLine && (
            <div>
              <p className="font-mono text-[10px] uppercase tracking-[0.08em] text-muted-2">What good looks like</p>
              <p className="mt-0.5 text-xs text-muted">{gap.goalLine}</p>
            </div>
          )}
          <div>
            <p className="font-mono text-[10px] uppercase tracking-[0.08em] text-muted-2">How it gets fixed</p>
            {gap.fixArea && (
              <p className="mt-0.5 text-xs text-muted">
                <span className="text-foreground">{gap.fixArea.label}</span>
                <span className="text-muted-2"> · {gap.fixArea.gloss}</span>
              </p>
            )}
            {/* The route sentence always renders; the agent chip is additive (F7) —
                previously the chip REPLACED it, so a card either explained how the
                fix ships or named its agent, never both. */}
            <p className="mt-0.5 text-xs text-muted">{gap.fixRoute}</p>
            {gap.agentChip && (
              <Link
                href={gap.agentChip.href}
                className="mt-1.5 inline-flex items-center gap-1 rounded-[4px] border border-neon/30 bg-neon/10 px-2 py-1 font-mono text-[10px] font-medium uppercase tracking-[0.08em] text-neon transition-colors hover:bg-neon/20 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-neon/40"
              >
                {gap.agentChip.label}
                <Icon name="ArrowRight" className="h-3 w-3" />
              </Link>
            )}
            {gap.qualifier && <p className="mt-1.5 text-[11px] text-muted-2">{gap.qualifier}</p>}
          </div>
        </div>
      )}
    </li>
  );
}

const matchesFilter = (g: GapView, filter: "all" | GapChannel) =>
  filter === "all" || g.channel === filter || g.channel === "both";

export function GapList({ gaps }: { gaps: GapView[] }) {
  const [filter, setFilter] = useState<"all" | GapChannel>("all");
  const [showAll, setShowAll] = useState(false);

  const filtered = gaps.filter((g) => matchesFilter(g, filter));
  const visible = showAll ? filtered : filtered.slice(0, COLLAPSED_COUNT);
  const hidden = filtered.length - visible.length;

  return (
    <div>
      <div className="mb-3 inline-flex rounded-md border border-border bg-surface-2 p-1">
        {FILTERS.map((f) => {
          // Row counts (F16): a tab that quietly holds fewer rows than you expect
          // is exactly how mis-filed checks stayed invisible.
          const count = gaps.filter((g) => matchesFilter(g, f.id)).length;
          return (
            <button
              key={f.id}
              type="button"
              aria-pressed={filter === f.id}
              onClick={() => setFilter(f.id)}
              className={cn(
                "rounded-md px-3 py-1.5 text-xs font-medium transition-all focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-foreground/25",
                filter === f.id
                  ? "bg-surface text-foreground shadow-[0_1px_4px_rgba(0,0,0,0.3)]"
                  : "text-muted hover:text-foreground",
              )}
            >
              {f.label}
              <span className="ml-1.5 font-mono text-[10px] text-muted-2">{count}</span>
            </button>
          );
        })}
      </div>

      {filtered.length === 0 ? (
        <EmptyState
          icon={<Icon name="CheckCircle2" className="h-6 w-6" />}
          title="Nothing to fix in this view"
          description="No measured gaps match this filter."
        />
      ) : (
        <>
          <ul className="space-y-2">
            {visible.map((g) => (
              <GapCard key={g.key} gap={g} />
            ))}
          </ul>
          {hidden > 0 && (
            <button
              type="button"
              onClick={() => setShowAll(true)}
              className="mt-2 inline-flex items-center gap-1 rounded-md text-xs text-muted transition-colors hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-foreground/25"
            >
              Show all {filtered.length} · {hidden} more
              <Icon name="ChevronDown" className="h-3.5 w-3.5" />
            </button>
          )}
        </>
      )}
    </div>
  );
}
