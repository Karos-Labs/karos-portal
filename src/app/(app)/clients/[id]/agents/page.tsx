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
import { LabImportButton } from "@/components/lab-import";
import { isAgentServiceConfigured } from "@/lib/agent-service/client";
import { isLabOutputsConfigured } from "@/lib/lab-outputs";

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
  const isStaff = user.role === "KAROS_ADMIN" || user.role === "KAROS_EMPLOYEE";
  const labImportAvailable = isStaff && isLabOutputsConfigured();

  return (
    <>
      <PageHeader
        title="AI Agents"
        description="Run agents, review drafts, and track scheduled deliverables."
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
      <AgentsHubTab
        client={client}
        agents={agents}
        jobs={jobs}
        assets={assets}
        contextItems={contextItems}
        integrations={integrations}
      />
      {isStaff && agentServiceConfigured && (
        <ManagedProducts clientId={id} contextItems={contextItems} jobs={jobs} />
      )}
    </>
  );
}
