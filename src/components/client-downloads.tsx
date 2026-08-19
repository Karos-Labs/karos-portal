"use client";

import { useState } from "react";
import { Card, CardTitle } from "@/components/ui";
import { Icon } from "@/components/icon";
import { cn } from "@/lib/utils";
import { markActionDoneAction } from "@/lib/actions/action-list-actions";

/** Today's date in the browser's own local zone, as a `<input type="date">` value. */
function todayLocalDateInputValue(): string {
  const d = new Date();
  const local = new Date(d.getTime() - d.getTimezoneOffset() * 60000);
  return local.toISOString().slice(0, 10);
}

/**
 * One button, one day of content, one zip. Lives at the bottom of the
 * Calendar page (calendar-body.tsx) — moved there from its own standalone
 * "Downloads" page/route (Surface 07, retired 2026-08): a client reported
 * not being able to find the download action at all once it was tucked
 * inside the day-detail panel's per-day conditional section, so this is
 * back to being its own persistent, always-visible section instead of
 * something you have to click a populated day open to see. The date picker
 * never offers a day past today: the API route refuses it too (nothing is
 * generated for a day that has not happened), so this is the same rule
 * stated where the client sees it first.
 */
export function ClientDownloads({
  clientId,
  viewerIsClient = false,
}: {
  clientId: string;
  viewerIsClient?: boolean;
}) {
  const today = todayLocalDateInputValue();
  const [date, setDate] = useState(today);

  return (
    <Card>
      <CardTitle className="mb-1">Download a day&apos;s content</CardTitle>
      <p className="mb-4 text-sm text-muted-2">
        Everything generated, scheduled or published for the day you pick, bundled into one zip.
      </p>
      <div className="flex flex-wrap items-end gap-3">
        <label className="flex flex-col gap-1 text-xs text-muted-2">
          Day
          <input
            type="date"
            value={date}
            max={today}
            onChange={(e) => setDate(e.target.value)}
            className="rounded-md border border-border bg-surface-2 px-3 py-2 text-sm text-foreground"
          />
        </label>
        <a
          href={`/api/clients/${clientId}/downloads?date=${date}`}
          // Action 15 ("Export a day of your content") — event-tracked, no
          // live signal answers it (lib/action-list.ts). A plain download
          // anchor gives no completion callback, so this fires on click
          // rather than on the browser finishing the save — the same
          // click-is-the-signal shape action 12 already uses for "week view
          // opened." Fire-and-forget: never blocks or cancels the download.
          onClick={() => {
            if (viewerIsClient) void markActionDoneAction(clientId, "15");
          }}
          className={cn(
            "inline-flex h-10 items-center justify-center gap-2 rounded-md bg-neon px-4 text-sm font-semibold text-accent-ink transition-all duration-200 hover:-translate-y-0.5 hover:shadow-[0_12px_28px_-10px_color-mix(in_srgb,var(--neon)_55%,transparent)]",
          )}
        >
          <Icon name="Download" className="h-4 w-4" />
          Download .zip
        </a>
      </div>
    </Card>
  );
}
