/**
 * One-off kill: remove the UNPUBLISHED legacy study-spot calendar slots for
 * Sitti (Albert, 2026-08-05: "yes kill these"). These are the 14 posts imported
 * 2026-07-24 from the pre-pivot lab runs; the product pivoted (creator maps,
 * "places people gatekeep" direction) and the unpublished tail is superseded by
 * the 2026-08-05 runway.
 *
 * Scope: assets whose meta.labRun starts with "instagram-agent/2026-07-24"
 * (covers 2026-07-24-rerender-v2 + 2026-07-24-batch-01), clientId = sitti,
 * status !== "published". Published slots are never touched.
 *
 * Convention mirrored from cleanup-stale-pitch-drafts.ts: the app has no
 * archived/hidden asset status, so removal = Firestore doc delete, with a FULL
 * backup of every deleted doc written to scripts/backups/ first (reversible).
 * Storage objects under lab-imports/ are left in place on purpose: the media
 * also lives in the lab repo and a re-import recreates everything.
 *
 * CLI
 *   npx tsx scripts/kill-sitti-legacy-slots.ts            # DRY RUN (default)
 *   npx tsx scripts/kill-sitti-legacy-slots.ts --apply    # backup + delete
 */

import { readFileSync, existsSync, mkdirSync, writeFileSync } from "fs";
import { resolve, dirname } from "path";

const argv = process.argv.slice(2);
const APPLY = argv.includes("--apply");

/* ── load .env.local (same pattern as import-sitti-calendar.ts) ───────────── */
function loadEnvFile(path: string) {
  try {
    const content = readFileSync(path, "utf-8");
    const lines = content.split("\n");
    for (let i = 0; i < lines.length; i++) {
      const trimmed = lines[i].trim();
      if (!trimmed || trimmed.startsWith("#")) continue;
      const eqIdx = trimmed.indexOf("=");
      if (eqIdx === -1) continue;
      const key = trimmed.slice(0, eqIdx).trim();
      let val = trimmed.slice(eqIdx + 1).trim();
      const quote = val[0] === '"' || val[0] === "'" ? val[0] : "";
      if (quote) {
        while (!(val.length > 1 && val.endsWith(quote)) && i < lines.length - 1) val += "\n" + lines[++i];
        val = val.slice(1, val.endsWith(quote) ? -1 : undefined);
      }
      if (!process.env[key]) process.env[key] = val;
    }
  } catch {
    /* missing file is fine */
  }
}
(function findAndLoadEnv() {
  let dir = process.cwd();
  for (let i = 0; i < 6; i++) {
    const candidate = resolve(dir, ".env.local");
    if (existsSync(candidate)) {
      loadEnvFile(candidate);
      break;
    }
    const parent = dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  loadEnvFile(resolve(process.cwd(), ".env"));
})();

import { initializeApp, getApps, cert } from "firebase-admin/app";
import { getFirestore } from "firebase-admin/firestore";

function initAdmin() {
  if (getApps().length) return;
  let raw = process.env.FIREBASE_SERVICE_ACCOUNT_KEY;
  if (raw && ((raw.startsWith("'") && raw.endsWith("'")) || (raw.startsWith('"') && raw.endsWith('"')))) {
    raw = raw.slice(1, -1);
  }
  if (raw) {
    initializeApp({ credential: cert(JSON.parse(raw)) });
    return;
  }
  const projectId = process.env.FIREBASE_PROJECT_ID;
  const clientEmail = process.env.FIREBASE_CLIENT_EMAIL;
  const privateKey = process.env.FIREBASE_PRIVATE_KEY?.replace(/\\n/g, "\n");
  if (projectId && clientEmail && privateKey) {
    initializeApp({ credential: cert({ projectId, clientEmail, privateKey }) });
    return;
  }
  throw new Error("No Firebase credentials found in .env.local");
}
initAdmin();
const db = getFirestore();

const LAB_RUN_PREFIX = "instagram-agent/2026-07-24";

async function main() {
  console.log(`kill-sitti-legacy-slots ${APPLY ? "APPLY" : "DRY RUN"}\n`);

  // resolve the sitti client (read-only variant of the importer's resolver)
  const clientsSnap = await db.collection("clients").get();
  let clientId: string | null = null;
  for (const d of clientsSnap.docs) {
    const c = d.data() as { name?: string; agentsRepoSlug?: string };
    if (c.agentsRepoSlug === "sitti" || /\bsitti\b/i.test(c.name ?? "")) {
      clientId = d.id;
      break;
    }
  }
  if (!clientId) throw new Error("No sitti client found; nothing to kill.");
  console.log(`Client: ${clientId}`);

  const snap = await db.collection("assets").where("clientId", "==", clientId).get();
  type Row = { id: string; labRun: string; status: string; title?: string; data: FirebaseFirestore.DocumentData };
  const targets: Row[] = [];
  const keptPublished: Row[] = [];
  for (const d of snap.docs) {
    const a = d.data();
    const lr = (a.meta as { labRun?: string } | undefined)?.labRun;
    if (typeof lr !== "string" || !lr.startsWith(LAB_RUN_PREFIX)) continue;
    const row: Row = { id: d.id, labRun: lr, status: a.status, title: a.title, data: a };
    if (a.status === "published") keptPublished.push(row);
    else targets.push(row);
  }

  console.log(`Legacy assets found: ${targets.length + keptPublished.length}`);
  console.log(`  published (NEVER touched): ${keptPublished.length}`);
  for (const r of keptPublished) console.log(`    keep  ${r.labRun}  [${r.status}]  ${r.title ?? ""}`);
  console.log(`  unpublished (to delete):   ${targets.length}`);
  for (const r of targets) console.log(`    kill  ${r.labRun}  [${r.status}]  ${r.title ?? ""}`);

  if (!APPLY) {
    console.log("\nDRY RUN: nothing written. Re-run with --apply to backup + delete.");
    return;
  }
  if (targets.length === 0) {
    console.log("\nNothing to delete.");
    return;
  }

  // full reversible backup first (cleanup-stale-pitch-drafts convention)
  const backupDir = resolve(process.cwd(), "scripts/backups");
  mkdirSync(backupDir, { recursive: true });
  const backupPath = resolve(backupDir, `sitti-legacy-kill-${new Date().toISOString().replace(/[:.]/g, "-")}.json`);
  writeFileSync(
    backupPath,
    JSON.stringify(
      {
        killedAt: Date.now(),
        reason: "Albert 2026-08-05: kill unpublished pre-pivot study-spot slots (superseded by the gatekeep runway)",
        clientId,
        docs: targets.map((r) => ({ id: r.id, data: r.data })),
      },
      null,
      2,
    ),
  );
  console.log(`\nBackup written: ${backupPath}`);

  const batch = db.batch();
  for (const r of targets) batch.delete(db.collection("assets").doc(r.id));
  await batch.commit();
  console.log(`Deleted ${targets.length} assets. Storage objects under lab-imports/ left in place (re-import recreates them).`);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
