/**
 * Finds Firestore `users` docs whose Firebase Auth account no longer exists
 * (deleted directly in the Firebase console, which never touches Firestore —
 * only the app's own delete/reject actions clean up both sides) and deletes
 * the orphaned Firestore doc.
 *
 *   npx tsx scripts/reconcile-deleted-auth-users.ts            # dry run — prints the plan
 *   npx tsx scripts/reconcile-deleted-auth-users.ts --apply    # deletes (permanent — there is no undo)
 *
 * DRY RUN IS THE DEFAULT ON PURPOSE. The credentials in .env.local point at
 * production Firestore/Auth. Read the printed plan first.
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
import { getAuth } from "firebase-admin/auth";
import { getFirestore } from "firebase-admin/firestore";

async function main() {
  const apply = process.argv.includes("--apply");
  if (!getApps().length) {
    const raw = process.env.FIREBASE_SERVICE_ACCOUNT_KEY;
    if (!raw) throw new Error("FIREBASE_SERVICE_ACCOUNT_KEY not set");
    initializeApp({ credential: cert(JSON.parse(raw)) });
  }
  const db = getFirestore();
  const auth = getAuth();

  console.log(apply ? "[APPLY — deletions are permanent]\n" : "[DRY RUN — nothing is deleted. Pass --apply to delete.]\n");

  const snap = await db.collection("users").get();
  console.log(`Checking ${snap.docs.length} Firestore user doc(s) against Firebase Auth...`);

  const orphaned: { uid: string; email?: string; name?: string }[] = [];
  for (const doc of snap.docs) {
    try {
      await auth.getUser(doc.id);
    } catch (e: unknown) {
      const code = (e as { code?: string })?.code;
      if (code === "auth/user-not-found") {
        const data = doc.data();
        orphaned.push({ uid: doc.id, email: data.email, name: data.name });
      } else {
        console.warn(`  ! could not verify ${doc.id}: ${(e as Error).message}`);
      }
    }
  }

  console.log(`\nOrphaned (no matching Auth account): ${orphaned.length}`);
  for (const u of orphaned) console.log(`  ${u.uid}  ${u.email ?? "?"}  ${u.name ?? ""}`);

  if (!apply) {
    console.log("\nDry run — nothing deleted. Re-run with --apply to clean up.");
    return;
  }

  for (const u of orphaned) {
    await db.collection("users").doc(u.uid).delete();
  }
  console.log(`\nDeleted ${orphaned.length} orphaned Firestore user doc(s).`);
}

main()
  .then(() => process.exit(0))
  .catch((e) => {
    console.error(e);
    process.exit(1);
  });
