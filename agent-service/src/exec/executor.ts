import type { JobSpec } from "../types.js";

export interface ExecutionHandle {
  /** resolves when the job container has exited, however it exited */
  wait: Promise<void>;
  /** graceful stop (SIGTERM + grace) escalating to hard kill */
  kill(): Promise<void>;
}

export interface JobExecutor {
  start(spec: JobSpec, env: Record<string, string>): Promise<ExecutionHandle>;
}

export function encodeJobSpec(spec: JobSpec): string {
  return Buffer.from(JSON.stringify(spec), "utf8").toString("base64");
}

export function decodeJobSpec(encoded: string): JobSpec {
  return JSON.parse(Buffer.from(encoded, "base64").toString("utf8")) as JobSpec;
}

/**
 * Cloud Run caps env var overrides at ~32 KiB total for the whole container
 * (see server.ts's MAX_JOB_SPEC_TOTAL_BYTES comment) — a spec under this
 * budget travels inline as JOB_SPEC_B64 today, no extra network round trip.
 * 30 KiB leaves headroom for the worker's other env (proxy vars, API keys).
 */
export const INLINE_SPEC_MAX_BYTES = 30 * 1024;

/** The small pointer sent instead of the full spec when it's over INLINE_SPEC_MAX_BYTES. */
export interface JobSpecRef {
  jobId: string;
  callbackBaseUrl: string;
  runnerToken: string;
}

export function encodeJobSpecRef(ref: JobSpecRef): string {
  return Buffer.from(JSON.stringify(ref), "utf8").toString("base64");
}

export function decodeJobSpecRef(encoded: string): JobSpecRef {
  return JSON.parse(Buffer.from(encoded, "base64").toString("utf8")) as JobSpecRef;
}

/**
 * Picks how the JobSpec reaches the runner container. Most jobs fit inline
 * (JOB_SPEC_B64, unchanged). A spec whose encoded size would blow Cloud Run's
 * env-var budget — e.g. a hand-authored custom agent like the X agent, whose
 * per-step prompts run near the schema's own 20,000-char ceiling — instead
 * gets a small JOB_SPEC_REF_B64 (jobId + callback URL + runner token only),
 * and the runner fetches the full spec from GET /internal/jobs/:id/spec on
 * startup: the same authenticated channel it already uses for
 * transcript/artifact/complete calls, just also for HOW to run instead of
 * NOTIFY. This is why createJobRecord no longer rejects large specs at
 * submit time (see server.ts) — only this transport choice changes.
 */
export function buildSpecEnv(spec: JobSpec): Record<string, string> {
  const inline = encodeJobSpec(spec);
  if (Buffer.byteLength(inline, "utf8") <= INLINE_SPEC_MAX_BYTES) {
    return { JOB_SPEC_B64: inline };
  }
  return {
    JOB_SPEC_REF_B64: encodeJobSpecRef({
      jobId: spec.jobId,
      callbackBaseUrl: spec.callbackBaseUrl,
      runnerToken: spec.runnerToken,
    }),
  };
}
