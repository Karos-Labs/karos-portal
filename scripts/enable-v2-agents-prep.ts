/**
 * Turn a v2 agent family ON in the **prep** database and grant it to a client,
 * so a local dev server has something to click.
 *
 * FENCED TO PREP, and the fence is the point of the file. Production and prep are
 * two Firestore databases in one project, selected by `FIRESTORE_DATABASE_ID` —
 * so the difference between "my localhost shows the new agent" and "every client
 * on the live portal shows an agent whose code is not deployed" is one
 * environment variable. This script refuses to run against `(default)` rather
 * than trusting whoever invokes it to have set it, because the failure mode is
 * silent and outward-facing: the live portal would offer a card, a client would
 * press Run, and the run would fire with none of its data attached.
 *
 * SUPERSEDES enable-linkedin-v2-prep.ts, which was this file with one family
 * hardcoded. Four families now need the same three writes, and four copies of a
 * script whose whole job is a safety fence is four places for the fence to rot.
 *
 * The production docs stay `enabled: false` until the branch is deployed.
 *
 * Run: FIRESTORE_DATABASE_ID=prep NODE_PATH=./node_modules npx tsx \
 *        --env-file=.env.local scripts/enable-v2-agents-prep.ts \
 *        [--apply] [--family all|linkedin|reddit|newsletter|blog|reputation|carousel] [--client <id>]
 */
import { cert, getApps, initializeApp } from "firebase-admin/app";
import { getFirestore } from "firebase-admin/firestore";
import {
  BLOG_MANAGER_V2_KEY,
  CAROUSEL_MANAGER_KEY,
  CAROUSEL_RUNNER_KEY,
  CAROUSEL_SETUP_KEY,
  BLOG_SETUP_V2_KEY,
  BLOG_WRITER_V2_KEY,
  COMPLIANCE_LOCK_V2_KEY,
  NEWSLETTER_MANAGER_V2_KEY,
  NEWSLETTER_SETUP_V2_KEY,
  NEWSLETTER_WRITER_V2_KEY,
  REDDIT_RUNNER_V2_KEY,
  REDDIT_SETUP_V2_KEY,
  REPUTATION_MANAGER_KEY,
  REPUTATION_RUNNER_KEY,
  REPUTATION_SETUP_KEY,
} from "../src/lib/custom-agent-launch";

const APPLY = process.argv.includes("--apply");
const arg = (name: string) => {
  const i = process.argv.indexOf(`--${name}`);
  return i > -1 ? process.argv[i + 1] : undefined;
};
/** Karos Labs — the pilot client, and the one with real intake on file. */
const CLIENT_ID = arg("client") ?? "iZLc0mtwSFXNKE2KkC2d";
const FAMILY = arg("family") ?? "all";

/**
 * Each family's keys, WRITER FIRST.
 *
 * The order matters for the grant, not for the enable. Only the writer is a
 * product a person chooses; its steps are hidden from every roster by
 * `parentKey`. They are granted anyway — hiding is not un-granting, and the
 * parent's own surface fires its steps on the client's behalf, which both submit
 * cores refuse for an ungranted agent.
 *
 * Keys are IMPORTED, never re-typed: they are the join to the roster predicates,
 * the gates and the context builders, and a typo here silently enables nothing.
 */
const FAMILIES: Record<string, readonly string[]> = {
  linkedin: [
    "karos-linkedin-writer-v2",
    "karos-linkedin-setup-v2",
    "karos-linkedin-manager-v2",
  ],
  reddit: [REDDIT_RUNNER_V2_KEY, REDDIT_SETUP_V2_KEY],
  newsletter: [
    NEWSLETTER_WRITER_V2_KEY,
    NEWSLETTER_SETUP_V2_KEY,
    NEWSLETTER_MANAGER_V2_KEY,
    COMPLIANCE_LOCK_V2_KEY,
  ],
  blog: [BLOG_WRITER_V2_KEY, BLOG_SETUP_V2_KEY, BLOG_MANAGER_V2_KEY],
  reputation: [REPUTATION_RUNNER_KEY, REPUTATION_SETUP_KEY, REPUTATION_MANAGER_KEY],
  carousel: [CAROUSEL_RUNNER_KEY, CAROUSEL_SETUP_KEY, CAROUSEL_MANAGER_KEY],
};

async function main() {
  const databaseId = process.env.FIRESTORE_DATABASE_ID;
  if (databaseId !== "prep") {
    throw new Error(
      `This script only runs against the prep database (FIRESTORE_DATABASE_ID=prep), and it is ${databaseId ?? "unset, which means production"}. ` +
        "Enabling these agents in production before the portal branch is deployed would offer a live client a run with no data attached.",
    );
  }
  const families = FAMILY === "all" ? Object.keys(FAMILIES) : [FAMILY];
  for (const f of families) {
    if (!FAMILIES[f]) throw new Error(`Unknown family "${f}". One of: all, ${Object.keys(FAMILIES).join(", ")}`);
  }

  const sa = JSON.parse(process.env.FIREBASE_SERVICE_ACCOUNT_KEY!);
  if (getApps().length === 0) initializeApp({ credential: cert(sa), projectId: sa.project_id });
  const db = getFirestore(databaseId);

  console.log(`project: ${sa.project_id} · database: ${databaseId}`);
  console.log(APPLY ? "MODE: apply\n" : "MODE: dry run (pass --apply to write)\n");

  const client = await db.collection("clients").doc(CLIENT_ID).get();
  if (!client.exists) throw new Error(`No client ${CLIENT_ID} in ${databaseId}`);
  console.log(`client: ${client.data()!.name} (${CLIENT_ID})`);

  const ids: string[] = [];
  for (const family of families) {
    console.log(`\n${family}:`);
    for (const key of FAMILIES[family]) {
      const snap = await db.collection("customAgents").where("key", "==", key).limit(1).get();
      if (snap.empty) {
        console.log(`  ${key}: MISSING — run its register-*-v2.ts against prep first`);
        continue;
      }
      const ref = snap.docs[0];
      ids.push(ref.id);
      console.log(`  ${key}: ${ref.id} — enabled ${ref.data().enabled} → true`);
      if (APPLY) await ref.ref.set({ enabled: true, updatedAt: Date.now() }, { merge: true });
    }
  }

  const granted: string[] = client.data()!.customAgentIds ?? [];
  const missing = ids.filter((id) => !granted.includes(id));
  console.log(
    `\ngrant: ${missing.length} of ${ids.length} to add (${granted.length} already on the client)`,
  );
  if (APPLY && missing.length > 0) {
    await client.ref.set(
      { customAgentIds: [...granted, ...missing], updatedAt: Date.now() },
      { merge: true },
    );
    console.log("  → granted");
  }

  if (APPLY) {
    console.log(
      `\nStart the dev server against prep:\n  FIRESTORE_DATABASE_ID=prep npm run dev\n` +
        `  Library:  http://localhost:3000/agents\n` +
        `  Roster:   http://localhost:3000/clients/${CLIENT_ID}/agents`,
    );
  }
}

main().then(
  () => process.exit(0),
  (e) => {
    console.error(`FAILED: ${e instanceof Error ? e.message : e}`);
    process.exit(1);
  },
);
