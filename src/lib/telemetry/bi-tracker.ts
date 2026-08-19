/**
 * Karos CMO — BigQuery BI event tracker.
 *
 * Design contract, mirroring src/services/logger.ts:
 *   • Every track*() call returns void immediately — never awaited by callers.
 *   • Streaming inserts are fire-and-forget; failures are swallowed here and
 *     surfaced through logger.logError so they're visible in errorLogs
 *     instead of vanishing twice over.
 *   • With GOOGLE_CLOUD_PROJECT unset (local dev), biTable() returns null and
 *     every track*() call becomes a no-op — no local BigQuery/ADC required.
 */
import "server-only";

import { biTable } from "@/lib/telemetry/bigquery-client";
import { logger } from "@/services/logger";

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
    errorDetails: event.errorDetails ?? null,
    timestamp: bqTimestamp(event.timestamp),
  });
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
    logger.logError({
      clientId: (row.clientId as string | null | undefined) ?? null,
      agentId: null,
      operation: `bi_tracker.${operation}`,
      errorMessage: err instanceof Error ? err.message : String(err),
      severity: "WARN",
    });
  }
}
