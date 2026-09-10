/**
 * What a "recommended task" IS, in pure functions — the set the onboarding
 * swarm proposed (src/lib/actions/onboarding-actions.ts) and the Task Map adds
 * to: a `ClientTask` with status `pending`, owner `karos_managed`, source
 * `copilot`.
 *
 * PORTAL FEEDBACK ROUND 2, 2026-09. Four surfaces now read this set — Home's
 * widget, the agent detail page, and both branches of the agent roster — and
 * the predicate had already been spelled inline twice before this pass (Home's
 * banner count and calendar-body.tsx's review cards), which is how Home and the
 * calendar came to disagree about how many were waiting.
 *
 * NO DATA-LAYER IMPORT HERE, deliberately: `lib/data.ts` is `server-only`, so a
 * module that pulls it in cannot be unit-tested or imported by a client
 * component. The fetching half lives in lib/task-kickoff.ts.
 */

import { MANAGED_PRODUCTS } from "@/lib/agent-service/products";
import type { ClientTask } from "@/lib/types";

/** The one predicate. A task failing any leg is somebody else's row. */
export function isRecommendedTask(task: Pick<ClientTask, "status" | "owner" | "source">): boolean {
  return task.status === "pending" && task.owner === "karos_managed" && task.source === "copilot";
}

/**
 * Who would run it. `metadata.agentName` first — the one field name every
 * writer (agent-swarm.ts, campaign-engine.ts, the chat route) uses for the
 * linked agent's display name (SCRUM-255) — then the managed product's catalog
 * name, then a truthful generic. Never the raw `productType` slug: an unknown
 * or missing one reads "Karos AI" rather than leaking an enum at a client.
 */
export function taskExecutorLabel(task: Pick<ClientTask, "metadata">): string {
  const meta = task.metadata ?? {};
  const agentName = meta.agentName as string | undefined;
  const productType = meta.productType as string | undefined;
  return agentName ?? MANAGED_PRODUCTS.find((p) => p.taskType === productType)?.name ?? "Karos AI";
}

/** The task's target platform, only when one is actually stored. */
export function taskPlatform(task: Pick<ClientTask, "metadata">): string | undefined {
  const platform = task.metadata?.platform;
  return typeof platform === "string" && platform.length > 0 ? platform : undefined;
}
