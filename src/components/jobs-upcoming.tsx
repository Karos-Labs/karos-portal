import Link from "next/link";
import { Card, CardTitle } from "@/components/ui";
import { Icon } from "@/components/icon";
import { nextRunCountdown } from "@/lib/scheduled-runs";

/** One projected future fire, from either scheduling system — see jobs/page.tsx. */
export interface UpcomingRunRow {
  id: string;
  clientId: string;
  clientName: string;
  /** The resolved display identity — never the stored/lab agent name (F147). */
  agentLabel: string;
  nextRunAt: number;
  /** Already carries its own zone suffix (describeCadence/describeLegacyCadence). */
  cadenceLabel: string;
}

/**
 * Item 2's "Upcoming Scheduled Runs" pane: exact trigger time + target agent
 * + client, nearest first, across BOTH scheduling systems (jobs/page.tsx does
 * the merge). A glance panel, not the full picture — the Calendar already
 * shows every projected occurrence across a month; this is capped by the
 * caller to a handful of "what's coming up next" rows.
 */
export function UpcomingRunsPanel({ runs, now }: { runs: UpcomingRunRow[]; now: number }) {
  if (runs.length === 0) return null;
  return (
    <Card className="mb-6">
      <div className="mb-3 flex items-center justify-between gap-2">
        <CardTitle className="flex items-center gap-2 text-sm">
          <Icon name="CalendarClock" className="h-4 w-4 text-muted-2" />
          Upcoming scheduled runs
        </CardTitle>
        <Link href="/calendar" className="text-xs text-muted hover:text-foreground">
          Full calendar
        </Link>
      </div>
      <ul className="divide-y divide-border">
        {runs.map((run) => (
          <li key={run.id} className="flex items-center justify-between gap-3 py-2 text-sm">
            <div className="min-w-0">
              <p className="truncate">
                {run.agentLabel} <span className="text-muted-2">· {run.clientName}</span>
              </p>
              <p className="text-xs text-muted-2">{run.cadenceLabel}</p>
            </div>
            <span className="shrink-0 whitespace-nowrap text-xs text-muted-2">
              {nextRunCountdown(run.nextRunAt, now)}
            </span>
          </li>
        ))}
      </ul>
    </Card>
  );
}
