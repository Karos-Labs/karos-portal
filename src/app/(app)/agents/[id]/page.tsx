import { notFound } from "next/navigation";
import { requireUser } from "@/lib/auth";
import { getAgent, listClients } from "@/lib/data";
import { PageHeader } from "@/components/ui";
import { AgentBuilder } from "@/components/agent-builder";

export default async function EditAgentPage({ params }: { params: Promise<{ id: string }> }) {
  const user = await requireUser(["admin", "employee"]);
  const { id } = await params;
  const [agent, clients] = await Promise.all([
    getAgent(id),
    listClients(user.role === "employee" ? { employeeId: user.uid } : undefined),
  ]);
  if (!agent) notFound();
  return (
    <>
      <PageHeader
        title={`${(agent.status ?? "published") === "draft" ? "Develop" : "Edit"} · ${agent.name || "Untitled agent"}`}
        description="Tune the prompt, inputs and capabilities — changes autosave. Test-run against a client, then publish."
      />
      <AgentBuilder agent={agent} clients={clients} />
    </>
  );
}
