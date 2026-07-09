import Link from "next/link";
import { requireUser } from "@/lib/auth";
import { listClients, listCustomAgents } from "@/lib/data";
import { Badge, Card, CardTitle, EmptyState, PageHeader } from "@/components/ui";
import { Icon } from "@/components/icon";
import { MANAGED_PRODUCTS } from "@/lib/agent-service/products";
import { isAgentServiceConfigured } from "@/lib/agent-service/client";
import { isCustomAgentImportConfigured } from "@/lib/agent-service/custom-agent-import";
import { CustomAgentsHub } from "@/components/custom-agents";

/**
 * Staff catalog of the managed agents — the karos-agents lab products run by
 * the external agent service — plus the custom-agents library (stored system
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
        description="Managed lab agents from the karos-agents repo, run by the agent service for a chosen client."
      />

      <div className="grid gap-4 sm:grid-cols-2">
        {MANAGED_PRODUCTS.map((product) => (
          <Card key={product.taskType} className="flex flex-col">
            <div className="flex items-start gap-3">
              <div
                className="flex h-10 w-10 shrink-0 items-center justify-center rounded-md"
                style={{ background: product.color + "1f", color: product.color }}
              >
                <Icon name={product.icon} className="h-5 w-5" />
              </div>
              <div className="min-w-0 flex-1">
                <p className="font-medium">{product.name}</p>
                <p className="mt-0.5 text-xs text-muted">{product.tagline}</p>
              </div>
              <Badge tone="neutral">{product.estimate}</Badge>
            </div>
            <p className="mt-3 text-xs leading-relaxed text-muted-2">{product.description}</p>
            <ul className="mt-3 space-y-0.5">
              {product.deliverables.map((d) => (
                <li key={d} className="flex items-center gap-1.5 text-xs text-foreground">
                  <Icon name="Check" className="h-3 w-3 shrink-0 text-success" /> {d}
                </li>
              ))}
            </ul>
          </Card>
        ))}
      </div>

      <Card className="mt-6">
        <CardTitle className="mb-1">Run an agent</CardTitle>
        <p className="mb-4 text-xs text-muted">
          Agents always run against a client&apos;s context — pick a client to launch one.
        </p>
        {activeClients.length === 0 ? (
          <EmptyState
            icon={<Icon name="Building2" className="h-6 w-6" />}
            title="No active clients"
            description="Add a client first — agents run against a client's context."
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
