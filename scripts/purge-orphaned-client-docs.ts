/**
 * Find (and optionally delete) documents whose clientId points at a client that
 * no longer exists — the leftovers of pre-cascade client deletions that used to
 * spill into cross-client staff views (task board, assets, calendar, jobs).
 *
 *   npx tsx scripts/purge-orphaned-client-docs.ts            # dry run — prints the plan
 *   npx tsx scripts/purge-orphaned-client-docs.ts --apply    # deletes (permanent — there is no undo)
 *
 * DRY RUN IS THE DEFAULT ON PURPOSE. The credentials in .env.local point at
 * production Firestore. Read the printed plan first.
 *
 * Keep the collection list in step with CLIENT_SCOPED_COLLECTIONS /
 * CLIENT_DOC_COLLECTIONS in src/lib/data.ts (inlined here because data.ts is
 * a Next server-only module). The credit LEDGER and usage logs are deliberately
 * NOT purged — they are financial/audit history.
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
import { getFirestore } from "firebase-admin/firestore";

/** Collections whose docs carry a clientId field (mirror of data.ts CLIENT_SCOPED_COLLECTIONS). */
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
  "liDirectionRequests",
  "liAgentState",
  "redditDraftFeedback",
  "redditAgentState",
  "newsletterDraftFeedback",
  "newsletterAgentState",
  "newsletterLedger",
  "blogAgentState",
  "reputationAgentState",
  "carouselAgentState",
  "plannedScheduledRuns",
  "seatVoiceProfiles",
];

/** Per-client singleton docs, doc ID = clientId (mirror of data.ts CLIENT_DOC_COLLECTIONS). */
const CLIENT_DOC_COLLECTIONS = [
  "clientReports",
  "clientSeoGeo",
  "clientInsightsCache",
  "clientCredits",
  "clientSettings",
];

async function main() {
  const apply = process.argv.includes("--apply");
  if (!getApps().length) {
    const raw = process.env.FIREBASE_SERVICE_ACCOUNT_KEY;
    if (!raw) throw new Error("FIREBASE_SERVICE_ACCOUNT_KEY not set");
    initializeApp({ credential: cert(JSON.parse(raw)) });
  }
  const db = getFirestore();

  const clientsSnap = await db.collection("clients").get();
  const liveIds = new Set(clientsSnap.docs.map((d) => d.id));
  console.log(
    `${liveIds.size} live clients${apply ? "  [APPLY — deletions are permanent]" : "  [DRY RUN — nothing is deleted. Pass --apply to delete.]"}`,
  );

  const byDeadClient = new Map<string, Array<{ coll: string; ref: FirebaseFirestore.DocumentReference; label: string }>>();

  for (const coll of CLIENT_SCOPED_COLLECTIONS) {
    const snap = await db.collection(coll).get();
    for (const doc of snap.docs) {
      const clientId = doc.data().clientId as string | undefined;
      if (!clientId || liveIds.has(clientId)) continue;
      const label = String(doc.data().title ?? doc.data().name ?? doc.data().company ?? "").slice(0, 60);
      (byDeadClient.get(clientId) ?? byDeadClient.set(clientId, []).get(clientId)!).push({ coll, ref: doc.ref, label });
    }
  }
  for (const coll of CLIENT_DOC_COLLECTIONS) {
    const snap = await db.collection(coll).get();
    for (const doc of snap.docs) {
      // Singleton docs: the doc ID is the clientId (some also carry the field).
      const clientId = (doc.data().clientId as string | undefined) ?? doc.id;
      if (liveIds.has(clientId)) continue;
      (byDeadClient.get(clientId) ?? byDeadClient.set(clientId, []).get(clientId)!).push({ coll, ref: doc.ref, label: "(singleton)" });
    }
  }

  if (byDeadClient.size === 0) {
    console.log("No orphaned documents found — nothing to purge.");
    return;
  }

  let total = 0;
  for (const [deadId, docs] of byDeadClient) {
    console.log(`\ndead client ${deadId}: ${docs.length} orphaned docs`);
    const perColl = new Map<string, number>();
    for (const d of docs) perColl.set(d.coll, (perColl.get(d.coll) ?? 0) + 1);
    for (const [coll, n] of perColl) console.log(`  ${coll}: ${n}`);
    for (const d of docs.slice(0, 5)) console.log(`    e.g. [${d.coll}] ${d.label || d.ref.id}`);
    total += docs.length;
  }
  console.log(`\n${total} orphaned documents across ${byDeadClient.size} dead client id(s).`);

  if (!apply) {
    console.log("Dry run — nothing deleted. Re-run with --apply to purge.");
    return;
  }

  let deleted = 0;
  const all = [...byDeadClient.values()].flat();
  for (let i = 0; i < all.length; i += 400) {
    const batch = db.batch();
    for (const d of all.slice(i, i + 400)) batch.delete(d.ref);
    await batch.commit();
    deleted += Math.min(400, all.length - i);
  }
  console.log(`Purged ${deleted} orphaned documents.`);
}

// Only when invoked directly — importing this file must never open a Firestore
// connection, let alone write to one.
if (require.main === module) {
  main().then(() => process.exit(0)).catch((e) => {
    console.error(e);
    process.exit(1);
  });
}
