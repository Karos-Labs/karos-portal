import { notFound, redirect } from "next/navigation";
import { requireUser } from "@/lib/auth";
import { getClient } from "@/lib/data";
import { buildLinkedInAgentIntakeView } from "@/lib/agent-intake-views";
import { PageHeader } from "@/components/ui";
import { LinkedInAgentIntake } from "@/components/linkedin-agent-intake";

/**
 * The client's LinkedIn agent page: the company-page form, seats (shared with
 * the other agents - one person, one seat), the shared news drop, and
 * per-draft feedback. Draft-first end to end: LinkedIn bars unattended
 * auto-posting, so a person always posts.
 */
export default async function LinkedInAgentPage({ params }: { params: Promise<{ id: string }> }) {
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

  const view = await buildLinkedInAgentIntakeView(id, {
    isStaff,
    ...(client.socialLinks?.linkedin ? { pageUrlSuggestion: client.socialLinks.linkedin } : {}),
  });

  return (
    <>
      <PageHeader
        title="LinkedIn agent"
        description="What we collect to run LinkedIn for you: the company page, a seat per person, and your ongoing drops. Drafts only - a person always posts."
        action={
          <a
            href={`/clients/${id}/agents`}
            className="inline-flex items-center gap-1.5 text-xs text-muted hover:text-foreground"
          >
            Run the agent →
          </a>
        }
      />
      <LinkedInAgentIntake {...view} />
    </>
  );
}
