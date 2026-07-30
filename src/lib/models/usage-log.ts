/**
 * Usage and error log types, plus the Anthropic pricing matrix.
 * Kept separate from types.ts so this file can be imported in server-only
 * service modules without pulling in all domain types.
 */

/* ── Log records ─────────────────────────────────────────────────── */

/** Model vendor behind a call. Drives which pricing table row applies. */
export type ProviderId = "anthropic" | "openai" | "google";

export interface UsageLog {
  id: string;
  clientId: string | null;
  agentId: string | null;
  agentName: string;
  /** Which vendor served the request. Derived from `modelName` when not supplied. */
  provider: ProviderId;
  modelName: string;
  /**
   * The feature/surface that triggered the run — the analytics `featureContext`.
   * e.g. "intel_report" | "intel_research" | "seo_audit" | "geo_capture" |
   * "chat_copilot" | "branding_extraction" | "competitor_analysis" | "task_execution".
   */
  operation: string;
  inputTokens: number;
  outputTokens: number;
  /**
   * Anthropic server-side web_search invocations billed on top of tokens
   * (web_fetch is included, no per-call charge). 0 for providers/calls without it.
   */
  webSearchCount?: number;
  estimatedCostUsd: number;
  jobId?: string | null;
  durationMs?: number;
  timestamp: number;
  /**
   * Omitted/undefined on historic docs is treated as "success" everywhere
   * this is read. "cancelled" is kept distinct from "failed" (mirroring
   * `JobStatus`'s own split) so a deliberate Force Cancel doesn't inflate the
   * Agent Leaderboard's failure count the way a genuine breakage should —
   * both still count toward totalCostUsd/totalRuns (the spend is real
   * either way), only the failedRuns/failedCostUsd reliability signal cares
   * about the distinction.
   */
  status?: "success" | "failed" | "cancelled";
  /** Set when status is "failed"/"cancelled" — the thrown error or upstream failure/cancellation reason. */
  errorMessage?: string;
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
  /** Overlay on the totals above — spend/runs already counted in totalCostUsd/totalRuns that failed. */
  failedRuns?: number;
  failedCostUsd?: number;
  lastUpdated: number;
  [key: string]: number | undefined; // model_* flattened fields
}

/* ── Pricing matrix ──────────────────────────────────────────────── */

/**
 * Per-token pricing (USD per 1 million tokens) across every provider the
 * platform calls. Anthropic models run the core pipeline; OpenAI + Gemini
 * answer their columns in the SEO/GEO visibility capture.
 * Update these when vendor pricing changes.
 */
export const MODEL_PRICING: Record<string, { inputPer1M: number; outputPer1M: number }> = {
  // Anthropic (Claude)
  "claude-opus-4-8":            { inputPer1M: 15.00, outputPer1M: 75.00 },
  "claude-opus-4-7":            { inputPer1M: 15.00, outputPer1M: 75.00 },
  "claude-sonnet-4-6":          { inputPer1M: 3.00,  outputPer1M: 15.00 },
  "claude-haiku-4-5-20251001":  { inputPer1M: 0.80,  outputPer1M: 4.00  },
  "claude-3-5-sonnet-20241022": { inputPer1M: 3.00,  outputPer1M: 15.00 },
  "claude-3-opus-20240229":     { inputPer1M: 15.00, outputPer1M: 75.00 },
  "claude-3-haiku-20240307":    { inputPer1M: 0.25,  outputPer1M: 1.25  },
  // OpenAI (SEO/GEO "chatgpt" engine)
  "gpt-4o-mini":                { inputPer1M: 0.15,  outputPer1M: 0.60  },
  "gpt-4o":                     { inputPer1M: 2.50,  outputPer1M: 10.00 },
  // Google (SEO/GEO "gemini" engine)
  "gemini-2.5-flash":           { inputPer1M: 0.30,  outputPer1M: 2.50  },
  "gemini-2.5-pro":             { inputPer1M: 1.25,  outputPer1M: 10.00 },
  _default:                     { inputPer1M: 3.00,  outputPer1M: 15.00 },
};

/**
 * Anthropic server-side web_search pricing: $10 per 1,000 searches → $0.01 each.
 * web_fetch carries no per-call charge (only the tokens it feeds into context).
 */
export const WEB_SEARCH_COST_PER_CALL = 10 / 1_000;

/** Infer the vendor from a model id so callers don't have to pass it explicitly. */
export function providerForModel(modelName: string): ProviderId {
  if (modelName.startsWith("gpt-") || modelName.startsWith("o1") || modelName.startsWith("o3")) return "openai";
  if (modelName.startsWith("gemini")) return "google";
  return "anthropic";
}

export function computeCostUsd(
  modelName: string,
  inputTokens: number,
  outputTokens: number,
  webSearchCount = 0,
): number {
  const p = MODEL_PRICING[modelName] ?? MODEL_PRICING._default!;
  const raw =
    (inputTokens * p.inputPer1M + outputTokens * p.outputPer1M) / 1_000_000 +
    webSearchCount * WEB_SEARCH_COST_PER_CALL;
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
