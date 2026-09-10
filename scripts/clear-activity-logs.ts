/**
 * Clears the entire clientActivityLogs collection (all clients/workspaces).
 * Requested to wipe test-era activity logs left over from before deploy.
 *
 *   npx tsx scripts/clear-activity-logs.ts            # dry run — prints the count
 *   npx tsx scripts/clear-activity-logs.ts --apply    # deletes (permanent — there is no undo)
 *
 * DRY RUN IS THE DEFAULT ON PURPOSE. The credentials in .env.local point at
 * production Firestore. Read the printed count first.
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

  const snap = await db.collection("clientActivityLogs").get();
  const refs = snap.docs.map((d) => d.ref);
  const byClient = new Map<string, number>();
  for (const doc of snap.docs) {
    const clientId = (doc.data().clientId as string | undefined) ?? "(no clientId)";
    byClient.set(clientId, (byClient.get(clientId) ?? 0) + 1);
  }

  console.log(`clientActivityLogs: ${refs.length} documents across ${byClient.size} client(s)`);
  for (const [clientId, count] of byClient) console.log(`  ${clientId}: ${count}`);

  if (!apply) {
    console.log("\nDry run — nothing deleted. Re-run with --apply to clear.");
    return;
  }

  const deleted = await batchDelete(db, refs);
  console.log(`\nCleared ${deleted} activity log documents.`);
}

main()
  .then(() => process.exit(0))
  .catch((e) => {
    console.error(e);
    process.exit(1);
  });
