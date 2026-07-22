import { requireUser } from "@/lib/auth";
import { TasksBody } from "./tasks-body";

export const dynamic = "force-dynamic";

export default async function TasksPage() {
  const user = await requireUser();
  return <TasksBody user={user} />;
}
