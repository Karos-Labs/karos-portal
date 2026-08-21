/**
 * The dispatch envelope published to `karos-agent-runs-${env}` (RFC — this
 * task's own spec). Only `clientSlug`/`productId`/`runKind` are actually
 * consumed by agent-engine's queue consumer today (its
 * `RunJobRequestSchema` has no `inputs`/`idempotencyKey`/`correlationId`
 * field — see `pubsub-client.ts`'s own doc comment); the rest are published
 * anyway, for forward compatibility, and so `correlationId` is visible on
 * the message itself for operators/logs even before agent-engine persists
 * it anywhere.
 */
export interface AgentEngineRunEnvelope {
  clientSlug: string;
  productId: string;
  runKind: "setup" | "recurring";
  inputs?: Record<string, unknown>;
  idempotencyKey: string;
  correlationId: string;
}

/** A gate resolution, matching agent-engine's `POST /api/v1/runs/:runId/resume` body shape exactly (`apps/agent-server/src/routes/runs.ts`'s `ResumeRunRequestSchema`). */
export interface AgentEngineGateResolution {
  decision: "approve" | "reject";
  actor: string;
  notes?: string;
}
