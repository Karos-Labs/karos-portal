/**
 * One-time registration of the v2 agent skills as `customAgents` docs,
 * with the canonical instructions from each product's own portal doc.
 *
 * WHY A SCRIPT rather than the admin "Import agents" flow: that flow needs
 * `AGENTS_REPO_GITHUB_TOKEN` to scan the lab repo over the GitHub API. This
 * writes the same fields the import writes — including `source.status: "blocked"`
 * and therefore `enabled: false`, exactly as `importCustomAgentsAction` would
 * derive them — from the manifest values, so an operator without that token can
 * still stand the three agents up.
 *
 * WHAT IT DELIBERATELY DOES NOT DO:
 *  - It does not ENABLE the agents. All three carry `status: "blocked"` upstream
 *    ("in build, no pilot run yet"), and the import rule is that a blocked skill
 *    lands disabled so nobody fires it by accident. An admin flips the switch
 *    after the portal code that feeds them is deployed.
 *  - It does not GRANT them to any client. An enabled-and-granted agent whose
 *    portal support is not deployed yet would let a client press Run and get an
 *    un-fed run.
 *  - It does not touch the e10 doc, which stays disabled as the fallback.
 *
 * Idempotent: a key that already exists has its instructions REFRESHED from the
 * doc (snapshotting the previous text to _backup/ first) and everything else left
 * alone, so re-running after a copy edit is the supported way to re-apply.
 *
 * Run: NODE_PATH=./node_modules npx tsx --env-file=.env.local scripts/register-linkedin-agent-v2.ts [--apply]
 * Without --apply it prints what it would do and writes nothing.
 * `FIRESTORE_DATABASE_ID=prep` targets the prep database instead of production.
 */
import { cert, getApps, initializeApp } from "firebase-admin/app";
import { getFirestore } from "firebase-admin/firestore";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";

const APPLY = process.argv.includes("--apply");
const LINKEDIN_DOC = "docs/linkedin-agent-portal.md";
const REDDIT_DOC = "docs/reddit-agent-portal.md";
const BACKUP_DIR = "_backup/2026-08-05";

/** The three v2 skills, as `catalog/agent-runtime-manifest.json` describes them. */
const AGENTS = [
  {
    key: "karos-linkedin-setup-v2",
    name: "LinkedIn Setup",
    entrySkillDir: "products/building/linkedin-agent-v2/setup",
    heading: "### `karos-linkedin-setup-v2`",
    doc: LINKEDIN_DOC,
    parentKey: "karos-linkedin-writer-v2",
    description:
      "LinkedIn Agent v2, the run-once client setup. Stands up everything the writer and manager read: the distilled voice card, this client's LinkedIn foundation (lanes, mix, cadence, compliance block), the seeded topic catalog, the empty continuity spine, the learning record, the client's updates drop box and the manager's memory file. Eleven numbered resumable steps. Emits NO agent code — one generic writer and manager serve every client.",
  },
  {
    key: "karos-linkedin-writer-v2",
    name: "LinkedIn Agent",
    entrySkillDir: "products/building/linkedin-agent-v2",
    heading: "### `karos-linkedin-writer-v2`",
    doc: LINKEDIN_DOC,
    parentKey: null,
    description:
      "LinkedIn Agent v2, the writer. Runs on demand: each run belongs to exactly ONE identity (the company page, or a single seat) and produces that identity's post draft — one per run by default — as twelve numbered resumable steps. In this portal one press runs the manager pass first, then the writer. Draft-first: it never publishes.",
  },
  {
    key: "karos-linkedin-manager-v2",
    name: "LinkedIn Manager",
    entrySkillDir: "products/building/linkedin-agent-v2/manager",
    heading: "### `karos-linkedin-manager-v2`",
    doc: LINKEDIN_DOC,
    parentKey: "karos-linkedin-writer-v2",
    description:
      "LinkedIn Agent v2, the manager. Audits what shipped and what each identity did with it, adjusts the lane mix within bounds, and refills the topic catalog from ONE research pull cached per client and reused same-day. The only skill in the product that touches the network. It never drafts and never publishes.",
  },
  {
    key: "karos-reddit-runner",
    name: "Reddit Agent",
    entrySkillDir: "products/building/reddit-agent-v2",
    heading: "### `karos-reddit-runner`",
    doc: REDDIT_DOC,
    parentKey: null,
    description:
      "Reddit Agent v2, the runner. On demand, ONE Reddit account per run: finds live threads worth replying to, checks each subreddit's rules before writing a word, drafts TWO ways to answer each thread in that account's voice, and passes both through a mechanical anti-slop gate plus a judgment gate. Thirteen numbered resumable steps. Comments only, never original posts. NEVER publishes: no post-to-Reddit code path exists.",
  },
  {
    key: "karos-reddit-setup",
    name: "Reddit Setup",
    entrySkillDir: "products/building/reddit-agent-v2/setup",
    heading: "### `karos-reddit-setup`",
    doc: REDDIT_DOC,
    // A STEP of the runner, so it never appears on a roster of its own — the
    // structural rule, not a hardcoded key list.
    parentKey: "karos-reddit-runner",
    description:
      "Reddit Agent v2, the run-once client setup. Learns the client's corner of Reddit: which subreddits their buyers actually talk in, what each one's rules are (can the product be named, is AI-written text banned, does the account have enough history to post), and which questions keep coming back. Writes the account's voice, the claims it can back with proof, and the strategy. Emits data, never code.",
  },
] as const;

/** "Building" group appearance, matching GROUP_APPEARANCE in custom-agent-actions.ts. */
const APPEARANCE = { icon: "Bot", color: "#FBBF24" };

/**
 * The fenced instruction block under one heading in the portal doc.
 *
 * Read from the DOC rather than duplicated here, so the text under version
 * control is the text in Firestore. A drift between the two is the failure this
 * avoids: the doc is what a reviewer reads and the doc is what gets applied.
 */
function instructionsFor(docPath: string, heading: string): string {
  const doc = readFileSync(docPath, "utf8");
  const at = doc.indexOf(heading);
  if (at === -1) throw new Error(`No section "${heading}" in ${docPath}`);
  const open = doc.indexOf("```", at);
  const close = doc.indexOf("```", open + 3);
  if (open === -1 || close === -1) throw new Error(`No fenced block under "${heading}"`);
  const body = doc.slice(open + 3, close).replace(/^\n/, "").trimEnd();
  if (!body) throw new Error(`Empty instruction block under "${heading}"`);
  // The submit cores cap instructions at 12,000 chars (MAX_INSTRUCTIONS_CHARS)
  // and refuse a longer one, which would fail every run of the agent rather than
  // truncating. Better to fail here, before the doc is written.
  if (body.length > 12_000) {
    throw new Error(`"${heading}" instructions are ${body.length} chars, over the 12,000 cap`);
  }
  return body;
}

async function main() {
  const sa = JSON.parse(process.env.FIREBASE_SERVICE_ACCOUNT_KEY!);
  if (getApps().length === 0) initializeApp({ credential: cert(sa), projectId: sa.project_id });
  // Same database selection the app uses (src/lib/firebase/admin.ts): prep runs
  // its own isolated Firestore in the same project, so `FIRESTORE_DATABASE_ID=prep`
  // registers the agents where a local dev server can safely enable them without
  // touching production.
  const databaseId = process.env.FIRESTORE_DATABASE_ID || "(default)";
  const db = getFirestore(databaseId);

  console.log(`project: ${sa.project_id} · database: ${databaseId}`);
  console.log(APPLY ? "MODE: apply\n" : "MODE: dry run (pass --apply to write)\n");

  for (const agent of AGENTS) {
    const instructions = instructionsFor(agent.doc, agent.heading);
    const existing = await db
      .collection("customAgents")
      .where("key", "==", agent.key)
      .limit(1)
      .get();

    if (!existing.empty) {
      const ref = existing.docs[0];
      const before = ref.data();
      const same = before.instructions === instructions;
      console.log(
        `${agent.key}: EXISTS (${ref.id}) — instructions ${same ? "already current" : `refresh ${(before.instructions ?? "").length} → ${instructions.length} chars`}, enabled=${before.enabled}`,
      );
      if (!same && APPLY) {
        // Snapshot before modifying, per the playbook's never-overwrite-data rule.
        mkdirSync(BACKUP_DIR, { recursive: true });
        writeFileSync(
          `${BACKUP_DIR}/customAgents-${ref.id}-pre-instructions.json`,
          `${JSON.stringify({ _collection: "customAgents", _id: ref.id, ...before }, null, 2)}\n`,
        );
        await ref.ref.set({ instructions, updatedAt: Date.now() }, { merge: true });
        console.log(`  → instructions applied (snapshot in ${BACKUP_DIR}/)`);
      }
      continue;
    }

    const now = Date.now();
    const payload = {
      key: agent.key,
      name: agent.name,
      description: agent.description.slice(0, 600),
      clientBlurb: null,
      icon: APPEARANCE.icon,
      color: APPEARANCE.color,
      entrySkillDir: agent.entrySkillDir,
      skillRoots: [] as string[],
      includeClientSkills: true,
      instructions,
      // A step of another agent is hidden from every roster by isSubAgent reading
      // this field — structural, so no predicate needs editing per agent.
      ...("parentKey" in agent && agent.parentKey ? { parentKey: agent.parentKey } : {}),
      creditCost: null,
      // Upstream says "blocked" (in build, no pilot run yet), and the import rule
      // is that a blocked skill lands DISABLED so nobody fires it by accident.
      enabled: false,
      source: { path: agent.entrySkillDir, status: "blocked" },
      createdBy: "script:register-linkedin-agent-v2",
      createdAt: now,
      updatedAt: now,
    };
    console.log(
      `${agent.key}: CREATE — ${agent.entrySkillDir}, enabled=false, instructions ${instructions.length} chars`,
    );
    if (APPLY) {
      const ref = await db.collection("customAgents").add(payload);
      console.log(`  → created ${ref.id}`);
    }
  }

  console.log(
    "\nNEXT, and deliberately not done here: deploy the portal branch and the agent service,\n" +
      "then enable the three agents and grant them, then run one pilot end to end.",
  );
}

main().then(
  () => process.exit(0),
  (e) => {
    console.error("FAILED:", e);
    process.exit(1);
  },
);
