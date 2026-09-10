/**
 * One-way mirror: production Firestore → prep Firestore. Production is only
 * ever read — nothing is ever written back to it. Prep is overwritten to
 * match production exactly: every production doc is copied over (full
 * overwrite, not merge), and any doc that exists in prep but not in
 * production is DELETED from prep. That's what "sync prep with production"
 * means here — a real mirror, not an additive copy.
 *
 * Same Firebase project, two named Firestore databases (see
 * DEPLOY_ENVIRONMENTS.md): production = "(default)", prep = "prep". Both are
 * reachable with the same FIREBASE_SERVICE_ACCOUNT_KEY — no cross-project
 * credentials needed. Collections are discovered dynamically via
 * listCollections() on production, so this never goes stale as new
 * collections are added (mirrors the pattern in audit-production-trash.ts /
 * purge-orphaned-client-docs.ts, which hardcode a list for a narrower
 * purpose — this script's job is "copy everything").
 *
 * ⚠️ Known gotcha (documented in DEPLOY_ENVIRONMENTS.md): prep sometimes
 * carries deliberately-different values from production on purpose — e.g.
 * enable-linkedin-v2-prep.ts flips `customAgents` docs to enabled:true only
 * in prep for local testing. A full sync overwrites that divergence back to
 * production's values. Use --exclude=customAgents (or whatever collection
 * you've hand-tuned in prep) if you need to preserve it across a sync.
 *
 * ⚠️ Also per DEPLOY_ENVIRONMENTS.md: a client's "Daily email" flag rides
 * along with everything else. Prep should keep that off — check
 * clients/clientSettings after a sync if you're going to exercise prep at all.
 *
 * Run (dry run first — this is destructive to prep):
 *   npx tsx --env-file=.env.local scripts/sync-prep-from-production.ts
 *   npx tsx --env-file=.env.local scripts/sync-prep-from-production.ts --apply
 *   npx tsx --env-file=.env.local scripts/sync-prep-from-production.ts --apply --only=clients,jobs,assets
 *   npx tsx --env-file=.env.local scripts/sync-prep-from-production.ts --apply --exclude=customAgents
 *   npx tsx --env-file=.env.local scripts/sync-prep-from-production.ts --apply --no-delete   # copy/overwrite only, never delete stale prep docs
 */

import { cert, getApps, initializeApp } from "firebase-admin/app";
import { getFirestore, type Firestore, type QueryDocumentSnapshot } from "firebase-admin/firestore";

const APPLY = process.argv.includes("--apply");
const NO_DELETE = process.argv.includes("--no-delete");

function listArg(flag: string): string[] | null {
  const arg = process.argv.find((a) => a.startsWith(`${flag}=`));
  if (!arg) return null;
  return arg
    .slice(flag.length + 1)
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);
}
const ONLY = listArg("--only");
const EXCLUDE = new Set(listArg("--exclude") ?? []);

const BATCH_SIZE = 400; // Firestore batch write limit is 500 ops — leave headroom.

async function writeAll(db: Firestore, collectionName: string, docs: QueryDocumentSnapshot[]) {
  let written = 0;
  for (let i = 0; i < docs.length; i += BATCH_SIZE) {
    const chunk = docs.slice(i, i + BATCH_SIZE);
    const batch = db.batch();
    for (const doc of chunk) batch.set(db.collection(collectionName).doc(doc.id), doc.data());
    await batch.commit();
    written += chunk.length;
  }
  return written;
}

async function deleteAll(db: Firestore, docs: QueryDocumentSnapshot[]) {
  let deleted = 0;
  for (let i = 0; i < docs.length; i += BATCH_SIZE) {
    const chunk = docs.slice(i, i + BATCH_SIZE);
    const batch = db.batch();
    for (const doc of chunk) batch.delete(doc.ref);
    await batch.commit();
    deleted += chunk.length;
  }
  return deleted;
}

async function main() {
  const raw = process.env.FIREBASE_SERVICE_ACCOUNT_KEY;
  if (!raw) throw new Error("FIREBASE_SERVICE_ACCOUNT_KEY not set — run with --env-file=.env.local");
  const sa = JSON.parse(raw);

  if (!getApps().length) initializeApp({ credential: cert(sa) });
  const app = getApps()[0]!;

  const prodDb = getFirestore(app, "(default)");
  const prepDb = getFirestore(app, "prep");
  for (const db of [prodDb, prepDb]) {
    try {
      db.settings({ ignoreUndefinedProperties: true });
    } catch {
      // Already configured by the other reference to the same singleton — fine.
    }
  }

  console.log(`project: ${sa.project_id}`);
  console.log(`source:  production ("(default)")  [read-only]`);
  console.log(`target:  prep ("prep")  [${APPLY ? "WILL BE OVERWRITTEN" : "dry run — nothing written"}]`);
  console.log(APPLY ? "MODE: apply\n" : "MODE: dry run (pass --apply to write)\n");

  const discovered = (await prodDb.listCollections()).map((c) => c.id).sort();
  const names = (ONLY ?? discovered).filter((n) => !EXCLUDE.has(n));

  if (ONLY) console.log(`--only: syncing ${names.length} of ${discovered.length} discovered collection(s)`);
  if (EXCLUDE.size) console.log(`--exclude: skipping ${[...EXCLUDE].join(", ")}`);
  console.log(`${names.length} collection(s): ${names.join(", ")}\n`);

  let totalWritten = 0;
  let totalDeleted = 0;

  for (const name of names) {
    const [prodSnap, prepSnap] = await Promise.all([
      prodDb.collection(name).get(),
      prepDb.collection(name).get(),
    ]);

    const prodIds = new Set(prodSnap.docs.map((d) => d.id));
    const staleInPrep = prepSnap.docs.filter((d) => !prodIds.has(d.id));

    console.log(
      `${name}: ${prodSnap.size} in production, ${prepSnap.size} in prep` +
        (staleInPrep.length ? `, ${staleInPrep.length} stale in prep${NO_DELETE ? " (kept, --no-delete)" : " (will delete)"}` : ""),
    );

    if (prodSnap.size === 0 && staleInPrep.length === 0) continue;
    if (!APPLY) continue;

    totalWritten += await writeAll(prepDb, name, prodSnap.docs);
    if (!NO_DELETE && staleInPrep.length) {
      totalDeleted += await deleteAll(prepDb, staleInPrep);
    }
  }

  console.log();
  if (APPLY) {
    console.log(`Done. ${totalWritten} doc(s) written, ${totalDeleted} stale doc(s) deleted from prep.`);
  } else {
    console.log(`Dry run only — pass --apply to actually write to prep.`);
  }
}

main().then(
  () => process.exit(0),
  (e) => {
    console.error(`FAILED: ${e instanceof Error ? e.message : e}`);
    process.exit(1);
  },
);
