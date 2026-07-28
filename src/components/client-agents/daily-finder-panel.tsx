"use client";

import { useState } from "react";
import { Badge } from "@/components/ui";
import { Icon } from "@/components/icon";
import { RedditDraftsBatch } from "@/components/reddit-drafts-review";
import { relativeTime } from "@/lib/utils";
import { cn } from "@/lib/utils";
import type { DailyFinderView, FinderDay } from "@/lib/agent-detail-archetypes";

const WEEKDAY = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];

/**
 * The daily finder (CD-I1 archetype 3).
 *
 * Albert on the Reddit agent: "it will find a thread every day… fully connected
 * to the calendar itself." So the page leads with what it found TODAY, and the
 * calendar under it is a strip of days rather than a week of formats — this
 * agent has no formats. It does not write to a template set; it goes looking,
 * once a day, and comes back with one thread and one reply.
 *
 * THE FINDS THEMSELVES ARE NOT RE-RENDERED HERE. `RedditDraftsBatch` is the
 * existing reader and it stays the reader: the markdown-stripping rules on it
 * are pinned by reddit-drafts.test.ts at the source level (which fields get
 * `stripInlineMarkdown` and — just as load-bearing — which two never do,
 * because `draft.text` and `draft.disclosure` are what the client actually
 * posts), and the four outcome actions behind it are the RedditDraftFeedback
 * path. A second reader on this page would be a second set of those rules, and
 * the copy of them that drifts is the one that leaks a lane heading or strips
 * the reply the client is about to paste into Reddit.
 *
 * CHURN A3/A4: `today` is today only. The server never puts a later day's finds
 * in the payload, so there is no "tomorrow's thread" to hide at render — and
 * the strip below carries dates and nothing else, exactly as the template
 * agents' week strip does.
 */
export function DailyFinderPanel({
  clientId,
  view,
  scheduleActive,
  emptyHint,
}: {
  clientId: string;
  view: DailyFinderView;
  /** Whether a schedule is actually firing — changes what "nothing today" means. */
  scheduleActive: boolean;
  emptyHint: string;
}) {
  return (
    <div className="space-y-6">
      <section>
        <SectionHeading
          title="Found today"
          hint="One thread a day, with a reply drafted in your voice. Tell it what you did with each one — that is what tunes the next find."
        />
        {view.today.length > 0 ? (
          <div className="space-y-4">
            {view.today.map((batch) => (
              <RedditDraftsBatch
                key={batch.assetId}
                clientId={clientId}
                assetId={batch.assetId}
                {...(batch.jobId ? { jobId: batch.jobId } : {})}
                accounts={batch.accounts}
              />
            ))}
          </div>
        ) : (
          <div className="rounded-[var(--radius)] border border-border bg-surface-2/50 px-4 py-5 text-center">
            <Icon name="Search" className="mx-auto h-6 w-6 text-muted-2" />
            <p className="mt-2 text-sm text-foreground">
              {scheduleActive ? "Nothing found yet today" : "Not looking yet"}
            </p>
            <p className="mx-auto mt-1 max-w-md text-xs leading-relaxed text-muted-2">{emptyHint}</p>
          </div>
        )}
      </section>

      <section>
        <SectionHeading
          title="When it looks"
          hint="A reply is a post into someone else's community, so this agent works at most one thread a day."
        />
        <DailyStrip days={view.days} />
      </section>

      {view.earlier.length > 0 && (
        <section>
          <SectionHeading title="Earlier finds" />
          <EarlierFinds clientId={clientId} view={view} />
        </section>
      )}
    </div>
  );
}

/**
 * The days this agent goes looking.
 *
 * Dates and nothing else — the same rule the template agents' week strip
 * follows (§4.1). A future day may not carry a count, a "found" mark or any
 * other tell that the work already exists; a past day is simply greyed, because
 * whether it found something is answered by the archive below, not by a chip.
 */
function DailyStrip({ days }: { days: FinderDay[] }) {
  if (days.length === 0) {
    return (
      <p className="rounded-[var(--radius)] border border-border bg-surface-2/50 px-3 py-2.5 text-[11px] text-muted-2">
        No schedule yet — your Karos team sets how often this agent goes looking.
      </p>
    );
  }
  return (
    <ul className="flex flex-wrap gap-1.5">
      {days.map((day) => {
        const [y, mo, d] = day.dateKey.split("-").map(Number);
        const at = new Date(Date.UTC(y, mo - 1, d));
        return (
          <li key={day.dateKey}>
            <span
              className={cn(
                "inline-block rounded-md border px-2 py-1 text-[11px]",
                day.isToday
                  ? "border-neon/50 bg-neon-soft/20 text-foreground"
                  : "border-border bg-surface-2",
                day.isPast && "opacity-50",
              )}
            >
              <span className="text-muted-2">
                {WEEKDAY[at.getUTCDay()]} {at.getUTCDate()}
              </span>
              {day.isToday && <span className="ml-1.5 text-neon">Today</span>}
            </span>
          </li>
        );
      })}
    </ul>
  );
}

/**
 * The per-agent archive of finds, collapsed.
 *
 * Every batch stays readable — the four outcome actions on an older draft are
 * still the way a client tells the agent what happened — but only one is open
 * at a time, because ten expanded batches is a page nobody scrolls.
 */
function EarlierFinds({ clientId, view }: { clientId: string; view: DailyFinderView }) {
  const [openId, setOpenId] = useState<string | null>(null);
  return (
    <ul className="space-y-2">
      {view.earlier.map((batch) => {
        const open = openId === batch.assetId;
        const drafts = batch.accounts.reduce((total, acc) => total + acc.drafts.length, 0);
        return (
          <li
            key={batch.assetId}
            className="overflow-hidden rounded-[var(--radius)] border border-border bg-surface-2/50"
          >
            <button
              type="button"
              onClick={() => setOpenId(open ? null : batch.assetId)}
              aria-expanded={open}
              className="flex w-full items-center gap-2 px-3 py-2 text-left transition-colors hover:bg-surface-2"
            >
              <Icon
                name={open ? "ChevronUp" : "ChevronDown"}
                className="h-4 w-4 shrink-0 text-muted-2"
              />
              <span className="min-w-0 flex-1 truncate text-xs text-foreground">
                {relativeTime(batch.at)}
              </span>
              <Badge tone="neutral">
                {drafts} {drafts === 1 ? "reply" : "replies"}
              </Badge>
            </button>
            {open && (
              <div className="border-t border-border p-3">
                <RedditDraftsBatch
                  clientId={clientId}
                  assetId={batch.assetId}
                  {...(batch.jobId ? { jobId: batch.jobId } : {})}
                  accounts={batch.accounts}
                />
              </div>
            )}
          </li>
        );
      })}
    </ul>
  );
}

function SectionHeading({ title, hint }: { title: string; hint?: string }) {
  return (
    <div className="mb-2.5">
      <h2 className="font-mono text-[10px] uppercase tracking-[0.08em] text-muted">{title}</h2>
      {hint && <p className="mt-1 text-xs text-muted-2">{hint}</p>}
    </div>
  );
}
