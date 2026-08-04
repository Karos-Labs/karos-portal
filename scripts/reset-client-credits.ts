/**
 * Pre-launch reset of client credits — every clientCredits doc goes back to a
 * fresh account (balance 200, weekly/monthly caps back to 150/400, spend
 * counters zeroed) and the creditLedger is wiped entirely. Everything charged
 * or granted so far was test activity on production Firestore; this clears it
 * out before real client usage starts.
 *
 *   npx tsx scripts/reset-client-credits.ts            # dry run — prints the plan
 *   npx tsx scripts/reset-client-credits.ts --apply    # writes the reset (permanent — there is no undo)
 *
 * DRY RUN IS THE DEFAULT ON PURPOSE. The credentials in .env.local point at
 * production Firestore. Read the printed plan first.
 *
 * Mirrors defaultClientCredits() / CREDIT_DEFAULTS in src/lib/credits.ts
 * (inlined here because that module is pure but data.ts's collection wiring
 * is a Next server-only path this script doesn't import).
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
import { getFirestore } from "firebase-admin/firestore";

const STARTING_BALANCE = 200;
const WEEKLY_LIMIT = 150;
const MONTHLY_LIMIT = 400;

function creditWeekKey(ts: number): string {
  const d = new Date(ts);
  const day = d.getUTCDay() || 7;
  const thursday = Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate() + (4 - day));
  const isoYear = new Date(thursday).getUTCFullYear();
  const yearStart = Date.UTC(isoYear, 0, 1);
  const week = Math.ceil(((thursday - yearStart) / 86_400_000 + 1) / 7);
  return `${isoYear}-W${String(week).padStart(2, "0")}`;
}

function creditMonthKey(ts: number): string {
  const d = new Date(ts);
  return `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, "0")}`;
}

async function main() {
  const apply = process.argv.includes("--apply");

  if (!getApps().length) {
    const raw = process.env.FIREBASE_SERVICE_ACCOUNT_KEY;
    if (!raw) throw new Error("FIREBASE_SERVICE_ACCOUNT_KEY not set");
    initializeApp({ credential: cert(JSON.parse(raw)) });
  }
  const db = getFirestore();
  const now = Date.now();

  console.log(`═══ Client credits reset (${apply ? "APPLY" : "DRY RUN"}) ═══\n`);

  const clientsSnap = await db.collection("clients").get();
  const clientIds = clientsSnap.docs.map((d) => d.id);
  const creditsSnap = await db.collection("clientCredits").get();
  const ledgerSnap = await db.collection("creditLedger").get();

  console.log(`${clientIds.length} clients, ${creditsSnap.size} existing clientCredits docs, ${ledgerSnap.size} creditLedger entries.\n`);

  console.log("── clientCredits: reset to balance=200, weeklyLimit=150, monthlyLimit=400, spend=0 ──");
  for (const doc of creditsSnap.docs) {
    const data = doc.data();
    console.log(
      `  ${doc.id}: balance ${data.balance ?? "?"} → ${STARTING_BALANCE}, ` +
        `weeklyLimit ${data.weeklyLimit ?? "null"} → ${WEEKLY_LIMIT}, ` +
        `monthlyLimit ${data.monthlyLimit ?? "null"} → ${MONTHLY_LIMIT}, ` +
        `weekSpent ${data.weekSpent ?? 0} → 0, monthSpent ${data.monthSpent ?? 0} → 0`,
    );
  }
  // Clients with no clientCredits doc yet don't need one created — the app
  // lazily creates it at the defaults on first charge/grant, which is exactly
  // this reset's target state.

  console.log(`\n── creditLedger: delete all ${ledgerSnap.size} entries ──\n`);

  if (!apply) {
    console.log("Dry run only — nothing written. Re-run with --apply to perform the reset.");
    return;
  }

  const weekKey = creditWeekKey(now);
  const monthKey = creditMonthKey(now);

  let batch = db.batch();
  let ops = 0;
  async function flushIfFull() {
    if (ops >= 450) {
      await batch.commit();
      batch = db.batch();
      ops = 0;
    }
  }

  for (const doc of creditsSnap.docs) {
    batch.set(doc.ref, {
      clientId: doc.id,
      balance: STARTING_BALANCE,
      weeklyLimit: WEEKLY_LIMIT,
      monthlyLimit: MONTHLY_LIMIT,
      weekKey,
      weekSpent: 0,
      monthKey,
      monthSpent: 0,
      updatedAt: now,
    });
    ops++;
    await flushIfFull();
  }
  for (const doc of ledgerSnap.docs) {
    batch.delete(doc.ref);
    ops++;
    await flushIfFull();
  }
  if (ops > 0) await batch.commit();

  console.log(`Reset ${creditsSnap.size} clientCredits doc(s) and deleted ${ledgerSnap.size} ledger entries.`);
}

main()
  .then(() => process.exit(0))
  .catch((e) => {
    console.error(e);
    process.exit(1);
  });
