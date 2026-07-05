import { Queue, Worker } from "bullmq";
import type { Redis } from "ioredis";
import type { ServiceConfig } from "../config.js";
import type { JobsStore } from "../state/jobs-store.js";
import { buildWebhookPayload } from "./worker.js";
import { deliverWebhook } from "../webhooks/deliver.js";
import { makeRedis } from "./connection.js";

export const WEBHOOKS_QUEUE_NAME = "agent-webhooks";

export interface WebhookQueuePayload {
  jobId: string;
}

export type WebhooksQueue = Queue<WebhookQueuePayload>;

/**
 * Durable webhook delivery: BullMQ retries with exponential backoff
 * (5s base, 10 attempts ≈ 42 minutes; the last attempts are ~20 min apart)
 * so a platform deploy or outage does not lose completion events.
 */
export function makeWebhooksQueue(connection: Redis): WebhooksQueue {
  return new Queue(WEBHOOKS_QUEUE_NAME, {
    connection,
    defaultJobOptions: {
      attempts: 10,
      backoff: { type: "exponential", delay: 5000 },
      removeOnComplete: 1000,
      removeOnFail: 5000,
    },
  }) as WebhooksQueue;
}

export async function enqueueWebhook(queue: WebhooksQueue, jobId: string): Promise<void> {
  await queue.add("deliver", { jobId });
}

export function startWebhookWorker(deps: {
  config: ServiceConfig;
  store: JobsStore;
}): Worker<WebhookQueuePayload> {
  const { config, store } = deps;
  const worker = new Worker<WebhookQueuePayload>(
    WEBHOOKS_QUEUE_NAME,
    async (bullJob) => {
      const record = await store.get(bullJob.data.jobId);
      if (!record || record.webhookDelivered) return;
      const result = await deliverWebhook(
        config.webhookSecret,
        record.request.callback_url,
        buildWebhookPayload(record),
      );
      if (result === "delivered") {
        await store.update(record.id, (r) => ({ ...r, webhookDelivered: true }));
        return;
      }
      if (result === "rejected") {
        console.error(`webhook for ${record.id} rejected by receiver (4xx) — giving up`);
        await store.update(record.id, (r) => ({ ...r, webhookDelivered: false }));
        return;
      }
      throw new Error(`webhook delivery unreachable for ${record.id} (attempt ${bullJob.attemptsMade + 1})`);
    },
    { connection: makeRedis(config.redisUrl), concurrency: 4 },
  );
  worker.on("failed", (bullJob, err) => {
    if (bullJob && bullJob.attemptsMade >= (bullJob.opts.attempts ?? 1)) {
      console.error(`webhook delivery exhausted for ${bullJob.data.jobId}:`, err.message);
    }
  });
  return worker;
}
