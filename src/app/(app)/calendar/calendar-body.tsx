import { listAssets, listClients, listCustomAgents, listJobs, listPlannedScheduledRuns } from "@/lib/data";
import { assetImages } from "@/lib/asset-images";
import { getClientLibraryAssets } from "@/lib/asset-visibility";
import { describeCadence, projectRunOccurrences } from "@/lib/scheduled-runs";
import { computeRunway } from "@/lib/runway";
import { PageHeader, EmptyState, Badge } from "@/components/ui";
import { Icon } from "@/components/icon";
import {
  RunCalendar,
  type CalendarClientOption,
  type CalendarPost,
  type CalendarRun,
  type RunAssetView,
  type ScheduleAgentOption,
} from "@/components/run-calendar";
import type { ReactNode } from "react";
import type { Asset, AppUser } from "@/lib/types";

// Jobs that have actually run (produced or attempted output).
const PAST_JOB_STATUSES = new Set(["review", "approved", "delivered", "failed"]);

function postKind(a: Asset): CalendarPost["kind"] | null {
  if (a.status === "published" && (a.scheduledAt != null || a.publishedAt != null)) return "published";
  if ((a.status === "scheduled" || a.status === "approved") && a.scheduledAt != null) {
    return a.publishMode === "placeholder" ? "placeholder" : "scheduled";
  }
  return null;
}

/**
 * Shared body for the Calendar route: a CLIENT_USER's own scoped view, staff
 * browsing a single client's Calendar (/clients/[id]/calendar — the
 * sidebar's "View as client" picker, viewClientId is that client's id), or
 * the staff cross-client overview when no client is in scope.
 */
export async function CalendarBody({ user, viewClientId }: { user: AppUser; viewClientId?: string }) {
  const isClient = user.role === "CLIENT_USER";

  // ── Resolve scope ──────────────────────────────────────────────────
  let idSet: Set<string> | null = null; // null = every client (admin overview)
  let singleFilter: { clientId: string } | undefined;
  let single = false; // when true, hide per-client name badges
  let canSchedule = false;
  let clientOptions: CalendarClientOption[] = [];
  let defaultClientId: string | undefined;
  let nameOf: (id: string) => string | undefined = () => undefined;
  let title = "Agent Calendar";
  const description = "What your agents will run, and everything they've already produced.";

  if (isClient) {
    if (!user.clientId) {
      return (
        <>
          <PageHeader title="Calendar" description="Your agent runs and content schedule." />
          <EmptyState
            icon={<Icon name="CalendarClock" className="h-7 w-7" />}
            title="Nothing scheduled yet"
            description="Your upcoming agent runs and delivered content will appear here."
          />
        </>
      );
    }
    idSet = new Set([user.clientId]);
    singleFilter = { clientId: user.clientId };
    single = true;
    title = "Calendar";
  } else {
    const employeeFilter = user.role === "KAROS_EMPLOYEE" ? { employeeId: user.uid } : undefined;
    const clients = await listClients(employeeFilter);
    const names = new Map(clients.map((c) => [c.id, c.name]));
    nameOf = (id) => names.get(id);
    canSchedule = true;

    const viewClient = viewClientId ? clients.find((c) => c.id === viewClientId) : undefined;
    if (viewClient) {
      idSet = new Set([viewClient.id]);
      singleFilter = { clientId: viewClient.id };
      single = true;
      defaultClientId = viewClient.id;
      title = `${viewClient.name} - Calendar`;
      // "View as client" is scoped to this one client — the schedule-run
      // picker must not offer every other client staff can see.
      clientOptions = [{ id: viewClient.id, name: viewClient.name }];
    } else {
      // Scope to the staff member's visible clients — for employees that's their
      // assigned set, for admins every existing client. Never null: an unfenced
      // overview also rendered orphaned runs/assets of DELETED clients.
      idSet = new Set(clients.map((c) => c.id));
      clientOptions = clients.map((c) => ({ id: c.id, name: c.name }));
    }
  }

  // ── Fetch (single-client scope uses a Firestore filter; broader scopes
  //    fetch-then-filter, matching the assets page) ─────────────────────
  const [runsRaw, jobsRaw, assetsRaw, customAgents] = await Promise.all([
    listPlannedScheduledRuns(singleFilter),
    listJobs(singleFilter),
    listAssets(singleFilter),
    listCustomAgents(),
  ]);
  const inScope = <T extends { clientId: string }>(arr: T[]): T[] =>
    idSet ? arr.filter((x) => idSet!.has(x.clientId)) : arr;

  const scheduledRuns = inScope(runsRaw);
  const jobs = inScope(jobsRaw);
  // Clients never see internal drafts (matches /assets). Future scheduled
  // deliverables also pass through the shared redaction boundary so the
  // calendar cannot expose their content, images, or download controls before
  // the scheduled day. Staff continue to receive the full assets for review.
  const scopedAssets = inScope(assetsRaw).filter((a) => !isClient || a.status !== "draft");
  const assets = isClient
    ? getClientLibraryAssets(scopedAssets, { forClient: true })
    : scopedAssets;

  // Agent lookups: by id for scheduled runs, by name for past jobs (jobs store
  // the agent's name, not its id).
  const agentById = new Map(customAgents.map((a) => [a.id, a]));
  const agentByName = new Map(customAgents.map((a) => [a.name, a]));
  const agentOptions: ScheduleAgentOption[] = customAgents
    .filter((a) => a.enabled)
    .map((a) => ({ id: a.id, name: a.name, description: a.description, icon: a.icon, color: a.color }));

  const assetsByJob = new Map<string, Asset[]>();
  for (const a of assets) {
    if (!a.jobId) continue;
    (assetsByJob.get(a.jobId) ?? assetsByJob.set(a.jobId, []).get(a.jobId)!).push(a);
  }

  // ── Scheduled (future) runs ─────────────────────────────────────────
  // eslint-disable-next-line react-hooks/purity -- server component, no re-render concern
  const scheduleNow = Date.now();
  const scheduledEntries: CalendarRun[] = scheduledRuns
    .filter((r) => r.status === "active")
    .flatMap((r) => {
      const agent = agentById.get(r.customAgentId);
      // A recurring cadence (e.g. "weekly · Mon-Fri") fires many times — project
      // every upcoming occurrence within the horizon instead of only the single
      // next fire, so a 5x/week schedule shows 5 chips a week, not 1.
      return projectRunOccurrences(r, { from: scheduleNow }).map((at) => ({
        id: r.id,
        kind: "scheduled" as const,
        clientId: r.clientId,
        clientName: single ? undefined : nameOf(r.clientId),
        at,
        productName: r.agentName,
        productColor: r.agentColor,
        productIcon: r.agentIcon,
        cadence: r.cadence,
        cadenceLabel: describeCadence(r),
        prompt: r.prompt,
        ...(agent?.description ? { agentDescription: agent.description } : {}),
      }));
    });

  // ── Past (completed) runs ───────────────────────────────────────────
  const pastEntries: CalendarRun[] = jobs
    .filter((j) => j.agentId === "agent-service" && PAST_JOB_STATUSES.has(j.status))
    .filter((j) => !(isClient && j.status === "failed")) // hide internal failures from clients
    .map((j) => {
      const agent = agentByName.get(j.agentName);
      const views: RunAssetView[] = (assetsByJob.get(j.id) ?? []).map((a) => ({
        id: a.id,
        type: a.type,
        title: a.title,
        textPreview: (a.content ?? "").slice(0, 240),
        images: assetImages(a),
      }));
      return {
        id: j.id,
        kind: "past" as const,
        clientId: j.clientId,
        clientName: single ? undefined : nameOf(j.clientId),
        at: j.createdAt,
        productName: j.agentName,
        productColor: agent?.color ?? "#FF6B2C",
        productIcon: agent?.icon ?? "Bot",
        jobStatus: j.status,
        assets: views,
        images: views.flatMap((v) => v.images),
      };
    });

  const runs = [...scheduledEntries, ...pastEntries];

  // ── Post publish events (auto-placed + manually scheduled + published) ──
  const posts: CalendarPost[] = assets
    .map((a): CalendarPost | null => {
      const kind = postKind(a);
      if (!kind) return null;
      const at = kind === "published" ? (a.publishedAt ?? a.scheduledAt!) : a.scheduledAt!;
      return {
        assetId: a.id,
        clientId: a.clientId,
        clientName: single ? undefined : nameOf(a.clientId),
        title: a.title,
        at,
        kind,
        images: assetImages(a),
        textPreview: (a.content ?? "").slice(0, 160),
      };
    })
    .filter((p): p is CalendarPost => p != null);

  // Runway indicator (staff single-client scope only — the client's own view
  // hides internal drafts, which would understate the backlog). Reuses the same
  // pure calculator the top-up cron runs, so the badge and the autopilot agree.
  let runwayBadge: ReactNode = null;
  if (single && !isClient) {
    // eslint-disable-next-line react-hooks/purity -- server component, no re-render concern
    const now = Date.now();
    const runway = computeRunway(assets, [], now);
    if (runway.activeFamilies.length > 0) {
      const fmt = (ms: number) => new Date(ms).toLocaleDateString(undefined, { month: "short", day: "numeric" });
      if (runway.coveredThroughMs == null) {
        runwayBadge = <Badge tone="danger">No runway — calendar is empty ahead</Badge>;
      } else if (runway.coveredThroughMs < runway.horizonThroughMs) {
        runwayBadge = <Badge tone="warning">Short runway — filled through {fmt(runway.coveredThroughMs)}</Badge>;
      } else {
        runwayBadge = <Badge tone="success">Runway: filled through {fmt(runway.coveredThroughMs)}</Badge>;
      }
    }
  }

  return (
    <>
      <PageHeader title={title} description={description} action={runwayBadge} />
      <RunCalendar
        runs={runs}
        posts={posts}
        assets={assets}
        canSchedule={canSchedule}
        clients={clientOptions}
        agents={agentOptions}
        defaultClientId={defaultClientId}
      />
    </>
  );
}
