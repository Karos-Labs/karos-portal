"use client";

import { useState } from "react";
import { Badge } from "@/components/ui";
import { Icon } from "@/components/icon";
import { RedditDraftsBatch } from "@/components/reddit-drafts-review";
import { relativeTime } from "@/lib/utils";
import { cn } from "@/lib/utils";
import type {
  DailyFinderView,
  FinderDay,
  FinderScheduleState,
} from "@/lib/agent-detail-archetypes";

const WEEKDAY = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];

/**
 * What "nothing today" means, per schedule state — the copy the page used to
 * pass in as an `emptyHint` prop it derived itself. Kept beside the strip's own
 * empty copy so the two cannot describe different situations, and keyed by the
 * state rather than by a boolean so "paused" is a state the copy has to answer
 * for rather than something folded into "not scheduled".
 */
const EMPTY_TITLE: Record<FinderScheduleState, string> = {
  active: "Nothing found yet today",
  paused: "Paused",
  none: "Not looking yet",
};

const EMPTY_HINT: Record<FinderScheduleState, string> = {
  active:
    "It looks once a day and only brings back a thread worth answering. Some days there is nothing good, and a forced reply is worse than none.",
  paused:
    "This agent has a schedule, but it is paused. It goes back to looking as soon as it is resumed.",
  none: "Your Karos team sets how often this agent goes looking. Nothing runs until they do.",
};

/**
 * The daily finder (CD-I1 archetype 3).
 *
 * Albert on the Reddit agent: "it will find a thread every day… fully connected
 * to the calendar itself." So the page leads with what it found TODAY, and the
 * calendar under it is a strip of days rather than a week of formats - this
 * agent has no formats. It does not write to a template set; it goes looking,
 * once a day, and comes back with one thread and one reply.
 *
 * THE FINDS THEMSELVES ARE NOT RE-RENDERED HERE. `RedditDraftsBatch` is the
 * existing reader and it stays the reader: the markdown-stripping rules on it
 * are pinned by reddit-drafts.test.ts at the source level (which fields get
 * `stripInlineMarkdown` and - just as load-bearing - which two never do,
 * because `draft.text` and `draft.disclosure` are what the client actually
 * posts), and the four outcome actions behind it are the RedditDraftFeedback
 * path. A second reader on this page would be a second set of those rules, and
 * the copy of them that drifts is the one that leaks a lane heading or strips
 * the reply the client is about to paste into Reddit.
 *
 * CHURN A3/A4: `today` is today only. The server never puts a later day's finds
 * in the payload, so there is no "tomorrow's thread" to hide at render - and
 * the strip below carries dates and nothing else, exactly as the template
 * agents' week strip does.
 */
export function DailyFinderPanel({
  clientId,
  view,
}: {
  clientId: string;
  view: DailyFinderView;
}) {
  // ONE READ OF "IS IT RUNNING?", for the header, its hint and the strip.
  // This panel used to take a `scheduleActive` boolean and an `emptyHint`
  // string, both derived by the page from the redacted schedule ROW, while
  // `view.days` was derived on the server from the raw run — three answers to
  // one question, and a paused schedule split them: the header said "Not
  // looking yet" over a strip of chips dated tomorrow and the day after.
  const state = view.scheduleState;
  return (
    <div className="space-y-6">
      <section>
        <SectionHeading
          title="Found today"
          hint="One thread a day, with a reply drafted in your voice. Tell it what you did with each one. That is what tunes the next find."
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
            <p className="mt-2 text-sm text-foreground">{EMPTY_TITLE[state]}</p>
            <p className="mx-auto mt-1 max-w-md text-xs leading-relaxed text-muted-2">
              {EMPTY_HINT[state]}
            </p>
          </div>
        )}
      </section>

      <section>
        <SectionHeading
          title="When it looks"
          hint="A reply is a post into someone else's community, so this agent works at most one thread a day."
        />
        <DailyStrip days={view.days} state={state} />
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
 * Dates and nothing else - the same rule the template agents' week strip
 * follows (§4.1). A future day may not carry a count, a "found" mark or any
 * other tell that the work already exists; a past day is simply greyed, because
 * whether it found something is answered by the archive below, not by a chip.
 *
 * THREE STATES, not two. Making `finderDays` stop projecting for a paused
 * schedule would otherwise have taken a remedy with it: an empty list used to
 * mean one thing ("nobody has scheduled this"), and a paused schedule reaching
 * that same branch would have been told there is no schedule when there is one
 * and it is theirs to resume. So the empty branch is keyed to the state, not to
 * the emptiness.
 */
function DailyStrip({ days, state }: { days: FinderDay[]; state: FinderScheduleState }) {
  if (days.length === 0) {
    return (
      <p className="rounded-[var(--radius)] border border-border bg-surface-2/50 px-3 py-2.5 text-[11px] text-muted-2">
        {state === "paused"
          ? "Paused. It stops going looking until this schedule is resumed."
          : "No schedule yet. Your Karos team sets how often this agent goes looking."}
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
 * Every batch stays readable - the four outcome actions on an older draft are
 * still the way a client tells the agent what happened - but only one is open
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
    <div className="mb-3">
      <h2 className="font-mono text-sm uppercase tracking-[0.1em] text-muted">{title}</h2>
      {hint && <p className="mt-1 text-xs text-muted-2">{hint}</p>}
    </div>
  );
}
