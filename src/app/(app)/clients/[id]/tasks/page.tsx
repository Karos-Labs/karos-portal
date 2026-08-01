import { redirect } from "next/navigation";
import { requireUser, requireVisibleClient } from "@/lib/auth";
import { TasksBody } from "@/app/(app)/tasks/tasks-body";

export const dynamic = "force-dynamic";

/**
 * Staff browsing a single client's Progress view via the sidebar's "View as
 * client" picker. CLIENT_USER already has their own Progress view at the
 * flat /tasks route — sent back there rather than duplicating it here.
 */
export default async function ClientTasksPage({ params }: { params: Promise<{ id: string }> }) {
  const user = await requireUser();
  const { id } = await params;

  if (user.role === "CLIENT_USER") {
    redirect(user.clientId === id ? "/tasks" : user.clientId ? `/clients/${user.clientId}` : "/tasks");
  } else if (user.role !== "KAROS_ADMIN" && user.role !== "KAROS_EMPLOYEE") {
    redirect("/dashboard");
  }

  const client = await requireVisibleClient(user, id);

  return <TasksBody user={user} viewClientId={client.id} />;
}
