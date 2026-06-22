import Link from "next/link";
import { requireUser } from "@/lib/auth";
import { listAgents, listClients } from "@/lib/data";
import { Button, EmptyState, PageHeader } from "@/components/ui";
import { Icon } from "@/components/icon";
import { AgentCard, DraftAgentCard } from "@/components/agent-card";
import { SeedAgentsButton } from "@/components/seed-agents";

export default async function AgentsPage() {
  const user = await requireUser(["admin", "employee"]);
  const [drafts, published, clients] = await Promise.all([
    listAgents({ status: "draft" }),
    listAgents({ status: "published" }),
    listClients(user.role === "employee" ? { employeeId: user.uid } : undefined),
  ]);

  return (
    <>
      <PageHeader
        title="Agents"
        description="Reusable AI skills your team builds and runs for clients."
        action={
          <Link href="/agents/new">
            <Button>
              <Icon name="Plus" className="h-4 w-4" />
              New agent
            </Button>
          </Link>
        }
      />

      {drafts.length > 0 && (
        <section className="mb-8">
          <h2 className="mb-3 flex items-center gap-2 text-sm font-semibold text-muted">
            <Icon name="PencilRuler" className="h-4 w-4" />
            In development
            <span className="text-muted-2">· {drafts.length}</span>
          </h2>
          <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
            {drafts.map((agent) => (
              <DraftAgentCard key={agent.id} agent={agent} />
            ))}
          </div>
        </section>
      )}

      <section>
        {drafts.length > 0 && <h2 className="mb-3 text-sm font-semibold text-muted">Live agents</h2>}
        {published.length === 0 ? (
          <EmptyState
            icon={<Icon name="Bot" className="h-7 w-7" />}
            title={drafts.length > 0 ? "No live agents yet" : "No agents yet"}
            description="Create a custom agent from scratch, or seed the starter pack including the Instagram + email agent."
            action={
              <div className="flex gap-2">
                <SeedAgentsButton />
                <Link href="/agents/new">
                  <Button variant="outline">Build from scratch</Button>
                </Link>
              </div>
            }
          />
        ) : (
          <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
            {published.map((agent) => (
              <AgentCard key={agent.id} agent={agent} clients={clients} canEdit />
            ))}
          </div>
        )}
      </section>
    </>
  );
}
