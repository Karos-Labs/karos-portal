import { query } from "@anthropic-ai/claude-agent-sdk";
import { AGENT_MODEL_ALIASES } from "../../../src/task-types.js";
import type { DynamicAgentModelAlias, DynamicAgentSpec, DynamicAgentStepDef } from "../../../src/dynamic-types.js";
import { isTransientError, isTransientResultError } from "../error-classification.js";
import { isResultMessage } from "../transcript.js";
import { buildStepAgentDefinitions, sdkEnv } from "../sdk-options.js";
import { createContextStore, serializeContext, withStepOutput, type DynamicRunContext } from "./context-store.js";
import { runCodeStep } from "./code-sandbox.js";
import { normalizeDashesDeep } from "./text-normalize.js";

/** One entry per executed step — the "per-step trace" Phase 7's acceptance asks for. */
export interface DynamicStepTraceEntry {
  stepId: string;
  type: "ai" | "code";
  label: string;
  status: "done" | "failed";
  /** ms wall-clock for this step, including its retry if any. */
  durationMs: number;
  /** Concrete model id this step actually ran on — the audit trail for per-step routing. */
  model?: string;
  error?: string;
  /** Only set for a code step's failure — never the client-facing text. */
  stderr?: string;
}

export interface DynamicRunResult {
  ok: boolean;
  outputs?: Record<string, unknown>;
  trace: DynamicStepTraceEntry[];
  /** The last step's own output — the run's overall deliverable. */
  finalOutput?: unknown;
  error?: string;
  failedStepId?: string;
  failedStepIndex?: number;
  /** Partial context accumulated up to (not including) the failed step. */
  partialOutputs?: Record<string, unknown>;
}

export interface DynamicStepRunnerDeps {
  /** Per-step progress emission (Phase 7's acceptance) — mirrors the campaign step bar. */
  onProgress?: (event: { stepId: string; index: number; total: number; status: "running" | "done" | "failed" }) => void;
  /**
   * The brief's own `step_models` map (stepId → model alias), threaded through
   * from the job payload. See resolveStepModel below for why this, and not
   * `step.model`, is consulted first.
   */
  stepModels?: Record<string, string> | undefined;
}

const RETRY_BACKOFF_MS = 2_000;

function isModelAlias(value: string): value is DynamicAgentModelAlias {
  return value === "opus" || value === "sonnet" || value === "haiku";
}

/**
 * Resolves the concrete model id for an AI step.
 *
 * The brief's `step_models` entry wins over the snapshot's own `step.model`.
 * That ordering is what makes this a genuine EXTENSION of the existing
 * `stepModels` mechanism (Phase 6: "Reuse and extend the existing `stepModels`
 * mapping rather than introducing a parallel mechanism") rather than a second
 * one bolted alongside it: the same brief field the hardcoded custom-agent
 * path already uses to route a model per named step is the field that routes a
 * model per dynamic step, read through the same key space (the step's id).
 * `step.model` remains the fallback so a snapshot is still self-sufficient if
 * a brief ever arrives without the map.
 *
 * Only ALIASES are ever accepted here — a raw model id in either place is
 * refused, which is the runtime half of the "never persist a raw model ID"
 * rule (the Portal's validation is the other half).
 */
export function resolveStepModel(
  step: Extract<DynamicAgentStepDef, { type: "ai" }>,
  stepModels: Record<string, string> | undefined,
): { ok: true; alias: DynamicAgentModelAlias; model: string } | { ok: false; error: string } {
  const fromBrief = stepModels?.[step.id];
  const raw = fromBrief ?? step.model;
  if (typeof raw !== "string" || !isModelAlias(raw)) {
    return {
      ok: false,
      error: `Step "${step.id}" asks for model "${String(raw)}", which is not one of the supported aliases (opus, sonnet, haiku). A spec must store an alias, never a raw model id.`,
    };
  }
  return { ok: true, alias: raw, model: AGENT_MODEL_ALIASES[raw] };
}

/**
 * // DECISION: v1 is sequential-only. `dependsOn` must be empty on every
 * step — checked here too (not only at Portal save time) because this
 * function executes a FROZEN specSnapshot that could, in principle, have
 * been written by a path that skipped the Portal's own validation (a direct
 * Firestore edit, a future importer). The runner is the last line of
 * defence for its own execution invariant.
 */
function validateSequentialOnly(steps: DynamicAgentStepDef[]): string | null {
  const withDeps = steps.find((s) => s.dependsOn && s.dependsOn.length > 0);
  if (withDeps) {
    return `Step "${withDeps.id}" sets dependsOn, but this runner only supports a strict sequential order — the spec cannot be executed as written.`;
  }
  return null;
}

/**
 * Runs every step of `spec.steps`, IN ORDER, accumulating context as it
 * goes.
 *
 * // DECISION: a failed step fails the job at that step. The result carries
 * `failedStepId`, `failedStepIndex` and the partial context up to (not
 * including) the failed step, and run-dynamic-job.ts persists all three plus
 * the trace through the runner's completion body so the Portal can store them
 * on the job and surface the partial output marked incomplete.
 */
export async function runDynamicSteps(
  spec: DynamicAgentSpec,
  inputs: DynamicRunContext["inputs"],
  deps: DynamicStepRunnerDeps = {},
): Promise<DynamicRunResult> {
  const sequentialError = validateSequentialOnly(spec.steps);
  if (sequentialError) return { ok: false, error: sequentialError, trace: [] };

  const steps = [...spec.steps].sort((a, b) => a.order - b.order);
  let context = createContextStore(inputs);
  const trace: DynamicStepTraceEntry[] = [];

  for (const [index, step] of steps.entries()) {
    deps.onProgress?.({ stepId: step.id, index, total: steps.length, status: "running" });
    const startedAt = Date.now();

    const result = await runOneStepWithRetry(step, context, deps.stepModels);

    if (!result.ok) {
      trace.push({
        stepId: step.id,
        type: step.type,
        label: step.label,
        status: "failed",
        durationMs: Date.now() - startedAt,
        ...(result.model ? { model: result.model } : {}),
        error: result.error,
        ...(result.stderr ? { stderr: result.stderr } : {}),
      });
      deps.onProgress?.({ stepId: step.id, index, total: steps.length, status: "failed" });
      return {
        ok: false,
        error: result.error,
        trace,
        failedStepId: step.id,
        failedStepIndex: index,
        partialOutputs: context.outputs,
      };
    }

    context = withStepOutput(context, step.id, result.output);
    trace.push({
      stepId: step.id,
      type: step.type,
      label: step.label,
      status: "done",
      durationMs: Date.now() - startedAt,
      ...(result.model ? { model: result.model } : {}),
    });
    deps.onProgress?.({ stepId: step.id, index, total: steps.length, status: "done" });
  }

  const lastStepId = steps[steps.length - 1]?.id;
  return {
    ok: true,
    outputs: context.outputs,
    finalOutput: lastStepId ? context.outputs[lastStepId] : undefined,
    trace,
  };
}

type StepOutcome =
  | { ok: true; output: unknown; model?: string }
  | { ok: false; error: string; stderr?: string; transient?: boolean; model?: string };

/**
 * // DECISION: one automatic retry for a transient AI/API error (429, 5xx,
 * timeout) with exponential backoff (a single fixed-then-doubled step is
 * "exponential" at n=1); ZERO automatic retries for a code-step exception — a
 * code step's failure is the author's script, not infrastructure, and retrying
 * it reproduces the same bug.
 *
 * The transient/permanent call is made ONCE, where the error is first
 * classified in `runAiStepOutcome` (against the SDK's own subtype/errors, or
 * the raw thrown exception), and threaded through via `outcome.transient` —
 * NOT re-derived here from the final English message. A result-error's
 * rendered text ("AI step transiently failed: <subtype>") intentionally drops
 * the raw signal (a "503", "overloaded_error", …) that justified the
 * classification, so re-running the same substring match against that
 * rendered text here would silently stop retrying anything classified via
 * `isTransientResultError`.
 */
async function runOneStepWithRetry(
  step: DynamicAgentStepDef,
  context: DynamicRunContext,
  stepModels: Record<string, string> | undefined,
): Promise<StepOutcome> {
  const first = await runOneStep(step, context, stepModels);
  if (first.ok) return first;
  if (step.type === "code") return first; // no retry, ever
  if (!first.transient) return first;

  await new Promise((resolve) => setTimeout(resolve, RETRY_BACKOFF_MS));
  return runOneStep(step, context, stepModels);
}

async function runOneStep(
  step: DynamicAgentStepDef,
  context: DynamicRunContext,
  stepModels: Record<string, string> | undefined,
): Promise<StepOutcome> {
  if (step.type === "code") return runCodeStepOutcome(step, context);
  return runAiStepOutcome(step, context, stepModels);
}

async function runCodeStepOutcome(
  step: Extract<DynamicAgentStepDef, { type: "code" }>,
  context: DynamicRunContext,
): Promise<StepOutcome> {
  // DECISION: code-step execution ships behind DYNAMIC_CODE_STEPS_ENABLED
  // and is gated off by default. An AI-only spec never reaches this branch; a
  // mixed spec fails cleanly here with an English reason rather than silently
  // "succeeding" with no real output.
  if (process.env.DYNAMIC_CODE_STEPS_ENABLED !== "true") {
    return { ok: false, error: "Code steps are disabled on this environment (DYNAMIC_CODE_STEPS_ENABLED is not set)." };
  }
  const result = await runCodeStep({
    language: step.language,
    code: step.code,
    context,
    ...(step.timeoutMs != null ? { timeoutMs: step.timeoutMs } : {}),
  });
  if (!result.ok) return { ok: false, error: result.error ?? "Code step failed.", ...(result.stderr ? { stderr: result.stderr } : {}) };
  // A code step's own output is passed through the same dash normalization as
  // AI text: its input was AI text (the preceding steps' outputs), so a
  // reshaped/forwarded string can carry the same em dashes.
  return { ok: true, output: normalizeDashesDeep(result.output) };
}

/** Recognizes `{{inputs.key}}` / `{{outputs.stepId}}` (dotted paths) and substitutes the resolved value. Unresolved placeholders are left as-is, visible for debugging rather than silently blanked. */
function interpolate(prompt: string, context: DynamicRunContext): string {
  return prompt.replace(/\{\{\s*([a-zA-Z0-9_.]+)\s*\}\}/g, (whole, path: string) => {
    const value = resolvePath(context, path);
    if (value === undefined) return whole;
    return typeof value === "string" ? value : JSON.stringify(value);
  });
}

function resolvePath(root: unknown, path: string): unknown {
  let current: unknown = root;
  for (const part of path.split(".")) {
    if (current == null || typeof current !== "object") return undefined;
    current = (current as Record<string, unknown>)[part];
  }
  return current;
}

function composePrompt(step: Extract<DynamicAgentStepDef, { type: "ai" }>, context: DynamicRunContext): string {
  const interpolated = interpolate(step.prompt, context);
  return `${interpolated}

---
Full run context so far, as JSON (client answers under "inputs", every earlier step's own output under "outputs.<stepId>"). Use it for anything not already inlined above:
\`\`\`json
${serializeContext(context)}
\`\`\``;
}

/**
 * AI step execution.
 *
 * Reuses the SAME imported `query()` and the SAME option plumbing the
 * hardcoded path uses — `buildStepAgentDefinitions` and `sdkEnv` are imported
 * from `../sdk-options.js`, which is where main.ts's own copies now live, so
 * there is one SDK client and one env allowlist across both paths. The step's
 * resolved model is passed BOTH as `options.model` (the effective lever for a
 * single-turn step, which has no subagent to delegate to) and through
 * `options.agents` in the existing `stepModels` shape, keyed by the step's id,
 * so per-step routing reads identically on both paths.
 *
 * What differs from main.ts's call, deliberately: no `cwd`, no tools, no
 * skills, `settingSources: []`, `maxTurns: 1`. main.ts launches a full
 * autonomous, filesystem-backed agent run against a cloned repo workspace; a
 * dynamic AI step is a single-turn text completion with no workspace to reach.
 *
 * KNOWN LIMITATION: a `file`/`image` input's value is its uploaded reference
 * (id/url/name), never fetched bytes — with no tools enabled here, an AI step
 * can reason about a file's name/URL as text but cannot see an image's pixels
 * or a document's contents. Extending this to fetch and attach file content is
 * future work, not implemented here.
 */
async function runAiStepOutcome(
  step: Extract<DynamicAgentStepDef, { type: "ai" }>,
  context: DynamicRunContext,
  stepModels: Record<string, string> | undefined,
): Promise<StepOutcome> {
  const resolved = resolveStepModel(step, stepModels);
  if (!resolved.ok) return { ok: false, error: resolved.error };
  const { model } = resolved;
  const prompt = composePrompt(step, context);
  const stepAgents = buildStepAgentDefinitions({ [step.id]: model });

  let text = "";
  let sawResult = false;
  let resultError: string | undefined;
  let resultTransient = false;

  try {
    const q = query({
      prompt,
      options: {
        model,
        ...(stepAgents ? { agents: stepAgents } : {}),
        maxTurns: 1,
        permissionMode: "dontAsk",
        allowedTools: [],
        settingSources: [],
        env: sdkEnv(),
      },
    });
    for await (const message of q) {
      const typed = message as { type?: string; message?: { content?: Array<{ type: string; text?: string }> } };
      if (typed.type === "assistant" && typed.message?.content) {
        for (const block of typed.message.content) {
          if (block.type === "text" && typeof block.text === "string") text += block.text;
        }
      } else if (isResultMessage(message)) {
        sawResult = true;
        const result = message as { subtype: string; errors?: string[] };
        if (result.subtype !== "success") {
          resultTransient = isTransientResultError(result.subtype, result.errors);
          resultError = resultTransient
            ? `AI step transiently failed: ${result.subtype}`
            : `AI step failed: ${result.subtype}${result.errors?.length ? ` — ${result.errors.join("; ")}` : ""}`;
        }
      }
    }
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return { ok: false, error: message, transient: isTransientError(err), model };
  }

  if (resultError) return { ok: false, error: resultError, transient: resultTransient, model };
  if (!sawResult) return { ok: false, error: "AI step ended without a result.", model };
  if (!text.trim()) return { ok: false, error: "AI step produced no text output.", model };
  // Dash normalization happens HERE, before the text enters the context store
  // — so every downstream step reads normalized text, and the persisted
  // artifact and the returned deliverable are normalized by construction
  // rather than at each write site. See text-normalize.ts for why the runner
  // is this utility's home.
  return { ok: true, output: normalizeDashesDeep(text), model };
}
