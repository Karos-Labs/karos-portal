import type { JobStatus } from "../types.js";

export type JobEvent =
  | { type: "start" }
  | { type: "complete" }
  | { type: "fail"; transient: boolean }
  | { type: "cancel" }
  | { type: "timeout" };

export class InvalidTransition extends Error {
  constructor(status: JobStatus, event: JobEvent["type"]) {
    super(`Invalid transition: ${event} while ${status}`);
    this.name = "InvalidTransition";
  }
}

export const TERMINAL_STATUSES: ReadonlySet<JobStatus> = new Set(["done", "failed", "cancelled", "dead_letter"]);

export function isTerminal(status: JobStatus): boolean {
  return TERMINAL_STATUSES.has(status);
}

/**
 * Pure job state machine. Timeouts and transient failures requeue while
 * attempts remain; exhausted retries land in dead_letter (transcript kept);
 * deterministic failures go straight to failed.
 */
export function transition(
  status: JobStatus,
  event: JobEvent,
  ctx: { attempt: number; maxAttempts: number },
): JobStatus {
  switch (event.type) {
    case "start":
      if (status !== "queued") throw new InvalidTransition(status, event.type);
      return "running";
    case "complete":
      if (status !== "running") throw new InvalidTransition(status, event.type);
      return "done";
    case "cancel":
      if (status === "queued" || status === "running") return "cancelled";
      throw new InvalidTransition(status, event.type);
    case "timeout":
    case "fail": {
      if (status !== "running" && status !== "queued") throw new InvalidTransition(status, event.type);
      const transient = event.type === "timeout" ? true : event.transient;
      if (!transient) return "failed";
      return ctx.attempt < ctx.maxAttempts ? "queued" : "dead_letter";
    }
  }
}
