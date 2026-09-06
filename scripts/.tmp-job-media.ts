/* READ-ONLY diagnostic: what media does job <id> claim, and what did the engine run record? */
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { initializeApp, cert, getApps, type App } from "firebase-admin/app";
import { getScriptFirestore, resolveScriptDatabaseId } from "./lib/firestore-db";

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
      if (process.env[k] === undefined) process.env[k] = v;
    }
  } catch {}
}
loadEnvFile(resolve(process.cwd(), "..", "karosCMO", ".env.local"));

function initAdmin(): App {
  const existing = getApps()[0];
  if (existing) return existing;
  const raw = process.env.FIREBASE_SERVICE_ACCOUNT_KEY;
  if (!raw) throw new Error("no FIREBASE_SERVICE_ACCOUNT_KEY in ../karosCMO/.env.local");
  return initializeApp({ credential: cert(JSON.parse(raw)) });
}

const JOB_ID = process.argv[2] ?? "eIruxfiBhYTFHgfXKWK5";
const trunc = (v: unknown, n = 400) => {
  const s = typeof v === "string" ? v : JSON.stringify(v);
  return s && s.length > n ? s.slice(0, n) + "…" : s;
};

async function main() {
  console.log(`database: ${resolveScriptDatabaseId()}`);
  const db = getScriptFirestore(initAdmin());
  const job = await db.collection("jobs").doc(JOB_ID).get();
  if (!job.exists) { console.log("job not found"); return; }
  const j = job.data()!;
  const keys = Object.keys(j).sort();
  console.log("\n=== JOB", JOB_ID, "keys:", keys.join(", "));
  for (const k of ["clientId", "agentKey", "agentName", "productId", "status", "createdAt", "updatedAt", "assetIds", "engineRunId", "runId", "agentEngineRunId", "briefValues", "input", "mediaAssets", "attachments", "error", "result", "deliverable", "meta"]) {
    if (j[k] !== undefined) console.log(`  ${k}:`, trunc(j[k], 900));
  }
  // any key mentioning media
  for (const k of keys) if (/media|attach|image|asset/i.test(k) && !["assetIds", "mediaAssets", "attachments"].includes(k)) console.log(`  ${k}:`, trunc(j[k], 600));

  const assetIds: string[] = Array.isArray(j.assetIds) ? j.assetIds : [];
  const assetsSnap = assetIds.length > 0 ? await Promise.all(assetIds.map((id) => db.collection("assets").doc(id).get())) : (await db.collection("assets").where("jobId", "==", JOB_ID).get()).docs;
  console.log(`\n=== ASSETS (${assetsSnap.length})`);
  for (const a of assetsSnap) {
    if (!a.exists) { console.log("  missing asset", a.id); continue; }
    const d = a.data()!;
    console.log(`  -- asset ${a.id}: type=${d.type} status=${d.status} title=${trunc(d.title, 80)}`);
    for (const k of ["imageUrl", "videoUrl", "mediaUrl", "mediaUrls", "attachments", "channels"]) if (d[k] !== undefined) console.log(`     ${k}:`, trunc(d[k], 300));
    if (d.meta) console.log("     meta:", trunc(d.meta, 1200));
    console.log("     content head:", trunc(d.content, 500));
  }

  const runId: string | undefined = j.engineRunId ?? j.agentEngineRunId ?? j.runId ?? (j.engine && j.engine.runId);
  if (runId) {
    const run = await db.collection("agentEngineRuns").doc(runId).get();
    console.log(`\n=== ENGINE RUN ${runId} exists=${run.exists}`);
    if (run.exists) {
      const r = run.data()!;
      console.log("  status:", r.status, "productId:", r.productId, "clientSlug:", r.clientSlug);
      console.log("  input:", trunc(r.input, 800));
      console.log("  output:", trunc(r.output, 800));
      const steps = await db.collection("agentEngineRuns").doc(runId).collection("steps").get();
      console.log(`  steps (${steps.size}):`, steps.docs.map((s) => s.id).sort().join(", "));
      for (const s of steps.docs) {
        if (/media|deliver|attach|render|draft|review|gate/i.test(s.id)) {
          const d = s.data();
          console.log(`  -- ${s.id} [${d.status}]`, trunc(d.output ?? d.result ?? d.payload ?? d, 1500));
        }
      }
    }
  } else {
    console.log("\n(no engine run id on the job)");
  }
}
main().catch((e) => { console.error(e); process.exit(1); });
