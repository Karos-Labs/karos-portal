import {
  listClientTasks,
  listClients,
  getClient,
  listClientActivityLogs,
  listJobs,
  listAssets,
  getClientReport,
} from "@/lib/data";
import { listClientAgents } from "@/lib/data-client-agents";
import { TasksBoard } from "@/components/tasks-board";
import { ProgressView } from "@/components/progress-view";
import type { TimelineActivity, TimelineJob } from "@/components/activity-timeline";
import { PageHeader } from "@/components/ui";
import { contentLabelsByAsset, runRowLabel } from "@/lib/agent-identity-map";
import { getClientArchiveAssets, getClientLibraryAssets } from "@/lib/asset-visibility";
import { clientSafeActor } from "@/lib/activity-actors";
import { isRunMachineryTitle } from "@/lib/activity-titles";
import { pastRunStatuses } from "@/lib/calendar-past-runs";
import { clientSafeRefusal } from "@/lib/custom-agent-launch";
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
    const [tasks, activityLogs, jobs, report, rawAssets, umbrellas] = await Promise.all([
      listClientTasks({ clientId: scopedClientId }),
      listClientActivityLogs(scopedClientId),
      listJobs({ clientId: scopedClientId }),
      getClientReport(scopedClientId),
      listAssets({ clientId: scopedClientId }),
      listClientAgents({ clientId: scopedClientId }),
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
    // The activity timeline narrates these runs, and on failure prints the
    // stored error verbatim. Two things must not go
    // through that door for a client: a LAUNCH run (its story is the launch
    // card's three phases — a second telling is the double identity again, and
    // it announces a deliverable that is staff-only by design), and the raw
    // service error, which is the same internal string every other client
    // surface routes through clientSafeRefusal. Both are handled HERE, at the
    // server boundary, because everything below is serialized into the RSC
    // payload whether or not it is painted.
    //
    // §7.3 identity (F147). The Workspace shows the same stream twice — the
    // Activity tab narrates the runs, the Archive tab groups their output — and
    // before this the two read the JOB's stored agentName and the ASSET's
    // derived label independently, which is exactly how one agent came to have
    // two names one tab apart. Both are resolved HERE, through the one helper,
    // and only the finished label crosses into the payload: the archive is a
    // client component and has no business holding umbrella ids or launch
    // states to re-derive a heading from.
    //
    // PROJECTED, not spread. This list is serialized into the RSC payload the
    // browser downloads, and a whole Job carries `input` (the operator's prompt
    // and brief), `events` (the internal execution trace), `clientAgentId` and
    // `meta.agentsRepoSha` — the git SHA of the private lab repo. The timeline
    // paints five fields; five fields is what crosses. Built by CONSTRUCTION so
    // a field added to Job later is excluded by default (the redactLockedAsset
    // rule), which is exactly what a `{ ...job }` here defeated.
    // The timeline's OTHER half, projected by the same rule and for the same
    // reason. An ActivityLog carries `clientId` and a free-form `metadata` bag
    // nothing paints, and its `actor` is whatever the writer stored — the
    // automated writers store internal service names ("Runway autopilot", see
    // activity-actors.ts). All of it shipped, and the redaction ran in the
    // BROWSER on a payload the browser already had.
    //
    // MANUAL_NOTE rows go the same way. They are written by the staff-only
    // composer in the timeline ("Add an internal note…"), and they were dropped
    // at render for a client while crossing the boundary in full — title, body
    // and the staff author's name. Dropped HERE instead, exactly like the
    // launch runs below.
    //
    // Machinery rows go with them. "Managed job started: Social posts
    // (IG/TikTok)" is the operator's dispatch record, and it reached the client
    // verbatim: the machine's vocabulary on the one screen that narrates their
    // work, one row per dispatch, so a runway top-up wrote up to fourteen of
    // them inside a single minute (the batch tell the run aggregation below was
    // added to close). The client is told nothing less — every writer of these
    // rows mints a job too, and a client's jobs are already narrated here,
    // collapsed to one row per agent per day in outcome language. See
    // activity-titles.ts for why the launch/setup row is on that list as well.
    const timelineActivity: TimelineActivity[] = activityLogs
      .filter(
        (log) =>
          !isClientViewer || (log.type !== "MANUAL_NOTE" && !isRunMachineryTitle(log.title)),
      )
      .map((log) => ({
        id: log.id,
        timestamp: log.timestamp,
        type: log.type,
        title: log.title,
        ...(log.description ? { description: log.description } : {}),
        // Staff are handed the row untouched, so their timeline is unchanged.
        ...clientSafeActor(log.actor, log.actorRole, isClientViewer),
      }));
    const agentLabelByAssetId = contentLabelsByAsset(assets, jobs, umbrellas);
    // WHICH run states this viewer may be narrated at all is the calendar's
    // rule, and it has one home: pastRunStatuses in lib/calendar-past-runs. This
    // file used to answer half of it inline (`isClientViewer && status ===
    // "failed"`), which is how the two came apart — a staff-cancelled run was
    // already absent from the client's calendar while still being narrated here.
    // Both withheld states are refunded outcomes, so neither is work the client
    // received, and this timeline collapses everything non-failed into "<agent>
    // worked on your content" — a claim a deliberately stopped run does not
    // support. The staff set holds every JobStatus, so no run state is withheld
    // from staff here.
    const timelineStatuses = pastRunStatuses({ isClient: isClientViewer });
    const timelineJobs: TimelineJob[] = jobs
      .filter((job) => !isClientViewer || (job.runType !== "launch" && job.runType !== "test"))
      .filter((job) => timelineStatuses.has(job.status))
      .map((job) => ({
        id: job.id,
        agentName: runRowLabel(job, umbrellas),
        status: job.status,
        title: job.title,
        createdAt: job.createdAt,
        ...(job.error
          ? { error: isClientViewer ? clientSafeRefusal(job.error) : job.error }
          : {}),
      }));
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
          activityLogs={timelineActivity}
          jobs={timelineJobs}
          report={report}
          assets={assets}
          agentLabelByAssetId={agentLabelByAssetId}
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
      <PageHeader title="Workspace" description="Every client's board in one place." />
      <TasksBoard tasks={annotatedTasks} currentUserRole={user.role} showClientName />
    </div>
  );
}
