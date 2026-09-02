import Link from "next/link";
import { Card, CardTitle, EmptyState, Badge } from "@/components/ui";
import { Icon } from "@/components/icon";
import { ASSET_TYPE_LABEL } from "@/lib/asset-type-copy";
import { postKind, postKindLabel } from "@/lib/calendar-kind";
import { platformLabel } from "@/lib/integrations/platforms";
import type { Asset } from "@/lib/types";

const WEEKDAY = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];

function dayLabel(ms: number): string {
  const d = new Date(ms);
  return `${WEEKDAY[d.getDay()]} ${d.getDate()}`;
}

/**
 * Home's "Calendar Preview" widget (portal revamp, Surface 02) — the next few
 * scheduled dates, in place of the old "Scheduled" counter tile. Names the
 * post's type and platform only, never a generated title: a future day's
 * content does not exist yet in the SOW's calendar model (Surface 05), and
 * this preview is not the place to get ahead of that rule. Clean empty state
 * on day one, same as the calendar itself.
 *
 * ── WHAT IT MEANS BY "UPCOMING" IS NOT THIS FILE'S DECISION (2026-09) ────
 *
 * The caller filters with `isUpcomingPost` (lib/calendar-kind), the predicate
 * the calendar page's own chips are derived from. It used to be a local
 * `a.status === "scheduled" && a.scheduledAt > now` at the page, and that cost
 * a client their whole widget: `postKind` admits `approved` and `draft` with a
 * date too, so a production client with thirteen future-dated APPROVED
 * placeholders on their calendar read "Nothing scheduled yet" here. See
 * `isUpcomingPost` for the full account.
 *
 * This component still trusts its input — it sorts and caps, it does not
 * re-filter — because a second filter here is how the widget and the page came
 * to disagree in the first place. What it DOES do now is say which KIND each
 * row is when that is not a plain scheduled post, so a placeholder is not
 * silently presented as a booked, we-will-post-this slot.
 */
export function CalendarPreviewWidget({
  upcoming,
  calendarHref = "/calendar",
  viewerIsClient,
}: {
  /**
   * Upcoming posts, any order — this widget sorts and caps them.
   *
   * "Upcoming" is `isUpcomingPost` (lib/calendar-kind), asked by the CALLER.
   * Not "status is scheduled": see the note above for the client whose widget
   * that spelling emptied.
   */
  upcoming: Asset[];
  /**
   * Where "Open calendar" links to. Defaults to the flat /calendar route,
   * which only resolves to this one client's own calendar for a real
   * CLIENT_USER (its `isClient` branch scopes by `user.clientId`). A staff
   * viewer hits the cross-client overview there instead, so callers
   * rendering this widget for staff must pass the scoped
   * `/clients/[id]/calendar` route explicitly.
   */
  calendarHref?: string;
  /**
   * Which register the kind chip reads. REQUIRED, no default — the same device
   * every other viewer-split component here uses, because a defaulted viewer
   * flag is how a client surface silently acquires the staff vocabulary.
   */
  viewerIsClient: boolean;
}) {
  const next = [...upcoming]
    .filter((a) => typeof a.scheduledAt === "number")
    .sort((a, b) => (a.scheduledAt ?? 0) - (b.scheduledAt ?? 0))
    .slice(0, 5);

  return (
    <Card>
      <div className="mb-3 flex items-center justify-between gap-2">
        <CardTitle className="min-w-0 truncate">Calendar</CardTitle>
        <Link
          href={calendarHref}
          className="shrink-0 whitespace-nowrap text-xs text-muted underline-offset-2 hover:text-foreground hover:underline"
        >
          Open calendar
        </Link>
      </div>
      {next.length === 0 ? (
        <EmptyState
          icon={<Icon name="CalendarClock" className="h-6 w-6" />}
          title="Nothing scheduled yet"
          description="Once your agents start posting, upcoming dates show up here."
        />
      ) : (
        <ul className="space-y-2">
          {next.map((a) => {
            // A plain scheduled post needs no chip — it is what the whole card
            // is about. A placeholder or a dated draft is a different promise
            // and gets named, in the same words the calendar chips it with.
            const kind = postKind(a);
            const chip = kind && kind !== "scheduled" ? postKindLabel(kind, viewerIsClient) : null;
            return (
              <li
                key={a.id}
                className="flex items-center gap-3 rounded-md border border-border bg-surface-2 px-3 py-2"
              >
                <span className="w-14 shrink-0 text-xs font-medium text-muted-2">
                  {dayLabel(a.scheduledAt as number)}
                </span>
                <span className="min-w-0 flex-1 truncate text-sm text-foreground">
                  {ASSET_TYPE_LABEL[a.type] ?? a.type}
                  {/* `platformLabel`, not the raw id: this printed "tiktok" and
                      "linkedin" lowercase, the QA F122 defect the connected-
                      channels card and the assets filter were both fixed for. */}
                  {a.scheduledPlatform ? ` · ${platformLabel(a.scheduledPlatform)}` : ""}
                </span>
                {chip && <Badge tone="neutral">{chip}</Badge>}
              </li>
            );
          })}
        </ul>
      )}
    </Card>
  );
}
