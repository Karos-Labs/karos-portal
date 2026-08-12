// "newsletter_issue" was removed 2026-08-06: the newsletter is now a custom
// agent (karos-newsletter-writer-v2) and runs through the generic "custom"
// runner. The platform mirror of this tuple is MANAGED_PRODUCTS + the
// ManagedTaskType union, and agent-registry-sync.test.ts fails CI if the two
// ever disagree.
// "blog_article" was removed 2026-08-06 alongside "newsletter_issue": the blog
// is now a custom agent (karos-blog-writer-v2) and runs through the generic
// "custom" runner.
export const TASK_TYPES = ["social_post", "landing_page", "custom"] as const;
export type TaskType = (typeof TASK_TYPES)[number];

export type JobStatus = "queued" | "running" | "done" | "failed" | "cancelled" | "dead_letter";

export interface ContextFileRef {
  name: string;
  url: string;
  description?: string;
  content_type?: string;
  /**
   * Repo-relative destination under clients/<slug>/, e.g.
   * "internal/x-agent/takes.json". When present, the runner writes the file
   * there IN ADDITION to client_context/files/<name> — for a skill with a
   * fixed-path contract (reads a specific file at a specific location every
   * run, e.g. x-agent-v2's run-protocol) rather than a generic attached
   * reference document. Absent ⇒ old behavior, client_context/files/ only.
   */
  client_path?: string;
}

export interface JobRequest {
  task_type: TaskType;
  client_id: string;
  /** agents-repo client folder slug; when absent the runner scaffolds a minimal client folder */
  client_slug?: string;
  brief: Record<string, unknown>;
  callback_url: string;
  /** git ref of the agents repo to run; defaults to the ref baked into the runner image */
  agent_version?: string;
  context_files?: ContextFileRef[];
  /** opaque platform correlation data, echoed back in the webhook */
  metadata?: Record<string, string>;
}

export interface ModelTokenUsage {
  inputTokens: number;
  outputTokens: number;
  cacheReadInputTokens: number;
  cacheCreationInputTokens: number;
  costUsd?: number;
}

export interface JobUsage {
  /** SDK client-side estimate; raw token counts are authoritative */
  totalCostUsd?: number;
  numTurns?: number;
  models: Record<string, ModelTokenUsage>;
}

export interface ArtifactEntry {
  /** workspace-relative path the agent wrote */
  path: string;
  name: string;
  bytes: number;
  sha256: string;
  contentType?: string;
  clientFacing: boolean;
  url?: string;
}

export interface CheckpointFileEntry {
  /** repo-relative path under the output roots (see runner/src/artifacts.ts outputRoots) */
  path: string;
  url: string;
  bytes: number;
}

/**
 * Snapshot of a failed attempt's output-tree state, saved by the runner so a
 * retry can restore prior progress instead of re-running the whole skill
 * from scratch (see runner/src/checkpoint.ts). Wholly replaced on each save —
 * only the most recent attempt's state is worth restoring.
 */
export interface JobCheckpoint {
  attempt: number;
  files: CheckpointFileEntry[];
  bytes: number;
}

export interface JobRecord {
  id: string;
  /** optimistic-concurrency version, bumped by JobsStore.update */
  v?: number;
  status: JobStatus;
  request: JobRequest;
  attempt: number;
  maxAttempts: number;
  createdAt: number;
  startedAt?: number;
  finishedAt?: number;
  agentsRepoSha?: string;
  model?: string;
  usage?: JobUsage;
  artifacts: ArtifactEntry[];
  error?: string;
  deadLetterReason?: string;
  cancelRequested?: boolean;
  /** single-purpose token the runner uses on /internal endpoints for this job only */
  runnerToken: string;
  transcriptUrl?: string;
  webhookDelivered?: boolean;
  /** what the runner reported via /internal/jobs/:id/complete; the worker turns this into the final transition */
  runnerReport?: RunnerCompleteBody;
  /** total artifact bytes stored so far (cap enforcement) */
  artifactBytes?: number;
  /** most recent attempt's saved output-tree state; see JobCheckpoint */
  checkpoint?: JobCheckpoint;
  /** Dynamic Agent Studio runs only — live step-progress, updated by /internal/jobs/:id/step-progress as the runner reports each step. Cleared implicitly once the job reaches a terminal status. */
  currentStepId?: string;
  currentStepName?: string;
  completedStepIds?: string[];
}

export type RunnerOutcome = "done" | "failed" | "cancelled";

export interface RunnerCompleteBody {
  outcome: RunnerOutcome;
  error?: string;
  /** transient=true asks the service to retry if attempts remain */
  transient?: boolean;
  usage?: JobUsage;
  agentsRepoSha?: string;
  model?: string;
  /** Dynamic Agent Studio runs only — see DynamicRunReport. */
  dynamicRun?: DynamicRunReport;
}

/**
 * // DECISION: a failed step fails the job at that step, and
 * `failedStepId` / `failedStepIndex` / the partial context are PERSISTED
 * rather than only rendered into an error string. This is the structured
 * carrier: the runner fills it, the queue worker forwards it on the webhook as
 * `dynamic_run`, and the Portal stores it on the job so the step bar and the
 * "incomplete" banner can be rendered from data instead of parsed out of prose.
 */
export interface DynamicRunReport {
  specId: string;
  specVersion: number;
  steps: Array<{
    stepId: string;
    type: "ai" | "code";
    label: string;
    status: "done" | "failed";
    durationMs: number;
    model?: string;
    error?: string;
    /** This step's own token/cost usage (AI steps only) — the per-step breakdown behind the run-level `usage` total. */
    usage?: JobUsage;
  }>;
  failedStepId?: string;
  failedStepIndex?: number;
  /** True when earlier steps produced output the client can still be shown. */
  hasPartialOutput?: boolean;
}

export interface JobCompletedWebhookPayload {
  event: "job.completed";
  job_id: string;
  status: Extract<JobStatus, "done" | "failed" | "cancelled" | "dead_letter">;
  task_type: TaskType;
  client_id: string;
  metadata?: Record<string, string>;
  artifacts: Array<{
    name: string;
    path: string;
    bytes: number;
    sha256: string;
    content_type?: string;
    client_facing: boolean;
    url: string;
  }>;
  usage?: JobUsage;
  agents_repo_sha?: string;
  model?: string;
  error?: string;
  transcript_url?: string;
  attempt: number;
  /** Dynamic Agent Studio runs only — the structured per-step report. */
  dynamic_run?: DynamicRunReport;
}

/**
 * Best-effort, fire-and-forget live progress ping — Dynamic Agent Studio runs
 * only. Unlike JobCompletedWebhookPayload, a dropped or out-of-order delivery
 * of this event is harmless: the next ping, or the eventual job.completed,
 * resyncs the Portal. Never carries usage/credits/artifacts.
 */
export interface JobStepProgressWebhookPayload {
  event: "job.step_progress";
  job_id: string;
  status: "running";
  client_id: string;
  current_step_id?: string;
  current_step_name?: string;
  completed_step_ids: string[];
}

export type WebhookPayload = JobCompletedWebhookPayload | JobStepProgressWebhookPayload;

/** Everything the runner needs; serialized into the job container's environment. */
export interface JobSpec {
  jobId: string;
  taskType: TaskType;
  clientId: string;
  clientSlug?: string;
  brief: Record<string, unknown>;
  contextFiles: ContextFileRef[];
  agentVersion?: string;
  timeoutMs: number;
  callbackBaseUrl: string;
  runnerToken: string;
  /** 1 on the first run; >1 means a prior attempt failed transiently and this is a retry. */
  attempt: number;
  maxAttempts: number;
  /** Job-scoped Karos MCP connection. Present only when the platform supplied both values. */
  karosMcp?: {
    url: string;
    token: string;
  };
}
