/**
 * READ-ONLY diagnostic: reports every active/enabled scheduled run (both the
 * PlannedScheduledRun and legacy ScheduledRun systems) — its next fire time,
 * whether that time is still in the future or has passed without the row
 * advancing, its last-fire bookkeeping (lastRunAt/lastError/lastJobId), and
 * the resolved status of that last job — plus every Job created in the last
 * `--minutes` (default 30) so a fire can be found even if the schedule row's
 * own bookkeeping lags behind.
 *
 * Writes nothing. Same env-loading + firebase-admin init pattern as
 * scripts/import-lab-client.ts.
 *
 * Usage: npx tsx scripts/check-scheduled-runs.ts [--minutes=30]
 */

import { readFileSync } from "node:fs";
import { resolve } from "node:path";

function loadEnvFile(path: string) {
  try {
    const content = readFileSync(path, "utf-8");
    for (const line of content.split("\n")) {
      const trimmed = line.trim();
      if (!trimmed || trimmed.startsWith("#")) continue;
      const eqIdx = trimmed.indexOf("=");
      if (eqIdx === -1) continue;
      const key = trimmed.slice(0, eqIdx).trim();
      let val = trimmed.slice(eqIdx + 1).trim();
      if ((val.startsWith('"') && val.endsWith('"')) || (val.startsWith("'") && val.endsWith("'"))) {
        val = val.slice(1, -1);
      }
      if (!process.env[key]) process.env[key] = val;
    }
  } catch {
    // .env.local may not exist — credentials can come from the environment.
  }
}
loadEnvFile(resolve(process.cwd(), ".env.local"));
loadEnvFile(resolve(process.cwd(), ".env"));

import { initializeApp, getApps, cert } from "firebase-admin/app";
import { getFirestore } from "firebase-admin/firestore";

function initAdmin() {
  if (!getApps().length) {
    const raw = process.env.FIREBASE_SERVICE_ACCOUNT_KEY;
    if (raw) {
      initializeApp({ credential: cert(JSON.parse(raw)) });
    } else {
      const projectId = process.env.FIREBASE_PROJECT_ID;
      const clientEmail = process.env.FIREBASE_CLIENT_EMAIL;
      const privateKey = process.env.FIREBASE_PRIVATE_KEY?.replace(/\\n/g, "\n");
      if (!projectId || !clientEmail || !privateKey) {
        throw new Error("No Firebase credentials found in .env.local");
      }
      initializeApp({ credential: cert({ projectId, clientEmail, privateKey }) });
    }
  }
  return getFirestore();
}

const minutesArg = process.argv.find((a) => a.startsWith("--minutes="));
const WINDOW_MIN = minutesArg ? Number(minutesArg.split("=")[1]) : 30;

function fmt(at: number | null | undefined): string {
  if (at == null) return "-";
  const deltaMin = Math.round((Date.now() - at) / 60_000);
  const when = new Date(at).toLocaleString("en-US", { hour12: false });
  return `${when} (${deltaMin >= 0 ? `${deltaMin}m ago` : `in ${-deltaMin}m`})`;
}

async function main() {
  const db = initAdmin();
  const now = Date.now();
  const windowStart = now - WINDOW_MIN * 60_000;

  const [clientsSnap, plannedSnap, legacySnap, recentJobsSnap] = await Promise.all([
    db.collection("clients").get(),
    db.collection("plannedScheduledRuns").where("status", "==", "active").get(),
    db.collection("scheduledRuns").where("enabled", "==", true).get(),
    db.collection("jobs").where("createdAt", ">=", windowStart).get(),
  ]);

  const clientName = new Map(clientsSnap.docs.map((d) => [d.id, (d.data().name as string) ?? d.id]));
  const jobsById = new Map(recentJobsSnap.docs.map((d) => [d.id, d.data()]));

  const scheduledJobs = recentJobsSnap.docs.filter((d) => d.data().runType === "scheduled");
  console.log(
    `\n=== Recent jobs (last ${WINDOW_MIN}m): ${recentJobsSnap.size} total, ${scheduledJobs.length} runType="scheduled" ===`,
  );
  for (const doc of recentJobsSnap.docs.sort((a, b) => b.data().createdAt - a.data().createdAt)) {
    const j = doc.data();
    console.log(
      `  [${doc.id}] ${clientName.get(j.clientId) ?? j.clientId} · ${j.agentName} · runType=${j.runType ?? "-"} · status=${j.status} · created ${fmt(j.createdAt)}${j.error ? ` · error: ${j.error}` : ""}`,
    );
  }

  console.log(`\n=== PlannedScheduledRun (active): ${plannedSnap.size} ===`);
  for (const doc of plannedSnap.docs.sort((a, b) => a.data().nextRunAt - b.data().nextRunAt)) {
    const r = doc.data();
    const stuck = r.nextRunAt <= now;
    const lastJob = r.lastJobId ? jobsById.get(r.lastJobId) : undefined;
    console.log(
      `  [${doc.id}] ${clientName.get(r.clientId) ?? r.clientId} · ${r.agentName} (${r.cadence})` +
        `\n      createdAt: ${fmt(r.createdAt)}` +
        `\n      nextRunAt: ${fmt(r.nextRunAt)}${stuck ? "  <-- PAST DUE, cron may not have run" : ""}` +
        `\n      lastRunAt: ${fmt(r.lastRunAt)}` +
        (r.lastError ? `\n      lastError: ${r.lastError} (${fmt(r.lastErrorAt)})` : "") +
        (r.lastJobId
          ? `\n      lastJobId: ${r.lastJobId}${lastJob ? ` -> status=${lastJob.status}` : " (job not in recent window / not found)"}`
          : "\n      lastJobId: none yet"),
    );
  }

  console.log(`\n=== Legacy ScheduledRun (enabled): ${legacySnap.size} ===`);
  for (const doc of legacySnap.docs.sort((a, b) => a.data().nextRunAt - b.data().nextRunAt)) {
    const r = doc.data();
    const stuck = r.nextRunAt <= now;
    const lastJob = r.lastJobId ? jobsById.get(r.lastJobId) : undefined;
    console.log(
      `  [${doc.id}] ${clientName.get(r.clientId) ?? r.clientId} · ${r.label} (${JSON.stringify(r.cadence)})` +
        `\n      nextRunAt: ${fmt(r.nextRunAt)}${stuck ? "  <-- PAST DUE, cron may not have run" : ""}` +
        `\n      lastRunAt: ${fmt(r.lastRunAt)}` +
        (r.lastError ? `\n      lastError: ${r.lastError} (${fmt(r.lastErrorAt)})` : "") +
        (r.lastJobId
          ? `\n      lastJobId: ${r.lastJobId}${lastJob ? ` -> status=${lastJob.status}` : " (job not in recent window / not found)"}`
          : "\n      lastJobId: none yet"),
    );
  }
  console.log("");
}

main()
  .then(() => process.exit(0))
  .catch((e) => {
    console.error(e);
    process.exit(1);
  });
