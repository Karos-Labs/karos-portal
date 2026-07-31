import { notFound, redirect } from "next/navigation";
import { requireUser } from "@/lib/auth";
import { getClient } from "@/lib/data";
import { buildXAgentIntakeView } from "@/lib/agent-intake-views";
import { PageHeader } from "@/components/ui";
import { XAgentIntake } from "@/components/x-agent-intake";

/**
 * The client's X agent page: the company-page form, seats, the two ongoing
 * boxes, and per-draft feedback - the one canonical set of X intake surfaces.
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

  const client = await getClient(id);
  if (!client) notFound();

  const view = await buildXAgentIntakeView(id, { isStaff });

  return (
    <>
      <PageHeader
        title="X agent"
        description="What we collect to run X for you: the company page, a seat per person, and your ongoing drops. Drafts only - nothing posts without a human."
        action={
          <a
            href={`/clients/${id}/agents`}
            className="inline-flex items-center gap-1.5 text-xs text-muted hover:text-foreground"
          >
            Run the agent →
          </a>
        }
      />
      <XAgentIntake {...view} />
    </>
  );
}
