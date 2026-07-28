import {
  listClientTasks,
  listClients,
  getClient,
  listClientActivityLogs,
  listJobs,
  listAssets,
  getClientReport,
} from "@/lib/data";
import { TasksBoard } from "@/components/tasks-board";
import { ProgressView } from "@/components/progress-view";
import { PageHeader } from "@/components/ui";
import { getClientArchiveAssets, getClientLibraryAssets } from "@/lib/asset-visibility";
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
    // A client user with no linked client renders an empty state — redirecting
    // would loop (/dashboard → /assets → /tasks → …), and there is nothing
    // cross-client a clientless viewer may ever see.
    if (!user.clientId) {
      return (
        <div>
          <PageHeader
            title="Workspace"
            description="What's next on the board, what already happened, and everything your agents have delivered."
          />
          <p className="text-sm text-muted-2">
            Your account isn&apos;t linked to a workspace yet — contact your Karos account manager.
          </p>
        </div>
      );
    }
    scopedClientId = user.clientId;
  } else if (viewClientId) {
    const client = await getClient(viewClientId);
    if (client) scopedClientId = client.id;
  }

  // Archiving is handled at query level (listClientTasks hides tasks Done ≥7d)
  // plus a physical sweep in the /api/credits/reconcile cron — no page-load work.
  if (scopedClientId) {
    const [tasks, activityLogs, jobs, report, rawAssets] = await Promise.all([
      listClientTasks({ clientId: scopedClientId }),
      listClientActivityLogs(scopedClientId),
      listJobs({ clientId: scopedClientId }),
      getClientReport(scopedClientId),
      listAssets({ clientId: scopedClientId }),
    ]);
    // Archive tab data. A client's archive is POSTED work from the last ~30
    // days only (F149/A4) — filtered HERE, at the server boundary, so nothing
    // unposted crosses into the RSC payload at all; redaction still runs behind
    // it as the standing guard for anything future-dated. Staff keep the full
    // library.
    const isClientViewer = user.role === "CLIENT_USER";
    const assets = isClientViewer
      ? getClientLibraryAssets(getClientArchiveAssets(rawAssets), { forClient: true })
      : getClientLibraryAssets(rawAssets);
    return (
      <div>
        <PageHeader
          title="Workspace"
          description="What's next on the board, what already happened, and everything your agents have delivered."
        />
        <ProgressView
          tasks={tasks}
          currentUserRole={user.role}
          clientId={scopedClientId}
          activityLogs={activityLogs}
          jobs={jobs}
          report={report}
          assets={assets}
        />
      </div>
    );
  }

  // Staff overview (no client selected): the cross-client Task Board.
  // Visibility fence: employees only see tasks of their ASSIGNED clients
  // (matching /jobs, /assets, /calendar — this board used to show every
  // client's tasks to any staff member), and tasks whose client no longer
  // exists (orphans of deleted clients) never surface for anyone.
  const [allTasks, clients] = await Promise.all([
    listClientTasks({ limit: 500 }),
    listClients(user.role === "KAROS_EMPLOYEE" ? { employeeId: user.uid } : undefined),
  ]);

  const clientMap = new Map(clients.map((c) => [c.id, c.name]));

  const annotatedTasks: (ClientTask & { _clientName?: string })[] = allTasks
    .filter((t) => clientMap.has(t.clientId))
    .map((t) => ({
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
