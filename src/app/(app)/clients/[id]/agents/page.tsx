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
  type RunnableAgentSummary,
} from "@/components/custom-agents";
import { AutoRefresh } from "@/components/auto-refresh";
import { ReplanCalendarButton } from "@/components/replan-calendar-button";
import { LabImportButton } from "@/components/lab-import";
import { isAgentServiceConfigured } from "@/lib/agent-service/client";
import { hasXAgentIntake } from "@/lib/agent-service/x-agent-context";
import { hasLinkedInAgentIntake } from "@/lib/agent-service/linkedin-agent-context";
import { clientSafeRefusal, isLinkedInAgentIdentity, isXAgentIdentity } from "@/lib/custom-agent-launch";
import type { AgentSetupState } from "@/components/custom-agents";
import { isLabOutputsConfigured } from "@/lib/lab-outputs";
import type { CustomAgent, Job } from "@/lib/types";
import type { ClientAgentScheduleRow } from "@/components/custom-agents";

/** Strip an agent to the client-safe summary — never the instructions/skill paths. */
function toSummary(agent: CustomAgent): RunnableAgentSummary {
  return {
    id: agent.id,
    key: agent.key,
    name: agent.name,
    description: agent.description,
    clientBlurb: agent.clientBlurb ?? null,
    icon: agent.icon,
    color: agent.color,
    creditCost: agent.creditCost ?? null,
  };
}

/**
 * Custom-agent runs as slim rows. `staff` adds the /jobs link target AND the
 * submitted prompt: the raw request is an operator's free text (typos, stray
 * capitals) and never belongs in a client's run history, so it is dropped here
 * at the RSC boundary rather than hidden at render.
 */
function toRunRows(jobs: Job[], staff: boolean): CustomAgentRunRow[] {
  return jobs
    .filter((j) => j.agentId === "agent-service" && j.external?.taskType === "custom")
    .sort((a, b) => b.createdAt - a.createdAt)
    .slice(0, 8)
    .map((j) => ({
      id: j.id,
      agentName: j.agentName,
      status: j.status,
      createdAt: j.createdAt,
      assetCount: j.assetIds.length,
      ...(staff && j.input.prompt ? { prompt: j.input.prompt } : {}),
      ...(staff ? { href: `/jobs/${j.id}` } : {}),
    }));
}

/**
 * `viewerIsClient` decides what the refusal may say. The redaction happens HERE,
 * not at render: everything on a ClientAgentScheduleRow is serialized into the
 * RSC payload the browser receives, so a raw internal string handed to a client
 * component is readable whether or not it is ever painted.
 */
function toScheduleRows(
  runs: Awaited<ReturnType<typeof listPlannedScheduledRuns>>,
  viewerIsClient: boolean,
): ClientAgentScheduleRow[] {
  return runs
    .filter((run) => run.cadence === "weekly" && run.status !== "completed")
    .map((run) => ({
      id: run.id,
      agentId: run.customAgentId,
      status: run.status === "paused" ? "paused" : "active",
      postsPerWeek: run.weekdays?.length ?? 1,
      outputsPerRun: run.outputsPerRun ?? 1,
      nextRunAt: run.nextRunAt,
      prompt: run.prompt,
      hour: run.hour,
      minute: run.minute,
      // The scheduler's refusal, so a schedule that can never fire stops
      // rendering as a healthy "Live" agent.
      lastError: run.lastError
        ? viewerIsClient
          ? clientSafeRefusal(run.lastError)
          : run.lastError
        : null,
      lastErrorAt: run.lastErrorAt ?? null,
    }));
}

/**
 * Intake readiness, resolved once per agent with the SAME call the submit core
 * makes (submitCustomAgentJob → hasXAgentIntake / hasLinkedInAgentIntake). The
 * LinkedIn check answers differently per agent key — the multi-seat agent runs
 * on any stored intake, the company-page agents need the company form — so a
 * single shared flag would block agents the server would run, and a card cannot
 * derive this from the key alone.
 */
async function buildAgentSetup(
  clientId: string,
  agents: Array<{ id: string; key: string }>,
): Promise<Record<string, AgentSetupState>> {
  const resolved = await Promise.all(
    agents.map(async (agent): Promise<[string, AgentSetupState] | null> => {
      if (isXAgentIdentity(agent.key)) {
        return [
          agent.id,
          {
            ready: await hasXAgentIntake(clientId),
            href: `/clients/${clientId}/x-agent`,
            label: "X agent data",
          },
        ];
      }
      if (isLinkedInAgentIdentity(agent.key)) {
        return [
          agent.id,
          {
            ready: await hasLinkedInAgentIntake(clientId, agent.key),
            href: `/clients/${clientId}/linkedin-agent`,
            label: "LinkedIn agent data",
          },
        ];
      }
      return null;
    }),
  );
  return Object.fromEntries(resolved.filter((entry): entry is [string, AgentSetupState] => entry !== null));
}

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
    const [allAgents, jobs, contextItems, credits, scheduledRuns] = await Promise.all([
      listCustomAgents(),
      listJobs({ clientId: id }),
      listContextItems({ clientId: id }),
      getClientCredits(id),
      listPlannedScheduledRuns({ clientId: id }),
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
    // Client viewers see only runs of agents they're allowed — not the
    // history of staff-fired agents outside their allowlist.
    const allowedNames = new Set(agents.map((a) => a.name));
    const runs = toRunRows(jobs, false).filter((r) => allowedNames.has(r.agentName));
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
    // A client run takes 10–20 minutes and the client's rows carry no link, so
    // without this the page never moved again after "Start run". Mounted only
    // while something is actually in flight; it unmounts when the server
    // renders a terminal status.
    const runInFlight = runs.some((run) => run.status === "queued" || run.status === "running");
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
        {agents.length > 0 ? (
          <ClientCustomAgents
            clientId={id}
            agents={agents}
            runs={runs}
            schedules={toScheduleRows(scheduledRuns, true)}
            contextItems={contextItems}
            viewerIsClient
            agentSetup={agentSetup}
            viewer={{ name: user.name, email: user.email }}
            {...(spendable !== undefined ? { availableCredits: spendable } : {})}
            creditBlockReasons={creditBlockReasons}
          />
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

  const [jobs, contextItems, customAgents, scheduledRuns] = await Promise.all([
    listJobs({ clientId: id }),
    listContextItems({ clientId: id }),
    listCustomAgents(),
    listPlannedScheduledRuns({ clientId: id }),
  ]);

  // (The jobPreviews block that used to live here fed <ManagedProducts />,
  // which nothing imported — it read every managed asset for this client on
  // every page load and handed the result to no one. Removed with F39/F45.)

  const staffAgents = customAgents.filter((a) => a.enabled).map(toSummary);
  const agentSetup = await buildAgentSetup(id, staffAgents);
  const staffRuns = toRunRows(jobs, true);
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
      {!agentServiceConfigured ? (
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
        <ClientCustomAgents
          clientId={id}
          agents={staffAgents}
          runs={staffRuns}
          schedules={toScheduleRows(scheduledRuns, false)}
          contextItems={contextItems}
          viewerIsClient={false}
          agentSetup={agentSetup}
          viewer={{ name: user.name, email: user.email }}
        />
      )}
    </>
  );
}
