/**
 * Registers karos-x-agent-v2 as a new CustomAgent doc, separate from v1
 * (karos-x-agent). Idempotent: safe to re-run, updates the existing doc by
 * key instead of creating a duplicate.
 *
 * Deliberately created with enabled: false — the karos-agents manifest still
 * marks both x-agent-v2 skills "unreviewed" (not "ready"), so this registers
 * the wiring without putting it in front of any client until someone flips
 * it on.
 *
 * Usage: npx tsx scripts/register-x-agent-v2.ts
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
import { getFirestore } from "firebase-admin/firestore";

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
  return getFirestore();
}

const KEY = "karos-x-agent-v2";

const INSTRUCTIONS = `Run the X agent v2 skill (products/building/x-agent-v2/SKILL.md) as the
on-demand drafting engine for this client. This is a SEPARATE, newer engine
from the production "X Agent" (v1) — do not fall back to products/live/x-agent.

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

async function main() {
  const db = initAdmin();
  const now = Date.now();

  const existingSnap = await db.collection("customAgents").where("key", "==", KEY).limit(1).get();

  const data = {
    key: KEY,
    name: "X Agent v2 (unreviewed)",
    description:
      "On-demand rebuild of the X drafting engine: one run drafts ONE post for one identity (the company page or a single seat). Resumable, draft-only. Separate from and does not replace the production X Agent. karos-agents manifest status: unreviewed.",
    clientBlurb: "Drafts one X post on demand, any time: build-in-public, knowledge, POV, news-reaction, or quote, grounded in your X agent data.",
    icon: "Zap",
    color: "#FDE047",
    entrySkillDir: "products/building/x-agent-v2",
    skillRoots: [],
    includeClientSkills: true,
    instructions: INSTRUCTIONS,
    creditCost: null,
    launchCreditCost: null,
    // The manifest already tiers this skill to claude-sonnet-5 (a deliberate,
    // cost-parity-tested choice per docs/one-pagers/x-agent-v2-FRAMEWORK.md) —
    // override the custom task type's opus-4-8 default to honor it.
    model: "claude-sonnet-5",
    stepModels: null,
    // Deliberately hidden from run surfaces until someone reviews it and
    // flips this on — see the file header.
    enabled: false,
    source: {
      path: "products/building/x-agent-v2",
      status: "unreviewed",
    },
    createdBy: "script:register-x-agent-v2",
    updatedAt: now,
  };

  if (existingSnap.empty) {
    const ref = await db.collection("customAgents").add({ ...data, createdAt: now });
    console.log(`>>> Created customAgents/${ref.id} (key=${KEY}, enabled=false)`);
  } else {
    const doc = existingSnap.docs[0];
    await doc.ref.update(data);
    console.log(`>>> Updated existing customAgents/${doc.id} (key=${KEY}, enabled=false)`);
  }
}

main()
  .then(() => process.exit(0))
  .catch((e) => {
    console.error(e);
    process.exit(1);
  });
