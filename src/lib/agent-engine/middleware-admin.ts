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
