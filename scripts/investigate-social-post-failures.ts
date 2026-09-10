/**
 * READ-ONLY: dumps recent failed social_post jobs (error, transcript URL,
 * timing) so the actual failure mode can be diagnosed from real data instead
 * of guessing. Same env-loading + firebase-admin init pattern as
 * scripts/dump-agent-cost-report.ts.
 *
 * Usage: npx tsx scripts/investigate-social-post-failures.ts
 */

import { readFileSync } from "node:fs";
import { resolve } from "node:path";

function loadEnvFile(path: string) {
  try {
    const content = readFileSync(path, "utf-8");
    for (const line of content.split("\n")) {
      const trimmed = line.trim();
      if (!trimmed || trimmed.startsWith("#")) continue;
      const eqIdx = trimmed.indexOf("=");
      if (eqIdx === -1) continue;
      const key = trimmed.slice(0, eqIdx).trim();
      let val = trimmed.slice(eqIdx + 1).trim();
      if ((val.startsWith('"') && val.endsWith('"')) || (val.startsWith("'") && val.endsWith("'"))) {
        val = val.slice(1, -1);
      }
      if (!process.env[key]) process.env[key] = val;
    }
  } catch {
    // .env.local may not exist — credentials can come from the environment.
  }
}
loadEnvFile(resolve(process.cwd(), ".env.local"));
loadEnvFile(resolve(process.cwd(), ".env"));

import { initializeApp, getApps, cert } from "firebase-admin/app";
import { getFirestore } from "firebase-admin/firestore";

function initAdmin() {
  if (!getApps().length) {
    const raw = process.env.FIREBASE_SERVICE_ACCOUNT_KEY;
    if (raw) {
      const parsed = JSON.parse(raw);
      console.log(`>>> Firebase project: ${parsed.project_id}`);
      initializeApp({ credential: cert(parsed) });
    } else {
      const projectId = process.env.FIREBASE_PROJECT_ID;
      const clientEmail = process.env.FIREBASE_CLIENT_EMAIL;
      const privateKey = process.env.FIREBASE_PRIVATE_KEY?.replace(/\\n/g, "\n");
      if (!projectId || !clientEmail || !privateKey) {
        throw new Error("No Firebase credentials found in .env.local");
      }
      console.log(`>>> Firebase project: ${projectId}`);
      initializeApp({ credential: cert({ projectId, clientEmail, privateKey }) });
    }
  }
  return getFirestore();
}

/** The fields this investigation actually reads off a jobs doc — everything else is ignored. */
interface SocialPostJobDoc {
  status?: string;
  error?: string;
  clientId?: string;
  createdAt?: number;
  updatedAt?: number;
  external?: {
    model?: string;
    totalCostUsd?: number;
    inputTokens?: number;
    outputTokens?: number;
    transcriptUrl?: string;
  };
}

async function main() {
  const db = initAdmin();

  const snap = await db
    .collection("jobs")
    .where("external.taskType", "==", "social_post")
    .limit(500)
    .get();
  const docs = snap.docs.sort((a, b) => (b.data().createdAt ?? 0) - (a.data().createdAt ?? 0)).slice(0, 100);

  console.log(`>>> Fetched ${snap.size} social_post jobs (showing ${docs.length} most recent)`);

  const byStatus = new Map<string, number>();
  const errorPatterns = new Map<string, { count: number; example: string; jobId: string }>();

  for (const doc of docs) {
    const job = doc.data() as SocialPostJobDoc;
    const status = job.status ?? "unknown";
    byStatus.set(status, (byStatus.get(status) ?? 0) + 1);
    if (status !== "failed") continue;

    const error: string = job.error ?? "(no error message)";
    // Bucket by a short signature so repeated causes group together instead of
    // each unique job-id/timestamp fragment making its own bucket.
    const signature = error
      .replace(/[0-9a-f]{8,}/gi, "<hex>")
      .replace(/\d{4}-\d{2}-\d{2}[^\s]*/g, "<date>")
      .slice(0, 120);
    const bucket = errorPatterns.get(signature);
    if (bucket) {
      bucket.count += 1;
    } else {
      errorPatterns.set(signature, { count: 1, example: error, jobId: doc.id });
    }
  }

  console.log(`\n=== STATUS BREAKDOWN ===`);
  for (const [status, count] of byStatus.entries()) {
    console.log(`  ${status}: ${count}`);
  }

  console.log(`\n=== FAILURE SIGNATURES (grouped) ===`);
  const sorted = [...errorPatterns.entries()].sort((a, b) => b[1].count - a[1].count);
  for (const [, info] of sorted) {
    console.log(`\n--- ${info.count}x --- (example job: ${info.jobId})`);
    console.log(`  ${info.example}`);
  }

  console.log(`\n=== RECENT FAILED JOBS (detail) ===`);
  let shown = 0;
  for (const doc of docs) {
    const job = doc.data() as SocialPostJobDoc;
    if (job.status !== "failed" || shown >= 15) continue;
    shown += 1;
    const durationMs = job.updatedAt && job.createdAt ? job.updatedAt - job.createdAt : null;
    console.log(`\n[${doc.id}] client=${job.clientId} createdAt=${new Date(job.createdAt ?? 0).toISOString()}`);
    console.log(`  durationMs=${durationMs} model=${job.external?.model} totalCostUsd=${job.external?.totalCostUsd}`);
    console.log(`  inputTokens=${job.external?.inputTokens} outputTokens=${job.external?.outputTokens}`);
    console.log(`  error: ${job.error}`);
    console.log(`  transcriptUrl: ${job.external?.transcriptUrl ?? "(none)"}`);
  }
}

main()
  .then(() => process.exit(0))
  .catch((e) => {
    console.error(e);
    process.exit(1);
  });
