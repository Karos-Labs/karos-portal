import { notFound, redirect } from "next/navigation";
import { requireUser } from "@/lib/auth";
import {
  getAsset,
  getClient,
  getClientCredits,
  listContextItems,
  listCustomAgents,
  listJobs,
  listPlannedScheduledRuns,
} from "@/lib/data";
import { availableCredits, creditBlockReason, isBillableClientActor } from "@/lib/credits";
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
import { AGENT_SERVICE_AGENT_ID } from "@/lib/agent-service/products";
import { assetImages } from "@/lib/asset-images";
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
    // show the gate only to billable client actors.
    const spendable = isBillableClientActor(user) ? availableCredits(credits) : undefined;
    // Which of the three limits clips that number. The card shows it beside a
    // blocked Run button: "ask for a top-up" is wrong advice for a client who
    // is capped for the week, and the correct wording existed only in the
    // denial text that appears after a run has already been refused.
    const creditBlock = spendable !== undefined ? creditBlockReason(credits) : undefined;
    const agentSetup = await buildAgentSetup(id, agents);
    // A client run takes 10–20 minutes and the client's rows carry no link, so
    // without this the page never moved again after "Start run". Mounted only
    // while something is actually in flight; it unmounts when the server
    // renders a terminal status.
    const runInFlight = runs.some((run) => run.status === "queued" || run.status === "running");
    return (
      <>
        {runInFlight && <AutoRefresh />}
        <PageHeader
          title="AI Agents"
          description="Your active AI team—run agents now or set their weekly production pace."
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
            {...(creditBlock !== undefined ? { creditBlockReason: creditBlock } : {})}
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

  // Thumbnail previews of what the managed agents have actually delivered, so
  // the "Live" view can show the formats a running agent produces. Keyed by
  // jobId → the first few image URLs across that run's deliverable assets.
  const managedAssetIds = Array.from(
    new Set(
      jobs
        .filter((j) => j.agentId === AGENT_SERVICE_AGENT_ID)
        .flatMap((j) => j.assetIds),
    ),
  );
  const managedAssets = await Promise.all(managedAssetIds.map((aid) => getAsset(aid)));
  const assetById = new Map(managedAssets.filter(Boolean).map((a) => [a!.id, a!]));
  const jobPreviews: Record<string, string[]> = {};
  for (const job of jobs) {
    if (job.agentId !== AGENT_SERVICE_AGENT_ID) continue;
    const urls = job.assetIds
      .map((aid) => assetById.get(aid))
      .filter(Boolean)
      .flatMap((a) => assetImages(a!).map((img) => img.url));
    if (urls.length > 0) jobPreviews[job.id] = urls.slice(0, 6);
  }

  const staffAgents = customAgents.filter((a) => a.enabled).map(toSummary);
  const agentSetup = await buildAgentSetup(id, staffAgents);

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
      {agentServiceConfigured ? (
        <ClientCustomAgents
          clientId={id}
          agents={staffAgents}
          runs={toRunRows(jobs, true)}
          schedules={toScheduleRows(scheduledRuns, false)}
          contextItems={contextItems}
          viewerIsClient={false}
          agentSetup={agentSetup}
          viewer={{ name: user.name, email: user.email }}
        />
      ) : (
        <EmptyState
          icon={<Icon name="Bot" className="h-7 w-7" />}
          title="Agent service not configured"
          description="Run controls are unavailable until the agent-service environment variables are set. Existing deliverables and calendars above are unaffected."
        />
      )}
    </>
  );
}
