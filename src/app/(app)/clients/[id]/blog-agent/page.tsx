import { redirect } from "next/navigation";
import { requireUser, requireVisibleClient } from "@/lib/auth";
import { buildBlogAgentIntakeView, requireIntakeAgentAccess } from "@/lib/agent-intake-views";
import { intakePageAction } from "@/lib/agent-intake-links";
import { PageHeader } from "@/components/ui";
import { BlogAgentIntake } from "@/components/blog-agent-intake";

/**
 * The client's blog agent page: the setup band and the details form - the one
 * canonical set of blog intake surfaces, mounted with the same props the run
 * dialog renders inline. Nothing in the navigation points here; it is the
 * fallback for a caller that ships the setup flag without the inline payload,
 * and a stable deep link for the run dialog's error recovery.
 */
export default async function BlogAgentPage({
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

  const view = await buildBlogAgentIntakeView(id, { isStaff });
  // SERIAL, and the VIEW IS BUILT FIRST, for the reason the Reddit page states:
  // this same call is the page's client gate (#114), and the rung it asks second
  // — has this family already worked for them — can only be read off the view's
  // run rows. A refused client's request therefore performs this client's intake
  // reads before the 404, which is affordable because `requireVisibleClient`
  // above has already fenced them to their OWN client and nothing here writes.
  const agentId = await requireIntakeAgentAccess({
    family: "blog",
    isStaff,
    clientSlug: client.agentsRepoSlug,
    grantedAgentIds: client.customAgentIds,
    runs: view.runs,
  });
  const action = intakePageAction({ clientId: id, isStaff, agentId });

  return (
    <>
      <PageHeader
        title="Blog agent"
        description="What we collect to run your blog: your own websites so we can link between them, and the subjects we should never cover. What each article is about comes from your newsletter. We take something it covered and go properly deep on it, then prepare the whole article for you to publish."
        action={
          <a
            href={action.href}
            className="inline-flex items-center gap-1.5 text-xs text-muted hover:text-foreground"
          >
            {action.label}
          </a>
        }
      />
      <BlogAgentIntake {...view} />
    </>
  );
}
