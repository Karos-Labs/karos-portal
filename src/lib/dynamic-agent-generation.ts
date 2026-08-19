import "server-only";

/**
 * Free-text → dynamic agent draft. An admin describes the agent they want in
 * plain English; this module turns that into a complete `inputSchema` +
 * `steps` pair the editor can render as an unsaved draft.
 *
 * // DECISION: AI-only. The generator never emits a `code` step. Code steps
 * ship behind `DYNAMIC_CODE_STEPS_ENABLED` (default OFF, per CLAUDE.md) —
 * generating one by default would hand back a draft whose pipeline silently
 * fails on most environments. Every house-rule capability (extraction vs.
 * writing, model tiers, capability grants) is fully expressible with AI
 * steps alone; an admin who wants a code step adds one by hand afterward,
 * same as any other manual pipeline edit.
 *
 * // DECISION: `order` is never part of the generated schema. The model
 * returns arrays in the order it wants them rendered/run; `order` is
 * assigned positionally from that array index before the draft is validated
 * — one fewer integer for the model to track correctly, and it is exactly
 * how the Studio's own "add a field/step" UI already assigns `order` to a
 * freshly added item.
 */

import { generateObject, NoObjectGeneratedError } from "ai";
import { anthropic } from "@ai-sdk/anthropic";
import { z } from "zod";
import { DOC_MAX_TOKENS, MODELS } from "@/lib/constants";
import {
  validateAndNormalizeInputSchema,
  validateAndNormalizeSteps,
  INPUT_KEY_RE,
} from "@/lib/dynamic-agent-validation";
import { checkDanglingReferences } from "@/lib/dynamic-agent-reference-check";
import { logger } from "@/services/logger";
import type { DynamicAgentInputDef, DynamicAgentStepDef } from "@/lib/types";

const GeneratedInputDef = z.object({
  key: z
    .string()
    .describe("Lowercase, variable-name-like, e.g. 'company_name'. Must match ^[a-z][a-z0-9_]*$, unique within the agent."),
  type: z.enum(["text", "textarea", "file", "image", "select"]),
  label: z.string().describe("Short, client-facing field label."),
  helpText: z
    .string()
    .optional()
    .describe("Persistent instruction copy shown ABOVE the field. Use this for anything the client must know before answering — never a placeholder."),
  required: z.boolean(),
  placeholder: z
    .string()
    .optional()
    .describe("Ghost example text INSIDE the control. text/textarea only. Never an instruction — that belongs in helpText."),
  options: z.array(z.string()).optional().describe("Required when type is 'select'; forbidden otherwise."),
  accept: z.string().optional().describe("file/image only, e.g. 'image/png,image/jpeg'."),
  maxSizeMb: z.number().optional().describe("file/image only."),
});

const GeneratedStep = z.object({
  id: z.string().describe("Single lowercase descriptive word, unique within the pipeline, e.g. 'research', 'draft', 'gaps'."),
  label: z.string().describe("Short, human-readable step name."),
  model: z
    .enum(["haiku", "sonnet", "opus"])
    .describe("haiku for extraction/sorting/classification; sonnet for writing and judgement; opus ONLY when the phrasing itself is the product."),
  prompt: z
    .string()
    .describe(
      "Markdown prompt. Reference client answers and earlier steps' outputs with {{inputs.KEY}} / {{outputs.STEP_ID}} — STEP_ID must be an EARLIER step in this same array, never itself or a later one.",
    ),
  allowNetwork: z.boolean().describe("True only when the description explicitly asks for behaviour that needs live network access. Default false."),
  allowClientData: z.boolean().describe("True only when the description explicitly asks this step to draw on the client's own stored documents. Default false."),
});

const GENERATION_SCHEMA = z.object({
  inputSchema: z.array(GeneratedInputDef).max(40),
  steps: z.array(GeneratedStep).min(1).max(40),
  notes: z
    .array(z.string())
    .describe(
      "Every assumption made because the description was silent, and the justifying sentence for every step that got allowNetwork/allowClientData. Empty array if there is genuinely nothing to flag.",
    ),
});

type GeneratedDraft = z.infer<typeof GENERATION_SCHEMA>;

/**
 * The free-text description length cap, enforced by
 * `generateDynamicAgentDraftAction` before it ever calls into this module.
 * Lives here rather than as a plain `export const` inside
 * `dynamic-agent-actions.ts` — a `"use server"` module — because
 * server-action-authorizer-sweep.test.ts fails closed on any export shape
 * in an action module it cannot prove is not itself a server action (see
 * that file's "knows every export shape these modules use").
 */
export const MAX_GENERATION_DESCRIPTION_CHARS = 5_000;

const SYSTEM_PROMPT = `You design dynamic agents for the Karos CMO Agent Studio — a no-code pipeline builder. Given an admin's plain-English description of an agent, you produce its input schema and step pipeline as structured data. You never write the agent's actual marketing output; you design the FORM and the PROMPTS that will later produce it.

House design rules — every one of these is load-bearing, not a style preference:

INPUT SCHEMA
- Keys are lowercase, variable-name-like (^[a-z][a-z0-9_]*$), unique.
- Prefer "select" over "text"/"textarea" for any value with a finite answer set (tone, platform, industry, goal, permission, restriction level). Free text on a finite-answer question produces three spellings of one value.
- helpText carries an instruction and stays on screen. placeholder carries an example and disappears on the first keystroke. NEVER put an instruction in a placeholder.
- placeholder only on text/textarea. options only on select (and required there). accept/maxSizeMb only on file/image.
- Give every client restriction, prohibition, or compliance constraint mentioned in the description ITS OWN dedicated field — never bury it inside a general notes field, where it will be missed.
- If the description says the agent works entirely from the client's own stored documents (its "client data" access) and asks the client nothing, output an EMPTY inputSchema array. Do not invent fields just to have some.

PIPELINE
- Every step has a non-empty label. Step ids are single lowercase descriptive words, unique.
- Split extraction from writing into TWO steps when the final output must persuade or represent the client favorably: one step extracts and states facts plainly (and explicitly says "not stated in the source" for anything the input material doesn't support), a second step writes from that extraction. A single step asked to both extract facts and be persuasive will invent plausible-sounding gaps. One step is enough when the output only has to report, not persuade.
- Model tiers: haiku for extraction, sorting, classification. sonnet for writing and judgement. opus ONLY when the exact phrasing is the product itself (e.g. a single polished headline), never as a default upgrade.
- allowNetwork and allowClientData both default to false. Set either to true ONLY when the description explicitly describes behaviour that needs it, and when you do, add a note naming the sentence of the description that justified it.
- The FINAL step that produces client-facing text must follow these house text rules: no em dashes or double hyphens, sentence case (not Title Case), no exclamation marks, English only, no superlative ("best", "leading", "revolutionary") without evidence in the input, no number that was not given to you in the description or an earlier step's output.
- The final step's prompt must instruct it to end its own output with an internal "gaps" section listing anything it could not support from the given information.
- Reference an earlier step's output with {{outputs.STEP_ID}} where STEP_ID is a step that appears BEFORE this one in your own steps array — never itself, never a step that comes after it. Reference a client answer with {{inputs.KEY}} where KEY is a key in your own inputSchema array.

Return ONLY the structured draft. Do not include any step that writes actual example marketing copy about a specific company — you are designing the pipeline, not running it.`;

function toPortalInputSchema(generated: GeneratedDraft["inputSchema"]): DynamicAgentInputDef[] {
  return generated.map((field, index) => ({
    key: field.key,
    type: field.type,
    label: field.label,
    required: field.required,
    order: index,
    ...(field.helpText ? { helpText: field.helpText } : {}),
    ...(field.placeholder ? { placeholder: field.placeholder } : {}),
    ...(field.options ? { options: field.options } : {}),
    ...(field.accept ? { accept: field.accept } : {}),
    ...(field.maxSizeMb != null ? { maxSizeMb: field.maxSizeMb } : {}),
  }));
}

function toPortalSteps(generated: GeneratedDraft["steps"]): DynamicAgentStepDef[] {
  return generated.map((step, index) => ({
    id: step.id,
    type: "ai" as const,
    label: step.label,
    model: step.model,
    prompt: step.prompt,
    order: index,
    allowNetwork: step.allowNetwork,
    allowClientData: step.allowClientData,
  }));
}

/** Every validation error a generated draft must clear, as one combined message, or null when it's clean. */
function validateDraft(inputSchema: DynamicAgentInputDef[], steps: DynamicAgentStepDef[]): string | null {
  const inputResult = validateAndNormalizeInputSchema(inputSchema);
  if (!inputResult.ok) return inputResult.error;
  const stepsResult = validateAndNormalizeSteps(steps);
  if (!stepsResult.ok) return stepsResult.error;
  const dangling = checkDanglingReferences(inputResult.inputSchema, stepsResult.steps);
  if (dangling.length > 0) return dangling.join(" ");
  return null;
}

/**
 * The output-token ceiling for one generation call. Reuses `DOC_MAX_TOKENS`
 * (documented in constants.ts as the Sonnet 4.6 ceiling this codebase already
 * verified) rather than a fresh magic number.
 *
 * // DECISION (2026-08, bugfix): this was previously hardcoded to 4_000,
 * which is not enough room for a draft with more than a handful of
 * inputs/steps — a richly-detailed description (still well under the 5,000
 * char cap `generateDynamicAgentDraftAction` enforces) routinely produces a
 * schema-valid draft that simply doesn't fit in 4,000 tokens. The model does
 * not fail gracefully when it runs out of room: it stops mid-JSON-string,
 * the AI SDK throws `NoObjectGeneratedError` with `finishReason: "length"`
 * trying to parse the truncated text, and that landed in generateDraft's
 * outer catch as the generic "Generation failed" message — for EVERY
 * sufficiently detailed description, not only unusually long ones.
 */
const GENERATION_MAX_OUTPUT_TOKENS = DOC_MAX_TOKENS;

/**
 * The usage-logging metadata for every call this module makes. `clientId` and
 * `agentId` are null — this is an admin-authored Studio tool, not a
 * client-billed run — but the spend is real Sonnet spend and belongs in
 * `usageLogs`/`agent_runs_bi`/the Agent Leaderboard exactly like any other
 * call, which is the whole point: before this, it was invisible everywhere.
 */
const USAGE_META = {
  clientId: null,
  agentId: null,
  agentName: "dynamic_agent_builder",
  modelName: MODELS.SONNET,
  operation: "dynamic_agent_draft",
} as const;

async function generateOnce(description: string, correction?: string): Promise<GeneratedDraft> {
  const prompt = correction
    ? `${description}\n\n---\nYour previous attempt was invalid for these reasons — fix them and return a corrected draft:\n${correction}`
    : description;
  const startedAt = Date.now();
  const { object, usage } = await generateObject({
    model: anthropic(MODELS.SONNET),
    schema: GENERATION_SCHEMA,
    system: SYSTEM_PROMPT,
    prompt,
    maxOutputTokens: GENERATION_MAX_OUTPUT_TOKENS,
  });
  logger.logUsage({
    ...USAGE_META,
    inputTokens: usage?.inputTokens ?? 0,
    outputTokens: usage?.outputTokens ?? 0,
    durationMs: Date.now() - startedAt,
  });
  return object;
}

/**
 * Turns a truncated generation into the SAME shape of "here's what went
 * wrong, fix it" correction text the validation-failure retry already uses,
 * rather than treating it as an unrecoverable error. `finishReason: "length"`
 * is the AI SDK's signal that the model was cut off by the token ceiling
 * mid-object, NOT a validation problem — it needs a different instruction
 * (write less, not write differently) but the same one-retry budget covers
 * it fine. Returns null for every other kind of thrown error, which the
 * caller re-throws unchanged into the outer catch (auth/network/etc. are not
 * this function's concern).
 */
function truncationCorrection(err: unknown): string | null {
  if (!NoObjectGeneratedError.isInstance(err) || err.finishReason !== "length") return null;
  return "Your previous attempt was cut off before it finished — it asked for too many steps/fields, or wrote prompts longer than necessary. Return a SHORTER, more concise draft this time: fewer steps, more compact prompts, no redundant fields — while still covering every requirement in the description.";
}

/** One generation call, with a truncated response reported as a correction rather than thrown. Anything else thrown propagates to the caller. */
async function attemptGeneration(
  description: string,
  correction?: string,
): Promise<{ ok: true; draft: GeneratedDraft } | { ok: false; correction: string }> {
  try {
    return { ok: true, draft: await generateOnce(description, correction) };
  } catch (err) {
    const truncation = truncationCorrection(err);
    if (truncation) {
      // A truncated attempt still spent real tokens (NoObjectGeneratedError
      // carries the failed attempt's `.usage`) — `generateOnce` never reached
      // its own logUsage call because generateObject threw, so this attempt
      // must record itself or the spend is simply absent from every usage
      // surface, the exact gap this whole module used to have on every path.
      logger.logGenerationFailure(USAGE_META, err);
      return { ok: false, correction: truncation };
    }
    throw err;
  }
}

/**
 * Generates a draft, validates it against the SAME validators a hand-built
 * spec clears (including the dangling-reference check), and retries ONCE —
 * passing the specific errors back — on failure. Never returns an invalid
 * draft: a second failure is reported as an error, not handed to the admin
 * to fix by hand. `key`/`id` collisions across the whole draft that the
 * per-field Zod schema cannot express on its own (uniqueness) are caught by
 * `validateAndNormalizeInputSchema`/`validateAndNormalizeSteps`, same as a
 * hand-built spec.
 *
 * The one retry budget is shared by BOTH failure modes: a schema-valid but
 * house-rule-invalid draft (dangling reference, bad key, etc.) and a
 * generation that got cut off by the token ceiling before it finished. Either
 * one produces a correction string that becomes the retry's prompt.
 */
export async function generateDynamicAgentDraft(
  description: string,
): Promise<
  { ok: true; inputSchema: DynamicAgentInputDef[]; steps: DynamicAgentStepDef[]; notes: string[] } | { ok: false; error: string }
> {
  try {
    const first = await attemptGeneration(description);
    let correction: string;
    if (first.ok) {
      const firstInputSchema = toPortalInputSchema(first.draft.inputSchema);
      const firstSteps = toPortalSteps(first.draft.steps);
      const firstError = validateDraft(firstInputSchema, firstSteps);
      if (!firstError) return { ok: true, inputSchema: firstInputSchema, steps: firstSteps, notes: first.draft.notes };
      correction = firstError;
    } else {
      correction = first.correction;
    }

    const retry = await attemptGeneration(description, correction);
    if (!retry.ok) {
      return {
        ok: false,
        error: "Generation was cut off twice in a row. Try a shorter or more focused description, or build the agent by hand.",
      };
    }
    const retryInputSchema = toPortalInputSchema(retry.draft.inputSchema);
    const retrySteps = toPortalSteps(retry.draft.steps);
    const retryError = validateDraft(retryInputSchema, retrySteps);
    if (!retryError) return { ok: true, inputSchema: retryInputSchema, steps: retrySteps, notes: retry.draft.notes };

    return { ok: false, error: `Generation produced an invalid draft twice. Last error: ${retryError}` };
  } catch (err) {
    logger.logError({
      clientId: null,
      agentId: null,
      operation: "dynamic_agent_generation",
      errorMessage: err instanceof Error ? err.message : String(err),
      severity: "ERROR",
    });
    return { ok: false, error: "Generation failed. Try rephrasing the description, or build the agent by hand." };
  }
}

/** Re-exported for the reference-check-adjacent test files that want the key pattern without importing the whole validation module. */
export { INPUT_KEY_RE };
