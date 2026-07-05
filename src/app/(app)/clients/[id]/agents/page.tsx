import { notFound, redirect } from "next/navigation";
import { requireUser } from "@/lib/auth";
import {
  getClient,
  listAgents,
  listAssets,
  listJobs,
  listContextItems,
  listClientIntegrations,
} from "@/lib/data";
import { PageHeader } from "@/components/ui";
import { AgentsHubTab } from "@/components/agents-hub-tab";
import { ManagedProducts } from "@/components/managed-products";
import { isAgentServiceConfigured } from "@/lib/agent-service/client";

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

  const [agents, assets, jobs, contextItems, integrations] = await Promise.all([
    listAgents({ status: "published" }),
    listAssets({ clientId: id }),
    listJobs({ clientId: id }),
    listContextItems({ clientId: id }),
    listClientIntegrations(id),
  ]);
  const agentServiceConfigured = isAgentServiceConfigured();

  return (
    <>
      <PageHeader
        title="AI Agents"
        description="Run agents, review drafts, and track scheduled deliverables."
        action={
          <a
            href={`/clients/${id}/settings`}
            className="inline-flex items-center gap-1.5 text-xs text-muted hover:text-foreground"
          >
            Manage integrations →
          </a>
        }
      />
      <AgentsHubTab
        client={client}
        agents={agents}
        jobs={jobs}
        assets={assets}
        contextItems={contextItems}
        integrations={integrations}
      />
      {(user.role === "KAROS_ADMIN" || user.role === "KAROS_EMPLOYEE") && agentServiceConfigured && (
        <ManagedProducts clientId={id} contextItems={contextItems} jobs={jobs} />
      )}
    </>
  );
}
