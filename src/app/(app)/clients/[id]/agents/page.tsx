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
import { ClientCustomAgents } from "@/components/custom-agents";
import { AutoRefresh } from "@/components/auto-refresh";
import { ReplanCalendarButton } from "@/components/replan-calendar-button";
import { LabImportButton } from "@/components/lab-import";
import { isAgentServiceConfigured } from "@/lib/agent-service/client";
import { isLabOutputsConfigured } from "@/lib/lab-outputs";
import { listClientAgents } from "@/lib/data-client-agents";
import { isLaunchInFlight } from "@/lib/client-agents";
import { umbrellaOwnsClientCard } from "@/lib/client-agent-runs";
import { ClientAgentsSection } from "@/components/client-agents/client-agents-section";
import {
  buildAgentSetup,
  scheduleZonesByAgent,
  toClientAgentRows,
  toRunRows,
  toScheduleRows,
  toSummary,
} from "@/lib/client-agent-rows";


/**
 * A client's AI Agents page. Clients can run only the custom agents that an
 * admin granted them; staff can run every enabled custom agent.
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

  // Client users: explicitly granted agents plus any agent that has already
  // delivered a successful run for this workspace.
  if (!isStaff) {
    const allowedIds = new Set(client.customAgentIds ?? []);
    const [allAgents, jobs, contextItems, credits, scheduledRuns, umbrellas] = await Promise.all([
      listCustomAgents(),
      listJobs({ clientId: id }),
      listContextItems({ clientId: id }),
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
      .filter((agent) => agent.enabled && (allowedIds.has(agent.id) || completedAgentIds.has(agent.id)))
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
    const runs = toRunRows(jobs, false).filter((r) => runnableNames.has(r.agentName));
    const clientScheduleRows = toScheduleRows(scheduledRuns, true);
    const clientAgentRows = await toClientAgentRows({
      umbrellas: ownedByUmbrella,
      agentsById: new Map(allAgents.map((a) => [a.id, a])),
      viewerIsClient: true,
      grantedAgentIds: new Set([...allowedIds, ...completedAgentIds]),
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
    return (
      <>
        {runInFlight && <AutoRefresh />}
        {/* The section below used to repeat this heading and tagline almost
            verbatim ("active AI team" / "always-on AI team"), one in Title Case
            and one in sentence case. This is the surviving one. */}
        <PageHeader
          title="AI agents"
          description="Your always-on AI team. Run an agent now, or set its weekly production pace."
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
        <ClientAgentsSection
          clientId={id}
          agents={clientAgentRows}
          viewerIsClient
          viewer={{ name: user.name, email: user.email }}
        />
        {runnableAgents.length > 0 || runs.length > 0 ? (
          <ClientCustomAgents
            clientId={id}
            agents={runnableAgents}
            runs={runs}
            schedules={clientScheduleRows}
            contextItems={contextItems}
            viewerIsClient
            agentSetup={agentSetup}
            viewer={{ name: user.name, email: user.email }}
            {...(spendable !== undefined ? { availableCredits: spendable } : {})}
            creditBlockReasons={creditBlockReasons}
          />
        ) : clientAgentRows.length > 0 ? null : (
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

  // (The jobPreviews block that used to live here fed <ManagedProducts />,
  // which nothing imported — it read every managed asset for this client on
  // every page load and handed the result to no one. Removed with F39/F45.)

  const staffAgents = customAgents.filter((a) => a.enabled).map(toSummary);
  const agentSetup = await buildAgentSetup(id, staffAgents);
  const staffRuns = toRunRows(jobs, true);
  // Staff see every umbrella in every state (including live) — this is where
  // the launch is fired for a client who cannot yet self-serve, and where the
  // template set is curated before the client ever sees it.
  const staffScheduleRows = toScheduleRows(scheduledRuns, false);
  const staffAgentRows = await toClientAgentRows({
    umbrellas,
    agentsById: new Map(customAgents.map((a) => [a.id, a])),
    viewerIsClient: false,
    grantedAgentIds: null,
    agentSetup,
    creditBlockReasons: {},
    scheduleRows: staffScheduleRows,
    scheduleZones: scheduleZonesByAgent(scheduledRuns),
    jobs,
    viewerUid: user.uid,
    viewerIsStaff: true,
    now: Date.now(),
  });
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
            viewer={{ name: user.name, email: user.email }}
          />
        </>
      )}
    </>
  );
}
