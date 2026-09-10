import { notFound } from "next/navigation";
import { requireUser } from "@/lib/auth";
import { getDynamicAgentSpec, listClients } from "@/lib/data";
import { isDynamicCodeStepsEnabled } from "@/lib/dynamic-agent-flags";
import { PageHeader } from "@/components/ui";
import { AgentStudioEditor } from "@/components/admin/agent-studio/agent-studio-editor";

export default async function AgentStudioEditorPage({
  params,
}: {
  params: Promise<{ specId: string }>;
}) {
  await requireUser(["KAROS_ADMIN"]);
  const { specId } = await params;
  const [spec, clients] = await Promise.all([getDynamicAgentSpec(specId), listClients()]);
  if (!spec) notFound();

  return (
    <>
      <PageHeader title={spec.name || "Untitled agent"} description="Agent Studio" />
      <AgentStudioEditor
        spec={spec}
        clients={clients.map((c) => ({ id: c.id, name: c.name }))}
        codeStepsEnabled={isDynamicCodeStepsEnabled()}
      />
    </>
  );
}
