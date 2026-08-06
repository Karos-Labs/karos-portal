/**
 * Registration of the four Newsletter v2 skills as `customAgents` docs, with the
 * canonical instructions from `docs/newsletter-agent-portal.md`.
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
 *  - It does not delete anything. The v1 `newsletter_issue` managed product is
 *    already gone from the code, and its stranded board rows are
 *    `scripts/cleanup-legacy-newsletter-tasks.ts`'s job, not this script's.
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
 * Run: NODE_PATH=./node_modules npx tsx --env-file=.env.local scripts/register-newsletter-agent-v2.ts [--apply]
 * Without --apply it prints what it would do and writes nothing.
 * `FIRESTORE_DATABASE_ID=prep` targets the prep database instead of production.
 */
import { cert, getApps, initializeApp } from "firebase-admin/app";
import { getFirestore } from "firebase-admin/firestore";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import {
  COMPLIANCE_LOCK_V2_KEY,
  NEWSLETTER_MANAGER_V2_KEY,
  NEWSLETTER_SETUP_V2_KEY,
  NEWSLETTER_WRITER_V2_KEY,
} from "../src/lib/custom-agent-launch";

const APPLY = process.argv.includes("--apply");
const NEWSLETTER_DOC = "docs/newsletter-agent-portal.md";
const BACKUP_DIR = "_backup/2026-08-06";

/**
 * The four v2 skills.
 *
 * KEYS ARE IMPORTED, never re-typed. They are the join between this script, the
 * roster predicates, the submit-core gates, the context builder and the state
 * capture — and a typo here produces a document that every one of those quietly
 * ignores, which is indistinguishable from the bug this script exists to fix.
 */
const AGENTS = [
  {
    key: NEWSLETTER_WRITER_V2_KEY,
    name: "Newsletter Agent",
    entrySkillDir: "products/building/newsletter-agent-v2",
    heading: `### \`${NEWSLETTER_WRITER_V2_KEY}\``,
    // THE PRODUCT. No parentKey: this is the one card a person sees, and giving
    // it one would hide the agent itself from every roster while leaving its
    // three steps visible — silently, with no error anywhere.
    parentKey: null,
    description:
      "Newsletter Agent v2, the writer. One run prepares ONE issue: claims its number in the issue index before any other work, picks a topic from the pool rather than inventing one, drafts in the client's distilled voice, and renders the email in dark and light from the same command. Holds the whole issue rather than editing around a compliance rule. We prepare it; the client sends it from their own platform.",
  },
  {
    key: NEWSLETTER_SETUP_V2_KEY,
    name: "Newsletter Setup",
    entrySkillDir: "products/building/newsletter-agent-v2/setup",
    heading: `### \`${NEWSLETTER_SETUP_V2_KEY}\``,
    parentKey: NEWSLETTER_WRITER_V2_KEY,
    description:
      "Newsletter Agent v2, the run-once client setup. Builds the five standing files every weekly run reads: the content foundation, the voice card distilled from the client's own past issues, the seeded topic pool, the niche watch-list, and the issue index the writer claims numbers in. Re-runnable, and a re-run VERIFIES rather than re-seeds — re-seeding an index that holds rows would erase issues that already went out.",
  },
  {
    key: NEWSLETTER_MANAGER_V2_KEY,
    name: "Newsletter Manager",
    entrySkillDir: "products/building/newsletter-agent-v2/manager",
    heading: `### \`${NEWSLETTER_MANAGER_V2_KEY}\``,
    parentKey: NEWSLETTER_WRITER_V2_KEY,
    description:
      "Newsletter Agent v2, the manager. Refills the topic pool from research and refreshes the voice card when new reference issues arrive, reading what actually shipped and what the client did with it. Keeps the pool healthy rather than merely non-empty — the writer holds a run on an empty one. It never drafts and never sends.",
  },
  {
    key: COMPLIANCE_LOCK_V2_KEY,
    name: "Newsletter Compliance Lock",
    entrySkillDir: "products/building/newsletter-agent-v2/compliance-lock",
    heading: `### \`${COMPLIANCE_LOCK_V2_KEY}\``,
    parentKey: NEWSLETTER_WRITER_V2_KEY,
    description:
      "Newsletter Agent v2, the compliance lock. Checks a prepared issue against the content foundation's compliance section, the brand file's, and the client's own banned phrases together. REFUSES rather than rewrites: a violation holds the whole issue and names the rule and the phrase that broke it. An unanswered compliance question is not a violation — it rides the issue as a review flag.",
  },
] as const;

/** "Building" group appearance, matching GROUP_APPEARANCE in custom-agent-actions.ts. */
const APPEARANCE = { icon: "Mail", color: "#60A5FA" };

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

  // Read every instruction block BEFORE writing anything. Four agents where the
  // last one's heading is missing would otherwise leave three registered and the
  // product half-standing — and the writer alone, with no setup skill to stand
  // its client up, is the worse half to be left with.
  const prepared = AGENTS.map((agent) => ({
    agent,
    instructions: instructionsFor(NEWSLETTER_DOC, agent.heading),
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
      createdBy: "script:register-newsletter-agent-v2",
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
      "  1. Check entrySkillDir against the lab repo — this checkout has no products/building/.\n" +
      "  2. Enable the WRITER and grant it to a pilot client (its three steps stay disabled;\n" +
      "     the parent's own surface fires them, and hiding is not un-granting).\n" +
      "  3. Run setup once for that client, then one writer run end to end.",
  );
}

main().then(
  () => process.exit(0),
  (e) => {
    console.error("FAILED:", e);
    process.exit(1);
  },
);
