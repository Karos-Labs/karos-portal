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
 * A reviewer's in-place edit of one slide, applied VERBATIM by the engine on
 * approve — no model redraft. `fields` patches the slide's own prose slots
 * (the engine only applies keys the slide actually has and that are not
 * layout metadata); `fontScale`/`textAlign` are the discrete typography
 * controls the templates implement as body classes.
 */
export interface AgentEngineSlideEdit {
  n: number;
  fields?: Record<string, string>;
  fontScale?: "s" | "m" | "l";
  textAlign?: "start" | "center" | "end";
}

/**
 * A reviewer's colour pick for this post — the same seven roles
 * agent-engine's own `StyleEditSchema` (`packages/core/src/types/gate.ts`)
 * accepts, mirrored here rather than imported (the portal and the engine are
 * separate repos/deploys). `ground`/`fg`/`accent` are the three the Design
 * block's inputs actually expose; the rest exist so a hand-authored
 * `client/brand.json` override and a reviewer's pick are indistinguishable
 * to the engine, exactly like every other layer of style resolution.
 *
 * IGSTYLE-6, §2.5. Unlike `caption`/`slides` (below), a style pick is
 * meaningful on `revise` as much as `approve` — a redraft supersedes
 * hand-edited PROSE, but must not discard a colour a person deliberately
 * chose, since that choice IS the instruction for the redraft. See
 * `resolveAgentEngineGateAction`'s own doc comment for where that split is
 * actually enforced.
 */
export interface AgentEngineStyleEdit {
  ground?: string;
  surface?: string;
  fg?: string;
  fg2?: string;
  line?: string;
  accentInk?: string;
  accent?: string;
}

/** Everything a reviewer hand-changed before approving — changes TO the post, shipped as written, distinct from `feedback` (words ABOUT it). */
export interface AgentEngineReviewEdits {
  caption?: string;
  slides?: AgentEngineSlideEdit[];
  /** See `AgentEngineStyleEdit`'s own doc comment — meaningful on `approve` AND `revise`, unlike `caption`/`slides`. */
  style?: AgentEngineStyleEdit;
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
  /**
   * In-place edits. `caption`/`slides` are meaningful on `approve` only — a
   * redraft supersedes hand edits. `style` (IGSTYLE-6) is the exception:
   * meaningful on `approve` AND `revise` — see `AgentEngineStyleEdit`'s own
   * doc comment.
   */
  edits?: AgentEngineReviewEdits;
}
