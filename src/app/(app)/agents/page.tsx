import Link from "next/link";
import { requireUser } from "@/lib/auth";
import { listClients, listCustomAgents } from "@/lib/data";
import { Card, CardTitle, EmptyState, PageHeader } from "@/components/ui";
import { Icon } from "@/components/icon";
import { isAgentServiceConfigured } from "@/lib/agent-service/client";
import { isCustomAgentImportConfigured } from "@/lib/agent-service/custom-agent-import";
import { CustomAgentsHub } from "@/components/custom-agents";

/**
 * Staff agents library — every agent is a repo-imported CustomAgent (imported
 * from the karos-agents catalog, runnable with a plain prompt, and schedulable
 * from the Calendar). Managed here; run against a chosen client's context.
 */
export default async function AgentsPage() {
  const user = await requireUser(["KAROS_ADMIN", "KAROS_EMPLOYEE"]);
  const [clients, customAgents] = await Promise.all([
    listClients(user.role === "KAROS_EMPLOYEE" ? { employeeId: user.uid } : undefined),
    listCustomAgents(),
  ]);
  const activeClients = clients.filter((c) => c.status === "active");

  return (
    <>
      <PageHeader
        title="Agents"
        description="Repo agents imported from karos-agents, run by the agent service for a chosen client."
      />

      <Card>
        <CardTitle className="mb-1">Run an agent</CardTitle>
        <p className="mb-4 text-xs text-muted">
          Agents always run against a client&apos;s context. Pick a client to launch one.
        </p>
        {activeClients.length === 0 ? (
          <EmptyState
            icon={<Icon name="Building2" className="h-6 w-6" />}
            title="No active clients"
            description="Add a client first. Agents run against a client's context."
          />
        ) : (
          <div className="flex flex-wrap gap-2">
            {activeClients.map((c) => (
              <Link
                key={c.id}
                href={`/clients/${c.id}/agents`}
                className="inline-flex items-center gap-1.5 rounded-md border border-border bg-surface-2 px-3 py-1.5 text-xs text-foreground transition-colors hover:border-border-strong hover:bg-surface-3"
              >
                <Icon name="Play" className="h-3 w-3 text-muted" />
                {c.name}
              </Link>
            ))}
          </div>
        )}
      </Card>

      <CustomAgentsHub
        agents={customAgents}
        clients={activeClients.map((c) => ({ id: c.id, name: c.name }))}
        isAdmin={user.role === "KAROS_ADMIN"}
        importConfigured={isCustomAgentImportConfigured()}
        serviceConfigured={isAgentServiceConfigured()}
      />
    </>
  );
}
