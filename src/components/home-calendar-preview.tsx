import Link from "next/link";
import { Card, CardTitle, EmptyState } from "@/components/ui";
import { Icon } from "@/components/icon";
import { ASSET_TYPE_LABEL } from "@/lib/asset-type-copy";
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
 */
export function CalendarPreviewWidget({
  upcoming,
}: {
  /** Future-dated, status "scheduled" assets, any order — this widget sorts and caps them. */
  upcoming: Asset[];
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
          href="/calendar"
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
          {next.map((a) => (
            <li
              key={a.id}
              className="flex items-center gap-3 rounded-md border border-border bg-surface-2 px-3 py-2"
            >
              <span className="w-14 shrink-0 text-xs font-medium text-muted-2">
                {dayLabel(a.scheduledAt as number)}
              </span>
              <span className="min-w-0 flex-1 truncate text-sm text-foreground">
                {ASSET_TYPE_LABEL[a.type] ?? a.type}
                {a.scheduledPlatform ? ` · ${a.scheduledPlatform}` : ""}
              </span>
            </li>
          ))}
        </ul>
      )}
    </Card>
  );
}
