/**
 * One-time backfill of `clientBlurb` on the existing customAgents.
 *
 * Agent cards and the run dialog used to render `description` — the lab repo's
 * own skill manifest — straight to clients, product codes and pipeline
 * vocabulary included. `description` is now the internal field and `clientBlurb`
 * is what clients read; agents imported before the field existed have none and
 * fall back to the manifest until this runs.
 *
 * Blurbs are hand-written below, one per agent, matched on the agent KEY (see
 * the ordering note on BLURBS). `description` is never touched.
 *
 * TWIN OF src/lib/agent-blurbs.ts. That module is the RUNTIME fallback: it
 * renders these same lines for any agent whose clientBlurb is still empty, so
 * the roster reads correctly whether or not this script has ever run. The two
 * lists carry identical copy on purpose and must be changed together — if they
 * drift, a client sees one line before the backfill and a different one after,
 * for no reason they could ever observe. Scripts cannot import from `@/`
 * (nothing under scripts/ resolves the path alias), which is why this is a
 * documented twin rather than a shared import.
 *
 * The copy rule both follow (CD-G2, Albert): benefit first, concrete nouns for
 * what arrives, one sentence, no buzzwords and no internal vocabulary — never
 * the lab manifest's own "Master content-social skill…" phrasing.
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
 * Matched against the agent KEY only (lowercased) — never the display name,
 * which is editable and whose wording can collide ("… X agent" ends with the
 * same two words as the X agent itself).
 *
 * FIRST HIT WINS, so specific keys must precede the broad ones. In particular
 * `karos-instagram-tiktok-content-agent` contains BOTH "instagram" and "tiktok"
 * and must be matched by its own exact key before either single-platform
 * pattern gets a chance at it. Agents no pattern matches are reported, not
 * guessed at.
 */
const BLURBS: Array<{ key: RegExp; blurb: string }> = [
  {
    // The combined content engine — must come before /tiktok/ and /instagram/.
    key: /^karos-instagram-tiktok-content-agent$/,
    blurb:
      "Improve your Instagram reach with a daily post, different templates, and an agent that scans what is working in your niche.",
  },
  {
    key: /^karos-x-agent$/,
    blurb:
      "Grow your following on X with a post a day, written in your voice from what your industry is talking about right now.",
  },
  {
    // Company pages first: karos-linkedin-company-<slug> is one page, one voice.
    key: /^karos-linkedin-company-/,
    blurb:
      "Keep your LinkedIn company page active with posts that sound like your business instead of a press release.",
  },
  {
    key: /^karos-linkedin/,
    blurb:
      "Build your team's presence on LinkedIn with a steady run of posts for each person you put forward, each in their own voice.",
  },
  {
    key: /reddit/,
    blurb:
      "Find the Reddit threads worth joining and get a reply drafted in your voice, one at a time.",
  },
  {
    key: /interview/,
    blurb: "Turn your interviews and long recordings into short captioned clips, ready to post.",
  },
  {
    key: /branded.?short|shorts.?editor/,
    blurb: "Turn one of your videos into short branded cuts with captions, sized for social.",
  },
  {
    key: /tiktok/,
    blurb:
      "Reach more people on TikTok with a steady run of ideas and scripts built around what is trending in your industry.",
  },
  {
    key: /instagram/,
    blurb:
      "Improve your Instagram reach with a daily post, different templates, and an agent that scans what is working in your niche.",
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
    const entry = BLURBS.find((b) => b.key.test((agent.key ?? "").toLowerCase()));
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

// Only when invoked directly. Importing this file — for its BLURBS table, or by
// accident from a test runner glob — must never open a Firestore connection,
// let alone write to one.
if (require.main === module) {
  main().catch((e) => {
    console.error(e);
    process.exit(1);
  });
}
