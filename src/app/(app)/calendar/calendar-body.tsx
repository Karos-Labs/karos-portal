import Link from "next/link";
import {
  listAssets,
  listClients,
  listCustomAgents,
  listJobs,
  listPlannedScheduledRuns,
} from "@/lib/data";
import { listClientAgents } from "@/lib/data-client-agents";
import { assetImages } from "@/lib/asset-images";
import { getClientLibraryAssets } from "@/lib/asset-visibility";
import {
  identitiesByClient,
  runRowLabel,
  scheduleRowLabel,
  type ClientAgentIdentity,
} from "@/lib/agent-identity-map";
import { stripInlineMarkdown, toPlainSummary } from "@/lib/doc-render";
import { isClientCalendarStatus, postKind } from "@/lib/calendar-kind";
import { projectPastRuns } from "@/lib/calendar-past-runs";
import { dedupeCalendarAssets } from "@/lib/calendar-dedupe";
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
import {
  RunCalendar,
  type CalendarClientOption,
  type CalendarPost,
  type CalendarRun,
  type RunAssetView,
  type ScheduleAgentOption,
} from "@/components/run-calendar";
import type { ReactNode } from "react";
import type { Asset, AppUser, AssetType } from "@/lib/types";

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

/**
 * The zone a scheduled run's wall clock actually means (CD-H7c).
 *
 * The run card printed "…09:00 · next 11:00 AM": describeCadence renders the
 * STORED hour, while the next-run time was formatted in whatever zone the
 * renderer happened to be in — two clocks, neither labelled, disagreeing by the
 * offset between them. A row written before `timeZone` existed had its
 * nextRunAt computed against the runtime's own zone (see the timezone contract
 * in lib/scheduled-runs), so that is the zone its hour was always expressed in.
 * Resolving it here means both halves of the line, the day bucket and the
 * printed zone suffix all come off the same clock, and a row WITH a stored zone
 * is unaffected.
 */
const RUNTIME_ZONE = Intl.DateTimeFormat().resolvedOptions().timeZone;

function runZone(stored: string | undefined): string {
  return isValidTimeZone(stored) ? stored : RUNTIME_ZONE;
}

/** Titles come straight from the agent — a leading `#` or `**` is not a title. */
function cleanTitle(title: string): string {
  return stripInlineMarkdown(title.replace(/^#{1,6}\s+/, "")) || title;
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
      title = `${viewClient.name} — Calendar`;
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
  const [runsRaw, jobsRaw, assetsRaw, customAgents, umbrellasRaw] = await Promise.all([
    listPlannedScheduledRuns(singleFilter),
    listJobs(singleFilter),
    listAssets(singleFilter),
    listCustomAgents(),
    // §7.3. One scoped read for the whole page — the cross-client overview
    // labels rows of many clients, and a per-row umbrella query would be one
    // Firestore read per printed card.
    listClientAgents(singleFilter),
  ]);
  const inScope = <T extends { clientId: string }>(arr: T[]): T[] =>
    idSet ? arr.filter((x) => idSet!.has(x.clientId)) : arr;

  const scheduledRuns = inScope(runsRaw);
  const jobs = inScope(jobsRaw);
  // Clients never see internal drafts (matches /assets). Future scheduled
  // deliverables also pass through the shared redaction boundary so the
  // calendar cannot expose their content, images, or download controls before
  // the scheduled day. Staff continue to receive the full assets for review.
  //
  // The draft rule itself lives with the classifier (isClientCalendarStatus),
  // because the legend has to know it too: a chip for a status this filter drops
  // is a filter a client can never make dim anything.
  const scopedAssets = inScope(assetsRaw).filter((a) => !isClient || isClientCalendarStatus(a.status));
  const visibleAssets = isClient
    ? getClientLibraryAssets(scopedAssets, { forClient: true })
    : scopedAssets;

  // Duplicate DOCUMENTS become duplicate CELLS, because the posts map below is
  // 1:1 and run-calendar just buckets what it gets by day. The bulk-upload
  // replay hole that minted them is closed on the write side now, but the
  // documents it already wrote are still in Firestore and no cleanup has run —
  // so the calendar defends itself here (lib/calendar-dedupe). Nothing is
  // deleted and nothing is counted: the client simply sees one cell per post,
  // with no hint that a second copy existed.
  //
  // Deduped ONCE, here, and every reader downstream takes the result. The run
  // cards ("drafted 8 posts") and the runway badge read the same assets, so a
  // list still holding both copies would print a deliverable twice on a past-run
  // card and over-count the days the calendar is filled through.
  //
  // Grouped on the UNREDACTED assets, then rendered from the visible copies. A
  // client's future-dated posts reach `visibleAssets` as placeholders whose meta
  // is stripped to `{locked}`, so keying off those would compare two blanks —
  // the gcsPath the whole decision rests on would be gone. Mapping each visible
  // asset back to its own pre-redaction twin keys the decision on the real path
  // and the real dates. Only the survivors' ids come back out; no redacted field
  // is bypassed. For staff `visibleAssets` IS `scopedAssets`, so this is a
  // straight pass.
  const rawById = new Map(scopedAssets.map((a) => [a.id, a]));
  const survivorIds = new Set(
    dedupeCalendarAssets(visibleAssets.map((a) => rawById.get(a.id) ?? a)).map((a) => a.id),
  );
  const assets = visibleAssets.filter((a) => survivorIds.has(a.id));

  // Agent lookups: by id for scheduled runs, by name for past jobs (jobs store
  // the agent's name, not its id). These stay JOIN keys — what a card PRINTS
  // comes off the identity helper below, never off the stored name.
  const agentById = new Map(customAgents.map((a) => [a.id, a]));
  const agentByName = new Map(customAgents.map((a) => [a.name, a]));

  // §7.3 identity (F147). The calendar is where Albert saw one stream named two
  // ways on the same day — a run row reading "Instagram Agent" stacked over a
  // post card reading "Social posts (IG/TikTok)". Both mappings below now name
  // their row through the one resolver, which maps a run onto the umbrella that
  // owns its content family. Stored `agentName` is untouched: it is the record
  // of what fired, and this is the display of who it belongs to.
  const NO_UMBRELLAS: ClientAgentIdentity[] = [];
  const umbrellasByClient = identitiesByClient(inScope(umbrellasRaw));
  const umbrellasFor = (clientId: string): ClientAgentIdentity[] =>
    umbrellasByClient.get(clientId) ?? NO_UMBRELLAS;
  // `description` here is the internal lab manifest and this array is serialized
  // into the payload the browser receives, rendered or not — so client viewers
  // get the written blurb, or the keyed fallback, never the manifest.
  const agentOptions: ScheduleAgentOption[] = customAgents
    .filter((a) => a.enabled)
    .map((a) => ({
      id: a.id,
      name: a.name,
      // Clients get the curated line, or the keyed fallback when none is
      // written yet (CD-G2) — never the lab manifest, and no longer an empty
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
   * the AI Agents page shows nothing for cadence "monthly" or "once"
   * (`weeklyFireDays` returns null and `toScheduleRows` drops the row), so those
   * two had no route back at all once the calendar forgot them. Identity and a
   * cadence label only; no occurrences.
   */
  const pausedSchedules = scheduledRuns
    .filter((r) => r.status === "paused")
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
    .filter((r) => r.status === "active")
    .flatMap((r) => {
      const agent = agentById.get(r.customAgentId);
      // Client-visible calendar: the lab manifest never ships here either.
      // It did. `clientBlurb || description` falls straight through to the
      // manifest for every agent whose blurb has not been written yet — which
      // is all of them until the backfill runs — so "Master content-social
      // skill…" was reaching clients on this surface today (CD-G2).
      const blurb = isClient
        ? clientAgentBlurb({
            key: agent?.key ?? "",
            name: agent?.name ?? r.agentName,
            clientBlurb: agent?.clientBlurb ?? null,
          })
        : agent?.clientBlurb?.trim() || agent?.description;
      // A recurring cadence (e.g. "weekly · Mon-Fri") fires many times — project
      // every upcoming occurrence within the horizon instead of only the single
      // next fire, so a 5x/week schedule shows 5 chips a week, not 1. Projected
      // in the SCHEDULE's zone, not the container's: only the first occurrence
      // comes from the stored cursor, so on a UTC server every later chip of a
      // Sao Paulo 09:00 run would slide to 06:00, and a Tokyo 22:00 run would
      // land on the previous day — putting a weekday-only run on a weekend
      // (F108).
      //
      // Computed off the RAW stored nextRunAt, before projectRunOccurrences
      // fast-forwards it — a schedule whose cursor is already behind "now"
      // hasn't fired when it should have (the cron missed it, or it's been
      // failing before it can advance). Every projected occurrence for this
      // row carries the resolved copy so the card can say so instead of
      // quietly showing "Upcoming · next 9:00 AM" for a time that has already
      // passed. Resolved HERE, not at render: a client reads a professional,
      // reassuring line with no internal vocabulary ("cron", "Jobs page",
      // "stuck"); staff get the operational detail, same split this file
      // already applies to `lastError` via clientSafeRefusal below.
      const stuck = r.nextRunAt < scheduleNow;
      const stuckLabel = stuck ? (isClient ? "Delayed" : "Stuck") : undefined;
      const stuckMessage = stuck
        ? isClient
          ? "This run hasn't started yet — your Karos team can look into it."
          : `This was expected to fire and hasn't — the schedule looks stuck.${
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
        cadence: r.cadence,
        // Pace for a client, mechanics for staff. describeCadence prints "3×
        // weekly", which names RUNS — and on a schedule storing several outputs
        // per fire that number is not the client's post count at all. Same
        // vocabulary AgentScheduleModal's paceOnly branch settled on.
        cadenceLabel: isClient
          ? clientCadenceLabel({ ...r, timeZone: runZone(r.timeZone) })
          : describeCadence({ ...r, timeZone: runZone(r.timeZone) }),
        // The zone the schedule's wall clock was set in. Sent to the browser so
        // the chip's day bucket and printed time are computed there exactly as
        // they were on the server — and so the card's cadence label and its
        // "next" time are read off ONE clock (CD-H7c).
        timeZone: runZone(r.timeZone),
        // Per OCCURRENCE, not per row: a projection that crosses a DST boundary
        // prints the offset in force on that day.
        zoneLabel: shortZoneLabel(runZone(r.timeZone), at),
        ...(stuckLabel ? { stuckLabel, stuckMessage: stuckMessage! } : {}),
        // The schedule's standing instruction is staff-authored direction —
        // run-calendar paints it under "Will run", so a client would read the
        // internal brief verbatim. Same shape as staffRef below (delta-lens).
        ...(isClient ? {} : { prompt: r.prompt }),
        ...(blurb ? { agentDescription: blurb } : {}),
        // The schedule's own track record (§ "Last fire" on the card) — the
        // ONLY signal a future-projection card can show about whether the
        // schedule has actually been firing, since it has no job of its own.
        // Same redaction `toScheduleRows` already applies to this same field
        // on the AI Agents page: staff get the raw refusal, a client gets the
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
      // The card's view of one deliverable, built INSIDE the projection so the
      // list it guarantees non-empty for a client is literally the list this row
      // ships as `assets` — no parallel array here to keep in step with it.
      //
      // Sanitized here, at the server boundary, not at render: slicing raw
      // content shipped the run record's own bookkeeping — markdown syntax, the
      // internal status word, the lab product code and the job hash — into the
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
  // No identity call here on purpose: a CalendarPost carries a title, a day and
  // a kind, and names no agent at all. F147's second name entered this surface
  // through the RUN cards above, which is where the resolver belongs. Give a
  // post an agent line later and it takes the same call.
  //
  // `assets` is already one document per post — see the dedupe above.
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

  // ── Manual push ("Publish Now") — staff only ────────────────────────
  // The approve panel's "Manual push" tier tells the user they push the post
  // live from the calendar, so the calendar's detail panel needs the control.
  // publishAssetNowAction is requireStaff(), so this is built ONLY for staff —
  // a client viewer's payload gains nothing. Integrations are read for the
  // clients that actually own a pushable post, not for every client in scope.
  //
  // The predicate itself lives in lib/publish-targets.ts, which exists so "is
  // this post pushable" cannot drift between the surfaces that ask it. This
  // file had kept a byte-identical copy of that function's body inline — three
  // status/mode/platform conditions and the integration read — which is the
  // second answer the shared module was extracted to prevent.
  const connectedPlatformsByClient = isClient
    ? undefined
    : await pushablePlatformsByClient(assets);

  // ── Empty state ─────────────────────────────────────────────────────
  // A month of blank squares under a header promising "what your agents will
  // run" is a dead end: clicking a day does nothing, and nothing says where
  // schedules come from. Clients CAN set one up — one item up the same rail —
  // via configureClientAgentScheduleAction, so this hands off rather than
  // apologising.
  const scopedClientId = singleFilter?.clientId;
  const isEmpty = runs.length + posts.length === 0;

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
        // Whose vocabulary the detail modal uses. `isClient` and not
        // `!canSchedule`: staff in View as Client keep the staff register, which
        // is the split every other viewer-worded surface on this page already
        // makes (the stuck label, the cadence label, the refusal text).
        viewerIsClient={isClient}
        canSchedule={canSchedule}
        // Pausing is not a staff privilege — a client owns their own schedules
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
