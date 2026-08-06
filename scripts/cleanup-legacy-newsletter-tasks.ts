/**
 * PERMANENTLY DELETE the board tasks stranded by the newsletter's move from a
 * managed task to a v2 custom agent, and repair the campaigns that referenced
 * them.
 *
 * ── WHY THEY ARE STRANDED, AND WHY DELETING IS THE FIX ────────────────────
 *
 * A `karos_managed` task carrying `metadata.productType: "newsletter_issue"`
 * also carries `completionTrigger: "product_run:newsletter_issue"`. The webhook
 * builds that trigger from the delivered payload — `product_run:${task_type}` —
 * and a v2 newsletter run is a CUSTOM run, so it composes to
 * `product_run:custom` and matches no watcher. Nothing throws; the task simply
 * sits `pending` for ever, and no future run of any kind can ever close it.
 *
 * With `newsletter_issue` gone from `MANAGED_PRODUCTS`, `resolveTaskProduct`
 * also returns null for these, so pressing Start would quietly hand them to the
 * generic in-process engine instead of the newsletter agent — a worse outcome
 * than the stall, because it produces something and calls it a newsletter.
 *
 * THERE IS NO UNDO IN FIRESTORE, so this snapshots every doc it is about to
 * remove into `_backup/<date>/` first (committed, per the integration
 * playbook's never-lose-data rule). Recovery is re-creating the doc from that
 * JSON — the id is in the file name.
 *
 * ── WHAT IT REPAIRS BESIDES THE TASK ──────────────────────────────────────
 *
 * A campaign task is the bundle's `distribution` role, and the parent
 * `campaigns` doc holds a `taskIds` array naming it. Deleting the task without
 * pruning that array leaves an id that resolves to nothing on every campaign
 * read. The DEPENDENCY direction needs no repair and deliberately gets none:
 * `unmetCampaignDependencyTitles` already ignores a `dependsOnTaskIds` entry
 * that no longer resolves ("it can never become satisfied, and would strand the
 * campaign"), and the stranded newsletter is a dependENT of the anchor, not a
 * dependency of anything.
 *
 * ── WHAT IT DELIBERATELY LEAVES ───────────────────────────────────────────
 *
 * Tasks that already REACHED a terminal or in-flight state. Only `pending` and
 * `cancelled` rows are deleted:
 *
 *   - `completed` is a delivered v1 newsletter and part of the client's record.
 *   - `review_pending` has a deliverable on the ticket awaiting a verdict —
 *     deleting it destroys work a client has not seen yet.
 *   - `in_progress` may have a v1 job still in flight whose webhook will write
 *     back to this very task id.
 *
 * Only a `pending` row is genuinely stranded, and only it is safe to remove.
 * The script prints every row it skips and why, so a survivor is never silent.
 *
 * Run: NODE_PATH=./node_modules npx tsx --env-file=.env.local \
 *        scripts/cleanup-legacy-newsletter-tasks.ts [--apply]
 * Dry run is the default. `FIRESTORE_DATABASE_ID=prep` targets prep.
 */
import { cert, getApps, initializeApp } from "firebase-admin/app";
import { getFirestore } from "firebase-admin/firestore";
import { mkdirSync, writeFileSync } from "node:fs";
import { RETIRED_NEWSLETTER_TASK_TYPE } from "../src/lib/types";

const APPLY = process.argv.includes("--apply");
const BACKUP_DIR = "_backup/2026-08-06";

/** The only states a stranded watcher can be in and still be safe to remove. */
const DELETABLE_STATUSES = new Set(["pending", "cancelled"]);

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

  // Read the whole collection and filter in memory rather than querying
  // `metadata.productType`: the field is inside an untyped map, so a
  // where-clause on it needs a composite index this project does not define,
  // and a missing index fails the script rather than returning fewer rows.
  const snap = await db.collection("clientTasks").get();
  // Imported from the type module, never re-typed here — the string is the join
  // key between the deleted product and these rows, and two spellings of it
  // would mean a cleanup that silently matches nothing.
  const candidates = snap.docs.filter(
    (d) =>
      (d.data().metadata as Record<string, unknown> | undefined)?.productType ===
      RETIRED_NEWSLETTER_TASK_TYPE,
  );

  if (candidates.length === 0) {
    console.log("No tasks carry the retired newsletter product. Nothing to do.");
  }

  const doomed = candidates.filter((d) => DELETABLE_STATUSES.has(d.data().status as string));
  const survivors = candidates.filter((d) => !DELETABLE_STATUSES.has(d.data().status as string));

  for (const doc of survivors) {
    const data = doc.data();
    console.log(
      `  KEEP   clientTasks/${doc.id}  status=${data.status}  "${data.title}"\n` +
        "         Not stranded: it holds delivered or in-flight work. Left for a human.",
    );
  }

  /** taskId → campaignId, for the second pass. */
  const campaignsToRepair = new Map<string, string[]>();

  for (const doc of doomed) {
    const data = doc.data();
    const campaignId = data.campaignId as string | undefined | null;
    console.log(
      `  DELETE clientTasks/${doc.id}  status=${data.status}  client=${data.clientId}  "${data.title}"` +
        (campaignId ? `  campaign=${campaignId}` : ""),
    );
    if (campaignId) {
      campaignsToRepair.set(campaignId, [...(campaignsToRepair.get(campaignId) ?? []), doc.id]);
    }
    if (!APPLY) continue;
    mkdirSync(BACKUP_DIR, { recursive: true });
    // THE DATABASE IS IN THE FILENAME. prep and production hold the SAME
    // document ids (prep was seeded from a production export), so without it the
    // second database's run silently clobbers the first's snapshot — a backup
    // one run can overwrite is not a backup. That cost a snapshot on
    // cleanup-legacy-agents.ts's first run; it is not repeated here.
    const dbTag = databaseId === "(default)" ? "prod" : databaseId;
    const file = `${BACKUP_DIR}/clientTasks-${doc.id}-${dbTag}-deleted.json`;
    writeFileSync(
      file,
      `${JSON.stringify({ _collection: "clientTasks", _id: doc.id, _database: databaseId, ...data }, null, 2)}\n`,
    );
    await doc.ref.delete();
    console.log(`    → deleted (snapshot: ${file})`);
  }

  // The parent campaigns. Done AFTER the deletions and in its own pass, so one
  // campaign holding two doomed tasks is written once rather than read-modify-
  // written twice — the second write of a read-modify-write pair would restore
  // the id the first removed.
  for (const [campaignId, taskIds] of campaignsToRepair) {
    const ref = db.collection("campaigns").doc(campaignId);
    const campaign = await ref.get();
    if (!campaign.exists) {
      console.log(`  CAMPAIGN ${campaignId}: already gone, nothing to prune.`);
      continue;
    }
    const existing: string[] = campaign.data()?.taskIds ?? [];
    const kept = existing.filter((id) => !taskIds.includes(id));
    if (kept.length === existing.length) {
      console.log(`  CAMPAIGN ${campaignId}: taskIds already clean.`);
      continue;
    }
    console.log(
      `  CAMPAIGN campaigns/${campaignId}: dropping ${existing.length - kept.length} task id(s)` +
        (kept.length === 0 ? " — this leaves the campaign with NO tasks; review it by hand." : ""),
    );
    if (!APPLY) continue;
    // Snapshot the campaign too. This is an UPDATE rather than a delete, but it
    // is still an irreversible edit to a doc this script did not write.
    const dbTag = databaseId === "(default)" ? "prod" : databaseId;
    const file = `${BACKUP_DIR}/campaigns-${campaignId}-${dbTag}-before-prune.json`;
    writeFileSync(
      file,
      `${JSON.stringify(
        { _collection: "campaigns", _id: campaignId, _database: databaseId, ...campaign.data() },
        null,
        2,
      )}\n`,
    );
    await ref.set({ taskIds: kept, updatedAt: Date.now() }, { merge: true });
    console.log(`    → pruned (snapshot: ${file})`);
  }

  // What SURVIVES, said out loud: a reader of this log should not have to guess
  // whether the client's delivered newsletters went with the tasks.
  console.log(
    "\n  KEPT: every ASSET and JOB these tasks produced. A delivered v1 issue is the" +
      " client's own work and their archive; it is not this script's to delete, and the" +
      " asset rows keep meta.taskType so historic surfaces still resolve them.",
  );

  console.log(
    APPLY
      ? `\nDone. ${doomed.length} task(s) deleted and ${campaignsToRepair.size} campaign(s) pruned in ${databaseId}.`
      : `\n${doomed.length} task(s) would be deleted, ${campaignsToRepair.size} campaign(s) pruned,` +
          ` ${survivors.length} left alone. Re-run with --apply.`,
  );
}

main().then(
  () => process.exit(0),
  (e) => {
    console.error(`FAILED: ${e instanceof Error ? e.message : e}`);
    process.exit(1);
  },
);
