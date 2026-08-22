import { requireUser } from "@/lib/auth";
import { PageHeader, Card, EmptyState } from "@/components/ui";
import { isMiddlewareDispatchEnabled } from "@/lib/agent-engine/middleware-client";
import {
  MiddlewareRequestError,
  getActivePrompt,
  listAgents,
  listFeedback,
  listModels,
  listTemplates,
  type MiddlewareAgent,
  type MiddlewareFeedback,
  type MiddlewareModel,
  type MiddlewarePrompt,
  type MiddlewareTemplate,
} from "@/lib/agent-engine/middleware-admin";
import { ControlPlaneConsole } from "@/components/admin/control-plane/control-plane-console";

/**
 * Control Plane — the admin console for `agent-middleware`.
 *
 * Distinct from Agent Studio (`/admin/agents/builder`) on purpose. Agent
 * Studio authors `dynamicAgentSpecs` in Firestore, executed by
 * `agent-service`. This page edits the agents, prompt versions, templates and
 * reviewer feedback that live in the control plane and drive `agent-engine`
 * runs. Same word, two systems; merging the surfaces would mean one of them
 * writing to a store it does not own.
 *
 * Admin-only: `requireUser` redirects a non-admin, and every server action the
 * client component calls re-checks `requireAdmin()` itself — the UI guard is
 * not the fence.
 */
export default async function ControlPlanePage({
  searchParams,
}: {
  searchParams: Promise<{ agent?: string }>;
}) {
  await requireUser(["KAROS_ADMIN"]);
  const { agent: requestedAgent } = await searchParams;

  if (!isMiddlewareDispatchEnabled()) {
    return (
      <>
        <PageHeader
          title="Control Plane"
          description="Agents, prompt versions, templates and review feedback in agent-middleware."
        />
        <Card className="p-6">
          <EmptyState
            title="The control plane is not enabled here"
            description="Set AGENT_MIDDLEWARE_URL and AGENT_MIDDLEWARE_DISPATCH_ENABLED for this environment. Until then jobs publish straight to agent-engine and no prompt or template version is recorded against a run."
          />
        </Card>
      </>
    );
  }

  let agents: MiddlewareAgent[] = [];
  let templates: MiddlewareTemplate[] = [];
  let models: MiddlewareModel[] = [];
  let loadError: string | null = null;

  try {
    const [agentPage, templatePage, modelPage] = await Promise.all([
      listAgents({ limit: 100 }),
      listTemplates({ limit: 100 }),
      listModels({ limit: 200 }),
    ]);
    agents = agentPage.items;
    templates = templatePage.items;
    models = modelPage.items;
  } catch (error) {
    // A reachable-but-broken control plane should say so, not render an empty
    // console that looks like "you have no agents".
    loadError =
      error instanceof MiddlewareRequestError
        ? `${error.message}`
        : error instanceof Error
          ? error.message
          : String(error);
  }

  // Prompt and feedback are per-agent. `?agent=` selects one; an unknown slug
  // falls back to the first rather than rendering an empty console, so a stale
  // bookmark degrades instead of breaking.
  const selected = (requestedAgent ? agents.find((a) => a.slug === requestedAgent) : undefined) ?? agents[0];
  let activePrompt: MiddlewarePrompt | null = null;
  let feedback: MiddlewareFeedback[] = [];

  if (selected && !loadError) {
    try {
      const [prompt, feedbackPage] = await Promise.all([
        getActivePrompt(selected.slug),
        listFeedback(selected.slug, { limit: 25 }),
      ]);
      activePrompt = prompt;
      feedback = feedbackPage.items;
    } catch (error) {
      loadError = error instanceof Error ? error.message : String(error);
    }
  }

  return (
    <>
      <PageHeader
        title="Control Plane"
        description="Agents, prompt versions, templates and review feedback in agent-middleware. Prompt versions are immutable — saving creates a new one, so a run's recorded version still means something later."
      />
      <ControlPlaneConsole
        agents={agents}
        templates={templates}
        models={models}
        selectedSlug={selected?.slug ?? null}
        activePrompt={activePrompt}
        feedback={feedback}
        loadError={loadError}
      />
    </>
  );
}
