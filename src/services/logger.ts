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
import { computeCostUsd, providerForModel, sanitizeModelKey } from "@/lib/models/usage-log";
import type { ProviderId, UsageLog, ErrorLog } from "@/lib/models/usage-log";

/** Minimal shape of an AI SDK streamText/generateText usage object. */
interface SdkUsage {
  inputTokens?: number;
  outputTokens?: number;
}

/** Fields every usage record needs; provider is derived from the model when omitted. */
type UsageInput = Omit<UsageLog, "id" | "timestamp" | "estimatedCostUsd" | "provider"> & {
  provider?: ProviderId;
};

/** Metadata for logging an AI SDK streaming/generate result (usage read for you). */
type StreamMeta = Omit<UsageInput, "inputTokens" | "outputTokens" | "webSearchCount">;

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

class Logger {
  /* ── Public API ─────────────────────────────────────────────────── */

  logUsage(data: UsageInput): void {
    const provider = data.provider ?? providerForModel(data.modelName);
    const webSearchCount = data.webSearchCount ?? 0; // Firestore rejects undefined
    const estimatedCostUsd = computeCostUsd(
      data.modelName,
      data.inputTokens,
      data.outputTokens,
      webSearchCount,
    );
    void this._writeUsage({ ...data, provider, webSearchCount, estimatedCostUsd, timestamp: Date.now() });
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
      } catch {
        // Usage logging must never disrupt the generation path.
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
      const key = sanitizeModelKey(data.modelName);
      const now = data.timestamp;

      // Increments shared across global + (optionally) client snapshot
      const increments = {
        totalCostUsd:                     FieldValue.increment(data.estimatedCostUsd),
        totalInputTokens:                 FieldValue.increment(data.inputTokens),
        totalOutputTokens:                FieldValue.increment(data.outputTokens),
        totalRuns:                        FieldValue.increment(1),
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
    } catch {
      // Logging must never throw — silent failure preserves the main path
    }
  }

  private async _writeError(
    data: Omit<ErrorLog, "id"> & { timestamp: number },
  ): Promise<void> {
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
