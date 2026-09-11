"use client";

/**
 * The run history on an intake card: one row per run, or the empty state.
 *
 * WHY IT IS ONE COMPONENT (SCRUM-412). This block was written out SIX times,
 * once per `*-agent-intake.tsx`, and the six copies were byte identical apart
 * from the empty state's noun. So were the two comments inside it - the C2
 * parity note and the raw-status note - which means the reasoning for why the
 * row looks like this was maintained in six places too. `intake-run-rows.test.ts`
 * had to assert the same four source patterns against all six files to keep
 * them honest; it now asks the one component instead, and asks that all six
 * mount it.
 *
 * The COLLAPSE is not here. `toRunRowViews` in `lib/agent-intake-views.ts`
 * already runs server-side and hands a client one row per calendar day (every
 * failure kept) while staff get every fire. This component renders what it is
 * given and makes no decision about which runs a viewer sees.
 */

import { JobStatusBadge } from "@/components/job-status";
import { IntakeNoRuns } from "@/components/intake-no-runs";
import { Badge } from "@/components/ui";
import type { IntakeFamily } from "@/lib/agent-intake-links";
import type { JobStatus } from "@/lib/types";
import { intakeRunNoun } from "@/lib/intake-run-noun";
import { formatDate, relativeTime } from "@/lib/utils";

/** One row of the run history. */
export interface IntakeRunRowView {
  id: string;
  /** Typed so the row renders through JobStatusBadge, never the raw word. */
  status: JobStatus;
  createdAt: number;
  /** Staff only, and staff-gated at the render: the forensic /jobs link. */
  href?: string;
}

export function IntakeRunRows({
  clientId,
  family,
  runs,
  isStaff,
  limit = 4,
}: {
  clientId: string;
  /** Picks the empty state's noun. One register, never a hand-spelled word. */
  family: IntakeFamily;
  runs: IntakeRunRowView[];
  isStaff: boolean;
  limit?: number;
}) {
  if (runs.length === 0) {
    return <IntakeNoRuns clientId={clientId} noun={intakeRunNoun(family)} />;
  }

  return (
    /* The run's state through the app's own mapper, and its date through the
       app's own formatter. These used to print the raw database word ("review",
       "queued", "failed") into client-facing copy, beside an ISO machine date,
       on a line with nothing to click. */
    <ul className="mt-3 space-y-1.5">
      {runs.slice(0, limit).map((r) => {
        /* C2 (parity pass 2026-09). The CLIENT'S sentence is the primary text
           for BOTH roles. Staff used to read `Run <date>` in its place, so one
           row said two different things and a staff preview of this page could
           not be compared with what the client gets. They lose nothing: the
           exact generation instant they debug with is appended as a muted
           secondary suffix, and the /jobs link - staff-only, staff-guarded, and
           outside the client workspace - rides on that suffix behind an
           Internal marker. The per-day collapse for clients still happens
           server-side (toRunRowViews). */
        const label = `Worked on your content · ${relativeTime(r.createdAt)}`;
        const stamp = `Run ${formatDate(r.createdAt)}`;
        return (
          <li key={r.id} className="flex flex-wrap items-center gap-2 text-xs text-muted">
            <span>{label}</span>
            {isStaff &&
              (r.href ? (
                <a href={r.href} className="text-muted-2 underline hover:text-foreground">
                  {stamp}
                </a>
              ) : (
                <span className="text-muted-2">{stamp}</span>
              ))}
            {isStaff && r.href && <Badge tone="neutral">Internal</Badge>}
            <JobStatusBadge status={r.status} viewerIsClient={!isStaff} />
          </li>
        );
      })}
    </ul>
  );
}
