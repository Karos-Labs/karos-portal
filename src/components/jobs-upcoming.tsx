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
  /**
   * Set only when this fire is KNOWN not to charge the client — a legacy
   * settings-page schedule (submitted with `charge: null`, always) or a planned
   * row that recorded `billClientCredits: false`.
   *
   * Absent is not "billed": a planned row written before that flag existed
   * leaves the decision to the cron's actor test, and this panel cannot resolve
   * it. So the marker is a positive claim about the rows that carry it and says
   * nothing about the rest.
   */
  unbilled?: boolean;
}

/**
 * Item 2's "Upcoming Scheduled Runs" pane: exact trigger time + target agent
 * + client, nearest first, across BOTH scheduling systems (jobs/page.tsx does
 * the merge). A glance panel, capped by the caller to a handful of "what's
 * coming up next" rows.
 *
 * It is also the ONLY surface that shows both systems. The Calendar projects
 * PlannedScheduledRun and nothing else, so a legacy settings-page schedule
 * appears there not at all — which is why the link below says "Full calendar"
 * rather than claiming it is the full picture, and why the unbilled marker is
 * worth the pixels here.
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
              <p className="text-xs text-muted-2">
                {run.cadenceLabel}
                {run.unbilled && " · not billed to the client"}
              </p>
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
