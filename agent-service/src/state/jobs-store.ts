import type { Redis } from "ioredis";
import type { ArtifactEntry, JobRecord, JobStatus } from "../types.js";
import { isTerminal, transition, type JobEvent } from "./machine.js";

const CANCEL_CHANNEL = "agent-jobs:cancel";

export class JobNotFound extends Error {
  constructor(id: string) {
    super(`Job not found: ${id}`);
    this.name = "JobNotFound";
  }
}

export class JobsStore {
  constructor(
    private readonly redis: Redis,
    private readonly ttlSeconds: number,
  ) {}

  private key(id: string): string {
    return `job:${id}`;
  }

  async create(record: JobRecord): Promise<void> {
    await this.redis.set(this.key(record.id), JSON.stringify(record));
  }

  async get(id: string): Promise<JobRecord | null> {
    const raw = await this.redis.get(this.key(id));
    return raw ? (JSON.parse(raw) as JobRecord) : null;
  }

  async getOrThrow(id: string): Promise<JobRecord> {
    const record = await this.get(id);
    if (!record) throw new JobNotFound(id);
    return record;
  }

  /**
   * Optimistic read-modify-write; retries on concurrent writers. `mutate`
   * must be pure — it may be called several times.
   */
  async update(id: string, mutate: (record: JobRecord) => JobRecord): Promise<JobRecord> {
    for (let i = 0; i < 5; i++) {
      await this.redis.watch(this.key(id));
      const raw = await this.redis.get(this.key(id));
      if (!raw) {
        await this.redis.unwatch();
        throw new JobNotFound(id);
      }
      const next = mutate(JSON.parse(raw) as JobRecord);
      const multi = this.redis.multi();
      if (isTerminal(next.status)) {
        multi.set(this.key(id), JSON.stringify(next), "EX", this.ttlSeconds);
      } else {
        multi.set(this.key(id), JSON.stringify(next));
      }
      const result = await multi.exec();
      if (result !== null) return next;
    }
    throw new Error(`Concurrent update conflict for job ${id}`);
  }

  /** Applies a state-machine event; returns the updated record. */
  async applyEvent(id: string, event: JobEvent, patch?: Partial<JobRecord>): Promise<JobRecord> {
    return this.update(id, (record) => {
      const status: JobStatus = transition(record.status, event, {
        attempt: record.attempt,
        maxAttempts: record.maxAttempts,
      });
      const next: JobRecord = { ...record, ...patch, status };
      if (status === "running" && record.status === "queued") next.startedAt = Date.now();
      if (isTerminal(status)) next.finishedAt = Date.now();
      if (status === "queued" && (event.type === "fail" || event.type === "timeout")) {
        next.attempt = record.attempt + 1;
        delete next.startedAt;
      }
      return next;
    });
  }

  async appendArtifact(id: string, artifact: ArtifactEntry): Promise<JobRecord> {
    return this.update(id, (record) => ({ ...record, artifacts: [...record.artifacts, artifact] }));
  }

  async requestCancel(id: string): Promise<JobRecord> {
    const record = await this.update(id, (r) => ({ ...r, cancelRequested: true }));
    await this.redis.publish(CANCEL_CHANNEL, id);
    return record;
  }

  subscribeCancel(subscriber: Redis, handler: (jobId: string) => void): void {
    void subscriber.subscribe(CANCEL_CHANNEL);
    subscriber.on("message", (channel, message) => {
      if (channel === CANCEL_CHANNEL) handler(message);
    });
  }
}

export function publicView(record: JobRecord): Omit<JobRecord, "runnerToken"> {
  const { runnerToken: _runnerToken, ...rest } = record;
  return rest;
}
