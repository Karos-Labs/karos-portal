/**
 * Skip the Task Map proposals that target a channel no agent of the client's
 * posts to, the way the calendar's own Skip does (deleteTaskAction → a hard
 * delete of the `clientTasks` row).
 *
 * WHY (Albert, 2026-09-11): "we are not doing YouTube agents. why is it
 * there." The copilot used to propose content for every CONNECTED channel,
 * YouTube included, and lib/served-platforms.ts now stops that at every
 * writer and hides such a proposal from the calendar. What it cannot do is
 * remove the rows already written, which still count on Home and still sit
 * in the task board — this does, once, and only for `pending` copilot rows:
 * anything approved or in flight is somebody's decision and is left alone.
 *
 * THERE IS NO UNDO IN FIRESTORE, so every deleted row is snapshotted to
 * `_backup/<date>/` first, database in the file name (prep and production
 * share document ids).
 *
 * Run: NODE_PATH=./node_modules npx tsx --env-file=.env.local \
 *        scripts/skip-unserved-platform-suggestions.ts [--apply]
 * Dry run is the default. `FIRESTORE_DATABASE_ID=prep` targets prep.
 */
import { cert, getApps, initializeApp } from "firebase-admin/app";
import { getFirestore } from "firebase-admin/firestore";
import { mkdirSync, writeFileSync } from "node:fs";
import { isServedPlatform, servedPlatformKeys } from "../src/lib/served-platforms";

const APPLY = process.argv.includes("--apply");
const BACKUP_DIR = "_backup/2026-09-11";

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

  const [tasksSnap, clientsSnap, agentsSnap] = await Promise.all([
    db.collection("clientTasks").where("source", "==", "copilot").where("status", "==", "pending").get(),
    db.collection("clients").get(),
    db.collection("customAgents").get(),
  ]);
  const agents = agentsSnap.docs.map((d) => ({ id: d.id, ...(d.data() as { key: string; name: string; enabled?: boolean }) }));
  const clientById = new Map(clientsSnap.docs.map((d) => [d.id, d.data() as { name?: string; customAgentIds?: string[] }]));

  // The same answer the calendar computes for the client: that client's
  // granted, enabled agents plus the managed products.
  const servedFor = (clientId: string) => {
    const granted = new Set(clientById.get(clientId)?.customAgentIds ?? []);
    return servedPlatformKeys(agents.filter((a) => a.enabled !== false && granted.has(a.id)));
  };

  const doomed = tasksSnap.docs.filter((d) => {
    const t = d.data();
    const platform = (t.metadata as Record<string, unknown> | undefined)?.platform as string | undefined;
    return t.owner === "karos_managed" && !isServedPlatform(platform, servedFor(t.clientId as string));
  });

  if (doomed.length === 0) console.log("No pending proposal targets a channel nobody posts to. Nothing to do.");

  for (const doc of doomed) {
    const t = doc.data();
    const platform = (t.metadata as Record<string, unknown> | undefined)?.platform;
    console.log(
      `  SKIP clientTasks/${doc.id}  client=${clientById.get(t.clientId as string)?.name ?? t.clientId}  platform=${String(platform)}  "${t.title}"`,
    );
    if (!APPLY) continue;
    mkdirSync(BACKUP_DIR, { recursive: true });
    const dbTag = databaseId === "(default)" ? "prod" : databaseId;
    writeFileSync(`${BACKUP_DIR}/clientTasks-${doc.id}-${dbTag}-deleted.json`, JSON.stringify({ id: doc.id, ...t }, null, 2));
    await doc.ref.delete();
  }

  console.log(`\n${doomed.length} proposal${doomed.length === 1 ? "" : "s"} ${APPLY ? "deleted" : "would be deleted"}. Re-run with --apply to delete.`);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
