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
import { finalizeJob } from "../lifecycle/finalize.js";
import { makeRedis } from "./connection.js";
import { enqueueJob, QUEUE_NAME, type QueuePayload } from "./queue.js";
import type { WebhooksQueue } from "./webhooks.js";

export interface WorkerDeps {
  config: ServiceConfig;
  store: JobsStore;
  artifactStore: ArtifactStore;
  queue: Queue<QueuePayload>;
  webhooksQueue: WebhooksQueue;
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
  const mcpUrl = record.request.metadata?.karos_mcp_url;
  const mcpToken = record.request.metadata?.karos_job_token;
  if (mcpUrl && mcpToken) {
    try {
      // The MCP endpoint must belong to the same platform that receives the
      // completion webhook. This prevents metadata from becoming an arbitrary
      // proxy-bypass/credential-forwarding destination.
      if (new URL(mcpUrl).origin === new URL(record.request.callback_url).origin) {
        spec.karosMcp = { url: mcpUrl, token: mcpToken };
      }
    } catch {
      // Request metadata is opaque by contract. Ignore malformed MCP hints.
    }
  }
  return spec;
}

export function buildRunnerEnv(config: ServiceConfig, spec?: JobSpec): Record<string, string> {
  const env: Record<string, string> = {};
  if (config.anthropicApiKey) env.ANTHROPIC_API_KEY = config.anthropicApiKey;
  // Live X reads (api.x.ai is already on the research egress group); absent =
  // the X agent's reactive lanes degrade to WebSearch, everything else unaffected.
  if (config.xaiApiKey) env.XAI_API_KEY = config.xaiApiKey;
  if (config.apifyToken) env.APIFY_TOKEN = config.apifyToken;
  // Reddit agent discovery: the account-scoped RSS pair lifts the keyless
  // rate limit the daily cadence otherwise trips. Read by NAME by the lab's
  // stdlib Python engine (config_loader.OPTIONAL_ENV); values never logged.
  if (config.redditRssUser) env.REDDIT_RSS_USER = config.redditRssUser;
  if (config.redditRssFeedToken) env.REDDIT_RSS_FEED_TOKEN = config.redditRssFeedToken;
  if (config.redditAccount) env.REDDIT_ACCOUNT = config.redditAccount;
  // On Cloud Run the api enforces IAM, so the runner must present an ID token
  // (audience = the api URL it calls back to) alongside its per-job token.
  if (config.executor === "cloudrun") env.RUNNER_IAM_AUDIENCE = config.internalBaseUrl;
  if (config.jobHttpProxy) {
    env.HTTP_PROXY = config.jobHttpProxy;
    env.HTTPS_PROXY = config.jobHttpProxy;
    env.http_proxy = config.jobHttpProxy;
    env.https_proxy = config.jobHttpProxy;
    // Bypass the egress proxy for the api callbacks AND the GCE metadata server
    // (the IAM ID-token source) — the proxy allow-list denies both, so routing
    // them through it would break every runner→api callback with a 403.
    env.NO_PROXY = [
      new URL(config.internalBaseUrl).hostname,
      ...(spec?.karosMcp ? [new URL(spec.karosMcp.url).hostname] : []),
      "metadata.google.internal",
      "169.254.169.254",
    ].filter((host, index, all) => all.indexOf(host) === index).join(",");
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
  const { config, store, queue } = deps;
  const executor: JobExecutor =
    config.executor === "cloudrun" ? new CloudRunJobExecutor(config) : new DockerExecutor(config);
  const running = new Map<string, ExecutionHandle>();

  const cancelSubscriber = makeRedis(config.redisUrl);
  store.subscribeCancel(cancelSubscriber, (jobId) => {
    const handle = running.get(jobId);
    if (handle) void handle.kill();
  });

  async function runJob(jobId: string): Promise<void> {
    let record = await store.get(jobId);
    if (!record) return;

    if (record.status === "running" && !running.has(jobId)) {
      // Stalled redelivery: a previous worker died mid-run. Resolve from the
      // runner's report if it arrived, otherwise fail transient (retry).
      const event = resolveExitEvent(record, false);
      const patch: Partial<JobRecord> = {};
      if (!record.runnerReport) patch.error = "worker lost the job mid-run (stalled)";
      const updated = await store.applyEvent(jobId, event, patch);
      await afterExit(updated);
      return;
    }
    if (record.status !== "queued") return;
    if (record.cancelRequested) {
      const cancelled = await store.applyEvent(jobId, { type: "cancel" });
      await afterExit(cancelled);
      return;
    }

    record = await store.applyEvent(jobId, { type: "start" });
    const spec = buildJobSpec(config, record);
    const env = buildRunnerEnv(config, spec);

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

    // Close the cancel race: a cancel published before running.set had no
    // handle to kill — re-check the flag now that the handle exists.
    const freshRecord = await store.get(jobId);
    if (freshRecord?.cancelRequested) void handle.kill();

    const timer = setTimeout(() => {
      timedOut = true;
      void handle.kill();
    }, spec.timeoutMs);
    try {
      // A rejected wait (Cloud Run operation failure, docker crash) is an
      // exit like any other — never let it strand the job in "running".
      await handle.wait.catch(() => undefined);
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
  }

  const worker = new Worker<QueuePayload>(
    QUEUE_NAME,
    async (bullJob) => {
      try {
        await runJob(bullJob.data.jobId);
      } catch (err) {
        // Last-resort containment: never leave a record stranded in
        // "running" because of an unexpected processor error.
        console.error(`worker processor error for ${bullJob.data.jobId}:`, err);
        try {
          const record = await store.get(bullJob.data.jobId);
          if (record && !isTerminal(record.status)) {
            const failed = await store.applyEvent(
              bullJob.data.jobId,
              { type: "fail", transient: true },
              { error: `worker error: ${err instanceof Error ? err.message : String(err)}` },
            );
            await afterExit(failed);
          }
        } catch (inner) {
          console.error(`worker recovery failed for ${bullJob.data.jobId}:`, inner);
        }
      }
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
    if (isTerminal(record.status)) {
      await finalizeJob(deps, await store.getOrThrow(record.id));
    }
  }

  worker.on("failed", (bullJob, err) => {
    console.error(`worker error for ${bullJob?.data.jobId}:`, err);
  });
  return worker;
}
