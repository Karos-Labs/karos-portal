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
import { computeCostUsd, sanitizeModelKey } from "@/lib/models/usage-log";
import type { UsageLog, ErrorLog } from "@/lib/models/usage-log";

class Logger {
  /* ── Public API ─────────────────────────────────────────────────── */

  logUsage(data: Omit<UsageLog, "id" | "timestamp" | "estimatedCostUsd">): void {
    const estimatedCostUsd = computeCostUsd(
      data.modelName,
      data.inputTokens,
      data.outputTokens,
    );
    void this._writeUsage({ ...data, estimatedCostUsd, timestamp: Date.now() });
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
