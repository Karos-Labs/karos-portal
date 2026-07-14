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
