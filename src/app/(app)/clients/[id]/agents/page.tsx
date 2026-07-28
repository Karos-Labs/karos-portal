import { notFound, redirect } from "next/navigation";
import { requireUser } from "@/lib/auth";
import {
  getClient,
  getClientCredits,
  listContextItems,
  listCustomAgents,
  listJobs,
  listPlannedScheduledRuns,
} from "@/lib/data";
import { availableCredits, creditBlockReason, CREDIT_COSTS, isBillableClientActor } from "@/lib/credits";
import { EmptyState, PageHeader } from "@/components/ui";
import { Icon } from "@/components/icon";
import {
  ClientCustomAgents,
  type CustomAgentRunRow,
  type LinkedInAgentSetup,
  type RedditAgentSetup,
  type RunnableAgentSummary,
  type XAgentSetup,
} from "@/components/custom-agents";
import { AutoRefresh } from "@/components/auto-refresh";
import { ReplanCalendarButton } from "@/components/replan-calendar-button";
import { LabImportButton } from "@/components/lab-import";
import { isAgentServiceConfigured } from "@/lib/agent-service/client";
import {
  buildLinkedInAgentIntakeView,
  buildRedditAgentIntakeView,
  buildXAgentIntakeView,
} from "@/lib/agent-intake-views";
import {
  agentKeyMatchesClientSlug,
  isLinkedInAgentIdentity,
  isRedditAgentIdentity,
  isXAgentIdentity,
} from "@/lib/custom-agent-launch";
import { isLabOutputsConfigured } from "@/lib/lab-outputs";
import { clientAgentBlurb } from "@/lib/agent-blurbs";
import { summarizeAgentEconomics } from "@/lib/credit-reporting";
import { listClientAgents } from "@/lib/data-client-agents";
import { isLaunchInFlight, rosterStatus } from "@/lib/client-agents";
import { umbrellaOwnsClientCard } from "@/lib/client-agent-runs";
import { ClientAgentsSection } from "@/components/client-agents/client-agents-section";
import { ClientAgentRoster, type AgentRosterEntry } from "@/components/client-agents/roster";
import {
  buildAgentSetup,
  scheduleZonesByAgent,
  toClientAgentRows,
  toRunRows,
  toScheduleRows,
  toSummary,
} from "@/lib/client-agent-rows";
import type { Job } from "@/lib/types";


/**
 * Setup props for the intake-driven agents (X e13, LinkedIn e10): their data
 * forms live in the run dialog, so the payload ships with the ready flag.
 * Building one costs a full read of seats, intake, drops and run history, so it
 * only happens when that agent is actually on this page's list, and it reuses
 * the caller's `jobs` scan rather than repeating it per agent.
 */
async function intakeSetups(
  clientId: string,
  agents: RunnableAgentSummary[],
  opts: { isStaff: boolean; jobs: Job[]; linkedinPageUrl?: string },
): Promise<{
  xSetup?: XAgentSetup;
  linkedinSetup?: LinkedInAgentSetup;
  redditSetup?: RedditAgentSetup;
}> {
  const hasX = agents.some((agent) => isXAgentIdentity(agent.key));
  const hasLinkedIn = agents.some((agent) => isLinkedInAgentIdentity(agent.key));
  const hasReddit = agents.some((agent) => isRedditAgentIdentity(agent.key));
  const [xData, linkedinData, redditData] = await Promise.all([
    hasX ? buildXAgentIntakeView(clientId, { isStaff: opts.isStaff, jobs: opts.jobs }) : null,
    hasLinkedIn
      ? buildLinkedInAgentIntakeView(clientId, {
          isStaff: opts.isStaff,
          jobs: opts.jobs,
          ...(opts.linkedinPageUrl ? { pageUrlSuggestion: opts.linkedinPageUrl } : {}),
        })
      : null,
    hasReddit ? buildRedditAgentIntakeView(clientId, { isStaff: opts.isStaff, jobs: opts.jobs }) : null,
  ]);
  // `ready` must agree with the run gates the submit cores apply, so it is read
  // off the same row those gates read instead of asking them again:
  // hasXAgentIntake(), hasLinkedInAgentIntake() and hasRedditAgentIntake() all
  // mean "the company-level form is saved" — respectively
  // agentIntake(clientId, "x"|"linkedin"|"reddit", null) — for every one of
  // their agents' keys. Reddit's company-level form is the account form, and
  // like the other two a shared ClientSeat never satisfies it.
  return {
    ...(xData
      ? {
          xSetup: { ready: xData.company !== null, data: xData },
        }
      : {}),
    ...(linkedinData
      ? {
          linkedinSetup: { ready: linkedinData.company !== null, data: linkedinData },
        }
      : {}),
    ...(redditData
      ? {
          redditSetup: { ready: redditData.company !== null, data: redditData },
        }
      : {}),
  };
}

/**
 * A client's AI Agents page. Clients can run only the custom agents that an
 * admin granted them; staff can run every enabled custom agent. Neither list
 * may include a per-client agent instance belonging to a different client —
 * its skill is baked under that client's lab folder, so a run here would draft
 * the wrong company. Both branches filter on agentKeyMatchesClientSlug, and
 * the submit core refuses a mismatched pair regardless of how it was launched.
 */
export default async function ClientAgentsPage({ params }: { params: Promise<{ id: string }> }) {
  const user = await requireUser();
  const { id } = await params;

  if (user.role === "CLIENT_USER") {
    if (user.clientId !== id) redirect(user.clientId ? `/clients/${user.clientId}` : "/assets");
  } else if (user.role !== "KAROS_ADMIN" && user.role !== "KAROS_EMPLOYEE") {
    redirect("/dashboard");
  }

  const client = await getClient(id);
  if (!client) notFound();

  const isStaff = user.role === "KAROS_ADMIN" || user.role === "KAROS_EMPLOYEE";
  const agentServiceConfigured = isAgentServiceConfigured();
  const linkedinPageUrl = client.socialLinks?.linkedin;

  // Client users: explicitly granted agents plus any agent that has already
  // delivered a successful run for this workspace.
  if (!isStaff) {
    const allowedIds = new Set(client.customAgentIds ?? []);
    // No listContextItems here any more: it fed the generic run dialog's
    // attachment picker, and a client's run gesture has moved to the detail
    // page (CD-G1). The roster reads nothing from it, so the roster no longer
    // pays for it.
    const [allAgents, jobs, credits, scheduledRuns, umbrellas] = await Promise.all([
      listCustomAgents(),
      listJobs({ clientId: id }),
      getClientCredits(id),
      listPlannedScheduledRuns({ clientId: id }),
      listClientAgents({ clientId: id }),
    ]);
    const successful = new Set(["review", "approved", "delivered"]);
    const agentIdByName = new Map(allAgents.map((agent) => [agent.name, agent.id]));
    const completedAgentIds = new Set(
      jobs
        .filter((job) => job.external?.taskType === "custom" && successful.has(job.status))
        .map((job) => job.customAgentId ?? agentIdByName.get(job.agentName))
        .filter((agentId): agentId is string => Boolean(agentId)),
    );
    const agents = allAgents
      .filter(
        (agent) =>
          agent.enabled &&
          (allowedIds.has(agent.id) || completedAgentIds.has(agent.id)) &&
          // The binding wins over both routes in: a grant and an inherited
          // delivered run are equally unable to move an instance off its client.
          agentKeyMatchesClientSlug(agent.key, client.agentsRepoSlug),
      )
      .map(toSummary);
    // Impersonating admins see the client view but never spend real credits —
    // show the gate only to billable client actors. `now` rolls the spend
    // windows on read: a schedule doc read after a week rollover would otherwise
    // still count last week's spend and mis-name the limit.
    const now = Date.now();
    const spendable = isBillableClientActor(user) ? availableCredits(credits, now) : undefined;
    // Which limit clips that number — computed PER AGENT, because the binding
    // limit depends on the agent's price (F130 gives agents distinct costs): a
    // cheap agent may be blocked by the weekly cap while a pricey one is blocked
    // by the balance, and each must name the limit its own denial would. The
    // card shows it beside a blocked Run button, where "ask for a top-up" is
    // wrong advice for a client who is capped for the week.
    const creditBlockReasons: Record<string, string> = {};
    if (spendable !== undefined) {
      for (const agent of agents) {
        const cost = agent.creditCost ?? CREDIT_COSTS.customAgentRun;
        if (spendable < cost) creditBlockReasons[agent.id] = creditBlockReason(credits, cost, now);
      }
    }
    const agentSetup = await buildAgentSetup(id, agents);
    // ── Card selection: exactly one card per agent ──
    // An umbrella owns its agent's card as soon as it is bound — the launch
    // card while it is being set up, the live card once it is producing. The
    // agent is dropped from the generic run cards below, so a client is never
    // offered a Run button beside a "not set up yet" state, and never sees the
    // same agent twice under two identities.
    //
    // The one exception is deliberate (`umbrellaOwnsClientCard`): a LIVE
    // umbrella with no templates yet — the grandfathered bind of an
    // already-producing agent — keeps today's card, because replacing a working
    // Run button with a card that has no rows in it is the F131 failure with
    // the roles reversed.
    const ownedByUmbrella = umbrellas.filter((u) => umbrellaOwnsClientCard(u));
    const ownedAgentIds = new Set(ownedByUmbrella.map((u) => u.customAgentId));
    const runnableAgents = agents.filter((agent) => !ownedAgentIds.has(agent.id));
    // Client viewers see only runs of agents they're allowed — not the history
    // of staff-fired agents outside their allowlist, and (§4.1 item 3) not the
    // batch rows of an umbrella-owned agent: "ran 2 hours ago · 7 drafts" beside
    // a week of daily slots is the tell that the days are a presentation of a
    // batch. Staff rows are unchanged.
    const runnableNames = new Set(runnableAgents.map((a) => a.name));
    // Still filtered on the STORED name (that is the join to the runnable set);
    // what each row prints is its resolved §7.3 identity (F147).
    const runs = toRunRows(jobs, false, umbrellas).filter((r) => runnableNames.has(r.agentName));
    const clientScheduleRows = toScheduleRows(scheduledRuns, true);
    const clientAgentRows = await toClientAgentRows({
      umbrellas: ownedByUmbrella,
      agentsById: new Map(allAgents.map((a) => [a.id, a])),
      viewerIsClient: true,
      grantedAgentIds: new Set([...allowedIds, ...completedAgentIds]),
      clientSlug: client.agentsRepoSlug,
      agentSetup,
      ...(spendable !== undefined ? { spendable } : {}),
      creditBlockReasons,
      scheduleRows: clientScheduleRows,
      scheduleZones: scheduleZonesByAgent(scheduledRuns),
      jobs,
      viewerUid: user.uid,
      viewerIsStaff: false,
      now,
    });
    // A client run takes 10–20 minutes and the client's rows carry no link, so
    // without this the page never moved again after "Start run". Mounted only
    // while something is actually in flight; it unmounts when the server
    // renders a terminal status. A setup run in flight moves the launch card
    // the same way — it is the same medicine for a longer wait.
    const runInFlight =
      runs.some((run) => run.status === "queued" || run.status === "running") ||
      umbrellas.some((u) => isLaunchInFlight(u.launchState)) ||
      // An umbrella agent has no run row to watch any more, so its in-flight
      // template run has to be what moves the page.
      clientAgentRows.some((row) => row.activeRun !== null);
    // ── The roster (CD-G1) ──
    // One card per GRANTED agent, umbrella-bound or not, carrying a mark, a
    // name, one line of what it gives you and one status word. No Run button
    // anywhere: a client's run gesture lives only inside a detail page, beside
    // the context that explains what it costs and produces.
    //
    // Built from the agent list rather than from the umbrellas, because a
    // client's roster is "the agents I have", not "the agents someone has bound
    // an umbrella for". An agent with no umbrella is not missing from the
    // roster — it is simply not set up yet, and says so.
    const umbrellaByAgentId = new Map(ownedByUmbrella.map((u) => [u.customAgentId, u]));
    const scheduleByAgentId = new Map(clientScheduleRows.map((row) => [row.agentId, row]));
    const rosterEntries: AgentRosterEntry[] = agents.map((agent) => {
      const umbrella = umbrellaByAgentId.get(agent.id) ?? null;
      const schedule = scheduleByAgentId.get(agent.id) ?? null;
      return {
        customAgentId: agent.id,
        identity: `${agent.key} ${agent.name}`,
        icon: agent.icon ?? null,
        displayName: umbrella?.displayName ?? agent.name,
        blurb: clientAgentBlurb({
          key: agent.key,
          name: agent.name,
          clientBlurb: agent.clientBlurb ?? null,
        }),
        status: rosterStatus({
          launchState: umbrella?.launchState ?? null,
          // Already client-redacted by toScheduleRows. A refusal outranks
          // "Live" (F24/F129) — an agent whose every fire is turned away is
          // not live, whatever its umbrella says.
          scheduleRefusal: schedule?.status === "active" ? schedule.lastError : null,
          scheduleActive: schedule?.status === "active",
        }),
      };
    });

    return (
      <>
        {runInFlight && <AutoRefresh />}
        {/* The section below used to repeat this heading and tagline almost
            verbatim ("active AI team" / "always-on AI team"), one in Title Case
            and one in sentence case. This is the surviving one. */}
        <PageHeader
          title="AI agents"
          description="Your always-on AI team. Open an agent to see what it makes and to start a post."
        />
        {/* Two different conditions used to share the never-set-up empty state,
            so an outage or a bad deploy told a client with three live agents
            and a run history that they had never been set up. Only an empty
            allowlist gets that copy now; an unconfigured service keeps the
            agents, schedules and history on screen behind an honest notice. */}
        {agents.length > 0 && !agentServiceConfigured && (
          <p className="mb-4 rounded-[var(--radius)] border border-warning/30 bg-warning/10 px-4 py-3 text-sm text-warning">
            <Icon name="TriangleAlert" className="mr-1.5 inline h-4 w-4" />
            Agent runs are paused right now — starting a new run will not work until this clears.
            Your Karos team has been notified. Everything below is unaffected.
          </p>
        )}
        {rosterEntries.length > 0 ? (
          <ClientAgentRoster clientId={id} entries={rosterEntries} />
        ) : (
          <EmptyState
            icon={<Icon name="Bot" className="h-7 w-7" />}
            title="No active agents yet"
            description="After your Karos team completes the first agent run, that agent will appear here."
          />
        )}
      </>
    );
  }

  const [jobs, contextItems, customAgents, scheduledRuns, umbrellas] = await Promise.all([
    listJobs({ clientId: id }),
    listContextItems({ clientId: id }),
    listCustomAgents(),
    listPlannedScheduledRuns({ clientId: id }),
    listClientAgents({ clientId: id }),
  ]);
  const enabledAgents = customAgents
    .filter((a) => a.enabled && agentKeyMatchesClientSlug(a.key, client.agentsRepoSlug))
    .map(toSummary);

  // (The jobPreviews block that used to live here fed <ManagedProducts />,
  // which nothing imported — it read every managed asset for this client on
  // every page load and handed the result to no one. Removed with F39/F45.
  // origin/main rebuilt it in the same shape and likewise passes it to nobody,
  // so it stays removed: it is one getAsset per managed deliverable per page
  // load, for a value with no reader.)

  // Ruling 7: the inline intake panes serve the STAFF dialog. The client's own
  // route reaches the same forms through AgentSetupState.href, so this read
  // happens on the staff branch only.
  const setups = await intakeSetups(id, enabledAgents, {
    isStaff,
    jobs,
    ...(linkedinPageUrl ? { linkedinPageUrl } : {}),
  });

  const staffAgents = customAgents.filter((a) => a.enabled).map(toSummary);
  const agentSetup = await buildAgentSetup(id, staffAgents);
  const staffRuns = toRunRows(jobs, true, umbrellas);
  // Staff see every umbrella in every state (including live) — this is where
  // the launch is fired for a client who cannot yet self-serve, and where the
  // template set is curated before the client ever sees it.
  const staffScheduleRows = toScheduleRows(scheduledRuns, false);
  const staffAgentRows = await toClientAgentRows({
    umbrellas,
    agentsById: new Map(customAgents.map((a) => [a.id, a])),
    viewerIsClient: false,
    grantedAgentIds: null,
    clientSlug: client.agentsRepoSlug,
    agentSetup,
    creditBlockReasons: {},
    scheduleRows: staffScheduleRows,
    scheduleZones: scheduleZonesByAgent(scheduledRuns),
    jobs,
    viewerUid: user.uid,
    viewerIsStaff: true,
    now: Date.now(),
  });
  // §6.2(b). USD this client has spent per bound agent, split by run type.
  // Computed from the jobs already loaded above — no extra read — and staff-only:
  // it is passed to the staff branch of the section and nowhere else.
  const agentById = new Map(customAgents.map((a) => [a.id, a]));
  const jobsByAgent = new Map<string, typeof jobs>();
  for (const job of jobs) {
    if (!job.customAgentId) continue;
    const bucket = jobsByAgent.get(job.customAgentId);
    if (bucket) bucket.push(job);
    else jobsByAgent.set(job.customAgentId, [job]);
  }
  const economicsByAgent: Record<
    string,
    { economics: ReturnType<typeof summarizeAgentEconomics>; launchCreditCost: number | null }
  > = {};
  for (const umbrella of umbrellas) {
    const agent = agentById.get(umbrella.customAgentId);
    if (!agent) continue;
    economicsByAgent[umbrella.customAgentId] = {
      economics: summarizeAgentEconomics(jobsByAgent.get(umbrella.customAgentId) ?? []),
      launchCreditCost: agent.launchCreditCost ?? null,
    };
  }

  const boundAgentIds = new Set(umbrellas.map((u) => u.customAgentId));
  const bindable = customAgents
    .filter((a) => a.enabled && !boundAgentIds.has(a.id))
    .map((a) => ({ id: a.id, name: a.name }));
  const launchInFlight = umbrellas.some((u) => isLaunchInFlight(u.launchState));
  // ClientCustomAgents renders nothing at all with no agents and no history, so
  // a brand-new client showed staff a header and then white space to the bottom
  // of the viewport — no cards, no empty state, no next action.
  const nothingToShow = staffAgents.length === 0 && staffRuns.length === 0;

  return (
    <>
      <PageHeader
        title="AI Agents"
        description="Run custom AI agents for this client and track their deliverables."
        action={
          <div className="flex items-center gap-3">
            {isLabOutputsConfigured() && <LabImportButton clientId={id} />}
            <ReplanCalendarButton clientId={id} />
            <a
              href={`/clients/${id}/settings`}
              className="inline-flex items-center gap-1.5 text-xs text-muted hover:text-foreground"
            >
              Manage integrations →
            </a>
          </div>
        }
      />
      {/* An unconfigured service must NOT hide the roster. F34's banner above
          says "everything below is unaffected", and replacing the whole grid
          with an empty state made that a lie — the client's granted agents,
          their schedules and their run history simply vanished. The banner
          carries the outage; the cards stay, with their run controls disabled
          by the same readiness gate that already handles setup and credits. */}
      {nothingToShow && !agentServiceConfigured ? (
        <EmptyState
          icon={<Icon name="Bot" className="h-7 w-7" />}
          title="Agent service not configured"
          description="Run controls are unavailable until the agent-service environment variables are set. Existing deliverables and calendars above are unaffected."
        />
      ) : nothingToShow ? (
        <EmptyState
          icon={<Icon name="Bot" className="h-7 w-7" />}
          title="No agents available for this client yet"
          description={
            client.agentsRepoSlug
              ? "No custom agent in the library is enabled, so there is nothing to run here. Import or enable one on the Agents page."
              : "No custom agent in the library is enabled, so there is nothing to run here. Import or enable one on the Agents page — and set this client's lab-repo slug in Settings, or runs go out without their client context."
          }
          action={
            <div className="flex flex-wrap items-center justify-center gap-3">
              <a href="/agents" className="text-xs text-neon hover:underline">
                Import or enable an agent →
              </a>
              {!client.agentsRepoSlug && (
                <a href={`/clients/${id}/settings`} className="text-xs text-muted hover:text-foreground">
                  Set the lab-repo slug →
                </a>
              )}
            </div>
          }
        />
      ) : (
        <>
          {launchInFlight && <AutoRefresh />}
          <ClientAgentsSection
            clientId={id}
            agents={staffAgentRows}
            viewerIsClient={false}
            bindable={bindable}
            economics={economicsByAgent}
            viewer={{ name: user.name, email: user.email }}
          />
          <ClientCustomAgents
            clientId={id}
            agents={staffAgents}
            runs={staffRuns}
            schedules={staffScheduleRows}
            contextItems={contextItems}
            viewerIsClient={false}
            agentSetup={agentSetup}
            {...setups}
            viewer={{ name: user.name, email: user.email }}
          />
        </>
      )}
    </>
  );
}
