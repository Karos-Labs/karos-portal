/**
 * Registration of the three Blog v2 skills as `customAgents` docs, with the
 * canonical instructions from `docs/blog-agent-portal.md`.
 *
 * WHY THIS EXISTS AT ALL: the portal code, the intake surface, the state capture
 * and the orchestration wiring all shipped, and the agent still did not appear on
 * any roster — because the documents were never created. Every filter downstream
 * (`agentKeyMatchesClientSlug`, `isUnlistedAgent`, the grant check) was working
 * correctly on an empty set. This is the missing step, and it is the same one
 * Reddit v2 was missing before it.
 *
 * WHY A SCRIPT rather than the admin "Import agents" flow: that flow needs
 * `AGENTS_REPO_GITHUB_TOKEN` to scan the lab repo over the GitHub API. This
 * writes the same fields the import writes — including `source.status: "blocked"`
 * and therefore `enabled: false`, exactly as `importCustomAgentsAction` would
 * derive them — so an operator without that token can still stand the four up.
 *
 * WHAT IT DELIBERATELY DOES NOT DO:
 *  - It does not ENABLE them. All four are in build with no pilot run yet, and
 *    the import rule is that a blocked skill lands disabled so nobody fires it by
 *    accident. An admin flips the switch after a pilot.
 *  - It does not GRANT them to any client. An enabled-and-granted agent whose
 *    setup has never run would let a client press Run and be refused by the
 *    submit core's second gate.
 *  - It does not delete anything. The v1 `blog_article` managed product is
 *    already gone from the code; any board rows it stranded are a cleanup
 *    script's job, not this one's.
 *
 * ONE THING TO CHECK BEFORE `--apply`: `entrySkillDir`. This lab checkout has no
 * `products/building/` directory at all — not for the newsletter, and not for
 * LinkedIn or Reddit either, whose registered paths point there — so the four
 * paths below follow the convention their siblings use rather than a directory
 * anyone verified locally. A wrong path fails at launch, loudly, and is one admin
 * edit to fix; it cannot corrupt anything. `compliance-lock` is the least certain
 * of the four, being the only sub-skill with no LinkedIn or Reddit precedent.
 *
 * Idempotent: a key that already exists has its instructions REFRESHED from the
 * doc (snapshotting the previous text to _backup/ first) and everything else left
 * alone, so re-running after a copy edit is the supported way to re-apply. It
 * never re-enables or re-disables an agent an admin has since touched.
 *
 * Run: NODE_PATH=./node_modules npx tsx --env-file=.env.local scripts/register-blog-agent-v2.ts [--apply]
 * Without --apply it prints what it would do and writes nothing.
 * `FIRESTORE_DATABASE_ID=prep` targets the prep database instead of production.
 */
import { cert, getApps, initializeApp } from "firebase-admin/app";
import { getFirestore } from "firebase-admin/firestore";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import {
  BLOG_MANAGER_V2_KEY,
  BLOG_SETUP_V2_KEY,
  BLOG_WRITER_V2_KEY,
} from "../src/lib/custom-agent-launch";

const APPLY = process.argv.includes("--apply");
const BLOG_DOC = "docs/blog-agent-portal.md";
const BACKUP_DIR = "_backup/2026-08-06";

/**
 * The three v2 skills. THREE, not four: there is no blog compliance lock — the
 * blog reuses the newsletter's `karos-compliance-lock-v2`, and the framework
 * re-decides its behaviour so it stops hand-editing blog posts and flags
 * "re-render needed" instead. The site tree is DERIVED from completed runs now,
 * so a hand-applied legal fix would be silently overwritten by the next press.
 *
 * KEYS ARE IMPORTED, never re-typed. They are the join between this script, the
 * roster predicates, the submit-core gates, the context builder and the state
 * capture — and a typo here produces a document that every one of those quietly
 * ignores, which is indistinguishable from the bug this script exists to fix.
 */
const AGENTS = [
  {
    key: BLOG_WRITER_V2_KEY,
    name: "Blog Agent",
    entrySkillDir: "products/building/blog-agent-v2",
    heading: `### \`${BLOG_WRITER_V2_KEY}\``,
    // THE PRODUCT. No parentKey: this is the one card a person sees, and giving
    // it one would hide the agent itself from every roster while leaving its two
    // steps visible — silently, with no error anywhere.
    parentKey: null,
    description:
      "Blog Agent v2, the writer. One press, one longform article, as thirteen numbered resumable steps. Walks the recent shipped newsletters, takes a subject the newsletter deliberately left unspent, and goes properly deep on it: real research with every number dated, an outline, the draft, an anti-slop and compliance pass, then a code gate that refuses the whole article rather than patching it. Delivers five files — the branded page, a paste-into-your-CMS fragment, the markdown, about.txt and publish-notes.txt. We prepare, the client publishes.",
  },
  {
    key: BLOG_SETUP_V2_KEY,
    name: "Blog Setup",
    entrySkillDir: "products/building/blog-agent-v2/setup",
    heading: `### \`${BLOG_SETUP_V2_KEY}\``,
    parentKey: BLOG_WRITER_V2_KEY,
    description:
      "Blog Agent v2, the run-once client setup. Reads the client's onboarding profile documents FIRST, completes the blog's own tokens in the shared brand file ADDITIVELY, derives their compliance patterns into the field the gate already reads, builds the cluster map and the post index, distils the voice card from their own posts, and lists their pre-v2 articles so the site rebuild keeps them. Emits data only, never code. Re-runnable, and a re-run VERIFIES rather than re-seeds.",
  },
  {
    key: BLOG_MANAGER_V2_KEY,
    name: "Blog Manager",
    entrySkillDir: "products/building/blog-agent-v2/manager",
    heading: `### \`${BLOG_MANAGER_V2_KEY}\``,
    parentKey: BLOG_WRITER_V2_KEY,
    description:
      "Blog Agent v2, the manager. The monthly maintenance pass, riding the writer's press rather than a background schedule, and never blocking the article. Watches the four things only a blog has: whether the client actually published what we gave them and for how long it has sat, whether the internal links are real or still dead (and repairs the ones whose target now exists), whether the subject runway is thinning, and the performance read in honest lighter mode.",
  },
] as const;

/** "Building" group appearance, matching GROUP_APPEARANCE in custom-agent-actions.ts. */
const APPEARANCE = { icon: "PenLine", color: "#34D399" };

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

  // Read every instruction block BEFORE writing anything. Three agents where the
  // last one's heading is missing would otherwise leave two registered and the
  // product half-standing — and the writer alone, with no setup skill to stand
  // its client up, is the worse half to be left with.
  const prepared = AGENTS.map((agent) => ({
    agent,
    instructions: instructionsFor(BLOG_DOC, agent.heading),
  }));

  for (const { agent, instructions } of prepared) {
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
        `${agent.key}: EXISTS (${ref.id}) — instructions ${same ? "already current" : `refresh ${(before.instructions ?? "").length} → ${instructions.length} chars`}, enabled=${before.enabled}, parentKey=${before.parentKey ?? "(none)"}`,
      );
      // The nesting is what makes this product ONE card rather than four, so a
      // doc whose parentKey has drifted is reported even when the text has not.
      // Not auto-corrected: an existing doc's shape is an admin's to change, and
      // a script that silently re-parents agents is one bad constant away from
      // hiding a product.
      const wantParent = agent.parentKey ?? null;
      if ((before.parentKey ?? null) !== wantParent) {
        console.log(
          `  ! parentKey is ${before.parentKey ?? "(none)"}, expected ${wantParent ?? "(none)"} —` +
            " fix by hand in the admin library; this script will not re-parent a live doc.",
        );
      }
      if (!same && APPLY) {
        // Snapshot before modifying, per the playbook's never-overwrite-data rule.
        // THE DATABASE IS IN THE FILENAME: prep and production hold the same
        // document ids, so without it the second run clobbers the first's
        // snapshot.
        mkdirSync(BACKUP_DIR, { recursive: true });
        const dbTag = databaseId === "(default)" ? "prod" : databaseId;
        writeFileSync(
          `${BACKUP_DIR}/customAgents-${ref.id}-${dbTag}-pre-instructions.json`,
          `${JSON.stringify({ _collection: "customAgents", _id: ref.id, _database: databaseId, ...before }, null, 2)}\n`,
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
      // this field — structural, so no predicate needs editing per agent. Written
      // only when set: an explicit `parentKey: null` on the writer would still be
      // falsy to isSubAgent, but the absent field is what the other products'
      // parents look like and the library groups on presence.
      ...(agent.parentKey ? { parentKey: agent.parentKey } : {}),
      creditCost: null,
      // In build, no pilot run yet, and the import rule is that a blocked skill
      // lands DISABLED so nobody fires it by accident.
      enabled: false,
      source: { path: agent.entrySkillDir, status: "blocked" },
      createdBy: "script:register-blog-agent-v2",
      createdAt: now,
      updatedAt: now,
    };
    console.log(
      `${agent.key}: CREATE — ${agent.entrySkillDir}, enabled=false, parentKey=${agent.parentKey ?? "(none)"}, instructions ${instructions.length} chars`,
    );
    if (APPLY) {
      const ref = await db.collection("customAgents").add(payload);
      console.log(`  → created ${ref.id}`);
    }
  }

  console.log(
    "\nNEXT, and deliberately not done here:\n" +
      "  1. Deploy the agent service (blog_article was removed from its TASK_TYPES).\n" +
      "  2. Enable the WRITER and grant it to a pilot client (its two steps stay disabled;\n" +
      "     the parent's own surface fires them, and hiding is not un-granting).\n" +
      "  3. Run setup once for that client, then one writer run end to end.\n" +
      "  4. THE BLOG NEEDS THE NEWSLETTER. Its writer picks a subject from the newsletter's\n" +
      "     published handoff, so a client with no shipped newsletter issue captured in\n" +
      "     `newsletterLedger` has nothing to write about and will HALT. Run the newsletter\n" +
      "     for the pilot client first.",
  );
}

main().then(
  () => process.exit(0),
  (e) => {
    console.error("FAILED:", e);
    process.exit(1);
  },
);
