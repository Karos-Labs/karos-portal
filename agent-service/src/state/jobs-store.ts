import type { Redis } from "ioredis";
import type { ArtifactEntry, JobRecord, JobStatus } from "../types.js";
import { isTerminal, transition, type JobEvent } from "./machine.js";

const CANCEL_CHANNEL = "agent-jobs:cancel";

/**
 * Atomic compare-and-set on the record's `v` field. A Lua script (single
 * round trip) instead of WATCH/MULTI because the connection is shared with
 * other concurrent callers — WATCH state on a shared connection is broken.
 */
const CAS_SCRIPT = `
local cur = redis.call('GET', KEYS[1])
if not cur then return -1 end
local decoded = cjson.decode(cur)
local curv = decoded['v'] or 0
if curv ~= tonumber(ARGV[1]) then return 0 end
if ARGV[3] == '1' then
  redis.call('SET', KEYS[1], ARGV[2], 'EX', tonumber(ARGV[4]))
else
  redis.call('SET', KEYS[1], ARGV[2])
end
return 1
`;

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
    for (let i = 0; i < 10; i++) {
      const raw = await this.redis.get(this.key(id));
      if (!raw) throw new JobNotFound(id);
      const current = JSON.parse(raw) as JobRecord;
      const next = { ...mutate(current), v: (current.v ?? 0) + 1 };
      const terminal = isTerminal(next.status);
      const result = (await this.redis.eval(
        CAS_SCRIPT,
        1,
        this.key(id),
        String(current.v ?? 0),
        JSON.stringify(next),
        terminal ? "1" : "0",
        String(this.ttlSeconds),
      )) as number;
      if (result === 1) return next;
      if (result === -1) throw new JobNotFound(id);
      // result === 0: lost the race — re-read and retry
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
