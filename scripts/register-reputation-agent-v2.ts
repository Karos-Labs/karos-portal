/**
 * Registration of the three Reputation v2 skills as `customAgents` docs, with
 * the canonical instructions from `docs/reputation-agent-portal.md`.
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
 *  - It does not delete anything, and unlike its two predecessors it has
 *    nothing to delete: reputation replaces NO managed task type. There is no
 *    `reputation` in `ManagedTaskType`, so this integration is purely additive
 *    and there are no stranded board rows to clean up.
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
 * Run: NODE_PATH=./node_modules npx tsx --env-file=.env.local scripts/register-reputation-agent-v2.ts [--apply]
 * Without --apply it prints what it would do and writes nothing.
 * `FIRESTORE_DATABASE_ID=prep` targets the prep database instead of production.
 */
import { cert, getApps, initializeApp } from "firebase-admin/app";
import { getFirestore } from "firebase-admin/firestore";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { REPUTATION_RUNNER_KEY, REPUTATION_SETUP_KEY } from "../src/lib/custom-agent-launch";

const APPLY = process.argv.includes("--apply");
const REPUTATION_DOC = "docs/reputation-agent-portal.md";
const BACKUP_DIR = "_backup/2026-08-06";

/**
 * The two v2 skills still in the product: a runner and its setup.
 *
 * A third skill, the standalone monthly-review manager
 * (`karos-reputation-manager`), used to be registered here too. It was
 * retired in full 2026-08-29 (SCRUM-377/T-B25a) — no engine equivalent was
 * ever planned, and product ruled it fully gone rather than left dormant.
 * Removed from code and the db, do not reintroduce.
 *
 * KEYS ARE IMPORTED, never re-typed. They are the join between this script, the
 * roster predicates, the submit-core gates, the context builder and the state
 * capture — and a typo here produces a document that every one of those quietly
 * ignores, which is indistinguishable from the bug this script exists to fix.
 */
const AGENTS = [
  {
    key: REPUTATION_RUNNER_KEY,
    name: "Reputation Agent",
    entrySkillDir: "products/building/reputation-agent-v2",
    heading: `### \`${REPUTATION_RUNNER_KEY}\``,
    // THE PRODUCT. No parentKey: this is the one card a person sees, and giving
    // it one would hide the agent itself from every roster while leaving its
    // step visible — silently, with no error anywhere.
    parentKey: null,
    description:
      "Reputation Agent v2, the runner. One pulse per press: reads what has been posted about the client on their rostered review surfaces since the last pulse, triages it, and drafts a reply for each review worth answering. Checks the response ledger first so no review is ever answered twice. Anything urgent is FLAGGED and routed to the client's named contact rather than replied to. Draft-only: it holds no posting credential for any surface.",
  },
  {
    key: REPUTATION_SETUP_KEY,
    name: "Reputation Setup",
    entrySkillDir: "products/building/reputation-agent-v2/setup",
    heading: `### \`${REPUTATION_SETUP_KEY}\``,
    parentKey: REPUTATION_RUNNER_KEY,
    description:
      "Reputation Agent v2, the run-once client setup. Resolves where the client THINKS they are reviewed into the real listings per surface and market, which is the work: a business may hold a Google Business Profile under a trading name and duplicate Yelp entries from a merge. Also sets the response voice and the autonomy bounds that decide what gets escalated rather than drafted, and stands up the two ledgers. Re-runnable, and a re-run VERIFIES rather than re-seeds.",
  },
] as const;

/** "Building" group appearance, matching GROUP_APPEARANCE in custom-agent-actions.ts. */
const APPEARANCE = { icon: "MessageSquare", color: "#F472B6" };

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
    instructions: instructionsFor(REPUTATION_DOC, agent.heading),
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
      createdBy: "script:register-reputation-agent-v2",
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
      "  1. Deploy the agent service (the review_platforms egress group is new).\n" +
      "  2. Enable the RUNNER and grant it to a pilot client (its two steps stay disabled;\n" +
      "     the parent's own surface fires them, and hiding is not un-granting).\n" +
      "  3. Run setup once for that client, then one pulse end to end.\n" +
      "  4. CHECK THE EGRESS. This runner is the first with DYNAMIC egress: it reaches five\n" +
      "     review platforms, added to the `review_platforms` group in\n" +
      "     agent-service/config/egress-allowlist.json. That group is attached to the shared\n" +
      "     `custom` task type, so EVERY custom agent can now reach them - stated here because\n" +
      "     it is a widening nobody would find by reading this script.",
  );
}

main().then(
  () => process.exit(0),
  (e) => {
    console.error("FAILED:", e);
    process.exit(1);
  },
);
