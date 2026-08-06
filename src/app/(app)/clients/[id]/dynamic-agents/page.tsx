import { redirect } from "next/navigation";
import { requireUser, requireVisibleClient } from "@/lib/auth";
import { listDynamicAgentSpecs } from "@/lib/data";
import { Card, CardTitle, EmptyState, PageHeader } from "@/components/ui";
import { Icon } from "@/components/icon";

/**
 * Client-facing entry point for Dynamic Agent Studio agents — the run
 * surface for the spec-driven agents an admin built in `/admin/agents/builder`.
 *
 * Deliberately kept SEPARATE from the existing `/clients/[id]/agents` roster
 * (custom-agents.tsx's CustomAgentsHub / ClientAgentRoster): that page's
 * launch-vs-run, scheduling, and umbrella-template machinery is built
 * specifically around `CustomAgent`/`ClientAgent`, which a `DynamicAgentSpec`
 * is not. Folding this in there would mean threading a second agent shape
 * through code the rest of this epic explicitly leaves untouched. See the
 * phase report for the same call made explicitly.
 */
export default async function ClientDynamicAgentsPage({ params }: { params: Promise<{ id: string }> }) {
  const user = await requireUser();
  const { id } = await params;

  if (user.role === "CLIENT_USER") {
    if (user.clientId !== id) redirect(user.clientId ? `/clients/${user.clientId}` : "/assets");
  } else if (user.role !== "KAROS_ADMIN" && user.role !== "KAROS_EMPLOYEE") {
    redirect("/dashboard");
  }

  const client = await requireVisibleClient(user, id);
  const isStaff = user.role === "KAROS_ADMIN" || user.role === "KAROS_EMPLOYEE";

  const allSpecs = await listDynamicAgentSpecs();
  const specs = allSpecs.filter((spec) => {
    if (!spec.active) return false;
    if (isStaff) return true;
    const allowed = spec.allowedClientIds ?? [];
    return allowed.length === 0 || allowed.includes(client.id);
  });

  return (
    <>
      <PageHeader title="Dynamic agents" description={`Agent Studio agents available to ${client.name}.`} />
      <Card>
        <CardTitle className="mb-3">Available agents</CardTitle>
        {specs.length === 0 ? (
          <EmptyState
            icon={<Icon name="Sparkles" className="h-6 w-6" />}
            title="No dynamic agents yet"
            description={
              isStaff
                ? "Build one in Agent Studio, mark it active, and it appears here."
                : "Your Karos team hasn't made a dynamic agent available to you yet."
            }
          />
        ) : (
          <div className="space-y-2">
            {specs.map((spec) => (
              <a
                key={spec.id}
                href={`/clients/${client.id}/dynamic-agents/${spec.id}`}
                className="flex items-center gap-2.5 rounded-md border border-border bg-surface-2 px-3 py-2.5 hover:border-border-strong"
              >
                <Icon name={spec.icon || "Sparkles"} className="h-4 w-4 shrink-0 text-muted-2" />
                <div className="min-w-0">
                  <p className="truncate text-sm font-medium text-foreground">{spec.name}</p>
                  <p className="truncate text-xs text-muted-2">{spec.summary || spec.description}</p>
                </div>
              </a>
            ))}
          </div>
        )}
      </Card>
    </>
  );
}
