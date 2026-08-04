import Link from "next/link";
import {
  getClient,
  listAssets,
  listClients,
  listCustomAgents,
  listJobs,
  listPlannedScheduledRuns,
} from "@/lib/data";
import { listClientAgents } from "@/lib/data-client-agents";
import { assetImages } from "@/lib/asset-images";
import { clientVisibleCalendarAssets } from "@/lib/client-calendar";
import {
  identitiesByClient,
  runRowLabel,
  scheduleRowLabel,
  type ClientAgentIdentity,
} from "@/lib/agent-identity-map";
import {
  assetRowPlatform,
  runRowPlatform,
  scheduleRowPlatform,
} from "@/lib/content-platform";
import { stripInlineMarkdown, toPlainSummary } from "@/lib/doc-render";
import { postKind } from "@/lib/calendar-kind";
import { projectPastRuns } from "@/lib/calendar-past-runs";
import { clientSafeRefusal } from "@/lib/custom-agent-launch";
import { pushablePlatformsByClient } from "@/lib/publish-targets";
import {
  clientCadenceLabel,
  describeCadence,
  projectRunOccurrences,
  shortZoneLabel,
} from "@/lib/scheduled-runs";
import { computeRunway } from "@/lib/runway";
import { isValidTimeZone } from "@/lib/run-cadence";
import { clientAgentBlurb } from "@/lib/agent-blurbs";
import { PageHeader, EmptyState, Badge } from "@/components/ui";
import { Icon } from "@/components/icon";
import { AutoRefresh } from "@/components/auto-refresh";
import {
  RunCalendar,
  type CalendarClientOption,
  type CalendarPost,
  type CalendarRun,
  type RunAssetView,
  type ScheduleAgentOption,
} from "@/components/run-calendar";
import type { ReactNode } from "react";
import type { Asset, AppUser, AssetType, Client } from "@/lib/types";

/** Plain-English noun for what a run actually produced. */
const OUTPUT_NOUN: Record<AssetType, [string, string]> = {
  instagram_post: ["post", "posts"],
  social_post: ["post", "posts"],
  article: ["article", "articles"],
  email: ["email", "emails"],
  note: ["note", "notes"],
};

/**
 * "drafted 8 posts" - composed from the run's own deliverables instead of
 * echoing the record's internal summary text.
 */
function describeRunOutput(views: RunAssetView[]): string | undefined {
  if (views.length === 0) return undefined;
  const types = new Set(views.map((v) => v.type));
  const [one, many] =
    types.size === 1 ? OUTPUT_NOUN[[...types][0]] ?? ["item", "items"] : ["item", "items"];
  return `${views.length} ${views.length === 1 ? one : many}`;
}

/**
 * The zone a scheduled run's wall clock actually means (CD-H7c).
 *
 * The run card printed "…09:00 · next 11:00 AM": describeCadence renders the
 * STORED hour, while the next-run time was formatted in whatever zone the
 * renderer happened to be in - two clocks, neither labelled, disagreeing by the
 * offset between them. A row written before `timeZone` existed had its
 * nextRunAt computed against the runtime's own zone (see the timezone contract
 * in lib/scheduled-runs), so that is the zone its hour was always expressed in.
 * Resolving it here means both halves of the line — the cadence's stored hour
 * and the printed zone suffix — come off the same clock, and a row WITH a
 * stored zone is unaffected.
 *
 * NOT THE DAY BUCKET. This used to claim the bucket too, and the calendar
 * bucketed run chips on this zone while everything else in the grid (post
 * chips, the day numbers, the "today" ring) used the viewer's — so a chip could
 * sit one cell away from the day it will actually reach the viewer. Which cell
 * an entry lands in is now one question with one answer; see `dayKey` in
 * components/run-calendar. This value is what the chip PRINTS.
 */
const RUNTIME_ZONE = Intl.DateTimeFormat().resolvedOptions().timeZone;

function runZone(stored: string | undefined): string {
  return isValidTimeZone(stored) ? stored : RUNTIME_ZONE;
}

/** Titles come straight from the agent - a leading `#` or `**` is not a title. */
function cleanTitle(title: string): string {
  return stripInlineMarkdown(title.replace(/^#{1,6}\s+/, "")) || title;
}

/**
 * Shared body for the Calendar route: a CLIENT_USER's own scoped view, staff
 * browsing a single client's Calendar (/clients/[id]/calendar - the
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
  // The client record in scope, when exactly one is. Read for its `dailyPace`
  // by the runway badge below, so the badge measures against the pace the
  // planners actually fill this client's days at.
  let scopedClient: Client | undefined;
  let title = "Agent Calendar";
  const description = "What your agents will run, and everything they've already produced.";
  // Every client a schedule row below might belong to — the one thing needed
  // to tell whether that row's agent is still granted (isAgentLiveForClient).
  // Populated per branch: the viewer's own client doc for a CLIENT_USER, the
  // staff member's visible roster otherwise — the same set `idSet` is built
  // from, so it always covers every row `inScope` lets through.
  let clients: Client[] = [];

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
    const ownClient = await getClient(user.clientId);
    if (ownClient) clients = [ownClient];
  } else {
    const employeeFilter = user.role === "KAROS_EMPLOYEE" ? { employeeId: user.uid } : undefined;
    clients = await listClients(employeeFilter);
    const names = new Map(clients.map((c) => [c.id, c.name]));
    nameOf = (id) => names.get(id);
    canSchedule = true;

    const viewClient = viewClientId ? clients.find((c) => c.id === viewClientId) : undefined;
    if (viewClient) {
      idSet = new Set([viewClient.id]);
      singleFilter = { clientId: viewClient.id };
      single = true;
      scopedClient = viewClient;
      defaultClientId = viewClient.id;
      title = `${viewClient.name} · Calendar`;
      // "View as client" is scoped to this one client — the schedule-run
      // picker must not offer every other client staff can see.
      clientOptions = [{ id: viewClient.id, name: viewClient.name }];
    } else {
      // Scope to the staff member's visible clients - for employees that's their
      // assigned set, for admins every existing client. Never null: an unfenced
      // overview also rendered orphaned runs/assets of DELETED clients.
      idSet = new Set(clients.map((c) => c.id));
      clientOptions = clients.map((c) => ({ id: c.id, name: c.name }));
    }
  }

  // ── Fetch (single-client scope uses a Firestore filter; broader scopes
  //    fetch-then-filter, matching the assets page) ─────────────────────
  const [runsRaw, jobsRaw, assetsRaw, customAgents, umbrellasRaw] = await Promise.all([
    listPlannedScheduledRuns(singleFilter),
    listJobs(singleFilter),
    listAssets(singleFilter),
    listCustomAgents(),
    // §7.3. One scoped read for the whole page - the cross-client overview
    // labels rows of many clients, and a per-row umbrella query would be one
    // Firestore read per printed card.
    listClientAgents(singleFilter),
  ]);
  const inScope = <T extends { clientId: string }>(arr: T[]): T[] =>
    idSet ? arr.filter((x) => idSet!.has(x.clientId)) : arr;

  const scheduledRuns = inScope(runsRaw);
  const jobs = inScope(jobsRaw);
  // WHAT A VIEWER'S CALENDAR IS MADE OF now lives in lib/client-calendar, and
  // this page is one of its two readers — the daily digest is the other, and it
  // has to be able to say it is showing the calendar rather than something like
  // it (AF-19: the mail is DRIVEN BY the calendar).
  //
  // The four steps it runs, unchanged and in the same order: drop the statuses a
  // client's calendar is not made of (drafts), pass the rest through the shared
  // client redaction boundary so future-dated content cannot cross before its
  // day, dedupe the duplicate DOCUMENTS the closed bulk-upload replay hole left
  // behind (keyed on the raw twins, since a redacted copy has no gcsPath), and
  // hand back the survivors. Deduped ONCE: the run cards ("drafted 8 posts") and
  // the runway badge read the same list, so a list still holding both copies
  // would print a deliverable twice and over-count the days filled through.
  const scopedAssets = inScope(assetsRaw);
  const assets = clientVisibleCalendarAssets(scopedAssets, {
    isClient,
    // eslint-disable-next-line react-hooks/purity -- server component, no re-render concern
    now: Date.now(),
    viewer: { role: user.role, seatId: user.seatId, isGroupAdmin: user.isGroupAdmin },
  });

  // Agent lookups: by id for scheduled runs, by name for past jobs (jobs store
  // the agent's name, not its id). These stay JOIN keys - what a card PRINTS
  // comes off the identity helper below, never off the stored name.
  const agentById = new Map(customAgents.map((a) => [a.id, a]));
  const agentByName = new Map(customAgents.map((a) => [a.name, a]));
  const clientById = new Map(clients.map((c) => [c.id, c]));

  // Whether a schedule row's agent is still one this client could fire today
  // - disabling an agent (setCustomAgentEnabledAction) or revoking it from a
  // client (setClientCustomAgentsAction) never touches the schedule row
  // itself, so without this a stale row keeps reading as active/paused
  // forever, and the calendar kept printing it (scheduled chips, or a
  // "Paused schedules" entry) long after the agent it belongs to was turned
  // off. Cosmetic-only lookups (agentById for name/icon/blurb) stay as they
  // are - this is the one place agent identity also gates visibility.
  const isAgentLiveForClient = (r: { customAgentId: string; clientId: string }): boolean => {
    const agent = agentById.get(r.customAgentId);
    const client = clientById.get(r.clientId);
    return Boolean(agent?.enabled) && Boolean(client?.customAgentIds?.includes(r.customAgentId));
  };

  // §7.3 identity (F147). The calendar is where Albert saw one stream named two
  // ways on the same day - a run row reading "Instagram Agent" stacked over a
  // post card reading "Social posts (IG/TikTok)". Both mappings below now name
  // their row through the one resolver, which maps a run onto the umbrella that
  // owns its content family. Stored `agentName` is untouched: it is the record
  // of what fired, and this is the display of who it belongs to.
  const NO_UMBRELLAS: ClientAgentIdentity[] = [];
  const umbrellasByClient = identitiesByClient(inScope(umbrellasRaw));
  const umbrellasFor = (clientId: string): ClientAgentIdentity[] =>
    umbrellasByClient.get(clientId) ?? NO_UMBRELLAS;
  // `description` here is the internal lab manifest and this array is serialized
  // into the payload the browser receives, rendered or not - so client viewers
  // get the written blurb, or the keyed fallback, never the manifest.
  const agentOptions: ScheduleAgentOption[] = customAgents
    .filter((a) => a.enabled)
    .map((a) => ({
      id: a.id,
      name: a.name,
      // Clients get the curated line, or the keyed fallback when none is
      // written yet (CD-G2) - never the lab manifest, and no longer an empty
      // string either, which is what they got before the fallback existed.
      description: isClient
        ? clientAgentBlurb({ key: a.key, name: a.name, clientBlurb: a.clientBlurb ?? null })
        : a.description,
      icon: a.icon,
      color: a.color,
    }));

  const assetsByJob = new Map<string, Asset[]>();
  for (const a of assets) {
    if (!a.jobId) continue;
    (assetsByJob.get(a.jobId) ?? assetsByJob.set(a.jobId, []).get(a.jobId)!).push(a);
  }

  // ── Scheduled (future) runs ─────────────────────────────────────────
  // eslint-disable-next-line react-hooks/purity -- server component, no re-render concern
  const scheduleNow = Date.now();
  // ACTIVE ONLY, and it stays that way: a paused schedule has no upcoming fires,
  // so projecting its occurrences would paint days it will not run — the exact
  // class of thing this surface is being fixed for. The cost is that pausing
  // deletes the row from this page's data outright, which unmounts the card that
  // did it. That is not a data problem to solve here; it is why the calendar
  // itself now carries the acknowledgement and the resume (PausedRunNotice in
  // components/run-calendar), rather than the card that disappears.
  /**
   * Paused schedules, carried to the calendar WITHOUT being projected.
   *
   * The filter below drops them from the day grid deliberately — painting days a
   * paused schedule will not run is the same class of lie the grid exists to
   * avoid. But dropping them from the PAGE is what made pausing a one-way door:
   * the AI agents page shows nothing for cadence "monthly" or "once"
   * (`weeklyFireDays` returns null and `toScheduleRows` drops the row), so those
   * two had no route back at all once the calendar forgot them. Identity and a
   * cadence label only; no occurrences.
   */
  const pausedSchedules = scheduledRuns
    .filter((r) => r.status === "paused" && isAgentLiveForClient(r))
    .map((r) => ({
      id: r.id,
      productName: agentById.get(r.customAgentId)?.name ?? r.agentName,
      // The SAME cadence vocabulary the active cards use — resolved here, per
      // viewer, because a client never reads `describeCadence`'s operator wording.
      cadenceLabel: isClient
        ? clientCadenceLabel({ ...r, timeZone: runZone(r.timeZone) })
        : describeCadence({ ...r, timeZone: runZone(r.timeZone) }),
      ...(single ? {} : { clientName: nameOf(r.clientId) }),
    }));

  const scheduledEntries: CalendarRun[] = scheduledRuns
    .filter((r) => r.status === "active" && isAgentLiveForClient(r))
    .flatMap((r) => {
      const agent = agentById.get(r.customAgentId);
      // Client-visible calendar: the lab manifest never ships here either.
      // It did. `clientBlurb || description` falls straight through to the
      // manifest for every agent whose blurb has not been written yet - which
      // is all of them until the backfill runs - so "Master content-social
      // skill…" was reaching clients on this surface today (CD-G2).
      const blurb = isClient
        ? clientAgentBlurb({
            key: agent?.key ?? "",
            name: agent?.name ?? r.agentName,
            clientBlurb: agent?.clientBlurb ?? null,
          })
        : agent?.clientBlurb?.trim() || agent?.description;
      // A recurring cadence (e.g. "weekly · Mon-Fri") fires many times - project
      // every upcoming occurrence within the horizon instead of only the single
      // next fire, so a 5x/week schedule shows 5 chips a week, not 1. Projected
      // in the SCHEDULE's zone, not the container's: only the first occurrence
      // comes from the stored cursor, so on a UTC server every later chip of a
      // Sao Paulo 09:00 run would slide to 06:00, and a Tokyo 22:00 run would
      // land on the previous day - putting a weekday-only run on a weekend
      // (F108).
      //
      // Computed off the RAW stored nextRunAt, before projectRunOccurrences
      // fast-forwards it - a schedule whose cursor is already behind "now"
      // hasn't fired when it should have (the cron missed it, or it's been
      // failing before it can advance). Every projected occurrence for this
      // row carries the resolved copy so the card can say so instead of
      // quietly showing "Upcoming · next 9:00 AM" for a time that has already
      // passed. Resolved HERE, not at render: a client reads a professional,
      // reassuring line with no internal vocabulary ("cron", "Jobs page",
      // "stuck"); staff get the operational detail, same split this file
      // already applies to `lastError` via clientSafeRefusal below.
      const schedulePlatform = scheduleRowPlatform(r, umbrellasFor(r.clientId));
      const stuck = r.nextRunAt < scheduleNow;
      const stuckLabel = stuck ? (isClient ? "Delayed" : "Stuck") : undefined;
      const stuckMessage = stuck
        ? isClient
          ? "This run hasn't started yet. Your Karos team can look into it."
          : `This was expected to fire and hasn't. The schedule looks stuck.${
              r.lastError || r.lastRunAt
                ? " See its last fire below."
                : " It has no recorded fire at all yet; check the Jobs page for what's blocking it."
            }`
        : undefined;
      return projectRunOccurrences(r, {
        from: scheduleNow,
        timeZone: runZone(r.timeZone),
      }).map((at) => ({
        id: r.id,
        kind: "scheduled" as const,
        clientId: r.clientId,
        clientName: single ? undefined : nameOf(r.clientId),
        at,
        // F147: the chip is named by the umbrella the client actually knows
        // ("Instagram Agent"), not the lab agent's own row name. One identity
        // for the same thing across calendar, agents page and dashboard.
        productName: scheduleRowLabel(r, umbrellasFor(r.clientId)),
        productColor: r.agentColor,
        productIcon: r.agentIcon,
        // AF-20: the platform this schedule's posts will target, shipped as a
        // TOKEN. The umbrella row it was read from never crosses the boundary —
        // same rule the stuck copy and the refusal text on this row already
        // follow (redaction happens server-side, at the projection, never at
        // render). Resolved once per ROW, not per occurrence: a weekday
        // schedule projects five chips a week and they are all the same agent.
        ...(schedulePlatform ? { platform: schedulePlatform } : {}),
        cadence: r.cadence,
        // Pace for a client, mechanics for staff. describeCadence prints "3×
        // weekly", which names RUNS - and on a schedule storing several outputs
        // per fire that number is not the client's post count at all. Same
        // vocabulary AgentScheduleModal's paceOnly branch settled on.
        cadenceLabel: isClient
          ? clientCadenceLabel({ ...r, timeZone: runZone(r.timeZone) })
          : describeCadence({ ...r, timeZone: runZone(r.timeZone) }),
        // The zone the schedule's wall clock was set in. PRINTED, NOT BUCKETED:
        // `dayKey` takes one argument now, so the day a chip lands in comes from
        // the VIEWER's clock — one calendar, one definition of a day — and this
        // zone reaches only `timeStr` and `zoneLabel`, which is how a reader can
        // still see the wall clock the schedule was actually set in.
        //
        // This sentence used to say the bucket was computed from it "exactly as
        // on the server", and both halves stopped being true with that change.
        // It is the THIRD copy of the claim; the other two were retired with the
        // fix and this one, 280 lines below the first in the same file, was not.
        // The residual is in `dayKey`'s own docstring: server and browser can
        // now disagree about the day, and that is the trade the consolidation
        // makes deliberately.
        timeZone: runZone(r.timeZone),
        // Per OCCURRENCE, not per row: a projection that crosses a DST boundary
        // prints the offset in force on that day.
        zoneLabel: shortZoneLabel(runZone(r.timeZone), at),
        ...(stuckLabel ? { stuckLabel, stuckMessage: stuckMessage! } : {}),
        // The schedule's standing instruction is staff-authored direction -
        // run-calendar paints it under "Will run", so a client would read the
        // internal brief verbatim. Same shape as staffRef below (delta-lens).
        ...(isClient ? {} : { prompt: r.prompt }),
        ...(blurb ? { agentDescription: blurb } : {}),
        // The schedule's own track record (§ "Last fire" on the card) - the
        // ONLY signal a future-projection card can show about whether the
        // schedule has actually been firing, since it has no job of its own.
        // Same redaction `toScheduleRows` already applies to this same field
        // on the AI agents page: staff get the raw refusal, a client gets the
        // safe paraphrase (never the internal provider/credit/service detail).
        //
        // `lastRunAt` GOES TO BOTH VIEWERS, and must: the card prints it as "Ran
        // <n> ago" for staff and as a date-free "This schedule has run before"
        // for a client, which is the substitute rule 3 of lib/calendar-past-runs
        // depends on (a client's in-flight and all-locked runs have no past-run
        // card at all). A3 objects to the batch INSTANT reaching a client, and
        // that is the render gate's job in ScheduledRunCard — gating the field
        // here instead would blank the client's line and take the substitute with
        // it. `lastJobId` is the one that is genuinely staff-only, because
        // /jobs/[id] is staff-guarded and would just redirect a client away.
        ...(r.lastRunAt ? { lastRunAt: r.lastRunAt } : {}),
        ...(isClient ? {} : r.lastJobId ? { lastJobId: r.lastJobId } : {}),
        ...(r.lastError
          ? {
              lastError: isClient ? clientSafeRefusal(r.lastError) : r.lastError,
              ...(r.lastErrorAt ? { lastErrorAt: r.lastErrorAt } : {}),
            }
          : {}),
      }));
    });

  // ── Past (completed) runs ───────────────────────────────────────────
  // WHICH runs reach this viewer, and which of each run's deliverables it may
  // be told about, is one rule with one home: lib/calendar-past-runs. Read that
  // module before changing what a client sees here — the run card asks it again
  // at render for the review control, so an answer changed only on this side
  // splits back into the two that contradicted each other (F80).
  //
  // The agent filter stays here: it says which jobs the calendar draws runs
  // from at all, which is a fact about this page's source, not about the viewer.
  const pastEntries: CalendarRun[] = projectPastRuns(
    jobs.filter((j) => j.agentId === "agent-service"),
    assetsByJob,
    {
      isClient,
      // AF-9. Rule 3's in-flight exception needs to know whose press it is
      // looking at: a client watches THEIR OWN run execute, and a scheduled fire
      // stays invisible (see viewerIsWatchingOwnRun). Passed for staff too and
      // simply never consulted — their cards are not dropped in the first place.
      viewerUid: user.uid,
      // The card's view of one deliverable, built INSIDE the projection so the
      // list it guarantees non-empty for a client is literally the list this row
      // ships as `assets` — no parallel array here to keep in step with it.
      //
      // Sanitized here, at the server boundary, not at render: slicing raw
      // content shipped the run record's own bookkeeping - markdown syntax, the
      // internal status word, the lab product code and the job hash - into the
      // payload of the panel a client opens to see what ran.
      project: (a): RunAssetView => ({
        id: a.id,
        type: a.type,
        title: cleanTitle(a.title),
        textPreview: toPlainSummary(a.content, 240),
        images: assetImages(a),
      }),
    },
  ).map(({ job: j, deliveredAssets: views }) => {
    const agent = agentByName.get(j.agentName);
    const runPlatform = runRowPlatform(j, umbrellasFor(j.clientId));
    return {
      id: j.id,
      kind: "past" as const,
      clientId: j.clientId,
      clientName: single ? undefined : nameOf(j.clientId),
      at: j.createdAt,
      // The job alone, deliberately — not its assets. This card IS the run,
      // so its fallback rung must stay the run's own recorded name; feeding
      // the deliverables in would let an asset-derived label outrank it.
      // The family rule still fires from the job's own `external.taskType`,
      // which is what a managed "Social posts (IG/TikTok)" run carries.
      productName: runRowLabel(j, umbrellasFor(j.clientId)),
      productColor: agent?.color ?? "#FF6B2C",
      productIcon: agent?.icon ?? "Bot",
      // AF-20, asked of the JOB alone for the same reason the label above is:
      // this card IS the run, so feeding its deliverables in would let one
      // asset's booked channel speak for a run that produced several.
      ...(runPlatform ? { platform: runPlatform } : {}),
      jobStatus: j.status,
      // Counts the views above, so for a client it counts what they have been
      // given at this moment and not their locked upcoming slots. Read rule 2 in
      // lib/calendar-past-runs for how far that goes — it suppresses a batch's
      // count while the batch is future-dated and does not survive the week.
      ...(describeRunOutput(views) ? { outputSummary: describeRunOutput(views) } : {}),
      // Job id is staff bookkeeping: a tooltip for them, absent for clients.
      ...(isClient ? {} : { staffRef: `Job ${j.id}${agent ? ` · agent ${agent.id}` : ""}` }),
      assets: views,
      images: views.flatMap((v) => v.images),
    };
  });

  const runs = [...scheduledEntries, ...pastEntries];

  // ── Post publish events (auto-placed + manually scheduled + published) ──
  // A CalendarPost still carries no agent LINE — no name, no blurb, nothing
  // that would re-open the F147 double identity this surface was cleaned of.
  //
  // It does now take an identity CALL, which is the case that note anticipated
  // ("give a post an agent line later and it takes the same call"), and it
  // takes it for the platform rather than for a name: AF-20 says every calendar
  // item shows where its content is going, and the umbrella is the rung that
  // answers for a placeholder post with no booked channel yet. What crosses the
  // boundary is one token — "instagram" — and the resolver's rungs are ordered
  // so the asset's own booked channel outranks the agent that produced it.
  //
  // `assets` is already one document per post — see the dedupe above.
  const posts: CalendarPost[] = assets
    .map((a): CalendarPost | null => {
      const kind = postKind(a);
      if (!kind) return null;
      const at = kind === "published" ? (a.publishedAt ?? a.scheduledAt!) : a.scheduledAt!;
      const platform = assetRowPlatform(a, umbrellasFor(a.clientId));
      return {
        assetId: a.id,
        clientId: a.clientId,
        clientName: single ? undefined : nameOf(a.clientId),
        title: cleanTitle(a.title),
        at,
        kind,
        ...(platform ? { platform } : {}),
        images: assetImages(a),
        // Same leak class as the run cards above - same treatment.
        textPreview: toPlainSummary(a.content, 160),
        // Deliberately un-branched, unlike `lastError` above: for a client this
        // field was already replaced by the getClientLibraryAssets projection
        // near the top of this file, which is the only place that CAN fix it —
        // `assets` is handed to RunCalendar whole for its detail modal, so a
        // branch here would have left the exception in the same payload. Staff
        // read the asset un-projected and keep the raw error. One rule, one
        // place (lib/custom-agent-launch clientSafePublishError).
        //
        // "held" travels too, and it is the one whose text a client is MEANT to
        // read: it is the ordering-hold sentence, written as client copy and the
        // only publishError the sanitizer passes through verbatim. Both kinds are
        // exactly the ones postKind derives FROM this field, so the condition is
        // the field's own, not a second list of kinds to keep in step.
        ...(a.publishError && (kind === "failed" || kind === "held")
          ? { publishError: a.publishError }
          : {}),
      };
    })
    .filter((p): p is CalendarPost => p != null);

  // ── Manual push ("Publish Now") - staff only ────────────────────────
  // The approve panel's "Manual push" tier tells the user they push the post
  // live from the calendar, so the calendar's detail panel needs the control.
  // publishAssetNowAction is requireStaff(), so this is built ONLY for staff -
  // a client viewer's payload gains nothing. Integrations are read for the
  // clients that actually own a pushable post, not for every client in scope.
  //
  // The predicate itself lives in lib/publish-targets.ts, which exists so "is
  // this post pushable" cannot drift between the surfaces that ask it. This
  // file had kept a byte-identical copy of that function's body inline - three
  // status/mode/platform conditions and the integration read - which is the
  // second answer the shared module was extracted to prevent.
  const connectedPlatformsByClient = isClient
    ? undefined
    : await pushablePlatformsByClient(assets);

  // ── Empty state ─────────────────────────────────────────────────────
  // A month of blank squares under a header promising "what your agents will
  // run" is a dead end: clicking a day does nothing, and nothing says where
  // schedules come from. Clients CAN set one up - one item up the same rail -
  // via configureClientAgentScheduleAction, so this hands off rather than
  // apologising.
  const scopedClientId = singleFilter?.clientId;
  const isEmpty = runs.length + posts.length === 0;

  // Runway indicator (staff single-client scope only - the client's own view
  // hides internal drafts, which would understate the backlog). Reuses the same
  // pure calculator the top-up cron runs, so the badge and the autopilot agree.
  let runwayBadge: ReactNode = null;
  if (single && !isClient) {
    // eslint-disable-next-line react-hooks/purity -- server component, no re-render concern
    const now = Date.now();
    const runway = computeRunway(assets, [], now, undefined, scopedClient?.dailyPace);
    if (runway.activeFamilies.length > 0) {
      const fmt = (ms: number) => new Date(ms).toLocaleDateString(undefined, { month: "short", day: "numeric" });
      if (runway.coveredThroughMs == null) {
        runwayBadge = <Badge tone="danger">No runway. Calendar is empty ahead</Badge>;
      } else if (runway.coveredThroughMs < runway.horizonThroughMs) {
        runwayBadge = <Badge tone="warning">Short runway. Filled through {fmt(runway.coveredThroughMs)}</Badge>;
      } else {
        runwayBadge = <Badge tone="success">Runway: filled through {fmt(runway.coveredThroughMs)}</Badge>;
      }
    }
  }

  // A run fired by a cron/background worker (scheduled fire, task-engine
  // dispatch) has no tab open to react to its own completion - the calendar
  // is a server component, so without this it would sit on "queued"/"running"
  // until someone happens to reload. Mounted only while something is actually
  // in flight, same convention as the Agents page's AutoRefresh.
  const runInFlight = jobs.some((j) => j.status === "queued" || j.status === "running");

  return (
    <>
      {runInFlight && <AutoRefresh />}
      <PageHeader title={title} description={description} action={runwayBadge} />
      {isEmpty && scopedClientId && (
        <div className="mb-4">
          <EmptyState
            icon={<Icon name="CalendarClock" className="h-7 w-7" />}
            title="No runs on the calendar yet"
            description="Schedules are set on the AI agents page. Once an agent has one, its runs and everything they produce show up here."
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
        // Whose vocabulary the detail modal uses. `isClient` and not
        // `!canSchedule`: staff in View as Client keep the staff register, which
        // is the split every other viewer-worded surface on this page already
        // makes (the stuck label, the cadence label, the refusal text).
        viewerIsClient={isClient}
        canSchedule={canSchedule}
        // Pausing is not a staff privilege - a client owns their own schedules
        // and the server action already authorizes them. Deleting stays behind
        // canSchedule.
        canManageRuns
        pausedSchedules={pausedSchedules}

        clients={clientOptions}
        agents={agentOptions}
        {...(connectedPlatformsByClient ? { connectedPlatformsByClient } : {})}
        defaultClientId={defaultClientId}
      />
    </>
  );
}
