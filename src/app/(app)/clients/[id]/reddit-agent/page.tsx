import { notFound, redirect } from "next/navigation";
import { requireUser } from "@/lib/auth";
import { getClient } from "@/lib/data";
import { buildRedditAgentIntakeView } from "@/lib/agent-intake-views";
import { PageHeader } from "@/components/ui";
import { RedditAgentIntake } from "@/components/reddit-agent-intake";

/**
 * The client's Reddit agent page: the account form and feedback — the one
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

  const client = await getClient(id);
  if (!client) notFound();

  const view = await buildRedditAgentIntakeView(id, { isStaff });

  return (
    <>
      <PageHeader
        title="Reddit agent"
        description="What we collect to run Reddit for you: the account we draft as, how much history it has, and how you want mentions handled. We work out the subreddits and the questions worth answering. Drafts only — we never post to Reddit, you post the reply yourself."
        action={
          <a
            href={`/clients/${id}/agents`}
            className="inline-flex items-center gap-1.5 text-xs text-muted hover:text-foreground"
          >
            Run the agent →
          </a>
        }
      />
      <RedditAgentIntake {...view} />
    </>
  );
}
