import { notFound, redirect } from "next/navigation";
import Link from "next/link";
import { requireUser } from "@/lib/auth";
import { getClient, listJobs, listContextItems } from "@/lib/data";
import { Button, EmptyState, PageHeader } from "@/components/ui";
import { Icon } from "@/components/icon";
import { ManagedProducts } from "@/components/managed-products";
import { LabImportButton } from "@/components/lab-import";
import { isAgentServiceConfigured } from "@/lib/agent-service/client";
import { isLabOutputsConfigured } from "@/lib/lab-outputs";

/**
 * A client's AI Agents page. The only agents on the platform are the managed
 * karos-agents lab products run by the external agent service — staff launch
 * them here; clients review the resulting deliverables in their Library.
 */
export default async function ClientAgentsPage({ params }: { params: Promise<{ id: string }> }) {
  const user = await requireUser();
  const { id } = await params;

  if (user.role === "CLIENT_USER") {
    if (user.clientId !== id) redirect(user.clientId ? `/clients/${user.clientId}` : "/assets");
  } else if (user.role !== "KAROS_ADMIN" && user.role !== "KAROS_EMPLOYEE") {
    redirect("/dashboard");
  }

  const client = await getClient(id);
  if (!client) notFound();

  const isStaff = user.role === "KAROS_ADMIN" || user.role === "KAROS_EMPLOYEE";

  // Client users don't launch managed runs — the Karos team does. Point them
  // at their Library, where approved deliverables land.
  if (!isStaff) {
    return (
      <>
        <PageHeader
          title="AI Agents"
          description="Your Karos team runs AI agents that research, produce, and deliver content for you."
        />
        <EmptyState
          icon={<Icon name="Bot" className="h-7 w-7" />}
          title="Your team is on it"
          description="Karos runs managed AI agents for your account. Deliverables appear in your Library once they're approved."
          action={
            <Link href="/assets">
              <Button>Open Library</Button>
            </Link>
          }
        />
      </>
    );
  }

  const [jobs, contextItems] = await Promise.all([
    listJobs({ clientId: id }),
    listContextItems({ clientId: id }),
  ]);
  const agentServiceConfigured = isAgentServiceConfigured();
  const labImportAvailable = isLabOutputsConfigured();

  return (
    <>
      <PageHeader
        title="AI Agents"
        description="Run managed lab agents for this client and track their deliverables."
        action={
          <div className="flex items-center gap-3">
            {labImportAvailable && <LabImportButton clientId={id} />}
            <a
              href={`/clients/${id}/settings`}
              className="inline-flex items-center gap-1.5 text-xs text-muted hover:text-foreground"
            >
              Manage integrations →
            </a>
          </div>
        }
      />
      {agentServiceConfigured ? (
        <ManagedProducts clientId={id} contextItems={contextItems} jobs={jobs} />
      ) : (
        <EmptyState
          icon={<Icon name="Bot" className="h-7 w-7" />}
          title="Agent service not configured"
          description="Set the agent-service environment variables to run managed lab agents from here."
        />
      )}
    </>
  );
}
