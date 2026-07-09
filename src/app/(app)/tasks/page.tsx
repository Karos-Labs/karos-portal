import { redirect } from "next/navigation";
import { requireUser } from "@/lib/auth";
import {
  listClientTasks,
  listClients,
  getClientSettings,
  listClientActivityLogs,
  listJobs,
  getClientReport,
} from "@/lib/data";
import { TasksBoard } from "@/components/tasks-board";
import { ProgressView } from "@/components/progress-view";
import { PageHeader } from "@/components/ui";
import type { ClientTask } from "@/lib/types";

export const dynamic = "force-dynamic";

export default async function TasksPage() {
  const user = await requireUser();

  // CLIENT_USER sees only their client's tasks + activity, behind one Progress view.
  if (user.role === "CLIENT_USER") {
    if (!user.clientId) redirect("/dashboard");
    const [tasks, settings, activityLogs, jobs, report] = await Promise.all([
      listClientTasks({ clientId: user.clientId }),
      getClientSettings(user.clientId),
      listClientActivityLogs(user.clientId),
      listJobs({ clientId: user.clientId }),
      getClientReport(user.clientId),
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
          clientId={user.clientId}
          autopilotEnabled={settings?.autopilot ?? false}
          activityLogs={activityLogs}
          jobs={jobs}
          report={report}
        />
      </div>
    );
  }

  // Staff: show all tasks across all clients
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
      <PageHeader
        title="Task Board"
        description={`${allTasks.length} tasks across all clients.`}
      />
      <TasksBoard tasks={annotatedTasks} currentUserRole={user.role} showClientName />
    </div>
  );
}
