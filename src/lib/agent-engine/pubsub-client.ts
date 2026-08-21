import "server-only";
import { PubSub } from "@google-cloud/pubsub";
import type { AgentEngineRunEnvelope } from "./types";

/**
 * Publishes one run-dispatch envelope to agent-engine's Pub/Sub topic
 * (`karos-agent-runs-${env}`, this repo's replacement for the legacy
 * `agent-service` HTTP dispatch — see `src/lib/jobs/submit-managed.ts`).
 *
 * `RunJobRequestSchema` on the receiving side (`agent-engine`'s
 * `apps/agent-server/src/run-job.ts`) only reads `clientSlug`/`productId`/
 * `runKind` from the message body today — `inputs`/`idempotencyKey`/
 * `correlationId` are accepted (zod silently strips unknown-but-harmless
 * extra fields, it doesn't reject them) but have no effect on the run yet.
 * The run's *actual* idempotency key is agent-engine's own
 * `pubsub-${message.id}` derivation (Pub/Sub reuses the same message id on
 * a redelivery of the same unacked message) — `publishAgentEngineRun`
 * returns that `messageId` precisely so the caller can compute
 * `agentEngineRuns/{runId}`'s id (`\`pubsub-${messageId}\``) without a round
 * trip back to Firestore.
 *
 * Local development: the official `@google-cloud/pubsub` client
 * auto-detects `PUBSUB_EMULATOR_HOST` and talks to the emulator instead of
 * real GCP when it's set — no code here needs to branch on that. When
 * NEITHER `AGENT_ENGINE_PUBSUB_TOPIC` nor the emulator is configured,
 * `isAgentEnginePubSubConfigured()` returns false and callers fall back to
 * the legacy agent-service path (Task 3's "fall back gracefully").
 */

let cachedClient: PubSub | undefined;

function resolveClient(): PubSub {
  cachedClient ??= new PubSub();
  return cachedClient;
}

function resolveTopicName(env: Record<string, string | undefined> = process.env): string | undefined {
  const topic = env.AGENT_ENGINE_PUBSUB_TOPIC;
  return topic && topic.length > 0 ? topic : undefined;
}

/** True when a real topic is configured OR the Pub/Sub emulator is (`PUBSUB_EMULATOR_HOST`) — either way, `publishAgentEngineRun` can actually publish. */
export function isAgentEnginePubSubConfigured(env: Record<string, string | undefined> = process.env): boolean {
  return resolveTopicName(env) !== undefined;
}

export interface PublishAgentEngineRunResult {
  /** Pub/Sub's own id for the published message — `agentEngineRuns/{runId}`'s id is `\`pubsub-${messageId}\`` once agent-engine's consumer picks it up. */
  messageId: string;
}

export async function publishAgentEngineRun(
  envelope: AgentEngineRunEnvelope,
  env: Record<string, string | undefined> = process.env,
): Promise<PublishAgentEngineRunResult> {
  const topicName = resolveTopicName(env);
  if (!topicName) {
    throw new Error(
      "publishAgentEngineRun: AGENT_ENGINE_PUBSUB_TOPIC is not set (and no Pub/Sub emulator is configured via PUBSUB_EMULATOR_HOST) — " +
        "call isAgentEnginePubSubConfigured() first and fall back to the legacy dispatch path when it returns false.",
    );
  }
  const messageId = await resolveClient().topic(topicName).publishMessage({
    json: envelope,
    attributes: { correlationId: envelope.correlationId, idempotencyKey: envelope.idempotencyKey, productId: envelope.productId },
  });
  return { messageId };
}

/** `agentEngineRuns/{runId}`'s id, derived exactly the way agent-engine's queue consumer/push route both derive it from a Pub/Sub message id. */
export function agentEngineRunIdFromMessageId(messageId: string): string {
  return `pubsub-${messageId}`;
}
