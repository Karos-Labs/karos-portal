import { redirect } from "next/navigation";
import { requireUser, requireVisibleClient } from "@/lib/auth";
import { listDynamicAgentSpecs } from "@/lib/data";
import { Badge, Card, CardTitle, EmptyState, PageHeader } from "@/components/ui";
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
  /** Would the CLIENT's own list carry this spec? Asked once, used twice. */
  const availableToClient = (spec: (typeof allSpecs)[number]) => {
    const allowed = spec.allowedClientIds ?? [];
    return allowed.length === 0 || allowed.includes(client.id);
  };
  // Staff keep the superset — seeing every active spec is how an operator knows
  // what there is to make available — but each extra row now says so (C3,
  // parity pass 2026-09). Before this, a staff member previewing an account
  // read a longer list with nothing marking which entries the client has.
  const specs = allSpecs.filter((spec) => spec.active && (isStaff || availableToClient(spec)));

  return (
    <>
      <PageHeader title="Dynamic agents" description={`Agent Studio agents available to ${client.name}.`} />
      <Card>
        <CardTitle className="mb-3">Available agents</CardTitle>
        {specs.length === 0 ? (
          /* One sentence for both roles (C3, parity pass 2026-09). Staff read
             "Build one in Agent Studio, mark it active, and it appears here" —
             an instruction to the operator standing where the client's
             explanation goes, so a preview of an empty account showed copy the
             client never gets. Agent Studio is a click away in the admin nav
             for the people who need it. */
          <EmptyState
            icon={<Icon name="Sparkles" className="h-6 w-6" />}
            title="No dynamic agents yet"
            description="Your Karos team hasn't made a dynamic agent available to you yet."
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
                {/* C3: the staff superset's extra rows, named. Only reachable
                    for staff — a client's list never contains one. */}
                {!availableToClient(spec) && (
                  <Badge tone="neutral" className="ml-auto">
                    Not available to this client
                  </Badge>
                )}
              </a>
            ))}
          </div>
        )}
      </Card>
    </>
  );
}
