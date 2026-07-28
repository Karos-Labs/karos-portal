import Link from "next/link";
import {
  listAssets,
  listClientIntegrations,
  listClients,
  listCustomAgents,
  listJobs,
  listPlannedScheduledRuns,
} from "@/lib/data";
import { assetImages } from "@/lib/asset-images";
import { getClientLibraryAssets } from "@/lib/asset-visibility";
import { integrationIsUsable } from "@/lib/integration-status";
import { stripInlineMarkdown, toPlainSummary } from "@/lib/doc-render";
import { PUBLISHABLE_PLATFORMS } from "@/lib/integrations/platforms";
import { describeCadence, shortZoneLabel } from "@/lib/scheduled-runs";
import { PageHeader, EmptyState } from "@/components/ui";
import { Icon } from "@/components/icon";
import {
  RunCalendar,
  type CalendarClientOption,
  type CalendarPost,
  type CalendarRun,
  type RunAssetView,
  type ScheduleAgentOption,
} from "@/components/run-calendar";
import type { Asset, AppUser, AssetType } from "@/lib/types";

// Jobs that have actually run (produced or attempted output).
const PAST_JOB_STATUSES = new Set(["review", "approved", "delivered", "failed"]);

/** Plain-English noun for what a run actually produced. */
const OUTPUT_NOUN: Record<AssetType, [string, string]> = {
  instagram_post: ["post", "posts"],
  social_post: ["post", "posts"],
  article: ["article", "articles"],
  email: ["email", "emails"],
  note: ["note", "notes"],
};

/**
 * "drafted 8 posts" — composed from the run's own deliverables instead of
 * echoing the record's internal summary text.
 */
function describeRunOutput(views: RunAssetView[]): string | undefined {
  if (views.length === 0) return undefined;
  const types = new Set(views.map((v) => v.type));
  const [one, many] =
    types.size === 1 ? OUTPUT_NOUN[[...types][0]] ?? ["item", "items"] : ["item", "items"];
  return `${views.length} ${views.length === 1 ? one : many}`;
}

/** Titles come straight from the agent — a leading `#` or `**` is not a title. */
function cleanTitle(title: string): string {
  return stripInlineMarkdown(title.replace(/^#{1,6}\s+/, "")) || title;
}

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
    clientOptions = clients.map((c) => ({ id: c.id, name: c.name }));
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
    } else {
      // Scope to the staff member's visible clients — for employees that's their
      // assigned set, for admins every existing client. Never null: an unfenced
      // overview also rendered orphaned runs/assets of DELETED clients.
      idSet = new Set(clients.map((c) => c.id));
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
  // `description` here is the internal lab manifest and this array is serialized
  // into the payload the browser receives, rendered or not — so client viewers
  // get the written blurb (empty until one exists), never the manifest.
  const agentOptions: ScheduleAgentOption[] = customAgents
    .filter((a) => a.enabled)
    .map((a) => ({
      id: a.id,
      name: a.name,
      description: isClient ? a.clientBlurb?.trim() ?? "" : a.description,
      icon: a.icon,
      color: a.color,
    }));

  const assetsByJob = new Map<string, Asset[]>();
  for (const a of assets) {
    if (!a.jobId) continue;
    (assetsByJob.get(a.jobId) ?? assetsByJob.set(a.jobId, []).get(a.jobId)!).push(a);
  }

  // ── Scheduled (future) runs ─────────────────────────────────────────
  const scheduledEntries: CalendarRun[] = scheduledRuns
    .filter((r) => r.status === "active")
    .map((r) => {
      const agent = agentById.get(r.customAgentId);
      // Client-visible calendar: the lab manifest never ships here either.
      const blurb = agent?.clientBlurb?.trim() || agent?.description;
      return {
        id: r.id,
        kind: "scheduled" as const,
        clientId: r.clientId,
        clientName: single ? undefined : nameOf(r.clientId),
        at: r.nextRunAt,
        productName: r.agentName,
        productColor: r.agentColor,
        productIcon: r.agentIcon,
        cadence: r.cadence,
        cadenceLabel: describeCadence(r),
        // The zone the schedule's wall clock was set in. Sent to the browser so
        // the chip's day bucket and printed time are computed there exactly as
        // they were on the server — a schedule with no stored zone (written
        // before the field existed) keeps the old runtime-local behaviour.
        ...(r.timeZone ? { timeZone: r.timeZone, zoneLabel: shortZoneLabel(r.timeZone, r.nextRunAt) } : {}),
        prompt: r.prompt,
        ...(blurb ? { agentDescription: blurb } : {}),
      };
    });

  // ── Past (completed) runs ───────────────────────────────────────────
  const pastEntries: CalendarRun[] = jobs
    .filter((j) => j.agentId === "agent-service" && PAST_JOB_STATUSES.has(j.status))
    .filter((j) => !(isClient && j.status === "failed")) // hide internal failures from clients
    .map((j) => {
      const agent = agentByName.get(j.agentName);
      // Sanitized here, at the server boundary, not at render: slicing raw
      // content shipped the run record's own bookkeeping — markdown syntax, the
      // internal status word, the lab product code and the job hash — into the
      // payload of the panel a client opens to see what ran.
      const views: RunAssetView[] = (assetsByJob.get(j.id) ?? []).map((a) => ({
        id: a.id,
        type: a.type,
        title: cleanTitle(a.title),
        textPreview: toPlainSummary(a.content, 240),
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
        ...(describeRunOutput(views) ? { outputSummary: describeRunOutput(views) } : {}),
        // Job id is staff bookkeeping: a tooltip for them, absent for clients.
        ...(isClient ? {} : { staffRef: `Job ${j.id}${agent ? ` · agent ${agent.id}` : ""}` }),
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
        title: cleanTitle(a.title),
        at,
        kind,
        images: assetImages(a),
        // Same leak class as the run cards above — same treatment.
        textPreview: toPlainSummary(a.content, 160),
      };
    })
    .filter((p): p is CalendarPost => p != null);

  // ── Manual push ("Publish Now") — staff only ────────────────────────
  // The approve panel's "Manual push" tier tells the user they push the post
  // live from the calendar, so the calendar's detail panel needs the control.
  // publishAssetNowAction is requireStaff(), so this is built ONLY for staff —
  // a client viewer's payload gains nothing. Integrations are read for the
  // clients that actually own a pushable post, not for every client in scope.
  let connectedPlatformsByClient: Record<string, string[]> | undefined;
  if (!isClient) {
    const pushableClientIds = [
      ...new Set(
        assets
          .filter(
            (a) =>
              (a.status === "approved" || a.status === "scheduled") &&
              a.publishMode !== "placeholder" &&
              (PUBLISHABLE_PLATFORMS[a.type] ?? []).length > 0,
          )
          .map((a) => a.clientId),
      ),
    ];
    if (pushableClientIds.length > 0) {
      const perClient = await Promise.all(
        pushableClientIds.map(async (id) => {
          const integrations = await listClientIntegrations(id);
          // Platform ids only — never the integration records, which carry
          // decrypted OAuth credentials.
          return [id, integrations.filter(integrationIsUsable).map((i) => i.platform)] as const;
        }),
      );
      connectedPlatformsByClient = Object.fromEntries(perClient);
    }
  }

  // ── Empty state ─────────────────────────────────────────────────────
  // A month of blank squares under a header promising "what your agents will
  // run" is a dead end: clicking a day does nothing, and nothing says where
  // schedules come from. Clients CAN set one up — one item up the same rail —
  // via configureClientAgentScheduleAction, so this hands off rather than
  // apologising.
  const scopedClientId = singleFilter?.clientId;
  const isEmpty = runs.length + posts.length === 0;

  return (
    <>
      <PageHeader title={title} description={description} />
      {isEmpty && scopedClientId && (
        <div className="mb-4">
          <EmptyState
            icon={<Icon name="CalendarClock" className="h-7 w-7" />}
            title="No runs on the calendar yet"
            description="Schedules are set on the AI Agents page. Once an agent has one, its runs and everything they produce show up here."
            action={
              <Link
                href={`/clients/${scopedClientId}/agents`}
                className="inline-flex h-10 items-center justify-center gap-2 rounded-md bg-neon px-4 text-sm font-semibold text-accent-ink transition-all duration-200 hover:-translate-y-0.5"
              >
                <Icon name="Bot" className="h-4 w-4" />
                Set up an agent schedule
              </Link>
            }
          />
        </div>
      )}
      <RunCalendar
        runs={runs}
        posts={posts}
        assets={assets}
        canSchedule={canSchedule}
        clients={clientOptions}
        agents={agentOptions}
        {...(connectedPlatformsByClient ? { connectedPlatformsByClient } : {})}
        defaultClientId={defaultClientId}
      />
    </>
  );
}
