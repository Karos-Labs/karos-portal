import Link from "next/link";
import { notFound, redirect } from "next/navigation";
import { requireUser } from "@/lib/auth";
import {
  getClient,
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
import { listClientAgents } from "@/lib/data-client-agents";
import { isLaunchInFlight, rosterStatus } from "@/lib/client-agents";
import { sanitizeIntegrations } from "@/lib/integrations/sanitize";
import { integrationNeedsReconnect } from "@/lib/integration-status";
import { platformLabel } from "@/lib/integrations/platforms";
import { ClientAgentLaunchCard } from "@/components/client-agents/launch-card";
import { AgentDetailPanel } from "@/components/client-agents/agent-detail-panel";
import { LegacyAgentPanel } from "@/components/client-agents/legacy-agent-panel";
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
  buildClipMakerView,
  buildDailyFinderView,
  deliverableStamp,
  templateDetails,
} from "@/lib/agent-detail-archetypes";
import {
  agentInputsView,
  buildAgentSetupFacts,
  readAgentInputDocs,
} from "@/lib/agent-detail-sections";
import {
  AgentInputsSection,
  AgentSetupSection,
  AgentStatusStrip,
} from "@/components/client-agents/agent-sections";
import {
  buildLinkedInAgentIntakeView,
  buildRedditAgentIntakeView,
  buildXAgentIntakeView,
} from "@/lib/agent-intake-views";
import {
  isLinkedInAgentIdentity,
  isRedditAgentIdentity,
  isXAgentIdentity,
  launchProfileFor,
} from "@/lib/custom-agent-launch";
import { summarizeAgentEconomics } from "@/lib/credit-reporting";
import { AgentRunHistory, StaffAgentControls } from "@/components/custom-agents";
import { AgentEconomicsCard } from "@/components/client-agents/agent-economics";
import { CurationPane } from "@/components/client-agents/client-agents-section";
import {
  buildAgentSetup,
  type AgentIntakePanes,
  scheduleZonesByAgent,
  toClientAgentRows,
  toRunRows,
  toScheduleRows,
  toSummary,
} from "@/lib/client-agent-rows";
import { relativeTime } from "@/lib/utils";
import type { Job } from "@/lib/types";

/**
 * The inline intake form for THIS agent, when it is one of the three that draft
 * from stored intake (X e13, LinkedIn e10, Reddit e15).
 *
 * Moved here from the roster page with CD-I1's staff parity. Ruling 7 put the
 * panes on whichever surface owns the run DIALOG, and that surface is now this
 * one — so the roster stopped paying for them and this page builds exactly one,
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
  return {};
}

/**
 * One agent's home page (CD-G1).
 *
 * Albert: "they can just click on it, and then it opens… over the whole page.
 * That whole page should be like the Instagram Agent." The roster answers "is
 * this working for me"; this page answers everything else — what the agent
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
 * non-live umbrella. The roster card upstream shows only the status word —
 * a CTA, a progress narration and a failure with a Contact-us row are all
 * explanations, and explanations belong on the page you opened to get them.
 */
export default async function ClientAgentDetailPage({
  params,
}: {
  params: Promise<{ id: string; agentId: string }>;
}) {
  const user = await requireUser();
  const { id, agentId } = await params;

  if (user.role === "CLIENT_USER") {
    if (user.clientId !== id) redirect(user.clientId ? `/clients/${user.clientId}` : "/assets");
  } else if (user.role !== "KAROS_ADMIN" && user.role !== "KAROS_EMPLOYEE") {
    redirect("/dashboard");
  }

  const client = await getClient(id);
  if (!client) notFound();

  const isStaff = user.role === "KAROS_ADMIN" || user.role === "KAROS_EMPLOYEE";
  const viewerIsClient = !isStaff;

  const agent = await getCustomAgent(agentId);
  if (!agent || !agent.enabled) notFound();

  const [jobs, credits, scheduledRuns, umbrellas, assets, integrations, contextItems] =
    await Promise.all([
    listJobs({ clientId: id }),
    getClientCredits(id),
    listPlannedScheduledRuns({ clientId: id }),
    listClientAgents({ clientId: id }),
    listAssets({ clientId: id }),
    listClientIntegrations(id),
    // The run dialog's attachment picker (CD-H8) — the legacy branch offers
    // the standard run gesture, and the standard gesture can attach context.
    listContextItems({ clientId: id }),
  ]);

  // A client may only open an agent they were granted — or one that has already
  // delivered for them, the same rule the roster uses to decide what to list.
  // Same answer for "not granted" and "does not exist": a client probing ids
  // must not learn which agents the lab has.
  if (viewerIsClient) {
    const successful = new Set(["review", "approved", "delivered"]);
    const earned = jobs.some(
      (job) =>
        job.external?.taskType === "custom" &&
        successful.has(job.status) &&
        (job.customAgentId === agent.id || job.agentName === agent.name),
    );
    if (!(client.customAgentIds ?? []).includes(agent.id) && !earned) notFound();
  }

  const summary = toSummary(agent);
  const now = Date.now();
  const spendable = isBillableClientActor(user) ? availableCredits(credits, now) : undefined;
  const cost = agent.creditCost ?? CREDIT_COSTS.customAgentRun;
  const creditBlockReasons: Record<string, string> =
    spendable !== undefined && spendable < cost
      ? { [agent.id]: creditBlockReason(credits, cost, now) }
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
  const scheduleRows = toScheduleRows(scheduledRuns, viewerIsClient);
  const umbrella = umbrellas.find((u) => u.customAgentId === agent.id) ?? null;
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
        now,
      })
    : [];
  const row = rows[0] ?? null;

  const schedule = scheduleRows.find((s) => s.agentId === agent.id) ?? null;
  const status = rosterStatus({
    launchState: umbrella?.launchState ?? null,
    scheduleRefusal: schedule?.status === "active" ? schedule.lastError : null,
    scheduleActive: schedule?.status === "active",
  });
  const blurb = clientAgentBlurb({
    key: agent.key,
    name: agent.name,
    clientBlurb: agent.clientBlurb ?? null,
  });

  // ── What this agent has already delivered (§7.3 identity) ──
  // The attribution join, the client's delivered-work-only filter and the
  // delivery stamp all moved to agent-detail-archetypes.ts when the second and
  // third archetypes arrived (CD-I1): three page shapes asking "what did this
  // agent make" three different ways is three chances to credit a post to an
  // agent that did not write it (F147).
  const produced = agentProducedAssets({
    assets,
    jobs,
    agent: { id: agent.id, name: agent.name },
    umbrella,
    umbrellas,
    viewerIsClient,
    now,
  });

  // ── WHICH PAGE SHAPE (CD-I1) ──
  // Albert: "a logical UI for each of the agents based on what each of the
  // agents does." The archetype is resolved from the agent's identity through
  // the §7.3 idiom, and it decides the HERO only — status, archive, data,
  // connectors and feedback are the common chassis and render for all three.
  const archetype = agentArchetype({ key: agent.key, name: agent.name });

  // The agent's own weekly schedule row, unredacted, for the day projections.
  // `scheduleRows` above is the client-safe projection and deliberately drops
  // the fields projectRunOccurrences needs.
  const plannedRun =
    scheduledRuns.find(
      (run) =>
        run.customAgentId === agent.id && run.cadence === "weekly" && run.status !== "completed",
    ) ?? null;

  const clipView =
    archetype === "clip_maker"
      ? buildClipMakerView({ assets: produced, run: plannedRun, now })
      : null;

  // The finder reads the SAME produced set — its finds are assets like any
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
  // the reliable discriminator — ContextItem.kind has no "video" variant yet
  // (the other half of F150, still ops-pending), so a clip uploaded today is
  // stored as "other" and a kind check would report none on file.
  // The archive list under the hero: the rows, and what to call them. Capped
  // at 8 on every branch — this is a summary that links the Workspace, not the
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
  // Computed from the jobs already loaded — no extra read — and staff-only:
  // this is cost data, and the client's side of the same question is credits.
  const economics = isStaff
    ? summarizeAgentEconomics(jobs.filter((job) => job.customAgentId === agent.id))
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

  const setup = agentSetup[agent.id] ?? null;
  const connections = sanitizeIntegrations(integrations);
  // Platform ids for the deliverable modal's publish controls — the same
  // sanitized set the connector chips below render, never the raw integration
  // docs (which carry credentials).
  const connectedPlatformNames = connections.map((connection) => connection.platform);
  const launchInFlight = umbrella ? isLaunchInFlight(umbrella.launchState) : false;
  const agentServiceConfigured = isAgentServiceConfigured();

  // CD-H8. The run gate for the legacy shape, evaluated HERE for the same
  // reason every other gate on this surface is: a control may only offer a
  // press the server would accept (F131), and its reason has to arrive with it
  // already resolved so it can be painted rather than hidden in a tooltip on a
  // pointer-events-none button (F25). Same ladder the generic card walks —
  // service, then intake, then credits — so the two cannot disagree.
  const legacyGate = evaluateLegacyRunGate({
    serviceConfigured: agentServiceConfigured,
    setup,
    cost,
    ...(spendable !== undefined ? { availableCredits: spendable } : {}),
    creditBlockReason: creditBlockReasons[agent.id] ?? null,
  });

  // F31. The legacy branch had no run state at all: a client pressed "Create a
  // new post", the page did not change, and nothing on it refreshed — so the
  // twenty minutes the run takes were indistinguishable from the press having
  // done nothing. Resolved here rather than in the panel for the usual reason:
  // only an id and a phase cross the boundary, never the job's prompt, events
  // or asset ids.
  //
  // Attribution matches the "what it has made" join above — customAgentId is
  // authoritative, agentName keeps runs fired before that field existed. Launch
  // runs are excluded by construction: this shape has no umbrella to launch.
  //
  // ONLY A RUN THIS VIEWER STARTED. The banner this feeds says "Making your
  // next post now" and offers a Cancel whose confirm promises the credits back,
  // and it was matching ANY in-flight run on the agent — including a SCHEDULED
  // fire. Two things were wrong with that. The copy: a cron tick is not
  // something the reader just asked for, and the umbrella card next door has
  // always held the opposite line ("the one run the card acknowledges: a 'Run
  // now' the viewer just pressed" — client-agent-rows.ts), which is also the
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
            job.createdBy === user.uid &&
            (job.customAgentId === agent.id ||
              (!job.customAgentId && job.agentName === agent.name)),
        )
        .sort((a, b) => b.createdAt - a.createdAt)[0] ?? null);

  // ── THE SECTIONED LAYOUT (CD-K1) ──
  // Albert: "under each agent, everything Daniel created is there, WITH DATES,
  // categorized in sections — all inputs, all outputs, all settings." Outputs
  // already had a home (the hero and the archive under it); these are the other
  // two bands, and both are read-only projections that link the surfaces which
  // already own the writes. Building editors here would be a second write path
  // for documents that have one, which is how two screens start disagreeing
  // about the same record.
  const inputs = agentInputsView(inputDocs, setup);

  // The registry rows the FORMAT list can be opened onto. `row.templates` is
  // the viewer-redacted registry, never `umbrella.templates` — a `curating`
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
  // own side started. Exactly the two the run banners already mount. A
  // scheduled fire is deliberately excluded — it is not something the reader
  // just asked for, and saying it is running states outright that production is
  // not day-of (A3/A4). A launch in flight is excluded too: the launch card is
  // already narrating it in three phases, and a second voice would be a second
  // copy of that story to keep in step.
  const running = Boolean(row?.activeRun || legacyRun);

  // Order-independent: `produced` is sorted for a client and unsorted for
  // staff, and this line has to give the same answer to both.
  const lastDelivered = produced.reduce<number | null>((newest, asset) => {
    const at = deliverableStamp(asset, viewerIsClient);
    return newest === null || at > newest ? at : newest;
  }, null);
  const statusFacts = [
    ...(lastDelivered !== null ? [{ label: "Last delivered", at: lastDelivered }] : []),
    ...(produced.length > 0
      ? [{ label: "Delivered so far", value: String(produced.length) }]
      : []),
  ];

  return (
    <>
      {(launchInFlight || row?.activeRun || legacyRun) && <AutoRefresh />}
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

      {!agentServiceConfigured && (
        <p className="mb-4 rounded-[var(--radius)] border border-warning/30 bg-warning/10 px-4 py-3 text-sm text-warning">
          <Icon name="TriangleAlert" className="mr-1.5 inline h-4 w-4" />
          Agent runs are paused right now — starting a new post will not work until this clears. Your
          Karos team has been notified. Everything below is unaffected.
        </p>
      )}

      <div className="grid gap-6 lg:grid-cols-[minmax(0,1fr)_320px]">
        <div className="min-w-0 space-y-6">
          {/* ── STATUS (CD-K1) ──
              The header badge says the same word in the same breath, and that
              is the point: Albert's directive is about how LOUDLY the page says
              it, not whether the word appears. The strip leads the column with
              a breathing halo; the badge stays the compact form for the header
              row. Both read the SAME resolved `status`, so the rule that a
              schedule refusal outranks Live (F24/F129) cannot hold in one place
              and not the other. */}
          <AgentStatusStrip status={status} running={running} facts={statusFacts} />

          {/* ── THE ARCHETYPE HERO (CD-I1) ──
              Deliberately ABOVE the controls band. Albert asked for the clip
              maker to be deliverables-first and the finder to lead with what it
              found today, and "first" is a layout claim, not a copy one: what a
              page opens with is what it is about. The template-calendar shape
              has no separate hero — its product IS the format registry and the
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

          {finderView && (
            <DailyFinderPanel
              clientId={id}
              view={finderView}
              scheduleActive={schedule?.status === "active"}
              emptyHint={
                schedule?.status === "active"
                  ? "It looks once a day and only brings back a thread worth answering — some days there is nothing good, and a forced reply is worse than none."
                  : "Your Karos team sets how often this agent goes looking. Nothing runs until they do."
              }
            />
          )}

          {/* Hero: the launch card for a non-live umbrella (§7.1 states 1–3),
              the working agent once it is live. An agent with no umbrella at
              all has neither — it is simply not set up, and says so rather
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
          ) : status.tone === "live" ? (
            /* The legacy shape (CD-H8): no umbrella was ever bound, but a weekly
               schedule is firing — so this agent genuinely IS producing, and the
               roster and header badge it Live. It is also the flagship case, not
               an edge one: Karos Labs' own Instagram Agent predates the umbrella
               model. It used to render one sentence and nothing else, which made
               the most-looked-at agent in the portal the one with no way to make
               a post, no way to change its pace, and no sign of anything it had
               ever made. It now gets the two gestures that need no umbrella;
               templates, the week strip and notes stay umbrella-gated because
               faking them would invent streams this agent does not have. */
            <LegacyAgentPanel
              clientId={id}
              agent={summary}
              cost={spendable !== undefined ? cost : null}
              gate={legacyGate}
              schedule={schedule}
              {...(setup ? { setup } : {})}
              contextItems={contextItems}
              viewerIsClient={viewerIsClient}
              viewer={{ name: user.name, email: user.email }}
              {...(spendable !== undefined ? { availableCredits: spendable } : {})}
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
              date and links the page that owns its writes — the forms are
              REUSED, never forked. */}
          {inputs && <AgentInputsSection view={inputs} />}

          {/* ── SETTINGS (CD-K1 directive 2) ──
              What the launch run decided: the registry, the rotation, the pace,
              and when any of it last moved. Read-only by design — every field
              here already has an editor above or beside it, and the gap this
              fills is that none of those editors ever says WHEN. */}
          {setupFacts.length > 0 && <AgentSetupSection facts={setupFacts} />}

          {/* ── STAFF CONTROLS (CD-I1 staff parity) ──
              The four gestures the retired card carried — run now, set/manage
              the schedule, reach the agent's data, read why a schedule is
              refusing — mounted for the ONE agent this page is about. Placed
              under the client-facing band deliberately: staff read this page to
              see what the client sees, then act. */}
          {isStaff && (
            <StaffAgentControls
              clientId={id}
              agent={summary}
              {...(schedule ? { schedule } : {})}
              {...(setup ? { setup } : {})}
              contextItems={contextItems}
              reviewCount={reviewCount}
              reviewHref={agentRuns.find((run) => run.status === "review")?.href ?? `/clients/${id}/assets`}
              {...(lastStaffRun ? { lastRunAt: lastStaffRun.createdAt } : {})}
              viewer={{ name: user.name, email: user.email }}
            />
          )}

          {/* Where staff confirm the template set before a client ever sees it
              (the Q3 curation gate). Umbrella-only by nature — it edits the
              umbrella's registry — and never shown for an unbound agent. */}
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
                  : "Nothing else yet — everything this agent has made is above."}
              </p>
            ) : (
              <ul className="space-y-1.5">
                {archiveRows.map((asset) => (
                  <li
                    key={asset.id}
                    className="flex items-center justify-between gap-3 rounded-[var(--radius)] border border-border bg-surface-2/50 px-3 py-2"
                  >
                    <span className="min-w-0 flex-1 truncate text-xs text-foreground">
                      {asset.title || "Untitled"}
                    </span>
                    {asset.templateName && <Badge tone="neutral">{asset.templateName}</Badge>}
                    {/* The set above is already delivered-work-only for a
                        client; the STAMP has to match. `createdAt` is the
                        generation instant a whole batch shares, so eight rows
                        under "What it has made for you" all read "3 hours ago"
                        — the same batch tell the asset filter three screens up
                        was added to close. Staff keep the generation time. */}
                    <span className="shrink-0 text-[11px] text-muted-2">
                      {relativeTime(deliverableStamp(asset, viewerIsClient))}
                    </span>
                  </li>
                ))}
              </ul>
            )}
            <Link
              href={`/clients/${id}/assets`}
              className="mt-2 inline-flex items-center gap-1 text-xs text-neon hover:underline"
            >
              Open your Workspace <Icon name="ArrowRight" className="h-3 w-3" />
            </Link>
          </section>

          {/* This agent's own run history, with the /jobs links and the
              submitted prompt — the staff slice of the same list the roster
              page shows across every agent. Client viewers never mount it:
              toRunRows only fills `prompt` and `href` for staff, and this page
              only builds the rows at all when isStaff. */}
          {isStaff && agentRuns.length > 0 && (
            <AgentRunHistory runs={agentRuns} agents={[summary]} heading="This agent's runs" />
          )}
        </div>

        <aside className="space-y-6">
          {/* ── The data this agent runs on ──
              The generic card answers this with one link, which is right for
              an agent whose data is a form and wrong for both new archetypes:
              a clip maker runs on FILES, and a finder runs on a list of
              communities it is welcome in and a list it is banned from — and
              being banned somewhere is a fact a client wants to see on the
              page, not behind a link. */}
          {archetype === "clip_maker" ? (
            <SourceMaterialCard
              files={sourceFiles}
              hint={launchProfileFor({ key: agent.key, name: agent.name }).attachments.hint}
            />
          ) : archetype === "daily_finder" && setup ? (
            /* Kept even though the inputs band lists the same document: this
               card shows the ANSWERS (which communities it is welcome in, which
               it is banned from), and "did they actually record that we were
               banned from r/SEO" is not a question a dated row can answer. */
            <FinderIntakeCard
              intake={finderIntake}
              href={setup.href}
              label={setup.label}
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
                  <p className="flex-1 text-xs text-foreground">{setup.label}</p>
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
            {connections.length === 0 ? (
              <p className="rounded-[var(--radius)] border border-border bg-surface-2/50 px-3 py-2.5 text-[11px] text-muted-2">
                No accounts connected yet. Posts are delivered to your Workspace for you to publish.
              </p>
            ) : (
              <ul className="space-y-1.5">
                {connections.map((connection) => (
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
              href={`/clients/${id}/settings`}
              className="mt-2 inline-flex items-center gap-1 text-xs text-muted hover:text-foreground"
            >
              Manage connections <Icon name="ArrowRight" className="h-3 w-3" />
            </Link>
          </section>

          {/* §6.2(b), staff only: what this agent has actually cost in USD.
              It rode the umbrella card before, so it was invisible for any
              agent nobody had bound — which is most of them. Keyed off the
              lab agent rather than the umbrella now, so it appears wherever
              the runs did. */}
          {isStaff && economics && (
            <AgentEconomicsCard
              customAgentId={agent.id}
              agentName={umbrella?.displayName ?? agent.name}
              economics={economics}
              launchCreditCost={agent.launchCreditCost ?? null}
            />
          )}
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
