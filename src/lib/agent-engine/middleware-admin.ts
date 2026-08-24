import "server-only";

import { middlewareFetch, MiddlewareRequestError } from "./middleware-http";

/**
 * Read/write client for `agent-middleware`'s control-plane REST API.
 *
 * `middleware-client.ts` is the *dispatch* path — one endpoint, on the hot
 * path of every job, with a fallback to direct Pub/Sub because a job must
 * never be orphaned. This is the *administration* path: agents, prompt
 * versions, templates and reviewer feedback, called from admin server actions.
 *
 * There is deliberately no fallback here. Dispatch falls back because the work
 * can still be done another way; there is no other way to edit a prompt
 * version, and pretending an edit succeeded would be worse than reporting that
 * it did not.
 *
 * ## Naming
 *
 * The wire is snake_case (FastAPI/Pydantic) and this repo is camelCase. The
 * boundary is here: every exported type is camelCase and every function
 * translates. Callers never see a snake_case key, so a rename on either side
 * breaks in one file rather than in every component that touched a field.
 */

export { MiddlewareRequestError } from "./middleware-http";

export type AgentStatus = "active" | "disabled";
export type FeedbackStatus = "approved" | "rejected" | "needs_changes";
export type TemplateKind = "layout" | "email" | "social" | "prompt_fragment" | "other";

/** Every list endpoint's envelope. `total` is null where Firestore cannot count cheaply. */
export interface Page<T> {
  items: T[];
  limit: number;
  offset: number;
  hasMore: boolean;
  total: number | null;
}

export interface AgentStage {
  id: string;
  label: string;
  description: string | null;
  /** A gate pauses for a human — the difference between finishing and waiting. */
  isGate: boolean;
  /**
   * Which kind of step this is, in agent-engine's own vocabulary: `"agent"` for
   * a model step, matching its `StepKindSchema`.
   *
   * Named `"ai"` on both sides of this wire when the feature first shipped,
   * which meant no seeded stage ever matched and the model picker below
   * rendered on none of them.
   */
  kind: "agent" | "code" | "gate";
  /**
   * Which prompt this stage loads, as `"<promptId>@<version>"`. Absent on code
   * steps and on the shared terminal guardrail, which builds its prompt inline
   * from the client's forbidden-topic list.
   */
  skillRef: string | null;
  /**
   * A model id from the normalized catalog, overriding what this stage is
   * compiled to use. Null means "leave the stage alone".
   *
   * Settable even when `stagesReadOnly` is true, and the distinction matters:
   * the stage LIST is compiled TypeScript and editing it here would describe a
   * program that does not exist, but which model a stage runs on is
   * configuration the engine reads per run.
   */
  modelId: string | null;
}

export interface AgentInputDef {
  key: string;
  type: string;
  label: string;
  helpText: string | null;
  required: boolean;
  placeholder: string | null;
  options: string[];
}

export interface MiddlewareAgent {
  id: string;
  slug: string;
  name: string;
  description: string | null;
  status: AgentStatus;
  agentType: string | null;
  model: string | null;
  modelParams: Record<string, unknown>;
  config: Record<string, unknown>;
  tags: string[];
  createdAt: string;
  updatedAt: string;
  // --- catalog / Studio presentation ---
  icon: string | null;
  category: string | null;
  /** Null means "platform default", not free. */
  creditCost: number | null;
  isPublic: boolean;
  requiredInputs: AgentInputDef[];
  /** For hand-written engine workflows these describe code, hence read-only. */
  stages: AgentStage[];
  stagesReadOnly: boolean;
}

export interface MiddlewarePrompt {
  id: string;
  agentId: string;
  version: number;
  content: string;
  notes: string | null;
  variables: string[];
  isActive: boolean;
  createdBy: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface MiddlewareTemplate {
  id: string;
  slug: string;
  name: string;
  description: string | null;
  kind: TemplateKind;
  tags: string[];
  createdAt: string;
  updatedAt: string;
}

export interface MiddlewareFeedback {
  id: string;
  runId: string;
  agentId: string;
  rating: number;
  status: FeedbackStatus;
  correctionNotes: string | null;
  correctedOutput: string | null;
  reviewer: string | null;
  tags: string[];
  /** Non-null once this verdict has been turned into a few-shot example. */
  promotedExampleId: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface MiddlewareExample {
  id: string;
  agentId: string;
  promptId: string | null;
  label: string | null;
  userInput: string;
  assistantOutput: string;
  tags: string[];
  position: number;
  isActive: boolean;
  sourceRunId: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface MiddlewareRun {
  id: string;
  agentId: string;
  status: string;
  jobType: string | null;
  promptId: string | null;
  promptVersion: number | null;
  templateVersionId: string | null;
  inputPayload: Record<string, unknown>;
  output: Record<string, unknown> | null;
  error: string | null;
  pubsubMessageId: string | null;
  requestedBy: string | null;
  completedAt: string | null;
  createdAt: string;
  updatedAt: string;
  feedback: MiddlewareFeedback[];
}

// ── wire -> domain ───────────────────────────────────────────────────────

type Row = Record<string, unknown>;

const str = (v: unknown): string => (typeof v === "string" ? v : "");
const strOrNull = (v: unknown): string | null => (typeof v === "string" && v.length > 0 ? v : null);
const num = (v: unknown, fallback = 0): number => (typeof v === "number" && Number.isFinite(v) ? v : fallback);
const bool = (v: unknown): boolean => v === true;
const strList = (v: unknown): string[] => (Array.isArray(v) ? v.filter((x): x is string => typeof x === "string") : []);
const obj = (v: unknown): Record<string, unknown> =>
  v !== null && typeof v === "object" && !Array.isArray(v) ? (v as Record<string, unknown>) : {};

function toAgent(row: Row): MiddlewareAgent {
  return {
    id: str(row.id),
    slug: str(row.slug),
    name: str(row.name),
    description: strOrNull(row.description),
    status: row.status === "disabled" ? "disabled" : "active",
    agentType: strOrNull(row.agent_type),
    model: strOrNull(row.model),
    modelParams: obj(row.model_params),
    config: obj(row.config),
    tags: strList(row.tags),
    createdAt: str(row.created_at),
    updatedAt: str(row.updated_at),
    icon: strOrNull(row.icon),
    category: strOrNull(row.category),
    creditCost: typeof row.credit_cost === "number" ? row.credit_cost : null,
    isPublic: row.is_public !== false,
    requiredInputs: Array.isArray(row.required_inputs)
      ? row.required_inputs.map((i) => {
          const f = obj(i);
          return {
            key: str(f.key),
            type: str(f.type) || "text",
            label: str(f.label),
            helpText: strOrNull(f.help_text),
            required: f.required === true,
            placeholder: strOrNull(f.placeholder),
            options: strList(f.options),
          };
        })
      : [],
    stages: Array.isArray(row.stages)
      ? row.stages.map((x) => {
          const f = obj(x);
          return {
            id: str(f.id),
            label: str(f.label),
            description: strOrNull(f.description),
            isGate: f.is_gate === true,
            kind: f.kind === "agent" || f.kind === "gate" ? f.kind : "code",
            skillRef: typeof f.skill_ref === "string" ? f.skill_ref : null,
            modelId: typeof f.model_id === "string" ? f.model_id : null,
          };
        })
      : [],
    stagesReadOnly: row.stages_read_only !== false,
  };
}

function toPrompt(row: Row): MiddlewarePrompt {
  return {
    id: str(row.id),
    agentId: str(row.agent_id),
    version: num(row.version),
    content: str(row.content),
    notes: strOrNull(row.notes),
    variables: strList(row.variables),
    isActive: bool(row.is_active),
    createdBy: strOrNull(row.created_by),
    createdAt: str(row.created_at),
    updatedAt: str(row.updated_at),
  };
}

function toTemplate(row: Row): MiddlewareTemplate {
  return {
    id: str(row.id),
    slug: str(row.slug),
    name: str(row.name),
    description: strOrNull(row.description),
    kind: (str(row.kind) || "other") as TemplateKind,
    tags: strList(row.tags),
    createdAt: str(row.created_at),
    updatedAt: str(row.updated_at),
  };
}

function toFeedback(row: Row): MiddlewareFeedback {
  const status = str(row.status);
  return {
    id: str(row.id),
    runId: str(row.run_id),
    agentId: str(row.agent_id),
    rating: num(row.rating),
    status: status === "approved" || status === "rejected" ? status : "needs_changes",
    correctionNotes: strOrNull(row.correction_notes),
    correctedOutput: strOrNull(row.corrected_output),
    reviewer: strOrNull(row.reviewer),
    tags: strList(row.tags),
    promotedExampleId: strOrNull(row.promoted_example_id),
    createdAt: str(row.created_at),
    updatedAt: str(row.updated_at),
  };
}

function toExample(row: Row): MiddlewareExample {
  return {
    id: str(row.id),
    agentId: str(row.agent_id),
    promptId: strOrNull(row.prompt_id),
    label: strOrNull(row.label),
    userInput: str(row.user_input),
    assistantOutput: str(row.assistant_output),
    tags: strList(row.tags),
    position: num(row.position),
    isActive: bool(row.is_active),
    sourceRunId: strOrNull(row.source_run_id),
    createdAt: str(row.created_at),
    updatedAt: str(row.updated_at),
  };
}

function toRun(row: Row): MiddlewareRun {
  return {
    id: str(row.id),
    agentId: str(row.agent_id),
    status: str(row.status),
    jobType: strOrNull(row.job_type),
    promptId: strOrNull(row.prompt_id),
    promptVersion: typeof row.prompt_version === "number" ? row.prompt_version : null,
    templateVersionId: strOrNull(row.template_version_id),
    inputPayload: obj(row.input_payload),
    output: row.output === null || row.output === undefined ? null : obj(row.output),
    error: strOrNull(row.error),
    pubsubMessageId: strOrNull(row.pubsub_message_id),
    requestedBy: strOrNull(row.requested_by),
    completedAt: strOrNull(row.completed_at),
    createdAt: str(row.created_at),
    updatedAt: str(row.updated_at),
    feedback: Array.isArray(row.feedback) ? row.feedback.map((f) => toFeedback(obj(f))) : [],
  };
}

function toPage<T>(body: unknown, map: (row: Row) => T): Page<T> {
  const b = obj(body);
  return {
    items: Array.isArray(b.items) ? b.items.map((i) => map(obj(i))) : [],
    limit: num(b.limit, 50),
    offset: num(b.offset),
    hasMore: bool(b.has_more),
    total: typeof b.total === "number" ? b.total : null,
  };
}

function listQuery(options: { limit?: number; offset?: number; status?: string; q?: string } = {}): string {
  const params = new URLSearchParams();
  if (options.limit !== undefined) params.set("limit", String(options.limit));
  if (options.offset !== undefined) params.set("offset", String(options.offset));
  if (options.status) params.set("status", options.status);
  if (options.q) params.set("q", options.q);
  const qs = params.toString();
  return qs ? `?${qs}` : "";
}

/** Path-safe agent reference. Slugs are URL-safe by schema, but ids from other sources are not guaranteed to be. */
const ref = (value: string): string => encodeURIComponent(value);

// ── agents ───────────────────────────────────────────────────────────────

export async function listAgents(
  options: { limit?: number; offset?: number; status?: AgentStatus; q?: string } = {},
): Promise<Page<MiddlewareAgent>> {
  return toPage(await middlewareFetch(`/agents${listQuery(options)}`), toAgent);
}

export async function getAgent(agentRef: string): Promise<MiddlewareAgent> {
  return toAgent(obj(await middlewareFetch(`/agents/${ref(agentRef)}`)));
}

export interface AgentPatch {
  name?: string;
  description?: string | null;
  status?: AgentStatus;
  agentType?: string | null;
  model?: string | null;
  modelParams?: Record<string, unknown>;
  config?: Record<string, unknown>;
  tags?: string[];
  /** The whole stage list. PATCH replaces it, so a caller sends every stage, not a delta. */
  stages?: AgentStage[];
}

/**
 * PATCH semantics: only the keys present are changed. Undefined keys are
 * omitted from the body rather than sent as null, because null is a real
 * value here — it clears `description`.
 */
export async function updateAgent(agentRef: string, patch: AgentPatch): Promise<MiddlewareAgent> {
  const body: Row = {};
  if (patch.name !== undefined) body.name = patch.name;
  if (patch.description !== undefined) body.description = patch.description;
  if (patch.status !== undefined) body.status = patch.status;
  if (patch.agentType !== undefined) body.agent_type = patch.agentType;
  if (patch.model !== undefined) body.model = patch.model;
  if (patch.modelParams !== undefined) body.model_params = patch.modelParams;
  if (patch.config !== undefined) body.config = patch.config;
  if (patch.tags !== undefined) body.tags = patch.tags;
  if (patch.stages !== undefined) {
    body.stages = patch.stages.map((stage) => ({
      id: stage.id,
      label: stage.label,
      description: stage.description,
      is_gate: stage.isGate,
      kind: stage.kind,
      skill_ref: stage.skillRef,
      model_id: stage.modelId,
    }));
  }

  return toAgent(obj(await middlewareFetch(`/agents/${ref(agentRef)}`, { method: "PATCH", body })));
}

export async function setAgentStatus(agentRef: string, status: AgentStatus): Promise<MiddlewareAgent> {
  return toAgent(obj(await middlewareFetch(`/agents/${ref(agentRef)}/status`, { method: "PATCH", body: { status } })));
}

// ── prompts ──────────────────────────────────────────────────────────────

export async function listPrompts(
  agentRef: string,
  options: { limit?: number; offset?: number } = {},
): Promise<Page<MiddlewarePrompt>> {
  return toPage(await middlewareFetch(`/agents/${ref(agentRef)}/prompts${listQuery(options)}`), toPrompt);
}

export async function getActivePrompt(agentRef: string): Promise<MiddlewarePrompt | null> {
  try {
    return toPrompt(obj(await middlewareFetch(`/agents/${ref(agentRef)}/prompts/active`)));
  } catch (error) {
    // An agent with no prompt yet is a normal state in the studio — it is what
    // the editor exists to fix — not an error to surface as a broken page.
    if (error instanceof MiddlewareRequestError && error.status === 404) return null;
    throw error;
  }
}

export interface NewPromptVersion {
  content: string;
  notes?: string | null;
  variables?: string[];
  createdBy?: string;
  /** Default true. False stores the version without making it live. */
  activate?: boolean;
}

/**
 * Creates a NEW version. Existing versions are immutable by design in the
 * control plane, which is what lets a run's `promptVersion` stay meaningful —
 * so there is no `updatePrompt`, and callers should not expect one.
 */
export async function createPromptVersion(agentRef: string, input: NewPromptVersion): Promise<MiddlewarePrompt> {
  const body: Row = { content: input.content, activate: input.activate ?? true };
  if (input.notes !== undefined) body.notes = input.notes;
  if (input.variables !== undefined) body.variables = input.variables;
  if (input.createdBy !== undefined) body.created_by = input.createdBy;

  return toPrompt(obj(await middlewareFetch(`/agents/${ref(agentRef)}/prompts`, { method: "POST", body })));
}

export async function activatePromptVersion(agentRef: string, promptId: string): Promise<MiddlewarePrompt> {
  return toPrompt(
    obj(await middlewareFetch(`/agents/${ref(agentRef)}/prompts/${ref(promptId)}/activate`, { method: "POST" })),
  );
}

// ── templates ────────────────────────────────────────────────────────────

export async function listTemplates(
  options: { limit?: number; offset?: number; q?: string } = {},
): Promise<Page<MiddlewareTemplate>> {
  return toPage(await middlewareFetch(`/templates${listQuery(options)}`), toTemplate);
}

export async function getTemplate(templateRef: string): Promise<MiddlewareTemplate> {
  return toTemplate(obj(await middlewareFetch(`/templates/${ref(templateRef)}`)));
}

/** Binds a template to an agent for one purpose. The purpose is the link's id, so this is an upsert. */
export async function bindTemplate(
  agentRef: string,
  purpose: string,
  templateRef: string,
  isPrimary = true,
): Promise<void> {
  await middlewareFetch(`/agents/${ref(agentRef)}/templates/${ref(purpose)}`, {
    method: "PUT",
    body: { template_ref: templateRef, is_primary: isPrimary },
  });
}

// ── runs & feedback ──────────────────────────────────────────────────────

export async function getRun(agentRef: string, runId: string): Promise<MiddlewareRun> {
  return toRun(obj(await middlewareFetch(`/agents/${ref(agentRef)}/runs/${ref(runId)}`)));
}

export interface NewFeedback {
  /** 1 (worst) to 5 (best). The middleware rejects anything outside that range. */
  rating: number;
  status: FeedbackStatus;
  correctionNotes?: string;
  /** The output as it should have been — this is what `promoteFeedback` turns into an example. */
  correctedOutput?: string;
  reviewer?: string;
  tags?: string[];
}

/** `POST /agents/{agentRef}/runs/{runId}/feedback` — tier one of the review loop. */
export async function submitFeedback(
  agentRef: string,
  runId: string,
  input: NewFeedback,
): Promise<MiddlewareFeedback> {
  const body: Row = { rating: input.rating, status: input.status };
  if (input.correctionNotes !== undefined) body.correction_notes = input.correctionNotes;
  if (input.correctedOutput !== undefined) body.corrected_output = input.correctedOutput;
  if (input.reviewer !== undefined) body.reviewer = input.reviewer;
  if (input.tags !== undefined) body.tags = input.tags;

  return toFeedback(
    obj(await middlewareFetch(`/agents/${ref(agentRef)}/runs/${ref(runId)}/feedback`, { method: "POST", body })),
  );
}

export async function listFeedback(
  agentRef: string,
  options: { limit?: number; offset?: number; status?: FeedbackStatus } = {},
): Promise<Page<MiddlewareFeedback>> {
  return toPage(await middlewareFetch(`/agents/${ref(agentRef)}/feedback${listQuery(options)}`), toFeedback);
}

/**
 * `POST /agents/{agentRef}/feedback/{feedbackId}/promote` — tier two.
 *
 * Turns a reviewer's correction into an active few-shot example, so the next
 * run is shaped by it. This is the only step that changes what the agent
 * actually does; tier one only records a verdict.
 */
export async function promoteFeedback(
  agentRef: string,
  feedbackId: string,
  options: { label?: string; userInput?: string; assistantOutput?: string; tags?: string[]; position?: number } = {},
): Promise<MiddlewareExample> {
  const body: Row = {};
  if (options.label !== undefined) body.label = options.label;
  if (options.userInput !== undefined) body.user_input = options.userInput;
  if (options.assistantOutput !== undefined) body.assistant_output = options.assistantOutput;
  if (options.tags !== undefined) body.tags = options.tags;
  if (options.position !== undefined) body.position = options.position;

  return toExample(
    obj(await middlewareFetch(`/agents/${ref(agentRef)}/feedback/${ref(feedbackId)}/promote`, { method: "POST", body })),
  );
}

export async function listExamples(
  agentRef: string,
  options: { limit?: number; offset?: number } = {},
): Promise<Page<MiddlewareExample>> {
  return toPage(await middlewareFetch(`/agents/${ref(agentRef)}/examples${listQuery(options)}`), toExample);
}

// ── models ───────────────────────────────────────────────────────────────

export type ModelAvailability = "available" | "not_enabled" | "retired";

export interface MiddlewareModel {
  id: string;
  modelId: string;
  displayName: string;
  vendor: string;
  availability: ModelAvailability;
  /** What the vendor's API expects — not always the id, e.g. Claude on Vertex. */
  providerModelName: string;
  region: string | null;
  description: string | null;
  contextWindow: number | null;
  supportsTools: boolean;
  tiers: string[];
  notes: string | null;
}

function toModel(row: Row): MiddlewareModel {
  const availability = str(row.availability);
  return {
    id: str(row.id),
    modelId: str(row.model_id),
    displayName: str(row.display_name),
    vendor: str(row.vendor),
    availability:
      availability === "not_enabled" || availability === "retired" ? availability : "available",
    providerModelName: str(row.provider_model_name),
    region: strOrNull(row.region),
    description: strOrNull(row.description),
    contextWindow: typeof row.context_window === "number" ? row.context_window : null,
    supportsTools: row.supports_tools !== false,
    tiers: strList(row.tiers),
    notes: strOrNull(row.notes),
  };
}

/**
 * The model catalog a Studio dropdown renders.
 *
 * Returns unselectable models too. A dropdown showing only what works reads as
 * the whole of what Vertex offers, which is how someone concludes a model is
 * unavailable when it is one config change away — so `not_enabled` rows are
 * rendered disabled with a way to ask for them, not filtered out.
 */
export async function listModels(options: { limit?: number } = {}): Promise<Page<MiddlewareModel>> {
  return toPage(await middlewareFetch(`/models${listQuery({ limit: options.limit ?? 100 })}`), toModel);
}

/**
 * Records a request for a model this deployment does not route. Does not
 * enable anything — the middleware stores the ask and a human does the rest.
 */
export async function requestModelAccess(
  modelRef: string,
  input: { requestedBy: string; reason?: string; agentId?: string },
): Promise<{ id: string; status: string }> {
  const body: Row = { requested_by: input.requestedBy };
  if (input.reason) body.reason = input.reason;
  if (input.agentId) body.agent_id = input.agentId;

  const result = obj(await middlewareFetch(`/models/${ref(modelRef)}/access-request`, { method: "POST", body }));
  return { id: str(result.id), status: str(result.status) };
}

// ── engine prompts ───────────────────────────────────────────────────────
//
// The prompt store agent-engine EXECUTES from — `promptVersions/{id}@{n}` —
// which is a different thing from this service's own
// `agents/{slug}/prompts/{version}`. Editing the latter changes nothing about
// what an agent runs; editing this changes the next run.

export interface EnginePrompt {
  promptId: string;
  version: string;
  skillRef: string;
  content: string;
  updatedAt: string | null;
  updatedBy: string | null;
}

function toEnginePrompt(row: Row): EnginePrompt {
  return {
    promptId: String(row.prompt_id ?? ""),
    version: String(row.version ?? ""),
    skillRef: String(row.skill_ref ?? ""),
    content: typeof row.content === "string" ? row.content : "",
    updatedAt: typeof row.updated_at === "string" ? row.updated_at : null,
    updatedBy: typeof row.updated_by === "string" ? row.updated_by : null,
  };
}

/** Splits a stage's `skillRef` into the two path segments the API takes. */
export function splitSkillRef(skillRef: string): { promptId: string; version: string } | null {
  const at = skillRef.lastIndexOf("@");
  if (at <= 0 || at === skillRef.length - 1) return null;
  return { promptId: skillRef.slice(0, at), version: skillRef.slice(at + 1) };
}

/** The exact text this stage will load on its next run. */
export async function getEnginePrompt(skillRef: string): Promise<EnginePrompt> {
  const parts = splitSkillRef(skillRef);
  if (!parts) throw new Error(`"${skillRef}" is not a promptId@version reference.`);
  return toEnginePrompt(
    obj(await middlewareFetch(`/engine-prompts/${ref(parts.promptId)}/versions/${ref(parts.version)}`)),
  );
}

/** Replaces that text, so the next run uses it. */
export async function putEnginePrompt(skillRef: string, content: string, actor?: string): Promise<EnginePrompt> {
  const parts = splitSkillRef(skillRef);
  if (!parts) throw new Error(`"${skillRef}" is not a promptId@version reference.`);
  const query = actor ? `?actor=${encodeURIComponent(actor)}` : "";
  return toEnginePrompt(
    obj(
      await middlewareFetch(`/engine-prompts/${ref(parts.promptId)}/versions/${ref(parts.version)}${query}`, {
        method: "PUT",
        body: { content },
      }),
    ),
  );
}
