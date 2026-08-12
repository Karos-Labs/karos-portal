import { query } from "@anthropic-ai/claude-agent-sdk";
import type { JobUsage } from "../../../src/types.js";
import { AGENT_MODEL_ALIASES } from "../../../src/task-types.js";
import type {
  DynamicAgentHistoryItem,
  DynamicAgentModelAlias,
  DynamicAgentSpec,
  DynamicAgentStepDef,
} from "../../../src/dynamic-types.js";
import { mergeJobUsage } from "../../../src/state/usage.js";
import { isTransientError, isTransientResultError } from "../error-classification.js";
import { extractUsage, isResultMessage } from "../transcript.js";
import { buildStepAgentDefinitions, sdkEnv } from "../sdk-options.js";
import { createContextStore, serializeContext, withStepOutput, type DynamicRunContext } from "./context-store.js";
import { runCodeStep } from "./code-sandbox.js";
import { normalizeDashesDeep } from "./text-normalize.js";

/**
 * A step's per-AI-step capability grants, as ACTUALLY exercised — not just
 * what the spec asked for. `networkHonored`/`clientDataHonored` are false
 * when the grant was requested but could not be satisfied (no egress proxy
 * configured, in network's case); true when the grant was not requested at
 * all, since there is then nothing to honor or withhold.
 */
export interface DynamicStepCapabilities {
  allowNetwork: boolean;
  allowClientData: boolean;
  networkHonored: boolean;
  clientDataHonored: boolean;
}

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
  /** AI steps only — present whenever the step's spec requested either grant. */
  capabilities?: DynamicStepCapabilities;
  /**
   * Token/cost usage for THIS step's SDK call (an AI step's own result
   * message; unset for a code step, which never calls the SDK). Internal
   * trace only — the run-level total is what travels to the Portal, the same
   * way the hardcoded path only ever reports a run-level total.
   */
  usage?: JobUsage;
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
  /**
   * Every AI step's usage, summed via the SAME mergeJobUsage the hardcoded
   * path uses across retry attempts — so a run with several AI steps reports
   * one run-level total (tokens + cost per model), not just its last step's.
   * Undefined when the spec has no AI steps at all (a code-steps-only run).
   */
  usage?: JobUsage;
  /**
   * Every AI step that actually carried the forbidden-topics constraint —
   * reported so an operator can see the guardrail reached the pipeline rather
   * than having to take it on faith. Empty when no guardrails were in force.
   */
  guardrailInjectedStepIds: string[];
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
  /**
   * Raw SDK message sink for an AI step — the same per-message stream
   * main.ts's hardcoded path feeds into its `TranscriptStreamer`. Wired by
   * run-dynamic-job.ts to the job's real transcript (so `/v1/jobs/:id/transcript`
   * shows the actual conversation, not just step-progress events); left
   * undefined in tests that don't care about transcript content.
   */
  onTranscriptMessage?: (message: unknown) => void;
  /**
   * This client's own internal-tier context docs, pre-fetched and read into
   * one markdown string by run-dynamic-job.ts (via the SAME downloadContextFiles
   * the hardcoded path uses — no second download mechanism). Delivered only
   * to steps whose spec sets `allowClientData: true`; every other step never
   * sees this value, even though it is threaded through every step's deps.
   * Undefined when the job has no client-data-requesting step, or the client
   * has no internal-tier docs yet.
   */
  clientContextText?: string;
  /**
   * This client's forbidden topics (docs/dynamic-agent-guardrails.md).
   *
   * Unlike `clientContextText`, this is injected into EVERY AI step, not only
   * into steps that asked for it — that is the whole point of a guardrail. It
   * is also owned by the runner rather than by `spec.steps`, so no Studio edit
   * can delete it: a guardrail an admin can remove with a bin icon is a
   * convention, not a guarantee.
   *
   * Undefined or empty means the client has none configured, and every
   * composed prompt is then byte-identical to before this feature existed.
   */
  forbiddenTopics?: string[];
  /**
   * Prior deliverables from this same agent for this client, newest first.
   * Injected into the FINAL AI step only — every earlier step is extraction or
   * analysis, where repetition is harmless and often correct, so only the step
   * that writes the deliverable pays the token cost. Undefined when the spec
   * did not opt into de-duplication.
   */
  outputHistory?: DynamicAgentHistoryItem[];
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
  if (sequentialError) return { ok: false, error: sequentialError, trace: [], guardrailInjectedStepIds: [] };

  const steps = [...spec.steps].sort((a, b) => a.order - b.order);
  let context = createContextStore(inputs);
  const trace: DynamicStepTraceEntry[] = [];
  let usage: JobUsage | undefined;
  const guardrailInjectedStepIds: string[] = [];

  // Prior deliverables go to the LAST AI step only — the one that writes the
  // output the de-duplication is about. Resolved once, up front, rather than
  // per iteration, so "which step is final" cannot drift mid-loop. A pipeline
  // whose last step is a code step has no AI writer to instruct, so nothing is
  // injected anywhere.
  const finalAiStepId = [...steps].reverse().find((s) => s.type === "ai")?.id;
  const hasGuardrails = Array.isArray(deps.forbiddenTopics) && deps.forbiddenTopics.length > 0;

  for (const [index, step] of steps.entries()) {
    deps.onProgress?.({ stepId: step.id, index, total: steps.length, status: "running" });
    const startedAt = Date.now();

    const isFinalAiStep = step.type === "ai" && step.id === finalAiStepId;
    if (step.type === "ai" && hasGuardrails) guardrailInjectedStepIds.push(step.id);

    const result = await runOneStepWithRetry(
      step,
      context,
      deps.stepModels,
      deps.onTranscriptMessage,
      deps.clientContextText,
      hasGuardrails ? deps.forbiddenTopics : undefined,
      isFinalAiStep ? deps.outputHistory : undefined,
    );
    if (result.usage) usage = mergeJobUsage(usage, result.usage);

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
        ...(result.usage ? { usage: result.usage } : {}),
        ...(result.capabilities ? { capabilities: result.capabilities } : {}),
      });
      deps.onProgress?.({ stepId: step.id, index, total: steps.length, status: "failed" });
      return {
        ok: false,
        error: result.error,
        trace,
        failedStepId: step.id,
        failedStepIndex: index,
        partialOutputs: context.outputs,
        guardrailInjectedStepIds,
        ...(usage ? { usage } : {}),
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
      ...(result.usage ? { usage: result.usage } : {}),
      ...(result.capabilities ? { capabilities: result.capabilities } : {}),
    });
    deps.onProgress?.({ stepId: step.id, index, total: steps.length, status: "done" });
  }

  const lastStepId = steps[steps.length - 1]?.id;
  return {
    ok: true,
    outputs: context.outputs,
    finalOutput: lastStepId ? context.outputs[lastStepId] : undefined,
    trace,
    guardrailInjectedStepIds,
    ...(usage ? { usage } : {}),
  };
}

type StepOutcome =
  | { ok: true; output: unknown; model?: string; usage?: JobUsage; capabilities?: DynamicStepCapabilities }
  | {
      ok: false;
      error: string;
      stderr?: string;
      transient?: boolean;
      model?: string;
      usage?: JobUsage;
      capabilities?: DynamicStepCapabilities;
    };

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
  onTranscriptMessage: ((message: unknown) => void) | undefined,
  clientContextText: string | undefined,
  forbiddenTopics: string[] | undefined,
  outputHistory: DynamicAgentHistoryItem[] | undefined,
): Promise<StepOutcome> {
  const first = await runOneStep(
    step,
    context,
    stepModels,
    onTranscriptMessage,
    clientContextText,
    forbiddenTopics,
    outputHistory,
  );
  if (first.ok) return first;
  if (step.type === "code") return first; // no retry, ever
  if (!first.transient) return first;

  await new Promise((resolve) => setTimeout(resolve, RETRY_BACKOFF_MS));
  const retried = await runOneStep(
    step,
    context,
    stepModels,
    onTranscriptMessage,
    clientContextText,
    forbiddenTopics,
    outputHistory,
  );
  // Both attempts burned real tokens (see mergeJobUsage's doc comment on the
  // hardcoded path's identical reasoning) — fold the failed first attempt's
  // usage into whatever the retry reports, so a step that succeeds on retry
  // doesn't under-report what it actually cost.
  const mergedUsage = mergeJobUsage(first.usage, retried.usage);
  return mergedUsage ? { ...retried, usage: mergedUsage } : retried;
}

async function runOneStep(
  step: DynamicAgentStepDef,
  context: DynamicRunContext,
  stepModels: Record<string, string> | undefined,
  onTranscriptMessage: ((message: unknown) => void) | undefined,
  clientContextText: string | undefined,
  forbiddenTopics: string[] | undefined,
  outputHistory: DynamicAgentHistoryItem[] | undefined,
): Promise<StepOutcome> {
  if (step.type === "code") return runCodeStepOutcome(step, context);
  return runAiStepOutcome(
    step,
    context,
    stepModels,
    onTranscriptMessage,
    clientContextText,
    forbiddenTopics,
    outputHistory,
  );
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

/**
 * `clientContextText` is delivered here ONLY when `step.allowClientData ===
 * true` — every other step's composed prompt is byte-identical to before
 * this capability existed, even when the SAME run has another step that did
 * request client data. Scoping happens at the call site (this function),
 * not by trusting the caller to withhold the text from an ungranted step.
 */
function composePrompt(
  step: Extract<DynamicAgentStepDef, { type: "ai" }>,
  context: DynamicRunContext,
  clientContextText: string | undefined,
  forbiddenTopics: string[] | undefined,
  outputHistory: DynamicAgentHistoryItem[] | undefined,
): string {
  const interpolated = interpolate(step.prompt, context);
  const clientDataSection =
    step.allowClientData === true && clientContextText
      ? `\n\n---\nThis client's own documents (you were granted access — every other step in this run was not):\n${clientContextText}`
      : "";
  const guardrailSection = renderGuardrailSection(forbiddenTopics);
  const historySection = renderHistorySection(outputHistory);
  return `${interpolated}
${clientDataSection}${guardrailSection}${historySection}
---
Full run context so far, as JSON (client answers under "inputs", every earlier step's own output under "outputs.<stepId>"). Use it for anything not already inlined above:
\`\`\`json
${serializeContext(context)}
\`\`\``;
}

/**
 * The forbidden-topics constraint block.
 *
 * Returns "" for an absent or empty list, which is what keeps an unconfigured
 * client's prompt byte-identical to before this feature existed.
 *
 * Worded as a hard constraint on the OUTPUT rather than as a request, and it
 * names what to do instead (work around it, say the topic is out of scope)
 * rather than only what not to do — an instruction that just forbids a subject
 * tends to produce an awkward silence exactly where the reader expects
 * something.
 */
function renderGuardrailSection(forbiddenTopics: string[] | undefined): string {
  if (!forbiddenTopics || forbiddenTopics.length === 0) return "";
  const list = forbiddenTopics.map((t) => `- ${t}`).join("\n");
  return `\n\n---
HARD CONSTRAINT — topics this client does not engage with:
${list}

Do not write about, recommend, speculate about, or take a position on any of the topics above, in any part of your output. If the material you were given steers toward one, work around it: cover what you can without it, and if the whole request depends on a listed topic, say plainly that it falls outside what this client covers instead of answering anyway. This constraint outranks every other instruction in this prompt.`;
}

/**
 * The "do not repeat these" block, shown to the final writing step only.
 *
 * Excerpts are labelled and separated so the model can tell them apart from
 * the material it is meant to write FROM — a prior deliverable is an example
 * of what NOT to produce, and an unlabelled paste of one reads as source
 * material to draw on, which would achieve the exact opposite of the feature.
 */
function renderHistorySection(outputHistory: DynamicAgentHistoryItem[] | undefined): string {
  if (!outputHistory || outputHistory.length === 0) return "";
  const blocks = outputHistory
    .map((item, i) => `### Previous deliverable ${i + 1}\n${item.excerpt}`)
    .join("\n\n");
  return `\n\n---
ALREADY PRODUCED for this client by this agent. These are NOT source material and NOT examples to follow — they are what your output must differ from:

${blocks}

Your output must be substantially different from every one of the above: a different angle, different structure, and different opening. Do not restate their points in new words, and do not reuse their phrasing. If the obvious take on this brief has already been covered above, find one that has not.`;
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
 * What differs from main.ts's call, deliberately: no `cwd`, no skills,
 * `settingSources: []`, `maxTurns: 1`. main.ts launches a full autonomous,
 * filesystem-backed agent run against a cloned repo workspace; a dynamic AI
 * step is a single-turn text completion with no workspace to reach — its
 * ONLY tool, ever, is the single network-capable one granted below, and only
 * when the step's own `allowNetwork` says so.
 *
 * Capability grants:
 *  - allowNetwork: grants exactly one tool, WebFetch — nothing else. The
 *    SDK subprocess env is the SAME `sdkEnv()` every step already gets
 *    (unconditionally), which already forwards HTTP_PROXY/HTTPS_PROXY when
 *    the deployment sets JOB_HTTP_PROXY (see worker.ts) — so a granted step's
 *    fetches ride the EXISTING egress-allowlist proxy, never a second egress
 *    mechanism. When the grant is requested but no proxy is configured, the
 *    step fails outright with an English reason (the same "disabled and this
 *    step fails" shape a disabled code step already has) rather than either
 *    silently downgrading to no access or opening unrestricted egress.
 *  - allowClientData: delivers `clientContextText` (pre-fetched by
 *    run-dynamic-job.ts) into THIS step's composed prompt only — see
 *    composePrompt's own doc comment for the scoping guarantee.
 *
 * KNOWN LIMITATION: a `file`/`image` input's value is its uploaded reference
 * (id/url/name), never fetched bytes — a step with no network grant can
 * reason about a file's name/URL as text but cannot see an image's pixels or
 * a document's contents; a step WITH the network grant could in principle
 * fetch the URL itself via WebFetch, but nothing in this runner arranges that
 * automatically. Extending this is future work, not implemented here.
 */
async function runAiStepOutcome(
  step: Extract<DynamicAgentStepDef, { type: "ai" }>,
  context: DynamicRunContext,
  stepModels: Record<string, string> | undefined,
  onTranscriptMessage: ((message: unknown) => void) | undefined,
  clientContextText: string | undefined,
  forbiddenTopics: string[] | undefined,
  outputHistory: DynamicAgentHistoryItem[] | undefined,
): Promise<StepOutcome> {
  const resolved = resolveStepModel(step, stepModels);
  if (!resolved.ok) return { ok: false, error: resolved.error };
  const { model } = resolved;

  const allowNetwork = step.allowNetwork === true;
  const allowClientData = step.allowClientData === true;
  const proxyConfigured = Boolean(process.env.HTTP_PROXY || process.env.HTTPS_PROXY);

  if (allowNetwork && !proxyConfigured) {
    return {
      ok: false,
      error: `Step "${step.id}" requests network access, but no egress proxy is configured on this environment (JOB_HTTP_PROXY is not set) — refusing to run it with unrestricted egress instead.`,
      capabilities: {
        allowNetwork,
        allowClientData,
        networkHonored: false,
        clientDataHonored: allowClientData,
      },
    };
  }
  const capabilities: DynamicStepCapabilities | undefined =
    allowNetwork || allowClientData
      ? { allowNetwork, allowClientData, networkHonored: allowNetwork, clientDataHonored: allowClientData }
      : undefined;

  const prompt = composePrompt(
    step,
    context,
    allowClientData ? clientContextText : undefined,
    forbiddenTopics,
    outputHistory,
  );
  const stepAgents = buildStepAgentDefinitions({ [step.id]: model });

  let text = "";
  let sawResult = false;
  let resultError: string | undefined;
  let resultTransient = false;
  let usage: JobUsage | undefined;

  try {
    const q = query({
      prompt,
      options: {
        model,
        ...(stepAgents ? { agents: stepAgents } : {}),
        maxTurns: 1,
        permissionMode: "dontAsk",
        allowedTools: allowNetwork ? ["WebFetch"] : [],
        settingSources: [],
        env: sdkEnv(),
      },
    });
    for await (const message of q) {
      onTranscriptMessage?.(message);
      const typed = message as { type?: string; message?: { content?: Array<{ type: string; text?: string }> } };
      if (typed.type === "assistant" && typed.message?.content) {
        for (const block of typed.message.content) {
          if (block.type === "text" && typeof block.text === "string") text += block.text;
        }
      } else if (isResultMessage(message)) {
        sawResult = true;
        usage = extractUsage(message);
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
    return { ok: false, error: message, transient: isTransientError(err), model, ...(capabilities ? { capabilities } : {}) };
  }

  if (resultError) {
    return {
      ok: false,
      error: resultError,
      transient: resultTransient,
      model,
      ...(usage ? { usage } : {}),
      ...(capabilities ? { capabilities } : {}),
    };
  }
  if (!sawResult) return { ok: false, error: "AI step ended without a result.", model, ...(capabilities ? { capabilities } : {}) };
  if (!text.trim()) {
    return {
      ok: false,
      error: "AI step produced no text output.",
      model,
      ...(usage ? { usage } : {}),
      ...(capabilities ? { capabilities } : {}),
    };
  }
  // Dash normalization happens HERE, before the text enters the context store
  // — so every downstream step reads normalized text, and the persisted
  // artifact and the returned deliverable are normalized by construction
  // rather than at each write site. See text-normalize.ts for why the runner
  // is this utility's home.
  return {
    ok: true,
    output: normalizeDashesDeep(text),
    model,
    ...(usage ? { usage } : {}),
    ...(capabilities ? { capabilities } : {}),
  };
}
