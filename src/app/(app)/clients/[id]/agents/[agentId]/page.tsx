import Link from "next/link";
import { notFound, redirect } from "next/navigation";
import { requireUser, requireVisibleClient } from "@/lib/auth";
import {
  getClientCredits,
  getCustomAgent,
  listAssets,
  listClientIntegrations,
  listContextItems,
  listJobs,
  listPlannedScheduledRuns,
} from "@/lib/data";
import { availableCredits, creditBlockReason, CREDIT_COSTS, isBillableClientActor } from "@/lib/credits";
import { Badge, EmptyState, PageHeader } from "@/components/ui";
import { Icon } from "@/components/icon";
import { AgentIdentity } from "@/components/agent-identity";
import { AutoRefresh } from "@/components/auto-refresh";
import { isAgentServiceConfigured } from "@/lib/agent-service/client";
import { clientAgentBlurb } from "@/lib/agent-blurbs";
import { selectAgentSchedule } from "@/lib/agent-schedule-selection";
import { listClientAgents } from "@/lib/data-client-agents";
import { isLaunchInFlight, lastRunFailedAgentIds, rosterStatus } from "@/lib/client-agents";
import { sanitizeIntegrations } from "@/lib/integrations/sanitize";
import { integrationNeedsReconnect } from "@/lib/integration-status";
import { platformLabel } from "@/lib/integrations/platforms";
import { ClientAgentLaunchCard } from "@/components/client-agents/launch-card";
import { AgentDetailPanel } from "@/components/client-agents/agent-detail-panel";
import { LegacyAgentPanel, SchedulePaceCard } from "@/components/client-agents/legacy-agent-panel";
import { AgentArchiveRows } from "@/components/client-agents/agent-archive-rows";
import { clientArchiveLink } from "@/lib/agent-intake-links";
import { ClipGallery } from "@/components/client-agents/clip-gallery";
import { DailyFinderPanel } from "@/components/client-agents/daily-finder-panel";
import {
  FinderIntakeCard,
  SourceMaterialCard,
  type SourceFile,
} from "@/components/client-agents/archetype-cards";
import { evaluateLegacyRunGate } from "@/lib/client-agent-runs";
import { agentArchetype } from "@/lib/agent-archetype";
import {
  agentProducedAssets,
  agentsWithDeliveredWork,
  agentsWithUpcomingContent,
  buildClipMakerView,
  buildDailyFinderView,
  deliverableStamp,
  templateDetails,
  umbrellaForAgent,
} from "@/lib/agent-detail-archetypes";
import {
  agentInputsView,
  buildAgentSetupFacts,
  intakeFamilyFor,
  readAgentInputDocs,
} from "@/lib/agent-detail-sections";
import {
  AgentInputsSection,
  AgentSetupSection,
  AgentStatusStrip,
} from "@/components/client-agents/agent-sections";
import {
  buildBlogAgentIntakeView,
  buildCarouselAgentIntakeView,
  buildLinkedInAgentIntakeView,
  buildNewsletterAgentIntakeView,
  buildRedditAgentIntakeView,
  buildReputationAgentIntakeView,
  buildXAgentIntakeView,
} from "@/lib/agent-intake-views";
import {
  agentKeyMatchesClientSlug,
  defaultRunBatchSize,
  isBlogAgentIdentity,
  isCarouselAgentIdentity,
  isLinkedInAgentIdentity,
  isNewsletterAgentIdentity,
  isRedditAgentIdentity,
  isReputationAgentIdentity,
  isXAgentIdentity,
  launchProfileFor,
} from "@/lib/custom-agent-launch";
import { summarizeAgentEconomics } from "@/lib/credit-reporting";
import { ControlRoom } from "@/components/client-agents/control-room";
import { CurationPane } from "@/components/client-agents/client-agents-section";
import { deriveAgentHealth } from "@/lib/agent-health";
import { nextRunCountdown } from "@/lib/scheduled-runs";
import {
  buildAgentSetup,
  type AgentIntakePanes,
  scheduleZonesByAgent,
  toClientAgentRows,
  toRunRows,
  toScheduleRows,
  toSummary,
} from "@/lib/client-agent-rows";
import type { Job } from "@/lib/types";

/**
 * The inline intake form for THIS agent, when it is one of the three that draft
 * from stored intake (X e13, LinkedIn e10, Reddit e15).
 *
 * Moved here from the roster page with CD-I1's staff parity. Ruling 7 put the
 * panes on whichever surface owns the run DIALOG, and that surface is now this
 * one - so the roster stopped paying for them and this page builds exactly one,
 * for the agent it is about, instead of three for every agent on a list.
 *
 * Only the FORMS are built here. `ready` is not re-derived alongside them:
 * buildAgentSetup answers it with the very calls the submit cores gate on, and
 * two independent answers to "is this set up" is the drift that lets a control
 * offer a run the server refuses.
 */
async function agentIntakePane(
  clientId: string,
  agent: { key: string },
  opts: { isStaff: boolean; jobs: Job[]; linkedinPageUrl?: string },
): Promise<AgentIntakePanes> {
  if (isXAgentIdentity(agent.key)) {
    return { x: await buildXAgentIntakeView(clientId, { isStaff: opts.isStaff, jobs: opts.jobs }) };
  }
  if (isLinkedInAgentIdentity(agent.key)) {
    return {
      linkedin: await buildLinkedInAgentIntakeView(clientId, {
        isStaff: opts.isStaff,
        jobs: opts.jobs,
        ...(opts.linkedinPageUrl ? { pageUrlSuggestion: opts.linkedinPageUrl } : {}),
      }),
    };
  }
  if (isRedditAgentIdentity(agent.key)) {
    return {
      reddit: await buildRedditAgentIntakeView(clientId, {
        isStaff: opts.isStaff,
        jobs: opts.jobs,
      }),
    };
  }
  if (isNewsletterAgentIdentity(agent.key)) {
    return {
      newsletter: await buildNewsletterAgentIntakeView(clientId, {
        isStaff: opts.isStaff,
        jobs: opts.jobs,
      }),
    };
  }
  if (isBlogAgentIdentity(agent.key)) {
    return {
      blog: await buildBlogAgentIntakeView(clientId, {
        isStaff: opts.isStaff,
        jobs: opts.jobs,
      }),
    };
  }
  if (isReputationAgentIdentity(agent.key)) {
    return {
      reputation: await buildReputationAgentIntakeView(clientId, {
        isStaff: opts.isStaff,
        jobs: opts.jobs,
      }),
    };
  }
  if (isCarouselAgentIdentity(agent.key)) {
    return {
      carousel: await buildCarouselAgentIntakeView(clientId, {
        isStaff: opts.isStaff,
        jobs: opts.jobs,
      }),
    };
  }
  return {};
}

/**
 * One agent's home page (CD-G1).
 *
 * Albert: "they can just click on it, and then it opens… over the whole page.
 * That whole page should be like the Instagram Agent." The roster answers "is
 * this working for me"; this page answers everything else - what the agent
 * produces, whether it is live, the formats it writes, how to make a post now,
 * how to steer it, what it has already delivered, what data and connections it
 * runs on.
 *
 * REDACTION HAPPENS HERE, at the RSC boundary, never at render. Every field
 * below is serialized into the payload the browser receives, so a raw internal
 * string handed to a client component is readable whether or not it is ever
 * painted. That is why the row projection is shared with the roster
 * (client-agent-rows.ts) rather than rebuilt: one place decides what a client
 * viewer may receive about an agent, and both routes go through it.
 *
 * The launch states (§7.1 states 1–3) render as this page's HERO for a
 * non-live umbrella. The roster card upstream shows only the status word -
 * a CTA, a progress narration and a failure with a Contact-us row are all
 * explanations, and explanations belong on the page you opened to get them.
 */
export default async function ClientAgentDetailPage({
  params,
  searchParams,
}: {
  params: Promise<{ id: string; agentId: string }>;
  /** `asset` - Copilot chat's staff deep link, lands on Control Room's Outputs
   *  tab with this asset pre-opened (OutputsHub/ControlRoom). Staff-only: a
   *  CLIENT_USER never receives this param (their side has no Control Room). */
  searchParams: Promise<{ asset?: string }>;
}) {
  const user = await requireUser();
  const { id, agentId } = await params;
  const { asset: deepLinkAssetId } = await searchParams;

  if (user.role === "CLIENT_USER") {
    if (user.clientId !== id) redirect(user.clientId ? `/clients/${user.clientId}` : "/assets");
  } else if (user.role !== "KAROS_ADMIN" && user.role !== "KAROS_EMPLOYEE") {
    redirect("/dashboard");
  }

  const client = await requireVisibleClient(user, id);

  const isStaff = user.role === "KAROS_ADMIN" || user.role === "KAROS_EMPLOYEE";
  const viewerIsClient = !isStaff;

  const agent = await getCustomAgent(agentId);
  if (!agent || !agent.enabled) notFound();

  // THE BINDING, on the surface that resolves the pair — not only on the three
  // that LIST it. A per-client agent instance runs an entry skill baked under
  // one client's lab folder (see agentKeyMatchesClientSlug), and the roster, the
  // settings page and the delivered-work read all drop an instance belonging to
  // another client. This route did not: `/clients/A/agents/<instance-of-B>`
  // resolved, and rendered A's status strip, setup facts, intake panes, schedule
  // controls and run gesture around an agent that can only ever draft for B. The
  // submit core refuses the pair at run time, so nothing wrong could be
  // GENERATED — what shipped was a page telling one client an agent was theirs.
  //
  // Refused for staff as well, and that is the same rule rather than an extra
  // one: both branches of the roster filter on this predicate regardless of who
  // is looking, and a staff run dialog opened here would build a submission both
  // submit cores reject.
  //
  // `notFound()`, matching the client gate below: a client probing ids must not
  // learn which agents the lab has, and a distinct refusal here would answer
  // exactly that for every instance key it guessed.
  if (!agentKeyMatchesClientSlug(agent.key, client.agentsRepoSlug)) notFound();

  const [jobs, credits, scheduledRuns, umbrellas, assets, integrations, contextItems] =
    await Promise.all([
    listJobs({ clientId: id }),
    getClientCredits(id),
    listPlannedScheduledRuns({ clientId: id }),
    listClientAgents({ clientId: id }),
    listAssets({ clientId: id }),
    listClientIntegrations(id),
    // The run dialog's attachment picker (CD-H8) - the legacy branch offers
    // the standard run gesture, and the standard gesture can attach context.
    listContextItems({ clientId: id }),
  ]);

  // eslint-disable-next-line react-hooks/purity -- server component, no re-render concern
  const now = Date.now();
  const umbrella = umbrellaForAgent(umbrellas, agent.id);
  // Has this agent landed work here? Asked ONCE, through the function the roster
  // lists by, and used for both the gate below and the status strip further
  // down. It was two reads: an inline job scan here and `produced.length > 0 ||
  // hasDeliveredByJob` there. The inline scan was job-only, so a client whose
  // Workspace was full of an agent's lab-imported posts got a 404 from the
  // agent's own page — and the roster, reading the same job-only rule, did not
  // list the agent either.
  const hasDelivered = agentsWithDeliveredWork({
    assets,
    jobs,
    agents: [agent],
    umbrellas,
    clientSlug: client.agentsRepoSlug,
    viewerIsClient,
    now,
  }).has(agent.id);

  // A client may only open an agent they were granted — or one that has already
  // delivered for them, the same rule the roster uses to decide what to list.
  // Same answer for "not granted" and "does not exist": a client probing ids
  // must not learn which agents the lab has.
  if (viewerIsClient && !(client.customAgentIds ?? []).includes(agent.id) && !hasDelivered) {
    notFound();
  }

  const summary = toSummary(agent);
  const spendable = isBillableClientActor(user) ? availableCredits(credits, now) : undefined;
  const cost = agent.creditCost ?? CREDIT_COSTS.customAgentRun;
  // What ONE PRESS of "create" actually charges: the per-output base × what a
  // fresh dialog submits (visible batch defaults only — 1 for every agent
  // today, so today runCost === cost). The gate, the block reason and the
  // panel's button all quote THIS, so a future visible multi-output default
  // cannot wave a client into a dialog whose Start run the server refuses.
  const runBatchSize = defaultRunBatchSize({ key: agent.key, name: agent.name });
  const runCost = cost * runBatchSize;
  const creditBlockReasons: Record<string, string> =
    spendable !== undefined && spendable < runCost
      ? { [agent.id]: creditBlockReason(credits, runCost, now) }
      : {};

  // Ruling 7: the inline pane rides the setup state, keyed by agent. Staff get
  // the form (their run dialog collects it in place); a client's own route
  // reaches the same form through AgentSetupState.href, which is the CD-E1
  // model and stays a full page.
  //
  // The intake DOCUMENTS ride alongside, not after: the inputs band (CD-K1)
  // wants a dated index of the same collections the panes are built from, and
  // making it wait for the panes would add a serial round trip to every staff
  // page load for data neither call needs from the other.
  const [panes, inputDocs] = await Promise.all([
    isStaff
      ? agentIntakePane(id, agent, {
          isStaff,
          jobs,
          ...(client.socialLinks?.linkedin ? { linkedinPageUrl: client.socialLinks.linkedin } : {}),
        })
      : Promise.resolve(undefined),
    readAgentInputDocs(id, agent.key),
  ]);
  const agentSetup = await buildAgentSetup(id, [summary], panes);
  // Declared HERE, not further down, because the status strip reads it: the badge
  // and the run gate must answer "can this be run" off one object, and a `const`
  // is not hoisted.
  const setup = agentSetup[agent.id] ?? null;
  const scheduleRows = toScheduleRows(scheduledRuns, viewerIsClient);
  const rows = umbrella
    ? await toClientAgentRows({
        umbrellas: [umbrella],
        agentsById: new Map([[agent.id, agent]]),
        viewerIsClient,
        grantedAgentIds: null,
        clientSlug: client.agentsRepoSlug,
        agentSetup,
        ...(spendable !== undefined ? { spendable } : {}),
        creditBlockReasons,
        scheduleRows,
        scheduleZones: scheduleZonesByAgent(scheduledRuns),
        jobs,
        viewerUid: user.uid,
        viewerIsStaff: isStaff,
        viewerSeatId: user.seatId,
        viewerIsGroupAdmin: user.isGroupAdmin,
        now,
      })
    : [];
  const row = rows[0] ?? null;

  const schedule = scheduleRows.find((s) => s.agentId === agent.id) ?? null;
  // The name fallback `lastRunFailedAgentIds` attributes pre-customAgentId runs
  // by. "Has it delivered?" is NOT re-derived here — it was answered above,
  // before the gate, through the same function the roster lists by.
  const agentIdByName = new Map([[agent.name, agent.id]]);
  // ── What this agent has already delivered (§7.3 identity) ──
  // The attribution join, the client's delivered-work-only filter and the
  // delivery stamp all moved to agent-detail-archetypes.ts when the second and
  // third archetypes arrived (CD-I1): three page shapes asking "what did this
  // agent make" three different ways is three chances to credit a post to an
  // agent that did not write it (F147).
  const produced = agentProducedAssets({
    assets,
    jobs,
    // The KEY rides along with the name: a lab-imported asset carries the repo
    // folder it came from ("instagram-agent") and nothing else, and the key is
    // the spelling of this agent closest to it.
    agent: { id: agent.id, name: agent.name, key: agent.key },
    umbrella,
    umbrellas,
    viewerIsClient,
    viewer: { role: user.role, seatId: user.seatId, isGroupAdmin: user.isGroupAdmin },
    now,
  });

  // `produced` is this page's LIST; `hasDelivered` above is the strip's VERDICT,
  // and it is also what the roster card that opened this page reads, so the two
  // pages cannot disagree.
  //
  // WHAT THE `|| produced.length > 0` IS FOR, restated because its old reason
  // has been closed above and a comment naming a cause that can no longer
  // happen is worse than no comment. The reason given here used to be the
  // binding: `agentsWithDeliveredWork` filters its candidates by
  // `agentKeyMatchesClientSlug` and `agentProducedAssets` does not, so for an
  // agent bound to another client the verdict could be false while the list was
  // non-empty — a strip reading "Not set up yet" above a shelf of work. This
  // route now refuses that pair outright, so that particular divergence is
  // unreachable and this line no longer changes any rendered page.
  //
  // Kept anyway, and deliberately: the invariant the page needs is that the
  // strip never contradicts the list under it, and the two answers are computed
  // by two functions that a review pass has already made disagree twice. This
  // costs a boolean OR; re-deriving the invariant from "the two computations
  // agree today" is what let it break before.
  const stripHasDelivered = hasDelivered || produced.length > 0;

  const status = rosterStatus({
    launchState: umbrella?.launchState ?? null,
    // Raw refusal + raw status: `rosterStatus` owns both the pause rule and
    // the freshness window, so the roster card and this page cannot end up
    // ageing the same refusal differently.
    scheduleRefusal: schedule?.lastError ?? null,
    scheduleRefusalAt: schedule?.lastErrorAt ?? null,
    scheduleActive: schedule?.status === "active",
    hasDelivered: stripHasDelivered,
    // The second proof of "this can be run", beside delivered work. Both
    // readiness questions, from the SAME object `legacyGate` below reads — so the
    // badge cannot say "Not set up yet" over a working Run button, which is what
    // it did for any configured agent that had simply never been asked yet.
    // Undefined when this agent runs on no intake: unknown must not read as ready.
    ...(setup ? { readyToRun: setup.ready && setup.standUpDone } : {}),
    // Read through the SAME helper the roster uses (lastRunFailedAgentIds), not
    // re-derived from `agentRuns` below: that list is staff-only and capped at
    // eight rows, so a client's page would answer this differently — or not at
    // all — from the card that opened it.
    lastRunFailed: lastRunFailedAgentIds(jobs, agentIdByName, { staff: isStaff }).has(agent.id),
    // The same flag `lastRunFailedAgentIds` already takes, handed on rather than
    // re-derived: a client's badge is never moved by a run that broke on our side
    // (AF-14), and the two answers have to come off one boolean or this page and
    // the card that opened it can disagree about which reader they are for.
    viewerIsStaff: isStaff,
    // AF-5, through the same helper both roster branches read, and with the same
    // (viewer-independent) arguments — the strip, the header badge and the card
    // that opened this page must all say one word.
    hasUpcomingContent: agentsWithUpcomingContent({
      assets,
      jobs,
      agents: [agent],
      umbrellas,
      clientSlug: client.agentsRepoSlug,
      now,
    }).has(agent.id),
    now,
  });
  const blurb = clientAgentBlurb({
    key: agent.key,
    name: agent.name,
    clientBlurb: agent.clientBlurb ?? null,
  });

  // ── WHICH PAGE SHAPE (CD-I1) ──
  // Albert: "a logical UI for each of the agents based on what each of the
  // agents does." The archetype is resolved from the agent's identity through
  // the §7.3 idiom, and it decides the HERO only - status, archive, data,
  // connectors and feedback are the common chassis and render for all three.
  const archetype = agentArchetype({ key: agent.key, name: agent.name });

  // The agent's own schedule row, unredacted, for the day projections.
  // `scheduleRows` above is the client-safe projection and deliberately drops
  // the fields projectRunOccurrences needs — so this reads the SAME selection
  // (`selectAgentSchedule`) rather than a fifth private copy of the weekly-only
  // filter. It had one, and it was the copy that made the Reddit panel print
  // "Not looking yet" for a daily agent that drafts every day.
  const plannedRun = selectAgentSchedule(scheduledRuns, agent.id)?.schedule ?? null;

  const clipView =
    archetype === "clip_maker"
      ? buildClipMakerView({ assets: produced, run: plannedRun, now })
      : null;

  // The finder reads the SAME produced set - its finds are assets like any
  // other deliverable, so a client's archive rules already apply to them and
  // an unapproved batch can never surface as "found today".
  const finderView =
    archetype === "daily_finder"
      ? buildDailyFinderView({
          assets: produced,
          jobs,
          run: plannedRun,
          viewerIsClient,
          now,
        })
      : null;

  // The finder's intake card. `buildRedditAgentIntakeView` already builds its
  // company view by whitelist (toRedditIntakeView), so what lands in the RSC
  // payload is the client's own answers and nothing else from the shared
  // intake document.
  const finderIntake =
    archetype === "daily_finder"
      ? (await buildRedditAgentIntakeView(id, { isStaff, jobs })).company
      : null;

  // The clip maker's source material: what it has to cut FROM. `mimeType` is
  // the reliable discriminator - ContextItem.kind has no "video" variant yet
  // (the other half of F150, still ops-pending), so a clip uploaded today is
  // stored as "other" and a kind check would report none on file.
  // The archive list under the hero: the rows, and what to call them. Capped
  // at 8 on every branch - this is a summary that links the Workspace, not the
  // Workspace itself.
  const archiveRows = (
    clipView ? clipView.documents : finderView ? finderView.documents : produced
  ).slice(0, 8);
  const archiveHeading =
    archetype === "template_calendar" ? "What it has made for you" : "Documents it produced";

  // ── STAFF PARITY (CD-I1) ──
  // Everything the retired card grid could do, resolved for THIS agent. The
  // directive is that nothing staff could do before becomes unreachable, so
  // each of these maps to a capability that used to live on that card: the run
  // dialog, the schedule dialog, the intake affordance, the review queue, the
  // run history, the curation pane and the economics card.
  const agentRuns = isStaff
    ? toRunRows(jobs, true, umbrellas).filter((run) => run.agentName === agent.name)
    : [];
  const reviewCount = isStaff
    ? jobs
        .filter(
          (job) =>
            job.external?.taskType === "custom" &&
            job.status === "review" &&
            job.agentName === agent.name,
        )
        .reduce((total, job) => total + job.assetIds.length, 0)
    : 0;
  const lastStaffRun = agentRuns[0];
  // §6.2(b). USD this client has spent on this agent, split by run type.
  // Computed from the jobs already loaded - no extra read - and staff-only:
  // this is cost data, and the client's side of the same question is credits.
  const economics = isStaff
    ? summarizeAgentEconomics(jobs.filter((job) => job.customAgentId === agent.id))
    : null;

  // ── CONTROL ROOM: health + next-scheduled-execution (real signals only) ──
  // `scheduledRuns` (unlike `scheduleRows`/`schedule` above, which only cover
  // WEEKLY umbrella-paced schedules) is the raw PlannedScheduledRun set for
  // every cadence, so a one-off or daily/monthly schedule still counts toward
  // health/next-run - deriveAgentHealth and nextRunCountdown are both pure
  // (agent-health.ts / scheduled-runs.ts), so this is just wiring real rows in.
  const agentSchedules = scheduledRuns.filter((r) => r.customAgentId === agent.id);
  const activeAgentSchedules = agentSchedules
    .filter((r) => r.status === "active")
    .sort((a, b) => a.nextRunAt - b.nextRunAt);
  const soonestActiveSchedule = activeAgentSchedules[0] ?? null;
  const pausedAgentSchedule = agentSchedules.find((r) => r.status === "paused") ?? null;
  const agentHealth = isStaff
    ? deriveAgentHealth({
        runs: agentRuns.map((r) => ({ status: r.status, createdAt: r.createdAt })),
        scheduleStatus: soonestActiveSchedule ? "active" : pausedAgentSchedule ? "paused" : null,
        scheduleLastError: (soonestActiveSchedule ?? pausedAgentSchedule)?.lastError ?? null,
      })
    : "healthy";
  const nextRunLabel = soonestActiveSchedule
    ? `Next run ${nextRunCountdown(soonestActiveSchedule.nextRunAt, now)}`
    : null;

  const sourceFiles: SourceFile[] =
    archetype === "clip_maker"
      ? contextItems
          .filter(
            (item) =>
              item.mimeType.startsWith("video/") || item.mimeType.startsWith("audio/"),
          )
          .map((item) => ({ id: item.id, name: item.name, at: item.createdAt }))
      : [];

  const connections = sanitizeIntegrations(integrations);
  // Platform ids for the deliverable modal's publish controls - the same
  // sanitized set the connector chips below render, never the raw integration
  // docs (which carry credentials).
  const connectedPlatformNames = connections.map((connection) => connection.platform);
  const launchInFlight = umbrella ? isLaunchInFlight(umbrella.launchState) : false;
  const agentServiceConfigured = isAgentServiceConfigured();

  // CD-H8. The run gate for the legacy shape, evaluated HERE for the same
  // reason every other gate on this surface is: a control may only offer a
  // press the server would accept (F131), and its reason has to arrive with it
  // already resolved so it can be painted rather than hidden in a tooltip on a
  // pointer-events-none button (F25). Same ladder the generic card walks -
  // service, then intake, then credits - so the two cannot disagree.
  const legacyGate = evaluateLegacyRunGate({
    serviceConfigured: agentServiceConfigured,
    setup,
    cost: runCost,
    ...(spendable !== undefined ? { availableCredits: spendable } : {}),
    creditBlockReason: creditBlockReasons[agent.id] ?? null,
  });

  // F31. The legacy branch had no run state at all: a client pressed "Create a
  // new post", the page did not change, and nothing on it refreshed - so the
  // twenty minutes the run takes were indistinguishable from the press having
  // done nothing. Resolved here rather than in the panel for the usual reason:
  // only an id and a phase cross the boundary, never the job's prompt, events
  // or asset ids.
  //
  // Attribution matches the "what it has made" join above - customAgentId is
  // authoritative, agentName keeps runs fired before that field existed. Launch
  // runs are excluded by construction: this shape has no umbrella to launch.
  //
  // ONLY A RUN THIS VIEWER STARTED. The banner this feeds says "Making your
  // next post now" and offers a Cancel whose confirm promises the credits back,
  // and it was matching ANY in-flight run on the agent - including a SCHEDULED
  // fire. Two things were wrong with that. The copy: a cron tick is not
  // something the reader just asked for, and the umbrella card next door has
  // always held the opposite line ("the one run the card acknowledges: a 'Run
  // now' the viewer just pressed" - client-agent-rows.ts), which is also the
  // A3/A4 rule that scheduled production stays invisible. And the money: a
  // scheduled fire charges the client only when the SCHEDULE was theirs
  // (run-scheduled/route.ts bills on `billClientCredits` and acts as the
  // schedule's creator), so for a staff-set schedule nothing was charged and
  // the refund promise was simply false.
  //
  // `createdBy === user.uid` answers both at once: the manual press is theirs,
  // and their own schedule's fire is theirs and IS billed, while a staff-set
  // schedule's fire is not shown to them at all.
  const legacyRun = umbrella
    ? null
    : (jobs
        .filter(
          (job) =>
            job.external?.taskType === "custom" &&
            (job.status === "queued" || job.status === "running") &&
            job.runType !== "launch" &&
            job.runType !== "test" &&
            job.createdBy === user.uid &&
            (job.customAgentId === agent.id ||
              (!job.customAgentId && job.agentName === agent.name)),
        )
        .sort((a, b) => b.createdAt - a.createdAt)[0] ?? null);

  // ── THE SECTIONED LAYOUT (CD-K1) ──
  // Albert: "under each agent, everything Daniel created is there, WITH DATES,
  // categorized in sections - all inputs, all outputs, all settings." Outputs
  // already had a home (the hero and the archive under it); these are the other
  // two bands, and both are read-only projections that link the surfaces which
  // already own the writes. Building editors here would be a second write path
  // for documents that have one, which is how two screens start disagreeing
  // about the same record.
  const inputs = agentInputsView(inputDocs, setup);

  // The registry rows the FORMAT list can be opened onto. `row.templates` is
  // the viewer-redacted registry, never `umbrella.templates` - a `curating`
  // umbrella's registry holds what the setup run proposed and staff have not
  // confirmed, and the row projection empties it for a client for that reason.
  // `produced` is the same delivered-work-only set the archive below rides, so
  // opening a format cannot become a laxer route to undelivered work.
  const templateDetailMap = umbrella
    ? templateDetails({ templates: row?.templates ?? [], assets: produced, viewerIsClient })
    : undefined;

  const setupFacts = umbrella
    ? buildAgentSetupFacts({
        umbrella,
        templates: row?.templates ?? [],
        schedule: schedule
          ? {
              status: schedule.status,
              postsPerWeek: schedule.postsPerWeek,
              outputsPerRun: schedule.outputsPerRun,
              nextRunAt: schedule.nextRunAt,
            }
          : null,
        viewerIsClient,
      })
    : [];

  // The only work this page may announce as happening NOW: a run this viewer's
  // own side started. A scheduled fire is deliberately excluded — it is not
  // something the reader just asked for, and saying it is running states outright
  // that production is not day-of (A3/A4). A launch in flight is excluded too:
  // the launch card is already narrating it in three phases, and a second voice
  // would be a second copy of that story to keep in step.
  //
  // AF-9: it used to be exactly the two runs a BANNER is mounted for, and those
  // two do not cover the run this page's own controls fire most. `row.activeRun`
  // matches `runType: "manual_template"` only, and `legacyRun` is nulled outright
  // for an umbrella-bound agent — so a staff "Run now" or "Test run" from the
  // Control Room, on the flagship umbrella agent, left the page with no in-flight
  // mark at all and no AutoRefresh. Pressing the button and being sent nowhere
  // visible is exactly the post-gesture confusion this item is about.
  //
  // Same authorship rule as `legacyRun` (`createdBy === user.uid`), so it can
  // still only ever announce work this reader asked for. Test runs count for
  // staff, who are the only people who can fire one and the people waiting on it.
  const viewerRunInFlight = jobs.some(
    (job) =>
      job.external?.taskType === "custom" &&
      (job.status === "queued" || job.status === "running") &&
      job.runType !== "launch" &&
      (isStaff || job.runType !== "test") &&
      job.createdBy === user.uid &&
      (job.customAgentId === agent.id ||
        (!job.customAgentId && job.agentName === agent.name)),
  );
  const running = Boolean(row?.activeRun || legacyRun) || viewerRunInFlight;

  // Order-independent: `produced` is sorted for a client and unsorted for
  // staff, and this line has to give the same answer to both.
  const lastDelivered = produced.reduce<number | null>((newest, asset) => {
    const at = deliverableStamp(asset, viewerIsClient);
    return newest === null || at > newest ? at : newest;
  }, null);
  // NOT "delivered so far". A client's `produced` is their ARCHIVE set, and
  // `isInClientArchive` drops published work past the 30-day window - so the
  // number is what is in the Workspace right now, and a label promising a
  // lifetime total would be wrong for exactly the clients who have the most.
  // Staff see every asset, so for them it is the count without a window.
  const statusFacts = [
    ...(lastDelivered !== null ? [{ label: "Last delivered", at: lastDelivered }] : []),
    ...(produced.length > 0
      ? [
          {
            label: viewerIsClient ? "In your Workspace" : "Deliverables",
            value: String(produced.length),
          },
        ]
      : []),
  ];

  // ── WHICH AGENTS GET THE RUN BAND (Daniel's ruling, 2026-08-06) ──
  //
  // It used to be `schedule?.status === "active" || hasDelivered` — production
  // HISTORY. An agent that had never produced got no run gesture and no price
  // card, so the only way to obtain the affordance was to already have used it.
  // For X that was invisible (it has delivered), and for a freshly granted
  // LinkedIn agent it meant a fully-configured product with nowhere to press:
  // "READY TO RUN" on the inputs band, and nothing on the page that could run it.
  //
  // `intakeDriven` is the third way in, and it is deliberately about CAPABILITY
  // rather than history: an agent whose readiness the server can actually answer
  // (X / LinkedIn / Reddit — `setup` is non-null exactly for those) is an agent
  // that can be asked for something. The gate below still decides whether the
  // press is OFFERED, and it now knows every rung the submit cores know — so
  // widening who SEES the band cannot widen who can fire a refused run.
  //
  // Deliberately not "every agent": one with no `setup` has no server-answerable
  // readiness, so its band could only guess. Those keep the old behaviour.
  const intakeDriven = setup !== null;
  const legacyShape = !row && (schedule?.status === "active" || hasDelivered || intakeDriven);

  // Where "everything this agent has made" actually lives for THIS viewer.
  // The old link sent both readers to /clients/<id>/assets, which redirects a
  // CLIENT_USER to /tasks — the Workspace board, not the archive tab they were
  // promised. clientArchiveLink is the four-call-site answer to exactly this.
  const archive = clientArchiveLink({ clientId: id, isStaff });

  // ── Which platform this agent's page is ABOUT, for the connectors card ──
  // An intake-driven agent (X/LinkedIn/Reddit) drafts for one platform, and
  // its sidebar listing Google Analytics beside "Connected accounts" answered
  // a question nobody on this page asked. Scoped to the agent's own family;
  // an agent with no family (the generic/legacy shapes) keeps the full list,
  // exactly as before. Display-only: connectedPlatformNames above still
  // carries every platform, because publish targets are not page-scoped.
  const family = intakeFamilyFor(agent.key);
  const FAMILY_PLATFORMS: Record<NonNullable<typeof family>, string[]> = {
    x: ["twitter"],
    linkedin: ["linkedin", "linkedin_community"],
    reddit: ["reddit"],
    // The newsletter and the blog have NO platform connection, and an empty
    // list is the honest answer rather than an omission. Neither product holds
    // a credential: an issue is sent from the client's own email platform and
    // an article is published on their own CMS, both by them. So the connectors
    // card shows none — which is different from the generic/legacy shapes
    // below, where a null family deliberately keeps the FULL list.
    newsletter: [],
    blog: [],
    // EMPTY, and for a different reason than the two above — which is why it is
    // not folded in with them. The newsletter and the blog have no platform at
    // all. Reputation READS five (Google Business, Yelp, App Store, Trustpilot,
    // Facebook), but none of them is a Karos INTEGRATION: the runner reaches
    // them through its own egress allowlist, and this card lists connections the
    // CLIENT has authorised. Listing them here would offer a "Connect" affordance
    // for accounts nothing in this portal can connect.
    reputation: [],
    // EMPTY, and this is the one that will look wrong at a glance: the carousel
    // makes INSTAGRAM slides, and Instagram is a platform this portal connects.
    // But the agent holds no credential and does not post — it renders PNGs a
    // person uploads, and the portal's own publish path is what would ever use a
    // connection. Listing it here would put a "Connected accounts" row on the
    // agent's page implying this agent needs or uses that connection, which is
    // the F7 shape: an affordance that answers a question nobody asked.
    carousel: [],
  };
  const familyPlatforms = family ? FAMILY_PLATFORMS[family] : null;
  const scopedConnections = familyPlatforms
    ? connections.filter((connection) => familyPlatforms.includes(connection.platform))
    : connections;

  // The row's display title, by VIEWER (F132: label rows by what was
  // produced, never by what was typed — the typed brief stays staff-facing).
  // Staff rows show `meta.runLabel` (what the run was asked to do) beside the
  // base title; a client's batch rows, which were N identical copies of the
  // agent's name, get the family's produced-work noun — the client component
  // dates it with the row's own delivery stamp, in the VIEWER's timezone,
  // because a server-formatted day can sit one day off beside the client-side
  // relative stamp on the same row.
  const FAMILY_BATCH_NOUN: Record<NonNullable<typeof family>, string> = {
    x: "X draft batch",
    linkedin: "LinkedIn draft batch",
    reddit: "Reddit reply draft",
    // SINGULAR for both, and not for tidiness: one run of either product
    // prepares exactly ONE thing. "Batch" would tell a client their week
    // arrived in a lump, which is the A3/A4 rule the other three nouns are
    // carefully worded around.
    newsletter: "Newsletter issue",
    blog: "Blog article",
    // "Replies", plural, and it is the one exception to the singular rule its two
    // neighbours follow. One pulse genuinely does produce several drafts, one per
    // review worth answering — so a singular here would be the inaccuracy, not the
    // batch-shaped tell the rule guards against. What that rule forbids is
    // implying a WEEK arrived in one lump; a set of replies to a set of reviews is
    // just what the run is.
    reputation: "Review replies",
    // Singular: one run produces ONE carousel post. Its eight to ten slides are
    // that post, not a batch of posts.
    carousel: "Carousel post",
  };
  const rowTitleFields = (
    asset: (typeof archiveRows)[number],
  ): { title: string } | { fallbackNoun: string } => {
    const stored = (asset.title ?? "").trim();
    const generic =
      !stored ||
      stored === agent.name ||
      (umbrella?.displayName ? stored === umbrella.displayName : false);
    const runLabel = asset.meta?.runLabel;
    if (isStaff && typeof runLabel === "string" && runLabel.trim()) {
      return { title: `${stored || agent.name} · ${runLabel.trim()}` };
    }
    if (!generic || !family) return { title: stored || agent.name };
    return { fallbackNoun: FAMILY_BATCH_NOUN[family] };
  };

  return (
    <>
      {/* AF-9: `running` already is "a run this viewer started is in flight", so
          the poller and the mark on the strip can no longer answer that question
          differently — which they did, and which is why a staff run left a static
          page behind it. */}
      {(launchInFlight || running) && <AutoRefresh />}
      <div className="mb-4">
        <Link
          href={`/clients/${id}/agents`}
          className="inline-flex items-center gap-1.5 text-xs text-muted hover:text-foreground"
        >
          <Icon name="ChevronLeft" className="h-3.5 w-3.5" /> All agents
        </Link>
      </div>

      <PageHeader
        title={umbrella?.displayName ?? agent.name}
        description={blurb}
        action={
          <div className="flex items-center gap-2">
            <AgentIdentity
              identity={`${agent.key} ${agent.name}`}
              {...(agent.icon ? { icon: agent.icon } : {})}
            />
            <StatusBadge label={status.label} tone={status.tone} />
          </div>
        }
      />

      {/* One banner, two registers — the roster page's idiom (agents/page.tsx),
          for the same reason. This tree renders for BOTH readers, so the client
          sentence was telling a KAROS_ADMIN to contact the Karos team; staff are
          the people who clear this, so theirs names the cause instead. Problem,
          then what to do, then the reassurance: the reassurance sat between the
          other two and buried the action. */}
      {!agentServiceConfigured && (
        <p className="mb-4 rounded-[var(--radius)] border border-warning/30 bg-warning/10 px-4 py-3 text-sm text-warning">
          <Icon name="TriangleAlert" className="mr-1.5 inline h-4 w-4" />
          {viewerIsClient
            ? "Agent runs are paused right now. Starting a new post will not work until this clears. Contact your Karos team if you need a post today. Everything below is unaffected."
            : "Agent runs are paused. The agent-service environment is not configured, so starting a post will fail until it is set. Everything below is unaffected."}
        </p>
      )}

      {/* CD-H7a's idiom, for the same failure one level up: the two-column
          arrangement engages off the CONTENT COLUMN, not the viewport. `lg:`
          only knows the window is 1024+, so with the Copilot dock out at 1280
          this grid computed 236px of content beside a 320px rail - the run
          card's label wrapped one word per line and the button sat on top of
          it. The (app) shells wrap every page in @container, so @4xl (896px of
          actual column) is the first width that honestly holds 1fr + 320px +
          the gap; below it the page is a single column. */}
      <div className="grid gap-6 @4xl:grid-cols-[minmax(0,1fr)_320px]">
        <div className="min-w-0 space-y-6">
          {/* ── STATUS (CD-K1) ──
              The header badge says the same word in the same breath, and that
              is the point: Albert's directive is about how LOUDLY the page says
              it, not whether the word appears. The strip leads the column with
              a breathing halo; the badge stays the compact form for the header
              row. Both read the SAME resolved `status`, so the rule that a
              schedule refusal outranks Live (F24/F129) cannot hold in one place
              and not the other. */}
          {/* `staffNote` is AF-5's operational truth and is passed for staff
              only — the client reads the word alone, which is the ruling. */}
          <AgentStatusStrip
            status={status}
            running={running}
            facts={statusFacts}
            {...(isStaff && status.staffNote ? { staffNote: status.staffNote } : {})}
            {...(legacyShape
              ? {
                  aside: (
                    <SchedulePaceCard
                      clientId={id}
                      agent={summary}
                      cost={spendable !== undefined ? cost : null}
                      schedule={schedule}
                      viewerIsClient={viewerIsClient}
                      {...(spendable !== undefined ? { availableCredits: spendable } : {})}
                    />
                  ),
                }
              : {})}
          />

          {/* ── THE ARCHETYPE HERO (CD-I1) ──
              Deliberately ABOVE the controls band. Albert asked for the clip
              maker to be deliverables-first and the finder to lead with what it
              found today, and "first" is a layout claim, not a copy one: what a
              page opens with is what it is about. The template-calendar shape
              has no separate hero - its product IS the format registry and the
              week ahead, which live inside the panel below. */}
          {clipView && (
            <section>
              <SectionHeading title="Your clips" />
              <ClipGallery
                clips={clipView.clips}
                viewerIsClient={viewerIsClient}
                canApprove={isStaff}
                {...(connectedPlatformNames.length > 0
                  ? { connectedPlatforms: connectedPlatformNames }
                  : {})}
                emptyHint={
                  sourceFiles.length === 0
                    ? "This agent cuts from footage you provide. Once your Karos team has your source video, finished clips land here for you to download and post."
                    : "Your footage is on file. Finished clips land here once your Karos team has reviewed them."
                }
              />
            </section>
          )}

          {/* No `scheduleActive` and no `emptyHint`: both were this page's own
              derivation of "is it running?" from the redacted schedule row,
              beside a strip the server had already derived from the raw run.
              The panel reads `view.scheduleState` — one answer, one source. */}
          {finderView && <DailyFinderPanel clientId={id} view={finderView} />}

          {/* Hero: the launch card for a non-live umbrella (§7.1 states 1–3),
              the working agent once it is live. An agent with no umbrella at
              all has neither - it is simply not set up, and says so rather
              than offering controls the server would refuse. */}
          {row && umbrella?.launchState === "live" ? (
            <AgentDetailPanel
              agent={row}
              viewerIsClient={viewerIsClient}
              viewer={{ name: user.name, email: user.email }}
              archetype={archetype}
              staffNotes={isStaff}
              {...(templateDetailMap ? { templateDetails: templateDetailMap } : {})}
            />
          ) : row ? (
            <ClientAgentLaunchCard
              agent={row}
              viewerIsClient={viewerIsClient}
              viewer={{ name: user.name, email: user.email }}
            />
          ) : legacyShape ? (
            /* The legacy shape (CD-H8): no umbrella was ever bound, but a weekly
               schedule is firing — so this agent genuinely IS producing, and the
               roster and header badge it Live.

               THE SCHEDULE, not `status.tone === "live"`. The tone was standing
               in for "a schedule is firing", and it stopped being able to the
               moment anything else could outrank Live: a failed last run (or a
               refusal) flipped the tone to `attention` and this whole panel
               vanished, replaced by an EmptyState reading "Not set up yet" — on
               an agent with an active weekly schedule. A run that failed is
               precisely when its owner needs the controls, so the branch now
               asks the question it always meant. It is also the flagship case, not
               an edge one: Karos Labs' own Instagram Agent predates the umbrella
               model. It used to render one sentence and nothing else, which made
               the most-looked-at agent in the portal the one with no way to make
               a post, no way to change its pace, and no sign of anything it had
               ever made. It now gets the two gestures that need no umbrella;
               templates, the week strip and notes stay umbrella-gated because
               faking them would invent streams this agent does not have.

               `|| hasDelivered` is what makes the "Runs on request" status
               honest. An unbound agent with delivered work but no schedule is
               set up and idle, and a page that says so while offering no way to
               ask it for anything is a label with nothing behind it. The gate
               below is the same server-evaluated ladder - service, intake,
               credits - so the button can still only offer a press the server
               would accept. */
            <LegacyAgentPanel
              clientId={id}
              agent={summary}
              cost={spendable !== undefined ? runCost : null}
              batchSize={runBatchSize}
              gate={legacyGate}
              // The banner above already made the outage statement; the gate's
              // own paragraph would repeat it 150px lower in different words.
              outageAnnounced={!agentServiceConfigured}
              {...(setup ? { setup } : {})}
              contextItems={contextItems}
              viewerIsClient={viewerIsClient}
              viewer={{ name: user.name, email: user.email }}
              activeRun={
                legacyRun
                  ? {
                      id: legacyRun.id,
                      status: legacyRun.status === "running" ? "running" : "queued",
                      // Whether stopping it actually returns credits. `spendable`
                      // is resolved only for a billable actor, so it IS the
                      // "was this viewer charged" answer, already computed.
                      refunds: spendable !== undefined,
                    }
                  : null
              }
            />
          ) : inputs ? (
            /* ONE SETUP ASK PER SCREEN (P1-2/P1-4). This EmptyState used to
               render above the inputs band regardless, so an intake-driven
               agent said "Not set up yet - your Karos team sets this up" in a
               hero and then, 40px below, carried a green READY TO RUN badge on
               the band that actually knows. On the Reddit page the same screen
               asked for setup five times in five voices.

               The band is the one that can answer: it holds the readiness the
               submit core gates on, the per-document dates, and the link to the
               form. So when it is mounted it owns the state, and the hero says
               nothing rather than a second, staler version of it. */
            null
          ) : (
            <EmptyState
              icon={<Icon name="Bot" className="h-7 w-7" />}
              title="Not set up yet"
              description="Your Karos team sets this agent up for your brand before it starts producing. They will let you know when it is ready."
            />
          )}

          {/* ── INPUTS (CD-K1 directive 1) ──
              Daniel's intake surfaces, reachable from the agent they belong to.
              They have always lived at /clients/<id>/<platform>-agent; the
              redesign removed the sidebar links, so for two months the only way
              to reach a seat form was to know the URL. Each row carries its own
              date and links the page that owns its writes - the forms are
              REUSED, never forked. */}
          {inputs && <AgentInputsSection view={inputs} />}

          {/* ── SETTINGS (CD-K1 directive 2) ──
              What the launch run decided: the registry, the rotation, the pace,
              and when any of it last moved. Read-only by design - every field
              here already has an editor above or beside it, and the gap this
              fills is that none of those editors ever says WHEN. */}
          {setupFacts.length > 0 && <AgentSetupSection facts={setupFacts} />}

          {/* ── CONTROL ROOM (AgentOps upgrade) ──
              Consolidates what used to be three scattered staff-only sections
              (StaffAgentControls, AgentRunHistory, AgentEconomicsCard) into one
              tabbed panel, plus what none of them had: a real (not fabricated)
              health read, an explicit next-scheduled-execution line, and a
              Test Run trigger. Staff only - never mounted for a CLIENT_USER,
              same gate every section it replaces already used. */}
          {isStaff && (
            <ControlRoom
              health={agentHealth}
              nextRunLabel={nextRunLabel}
              clientId={id}
              agent={summary}
              {...(schedule ? { schedule } : {})}
              {...(setup ? { setup } : {})}
              contextItems={contextItems}
              reviewCount={reviewCount}
              reviewHref={agentRuns.find((run) => run.status === "review")?.href ?? `/clients/${id}/assets`}
              {...(lastStaffRun ? { lastRunAt: lastStaffRun.createdAt } : {})}
              viewer={{ name: user.name, email: user.email }}
              runs={agentRuns}
              agents={[summary]}
              economics={economics}
              economicsAgentName={umbrella?.displayName ?? agent.name}
              launchCreditCost={agent.launchCreditCost ?? null}
              outputs={produced}
              {...(deepLinkAssetId ? { initialOpenAssetId: deepLinkAssetId } : {})}
            />
          )}

          {/* Where staff confirm the template set before a client ever sees it
              (the Q3 curation gate). Umbrella-only by nature - it edits the
              umbrella's registry - and never shown for an unbound agent. */}
          {isStaff && row && umbrella && umbrella.launchState !== "not_launched" && (
            <CurationPane agent={row} />
          )}

          {/* ── The per-agent archive (common chassis) ──
              WHAT is listed depends on the archetype, because two of the three
              already showed their product above and a second listing of the
              same rows under a different heading is how one deliverable ends
              up looking like two. The clip maker lists what it wrote BESIDE
              the clips; the finder lists what it wrote that was not a find. */}
          <section>
            <SectionHeading title={archiveHeading} />
            {archiveRows.length === 0 ? (
              <p className="rounded-[var(--radius)] border border-border bg-surface-2/50 px-4 py-3 text-xs text-muted-2">
                {archetype === "template_calendar"
                  ? "Nothing yet. Finished work appears here once your Karos team has approved it."
                  : "Nothing else yet. Everything this agent has made is above."}
              </p>
            ) : (
              /* Each row now carries its own way in — a neon-outline
                 View-output control, opening the same detail modal the archive uses (the
                 per-draft reader for agent batches). The rows used to be inert:
                 title, stamp, and one small text link under the list, so
                 reaching a specific deliverable meant leaving the page and
                 finding it again in the Workspace.

                 The STAMP is computed here, not in the component: the set is
                 already delivered-work-only for a client, and the stamp has to
                 match. `createdAt` is the generation instant a whole batch
                 shares, so eight rows under "What it has made for you" would
                 all read "3 hours ago" - the same batch tell the asset filter
                 three screens up was added to close. Staff keep the
                 generation time. */
              <AgentArchiveRows
                rows={archiveRows.map((asset) => ({
                  asset,
                  at: deliverableStamp(asset, viewerIsClient),
                  ...rowTitleFields(asset),
                }))}
                viewerIsClient={viewerIsClient}
              />
            )}
            <Link
              href={archive.href}
              className="mt-2 inline-flex items-center gap-1 text-xs text-neon hover:underline"
            >
              Open {archive.label} <Icon name="ArrowRight" className="h-3 w-3" />
            </Link>
          </section>
        </div>

        <aside className="space-y-6">
          {/* ── The data this agent runs on ──
              The generic card answers this with one link, which is right for
              an agent whose data is a form and wrong for both new archetypes:
              a clip maker runs on FILES, and a finder runs on a list of
              communities it is welcome in and a list it is banned from - and
              being banned somewhere is a fact a client wants to see on the
              page, not behind a link. */}
          {archetype === "clip_maker" ? (
            <SourceMaterialCard
              files={sourceFiles}
              hint={launchProfileFor({ key: agent.key, name: agent.name }).attachments.hint}
            />
          ) : archetype === "daily_finder" && setup && !(inputs && !inputs.ready) ? (
            /* Kept even though the inputs band lists the same document: this
               card shows the ANSWERS (which communities it is welcome in, which
               it is banned from), and "did they actually record that we were
               banned from r/SEO" is not a question a dated row can answer.

               It drops out while the intake is still EMPTY, though. With
               nothing saved it has no answers to show and collapses into a
               fourth "Set it up" - and the inputs band beside it is already
               making that ask with the dates and the link. One ask per screen
               (P1-4); once the intake exists this card is the only thing on the
               page that can show what is in it, and comes back. */
            <FinderIntakeCard
              intake={finderIntake}
              href={setup.href}
              label={setup.clientLabel}
              ready={setup.ready}
            />
          ) : inputs ? (
            /* The inputs band in the content column says all of this, per
               document and with dates. One link and a Saved/Needed badge beside
               it would be the same sentence twice, and the two would have to be
               kept in step forever. */
            null
          ) : (
          <section>
            <SectionHeading title="What it knows about you" />
            {setup ? (
              <div className="rounded-[var(--radius)] border border-border bg-surface-2/50 p-3">
                <div className="flex items-center gap-2">
                  <p className="flex-1 text-xs text-foreground">{setup.clientLabel}</p>
                  <Badge tone={setup.ready ? "success" : "warning"}>
                    {setup.ready ? "Saved" : "Needed"}
                  </Badge>
                </div>
                <p className="mt-1 text-[11px] text-muted-2">
                  {setup.ready
                    ? "This agent writes from what you saved here. Update it any time."
                    : "This agent needs this before it can write for you."}
                </p>
                <Link
                  href={setup.href}
                  className="mt-2 inline-flex items-center gap-1 text-xs text-neon hover:underline"
                >
                  {setup.ready ? "Review it" : "Set it up"} <Icon name="ArrowRight" className="h-3 w-3" />
                </Link>
              </div>
            ) : (
              <p className="rounded-[var(--radius)] border border-border bg-surface-2/50 px-3 py-2.5 text-[11px] text-muted-2">
                This agent writes from your brand profile and the documents in your Workspace.
              </p>
            )}
          </section>
          )}

          {/* ── Connectors ── read-only chips. Connecting and reconnecting are
              settings actions, so this states the fact and links there rather
              than growing a second place to change them. */}
          <section>
            <SectionHeading title="Connected accounts" />
            {scopedConnections.length === 0 ? (
              <p className="rounded-[var(--radius)] border border-border bg-surface-2/50 px-3 py-2.5 text-[11px] text-muted-2">
                {familyPlatforms && familyPlatforms.length > 0
                  ? `No ${platformLabel(familyPlatforms[0])} account connected yet. Posts are delivered to your Workspace for you to publish.`
                  : "No accounts connected yet. Posts are delivered to your Workspace for you to publish."}
              </p>
            ) : (
              <ul className="space-y-1.5">
                {scopedConnections.map((connection) => (
                  <li
                    key={connection.id}
                    className="flex items-center justify-between gap-2 rounded-[var(--radius)] border border-border bg-surface-2/50 px-3 py-2"
                  >
                    <span className="min-w-0 flex-1 truncate text-xs text-foreground">
                      {platformLabel(connection.platform)}
                      {connection.accountName && (
                        <span className="text-muted-2"> · {connection.accountName}</span>
                      )}
                    </span>
                    {integrationNeedsReconnect(connection) ? (
                      <Badge tone="warning">
                        <Icon name="TriangleAlert" className="h-3 w-3" /> Reconnect
                      </Badge>
                    ) : (
                      <Badge tone="neon">
                        <Icon name="CircleCheck" className="h-3 w-3" /> Connected
                      </Badge>
                    )}
                  </li>
                ))}
              </ul>
            )}
            <Link
              href={`/clients/${id}/settings?tab=channels`}
              className="mt-2 inline-flex items-center gap-1 text-xs text-muted hover:text-foreground"
            >
              Manage connections <Icon name="ArrowRight" className="h-3 w-3" />
            </Link>
          </section>

        </aside>
      </div>
    </>
  );
}

function SectionHeading({ title }: { title: string }) {
  return (
    <h2 className="mb-2.5 font-mono text-[10px] uppercase tracking-[0.08em] text-muted">{title}</h2>
  );
}

function StatusBadge({ label, tone }: { label: string; tone: string }) {
  if (tone === "live") {
    return (
      <Badge tone="success">
        <span className="h-1.5 w-1.5 rounded-full bg-success animate-pulse-neon" aria-hidden="true" />
        {label}
      </Badge>
    );
  }
  if (tone === "attention") return <Badge tone="warning">{label}</Badge>;
  if (tone === "progress") return <Badge tone="info">{label}</Badge>;
  return <Badge tone="neutral">{label}</Badge>;
}
