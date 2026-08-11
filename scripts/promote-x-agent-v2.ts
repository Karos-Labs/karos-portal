/**
 * Retires karos-x-agent (v1) and promotes karos-x-agent-v2 to the official,
 * client-facing X agent, in BOTH Firestore databases (production "(default)"
 * and "prep"). Per explicit operator instruction (2026-08-03): v1 is
 * unneeded and must not exist in code or the db; v2 becomes "the" X agent.
 *
 * For each database this:
 * 1. Deletes the karos-x-agent (v1) CustomAgent doc.
 * 2. For every client whose customAgentIds referenced v1, swaps that id for
 *    v2's — so clients that had X agent access keep it, now on v2.
 * 3. Upserts karos-x-agent-v2 with enabled: true and display copy that drops
 *    the "(unreviewed)"/"separate from production" framing, since it is now
 *    the production agent. NOTE: the karos-agents repo's own runtime
 *    manifest still tags both x-agent-v2 skills "unreviewed" — this script
 *    overrides that on the operator's explicit instruction; it does not
 *    change the upstream manifest.
 *
 * A pre-mutation snapshot of every affected doc (both databases) was written
 * to _backup/2026-08-03/x-agent-v1-removal-snapshot.json before this ran.
 *
 * Usage: npx tsx scripts/promote-x-agent-v2.ts
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
import { getFirestore, type Firestore } from "firebase-admin/firestore";

function initAdmin() {
  if (!getApps().length) {
    const raw = process.env.FIREBASE_SERVICE_ACCOUNT_KEY;
    if (raw) {
      const parsed = JSON.parse(raw);
      console.log(`>>> Firebase project: ${parsed.project_id}`);
      initializeApp({ credential: cert(parsed) });
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
  return getApps()[0]!;
}

const V1_KEY = "karos-x-agent";
const V2_KEY = "karos-x-agent-v2";

const V2_INSTRUCTIONS = `Run the X agent v2 skill (products/building/x-agent-v2/SKILL.md) as the
on-demand drafting engine for this client. This is the official X agent —
do not fall back to products/live/x-agent (removed).

Before anything else, read products/building/x-agent-v2/references/run-protocol.md
in full. It governs the run folder name, attempt numbering, and the numbered
internal/ handoff files that make this run resumable — follow it exactly,
including its own run-folder naming convention (NOT the generic
"<date>-job-<id>" folder name this platform's own preamble otherwise suggests;
the skill's own protocol takes precedence for this agent).

ONE RUN PRODUCES ONE POST. This is the product ruling of 2026-08-11 and it
supersedes the skill's own batch framing wherever the two disagree: SKILL.md
and its references still describe a batch of N drafts (5/10/21) — that text
is stale, and there is no batch. A run belongs to ONE identity (the company
page, or a single seat), read from the client's request text; if the request
names no identity, draft for the company page. Choose ONE avenue by the
skill's own precedence — the client's request first, the identity's stated
lane preference next, otherwise the identity's top-weighted lane — and run
the skill's per-post steps once for that single subject: choose it, angle
it, draft it, gate it. Deliver exactly one post (a thread is that one post).
If the request asks for several posts or "a batch", still deliver one — the
strongest single post the request supports — and note the narrowed scope in
internal/RUN.md. The lane-spanning batch rules in the skill's references do
not apply to a one-post run; every other gate does.

Deliverable structure: write client/DRAFTS.md — the portal parses it. Keep
exactly this shape, with one account section and one avenue block:
"# Account 1 · <name>" (the company section's name must contain "Company
page"; a seat section carries the person's name), one "## Avenue 1 · <lane>"
block, the post text as a "> " blockquote (a thread: one blockquote per part
with **1/3**-style markers between), a "NNN chars" line after the post, and
"- **" bullets for sources.

Read first, in this order:
1. client_context/brief.md and every file in client_context/files/. The files
   x-portal-intake.md, whats-new.json, and takes--*.json are the portal's LIVE
   client data and OVERRIDE any older copies inside the repo on any
   disagreement. Files named prior-batch-*.md are this client's previous
   portal deliveries — treat every subject, source, quoted post, and phrasing
   in them as ALREADY USED, in addition to the repo's own shared ledger
   (clients/<slug>/skills/x-agent/x-ledger.json).
2. The client's onboarding profile (clients/<slug>/profile/) and voice
   profiles (clients/<slug>/skills/x-agent/voice/, or profile/executives/
   <name>.md sections 8-9 for a person) — these are read-only references the
   agent built, never asked of the client.

This skill requires the client to already be built (foundation, voice
profile, seeded topic catalog via the v2 setup run) — if
clients/<slug>/skills/x-agent/X-FOUNDATION.md does not exist yet, stop and
report outcome blocked_intake naming that file, per the run protocol's own
rule. Do not fall back to a generic voice.

No images anywhere, no caption files — an X post is text, and the post text
IS the deliverable. Draft-only: nothing posts, and no posting credential
exists. Follow every gate in the skill's own references
(x-craft.md, lanes.md) — they are load-bearing, not optional, especially
section 4 of x-craft.md.`;

const V2_DATA = {
  key: V2_KEY,
  name: "X Agent",
  description:
    "On-demand X drafting engine: one run drafts ONE post for one identity (the company page or a single seat), on the avenue the request calls for. Resumable, draft-only, grounded in the client's own X agent data.",
  clientBlurb:
    "Drafts one X post on demand, any time: build-in-public, knowledge, POV, news-reaction, or quote, grounded in your X agent data.",
  icon: "Zap",
  color: "#FDE047",
  entrySkillDir: "products/building/x-agent-v2",
  skillRoots: [],
  includeClientSkills: true,
  instructions: V2_INSTRUCTIONS,
  creditCost: null,
  launchCreditCost: null,
  model: "claude-sonnet-5",
  stepModels: null,
  enabled: true,
  source: {
    path: "products/building/x-agent-v2",
    // Mirrors the karos-agents repo's own runtime manifest, which still says
    // "unreviewed" as of 2026-08-03. Promoted to enabled: true anyway on
    // explicit operator instruction — this field intentionally still
    // reflects upstream's own assessment rather than the portal's decision.
    status: "unreviewed",
  },
  updatedBy: "script:promote-x-agent-v2",
  updatedAt: 0, // set per-run below
};

async function processDatabase(app: ReturnType<typeof initAdmin>, databaseId: string) {
  const db: Firestore = databaseId === "(default)" ? getFirestore(app) : getFirestore(app, databaseId);
  const now = Date.now();
  console.log(`\n=== database: ${databaseId} ===`);

  const v1Snap = await db.collection("customAgents").where("key", "==", V1_KEY).limit(1).get();
  const v2Snap = await db.collection("customAgents").where("key", "==", V2_KEY).limit(1).get();

  let v1Id: string | null = null;
  if (!v1Snap.empty) {
    v1Id = v1Snap.docs[0].id;
    await v1Snap.docs[0].ref.delete();
    console.log(`>>> Deleted customAgents/${v1Id} (key=${V1_KEY})`);
  } else {
    console.log(`>>> No ${V1_KEY} doc found — nothing to delete`);
  }

  let v2Id: string;
  const v2Payload = { ...V2_DATA, updatedAt: now };
  if (v2Snap.empty) {
    const ref = await db.collection("customAgents").add({ ...v2Payload, createdAt: now });
    v2Id = ref.id;
    console.log(`>>> Created customAgents/${v2Id} (key=${V2_KEY}, enabled=true)`);
  } else {
    v2Id = v2Snap.docs[0].id;
    await v2Snap.docs[0].ref.update(v2Payload);
    console.log(`>>> Updated customAgents/${v2Id} (key=${V2_KEY}, enabled=true)`);
  }

  if (v1Id) {
    const clientsSnap = await db.collection("clients").where("customAgentIds", "array-contains", v1Id).get();
    for (const clientDoc of clientsSnap.docs) {
      const ids: string[] = clientDoc.data().customAgentIds ?? [];
      const nextIds = Array.from(new Set(ids.filter((id) => id !== v1Id).concat(v2Id)));
      await clientDoc.ref.update({ customAgentIds: nextIds });
      console.log(`>>> ${clientDoc.id} (${clientDoc.data().name}): swapped v1 -> v2 in customAgentIds`);
    }
    console.log(`>>> Swapped v1 -> v2 for ${clientsSnap.size} client(s)`);
  }
}

async function main() {
  const app = initAdmin();
  for (const databaseId of ["(default)", "prep"]) {
    await processDatabase(app, databaseId);
  }
}

main()
  .then(() => process.exit(0))
  .catch((e) => {
    console.error(e);
    process.exit(1);
  });
