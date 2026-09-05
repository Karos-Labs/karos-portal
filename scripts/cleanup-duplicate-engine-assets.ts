/**
 * Find (and, only when told to, delete) the duplicate assets one agent-engine
 * run minted more than once — the "same post 3 or 6 times" the client saw on
 * /assets on 2026-09-04.
 *
 * WHERE THEY CAME FROM. `materializeAgentEngineDeliverable` guarded against a
 * second materialization only by checking the job SNAPSHOT it was handed for
 * `assetIds.length > 0`. Every render of the Job page deferred a sync holding
 * that render's snapshot, and the page refreshed every 4 s around completion —
 * so N renders during one materialization all saw `[]`, all created an asset
 * under a random id, and each overwrote `job.assetIds` with "[] plus mine".
 * The job kept ONE id; the rest are orphans that still show on /assets. The
 * write path is fixed (deterministic `agent-engine-<runId>` id + arrayUnion);
 * this cleans up what it already wrote.
 *
 * GROUPING RULE — one group per (jobId, meta.agentEngineRunId): the run id is
 * the true identity of a deliverable, so two assets sharing it ARE one post.
 * Titles are NOT compared (the titler is an LLM call, so copies of one post
 * legitimately carry different titles).
 *
 * SURVIVOR — the copy `job.assetIds` already references, else the earliest
 * created. If the job references none of them, the survivor is attached
 * (arrayUnion) so the Job page shows its deliverable again.
 *
 * ONLY DRAFTS ARE EVER DELETED. A copy that was approved, scheduled, delivered
 * or published is a decision somebody made; it is reported and left alone.
 *
 *   FIRESTORE_DATABASE_ID=prep npx tsx scripts/cleanup-duplicate-engine-assets.ts            # dry run
 *   FIRESTORE_DATABASE_ID=prep npx tsx scripts/cleanup-duplicate-engine-assets.ts --apply    # delete
 *
 * Dry run is the default. The database must be named out loud
 * (scripts/lib/firestore-db.ts refuses otherwise) because unset used to mean production.
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
    // .env.local may not exist — credentials can come from the environment.
  }
}
loadEnvFile(resolve(process.cwd(), ".env.local"));
loadEnvFile(resolve(process.cwd(), ".env"));

import { initializeApp, cert, getApps, applicationDefault, type App } from "firebase-admin/app";
import { FieldValue } from "firebase-admin/firestore";
import { getScriptFirestore, resolveScriptDatabaseId } from "./lib/firestore-db";

function initAdmin(): App {
  const existing = getApps()[0];
  if (existing) return existing;
  const raw = process.env.FIREBASE_SERVICE_ACCOUNT_KEY;
  if (raw) return initializeApp({ credential: cert(JSON.parse(raw)) });
  const projectId = process.env.FIREBASE_PROJECT_ID;
  if (!projectId) throw new Error("Set FIREBASE_SERVICE_ACCOUNT_KEY or FIREBASE_PROJECT_ID.");
  return initializeApp({ credential: applicationDefault(), projectId });
}

const iso = (ms?: number) => (typeof ms === "number" ? new Date(ms).toISOString().slice(0, 19) : "—");

interface Row {
  id: string;
  clientId: string;
  jobId: string;
  runId: string;
  status: string;
  title: string;
  createdAt: number;
  ref: FirebaseFirestore.DocumentReference;
}

async function main() {
  const apply = process.argv.includes("--apply");
  const dbId = resolveScriptDatabaseId();
  const db = getScriptFirestore(initAdmin());
  console.log(`database: ${dbId}   mode: ${apply ? "APPLY — deleting draft duplicates" : "DRY RUN — nothing is written"}\n`);

  const snap = await db.collection("assets").where("agentId", "==", "agent-engine").get();
  const rows: Row[] = [];
  for (const d of snap.docs) {
    const a = d.data();
    const runId = a.meta?.agentEngineRunId;
    if (typeof a.jobId !== "string" || typeof runId !== "string") continue;
    rows.push({ id: d.id, clientId: String(a.clientId ?? ""), jobId: a.jobId, runId, status: String(a.status ?? ""), title: String(a.title ?? ""), createdAt: Number(a.createdAt ?? 0), ref: d.ref });
  }
  const groups = new Map<string, Row[]>();
  for (const r of rows) {
    const k = `${r.jobId}::${r.runId}`;
    (groups.get(k) ?? groups.set(k, []).get(k)!).push(r);
  }
  const dups = [...groups.values()].filter((g) => g.length > 1).sort((a, b) => b.length - a.length);
  console.log(`agent-engine assets: ${rows.length} · runs materialized more than once: ${dups.length}\n`);

  const toDelete: Row[] = [];
  const toAttach: Array<{ jobId: string; assetId: string }> = [];
  const kept: Row[] = [];
  for (const g of dups) {
    g.sort((a, b) => a.createdAt - b.createdAt);
    const jobSnap = await db.collection("jobs").doc(g[0]!.jobId).get();
    const jobAssetIds: string[] = Array.isArray(jobSnap.data()?.assetIds) ? jobSnap.data()!.assetIds : [];
    const survivor = g.find((r) => jobAssetIds.includes(r.id)) ?? g.find((r) => r.status !== "draft") ?? g[0]!;
    console.log(`job ${g[0]!.jobId}  run ${g[0]!.runId}  client ${g[0]!.clientId}  job ${jobSnap.exists ? "exists" : "MISSING"}  x${g.length}`);
    for (const r of g) {
      const isSurvivor = r.id === survivor.id;
      const verdict = isSurvivor ? "KEEP" : r.status === "draft" ? "drop" : "keep (not a draft)";
      console.log(`   ${verdict.padEnd(18)} ${r.id}  ${iso(r.createdAt)}  ${r.status.padEnd(9)} "${r.title.slice(0, 50)}"`);
      if (isSurvivor) kept.push(r);
      else if (r.status === "draft") toDelete.push(r);
    }
    if (jobSnap.exists && !jobAssetIds.includes(survivor.id)) {
      console.log(`   attach survivor ${survivor.id} to job (job.assetIds currently ${JSON.stringify(jobAssetIds)})`);
      toAttach.push({ jobId: survivor.jobId, assetId: survivor.id });
    }
    console.log();
  }

  console.log(`${dups.length} group(s) · ${kept.length} kept · ${toDelete.length} draft duplicate(s) to delete · ${toAttach.length} survivor(s) to attach`);
  if (!apply) {
    console.log("Dry run — nothing changed. Re-run with --apply to delete.");
    return;
  }
  for (let i = 0; i < toDelete.length; i += 400) {
    const batch = db.batch();
    for (const r of toDelete.slice(i, i + 400)) batch.delete(r.ref);
    await batch.commit();
  }
  for (const { jobId, assetId } of toAttach) {
    await db.collection("jobs").doc(jobId).set({ assetIds: FieldValue.arrayUnion(assetId), updatedAt: Date.now() }, { merge: true });
  }
  console.log(`Deleted ${toDelete.length} document(s); attached ${toAttach.length} survivor(s).`);
}

if (require.main === module) {
  main()
    .then(() => process.exit(0))
    .catch((e) => {
      console.error(e);
      process.exit(1);
    });
}
