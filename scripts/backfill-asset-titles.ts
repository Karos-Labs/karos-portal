/**
 * One-time backfill of deliverable titles that kept the client's own name.
 *
 * Every agent-service submit path titles its job `<Agent name> - <Client name>`
 * and the delivery handler is meant to strip that suffix, so the deliverable is
 * titled just the agent name. The strip looked for an em dash while all three
 * builders wrote a plain hyphen, so it never fired — for any run, from any
 * path. Both sides now share lib/job-title.ts, but assets already written keep
 * titles like "Reddit Agent - Acme Corp" until this runs.
 *
 *   npx tsx scripts/backfill-asset-titles.ts            # dry run — prints the plan
 *   npx tsx scripts/backfill-asset-titles.ts --apply    # writes
 *
 * DRY RUN IS THE DEFAULT ON PURPOSE. The credentials in .env.local point at
 * production Firestore. Read the printed plan first.
 *
 * Deliberately conservative: an asset is rewritten ONLY when its title is
 * character-for-character its job's title AND that title is the exact
 * `<agentName> - <client>` shape. An asset renamed by hand, or one whose title
 * the agent chose itself, is left alone.
 */

import { readFileSync } from "fs";
import { resolve } from "path";

// ── Load .env.local before any Firebase imports ──────────────────────────────
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
    // .env.local may not exist in CI — that's fine
  }
}

loadEnvFile(resolve(process.cwd(), ".env.local"));
loadEnvFile(resolve(process.cwd(), ".env"));

import { initializeApp, getApps, cert } from "firebase-admin/app";
import { getFirestore } from "firebase-admin/firestore";

/** Twin of JOB_TITLE_CLIENT_SEPARATOR in src/lib/job-title.ts. */
const JOB_TITLE_CLIENT_SEPARATOR = " - ";

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

interface JobDoc {
  agentId?: string;
  agentName?: string;
  title?: string;
  assetIds?: string[];
}

async function main() {
  const apply = process.argv.includes("--apply");
  initAdmin();
  const db = getFirestore();
  db.settings({ ignoreUndefinedProperties: true });

  console.log(
    apply ? "APPLYING asset-title backfill\n" : "DRY RUN — nothing is written. Pass --apply to write.\n",
  );

  const jobs = await db.collection("jobs").where("agentId", "==", "agent-service").get();
  let planned = 0;
  let untouched = 0;

  for (const jobDoc of jobs.docs) {
    const job = jobDoc.data() as JobDoc;
    const agentName = job.agentName?.trim();
    const jobTitle = job.title ?? "";
    if (!agentName || !jobTitle.startsWith(agentName + JOB_TITLE_CLIENT_SEPARATOR)) continue;

    for (const assetId of job.assetIds ?? []) {
      const ref = db.collection("assets").doc(assetId);
      const snap = await ref.get();
      if (!snap.exists) continue;
      const title = (snap.data()?.title as string | undefined) ?? "";
      if (title !== jobTitle) {
        untouched++;
        continue;
      }
      planned++;
      console.log(`rename ${assetId}\n       "${title}"\n    -> "${agentName}"`);
      if (apply) await ref.set({ title: agentName, updatedAt: Date.now() }, { merge: true });
    }
  }

  console.log(`\n${apply ? "renamed" : "would rename"} ${planned} · left alone ${untouched}`);
}

// Only when invoked directly — importing this file must never open a Firestore
// connection, let alone write to one.
if (require.main === module) {
  main().catch((e) => {
    console.error(e);
    process.exit(1);
  });
}
