import { notFound, redirect } from "next/navigation";
import { requireUser } from "@/lib/auth";
import {
  getClient,
  getClientCredits,
  listAssets,
  listClientIntegrations,
  listContextItems,
  listCustomAgents,
  listJobs,
} from "@/lib/data";
import { availableCredits, isBillableClientActor } from "@/lib/credits";
import { ClientHome } from "@/components/client-home";
import {
  type CustomAgentRunRow,
  type RunnableAgentSummary,
} from "@/components/custom-agents";
import { isAgentServiceConfigured } from "@/lib/agent-service/client";
import type { CustomAgent, Job } from "@/lib/types";

/** Strip an agent to the client-safe summary — never the instructions/skill paths. */
function toSummary(agent: CustomAgent): RunnableAgentSummary {
  return {
    id: agent.id,
    name: agent.name,
    description: agent.description,
    icon: agent.icon,
    color: agent.color,
    creditCost: agent.creditCost ?? null,
  };
}

/** Custom-agent runs as slim rows; `withLinks` adds staff-only /jobs targets. */
function toRunRows(jobs: Job[], withLinks: boolean): CustomAgentRunRow[] {
  return jobs
    .filter((j) => j.agentId === "agent-service" && j.external?.taskType === "custom")
    .sort((a, b) => b.createdAt - a.createdAt)
    .slice(0, 8)
    .map((j) => ({
      id: j.id,
      agentName: j.agentName,
      status: j.status,
      createdAt: j.createdAt,
      ...(j.input.prompt ? { prompt: j.input.prompt } : {}),
      ...(withLinks ? { href: `/jobs/${j.id}` } : {}),
    }));
}

export default async function ClientDetailPage({ params }: { params: Promise<{ id: string }> }) {
  const user = await requireUser();
  const { id } = await params;

  // CLIENT_USER may only view their own account.
  if (user.role === "CLIENT_USER") {
    if (user.clientId !== id) redirect(user.clientId ? `/clients/${user.clientId}` : "/assets");
  } else if (user.role !== "KAROS_ADMIN" && user.role !== "KAROS_EMPLOYEE") {
    redirect("/dashboard");
  }

  const client = await getClient(id);
  if (!client) notFound();

  const isStaff = user.role === "KAROS_ADMIN" || user.role === "KAROS_EMPLOYEE";
  const viewerIsClient = !isStaff;
  const agentServiceConfigured = isAgentServiceConfigured();

  const [jobs, assets, integrations, contextItems] = await Promise.all([
    listJobs({ clientId: id }),
    listAssets({ clientId: id }),
    listClientIntegrations(id),
    listContextItems({ clientId: id }),
  ]);

  // Runnable-agent set differs by viewer: staff see the whole enabled library;
  // clients see only the agents an admin granted them (and are billed per run).
  let agents: RunnableAgentSummary[] = [];
  let runs: CustomAgentRunRow[] = [];
  let hasGrantedAgents = false;
  let spendable: number | undefined;

  if (isStaff) {
    const customAgents = await listCustomAgents();
    agents = customAgents.filter((a) => a.enabled).map(toSummary);
    runs = toRunRows(jobs, true);
  } else {
    const allowedIds = new Set(client.customAgentIds ?? []);
    hasGrantedAgents = allowedIds.size > 0;
    const [allAgents, credits] = await Promise.all([
      hasGrantedAgents ? listCustomAgents() : Promise.resolve([]),
      getClientCredits(id),
    ]);
    agents = allAgents.filter((a) => a.enabled && allowedIds.has(a.id)).map(toSummary);
    const allowedNames = new Set(agents.map((a) => a.name));
    runs = toRunRows(jobs, false).filter((r) => allowedNames.has(r.agentName));
    // Impersonating admins see the client view but never spend real credits.
    spendable = isBillableClientActor(user) ? availableCredits(credits) : undefined;
  }

  const greetingTitle = viewerIsClient ? `Hi ${user.name.split(" ")[0]}` : client.name;
  const greetingSubtitle = viewerIsClient
    ? "Run an agent, or pick up where your team left off."
    : "Client workspace — run agents and track deliverables.";

  return (
    <ClientHome
      clientId={id}
      greetingTitle={greetingTitle}
      greetingSubtitle={greetingSubtitle}
      viewerIsClient={viewerIsClient}
      isStaff={isStaff}
      agentServiceConfigured={agentServiceConfigured}
      hasGrantedAgents={hasGrantedAgents}
      customAgents={agents}
      customRuns={runs}
      contextItems={contextItems}
      {...(spendable !== undefined ? { availableCredits: spendable } : {})}
      jobs={jobs}
      assets={assets}
      integrations={integrations}
    />
  );
}
