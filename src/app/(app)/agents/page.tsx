import Link from "next/link";
import { requireUser } from "@/lib/auth";
import { listClients, listCustomAgents } from "@/lib/data";
import { Card, CardTitle, EmptyState, PageHeader } from "@/components/ui";
import { Icon } from "@/components/icon";
import { isAgentServiceConfigured } from "@/lib/agent-service/client";
import { isCustomAgentImportConfigured } from "@/lib/agent-service/custom-agent-import";
import { CustomAgentsHub } from "@/components/custom-agents";

/**
 * Staff entry point for running agents: a client picker (agents always run
 * against a client's context) plus the custom-agents library (stored system
 * prompts, importable from the repo catalog, runnable with a plain prompt).
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
        description="Custom agents from your library, run against a chosen client's context."
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
        // The lab slug rides along so the hub can tell which agents may run for
        // which client — a per-client instance is refused by both submit cores
        // for anyone else, and the hub is where that pair gets assembled (F38).
        clients={activeClients.map((c) => ({
          id: c.id,
          name: c.name,
          agentsRepoSlug: c.agentsRepoSlug ?? null,
        }))}
        isAdmin={user.role === "KAROS_ADMIN"}
        importConfigured={isCustomAgentImportConfigured()}
        serviceConfigured={isAgentServiceConfigured()}
      />
    </>
  );
}
