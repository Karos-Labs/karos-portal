import { Queue } from "bullmq";
import type { Redis } from "ioredis";
import type { JobRecord } from "../types.js";

export const QUEUE_NAME = "agent-jobs";

export interface QueuePayload {
  jobId: string;
}

export type JobsQueue = Queue<QueuePayload>;

export function makeQueue(connection: Redis): JobsQueue {
  return new Queue(QUEUE_NAME, {
    connection,
    defaultJobOptions: {
      attempts: 1,
      removeOnComplete: 1000,
      removeOnFail: 1000,
    },
  }) as JobsQueue;
}

export async function enqueueJob(queue: JobsQueue, record: JobRecord): Promise<void> {
  await queue.add("run", { jobId: record.id }, { jobId: `${record.id}:${record.attempt}` });
}

export async function removeQueuedJob(queue: JobsQueue, jobId: string): Promise<boolean> {
  const jobs = await queue.getJobs(["waiting", "delayed", "prioritized"]);
  const match = jobs.find((j) => j.data.jobId === jobId);
  if (!match) return false;
  try {
    await match.remove();
    return true;
  } catch {
    return false;
  }
}
