/**
 * The dispatch envelope published to `karos-agent-runs-${env}` (RFC — this
 * task's own spec). `clientSlug`/`productId`/`runKind`/`input` are consumed by
 * agent-engine's queue consumer (`RunJobRequestSchema`);
 * `idempotencyKey`/`correlationId` are published anyway, so `correlationId` is
 * visible on the message itself for operators and logs even though the engine
 * does not read it.
 *
 * ## `input`, singular, and why the name matters
 *
 * This field was `inputs` until a live prep run proved what that costs. Zod
 * STRIPS unknown keys rather than rejecting them, so a run dispatched on this
 * fallback path was accepted, ran to completion, and quietly ignored the brief:
 * the agent picked its own topic and no attachment reached Tier 0. Nothing
 * errored. agent-middleware has always published `input` (its
 * `to_engine_message`), which is why the primary path was unaffected and this
 * one went unnoticed — and why the fallback is exactly where a silent
 * divergence is worst, since it fires when the control plane is already down.
 */
export interface AgentEngineRunEnvelope {
  clientSlug: string;
  productId: string;
  runKind: "setup" | "recurring";
  /** Named to match `RunJobRequestSchema.input` exactly. See above. */
  input?: Record<string, unknown>;
  idempotencyKey: string;
  correlationId: string;
}

/**
 * A reviewer's note on one slide's template, routed to the engine's template
 * registry rather than to the post's own feedback.
 *
 * `promote` is explicit rather than implied by `verdict: "approved"`: liking
 * one render is not the same as wanting every client's future runs to use that
 * layout, and only a person can tell those apart.
 */
export interface AgentEngineTemplateFeedback {
  slide: number;
  templateId: string;
  verdict: "approved" | "revise";
  note: string;
  promote?: boolean;
}

/**
 * A gate resolution, matching agent-engine's `POST /api/v1/runs/:runId/resume`
 * body shape exactly (`apps/agent-server/src/routes/runs.ts`'s
 * `ResumeRunRequestSchema`).
 *
 * `revise` (2026-08) is the third decision: it re-enters the agent's drafting
 * loop with `feedback` injected and everything already checkpointed reused,
 * instead of holding the run and forcing somebody to dispatch a fresh one that
 * knows nothing about what was asked for.
 */
export interface AgentEngineGateResolution {
  decision: "approve" | "revise" | "reject";
  actor: string;
  notes?: string;
  /** Required by the engine on `revise`; optional guidance on `approve`. */
  feedback?: string;
  templateFeedback?: AgentEngineTemplateFeedback[];
}
