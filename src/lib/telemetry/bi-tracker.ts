/**
 * Karos CMO — BigQuery BI event tracker.
 *
 * Design contract, mirroring src/services/logger.ts:
 *   • Every track*() call returns void immediately — never awaited by callers.
 *   • Streaming inserts are fire-and-forget; failures are swallowed here and
 *     surfaced through logStructured (not logger.logError — logger.ts itself
 *     calls into this module, and looping back through it would be circular)
 *     so they're still visible in Cloud Logging instead of vanishing.
 *   • With GOOGLE_CLOUD_PROJECT unset (local dev), biTable() returns null and
 *     every track*() call becomes a no-op — no local BigQuery/ADC required.
 */
import "server-only";

import { biTable } from "@/lib/telemetry/bigquery-client";
import { logStructured } from "@/lib/telemetry/structured-log";

interface UserActionEvent {
  clientId: string | null;
  userId: string;
  eventName: string;
  surface: string;
  targetId?: string | null;
  metadata?: Record<string, unknown>;
}

/** logins, task/asset approvals, UI clicks — anything worth a BI row that isn't an AI run or a credit change. */
export function trackUserAction(event: UserActionEvent): void {
  void insertRow("user_actions_bi", "trackUserAction", {
    timestamp: bqTimestamp(Date.now()),
    clientId: event.clientId,
    userId: event.userId,
    eventName: event.eventName,
    surface: event.surface,
    targetId: event.targetId ?? null,
    metadataJson: event.metadata ? JSON.stringify(event.metadata) : null,
  });
}

interface CreditUsageEvent {
  clientId: string;
  amount: number;
  balanceAfter: number;
  reason: string;
  source: string;
}

/** Every creditLedger write (charge, grant, refund, adjustment) — call right after the Firestore transaction resolves. */
export function trackCreditUsage(event: CreditUsageEvent): void {
  void insertRow("credit_usage_bi", "trackCreditUsage", {
    timestamp: bqTimestamp(Date.now()),
    clientId: event.clientId,
    amount: event.amount,
    balanceAfter: event.balanceAfter,
    reason: event.reason,
    source: event.source,
  });
}

interface AgentRunEvent {
  runId: string;
  clientId: string | null;
  agentId: string | null;
  model: string;
  inputTokens: number;
  outputTokens: number;
  costUsd: number;
  durationMs: number | null;
  status: string;
  errorDetails?: string | null;
  timestamp: number;
  /**
   * The feature/surface that spent this — logger.ts's `UsageLog.operation`
   * (e.g. "ai_insights_summary", "managed_job_step", "dynamic_agent_draft").
   * Discriminator (2026-08): without it, a run-level row and the per-step
   * rows for the SAME dynamic run are indistinguishable in `agent_runs_bi`,
   * so `SUM(costUsd)` double-counts every dynamic run's tokens. Column is
   * additive/nullable — see bootstrap-bi-telemetry-gcp.sh — so this ships
   * safely whether or not that migration has run yet against a given table.
   */
  operation?: string | null;
  /** Dynamic Agent Studio only — pairs with stepId to isolate one run's step rows from its own run-level row. */
  jobId?: string | null;
  stepId?: string | null;
}

/** One row per logger.logUsage() call — wired from src/services/logger.ts's _writeUsage. */
export function trackAgentRun(event: AgentRunEvent): void {
  void insertRow("agent_runs_bi", "trackAgentRun", {
    runId: event.runId,
    clientId: event.clientId,
    agentId: event.agentId,
    model: event.model,
    inputTokens: event.inputTokens,
    outputTokens: event.outputTokens,
    costUsd: event.costUsd,
    durationMs: event.durationMs,
    status: event.status,
    errorDetails: sanitizeErrorDetail(event.errorDetails),
    timestamp: bqTimestamp(event.timestamp),
    operation: event.operation ?? null,
    jobId: event.jobId ?? null,
    stepId: event.stepId ?? null,
    // Every row this repo writes is a portal-originated row — the engine's
    // own agent-runs_bi inserts (packages/telemetry/src/span-helpers.ts)
    // stamp "agent-engine" themselves.
    source: "portal",
  });
}

const MAX_ERROR_DETAIL_LENGTH = 300;

/**
 * Provider/upstream error text can echo prompt fragments verbatim, and a raw
 * `.stack` is multi-line with local file paths — neither belongs in a BI
 * table. Keep only the first line (error name + message, no stack frames)
 * and cap its length.
 */
function sanitizeErrorDetail(detail: string | null | undefined): string | null {
  if (!detail) return null;
  const firstLine = detail.split("\n")[0];
  return firstLine.length > MAX_ERROR_DETAIL_LENGTH
    ? `${firstLine.slice(0, MAX_ERROR_DETAIL_LENGTH)}…`
    : firstLine;
}

/** BigQuery TIMESTAMP columns want ISO 8601, not epoch millis. */
function bqTimestamp(epochMs: number): string {
  return new Date(epochMs).toISOString();
}

async function insertRow(tableId: string, operation: string, row: Record<string, unknown>): Promise<void> {
  try {
    const table = biTable(tableId);
    if (!table) return; // telemetry not configured — silent no-op, matches Logger's contract
    await table.insert([row], { ignoreUnknownValues: true, skipInvalidRows: false });
  } catch (err) {
    logStructured("WARNING", err instanceof Error ? err.message : String(err), {
      clientId: (row.clientId as string | null | undefined) ?? null,
      operation: `bi_tracker.${operation}`,
    });
  }
}
