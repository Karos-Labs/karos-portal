/**
 * PERMANENTLY DELETE the `customAgents` docs for the 5 keys retired in full by
 * SCRUM-377/T-B25a (2026-08-29) — no engine equivalent was ever planned, and
 * product ruled every one of them fully gone rather than left dormant:
 *
 *   - karos-carousel-runner
 *   - karos-carousel-setup
 *   - karos-carousel-manager
 *   - karos-linkedin-manager-v2
 *   - karos-reputation-manager
 *
 * WHY THIS SCRIPT EXISTS SEPARATELY FROM `cleanup-legacy-agents.ts`: that
 * script derives its doomed set from `isSupersededAgentKey`, which is a
 * DIFFERENT retirement mechanism (a v1→v2 migration where the old key stays
 * importable as a rollback fallback). These five have no such fallback role —
 * `isSupersededAgentKey` correctly returns false for all of them — so a
 * hand-typed list is the honest way to name this specific, one-time cleanup.
 *
 * WHAT THIS REPO'S SANDBOX COULD NOT DO: confirm from code alone whether any
 * of these 5 keys still has a live `customAgents` doc, or whether any client's
 * `customAgentIds` still names one. `FIREBASE_SERVICE_ACCOUNT_KEY` is not set
 * in the environment this migration was authored in, so this script has never
 * been run — read it as the query to run, not as a run that already happened.
 *
 * WHAT IT DELETES: any `customAgents` doc whose `key` is one of the five above.
 * THERE IS NO UNDO IN FIRESTORE, so this snapshots every doc it is about to
 * remove into `_backup/<date>/` first, per the integration playbook's
 * never-lose-data rule. Recovery is re-creating the doc from that JSON — the
 * id is in the file name. Reintroducing the KEY, though, is explicitly against
 * the product decision this migration implements — see the retirement comments
 * next to each key's old definition in `src/lib/custom-agent-launch.ts`.
 *
 * IT ALSO CLEANS THE GRANTS. Each client's `customAgentIds` may name a deleted
 * agent, and a dangling id there is not harmless: `isCustomAgentGrantedToClient`
 * and every roster read it, so leaving them behind means a client carrying a
 * grant to an agent that cannot be looked up.
 *
 * WHAT IT DELIBERATELY LEAVES: the JOBS and ASSETS these agents produced (a
 * client's delivered work and their archive), and the `carouselAgentState`,
 * `reputationAgentState` rows the retired skills wrote — the collection
 * accessors for those stay in `src/lib/data.ts` specifically so
 * `deleteClientCascade` still sweeps them if a *client* is ever deleted; this
 * script does not touch state rows on its own.
 *
 * Run (READ-ONLY REPORT, no writes — this is the check the ticket asked for):
 *   NODE_PATH=./node_modules npx tsx --env-file=.env.local \
 *     scripts/cleanup-retired-legacy-agents-scrum-377.ts
 *
 * Run for real, once the report above has been read:
 *   NODE_PATH=./node_modules npx tsx --env-file=.env.local \
 *     scripts/cleanup-retired-legacy-agents-scrum-377.ts --apply
 *
 * `FIRESTORE_DATABASE_ID=prep` targets prep instead of production — run it
 * against BOTH databases; a doc registered only in prep during piloting is
 * exactly the shape these five are believed to be in (see the ticket's
 * clientDataCheck note), but "believed" is not "verified", which is the whole
 * reason this script exists.
 */
import { cert, getApps, initializeApp } from "firebase-admin/app";
import { getFirestore } from "firebase-admin/firestore";
import { mkdirSync, writeFileSync } from "node:fs";

const APPLY = process.argv.includes("--apply");
const BACKUP_DIR = "_backup/2026-08-29";

const RETIRED_KEYS = new Set([
  "karos-carousel-runner",
  "karos-carousel-setup",
  "karos-carousel-manager",
  "karos-linkedin-manager-v2",
  "karos-reputation-manager",
]);

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
  const doomed = snap.docs.filter((d) => RETIRED_KEYS.has(d.data().key as string));

  if (doomed.length === 0) {
    console.log("No customAgents doc for any of the 5 retired SCRUM-377 keys. Nothing to delete.");
  }

  for (const doc of doomed) {
    const data = doc.data();
    console.log(
      `  DELETE customAgents/${doc.id}  key=${data.key}  name=${data.name}  enabled=${data.enabled}`,
    );
    if (!APPLY) continue;
    mkdirSync(BACKUP_DIR, { recursive: true });
    // THE DATABASE IS IN THE FILENAME: prep and production can hold the same
    // document ids, so leaving it out risks one database's write clobbering
    // the other's snapshot.
    const dbTag = databaseId === "(default)" ? "prod" : databaseId;
    const file = `${BACKUP_DIR}/customAgents-${doc.id}-${dbTag}-deleted.json`;
    writeFileSync(
      file,
      `${JSON.stringify({ _collection: "customAgents", _id: doc.id, _database: databaseId, ...data }, null, 2)}\n`,
    );
    await doc.ref.delete();
    console.log(`    → deleted (snapshot: ${file})`);
  }

  // The grants that pointed at them, checked and reported REGARDLESS of
  // whether a customAgents doc still exists for that id — a client can hold a
  // dangling id even after the doc above is long gone.
  const doomedIds = new Set(doomed.map((d) => d.id));
  const clients = await db.collection("clients").get();
  let clientsWithGrants = 0;
  for (const client of clients.docs) {
    const granted: string[] = client.data().customAgentIds ?? [];
    const staleHere = granted.filter((id) => doomedIds.has(id));
    if (staleHere.length === 0) continue;
    clientsWithGrants++;
    console.log(
      `  GRANTS clients/${client.id} (${client.data().name}): ${staleHere.length} grant(s) reference a retired agent`,
    );
    if (!APPLY) continue;
    const kept = granted.filter((id) => !doomedIds.has(id));
    await client.ref.set({ customAgentIds: kept, updatedAt: Date.now() }, { merge: true });
    console.log("    → grants cleaned");
  }
  if (doomed.length > 0 && clientsWithGrants === 0) {
    console.log("  GRANTS: no client currently references any of the deleted doc ids.");
  }

  console.log(
    APPLY
      ? `\nDone. ${doomed.length} agent doc(s) deleted from ${databaseId}, ${clientsWithGrants} client(s)' grants cleaned.`
      : `\n${doomed.length} agent doc(s) and ${clientsWithGrants} client grant row(s) would change. Re-run with --apply.`,
  );
}

main().then(
  () => process.exit(0),
  (e) => {
    console.error(`FAILED: ${e instanceof Error ? e.message : e}`);
    process.exit(1);
  },
);
