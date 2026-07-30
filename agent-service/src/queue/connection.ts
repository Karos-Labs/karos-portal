import { Redis } from "ioredis";

/**
 * Every Redis connection this service opens (BullMQ's queue/worker
 * connections, the cancel pub/sub subscriber) goes through here.
 *
 * `keepAlive` matters more than it looks: GCP's VPC/NAT path between Cloud Run
 * and Memorystore silently drops a TCP connection that's sat idle too long —
 * a job dispatch is a burst of activity followed by a quiet gap, exactly the
 * pattern that trips this. Without a keepalive, the OS's own default (often
 * ~2h) is far longer than GCP's idle window, so the connection looks fine
 * until the next command hits it with a plain `ECONNRESET` (confirmed via
 * production logs, 2026-07-30 incident: "[ioredis] Unhandled error event:
 * Error: read ECONNRESET" with no other explanation). A short keepalive keeps
 * the connection demonstrably alive through that window instead.
 *
 * The error listener doesn't change ioredis's behavior (it already
 * auto-reconnects via its default `retryStrategy` regardless of whether
 * anything listens) — it just turns "Unhandled error event" into a
 * greppable, attributable log line, and guarantees a transient reset can
 * never surface as an actual unhandled-exception crash (Node's EventEmitter
 * contract: an 'error' event with zero listeners can throw).
 */
export function makeRedis(redisUrl: string): Redis {
  const client = new Redis(redisUrl, { maxRetriesPerRequest: null, keepAlive: 10_000 });
  client.on("error", (err) => {
    console.error("[redis] connection error (ioredis will auto-reconnect):", err.message);
  });
  return client;
}
