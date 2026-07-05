import { Worker, type Queue } from "bullmq";
import { URL } from "node:url";
import type { ServiceConfig } from "../config.js";
import type { ArtifactStore } from "../storage/artifact-store.js";
import { JobsStore } from "../state/jobs-store.js";
import { isTerminal } from "../state/machine.js";
import type { JobEvent } from "../state/machine.js";
import { getTaskTypeConfig } from "../task-types.js";
import type { JobRecord, JobSpec, WebhookPayload } from "../types.js";
import { DockerExecutor } from "../exec/docker-executor.js";
import { CloudRunJobExecutor } from "../exec/cloudrun-executor.js";
import type { ExecutionHandle, JobExecutor } from "../exec/executor.js";
import { deliverWebhook } from "../webhooks/deliver.js";
import { makeRedis } from "./connection.js";
import { enqueueJob, QUEUE_NAME, type QueuePayload } from "./queue.js";

export interface WorkerDeps {
  config: ServiceConfig;
  store: JobsStore;
  artifactStore: ArtifactStore;
  queue: Queue<QueuePayload>;
}

export function buildJobSpec(config: ServiceConfig, record: JobRecord): JobSpec {
  const taskConfig = getTaskTypeConfig(record.request.task_type);
  const spec: JobSpec = {
    jobId: record.id,
    taskType: record.request.task_type,
    clientId: record.request.client_id,
    brief: record.request.brief,
    contextFiles: record.request.context_files ?? [],
    timeoutMs: taskConfig.timeoutMs || config.defaultTimeoutMs,
    callbackBaseUrl: config.internalBaseUrl,
    runnerToken: record.runnerToken,
  };
  if (record.request.client_slug) spec.clientSlug = record.request.client_slug;
  if (record.request.agent_version) spec.agentVersion = record.request.agent_version;
  return spec;
}

export function buildRunnerEnv(config: ServiceConfig): Record<string, string> {
  const env: Record<string, string> = {};
  if (config.anthropicApiKey) env.ANTHROPIC_API_KEY = config.anthropicApiKey;
  if (config.jobHttpProxy) {
    env.HTTP_PROXY = config.jobHttpProxy;
    env.HTTPS_PROXY = config.jobHttpProxy;
    env.http_proxy = config.jobHttpProxy;
    env.https_proxy = config.jobHttpProxy;
    env.NO_PROXY = new URL(config.internalBaseUrl).hostname;
    env.no_proxy = env.NO_PROXY;
  }
  return env;
}

export function buildWebhookPayload(record: JobRecord): WebhookPayload {
  const payload: WebhookPayload = {
    event: "job.completed",
    job_id: record.id,
    status: record.status as WebhookPayload["status"],
    task_type: record.request.task_type,
    client_id: record.request.client_id,
    artifacts: record.artifacts.map((a) => {
      const entry: WebhookPayload["artifacts"][number] = {
        name: a.name,
        path: a.path,
        bytes: a.bytes,
        sha256: a.sha256,
        client_facing: a.clientFacing,
        url: a.url ?? "",
      };
      if (a.contentType) entry.content_type = a.contentType;
      return entry;
    }),
    attempt: record.attempt,
  };
  if (record.request.metadata) payload.metadata = record.request.metadata;
  if (record.usage) payload.usage = record.usage;
  if (record.agentsRepoSha) payload.agents_repo_sha = record.agentsRepoSha;
  if (record.model) payload.model = record.model;
  if (record.error) payload.error = record.error;
  if (record.transcriptUrl) payload.transcript_url = record.transcriptUrl;
  return payload;
}

/** Decide the state-machine event once the job container has exited. */
export function resolveExitEvent(record: JobRecord, timedOut: boolean): JobEvent {
  if (timedOut && !record.runnerReport) return { type: "timeout" };
  const report = record.runnerReport;
  if (!report) return { type: "fail", transient: true };
  if (report.outcome === "done") return { type: "complete" };
  if (report.outcome === "cancelled" || record.cancelRequested) return { type: "cancel" };
  return { type: "fail", transient: report.transient ?? false };
}

export function startWorker(deps: WorkerDeps): Worker<QueuePayload> {
  const { config, store, artifactStore, queue } = deps;
  const executor: JobExecutor =
    config.executor === "cloudrun" ? new CloudRunJobExecutor(config) : new DockerExecutor(config);
  const running = new Map<string, ExecutionHandle>();

  const cancelSubscriber = makeRedis(config.redisUrl);
  store.subscribeCancel(cancelSubscriber, (jobId) => {
    const handle = running.get(jobId);
    if (handle) void handle.kill();
  });

  const worker = new Worker<QueuePayload>(
    QUEUE_NAME,
    async (bullJob) => {
      const jobId = bullJob.data.jobId;
      let record = await store.get(jobId);
      if (!record || record.status !== "queued") return;
      if (record.cancelRequested) {
        record = await store.applyEvent(jobId, { type: "cancel" });
        await finalize(record);
        return;
      }

      record = await store.applyEvent(jobId, { type: "start" });
      const spec = buildJobSpec(config, record);
      const env = buildRunnerEnv(config);

      let timedOut = false;
      let handle: ExecutionHandle;
      try {
        handle = await executor.start(spec, env);
      } catch (err) {
        const failed = await store.applyEvent(
          jobId,
          { type: "fail", transient: true },
          { error: `executor start failed: ${err instanceof Error ? err.message : String(err)}` },
        );
        await afterExit(failed);
        return;
      }
      running.set(jobId, handle);
      const timer = setTimeout(() => {
        timedOut = true;
        void handle.kill();
      }, spec.timeoutMs);
      try {
        await handle.wait;
      } finally {
        clearTimeout(timer);
        running.delete(jobId);
      }

      const exited = await store.getOrThrow(jobId);
      const event = resolveExitEvent(exited, timedOut);
      const patch: Partial<JobRecord> = {};
      if (event.type === "timeout") patch.error = `timed out after ${spec.timeoutMs}ms`;
      if (event.type === "fail" && exited.runnerReport?.error) patch.error = exited.runnerReport.error;
      if (event.type === "fail" && !exited.runnerReport) patch.error = "job container exited without reporting";
      const updated = await store.applyEvent(jobId, event, patch);
      await afterExit(updated);
    },
    { connection: makeRedis(config.redisUrl), concurrency: config.workerConcurrency },
  );

  async function afterExit(record: JobRecord): Promise<void> {
    if (record.status === "queued") {
      await enqueueJob(queue, record);
      return;
    }
    if (record.status === "dead_letter") {
      await store.update(record.id, (r) => ({
        ...r,
        deadLetterReason: r.error ?? "retries exhausted",
      }));
    }
    if (isTerminal(record.status)) await finalize(await store.getOrThrow(record.id));
  }

  async function finalize(record: JobRecord): Promise<void> {
    let current = record;
    const transcriptUrl = await artifactStore.finalizeTranscript(current.id);
    if (transcriptUrl) {
      current = await store.update(current.id, (r) => ({ ...r, transcriptUrl }));
    }
    const delivered = await deliverWebhook(
      config.webhookSecret,
      current.request.callback_url,
      buildWebhookPayload(current),
    );
    await store.update(current.id, (r) => ({ ...r, webhookDelivered: delivered }));
  }

  worker.on("failed", (bullJob, err) => {
    console.error(`worker error for ${bullJob?.data.jobId}:`, err);
  });
  return worker;
}
