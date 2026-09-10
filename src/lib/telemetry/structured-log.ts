import "server-only";

/** Subset of Cloud Logging's LogSeverity enum this app actually emits. */
export type LogSeverity = "DEFAULT" | "INFO" | "WARNING" | "ERROR" | "CRITICAL";

/**
 * Cloud Run parses a single-line JSON object written to stdout/stderr into a
 * structured Cloud Logging entry: `severity` and `message` are promoted to
 * top-level LogEntry fields, everything else lands in `jsonPayload` — which
 * is what the Phase 2 log→BigQuery sink (bi_logs_export) needs to export
 * queryable fields instead of one opaque textPayload blob per line.
 * https://cloud.google.com/run/docs/logging#run_manual_logging
 *
 * Falls back to a plain, human-readable line outside Cloud Run (local dev,
 * `next build`) so terminals don't fill up with raw JSON. `K_SERVICE` is set
 * by Cloud Run on every revision — a reliable signal that stdout is actually
 * being scraped by the structured-log parser rather than a plain console.
 */
export function logStructured(
  severity: LogSeverity,
  message: string,
  fields?: Record<string, unknown>,
): void {
  const write = severity === "ERROR" || severity === "CRITICAL" ? console.error : console.log;
  if (process.env.K_SERVICE) {
    write(JSON.stringify({ severity, message, ...fields }));
  } else {
    write(`[${severity}] ${message}`, fields ?? "");
  }
}
