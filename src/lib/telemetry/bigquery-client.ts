import "server-only";

import { BigQuery, type Table } from "@google-cloud/bigquery";

/**
 * Lazy BigQuery singleton, same shape as adminDb()/adminBucket() in
 * src/lib/firebase/admin.ts. Auth is ADC (Cloud Run's attached service
 * account); GOOGLE_CLOUD_PROJECT must be set for BigQuery to resolve which
 * project's dataset to target. Unset in local dev — callers treat a null
 * return as "telemetry not configured" and no-op.
 */
const globalForBq = globalThis as typeof globalThis & {
  __karosBigQuery?: BigQuery;
};

function getBigQuery(): BigQuery | null {
  const projectId = process.env.GOOGLE_CLOUD_PROJECT;
  if (!projectId) return null;
  if (!globalForBq.__karosBigQuery) {
    globalForBq.__karosBigQuery = new BigQuery({ projectId });
  }
  return globalForBq.__karosBigQuery;
}

const DATASET_ID = () => process.env.BQ_DATASET_ID || "bi_telemetry";

/** Returns null when BigQuery isn't configured (GOOGLE_CLOUD_PROJECT unset) — callers no-op. */
export function biTable(tableId: string): Table | null {
  const bq = getBigQuery();
  if (!bq) return null;
  return bq.dataset(DATASET_ID()).table(tableId);
}
