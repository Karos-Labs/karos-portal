/**
 * PERMANENTLY DELETE the agents a newer generation replaced, and clean up the
 * grants that pointed at them.
 *
 * The rule changed on 2026-08-05 (Ben): a superseded agent is not archived, it is
 * deleted. Before that it was kept disabled "as the fallback" and merely hidden
 * from client rosters, which is why `isSupersededAgentKey` exists — that predicate
 * stays as the belt to this script's braces, for a doc that survives a run of this
 * or a key added to the predicate before its cleanup happens.
 *
 * WHAT IT DELETES: `karos-reddit-agent` and every `karos-linkedin-company-*`,
 * exactly the set `isSupersededAgentKey` names. The list is derived from that
 * predicate rather than re-typed, so the two cannot drift.
 *
 * THERE IS NO UNDO IN FIRESTORE, so this snapshots every doc it is about to
 * remove into `_backup/<date>/` first (committed, per the integration playbook's
 * never-lose-data rule). Recovery is re-creating the doc from that JSON — the id
 * is in the file name.
 *
 * IT ALSO CLEANS THE GRANTS. Each client's `customAgentIds` may name a deleted
 * agent, and a dangling id there is not harmless: `isCustomAgentGrantedToClient`
 * and every roster read it, so leaving them behind means a client carrying a grant
 * to an agent that cannot be looked up.
 *
 * WHAT IT DELIBERATELY LEAVES: the JOBS and ASSETS these agents produced. That is
 * a client's delivered work and their archive — deleting it because the producing
 * agent retired would destroy history nobody asked to lose. Those rows keep
 * `agentName`, which is what the run history joins on for historic jobs anyway
 * (`isCustomAgentGrantedToClient` falls back to the name for exactly this case).
 *
 * Run: NODE_PATH=./node_modules npx tsx --env-file=.env.local \
 *        scripts/cleanup-legacy-agents.ts [--apply]
 * Dry run is the default. `FIRESTORE_DATABASE_ID=prep` targets prep.
 */
import { cert, getApps, initializeApp } from "firebase-admin/app";
import { getFirestore } from "firebase-admin/firestore";
import { mkdirSync, writeFileSync } from "node:fs";
import { isSupersededAgentKey } from "../src/lib/custom-agent-launch";

const APPLY = process.argv.includes("--apply");
const BACKUP_DIR = "_backup/2026-08-05";

async function main() {
  const sa = JSON.parse(process.env.FIREBASE_SERVICE_ACCOUNT_KEY!);
  if (getApps().length === 0) initializeApp({ credential: cert(sa), projectId: sa.project_id });
  const databaseId = process.env.FIRESTORE_DATABASE_ID || "(default)";
  const db = getFirestore(databaseId);

  console.log(`project: ${sa.project_id} · database: ${databaseId}`);
  console.log(
    APPLY
      ? "MODE: apply — deletions are PERMANENT (snapshots are written first)\n"
      : "MODE: dry run. Nothing is deleted. Pass --apply.\n",
  );

  const snap = await db.collection("customAgents").get();
  // Derived from the predicate the UI uses, never a second hand-typed list.
  const doomed = snap.docs.filter((d) => isSupersededAgentKey(d.data().key as string));

  if (doomed.length === 0) {
    console.log("No superseded agents present. Nothing to delete.");
  }

  for (const doc of doomed) {
    const data = doc.data();
    console.log(`  DELETE customAgents/${doc.id}  key=${data.key}  name=${data.name}`);
    if (!APPLY) continue;
    mkdirSync(BACKUP_DIR, { recursive: true });
    // THE DATABASE IS IN THE FILENAME, and it is there because leaving it out
    // cost a snapshot on the first run of this script: prep and production hold
    // the SAME document ids (prep was seeded from a production export), so the
    // second database's write silently clobbered the first's. A backup that one
    // run can overwrite is not a backup.
    const dbTag = databaseId === "(default)" ? "prod" : databaseId;
    const file = `${BACKUP_DIR}/customAgents-${doc.id}-${dbTag}-deleted.json`;
    writeFileSync(
      file,
      `${JSON.stringify({ _collection: "customAgents", _id: doc.id, _database: databaseId, ...data }, null, 2)}\n`,
    );
    await doc.ref.delete();
    console.log(`    → deleted (snapshot: ${file})`);
  }

  // The grants that pointed at them. A dangling id in customAgentIds is read by
  // every roster and by isCustomAgentGrantedToClient, so it is not cosmetic.
  const doomedIds = new Set(doomed.map((d) => d.id));
  if (doomedIds.size > 0) {
    const clients = await db.collection("clients").get();
    for (const client of clients.docs) {
      const granted: string[] = client.data().customAgentIds ?? [];
      const kept = granted.filter((id) => !doomedIds.has(id));
      if (kept.length === granted.length) continue;
      const removed = granted.length - kept.length;
      console.log(
        `  GRANTS clients/${client.id} (${client.data().name}): dropping ${removed} dangling id(s)`,
      );
      if (!APPLY) continue;
      await client.ref.set({ customAgentIds: kept, updatedAt: Date.now() }, { merge: true });
      console.log("    → grants cleaned");
    }
  }

  // What SURVIVES, said out loud: a reader of this log should not have to guess
  // whether their delivered work went with the agent.
  if (doomedIds.size > 0) {
    const jobs = await db.collection("jobs").get();
    const affected = jobs.docs.filter((j) => doomedIds.has(j.data().customAgentId as string));
    console.log(
      `\n  KEPT: ${affected.length} job(s) produced by these agents, and their assets. Delivered work` +
        " and a client's archive are not this script's to delete; the rows keep agentName, which is what" +
        " historic run history joins on.",
    );
  }

  console.log(
    APPLY
      ? `\nDone. ${doomed.length} agent doc(s) deleted from ${databaseId}.`
      : `\n${doomed.length} agent doc(s) would be deleted. Re-run with --apply.`,
  );
}

main().then(
  () => process.exit(0),
  (e) => {
    console.error(`FAILED: ${e instanceof Error ? e.message : e}`);
    process.exit(1);
  },
);
