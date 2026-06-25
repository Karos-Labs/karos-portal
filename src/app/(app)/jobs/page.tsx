import Link from "next/link";
import { requireUser } from "@/lib/auth";
import { listJobs, listClients } from "@/lib/data";
import { Card, EmptyState, PageHeader } from "@/components/ui";
import { Icon } from "@/components/icon";
import { JobStatusBadge } from "@/components/job-status";
import { relativeTime } from "@/lib/utils";

export default async function JobsPage() {
  const user = await requireUser(["admin", "employee"]);
  const [jobs, clients] = await Promise.all([
    listJobs(),
    listClients(user.role === "employee" ? { employeeId: user.uid } : undefined),
  ]);
  const allowed = new Set(clients.map((c) => c.id));
  const visible = user.role === "employee" ? jobs.filter((j) => allowed.has(j.clientId)) : jobs;
  const clientName = (id: string) => clients.find((c) => c.id === id)?.name ?? "—";

  return (
    <>
      <PageHeader title="Jobs" description="Every agent run, its output and delivery status." />
      {visible.length === 0 ? (
        <EmptyState icon={<Icon name="ListChecks" className="h-7 w-7" />} title="No jobs yet" description="Agent runs will appear here." />
      ) : (
        <Card className="p-0">
          <ul className="divide-y divide-border">
            {visible.map((job) => (
              <li key={job.id}>
                <Link href={`/jobs/${job.id}`} className="flex items-center justify-between gap-3 px-5 py-4 transition-colors hover:bg-surface-2/40">
                  <div className="min-w-0">
                    <p className="truncate text-sm font-medium">{job.agentName}</p>
                    <p className="text-xs text-muted-2">
                      {clientName(job.clientId)} · {relativeTime(job.createdAt)}
                      {job.emailedTo && <span className="text-neon-dim"> · emailed</span>}
                    </p>
                  </div>
                  <JobStatusBadge status={job.status} />
                </Link>
              </li>
            ))}
          </ul>
        </Card>
      )}
    </>
  );
}
