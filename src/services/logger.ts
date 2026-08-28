/**
 * Karos CMO — Async usage & error logger.
 *
 * Design contract:
 *   • logUsage() / logError() return void immediately — never awaited by callers.
 *   • All Firestore I/O is isolated in private async methods; failures are swallowed.
 *   • The class interface is an intentional OTel boundary: to migrate to an APM
 *     collector, replace _writeUsage/_writeError with OTLP span/metric exports —
 *     every call-site stays unchanged.
 *
 * Concurrency note:
 *   Inside executeRun (already deferred via next/server `after()`), call directly:
 *     void logger.logUsage({ ... });
 *   Inside server actions / route handlers, wrap with after():
 *     after(() => logger.logUsage({ ... }));
 */
import "server-only";

import { adminDb } from "@/lib/firebase/admin";
import {
  PricingLookupError,
  computeCostUsd,
  providerForModel,
  providerForVendor,
  sanitizeModelKey,
  vendorsPricing,
} from "@/lib/models/usage-log";
import type { PricingVendor, ProviderId, UsageLog, ErrorLog } from "@/lib/models/usage-log";
import { trackAgentRun } from "@/lib/telemetry/bi-tracker";
import { logStructured } from "@/lib/telemetry/structured-log";

/** Minimal shape of an AI SDK streamText/generateText usage object. */
interface SdkUsage {
  inputTokens?: number;
  outputTokens?: number;
}

/**
 * Fields every usage record needs.
 *
 * `modelName` must be the RESOLVED model id and `vendor` the vendor that served
 * it — spread `usageFor("<role>")` from `@/lib/ai/provider` to get both from one
 * place. Passing a `MODELS.*` tier constant still type-checks (it is a string),
 * which is why the pricing lookup, not the type, is the thing that refuses: see
 * `logUsage` below and `lib/models/usage-log.ts`'s `priceFor`.
 *
 * `provider` (the coarse billing family) is derived from `vendor` when omitted.
 */
type UsageInput = Omit<UsageLog, "id" | "timestamp" | "estimatedCostUsd" | "provider" | "vendor"> & {
  provider?: ProviderId;
  vendor?: PricingVendor;
};

/** Metadata for logging an AI SDK streaming/generate result (usage read for you). */
type StreamMeta = Omit<UsageInput, "inputTokens" | "outputTokens" | "webSearchCount" | "status" | "errorMessage">;

/**
 * Best-effort partial-usage extraction from a thrown AI SDK error.
 *
 * `generateObject`'s `NoObjectGeneratedError` carries the real `.usage` for the
 * attempt that failed schema validation — tokens genuinely spent that every
 * other error shape (APICallError, network failures) has no equivalent for.
 * Duck-typed rather than `instanceof` so this doesn't need to import `ai`'s
 * error classes here; never throws.
 */
function extractPartialUsage(err: unknown): SdkUsage {
  try {
    const usage = (err as { usage?: SdkUsage } | null)?.usage;
    if (usage && (typeof usage.inputTokens === "number" || typeof usage.outputTokens === "number")) {
      return { inputTokens: usage.inputTokens ?? 0, outputTokens: usage.outputTokens ?? 0 };
    }
  } catch {
    // fall through to zero
  }
  return { inputTokens: 0, outputTokens: 0 };
}

/**
 * Best-effort extraction of Anthropic server-side web_search invocation count
 * from AI SDK provider metadata. Never throws; returns 0 when unavailable.
 * Exported for `generateText` call sites, which expose `providerMetadata` as a
 * resolved value rather than the promise `trackStream` consumes.
 */
export function readWebSearchCount(providerMetadata: unknown): number {
  try {
    const anthropic = (providerMetadata as { anthropic?: Record<string, unknown> })?.anthropic;
    const usage = anthropic?.usage as Record<string, unknown> | undefined;
    const serverToolUse =
      (usage?.serverToolUse as Record<string, unknown> | undefined) ??
      (usage?.server_tool_use as Record<string, unknown> | undefined);
    const count =
      (serverToolUse?.webSearchRequests as number | undefined) ??
      (serverToolUse?.web_search_requests as number | undefined);
    return Number.isFinite(count) ? Number(count) : 0;
  } catch {
    return 0;
  }
}

/**
 * Best-effort vendor for a row whose caller did not pass one.
 *
 * Only ever used for legacy/raw-id call sites (a client-configured chat model,
 * the SEO/GEO engine columns). Picking any vendor that prices the id is safe
 * because `MODEL_PRICING` refuses to build if two vendors price one id
 * differently — so where more than one matches, the bill is the same either way.
 * An id NO vendor prices falls through to the id-sniffed family and is then
 * REFUSED by `priceFor`, which is the intended outcome: an id nobody prices must
 * not be quietly costed.
 */
function inferVendor(modelId: string): PricingVendor {
  const vendors = vendorsPricing(modelId);
  return vendors.length === 1 ? vendors[0]! : (vendors[0] ?? providerForModel(modelId));
}

const MAX_ERROR_DETAIL_LENGTH = 300;

/**
 * Provider/upstream error text can echo prompt fragments verbatim, and a raw
 * `.stack` is multi-line with local file paths — neither belongs in the
 * structured log line that Cloud Run exports into bi_logs_export. Keep only
 * the first line (error name + message, no stack frames) and cap its length.
 */
function sanitizeErrorDetail(detail: string | null | undefined): string | null {
  if (!detail) return null;
  const firstLine = detail.split("\n")[0];
  return firstLine.length > MAX_ERROR_DETAIL_LENGTH
    ? `${firstLine.slice(0, MAX_ERROR_DETAIL_LENGTH)}…`
    : firstLine;
}

class Logger {
  /* ── Public API ─────────────────────────────────────────────────── */

  logUsage(data: UsageInput): void {
    const vendor = data.vendor ?? inferVendor(data.modelName);
    const provider = data.provider ?? providerForVendor(vendor);
    const webSearchCount = data.webSearchCount ?? 0; // Firestore rejects undefined

    // AU70/SCRUM-370. Pricing is keyed on (vendor, resolved model id) and the
    // lookup THROWS on a pair it does not know — there is no default row any
    // more. logUsage's contract is that it never throws into the generation
    // path, so the refusal is converted here into the loudest thing that is
    // still safe: a structured ERROR naming the pair, AND a `pricingUnresolved`
    // flag persisted on the row itself (not only an ERROR log line, whose
    // readership nothing here can confirm) — the row's cost is written as 0 but
    // stays queryably distinct from a row that is 0 because the call really was
    // free. This matters beyond the aiFor/usageFor-covered call sites this
    // ticket rewired: the agent-service webhook and reconcile-job also call
    // logUsage with a `modelName` sourced from an external payload or an
    // admin-typed `stepModels` override, never from `ResolvedAi`, so they can
    // hit an unpriced pair too — see cost-logger-external-model-ids.test.ts. The
    // old behaviour — Sonnet's $3/$15 substituted for an unrecognised pair —
    // was silent, plausible and wrong, which is the entire ticket; a bare 0
    // with nothing marking it would trade that for a different silent wrong:
    // indistinguishable from a genuinely free run on every dashboard that reads
    // this collection. The flag is what keeps the failure loud all the way to
    // the stored data, not just to whoever happens to be watching the log.
    let estimatedCostUsd = 0;
    let pricingUnresolved = false;
    try {
      estimatedCostUsd = computeCostUsd(
        vendor,
        data.modelName,
        data.inputTokens,
        data.outputTokens,
        webSearchCount,
      );
    } catch (err) {
      if (!(err instanceof PricingLookupError)) throw err;
      pricingUnresolved = true;
      logStructured("ERROR", err.message, {
        event: "pricing.lookup_failed",
        vendor: err.vendor,
        modelName: err.modelId,
        operation: data.operation,
        clientId: data.clientId,
        inputTokens: data.inputTokens,
        outputTokens: data.outputTokens,
      });
    }

    void this._writeUsage({
      ...data,
      provider,
      vendor,
      webSearchCount,
      estimatedCostUsd,
      ...(pricingUnresolved ? { pricingUnresolved: true } : {}),
      timestamp: Date.now(),
    });
  }

  /**
   * Log a failed generation attempt — a call that threw before (or instead of)
   * returning a usable result. Tokens are best-effort (0 when the error carries
   * no recoverable usage); the point is that the attempt, and whatever it did
   * spend, is never simply absent from `usageLogs` / the leaderboard.
   */
  logGenerationFailure(meta: StreamMeta, err: unknown): void {
    const usage = extractPartialUsage(err);
    this.logUsage({
      ...meta,
      inputTokens: usage.inputTokens ?? 0,
      outputTokens: usage.outputTokens ?? 0,
      status: "failed",
      errorMessage: err instanceof Error ? err.message : String(err),
    });
  }

  /**
   * Log usage for an AI SDK `streamText`/`generateText` result. Reads the
   * result's `usage` (and, when present, `providerMetadata` for web_search
   * counts) then records one UsageLog. Fire-and-forget — never throws, never
   * blocks the caller. Call it right after you finish consuming the stream:
   *   const text = await stream.text;
   *   logger.trackStream(stream, { clientId, agentName, modelName, operation });
   */
  trackStream(
    result: { usage: PromiseLike<SdkUsage>; providerMetadata?: PromiseLike<unknown> },
    meta: StreamMeta,
  ): void {
    void (async () => {
      try {
        const [usage, providerMetadata] = await Promise.all([
          result.usage,
          result.providerMetadata ?? Promise.resolve(undefined),
        ]);
        this.logUsage({
          ...meta,
          inputTokens: usage.inputTokens ?? 0,
          outputTokens: usage.outputTokens ?? 0,
          webSearchCount: readWebSearchCount(providerMetadata),
        });
      } catch (err) {
        // Usage logging must never disrupt the generation path, but a stream
        // that threw before resolving `usage` (rate limit, dropped connection,
        // upstream error) still spent whatever tokens it emitted before
        // failing — record it as a failed, best-effort-zero-token attempt
        // instead of letting it vanish from usageLogs/analyticsSnapshot.
        this.logGenerationFailure(meta, err);
      }
    })();
  }

  logError(data: Omit<ErrorLog, "id" | "timestamp">): void {
    void this._writeError({ ...data, timestamp: Date.now() });
  }

  /* ── Private I/O ────────────────────────────────────────────────── */

  private async _writeUsage(
    data: Omit<UsageLog, "id"> & { estimatedCostUsd: number; timestamp: number },
  ): Promise<void> {
    try {
      const db = adminDb();
      const { FieldValue } = await import("firebase-admin/firestore");

      const logRef = db.collection("usageLogs").doc();
      const key = sanitizeModelKey(data.modelName, data.vendor ?? "anthropic");
      const now = data.timestamp;

      // Increments shared across global + (optionally) client snapshot. Failed
      // runs still count toward totalCostUsd/totalRuns — the spend happened —
      // and are additionally broken out via failedRuns/failedCostUsd so
      // dashboards can distinguish "spend" from "spend that produced nothing."
      const failed = data.status === "failed";
      const increments = {
        totalCostUsd:                     FieldValue.increment(data.estimatedCostUsd),
        totalInputTokens:                 FieldValue.increment(data.inputTokens),
        totalOutputTokens:                FieldValue.increment(data.outputTokens),
        totalRuns:                        FieldValue.increment(1),
        ...(failed ? {
          failedRuns:                     FieldValue.increment(1),
          failedCostUsd:                  FieldValue.increment(data.estimatedCostUsd),
        } : {}),
        [`model_${key}_costUsd`]:         FieldValue.increment(data.estimatedCostUsd),
        [`model_${key}_inputTokens`]:     FieldValue.increment(data.inputTokens),
        [`model_${key}_outputTokens`]:    FieldValue.increment(data.outputTokens),
        [`model_${key}_runs`]:            FieldValue.increment(1),
        lastUpdated:                      now,
      };

      const snaps = db.collection("analyticsSnapshot");
      const batch = db.batch();
      batch.set(logRef, { id: logRef.id, ...data });
      batch.set(snaps.doc("global"), increments, { merge: true });
      if (data.clientId) {
        batch.set(snaps.doc(`client_${data.clientId}`), increments, { merge: true });
      }
      await batch.commit();

      // BI seam: every usage log also feeds the BigQuery agent_runs_bi table.
      // No-ops when GOOGLE_CLOUD_PROJECT is unset (see bigquery-client.ts).
      trackAgentRun({
        runId: logRef.id,
        clientId: data.clientId,
        agentId: data.agentId,
        model: data.modelName,
        inputTokens: data.inputTokens,
        outputTokens: data.outputTokens,
        costUsd: data.estimatedCostUsd,
        durationMs: data.durationMs ?? null,
        status: data.status ?? "success",
        errorDetails: data.errorMessage ?? null,
        timestamp: now,
        // Discriminator (2026-08) — see trackAgentRun's own doc. Without
        // `operation`, a dynamic run's run-level row and its own per-step
        // rows (operation: "managed_job_step") are indistinguishable in BQ.
        operation: data.operation,
        jobId: data.jobId ?? null,
        stepId: data.stepId ?? null,
      });
    } catch {
      // Logging must never throw — silent failure preserves the main path
    }
  }

  private async _writeError(
    data: Omit<ErrorLog, "id"> & { timestamp: number },
  ): Promise<void> {
    // Structured stdout/stderr line — Cloud Run scrapes this into Cloud
    // Logging, and the Phase 2 sink exports it into bi_logs_export. Fires
    // unconditionally (console calls don't throw), independent of whether
    // the Firestore write below succeeds. Sanitized: provider/upstream error
    // text can echo prompt fragments, and a raw stack is multi-line with
    // local file paths — neither belongs in an exported BI sink.
    logStructured(data.severity === "WARN" ? "WARNING" : data.severity === "FATAL" ? "CRITICAL" : "ERROR", sanitizeErrorDetail(data.errorMessage) ?? "", {
      clientId: data.clientId,
      agentId: data.agentId,
      operation: data.operation,
      stackTrace: sanitizeErrorDetail(data.stackTrace),
    });
    try {
      const db = adminDb();
      const { FieldValue } = await import("firebase-admin/firestore");

      const logRef = db.collection("errorLogs").doc();
      const snaps = db.collection("analyticsSnapshot");
      const errorIncrement = {
        totalErrors:  FieldValue.increment(1),
        lastUpdated:  data.timestamp,
      };

      const batch = db.batch();
      batch.set(logRef, { id: logRef.id, ...data });
      batch.set(snaps.doc("global"), errorIncrement, { merge: true });
      if (data.clientId) {
        batch.set(snaps.doc(`client_${data.clientId}`), errorIncrement, { merge: true });
      }
      await batch.commit();
    } catch {
      // Silent failure
    }
  }
}

export const logger = new Logger();
