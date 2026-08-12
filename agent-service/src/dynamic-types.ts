/**
 * Dynamic Agent Studio — agent-service's own local mirror of the Portal's
 * declarative types (karosCMO/src/lib/types.ts). Deliberately NOT
 * cross-imported from the Portal (the two repos deploy independently); kept
 * structurally identical by hand. If you change one side, change the other.
 *
 * The generic execution engine (runner/src/dynamic/) reads a job's frozen
 * `specSnapshot` (see DynamicAgentJobPayload) and runs its `steps` in order.
 * This is ADDITIVE — the existing hardcoded task types in task-types.ts are
 * untouched.
 */

/** Client intake field kinds the Agent Studio's input builder can produce. */
export type DynamicAgentInputType = "text" | "textarea" | "file" | "image" | "select";

export interface DynamicAgentInputDef {
  key: string;
  type: DynamicAgentInputType;
  label: string;
  helpText?: string;
  required: boolean;
  /** `text`/`textarea` only: ghost text inside the control. See the Portal's copy. */
  placeholder?: string;
  /** Required when type === "select" (the choices); forbidden for every other type. */
  options?: string[];
  /** file/image only: an <input accept> string, e.g. "image/png,image/jpeg". */
  accept?: string;
  /** file/image only: per-file cap in megabytes. */
  maxSizeMb?: number;
  order: number;
}

/**
 * The UI and the spec store the alias only — never a raw model id.
 * AGENT_MODEL_ALIASES in task-types.ts resolves it to a concrete model id.
 */
export type DynamicAgentModelAlias = "opus" | "sonnet" | "haiku";

/**
 * One pipeline step. A discriminated union on `type` so a `switch (step.type)`
 * narrows to the right shape with no `any`.
 *
 * // DECISION: v1 is sequential-only — `steps` is executed strictly in the
 * order given, and step-runner.ts REJECTS any spec where any step's
 * `dependsOn` is non-empty, with a plain English validation error.
 * `dependsOn` exists from day one so the schema is DAG-ready for later.
 */
export type DynamicAgentStepDef =
  | {
      id: string;
      type: "ai";
      label: string;
      model: DynamicAgentModelAlias;
      prompt: string;
      order: number;
      dependsOn?: string[];
      /** May this step reach the network? Default false (absent === false). See the Portal's copy. */
      allowNetwork?: boolean;
      /** May this step read this client's own documents? Default false (absent === false). See the Portal's copy. */
      allowClientData?: boolean;
    }
  | {
      id: string;
      type: "code";
      label: string;
      language: "python" | "node";
      code: string;
      timeoutMs?: number;
      order: number;
      dependsOn?: string[];
    };

export interface DynamicAgentSpec {
  id: string;
  name: string;
  /** One-line pitch for list surfaces; readers fall back to `description`. */
  summary?: string;
  description: string;
  category: string;
  icon: string;
  creditsCost: number;
  active: boolean;
  version: number;
  allowedClientIds?: string[];
  inputSchema: DynamicAgentInputDef[];
  steps: DynamicAgentStepDef[];
  /** Opt-in output de-duplication. Default false (absent === false). See the Portal's copy and docs/dynamic-agent-guardrails.md. */
  dedupeAgainstHistory?: boolean;
  createdAt: number;
  updatedAt: number;
  createdBy: string;
  /**
   * The admin who saved the most recent version.
   *
   * ASSUMPTION, flagged: Phase 2 says every update "stamps `updatedAt` /
   * `createdBy`". Taken literally that would overwrite `createdBy` with the
   * editing admin's uid on every save, destroying the authorship the field
   * name promises - so `createdBy` is preserved and the editor is recorded
   * here instead. Absent on specs saved before this field existed.
   */
  updatedBy?: string;
}

export type DynamicAgentInputValue =
  | string
  | string[]
  | { id: string; url: string; name: string }
  | { id: string; url: string; name: string }[]
  | null;

/**
 * The brief payload the Portal builds for a dynamic-agent run
 * (karosCMO/src/lib/jobs/submit-custom.ts). `specSnapshot` is a deep clone
 * taken at job-creation time — the runner executes ONLY this snapshot, never
 * a live spec, so a running job can never observe a mid-flight admin edit.
 */
export interface DynamicAgentJobPayload {
  specId: string;
  specVersion: number;
  specSnapshot: DynamicAgentSpec;
  clientId: string;
  inputs: Record<string, DynamicAgentInputValue>;
  runType?: string;
  /**
   * Per-step model routing, keyed by step id, carrying the model ALIAS only.
   * This is the brief's existing `step_models` field (the same one the
   * hardcoded custom-agent path populates from CustomAgent.stepModels), reused
   * rather than duplicated — the runner prefers it over the snapshot's own
   * `step.model`. See resolveStepModel() in the dynamic step runner.
   */
  stepModels?: Record<string, string>;
  /**
   * This client's topic guardrails, frozen at job-creation time exactly like
   * `specSnapshot`. Absent when the client has no forbidden topics, which is
   * what makes the feature inert — see docs/dynamic-agent-guardrails.md.
   */
  guardrails?: { forbiddenTopics: string[] };
  /** Prior deliverables from this same agent for this client, newest first. Present only when the snapshot sets `dedupeAgainstHistory`. */
  outputHistory?: { items: DynamicAgentHistoryItem[] };
}

/** One prior deliverable, as shown to a de-duplicating run. */
export interface DynamicAgentHistoryItem {
  jobId: string;
  createdAt: number;
  excerpt: string;
}

/** True when a raw custom-task brief carries a frozen dynamic-agent snapshot. */
export function isDynamicAgentBrief(
  brief: Record<string, unknown>,
): brief is { specSnapshot: DynamicAgentSpec } & Record<string, unknown> {
  return (
    typeof brief.specSnapshot === "object" &&
    brief.specSnapshot !== null &&
    Array.isArray((brief.specSnapshot as DynamicAgentSpec).steps)
  );
}
