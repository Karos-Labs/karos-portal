import Link from "next/link";
import { redirect } from "next/navigation";
import { requireUser } from "@/lib/auth";
import { listClients, listJobs, listAssets, listTranscripts, listActionItemsByAssignee, listUsers, listCustomAgents } from "@/lib/data";
import { Card, CardTitle, StatCard, Badge, EmptyState, Button, PageHeader } from "@/components/ui";
import { Icon } from "@/components/icon";
import { JobStatusBadge } from "@/components/job-status";
import { MyActionItems } from "@/components/my-action-items";
import { relativeTime } from "@/lib/utils";
import { AGENT_SERVICE_AGENT_ID } from "@/lib/agent-service/products";

export default async function DashboardPage() {
  const user = await requireUser();

  if (user.role === "CLIENT_USER") {
    redirect(user.clientId ? `/clients/${user.clientId}` : "/assets");
  }

  // Managed action items — admin-only view for now (see action-item-actions.ts
  // for the client rollout note).
  const isAdmin = user.role === "KAROS_ADMIN";
  const employeeFilter = user.role === "KAROS_EMPLOYEE" ? { employeeId: user.uid } : undefined;
  const [clients, jobs, myActionItems, allUsers, customAgents] = await Promise.all([
    listClients(employeeFilter),
    listJobs(),
    isAdmin ? listActionItemsByAssignee(user.uid) : Promise.resolve([]),
    isAdmin ? listUsers() : Promise.resolve([]),
    listCustomAgents(),
  ]);
  const managedJobs = jobs.filter((j) => j.agentId === AGENT_SERVICE_AGENT_ID);
  const enabledAgents = customAgents.filter((a) => a.enabled);
  // Reassignment targets: active staff only.
  const staffUsers = allUsers.filter(
    (u) => !u.disabled && (u.role === "KAROS_ADMIN" || u.role === "KAROS_EMPLOYEE"),
  );
  // eslint-disable-next-line react-hooks/purity -- server component, no re-render concern
  const weekAgo = Date.now() - 7 * 86400000;
  const jobsThisWeek = jobs.filter((j) => j.createdAt > weekAgo);
  const delivered = jobs.filter((j) => j.status === "delivered").length;

  return (
    <>
      <PageHeader
        title={`Welcome back, ${user.name.split(" ")[0]}`}
        description="Your AI agency at a glance."
        action={
          <Link href="/agents">
            <Button>
              <Icon name="Play" className="h-4 w-4" />
              Run an agent
            </Button>
          </Link>
        }
      />

      <div className="grid grid-cols-2 gap-4 lg:grid-cols-4">
        <StatCard label="Clients" value={clients.length} icon={<Icon name="Building2" className="h-5 w-5" />} />
        <StatCard label="Managed runs" value={managedJobs.length} icon={<Icon name="Bot" className="h-5 w-5" />} />
        <StatCard label="Jobs this week" value={jobsThisWeek.length} icon={<Icon name="ListChecks" className="h-5 w-5" />} />
        <StatCard label="Delivered" value={delivered} icon={<Icon name="Send" className="h-5 w-5" />} />
      </div>

      {isAdmin && (
        <div className="mt-6">
          <MyActionItems
            items={myActionItems}
            users={staffUsers}
            clients={clients}
            currentUserId={user.uid}
          />
        </div>
      )}

      <div className="mt-6 grid gap-4 lg:grid-cols-3">
        <Card className="lg:col-span-2">
          <div className="mb-4 flex items-center justify-between">
            <CardTitle>Recent jobs</CardTitle>
            <Link href="/jobs" className="text-xs text-neon hover:underline">
              View all
            </Link>
          </div>
          {jobs.length === 0 ? (
            <EmptyState
              icon={<Icon name="ListChecks" className="h-6 w-6" />}
              title="No jobs yet"
              description="Run an agent on a client to generate your first deliverable."
              action={
                <Link href="/agents">
                  <Button size="sm">Browse agents</Button>
                </Link>
              }
            />
          ) : (
            <ul className="divide-y divide-border">
              {jobs.slice(0, 6).map((job) => (
                <li key={job.id}>
                  <Link href={`/jobs/${job.id}`} className="flex items-center justify-between gap-3 py-3 transition-colors hover:bg-surface-2/40 -mx-2 px-2 rounded-lg">
                    <div className="min-w-0">
                      <p className="truncate text-sm font-medium">{job.title}</p>
                      <p className="text-xs text-muted-2">{relativeTime(job.createdAt)}</p>
                    </div>
                    <JobStatusBadge status={job.status} />
                  </Link>
                </li>
              ))}
            </ul>
          )}
        </Card>

        <Card>
          <div className="mb-4 flex items-center justify-between">
            <CardTitle>Agents</CardTitle>
            <Link href="/agents" className="text-xs text-neon hover:underline">Manage</Link>
          </div>
          {enabledAgents.length === 0 ? (
            <EmptyState
              icon={<Icon name="Bot" className="h-6 w-6" />}
              title="No agents yet"
              description="Import agents from the karos-agents repo to get started."
              action={
                <Link href="/agents">
                  <Button size="sm">Import agents</Button>
                </Link>
              }
            />
          ) : (
            <ul className="space-y-2">
              {enabledAgents.slice(0, 6).map((agent) => {
                const runs = managedJobs.filter((j) => j.agentName === agent.name).length;
                return (
                  <li key={agent.id}>
                    <Link href="/agents" className="flex items-center gap-3 rounded-md p-2 transition-colors hover:bg-surface-2">
                      <div
                        className="flex h-9 w-9 items-center justify-center rounded-md"
                        style={{ color: agent.color, background: agent.color + "1f" }}
                      >
                        <Icon name={agent.icon} className="h-4 w-4" />
                      </div>
                      <div className="min-w-0 flex-1">
                        <p className="truncate text-sm font-medium">{agent.name}</p>
                        <p className="text-xs text-muted-2">{runs} run{runs !== 1 ? "s" : ""}</p>
                      </div>
                      <Badge tone="neon">Live</Badge>
                    </Link>
                  </li>
                );
              })}
            </ul>
          )}
        </Card>
      </div>
    </>
  );
}

async function ClientDashboard({ clientId, name }: { clientId: string; name: string }) {
  const [assets, transcripts] = await Promise.all([
    clientId ? listAssets({ clientId }) : Promise.resolve([]),
    clientId ? listTranscripts({ clientId }) : Promise.resolve([]),
  ]);
  const delivered = assets.filter((a) => a.status === "delivered" || a.status === "approved" || a.status === "published");

  return (
    <>
      <PageHeader title={`Hi ${name.split(" ")[0]}`} description="Everything your Karos team has prepared for you." />
      <div className="grid grid-cols-2 gap-4 lg:grid-cols-3">
        <StatCard label="Assets" value={assets.length} icon={<Icon name="FolderOpen" className="h-5 w-5" />} />
        <StatCard label="Approved & live" value={delivered.length} icon={<Icon name="CircleCheckBig" className="h-5 w-5" />} />
        <StatCard label="Meetings" value={transcripts.length} icon={<Icon name="Mic" className="h-5 w-5" />} />
      </div>
      <Card className="mt-6">
        <div className="mb-4 flex items-center justify-between">
          <CardTitle>Latest assets</CardTitle>
          <Link href="/assets" className="text-xs text-neon hover:underline">View all</Link>
        </div>
        {assets.length === 0 ? (
          <EmptyState icon={<Icon name="FolderOpen" className="h-6 w-6" />} title="Nothing here yet" description="Your team's deliverables will appear here." />
        ) : (
          <ul className="divide-y divide-border">
            {assets.slice(0, 6).map((a) => (
              <li key={a.id} className="flex items-center justify-between py-3">
                <div className="min-w-0">
                  <p className="truncate text-sm font-medium">{a.title}</p>
                  <p className="text-xs text-muted-2">{relativeTime(a.createdAt)}</p>
                </div>
                <Badge tone={a.status === "draft" ? "warning" : "neon"}>{a.status}</Badge>
              </li>
            ))}
          </ul>
        )}
      </Card>
    </>
  );
}
