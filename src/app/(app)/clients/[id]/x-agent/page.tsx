import { redirect } from "next/navigation";
import { requireUser, requireVisibleClient } from "@/lib/auth";
import { buildXAgentIntakeView, requireIntakeAgentAccess } from "@/lib/agent-intake-views";
import { intakePageAction } from "@/lib/agent-intake-links";
import { PageHeader } from "@/components/ui";
import { XAgentIntake } from "@/components/x-agent-intake";

/**
 * The client's X agent page: the company-page form, seats, the two ongoing
 * boxes, and per-draft feedback — the one canonical set of X intake surfaces.
 */
export default async function XAgentPage({ params }: { params: Promise<{ id: string }> }) {
  const user = await requireUser();
  const { id } = await params;

  if (user.role === "CLIENT_USER") {
    if (user.clientId !== id) redirect(user.clientId ? `/clients/${user.clientId}` : "/assets");
  } else if (user.role !== "KAROS_ADMIN" && user.role !== "KAROS_EMPLOYEE") {
    redirect("/dashboard");
  }
  const isStaff = user.role === "KAROS_ADMIN" || user.role === "KAROS_EMPLOYEE";

  // Called for the refusal AND for the record: the header's control needs this
  // client's grant list and lab slug to resolve the agent's own page (#82).
  const client = await requireVisibleClient(user, id);

  const view = await buildXAgentIntakeView(id, { isStaff });
  // Resolved for BOTH roles. It used to be skipped for staff "whose destination is
  // the roster either way" — but the roster carries no run control for staff
  // either (CD-I1 moved every staff run gesture to the agent's own page), so
  // staff need the same destination a client gets.
  //
  // SERIAL, and the VIEW IS BUILT FIRST, which is a fact worth stating rather
  // than hiding: this same call is the page's client gate (#114), and the rung it
  // asks second — has this family already worked for them — can only be read off
  // the view's run rows. So a refused client's request does perform this client's
  // intake reads before the 404. That is affordable because `requireVisibleClient`
  // above has already fenced them to their OWN client and nothing here writes;
  // what the gate stops is a form for an agent they do not have.
  const agentId = await requireIntakeAgentAccess({
    family: "x",
    isStaff,
    clientSlug: client.agentsRepoSlug,
    grantedAgentIds: client.customAgentIds,
    runs: view.runs,
  });
  // Both roles go to the agent's own page when one resolves — it is the only
  // place a run gesture lives for either of them — and to the roster, named for
  // what it is, when none does. The label moves with the destination (#82).
  const action = intakePageAction({ clientId: id, isStaff, agentId });

  return (
    <>
      <PageHeader
        title="X agent"
        description="What we collect to run X for you: the company page, a seat per person, and your ongoing drops. Drafts only — nothing posts without a human."
        action={
          <a
            href={action.href}
            className="inline-flex items-center gap-1.5 text-xs text-muted hover:text-foreground"
          >
            {action.label}
          </a>
        }
      />
      <XAgentIntake {...view} />
    </>
  );
}
