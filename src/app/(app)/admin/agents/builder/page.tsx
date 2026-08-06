import { requireUser } from "@/lib/auth";
import { listClients, listDynamicAgentSpecs } from "@/lib/data";
import { PageHeader } from "@/components/ui";
import { AgentStudioList } from "@/components/admin/agent-studio/agent-studio-list";

/**
 * Agent Studio — the no-code/low-code dynamic agent builder. Admin-only:
 * `requireUser` redirects a non-admin to /dashboard, and every server action
 * this page's client components call re-checks `requireAdmin()` itself (see
 * lib/actions/dynamic-agent-actions.ts) — the UI guard alone is not the fence.
 */
export default async function AgentStudioPage() {
  await requireUser(["KAROS_ADMIN"]);
  const [specs, clients] = await Promise.all([listDynamicAgentSpecs(), listClients()]);

  return (
    <>
      <PageHeader
        title="Agent Studio"
        description="Build spec-driven agents visually — no deploy required. Each agent runs on the generic execution engine, side by side with the platform's hardcoded agents."
      />
      <AgentStudioList
        specs={specs}
        clients={clients.map((c) => ({ id: c.id, name: c.name }))}
      />
    </>
  );
}
