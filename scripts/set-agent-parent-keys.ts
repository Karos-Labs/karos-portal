/**
 * Set `CustomAgent.parentKey` on the agents that are STEPS of another agent.
 *
 * This is the data half of the structural sub-agent change. Before it, the only
 * thing expressing "the LinkedIn setup belongs to the LinkedIn agent" was a
 * hardcoded list of keys in `custom-agent-launch.ts`; after it, the relationship
 * is on the document and `isSubAgent` reads it — so the next agent that grows a
 * step needs a field, not a code change.
 *
 * Idempotent: a doc whose parentKey already matches is left alone. A doc whose
 * parentKey is DIFFERENT is snapshotted to _backup/ and then corrected, because
 * the alternative is a silent overwrite of somebody's deliberate edit.
 *
 * Refuses to name a parent that does not exist in the same database. An
 * unresolvable parentKey makes the agent an ORPHAN — the library shows it with a
 * "Step with no parent" badge rather than dropping it, but a typo written here
 * would be the usual way that state gets created, so it fails instead.
 *
 * Run: NODE_PATH=./node_modules npx tsx --env-file=.env.local \
 *        scripts/set-agent-parent-keys.ts [--apply]
 * `FIRESTORE_DATABASE_ID=prep` targets prep instead of production.
 */
import { cert, getApps, initializeApp } from "firebase-admin/app";
import { getFirestore } from "firebase-admin/firestore";
import { mkdirSync, writeFileSync } from "node:fs";

const APPLY = process.argv.includes("--apply");
const BACKUP_DIR = "_backup/2026-08-05";

/** Each step, and the agent whose surface fires it. */
const PARENT_BY_KEY: Record<string, string> = {
  "karos-linkedin-setup-v2": "karos-linkedin-writer-v2",
  "karos-linkedin-manager-v2": "karos-linkedin-writer-v2",
};

async function main() {
  const sa = JSON.parse(process.env.FIREBASE_SERVICE_ACCOUNT_KEY!);
  if (getApps().length === 0) initializeApp({ credential: cert(sa), projectId: sa.project_id });
  const databaseId = process.env.FIRESTORE_DATABASE_ID || "(default)";
  const db = getFirestore(databaseId);

  console.log(`project: ${sa.project_id} · database: ${databaseId}`);
  console.log(APPLY ? "MODE: apply\n" : "MODE: dry run (pass --apply to write)\n");

  const snap = await db.collection("customAgents").get();
  const byKey = new Map(snap.docs.map((d) => [d.data().key as string, d]));

  let changed = 0;
  for (const [key, parentKey] of Object.entries(PARENT_BY_KEY)) {
    const doc = byKey.get(key);
    if (!doc) {
      console.log(`  ${key}: ABSENT from ${databaseId} — nothing to do`);
      continue;
    }
    if (!byKey.has(parentKey)) {
      throw new Error(
        `${key} would name parent "${parentKey}", which does not exist in ${databaseId}. ` +
          "That would create an orphaned step; register the parent first.",
      );
    }
    const current = (doc.data().parentKey ?? null) as string | null;
    if (current === parentKey) {
      console.log(`  ${key}: already → ${parentKey}`);
      continue;
    }
    console.log(`  ${key}: ${current ?? "(none)"} → ${parentKey}`);
    changed++;
    if (!APPLY) continue;
    if (current) {
      // Only a doc that already carried a DIFFERENT value is snapshotted: there
      // is a prior state to lose. Writing the field for the first time cannot
      // destroy anything, and the undo is `parentKey: null`.
      mkdirSync(BACKUP_DIR, { recursive: true });
      writeFileSync(
        `${BACKUP_DIR}/customAgents-${doc.id}-pre-parentkey.json`,
        `${JSON.stringify({ _collection: "customAgents", _id: doc.id, ...doc.data() }, null, 2)}\n`,
      );
    }
    await doc.ref.set({ parentKey, updatedAt: Date.now() }, { merge: true });
  }

  console.log(
    changed === 0
      ? "\nNothing to change."
      : `\n${changed} doc(s) ${APPLY ? "updated" : "would change"}. Undo = set parentKey to null.`,
  );
}

main().then(
  () => process.exit(0),
  (e) => {
    console.error(`FAILED: ${e instanceof Error ? e.message : e}`);
    process.exit(1);
  },
);
