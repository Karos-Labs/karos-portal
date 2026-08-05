/**
 * One-off cleanup for the XO Digital client:
 *   1. Delete assets created in July 2026 only.
 *   2. Remove the old connected channel whose account is tomererel@... .
 *
 *   npx tsx scripts/cleanup-xo-digital.ts            # dry run — prints the plan
 *   npx tsx scripts/cleanup-xo-digital.ts --apply    # deletes (permanent — there is no undo)
 *
 * DRY RUN IS THE DEFAULT ON PURPOSE. The credentials in .env.local point at
 * production Firestore. Read the printed plan first.
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
    // fine — env may come from the shell
  }
}
loadEnvFile(resolve(process.cwd(), ".env.local"));
loadEnvFile(resolve(process.cwd(), ".env"));

import { initializeApp, cert, getApps } from "firebase-admin/app";
import { getFirestore, type DocumentReference } from "firebase-admin/firestore";

const CLIENT_NAME = "XO Digital";
const CHANNEL_EMAIL_NEEDLE = "tomererel";
const JULY_START = Date.UTC(2026, 6, 1);
const JULY_END = Date.UTC(2026, 7, 1);

function initAdmin() {
  if (getApps().length) return;
  const raw = process.env.FIREBASE_SERVICE_ACCOUNT_KEY;
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
  throw new Error(
    "No Firebase credentials found. Set FIREBASE_SERVICE_ACCOUNT_KEY or " +
      "FIREBASE_PROJECT_ID + FIREBASE_CLIENT_EMAIL + FIREBASE_PRIVATE_KEY in .env.local",
  );
}

function stamp(ms?: number): string {
  return typeof ms === "number" && Number.isFinite(ms) ? new Date(ms).toISOString() : "—";
}

async function batchDelete(db: FirebaseFirestore.Firestore, refs: DocumentReference[]) {
  for (let i = 0; i < refs.length; i += 400) {
    const batch = db.batch();
    for (const ref of refs.slice(i, i + 400)) batch.delete(ref);
    await batch.commit();
  }
}

async function main() {
  const apply = process.argv.includes("--apply");
  console.log(apply ? "[APPLY — deletions are permanent]\n" : "[DRY RUN — nothing is deleted. Pass --apply to delete.]\n");

  initAdmin();
  const db = getFirestore();
  db.settings({ ignoreUndefinedProperties: true });

  const clientSnap = await db.collection("clients").where("name", "==", CLIENT_NAME).get();
  if (clientSnap.empty) {
    console.error(`No client found with name "${CLIENT_NAME}".`);
    process.exit(1);
    return;
  }
  if (clientSnap.size > 1) {
    console.error(
      `Refusing to run — ${clientSnap.size} clients found with name "${CLIENT_NAME}": ` +
        clientSnap.docs.map((d) => d.id).join(", "),
    );
    process.exit(1);
    return;
  }
  const clientId = clientSnap.docs[0].id;
  console.log(`Client: ${CLIENT_NAME} (${clientId})\n`);

  // ── 1. July 2026 assets ────────────────────────────────────────────────
  const assetSnap = await db.collection("assets").where("clientId", "==", clientId).get();
  const julyAssets = assetSnap.docs.filter((d) => {
    const createdAt = d.data().createdAt as number | undefined;
    return typeof createdAt === "number" && createdAt >= JULY_START && createdAt < JULY_END;
  });

  console.log(`=== Assets created in July 2026 (${julyAssets.length}) ===`);
  if (julyAssets.length === 0) console.log("  none");
  for (const d of julyAssets) {
    const data = d.data();
    console.log(`  ${d.id}  created ${stamp(data.createdAt)}  ${data.status ?? "—"}  "${data.title ?? "—"}"`);
  }

  // ── 2. Old connected channel (tomererel) ───────────────────────────────
  const integrationSnap = await db.collection("clientIntegrations").where("clientId", "==", clientId).get();
  const staleIntegrations = integrationSnap.docs.filter((d) => {
    const data = d.data();
    const accountName = (data.accountName as string | undefined)?.toLowerCase() ?? "";
    const seats = (data.employeeSeats as Array<{ email?: string }> | undefined) ?? [];
    return (
      accountName.includes(CHANNEL_EMAIL_NEEDLE) ||
      seats.some((s) => s.email?.toLowerCase().includes(CHANNEL_EMAIL_NEEDLE))
    );
  });

  console.log(`\n=== Connected channels matching "${CHANNEL_EMAIL_NEEDLE}" (${staleIntegrations.length}) ===`);
  if (staleIntegrations.length === 0) console.log("  none");
  for (const d of staleIntegrations) {
    const data = d.data();
    console.log(`  ${d.id}  platform=${data.platform}  account="${data.accountName ?? "—"}"  status=${data.status ?? "—"}`);
  }

  if (!apply) {
    console.log("\nDry run — nothing changed. Re-run with --apply to delete the above.");
    return;
  }

  if (julyAssets.length) {
    await batchDelete(db, julyAssets.map((d) => d.ref));
    console.log(`\nDeleted ${julyAssets.length} July asset(s).`);
  }
  if (staleIntegrations.length) {
    await batchDelete(db, staleIntegrations.map((d) => d.ref));
    console.log(`Deleted ${staleIntegrations.length} stale integration(s).`);
  }
}

main()
  .then(() => process.exit(0))
  .catch((e) => {
    console.error(e);
    process.exit(1);
  });
