import { requireUser } from "@/lib/auth";
import { listJobs, listClients } from "@/lib/data";
import { listClientAgents } from "@/lib/data-client-agents";
import { identitiesByClient, runRowLabel } from "@/lib/agent-identity-map";
import { EmptyState, PageHeader } from "@/components/ui";
import { Icon } from "@/components/icon";
import { JobsList, type JobListRow } from "@/components/jobs-list";

export default async function JobsPage() {
  const user = await requireUser(["KAROS_ADMIN", "KAROS_EMPLOYEE"]);
  const [jobs, clients, umbrellas] = await Promise.all([
    listJobs(),
    listClients(user.role === "KAROS_EMPLOYEE" ? { employeeId: user.uid } : undefined),
    // §7.3. Read once for the page, indexed per client below — this list is
    // cross-client, so resolving a row's identity by querying its client's
    // umbrellas would be one Firestore read per row.
    listClientAgents(),
  ]);
  const nameById = new Map(clients.map((c) => [c.id, c.name]));
  const umbrellasByClient = identitiesByClient(umbrellas);
  // Admins and employees alike only see jobs of EXISTING (visible) clients —
  // orphaned jobs of deleted clients used to leak into this cross-client view.
  // Stripped to what the list renders: no run events, no input payloads, no
  // asset ids cross the RSC boundary just to print a row.
  const rows: JobListRow[] = jobs
    .filter((job) => nameById.has(job.clientId))
    .map((job) => ({
      id: job.id,
      // §7.3 identity (F147), not the stored name: staff read this list beside
      // the client surfaces, so a run has to be called here what the client is
      // told it is called. The job doc keeps its own agentName untouched — /jobs/[id]
      // is the forensic view of the record and still prints it verbatim.
      agentName: runRowLabel(job, umbrellasByClient.get(job.clientId) ?? []),
      title: job.title,
      clientId: job.clientId,
      clientName: nameById.get(job.clientId)!,
      status: job.status,
      createdAt: job.createdAt,
      emailed: Boolean(job.emailedTo),
    }));

  return (
    <>
      <PageHeader title="Jobs" description="Every agent run, its output and delivery status." />
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
