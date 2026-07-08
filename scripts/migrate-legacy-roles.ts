/**
 * One-off migration: normalize legacy lowercase role values in the `users`
 * collection and collapse duplicate user docs for the same email.
 *
 *   admin    → KAROS_ADMIN
 *   employee → KAROS_EMPLOYEE
 *   client   → CLIENT_USER
 *
 * Duplicate handling: when two docs share an email, the doc whose id matches
 * the live Firebase Auth uid (adminAuth.getUserByEmail) is kept; fields the
 * keeper is missing are merged in from the loser, then the loser is deleted.
 *
 * Run with:
 *   npx tsx scripts/migrate-legacy-roles.ts            # dry run — prints the plan only
 *   npx tsx scripts/migrate-legacy-roles.ts --apply    # executes the writes
 *
 * Reads Firebase credentials (FIREBASE_SERVICE_ACCOUNT_KEY) from .env.local.
 */

import { readFileSync, existsSync } from "fs";
import { resolve, dirname } from "path";

// ── Load .env.local before any Firebase imports ──────────────────────────────
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
      const quote = val.startsWith('"') ? '"' : val.startsWith("'") ? "'" : "";
      if (quote) {
        // Multi-line quoted value: consume lines until the closing quote.
        val = val.slice(1);
        while (!val.endsWith(quote) && i + 1 < lines.length) {
          i++;
          val += "\n" + lines[i].trimEnd();
        }
        if (val.endsWith(quote)) val = val.slice(0, -1);
      }
      if (!process.env[key]) process.env[key] = val;
    }
  } catch {
    // ignore missing files
  }
}

// Walk up from cwd so the script also works when run from a git worktree
// whose checkout has no .env.local of its own.
function findAndLoadEnv() {
  let dir = process.cwd();
  for (let i = 0; i < 6; i++) {
    const candidate = resolve(dir, ".env.local");
    if (existsSync(candidate)) {
      loadEnvFile(candidate);
      return;
    }
    const parent = dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  loadEnvFile(resolve(process.cwd(), ".env"));
}

findAndLoadEnv();

// ── Firebase Admin SDK ───────────────────────────────────────────────────────
import { initializeApp, getApps, cert } from "firebase-admin/app";
import { getFirestore } from "firebase-admin/firestore";
import { getAuth } from "firebase-admin/auth";

function initAdmin() {
  if (getApps().length) return;
  const raw = process.env.FIREBASE_SERVICE_ACCOUNT_KEY;
  if (!raw) {
    throw new Error("FIREBASE_SERVICE_ACCOUNT_KEY not found in .env.local");
  }
  initializeApp({ credential: cert(JSON.parse(raw)) });
}

initAdmin();
const db = getFirestore();
const auth = getAuth();

const ROLE_MAP: Record<string, string> = {
  admin: "KAROS_ADMIN",
  employee: "KAROS_EMPLOYEE",
  client: "CLIENT_USER",
};
const VALID_ROLES = new Set(["KAROS_ADMIN", "KAROS_EMPLOYEE", "CLIENT_USER"]);

const APPLY = process.argv.includes("--apply");

async function main() {
  console.log(`Mode: ${APPLY ? "APPLY — writes will be executed" : "DRY RUN — no writes"}\n`);

  const snap = await db.collection("users").get();
  console.log(`Fetched ${snap.size} user docs.\n`);

  type UserDoc = { id: string; data: FirebaseFirestore.DocumentData };
  const byEmail = new Map<string, UserDoc[]>();
  for (const doc of snap.docs) {
    const data = doc.data();
    const email = String(data.email ?? "").toLowerCase();
    const list = byEmail.get(email) ?? [];
    list.push({ id: doc.id, data });
    byEmail.set(email, list);
  }

  const roleUpdates: { id: string; email: string; from: string; to: string }[] = [];
  const merges: { keepId: string; deleteId: string; email: string; mergedFields: string[] }[] = [];
  const unknownRoles: { id: string; email: string; role: string }[] = [];

  for (const [email, docs] of byEmail) {
    let survivors = docs;

    // ── Duplicate resolution ──────────────────────────────────────────────
    if (docs.length > 1) {
      if (!email) {
        console.warn(`⚠ ${docs.length} docs with no email field (ids: ${docs.map((d) => d.id).join(", ")}) — skipping, resolve manually.`);
        continue;
      }
      let authUid: string;
      try {
        authUid = (await auth.getUserByEmail(email)).uid;
      } catch {
        console.warn(`⚠ ${email}: ${docs.length} docs but no Firebase Auth user found — skipping, resolve manually.`);
        continue;
      }
      const keeper = docs.find((d) => d.id === authUid);
      if (!keeper) {
        console.warn(`⚠ ${email}: ${docs.length} docs but none matches Auth uid ${authUid} — skipping, resolve manually.`);
        continue;
      }
      for (const loser of docs.filter((d) => d.id !== keeper.id)) {
        // Merge: fill in fields the keeper is missing; keeper's values win.
        const mergedFields: string[] = [];
        for (const [k, v] of Object.entries(loser.data)) {
          if (keeper.data[k] === undefined && v !== undefined && k !== "role") {
            keeper.data[k] = v;
            mergedFields.push(k);
          }
        }
        merges.push({ keepId: keeper.id, deleteId: loser.id, email, mergedFields });
      }
      survivors = [keeper];
    }

    // ── Role normalization ────────────────────────────────────────────────
    for (const doc of survivors) {
      const role = String(doc.data.role ?? "");
      if (VALID_ROLES.has(role)) continue;
      const mapped = ROLE_MAP[role];
      if (mapped) {
        roleUpdates.push({ id: doc.id, email, from: role, to: mapped });
      } else {
        unknownRoles.push({ id: doc.id, email, role });
      }
    }
  }

  // ── Report the plan ────────────────────────────────────────────────────────
  console.log("── Plan ─────────────────────────────────────────────");
  if (merges.length) {
    console.log("\nDuplicate docs to collapse:");
    for (const m of merges) {
      console.log(`  • ${m.email}: keep ${m.keepId} (matches Auth uid), delete ${m.deleteId}`);
      console.log(`    fields merged from deleted doc: ${m.mergedFields.length ? m.mergedFields.join(", ") : "(none — keeper already had everything)"}`);
    }
  }
  if (roleUpdates.length) {
    console.log("\nRole updates:");
    for (const u of roleUpdates) {
      console.log(`  • ${u.email} (${u.id}): ${u.from} → ${u.to}`);
    }
  }
  if (unknownRoles.length) {
    console.log("\n⚠ Unrecognized roles left untouched:");
    for (const u of unknownRoles) {
      console.log(`  • ${u.email} (${u.id}): "${u.role}"`);
    }
  }
  if (!merges.length && !roleUpdates.length) {
    console.log("\nNothing to do — all roles are already valid and no duplicates found.");
    return;
  }

  if (!APPLY) {
    console.log("\nDry run complete. Re-run with --apply to execute.");
    return;
  }

  // ── Execute ────────────────────────────────────────────────────────────────
  console.log("\nApplying…");
  const batch = db.batch();
  for (const m of merges) {
    if (m.mergedFields.length) {
      const keeperData = byEmail.get(m.email)!.find((d) => d.id === m.keepId)!.data;
      const patch: Record<string, unknown> = {};
      for (const f of m.mergedFields) patch[f] = keeperData[f];
      batch.set(db.collection("users").doc(m.keepId), patch, { merge: true });
    }
    batch.delete(db.collection("users").doc(m.deleteId));
  }
  for (const u of roleUpdates) {
    batch.update(db.collection("users").doc(u.id), {
      role: u.to,
      roleMigratedAt: Date.now(),
      roleMigratedFrom: u.from,
    });
  }
  await batch.commit();
  console.log(`Done: ${roleUpdates.length} role update(s), ${merges.length} duplicate(s) removed.`);
}

main().catch((err) => {
  console.error("Migration failed:", err);
  process.exit(1);
});
