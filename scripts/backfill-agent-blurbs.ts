/**
 * One-time backfill of `clientBlurb` on the existing customAgents.
 *
 * Agent cards and the run dialog used to render `description` — the lab repo's
 * own skill manifest — straight to clients, product codes and pipeline
 * vocabulary included. `description` is now the internal field and `clientBlurb`
 * is what clients read; agents imported before the field existed have none and
 * fall back to the manifest until this runs.
 *
 * Blurbs are hand-written below, one per agent, matched on `<key> <name>` the
 * same way the launch profiles match. `description` is never touched.
 *
 *   npx tsx scripts/backfill-agent-blurbs.ts            # dry run — prints the plan
 *   npx tsx scripts/backfill-agent-blurbs.ts --apply    # writes
 *
 * DRY RUN IS THE DEFAULT ON PURPOSE. The credentials in .env.local point at
 * production Firestore. Read the printed plan, confirm every agent matched the
 * blurb you expect, then re-run with --apply.
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

/** Twin of LAB_JARGON_RE in src/lib/agent-service/custom-agent-import.ts. */
const LAB_JARGON_RE = /\be\d{1,2}\)|sub-skill|tonemap|FORGE|Path [A-Z]\b/i;
const MAX_CLIENT_BLURB_CHARS = 300;

/**
 * Matched against `<key> <name>` lowercased, first hit wins — so ordering
 * matters where patterns overlap (interview clips and branded shorts are both
 * "video", Instagram and TikTok are both "content engine").
 */
const BLURBS: Array<{ match: RegExp; blurb: string }> = [
  {
    match: /karos-x-agent|(^|\s)x agent/,
    blurb:
      "Drafts your X posts from your company page, your team's profiles, and the updates you save on the X agent data page. Every post arrives as a draft for you to approve.",
  },
  {
    match: /linkedin/,
    blurb:
      "Drafts LinkedIn posts for your company page and your team from the profiles and updates you save on the LinkedIn agent data page. Nothing publishes without your approval.",
  },
  {
    match: /reddit/,
    blurb:
      "Finds the Reddit conversations worth joining and drafts one reply at a time in your voice. You post each reply yourself.",
  },
  {
    match: /interview.?clip/,
    blurb:
      "Cuts your interviews and long recordings into short captioned clips, ready to post.",
  },
  {
    match: /branded.?short|shorts editor/,
    blurb:
      "Turns a video you upload into short branded cuts with captions, sized for social.",
  },
  {
    match: /tiktok/,
    blurb:
      "Turns your brand guidelines and what is trending in your industry into a steady run of TikTok-ready ideas and scripts.",
  },
  {
    match: /instagram/,
    blurb:
      "Produces a continuous stream of on-brand Instagram posts, drawn from your brand guidelines and what is happening in your industry.",
  },
];

interface AgentDoc {
  key?: string;
  name?: string;
  description?: string;
  clientBlurb?: string | null;
}

async function main() {
  const apply = process.argv.includes("--apply");
  initAdmin();
  const db = getFirestore();
  db.settings({ ignoreUndefinedProperties: true });

  for (const { blurb } of BLURBS) {
    if (blurb.length > MAX_CLIENT_BLURB_CHARS) throw new Error(`Blurb too long: ${blurb}`);
    if (LAB_JARGON_RE.test(blurb)) throw new Error(`Blurb reads as lab notes: ${blurb}`);
  }

  const snap = await db.collection("customAgents").get();
  const unmatched: string[] = [];
  let planned = 0;
  let alreadySet = 0;

  console.log(apply ? "APPLYING clientBlurb backfill\n" : "DRY RUN — nothing is written. Pass --apply to write.\n");

  for (const doc of snap.docs) {
    const agent = doc.data() as AgentDoc;
    const identity = `${agent.key ?? ""} ${agent.name ?? ""}`.toLowerCase();
    const entry = BLURBS.find((b) => b.match.test(identity));
    if (!entry) {
      unmatched.push(`${agent.name ?? "(unnamed)"} [${agent.key ?? doc.id}]`);
      continue;
    }
    if (agent.clientBlurb?.trim()) {
      alreadySet++;
      console.log(`skip  ${agent.name} — already has a blurb`);
      continue;
    }
    planned++;
    console.log(`set   ${agent.name}\n      ${entry.blurb}`);
    if (apply) {
      await doc.ref.set({ clientBlurb: entry.blurb, updatedAt: Date.now() }, { merge: true });
    }
  }

  console.log(
    `\n${apply ? "wrote" : "would write"} ${planned} · already set ${alreadySet} · unmatched ${unmatched.length}`,
  );
  if (unmatched.length > 0) {
    console.log(
      "\nNo blurb pattern matched these agents — their cards keep falling back to the internal\n" +
        "description. Add a pattern here or write the blurb in the admin agent editor:",
    );
    for (const name of unmatched) console.log(`  - ${name}`);
  }
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
