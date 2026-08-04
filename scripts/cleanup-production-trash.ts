/**
 * Deletes the three confirmed-trash categories found by
 * audit-production-trash.ts: orphaned client-scoped docs, failed jobs, and
 * mock-sourced analytics rows. Does NOT touch any client record itself.
 *
 *   npx tsx scripts/cleanup-production-trash.ts            # dry run — prints the plan
 *   npx tsx scripts/cleanup-production-trash.ts --apply    # deletes (permanent — there is no undo)
 *
 * DRY RUN IS THE DEFAULT ON PURPOSE. The credentials in .env.local point at
 * production Firestore. Read the printed plan first.
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
import { getFirestore, type DocumentReference } from "firebase-admin/firestore";

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
const CLIENT_DOC_COLLECTIONS = ["clientReports", "clientSeoGeo", "clientInsightsCache", "clientCredits", "clientSettings"];

async function batchDelete(db: FirebaseFirestore.Firestore, refs: DocumentReference[]) {
  let deleted = 0;
  for (let i = 0; i < refs.length; i += 400) {
    const batch = db.batch();
    for (const ref of refs.slice(i, i + 400)) batch.delete(ref);
    await batch.commit();
    deleted += Math.min(400, refs.length - i);
  }
  return deleted;
}

async function main() {
  const apply = process.argv.includes("--apply");
  if (!getApps().length) {
    const raw = process.env.FIREBASE_SERVICE_ACCOUNT_KEY;
    if (!raw) throw new Error("FIREBASE_SERVICE_ACCOUNT_KEY not set");
    initializeApp({ credential: cert(JSON.parse(raw)) });
  }
  const db = getFirestore();

  console.log(apply ? "[APPLY — deletions are permanent]\n" : "[DRY RUN — nothing is deleted. Pass --apply to delete.]\n");

  // ── 1. Orphaned client-scoped docs ──────────────────────────────────────
  const clientsSnap = await db.collection("clients").get();
  const liveIds = new Set(clientsSnap.docs.map((d) => d.id));
  const orphanedRefs: DocumentReference[] = [];
  for (const coll of CLIENT_SCOPED_COLLECTIONS) {
    const snap = await db.collection(coll).get();
    for (const doc of snap.docs) {
      const clientId = doc.data().clientId as string | undefined;
      if (clientId && !liveIds.has(clientId)) orphanedRefs.push(doc.ref);
    }
  }
  for (const coll of CLIENT_DOC_COLLECTIONS) {
    const snap = await db.collection(coll).get();
    for (const doc of snap.docs) {
      const clientId = (doc.data().clientId as string | undefined) ?? doc.id;
      if (!liveIds.has(clientId)) orphanedRefs.push(doc.ref);
    }
  }
  console.log(`1. Orphaned docs: ${orphanedRefs.length}`);

  // ── 2. Failed / cancelled jobs ───────────────────────────────────────────
  const jobsSnap = await db.collection("jobs").where("status", "in", ["failed", "cancelled"]).get();
  const jobRefs = jobsSnap.docs.map((d) => d.ref);
  console.log(`2. Failed/cancelled jobs: ${jobRefs.length}`);

  // ── 3. Mock-sourced analytics ────────────────────────────────────────────
  const mockSnap = await db.collection("clientMarketingAnalytics").where("source", "==", "mock").get();
  const mockRefs = mockSnap.docs.map((d) => d.ref);
  console.log(`3. Mock-sourced analytics: ${mockRefs.length}`);

  const total = orphanedRefs.length + jobRefs.length + mockRefs.length;
  console.log(`\nTotal to delete: ${total}`);

  if (!apply) {
    console.log("\nDry run — nothing deleted. Re-run with --apply to purge.");
    return;
  }

  const allRefs = [...orphanedRefs, ...jobRefs, ...mockRefs];
  const deleted = await batchDelete(db, allRefs);
  console.log(`\nPurged ${deleted} documents.`);
}

main()
  .then(() => process.exit(0))
  .catch((e) => {
    console.error(e);
    process.exit(1);
  });
