import { requireUser } from "@/lib/auth";
import { listJobs, listClients, listPlannedScheduledRuns, listScheduledRuns } from "@/lib/data";
import { listClientAgents } from "@/lib/data-client-agents";
import { identitiesByClient, runRowLabel, scheduleRowLabel } from "@/lib/agent-identity-map";
import { describeCadence } from "@/lib/scheduled-runs";
import { describeCadence as describeLegacyCadence, isValidTimeZone } from "@/lib/run-cadence";
import { EmptyState, PageHeader } from "@/components/ui";
import { Icon } from "@/components/icon";
import { JobsList, type JobListRow } from "@/components/jobs-list";
import { UpcomingRunsPanel, type UpcomingRunRow } from "@/components/jobs-upcoming";

// A row written before `timeZone` existed falls back to the runtime's own zone
// - same fallback calendar-body.tsx's runZone() uses, so this panel's "next
// fire" time can't disagree with the Calendar's.
const RUNTIME_ZONE = Intl.DateTimeFormat().resolvedOptions().timeZone;
function runZone(stored: string | undefined): string {
  return isValidTimeZone(stored) ? stored : RUNTIME_ZONE;
}

const UPCOMING_LIMIT = 8;

export default async function JobsPage() {
  const user = await requireUser(["KAROS_ADMIN", "KAROS_EMPLOYEE"]);
  // eslint-disable-next-line react-hooks/purity -- server component, no re-render concern
  const now = Date.now();
  const [jobs, clients, umbrellas, plannedRuns, legacyRuns] = await Promise.all([
    listJobs(),
    listClients(user.role === "KAROS_EMPLOYEE" ? { employeeId: user.uid } : undefined),
    // §7.3. Read once for the page, indexed per client below - this list is
    // cross-client, so resolving a row's identity by querying its client's
    // umbrellas would be one Firestore read per row.
    listClientAgents(),
    listPlannedScheduledRuns(),
    listScheduledRuns(),
  ]);
  const nameById = new Map(clients.map((c) => [c.id, c.name]));
  const umbrellasByClient = identitiesByClient(umbrellas);
  // Admins and employees alike only see jobs of EXISTING (visible) clients -
  // orphaned jobs of deleted clients used to leak into this cross-client view.
  // Stripped to what the list renders: no run events, no input payloads, no
  // asset ids cross the RSC boundary just to print a row.
  const rows: JobListRow[] = jobs
    .filter((job) => nameById.has(job.clientId))
    .map((job) => ({
      id: job.id,
      // §7.3 identity (F147), not the stored name: staff read this list beside
      // the client surfaces, so a run has to be called here what the client is
      // told it is called. The job doc keeps its own agentName untouched - /jobs/[id]
      // is the forensic view of the record and still prints it verbatim.
      agentName: runRowLabel(job, umbrellasByClient.get(job.clientId) ?? []),
      title: job.title,
      clientId: job.clientId,
      clientName: nameById.get(job.clientId)!,
      status: job.status,
      createdAt: job.createdAt,
      emailed: Boolean(job.emailedTo),
      ...(job.customAgentId ? { customAgentId: job.customAgentId } : {}),
      ...(job.error ? { error: job.error } : {}),
    }));

  // ── Upcoming Scheduled Runs (item 2's "future" pane) ─────────────────
  // Merges both scheduling systems - PlannedScheduledRun (the per-agent
  // schedule dialog) and the legacy ScheduledRun row - into one glance panel,
  // nearest fire first. Both already carry the fire time on `nextRunAt`
  // (that's what the cron polls on), so no re-projection is needed here, only
  // formatting - same helpers calendar-body.tsx uses so this can't disagree
  // with the Calendar's own "next run" time for the same row.
  const upcoming: UpcomingRunRow[] = [
    ...plannedRuns
      .filter((r) => r.status === "active" && nameById.has(r.clientId))
      .map((r) => ({
        id: r.id,
        clientId: r.clientId,
        clientName: nameById.get(r.clientId)!,
        agentLabel: scheduleRowLabel(r, umbrellasByClient.get(r.clientId) ?? []),
        nextRunAt: r.nextRunAt,
        cadenceLabel: describeCadence({ ...r, timeZone: runZone(r.timeZone) }),
        // `=== false`, never `!r.billClientCredits`: an ABSENT flag is a row
        // written before it existed, and the cron falls back to the actor test
        // for those, so this panel does not know. Only a recorded intent gets
        // to make the claim.
        ...(r.billClientCredits === false ? { unbilled: true } : {}),
      })),
    ...legacyRuns
      .filter((r) => r.enabled && nameById.has(r.clientId))
      .map((r) => ({
        id: r.id,
        clientId: r.clientId,
        clientName: nameById.get(r.clientId)!,
        agentLabel: r.label,
        nextRunAt: r.nextRunAt,
        cadenceLabel: describeLegacyCadence(r.cadence),
        // Unconditional, and it is not a policy choice here: /api/scheduler
        // passes `charge: null` to the submit core on every fire of this
        // collection, so there is no legacy row that bills.
        unbilled: true,
      })),
  ]
    .sort((a, b) => a.nextRunAt - b.nextRunAt)
    .slice(0, UPCOMING_LIMIT);

  return (
    <>
      <PageHeader title="Jobs" description="Every agent run, its output and delivery status." />
      <UpcomingRunsPanel runs={upcoming} now={now} />
      {rows.length === 0 ? (
        <EmptyState
          icon={<Icon name="ListChecks" className="h-7 w-7" />}
          title="No jobs yet"
          description="Agent runs will appear here."
        />
      ) : (
        <JobsList jobs={rows} isAdmin={user.role === "KAROS_ADMIN"} />
      )}
    </>
  );
}
