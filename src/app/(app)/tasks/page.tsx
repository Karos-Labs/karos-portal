import { redirect } from "next/navigation";
import { requireUser } from "@/lib/auth";
import { listClientTasks, listClients, getClientSettings } from "@/lib/data";
import { TasksBoard } from "@/components/tasks-board";
import { QuickAddTaskBar } from "@/components/quick-add-task-bar";
import { PageHeader } from "@/components/ui";
import type { ClientTask } from "@/lib/types";

export const dynamic = "force-dynamic";

export default async function TasksPage() {
  const user = await requireUser();

  // CLIENT_USER sees only their client's tasks + autopilot toggle
  if (user.role === "CLIENT_USER") {
    if (!user.clientId) redirect("/dashboard");
    const [tasks, settings] = await Promise.all([
      listClientTasks({ clientId: user.clientId }),
      getClientSettings(user.clientId),
    ]);
    return (
      <div>
        <PageHeader
          title="Task Board"
          description="Your AI-generated and operational tasks, organized by priority and ownership."
        />
        <div className="mb-4">
          <QuickAddTaskBar clientId={user.clientId} />
        </div>
        <TasksBoard
          tasks={tasks}
          currentUserRole={user.role}
          clientId={user.clientId}
          autopilotEnabled={settings?.autopilot ?? false}
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
