import { redirect } from "next/navigation";
import { requireUser, requireVisibleClient } from "@/lib/auth";
import { buildRedditAgentIntakeView, requireIntakeAgentAccess } from "@/lib/agent-intake-views";
import { intakePageAction } from "@/lib/agent-intake-links";
import { PageHeader } from "@/components/ui";
import { RedditAgentIntake } from "@/components/reddit-agent-intake";

/**
 * The client's Reddit agent page: the account form and feedback - the one
 * canonical set of Reddit intake surfaces, mounted with the same props the run
 * dialog renders inline. Nothing in the navigation points here; it is the
 * fallback for a caller that ships the setup flag without the inline payload,
 * and a stable deep link for the run dialog's error recovery.
 */
export default async function RedditAgentPage({ params }: { params: Promise<{ id: string }> }) {
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

  const view = await buildRedditAgentIntakeView(id, { isStaff });
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
    family: "reddit",
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
        title="Reddit agent"
        description="What we collect to run Reddit for you: the account we draft as, how much history it has, and how you want mentions handled. We work out the subreddits and the questions worth answering. Drafts only. We never post to Reddit, you post the reply yourself."
        action={
          <a
            href={action.href}
            className="inline-flex items-center gap-1.5 text-xs text-muted hover:text-foreground"
          >
            {action.label}
          </a>
        }
      />
      <RedditAgentIntake {...view} />
    </>
  );
}
