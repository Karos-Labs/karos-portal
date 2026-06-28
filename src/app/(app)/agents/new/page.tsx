import { requireUser } from "@/lib/auth";
import { listClients } from "@/lib/data";
import { PageHeader } from "@/components/ui";
import { AgentBuilder } from "@/components/agent-builder";

export default async function NewAgentPage() {
  const user = await requireUser(["KAROS_ADMIN", "KAROS_EMPLOYEE"]);
  const clients = await listClients(user.role === "KAROS_EMPLOYEE" ? { employeeId: user.uid } : undefined);
  return (
    <>
      <PageHeader title="New agent" description="Build a reusable AI skill — it autosaves as a draft and you can test-run it before publishing." />
      <AgentBuilder clients={clients} />
    </>
  );
}
