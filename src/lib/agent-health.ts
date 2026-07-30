import type { JobStatus } from "@/lib/types";

/**
 * Real, derived-only health states for the Control Room — no fabricated
 * "degrading" percentage or invented timer-based state. Each value maps to a
 * concrete signal already on the job/schedule rows this page fetches.
 */
export type AgentHealth = "healthy" | "retrying" | "errored" | "paused";

export interface AgentHealthInput {
  /** This agent's runs, any order (sorted internally by createdAt desc). */
  runs: Array<{ status: JobStatus; createdAt: number }>;
  /** This agent's PlannedScheduledRun status, if it has one. */
  scheduleStatus?: "active" | "paused" | "completed" | null;
  /**
   * A scheduled fire that was refused before a job even existed (credit cap,
   * missing intake, service unreachable) — PlannedScheduledRun.lastError. A
   * real operational problem distinct from "the last run that fired failed".
   */
  scheduleLastError?: string | null;
}

/**
 * Derives one of the four states above, in this precedence:
 *
 * 1. `paused` — a human explicitly stopped the schedule; that overrides
 *    whatever came before it, the same way pausing anything suppresses its
 *    prior alarms.
 * 2. `retrying` — a run is currently queued/running AND the run immediately
 *    before it failed. This is the one state that needs BOTH the latest and
 *    previous run to derive — a plain "running" doesn't tell you it's a retry.
 * 3. `errored` — the most recent completed run failed, OR the schedule itself
 *    couldn't even fire last time (`scheduleLastError`).
 * 4. `healthy` — none of the above, including the "no runs yet, nothing
 *    scheduled has failed" case.
 */
export function deriveAgentHealth(input: AgentHealthInput): AgentHealth {
  if (input.scheduleStatus === "paused") return "paused";

  const sorted = [...input.runs].sort((a, b) => b.createdAt - a.createdAt);
  const [latest, previous] = sorted;
  const inFlight = latest?.status === "queued" || latest?.status === "running";

  if (inFlight && previous?.status === "failed") return "retrying";
  if (latest?.status === "failed") return "errored";
  if (input.scheduleLastError) return "errored";
  return "healthy";
}

export const AGENT_HEALTH_LABEL: Record<AgentHealth, string> = {
  healthy: "Healthy",
  retrying: "Degrading — retrying",
  errored: "Errored",
  paused: "Paused",
};
