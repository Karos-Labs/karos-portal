import { redirect } from "next/navigation";
import { requireUser, requireVisibleClient } from "@/lib/auth";
import { isBillableClientActor } from "@/lib/credits";
import { buildNewsletterAgentIntakeView, requireIntakeAgentAccess } from "@/lib/agent-intake-views";
import { intakePageAction } from "@/lib/agent-intake-links";
import { IntakePageActionLink } from "@/components/intake-page-action-link";
import { PageHeader } from "@/components/ui";
import { NewsletterAgentIntake } from "@/components/newsletter-agent-intake";

/**
 * The client's newsletter agent page: the setup band, the details form and
 * feedback - the one canonical set of newsletter intake surfaces, mounted with
 * the same props the run dialog renders inline. Nothing in the navigation points
 * here; it is the fallback for a caller that ships the setup flag without the
 * inline payload, and a stable deep link for the run dialog's error recovery.
 */
export default async function NewsletterAgentPage({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
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

  // FLOW AUDIT 2026-09, R3: the metered controls on this page quote a price,
  // and this is the answer to "whose money" — an unbilled reader still reads
  // the client's figure, marked as theirs (see CreditPriceNote).
  const viewerIsBilled = isBillableClientActor(user);
  const view = await buildNewsletterAgentIntakeView(id, { isStaff, viewerIsBilled });
  // SERIAL, and the VIEW IS BUILT FIRST, for the reason the Reddit page states:
  // this same call is the page's client gate (#114), and the rung it asks second
  // — has this family already worked for them — can only be read off the view's
  // run rows. A refused client's request therefore performs this client's intake
  // reads before the 404, which is affordable because `requireVisibleClient`
  // above has already fenced them to their OWN client and nothing here writes.
  const agentId = await requireIntakeAgentAccess({
    family: "newsletter",
    isStaff,
    clientSlug: client.agentsRepoSlug,
    grantedAgentIds: client.customAgentIds,
    runs: view.runs,
  });
  const action = intakePageAction({ clientId: id, isStaff, agentId });

  return (
    <>
      <PageHeader
        title="Newsletter agent"
        description="What we collect to run your newsletter: the day you want your issue ready, where you send it from, and anything we must never print. What it is about and how it sounds we work out from the material you already gave us. We prepare the whole issue; you send it from your own platform."
        action={
          <IntakePageActionLink href={action.href} label={action.label} back={action.back} />
        }
      />
      <NewsletterAgentIntake {...view} />
    </>
  );
}
