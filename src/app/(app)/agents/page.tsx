import Link from "next/link";
import { requireUser } from "@/lib/auth";
import { listClients, listCustomAgents } from "@/lib/data";
import { Badge, Card, CardTitle, EmptyState, PageHeader } from "@/components/ui";
import { Icon } from "@/components/icon";
import { isAgentServiceConfigured } from "@/lib/agent-service/client";
import { isCustomAgentImportConfigured } from "@/lib/agent-service/custom-agent-import";
import { CustomAgentsHub } from "@/components/custom-agents";
import { loadControlPlane } from "@/lib/agent-engine/control-plane-enrichment";
import { buildAgentCatalogUnion, controlPlaneAgentHref } from "@/lib/agent-engine/catalog-union";

/**
 * Staff entry point for running agents: a client picker (agents always run
 * against a client's context) plus the custom-agents library (stored system
 * prompts, importable from the repo catalog, runnable with a plain prompt).
 *
 * MERGED, not replaced: `customAgents` stays the spine of this list. The
 * control plane knows a handful of agents and this library holds every one a
 * client can actually run, so sourcing the catalog from `GET /agents` would
 * make agents people use today vanish from their own portal. The middleware
 * layers on what it genuinely knows — which prompt version an agent is on —
 * and every agent it has never heard of renders exactly as before.
 */
export default async function AgentsPage() {
  const user = await requireUser(["KAROS_ADMIN", "KAROS_EMPLOYEE"]);
  const [clients, customAgents] = await Promise.all([
    listClients(user.role === "KAROS_EMPLOYEE" ? { employeeId: user.uid } : undefined),
    listCustomAgents(),
  ]);
  const activeClients = clients.filter((c) => c.status === "active");

  // One control-plane round trip serving both halves of the union: the
  // per-agent enrichment below, and the agents the library has no row for.
  // Returns empty when the control plane is off, unreachable or slow, so
  // this page never depends on it being up.
  const snapshot = await loadControlPlane(customAgents.map((a) => a.key));
  const { controlPlaneOnly } = buildAgentCatalogUnion(customAgents, snapshot.agents);

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

      {user.role === "KAROS_ADMIN" ? (
        <Card>
          <CardTitle className="mb-1">Agent Studio</CardTitle>
          <p className="mb-3 text-xs text-muted">
            Build spec-driven agents visually — no deploy required. Runs on the generic execution engine, side by
            side with the agents above.
          </p>
          <Link
            href="/admin/agents/builder"
            className="inline-flex items-center gap-1.5 rounded-md border border-border bg-surface-2 px-3 py-1.5 text-xs text-foreground transition-colors hover:border-border-strong hover:bg-surface-3"
          >
            <Icon name="Sparkles" className="h-3 w-3 text-muted" />
            Open Agent Studio
          </Link>
        </Card>
      ) : null}

      {controlPlaneOnly.length > 0 && (
        <Card className="mb-6">
          <CardTitle className="mb-1">Control-plane agents</CardTitle>
          <p className="mb-4 text-xs text-muted">
            Managed in agent-middleware with versioned prompts, a model and template bindings. They have no lab-repo
            entry, so they are configured from the control plane rather than run from this library.
          </p>
          <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
            {controlPlaneOnly.map((agent) => (
              <Link
                key={agent.slug}
                href={controlPlaneAgentHref(agent.slug)}
                className="rounded-lg border border-white/10 p-4 transition hover:border-neon/50"
              >
                <div className="flex flex-wrap items-center gap-2">
                  <span className="font-medium">{agent.name}</span>
                  <Badge tone={agent.status === "active" ? "success" : "neutral"}>{agent.status}</Badge>
                </div>
                <code className="mt-1 block text-xs opacity-60">{agent.slug}</code>
                {agent.description && <p className="mt-2 text-xs text-muted">{agent.description}</p>}
                {agent.model && <p className="mt-2 text-xs opacity-60">{agent.model}</p>}
              </Link>
            ))}
          </div>
        </Card>
      )}

      <CustomAgentsHub
        agents={customAgents}
        controlPlane={snapshot.facts}
        // The lab slug rides along so the hub can tell which agents may run for
        // which client - a per-client instance is refused by both submit cores
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
