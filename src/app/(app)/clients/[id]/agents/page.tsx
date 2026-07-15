import { notFound, redirect } from "next/navigation";
import Link from "next/link";
import { requireUser } from "@/lib/auth";
import {
  getAsset,
  getClient,
  getClientCredits,
  listContextItems,
  listCustomAgents,
  listJobs,
} from "@/lib/data";
import { availableCredits, isBillableClientActor } from "@/lib/credits";
import { assetImages } from "@/lib/asset-images";
import { AGENT_SERVICE_AGENT_ID } from "@/lib/agent-service/products";
import { Button, EmptyState, PageHeader } from "@/components/ui";
import { Icon } from "@/components/icon";
import { ManagedProducts } from "@/components/managed-products";
import {
  ClientCustomAgents,
  type CustomAgentRunRow,
  type RunnableAgentSummary,
} from "@/components/custom-agents";
import { LabImportButton } from "@/components/lab-import";
import { isAgentServiceConfigured } from "@/lib/agent-service/client";
import { isLabOutputsConfigured } from "@/lib/lab-outputs";
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

/**
 * A client's AI Agents page. Staff launch the managed lab products and any
 * custom agent here; client users see (and fire, billed in credits) only the
 * custom agents an admin granted them in client settings.
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

  // Client users: their granted custom agents (if any) — otherwise the
  // "your team is on it" state. Managed products stay staff-launched.
  if (!isStaff) {
    const allowedIds = new Set(client.customAgentIds ?? []);
    const [allAgents, jobs, contextItems, credits] = await Promise.all([
      allowedIds.size > 0 ? listCustomAgents() : Promise.resolve([]),
      listJobs({ clientId: id }),
      listContextItems({ clientId: id }),
      getClientCredits(id),
    ]);
    const agents = allAgents.filter((a) => a.enabled && allowedIds.has(a.id)).map(toSummary);
    // Client viewers see only runs of agents they're allowed — not the
    // history of staff-fired agents outside their allowlist.
    const allowedNames = new Set(agents.map((a) => a.name));
    const runs = toRunRows(jobs, false).filter((r) => allowedNames.has(r.agentName));
    // Impersonating admins see the client view but never spend real credits —
    // show the gate only to billable client actors.
    const spendable = isBillableClientActor(user) ? availableCredits(credits) : undefined;

    return (
      <>
        <PageHeader
          title="AI Agents"
          description="Your Karos team runs AI agents that research, produce, and deliver content for you."
        />
        {agents.length > 0 && agentServiceConfigured ? (
          <ClientCustomAgents
            clientId={id}
            agents={agents}
            runs={runs}
            contextItems={contextItems}
            viewerIsClient
            {...(spendable !== undefined ? { availableCredits: spendable } : {})}
          />
        ) : (
          <EmptyState
            icon={<Icon name="Bot" className="h-7 w-7" />}
            title="Your team is on it"
            description="Karos runs managed AI agents for your account. Deliverables appear in your Library once they're approved."
            action={
              <Link href="/assets">
                <Button>Open Library</Button>
              </Link>
            }
          />
        )}
      </>
    );
  }

  const [jobs, contextItems, customAgents] = await Promise.all([
    listJobs({ clientId: id }),
    listContextItems({ clientId: id }),
    listCustomAgents(),
  ]);
  const labImportAvailable = isLabOutputsConfigured();

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

  return (
    <>
      <PageHeader
        title="AI Agents"
        description="Run managed lab agents for this client and track their deliverables."
        action={
          <div className="flex items-center gap-3">
            {labImportAvailable && <LabImportButton clientId={id} />}
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
        <>
          <ManagedProducts clientId={id} contextItems={contextItems} jobs={jobs} jobPreviews={jobPreviews} />
          <ClientCustomAgents
            clientId={id}
            agents={customAgents.filter((a) => a.enabled).map(toSummary)}
            runs={toRunRows(jobs, true)}
            contextItems={contextItems}
            viewerIsClient={false}
          />
        </>
      ) : (
        <EmptyState
          icon={<Icon name="Bot" className="h-7 w-7" />}
          title="Agent service not configured"
          description="Set the agent-service environment variables to run managed lab agents from here."
        />
      )}
    </>
  );
}
