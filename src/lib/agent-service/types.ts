/**
 * Wire types for the external agent service (agent-service/).
 * Deliberately duplicated (thin) rather than imported — the platform never
 * imports agent-service code; the HTTP API + webhook are the only contract.
 */
import type { ManagedTaskType } from "@/lib/types";

export interface AgentServiceContextFile {
  name: string;
  url: string;
  description?: string;
  content_type?: string;
}

export interface AgentServiceJobRequest {
  task_type: ManagedTaskType;
  client_id: string;
  client_slug?: string;
  brief: Record<string, unknown>;
  callback_url: string;
  agent_version?: string;
  context_files?: AgentServiceContextFile[];
  /** Echoed back in the webhook — carries the platform job id. */
  metadata?: Record<string, string>;
}

export type AgentServiceJobStatus =
  | "queued"
  | "running"
  | "done"
  | "failed"
  | "cancelled"
  | "dead_letter";

export interface AgentServiceUsage {
  totalCostUsd?: number;
  numTurns?: number;
  models: Record<
    string,
    {
      inputTokens: number;
      outputTokens: number;
      cacheReadInputTokens: number;
      cacheCreationInputTokens: number;
      costUsd?: number;
    }
  >;
}

export interface AgentServiceArtifact {
  name: string;
  path: string;
  bytes: number;
  sha256: string;
  content_type?: string;
  client_facing: boolean;
  url: string;
}

export interface AgentServiceJobView {
  id: string;
  status: AgentServiceJobStatus;
  attempt: number;
  artifacts: AgentServiceArtifact[];
  usage?: AgentServiceUsage;
  agentsRepoSha?: string;
  model?: string;
  error?: string;
  transcriptUrl?: string;
}

export interface AgentServiceWebhookPayload {
  event: "job.completed";
  job_id: string;
  status: Extract<AgentServiceJobStatus, "done" | "failed" | "cancelled" | "dead_letter">;
  task_type: ManagedTaskType;
  client_id: string;
  metadata?: Record<string, string>;
  artifacts: AgentServiceArtifact[];
  usage?: AgentServiceUsage;
  agents_repo_sha?: string;
  model?: string;
  error?: string;
  transcript_url?: string;
  attempt: number;
}
