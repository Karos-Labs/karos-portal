import Link from "next/link";
import { requireUser } from "@/lib/auth";
import { listClients } from "@/lib/data";
import { Card, CardTitle, EmptyState, PageHeader } from "@/components/ui";
import { Icon } from "@/components/icon";
import { loadControlPlane } from "@/lib/agent-engine/control-plane-enrichment";
import { buildEngineAgentCards } from "@/lib/agent-engine/catalog-union";
import { EngineAgentCard } from "@/components/agents/engine-agent-card";

/**
 * Staff entry point for running agents: the agent-engine catalog, every agent
 * runnable against any active client.
 *
 * ## Why the lab library no longer renders here
 *
 * This page used to show the engine catalog ABOVE the lab-imported
 * `customAgents` library, on the reasoning that the library was what clients
 * actually ran. That has inverted: every product in it now has an engine
 * workflow, and the two executors draft the same deliverable by different
 * routes. Showing both made the catalog a quiz — two cards per product, one
 * with stages, prompts and a Studio link, one without, and nothing on either
 * saying which one a person should press.
 *
 * The library itself is untouched. `CustomAgentsHub` still renders on a
 * client's own agents page, where a granted-agent roster is the point; what is
 * gone is the duplicate catalog beside the engine's.
 */
export default async function AgentsPage() {
  const user = await requireUser(["KAROS_ADMIN", "KAROS_EMPLOYEE"]);
  const clients = await listClients(user.role === "KAROS_EMPLOYEE" ? { employeeId: user.uid } : undefined);
  const activeClients = clients.filter((c) => c.status === "active");

  // No agent keys passed: the per-key enrichment existed for the library rows
  // that no longer render, and asking for it would spend a prompt lookup per
  // agent on a badge nothing draws.
  const snapshot = await loadControlPlane([]);
  const engineAgents = buildEngineAgentCards(snapshot.agents);

  return (
    <>
      <PageHeader
        title="Agents"
        description="Every agent-engine workflow, run against a chosen client's context."
      />

      {user.role === "KAROS_ADMIN" ? (
        <Card>
          <CardTitle className="mb-1">Agent Studio</CardTitle>
          <p className="mb-3 text-xs text-muted">
            Build spec-driven agents visually — no deploy required. Runs on the generic execution engine, side by
            side with the agents below.
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

      <Card className="mb-6">
        <CardTitle className="mb-1">Run an agent</CardTitle>
        <p className="mb-4 text-xs text-muted">
          Each agent runs with versioned prompts, a model and template bindings. Pick a client, optionally steer the
          run, and launch — or open it in the Studio to change how it works.
        </p>
        {activeClients.length === 0 ? (
          <EmptyState
            icon={<Icon name="Building2" className="h-6 w-6" />}
            title="No active clients"
            description="Add a client first. Agents run against a client's context."
          />
        ) : engineAgents.length === 0 ? (
          // Distinct from the no-clients case on purpose: an empty catalog means
          // the control plane is off or unreachable, which is an operator
          // problem, and telling someone to "add a client" would send them to
          // fix the wrong thing.
          <EmptyState
            icon={<Icon name="Sparkles" className="h-6 w-6" />}
            title="No agents available"
            description="The control plane returned no agents. Check that agent-middleware is reachable from this environment."
          />
        ) : (
          <div className="grid gap-3 lg:grid-cols-2">
            {engineAgents.map((agent) => (
              <EngineAgentCard
                key={agent.slug}
                agent={agent}
                clients={activeClients.map((c) => ({ id: c.id, name: c.name }))}
              />
            ))}
          </div>
        )}
      </Card>

      {activeClients.length > 0 && (
        <Card>
          <CardTitle className="mb-1">Client workspaces</CardTitle>
          <p className="mb-4 text-xs text-muted">
            Open a client to see their agent roster, schedules and delivered work.
          </p>
          <div className="flex flex-wrap gap-2">
            {activeClients.map((c) => (
              <Link
                key={c.id}
                href={`/clients/${c.id}/agents`}
                className="inline-flex items-center gap-1.5 rounded-md border border-border bg-surface-2 px-3 py-1.5 text-xs text-foreground transition-colors hover:border-border-strong hover:bg-surface-3"
              >
                <Icon name="ArrowRight" className="h-3 w-3 text-muted" />
                {c.name}
              </Link>
            ))}
          </div>
        </Card>
      )}
    </>
  );
}
