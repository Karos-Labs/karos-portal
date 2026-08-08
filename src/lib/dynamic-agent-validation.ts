/**
 * Pure validation/normalization for the Agent Studio (Phases 2/3/5). No
 * Firestore, no auth, no "server-only" — mirrors the credits.ts / data.ts
 * split this codebase already uses (pure pricing math vs. transactional
 * writes) so this logic is unit-testable on its own and importable from a
 * client component if a future revision wants inline validation.
 * `lib/actions/dynamic-agent-actions.ts` is the only thing that adds the
 * server-only pieces (requireAdmin, Firestore reads/writes) around these.
 */

import type {
  DynamicAgentInputDef,
  DynamicAgentModelAlias,
  DynamicAgentStepDef,
} from "@/lib/types";

export const MAX_NAME_CHARS = 200;
export const MAX_SUMMARY_CHARS = 160;
const MAX_DESCRIPTION_CHARS = 2_000;
export const MAX_CATEGORY_CHARS = 60;
export const MAX_ICON_CHARS = 60;
export const MAX_ALLOWED_CLIENTS = 1_000;

export const MAX_INPUT_FIELDS = 40;
export const MAX_INPUT_LABEL_CHARS = 200;
export const MAX_INPUT_PLACEHOLDER_CHARS = 120;
const MAX_INPUT_HELP_CHARS = 500;
export const MAX_INPUT_OPTIONS = 40;
export const MAX_INPUT_OPTION_CHARS = 200;
export const MAX_ACCEPT_CHARS = 300;
export const MAX_SIZE_MB = 200;

export const MAX_STEPS = 40;
export const MAX_STEP_LABEL_CHARS = 200;
export const MAX_PROMPT_CHARS = 20_000;
export const MAX_CODE_CHARS = 20_000;
export const DEFAULT_CODE_TIMEOUT_MS = 30_000;
export const MAX_CODE_TIMEOUT_MS = 120_000;

/**
 * The context-variable name the builder's key becomes for AI prompts and code
 * steps. Mirrors the pattern other slug-like fields in this codebase use
 * (entrySkillDir's SKILL_DIR_RE, agent `key`), scoped down to a bare
 * identifier since this is interpolated into prompts/scripts, not a path.
 */
export const INPUT_KEY_RE = /^[a-z][a-z0-9_]*$/;

export const MODEL_ALIASES: DynamicAgentModelAlias[] = ["opus", "sonnet", "haiku"];

export interface DynamicAgentGeneralInput {
  name: string;
  /** One-line pitch for list surfaces. Optional — readers fall back to `description`. */
  summary?: string;
  description: string;
  category: string;
  icon: string;
  /** Integer >= 0. */
  creditsCost: number;
  active: boolean;
  /** Empty/absent = every client may run this agent. */
  allowedClientIds?: string[];
}

export function validateGeneral(input: DynamicAgentGeneralInput): string | null {
  if (!input.name.trim()) return "Name is required.";
  if (input.name.trim().length > MAX_NAME_CHARS) {
    return `Name is too long (max ${MAX_NAME_CHARS} characters).`;
  }
  // Optional by design: a one-liner is a nicety for list surfaces, not a second
  // thing every admin must write before they can save. Capped tightly, because a
  // "summary" that wraps to three lines defeats the layout it exists for.
  if ((input.summary ?? "").trim().length > MAX_SUMMARY_CHARS) {
    return `Summary is too long (max ${MAX_SUMMARY_CHARS} characters) - it is a one-line pitch, so put the detail in the description.`;
  }
  if (!input.description.trim()) return "Description is required.";
  if (input.description.trim().length > MAX_DESCRIPTION_CHARS) {
    return `Description is too long (max ${MAX_DESCRIPTION_CHARS.toLocaleString()} characters).`;
  }
  if (!input.category.trim()) return "Category is required.";
  if (input.category.trim().length > MAX_CATEGORY_CHARS) {
    return `Category is too long (max ${MAX_CATEGORY_CHARS} characters).`;
  }
  if (!input.icon.trim()) return "Icon is required.";
  if (input.icon.trim().length > MAX_ICON_CHARS) {
    return `Icon is too long (max ${MAX_ICON_CHARS} characters).`;
  }
  if (!Number.isInteger(input.creditsCost) || input.creditsCost < 0) {
    return "Credits cost must be a whole number of 0 or more.";
  }
  if ((input.allowedClientIds ?? []).length > MAX_ALLOWED_CLIENTS) {
    return "Too many allowed clients selected.";
  }
  return null;
}

/**
 * Validates one input-schema field (Phase 3). `options` required for
 * `type === "select"` and forbidden otherwise; `accept`/`maxSizeMb` only make
 * sense for `file`/`image`.
 */
function validateInputDef(input: DynamicAgentInputDef, seenKeys: Set<string>): string | null {
  const key = input.key.trim();
  if (!key) return "Every input field needs a key.";
  if (!INPUT_KEY_RE.test(key)) {
    return `Invalid key "${key}" — keys must start with a lowercase letter and contain only lowercase letters, digits, and underscores.`;
  }
  if (seenKeys.has(key)) return `Duplicate input key "${key}" — keys must be unique within an agent.`;
  seenKeys.add(key);

  if (!input.label.trim()) return `Field "${key}" needs a label.`;
  if (input.label.trim().length > MAX_INPUT_LABEL_CHARS) {
    return `Label for "${key}" is too long (max ${MAX_INPUT_LABEL_CHARS} characters).`;
  }
  if ((input.helpText ?? "").length > MAX_INPUT_HELP_CHARS) {
    return `Help text for "${key}" is too long (max ${MAX_INPUT_HELP_CHARS} characters).`;
  }
  // A placeholder is ghost text inside the control, so it only exists for the
  // two types that HAVE one: a select shows its own "Select…" option and a file
  // input's chrome belongs to the browser. Fenced the same way options and
  // accept are, rather than being silently ignored on the types that can't show it.
  if (input.type === "text" || input.type === "textarea") {
    if ((input.placeholder ?? "").length > MAX_INPUT_PLACEHOLDER_CHARS) {
      return `Placeholder for "${key}" is too long (max ${MAX_INPUT_PLACEHOLDER_CHARS} characters).`;
    }
  } else if (input.placeholder) {
    return `Field "${key}" is a ${input.type} field, which has no placeholder — put the guidance in its help text instead.`;
  }

  if (input.type === "select") {
    const options = input.options ?? [];
    if (options.length === 0) return `Field "${key}" is a select field and needs at least one option.`;
    if (options.length > MAX_INPUT_OPTIONS) return `Field "${key}" has too many options (max ${MAX_INPUT_OPTIONS}).`;
    if (options.some((o) => !o.trim())) return `Field "${key}" has a blank option.`;
    if (options.some((o) => o.length > MAX_INPUT_OPTION_CHARS)) {
      return `An option for "${key}" is too long (max ${MAX_INPUT_OPTION_CHARS} characters).`;
    }
  } else if (input.options && input.options.length > 0) {
    return `Field "${key}" is not a select field and cannot have options.`;
  }

  if (input.type === "file" || input.type === "image") {
    if (input.accept && input.accept.length > MAX_ACCEPT_CHARS) {
      return `The accepted-file list for "${key}" is too long.`;
    }
    if (
      input.maxSizeMb != null &&
      (!Number.isFinite(input.maxSizeMb) || input.maxSizeMb <= 0 || input.maxSizeMb > MAX_SIZE_MB)
    ) {
      return `Max file size for "${key}" must be between 1 and ${MAX_SIZE_MB} MB.`;
    }
  } else if (input.accept || input.maxSizeMb != null) {
    return `Field "${key}" is not a file/image field and cannot set an accept list or max size.`;
  }

  return null;
}

/** Reorders + re-indexes to a dense, 0-indexed `order` — the contract Phase 3 promises on save. */
function normalizeInputSchema(inputs: DynamicAgentInputDef[]): DynamicAgentInputDef[] {
  return [...inputs]
    .sort((a, b) => a.order - b.order)
    .map((input, index) => ({
      ...input,
      key: input.key.trim(),
      label: input.label.trim(),
      helpText: input.helpText?.trim() || undefined,
      placeholder:
        input.type === "text" || input.type === "textarea" ? input.placeholder?.trim() || undefined : undefined,
      options: input.type === "select" ? (input.options ?? []).map((o) => o.trim()) : undefined,
      accept: input.type === "file" || input.type === "image" ? input.accept?.trim() || undefined : undefined,
      maxSizeMb: input.type === "file" || input.type === "image" ? (input.maxSizeMb ?? undefined) : undefined,
      order: index,
    }));
}

export function validateAndNormalizeInputSchema(
  inputs: DynamicAgentInputDef[],
): { ok: true; inputSchema: DynamicAgentInputDef[] } | { ok: false; error: string } {
  if (inputs.length > MAX_INPUT_FIELDS) {
    return { ok: false, error: `At most ${MAX_INPUT_FIELDS} input fields per agent.` };
  }
  const seenKeys = new Set<string>();
  for (const input of [...inputs].sort((a, b) => a.order - b.order)) {
    const error = validateInputDef(input, seenKeys);
    if (error) return { ok: false, error };
  }
  return { ok: true, inputSchema: normalizeInputSchema(inputs) };
}

/** Validates one pipeline step (Phase 5). // DECISION: `dependsOn` must be empty in v1. */
function validateStepDef(step: DynamicAgentStepDef, seenIds: Set<string>): string | null {
  const id = step.id.trim();
  if (!id) return "Every step needs an id.";
  if (seenIds.has(id)) return `Duplicate step id "${id}" — step ids must be unique.`;
  seenIds.add(id);
  if (!step.label.trim()) return `Step "${id}" needs a label.`;
  if (step.label.trim().length > MAX_STEP_LABEL_CHARS) {
    return `Label for step "${id}" is too long (max ${MAX_STEP_LABEL_CHARS} characters).`;
  }
  // DECISION: sequential-only in v1 — a populated dependsOn is rejected outright,
  // here and again in agent-service/runner/src/dynamic/step-runner.ts.
  if (step.dependsOn && step.dependsOn.length > 0) {
    return `Step "${id}" sets dependsOn, but this version of the Pipeline Builder only supports a strict sequential order — remove it and rely on step order instead.`;
  }

  if (step.type === "ai") {
    if (!MODEL_ALIASES.includes(step.model)) {
      return `Step "${id}" has an invalid model — pick opus, sonnet, or haiku.`;
    }
    if (!step.prompt.trim()) return `Step "${id}" needs a prompt.`;
    if (step.prompt.length > MAX_PROMPT_CHARS) {
      return `The prompt for step "${id}" is too long (max ${MAX_PROMPT_CHARS.toLocaleString()} characters).`;
    }
  } else if (step.type === "code") {
    if (step.language !== "python" && step.language !== "node") {
      return `Step "${id}" has an invalid language — pick python or node.`;
    }
    if (!step.code.trim()) return `Step "${id}" needs code.`;
    if (step.code.length > MAX_CODE_CHARS) {
      return `The code for step "${id}" is too long (max ${MAX_CODE_CHARS.toLocaleString()} characters).`;
    }
    if (
      step.timeoutMs != null &&
      (!Number.isInteger(step.timeoutMs) || step.timeoutMs <= 0 || step.timeoutMs > MAX_CODE_TIMEOUT_MS)
    ) {
      return `The timeout for step "${id}" must be a whole number of ms between 1 and ${MAX_CODE_TIMEOUT_MS.toLocaleString()}.`;
    }
  } else {
    return `Step "${id}" has an unrecognized type.`;
  }
  return null;
}

function normalizeSteps(steps: DynamicAgentStepDef[]): DynamicAgentStepDef[] {
  return [...steps]
    .sort((a, b) => a.order - b.order)
    .map((step, index) => {
      const base = { id: step.id.trim(), label: step.label.trim(), order: index };
      if (step.type === "ai") {
        return { ...base, type: "ai" as const, model: step.model, prompt: step.prompt };
      }
      return {
        ...base,
        type: "code" as const,
        language: step.language,
        code: step.code,
        timeoutMs: step.timeoutMs ?? DEFAULT_CODE_TIMEOUT_MS,
      };
    });
}

export function validateAndNormalizeSteps(
  steps: DynamicAgentStepDef[],
): { ok: true; steps: DynamicAgentStepDef[] } | { ok: false; error: string } {
  if (steps.length === 0) return { ok: false, error: "Add at least one step." };
  if (steps.length > MAX_STEPS) return { ok: false, error: `At most ${MAX_STEPS} steps per agent.` };
  const seenIds = new Set<string>();
  for (const step of [...steps].sort((a, b) => a.order - b.order)) {
    const error = validateStepDef(step, seenIds);
    if (error) return { ok: false, error };
  }
  return { ok: true, steps: normalizeSteps(steps) };
}
