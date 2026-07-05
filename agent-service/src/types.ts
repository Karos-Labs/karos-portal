export const TASK_TYPES = ["social_post", "newsletter_issue", "blog_article", "landing_page"] as const;
export type TaskType = (typeof TASK_TYPES)[number];

export type JobStatus = "queued" | "running" | "done" | "failed" | "cancelled" | "dead_letter";

export interface ContextFileRef {
  name: string;
  url: string;
  description?: string;
  content_type?: string;
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
}

export interface WebhookPayload {
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
}

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
}
