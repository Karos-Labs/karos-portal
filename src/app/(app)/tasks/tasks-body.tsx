import { redirect } from "next/navigation";
import {
  listClientTasks,
  listClients,
  getClient,
  getClientSettings,
  listClientActivityLogs,
  listJobs,
  getClientReport,
} from "@/lib/data";
import { TasksBoard } from "@/components/tasks-board";
import { ProgressView } from "@/components/progress-view";
import { PageHeader } from "@/components/ui";
import type { AppUser, ClientTask } from "@/lib/types";

/**
 * Shared body for the Tasks route: a CLIENT_USER's own Progress view, staff
 * browsing a single client's Progress view (/clients/[id]/tasks — the
 * sidebar's "View as client" picker), or the staff cross-client Task Board
 * overview when no client is in scope. The id is re-validated against a
 * real client here, never trusted as-is, so it can't be used to peek at an
 * arbitrary clientId.
 */
export async function TasksBody({ user, viewClientId }: { user: AppUser; viewClientId?: string }) {
  let scopedClientId: string | undefined;
  if (user.role === "CLIENT_USER") {
    if (!user.clientId) redirect("/dashboard");
    scopedClientId = user.clientId;
  } else if (viewClientId) {
    const client = await getClient(viewClientId);
    if (client) scopedClientId = client.id;
  }

  // Archiving is handled at query level (listClientTasks hides tasks Done ≥7d)
  // plus a physical sweep in the /api/credits/reconcile cron — no page-load work.
  if (scopedClientId) {
    const [tasks, settings, activityLogs, jobs, report] = await Promise.all([
      listClientTasks({ clientId: scopedClientId }),
      getClientSettings(scopedClientId),
      listClientActivityLogs(scopedClientId),
      listJobs({ clientId: scopedClientId }),
      getClientReport(scopedClientId),
    ]);
    return (
      <div>
        <PageHeader
          title="Progress"
          description="Your tasks and account activity: what's next and what's done."
        />
        <ProgressView
          tasks={tasks}
          currentUserRole={user.role}
          clientId={scopedClientId}
          autopilotEnabled={settings?.autopilot ?? false}
          activityLogs={activityLogs}
          jobs={jobs}
          report={report}
        />
      </div>
    );
  }

  // Staff overview (no client selected): show all tasks across all clients
  const [allTasks, clients] = await Promise.all([
    listClientTasks({ limit: 500 }),
    listClients(),
  ]);

  const clientMap = new Map(clients.map((c) => [c.id, c.name]));

  const annotatedTasks: (ClientTask & { _clientName?: string })[] = allTasks.map((t) => ({
    ...t,
    _clientName: clientMap.get(t.clientId),
  }));

  return (
    <div>
      <PageHeader title="Task Board" />
      <TasksBoard tasks={annotatedTasks} currentUserRole={user.role} showClientName />
    </div>
  );
}
