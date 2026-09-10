/**
 * Read-only survey of candidate "trash" data in production Firestore — never
 * deletes anything. Prints counts + samples per category so you can decide
 * what's actually safe to purge before running the (separate, --apply-gated)
 * cleanup step.
 *
 *   npx tsx scripts/audit-production-trash.ts
 *
 * The credentials in .env.local point at production Firestore (same as
 * purge-orphaned-client-docs.ts). This script issues reads only.
 *
 * Categories surveyed:
 *   1. Orphaned client-scoped docs (clientId points at a deleted client) —
 *      mirrors purge-orphaned-client-docs.ts's own detection.
 *   2. Jobs with status "failed" or "cancelled" (no age cutoff — all of them).
 *   3. clientMarketingAnalytics docs with source:"mock" (pre-live-ingest
 *      placeholder data — see src/lib/analytics.ts's mock/live distinction).
 *   4. Client records that look like test/demo fixtures (name/email/domain
 *      heuristics) — flagged for manual review, never auto-deleted.
 */

import { readFileSync } from "node:fs";
import { resolve } from "node:path";

function loadEnvFile(path: string) {
  try {
    for (const line of readFileSync(path, "utf-8").split("\n")) {
      const t = line.trim();
      if (!t || t.startsWith("#")) continue;
      const i = t.indexOf("=");
      if (i === -1) continue;
      const k = t.slice(0, i).trim();
      let v = t.slice(i + 1).trim();
      if ((v.startsWith('"') && v.endsWith('"')) || (v.startsWith("'") && v.endsWith("'"))) v = v.slice(1, -1);
      if (!process.env[k]) process.env[k] = v;
    }
  } catch {
    // fine — env may come from the shell
  }
}
loadEnvFile(resolve(process.cwd(), ".env.local"));
loadEnvFile(resolve(process.cwd(), ".env"));

import { initializeApp, cert, getApps } from "firebase-admin/app";

import { getScriptFirestore } from "./lib/firestore-db";

/** Mirror of data.ts CLIENT_SCOPED_COLLECTIONS (see purge-orphaned-client-docs.ts). */
const CLIENT_SCOPED_COLLECTIONS = [
  "jobs",
  "assets",
  "transcripts",
  "contextItems",
  "clientCompetitors",
  "clientContextDocs",
  "clientActivityLogs",
  "clientIntegrations",
  "clientTasks",
  "taskComments",
  "actionItems",
  "scheduledRuns",
  "clientMarketingAnalytics",
  "campaigns",
  "clientSeats",
  "agentIntake",
  "xNewsUpdates",
  "xTakes",
  "xDraftFeedback",
  "liDraftFeedback",
  "redditDraftFeedback",
  "plannedScheduledRuns",
  "seatVoiceProfiles",
];

/** Mirror of data.ts CLIENT_DOC_COLLECTIONS. */
const CLIENT_DOC_COLLECTIONS = ["clientReports", "clientSeoGeo", "clientInsightsCache", "clientCredits", "clientSettings"];

/** Heuristics for test/demo client fixtures — flagged for manual review only. */
const TEST_NAME_PATTERN = /\b(test|demo|sample|dummy|fixture|qa)\b/i;
const TEST_EMAIL_PATTERN = /@(example\.(com|org|net)|test\.(com|dev)|localhost|karoslabs\.com)$/i;

function fmtDate(ms: number | undefined) {
  return ms ? new Date(ms).toISOString().slice(0, 10) : "?";
}

async function main() {
  if (!getApps().length) {
    const raw = process.env.FIREBASE_SERVICE_ACCOUNT_KEY;
    if (!raw) throw new Error("FIREBASE_SERVICE_ACCOUNT_KEY not set");
    initializeApp({ credential: cert(JSON.parse(raw)) });
  }
  // Deliberately production-only by design (SCRUM-374) — opts in explicitly
  // rather than inheriting "(default)" by leaving FIRESTORE_DATABASE_ID unset.
  const db = getScriptFirestore(getApps()[0]!, { allowDefaultProduction: true });

  console.log("═══ Production data audit (read-only — nothing is deleted) ═══\n");

  // ── 1. Orphaned client-scoped docs ──────────────────────────────────────
  console.log("── 1. Orphaned docs (clientId points at a deleted client) ──");
  const clientsSnap = await db.collection("clients").get();
  const liveIds = new Set(clientsSnap.docs.map((d) => d.id));
  console.log(`${liveIds.size} live clients.`);

  const orphanedByColl = new Map<string, number>();
  let orphanedTotal = 0;
  for (const coll of CLIENT_SCOPED_COLLECTIONS) {
    const snap = await db.collection(coll).get();
    let n = 0;
    for (const doc of snap.docs) {
      const clientId = doc.data().clientId as string | undefined;
      if (clientId && !liveIds.has(clientId)) n++;
    }
    if (n > 0) orphanedByColl.set(coll, n);
    orphanedTotal += n;
  }
  for (const coll of CLIENT_DOC_COLLECTIONS) {
    const snap = await db.collection(coll).get();
    let n = 0;
    for (const doc of snap.docs) {
      const clientId = (doc.data().clientId as string | undefined) ?? doc.id;
      if (!liveIds.has(clientId)) n++;
    }
    if (n > 0) orphanedByColl.set(coll, n);
    orphanedTotal += n;
  }
  if (orphanedTotal === 0) {
    console.log("None found.\n");
  } else {
    for (const [coll, n] of orphanedByColl) console.log(`  ${coll}: ${n}`);
    console.log(`Total: ${orphanedTotal}. Run purge-orphaned-client-docs.ts for the full per-client breakdown + deletion.\n`);
  }

  // ── 2. Failed / cancelled jobs (no age cutoff) ──────────────────────────
  console.log("── 2. Failed / cancelled jobs (all, no age cutoff) ──");
  const jobsSnap = await db.collection("jobs").where("status", "in", ["failed", "cancelled"]).get();
  const byStatus = new Map<string, number>();
  const samples: string[] = [];
  for (const doc of jobsSnap.docs) {
    const data = doc.data();
    const status = data.status as string;
    byStatus.set(status, (byStatus.get(status) ?? 0) + 1);
    if (samples.length < 8) {
      samples.push(`  [${status}] ${doc.id} — client=${data.clientId ?? "?"} type=${data.taskType ?? data.type ?? "?"} created=${fmtDate(data.createdAt)}`);
    }
  }
  if (jobsSnap.size === 0) {
    console.log("None found.\n");
  } else {
    for (const [status, n] of byStatus) console.log(`  ${status}: ${n}`);
    console.log(`Total: ${jobsSnap.size}. Samples:`);
    console.log(samples.join("\n"), "\n");
  }

  // ── 3. Mock-sourced analytics ────────────────────────────────────────────
  console.log("── 3. clientMarketingAnalytics with source:\"mock\" ──");
  const mockAnalyticsSnap = await db.collection("clientMarketingAnalytics").where("source", "==", "mock").get();
  if (mockAnalyticsSnap.size === 0) {
    console.log("None found.\n");
  } else {
    const byClient = new Map<string, number>();
    for (const doc of mockAnalyticsSnap.docs) {
      const clientId = (doc.data().clientId as string) ?? "?";
      byClient.set(clientId, (byClient.get(clientId) ?? 0) + 1);
    }
    console.log(`Total: ${mockAnalyticsSnap.size} across ${byClient.size} client(s).`);
    for (const [clientId, n] of [...byClient.entries()].slice(0, 10)) console.log(`  client ${clientId}: ${n}`);
    console.log();
  }

  // ── 4. Test/demo-looking client accounts (flagged for review only) ──────
  console.log("── 4. Client records matching test/demo heuristics (manual review — not auto-flagged for deletion) ──");
  const suspects: string[] = [];
  for (const doc of clientsSnap.docs) {
    const data = doc.data();
    const name = String(data.name ?? "");
    const email = String(data.contactEmail ?? "");
    const domains = Array.isArray(data.domains) ? (data.domains as string[]) : [];
    const nameHit = TEST_NAME_PATTERN.test(name);
    const emailHit = TEST_EMAIL_PATTERN.test(email) || domains.some((d) => TEST_EMAIL_PATTERN.test(`@${d}`));
    if (nameHit || emailHit) {
      suspects.push(`  ${doc.id} — name="${name}" email="${email}" domains=${JSON.stringify(domains)} status=${data.status ?? "?"}`);
    }
  }
  if (suspects.length === 0) {
    console.log("None found.\n");
  } else {
    console.log(`${suspects.length} client(s) flagged — review each one, these are NOT queued for deletion:`);
    console.log(suspects.join("\n"), "\n");
  }

  console.log("═══ Audit complete. Nothing was deleted. ═══");
}

main()
  .then(() => process.exit(0))
  .catch((e) => {
    console.error(e);
    process.exit(1);
  });
