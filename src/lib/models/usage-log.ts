/**
 * Usage and error log types, plus the Anthropic pricing matrix.
 * Kept separate from types.ts so this file can be imported in server-only
 * service modules without pulling in all domain types.
 */

/* ── Log records ─────────────────────────────────────────────────── */

export interface UsageLog {
  id: string;
  clientId: string | null;
  agentId: string | null;
  agentName: string;
  modelName: string;
  /** e.g. "agent_run" | "intel_report" | "branding_gen" | "competitor_analysis" */
  operation: string;
  inputTokens: number;
  outputTokens: number;
  estimatedCostUsd: number;
  jobId?: string | null;
  durationMs?: number;
  timestamp: number;
}

export interface ErrorLog {
  id: string;
  clientId: string | null;
  agentId: string | null;
  operation: string;
  errorMessage: string;
  stackTrace?: string;
  severity: "WARN" | "ERROR" | "FATAL";
  timestamp: number;
}

/**
 * Pre-computed running totals maintained by the logger via FieldValue.increment().
 * Document IDs: "global" or "client_{clientId}".
 * Per-model fields are flattened: model_{sanitizedName}_{metric}.
 * This gives O(1) reads for the admin dashboard KPIs.
 */
export interface AnalyticsSnapshot {
  totalCostUsd: number;
  totalInputTokens: number;
  totalOutputTokens: number;
  totalRuns: number;
  totalErrors: number;
  lastUpdated: number;
  [key: string]: number; // model_* flattened fields
}

/* ── Pricing matrix ──────────────────────────────────────────────── */

/** Official Anthropic per-token pricing (USD per 1 million tokens). */
export const MODEL_PRICING: Record<string, { inputPer1M: number; outputPer1M: number }> = {
  "claude-opus-4-8":            { inputPer1M: 15.00, outputPer1M: 75.00 },
  "claude-opus-4-7":            { inputPer1M: 15.00, outputPer1M: 75.00 },
  "claude-sonnet-4-6":          { inputPer1M: 3.00,  outputPer1M: 15.00 },
  "claude-haiku-4-5-20251001":  { inputPer1M: 0.80,  outputPer1M: 4.00  },
  "claude-3-5-sonnet-20241022": { inputPer1M: 3.00,  outputPer1M: 15.00 },
  "claude-3-opus-20240229":     { inputPer1M: 15.00, outputPer1M: 75.00 },
  "claude-3-haiku-20240307":    { inputPer1M: 0.25,  outputPer1M: 1.25  },
  _default:                     { inputPer1M: 3.00,  outputPer1M: 15.00 },
};

export function computeCostUsd(
  modelName: string,
  inputTokens: number,
  outputTokens: number,
): number {
  const p = MODEL_PRICING[modelName] ?? MODEL_PRICING._default!;
  const raw = (inputTokens * p.inputPer1M + outputTokens * p.outputPer1M) / 1_000_000;
  return Math.round(raw * 1_000_000) / 1_000_000; // 6 decimal precision
}

/** Sanitize model name for use as a Firestore field key segment (no dots or dashes). */
export function sanitizeModelKey(modelName: string): string {
  return modelName.replace(/[^a-zA-Z0-9]/g, "_");
}

/** Reverse-map a sanitized key back to the closest known model name. */
export function resolveModelName(sanitizedKey: string): string {
  const direct = Object.keys(MODEL_PRICING).find(
    (m) => sanitizeModelKey(m) === sanitizedKey,
  );
  return direct ?? sanitizedKey.replace(/_/g, "-");
}
