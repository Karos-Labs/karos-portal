import "server-only";
import { createJob, updateJob } from "@/lib/data";
import { agentEngineRunIdFromMessageId, isAgentEnginePubSubConfigured, publishAgentEngineRun } from "./pubsub-client";

export interface DispatchAgentEngineRunInput {
  clientId: string;
  clientSlug: string;
  productId: string;
  runKind: "setup" | "recurring";
  /** The job's own display label, e.g. "SEO/GEO Research (Agent Engine)". */
  agentName: string;
  title: string;
  inputs?: Record<string, unknown>;
  /** The job doc's own `input` display field — a human-readable summary, distinct from `inputs` above (the envelope's raw payload). Defaults to `{}`. */
  inputSummary?: Record<string, string>;
  /** `Job.createdBy` — a real user id for a staff/client-triggered dispatch, "system" (the default) for one an internal pipeline (onboarding) triggers on nobody's behalf. */
  createdBy?: string;
}

export type DispatchAgentEngineRunResult = { jobId: string; agentEngineRunId: string } | { jobId: string; error: string } | { error: string };

/**
 * The one flag that turns on agent-engine dispatch anywhere in this repo —
 * `submit-managed.ts`'s managed-catalog path and `dispatch-research-
 * agents.ts`'s onboarding-observability path both gate on this single
 * switch, rather than each growing its own. Default OFF: unset (or
 * "false") keeps every dispatch path exactly as it behaved before Task 2 —
 * a deliberate, instantly-revertible opt-in, not a behavior change existing
 * deployments get for free.
 */
export function isAgentEngineDispatchEnabled(): boolean {
  return process.env.AGENT_ENGINE_DISPATCH_ENABLED === "true";
}

/**
 * Creates a `jobs` doc and dispatches it through agent-engine's Pub/Sub
 * topic — the one place this repo does that, shared by
 * `submit-managed.ts`'s own agent-engine branch and the two new observable
 * onboarding dispatches (`dispatch-research-agents.ts`) so the
 * create-job/publish/record-runId/handle-failure sequence can't drift
 * between the three callers.
 */
export async function dispatchAgentEngineRun(input: DispatchAgentEngineRunInput): Promise<DispatchAgentEngineRunResult> {
  if (!isAgentEnginePubSubConfigured()) {
    return { error: "AGENT_ENGINE_PUBSUB_TOPIC (or the Pub/Sub emulator) is not configured." };
  }

  const now = Date.now();
  const jobId = await createJob({
    clientId: input.clientId,
    agentId: "agent-engine",
    agentName: input.agentName,
    title: input.title,
    status: "queued",
    input: input.inputSummary ?? {},
    assetIds: [],
    events: [{ at: now, level: "info", message: "Dispatched to agent-engine" }],
    createdBy: input.createdBy ?? "system",
    createdAt: now,
    updatedAt: now,
  });

  try {
    const { messageId } = await publishAgentEngineRun({
      clientSlug: input.clientSlug,
      productId: input.productId,
      runKind: input.runKind,
      ...(input.inputs && Object.keys(input.inputs).length > 0 ? { inputs: input.inputs } : {}),
      idempotencyKey: jobId,
      correlationId: jobId,
    });
    const agentEngineRunId = agentEngineRunIdFromMessageId(messageId);
    await updateJob(jobId, { agentEngineRunId, agentEngineProductId: input.productId, updatedAt: Date.now() });
    return { jobId, agentEngineRunId };
  } catch (e) {
    const message = e instanceof Error ? e.message : "Agent engine dispatch failed";
    await updateJob(jobId, {
      status: "failed",
      error: message,
      events: [
        { at: now, level: "info", message: "Dispatched to agent-engine" },
        { at: Date.now(), level: "error", message },
      ],
      updatedAt: Date.now(),
    });
    return { jobId, error: message };
  }
}
