import Link from "next/link";
import { requireUser } from "@/lib/auth";
import { listJobs, listClients } from "@/lib/data";
import { Card, EmptyState, PageHeader } from "@/components/ui";
import { Icon } from "@/components/icon";
import { JobStatusBadge } from "@/components/job-status";
import { JobDeleteButton } from "@/components/job-delete";
import { relativeTime } from "@/lib/utils";

export default async function JobsPage() {
  const user = await requireUser(["KAROS_ADMIN", "KAROS_EMPLOYEE"]);
  const [jobs, clients] = await Promise.all([
    listJobs(),
    listClients(user.role === "KAROS_EMPLOYEE" ? { employeeId: user.uid } : undefined),
  ]);
  const allowed = new Set(clients.map((c) => c.id));
  const visible = user.role === "KAROS_EMPLOYEE" ? jobs.filter((j) => allowed.has(j.clientId)) : jobs;
  const clientName = (id: string) => clients.find((c) => c.id === id)?.name ?? "-";
  const isAdmin = user.role === "KAROS_ADMIN";

  return (
    <>
      <PageHeader title="Jobs" description="Every agent run, its output and delivery status." />
      {visible.length === 0 ? (
        <EmptyState icon={<Icon name="ListChecks" className="h-7 w-7" />} title="No jobs yet" description="Agent runs will appear here." />
      ) : (
        <Card className="p-0">
          <ul className="divide-y divide-border">
            {visible.map((job) => (
              <li key={job.id} className="flex items-center transition-colors hover:bg-surface-2/40">
                <Link href={`/jobs/${job.id}`} className="flex min-w-0 flex-1 items-center justify-between gap-3 px-5 py-4">
                  <div className="min-w-0">
                    <p className="truncate text-sm font-medium">{job.agentName}</p>
                    <p className="text-xs text-muted-2">
                      {clientName(job.clientId)} · {relativeTime(job.createdAt)}
                      {job.emailedTo && <span className="text-neon-dim"> · emailed</span>}
                    </p>
                  </div>
                  <JobStatusBadge status={job.status} />
                </Link>
                {isAdmin && (
                  <div className="pr-3">
                    <JobDeleteButton jobId={job.id} compact />
                  </div>
                )}
              </li>
            ))}
          </ul>
        </Card>
      )}
    </>
  );
}
