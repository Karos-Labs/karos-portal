import { notFound } from "next/navigation";
import Link from "next/link";
import { requireUser } from "@/lib/auth";
import { Card, EmptyState, PageHeader } from "@/components/ui";
import { isMiddlewareDispatchEnabled } from "@/lib/agent-engine/middleware-client";
import {
  MiddlewareRequestError,
  getActivePrompt,
  getAgent,
  listFeedback,
  listModels,
  listPrompts,
  listTemplates,
  type MiddlewareFeedback,
  type MiddlewareModel,
  type MiddlewarePrompt,
  type MiddlewareTemplate,
} from "@/lib/agent-engine/middleware-admin";
import { AgentStudio } from "@/components/agents/agent-studio";

/**
 * Agent Studio — one agent, everything about it.
 *
 * Replaces the admin console at `/admin/agents/control-plane`, which was a
 * single page with an agent picker. That shape was wrong twice over: an agent
 * is a thing you navigate TO, not a selection inside a settings screen, and
 * burying it under `/admin` meant the catalog's "Edit in Studio" led somewhere
 * that did not look like the product.
 *
 * Everything an agent has is loaded here: its stages, its prompt version
 * history, the model it runs on, its template bindings and its review
 * feedback. One page, one agent, one place to change how it works.
 *
 * Each read is independent. A control plane that cannot answer for feedback
 * should still render the prompt editor, so a partial outage costs a panel
 * rather than the page — the failure that took this surface down was exactly
 * one of these queries erroring and being allowed to bring the rest with it.
 */
export default async function AgentStudioPage({
  params,
}: {
  params: Promise<{ slug: string }>;
}) {
  await requireUser(["KAROS_ADMIN", "KAROS_EMPLOYEE"]);
  const { slug } = await params;

  if (!isMiddlewareDispatchEnabled()) {
    return (
      <>
        <PageHeader title="Agent Studio" description="Managed in agent-middleware." />
        <Card className="p-6">
          <EmptyState
            title="The control plane is not enabled here"
            description="Set AGENT_MIDDLEWARE_URL and AGENT_MIDDLEWARE_DISPATCH_ENABLED for this environment."
          />
        </Card>
      </>
    );
  }

  const agent = await getAgent(slug).catch((error) => {
    if (error instanceof MiddlewareRequestError && error.status === 404) return null;
    throw error;
  });
  if (!agent) notFound();

  /** A panel's data, or null — never a thrown error that takes the page with it. */
  async function soft<T>(load: () => Promise<T>, panel: string): Promise<T | null> {
    try {
      return await load();
    } catch (error) {
      console.warn(
        JSON.stringify({
          severity: "WARNING",
          message: `agent studio: ${panel} did not load`,
          agent: slug,
          reason: error instanceof Error ? error.message : String(error),
        }),
      );
      return null;
    }
  }

  const [activePrompt, promptHistory, templates, models, feedback] = await Promise.all([
    soft<MiddlewarePrompt | null>(() => getActivePrompt(slug), "active prompt"),
    soft(() => listPrompts(slug, { limit: 50 }).then((p) => p.items), "prompt history"),
    soft(() => listTemplates({ limit: 100 }).then((p) => p.items), "templates"),
    soft(() => listModels({ limit: 200 }).then((p) => p.items), "models"),
    soft(() => listFeedback(slug, { limit: 25 }).then((p) => p.items), "feedback"),
  ]);

  return (
    <>
      <PageHeader
        title={agent.name}
        description={agent.description ?? "Managed in agent-middleware and run on agent-engine."}
      />
      <p className="mb-4 text-xs text-muted">
        <Link href="/agents" className="underline decoration-dotted hover:text-neon">
          ← All agents
        </Link>
      </p>
      <AgentStudio
        agent={agent}
        activePrompt={activePrompt ?? null}
        promptHistory={(promptHistory as MiddlewarePrompt[] | null) ?? []}
        templates={(templates as MiddlewareTemplate[] | null) ?? []}
        models={(models as MiddlewareModel[] | null) ?? []}
        feedback={(feedback as MiddlewareFeedback[] | null) ?? []}
      />
    </>
  );
}
