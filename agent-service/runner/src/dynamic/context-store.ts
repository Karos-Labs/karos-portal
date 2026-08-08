import type { DynamicAgentInputValue } from "../../../src/dynamic-types.js";

/**
 * The run context every step sees: the client's answers, plus every earlier
 * step's own output keyed by its `stepId`. Each step receives the FULL
 * accumulated context (Phase 7's contract) — a step never gets a narrowed
 * view, so a prompt/script can reach back to any prior step's output, not
 * just its immediate predecessor's.
 */
export interface DynamicRunContext {
  inputs: Record<string, DynamicAgentInputValue>;
  outputs: Record<string, unknown>;
}

export function createContextStore(inputs: Record<string, DynamicAgentInputValue>): DynamicRunContext {
  // A fresh plain object copy — never the caller's own `inputs` reference —
  // so nothing downstream can mutate the brief's original input map.
  return { inputs: { ...inputs }, outputs: {} };
}

export function withStepOutput(
  context: DynamicRunContext,
  stepId: string,
  output: unknown,
): DynamicRunContext {
  return { ...context, outputs: { ...context.outputs, [stepId]: output } };
}

/**
 * Deterministic JSON serialization — keys sorted at every object level, so
 * the exact same context always serializes to the exact same string. This is
 * what "runs are reproducible" (Phase 7's acceptance) means in practice: two
 * runs of the same spec against the same inputs and the same step outputs
 * produce byte-identical prompts / stdin, so a diff between two runs' traces
 * is a diff of what actually changed, not of key ordering.
 */
export function serializeContext(context: DynamicRunContext): string {
  return stableStringify(context);
}

function stableStringify(value: unknown): string {
  return JSON.stringify(sortKeysDeep(value));
}

function sortKeysDeep(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(sortKeysDeep);
  if (value !== null && typeof value === "object") {
    const sorted: Record<string, unknown> = {};
    for (const key of Object.keys(value as Record<string, unknown>).sort()) {
      sorted[key] = sortKeysDeep((value as Record<string, unknown>)[key]);
    }
    return sorted;
  }
  return value;
}
