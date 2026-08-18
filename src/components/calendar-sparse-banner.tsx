"use client";

import { useState } from "react";
import Link from "next/link";
import { Icon } from "@/components/icon";
import { RefreshTaskMapButton } from "@/components/refresh-task-map-button";
import { platformLabel } from "@/lib/integrations/platforms";

function formatPlatformList(platforms: readonly string[]): string {
  const labels = platforms.map(platformLabel);
  if (labels.length === 1) return labels[0];
  if (labels.length === 2) return `${labels[0]} and ${labels[1]}`;
  return `${labels.slice(0, -1).join(", ")}, and ${labels[labels.length - 1]}`;
}

/**
 * The calendar's "your schedule is light" nudge — Home's Calendar Preview
 * widget and the Calendar page both mount this. Two states, mutually
 * exclusive: tasks already proposed and waiting for review outrank the
 * generate prompt, since there is nothing left to generate until those are
 * cleared. `gapPlatforms`/`pendingSuggestionCount` are computed server-side
 * from the SAME gap math the Task Map generator itself reasons from
 * (lib/calendar-gaps.ts's `computePlatformGaps`, shared with
 * lib/agent-swarm.ts's `buildSwarmContext`) so the two can never disagree
 * about what "light" means.
 */
export function CalendarSparseBanner({
  clientId,
  gapPlatforms,
  pendingSuggestionCount,
  isAiProcessing,
  viewerIsBilled,
  reviewHref,
}: {
  clientId: string;
  /** Connected platforms with nothing scheduled in the next two weeks. Empty ⇒ not sparse. */
  gapPlatforms: readonly string[];
  /** Tasks the generator already proposed (status "pending") that nobody has approved or skipped yet. */
  pendingSuggestionCount: number;
  isAiProcessing?: boolean;
  viewerIsBilled: boolean;
  /**
   * Where "review" links to. Set on Home (→ /calendar), where the actual review
   * cards don't render. Omitted on the Calendar page itself: the cards are
   * already right below, so this component has nothing to add there once
   * suggestions exist and renders null instead of a link to itself.
   */
  reviewHref?: string;
}) {
  // Session-only dismiss for the generate prompt — it is recomputed from live
  // calendar state on every visit, so there is nothing to persist: a client
  // who dismisses it now and is still sparse next visit sees it again, which
  // is the point of a nudge rather than a standing decision (contrast the
  // 15-item action list's own Dismiss, which IS persisted because that one
  // guards a real workflow rather than restating live state).
  const [dismissed, setDismissed] = useState(false);

  if (pendingSuggestionCount > 0) {
    if (!reviewHref) return null;
    return (
      <div className="mb-4 flex flex-wrap items-center gap-2.5 rounded-md border border-neon/25 bg-neon-soft px-3.5 py-2.5 text-sm text-foreground">
        <Icon name="ListTodo" className="h-4 w-4 shrink-0 text-neon" />
        <p className="flex-1 font-medium">
          {pendingSuggestionCount} recommended task{pendingSuggestionCount === 1 ? "" : "s"} waiting for your
          review.
        </p>
        <Link href={reviewHref} className="shrink-0 text-sm font-medium text-neon hover:underline">
          Review on your calendar
        </Link>
      </div>
    );
  }

  if (dismissed || gapPlatforms.length === 0) return null;

  return (
    <div className="mb-4 flex items-start gap-2.5 rounded-md border border-border bg-surface-2 px-3.5 py-3 text-sm text-foreground">
      <Icon name="CalendarClock" className="mt-0.5 h-4 w-4 shrink-0 text-muted-2" />
      <div className="min-w-0 flex-1">
        <p className="font-medium">Your calendar is light this week.</p>
        <p className="mt-0.5 text-muted">
          {formatPlatformList(gapPlatforms)} {gapPlatforms.length === 1 ? "has" : "have"} nothing scheduled in
          the next two weeks.
        </p>
        <div className="mt-2.5">
          <RefreshTaskMapButton
            clientId={clientId}
            isAiProcessing={isAiProcessing}
            viewerIsBilled={viewerIsBilled}
            label="Generate recommended tasks"
          />
        </div>
      </div>
      <button
        type="button"
        onClick={() => setDismissed(true)}
        aria-label="Dismiss"
        className="shrink-0 rounded p-1 text-muted-2 transition-colors hover:bg-surface-3 hover:text-foreground"
      >
        <Icon name="X" className="h-3.5 w-3.5" />
      </button>
    </div>
  );
}
