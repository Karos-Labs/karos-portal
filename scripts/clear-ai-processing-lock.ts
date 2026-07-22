/**
 * One-off: clear a stuck Client.isAiProcessing lock (e.g. the background
 * generation cycle died — out-of-credits, dev-server restart, etc. — without
 * reaching its `finally` release).
 *
 * Run with:
 *   npx tsx scripts/clear-ai-processing-lock.ts "<client name or id>"
 *
 * Reads Firebase credentials from .env.local automatically.
 */

import { readFileSync } from "fs";
import { resolve } from "path";

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
    // .env.local may not exist in CI or Vercel — that's fine
  }
}

loadEnvFile(resolve(process.cwd(), ".env.local"));
loadEnvFile(resolve(process.cwd(), ".env"));

import { initializeApp, getApps, cert } from "firebase-admin/app";
import { getFirestore } from "firebase-admin/firestore";

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

async function main() {
  const query = process.argv[2];
  if (!query) {
    console.error('Usage: npx tsx scripts/clear-ai-processing-lock.ts "<client name or id>"');
    process.exit(1);
  }

  initAdmin();
  const db = getFirestore();

  const byId = await db.collection("clients").doc(query).get();
  const matches = byId.exists
    ? [byId]
    : (await db.collection("clients").get()).docs.filter((d) =>
        String(d.data().name ?? "").toLowerCase().includes(query.toLowerCase()),
      );

  if (matches.length === 0) {
    console.error(`No client found matching "${query}"`);
    process.exit(1);
  }
  if (matches.length > 1) {
    console.error(`Multiple clients match "${query}": ${matches.map((d) => `${d.data()?.name} (${d.id})`).join(", ")}`);
    console.error("Re-run with the exact client id.");
    process.exit(1);
  }

  const doc = matches[0];
  const data = doc.data() ?? {};
  console.log(`Found: ${data.name} (${doc.id})`);
  console.log(`  isAiProcessing: ${data.isAiProcessing}`);
  console.log(`  aiProcessingStartedAt: ${data.aiProcessingStartedAt ? new Date(data.aiProcessingStartedAt).toISOString() : "—"}`);

  await doc.ref.set(
    { isAiProcessing: false, aiProcessingStartedAt: null, aiProcessingError: null },
    { merge: true },
  );
  console.log("✅ Lock cleared. Regenerate / Refresh Task Map are unlocked.");
  process.exit(0);
}

main().catch((err) => {
  console.error("Fatal error:", err);
  process.exit(1);
});
