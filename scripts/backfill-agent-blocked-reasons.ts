/**
 * Copy each agent's `blocked_reason` from the lab manifest onto its
 * `customAgents` doc, so the library badge can say WHY a skill is blocked instead
 * of only that it is.
 *
 * WHY A BACKFILL. The field is written at import from now on, but every doc that
 * already exists was imported before it, and the agents that most need it are
 * exactly those: `karos-reddit-runner` (Reddit blocks datacenter egress),
 * `karos-reddit-agent` (the same, plus an unprovisioned OAuth app), and the three
 * v2 LinkedIn skills (in build, no pilot run yet). Without this they all render as
 * an unexplained "blocked", which is the confusion the field exists to end.
 *
 * Reads the manifest from the LOCAL lab clone via git, so it needs no
 * AGENTS_REPO_GITHUB_TOKEN — `origin/main` is the source of truth for what the
 * runner actually bakes, so that is the ref it reads.
 *
 * Idempotent, and it only ever ADDS or CORRECTS this one field: a doc whose reason
 * already matches is left alone, and nothing else on the doc is touched.
 *
 * Run: NODE_PATH=./node_modules npx tsx --env-file=.env.local \
 *        scripts/backfill-agent-blocked-reasons.ts [--apply]
 * `FIRESTORE_DATABASE_ID=prep` targets prep instead of production.
 */
import { cert, getApps, initializeApp } from "firebase-admin/app";
import { getFirestore } from "firebase-admin/firestore";
import { execFileSync } from "node:child_process";

const APPLY = process.argv.includes("--apply");
const LAB_REPO = "/Users/bentsionoliel/KarosLabs/karos-agents";
const MANIFEST_REF = "origin/main:catalog/agent-runtime-manifest.json";

interface ManifestSkill {
  skill_name?: string;
  status?: string;
  blocked_reason?: string;
}

function readManifest(): Map<string, { status?: string; reason?: string }> {
  const raw = execFileSync("git", ["--no-pager", "show", MANIFEST_REF], {
    cwd: LAB_REPO,
    encoding: "utf8",
    maxBuffer: 64 * 1024 * 1024,
  });
  const parsed = JSON.parse(raw) as { skills?: ManifestSkill[] };
  const out = new Map<string, { status?: string; reason?: string }>();
  for (const skill of parsed.skills ?? []) {
    if (!skill.skill_name) continue;
    out.set(skill.skill_name, {
      ...(skill.status ? { status: skill.status } : {}),
      ...(skill.blocked_reason ? { reason: skill.blocked_reason } : {}),
    });
  }
  return out;
}

async function main() {
  const sa = JSON.parse(process.env.FIREBASE_SERVICE_ACCOUNT_KEY!);
  if (getApps().length === 0) initializeApp({ credential: cert(sa), projectId: sa.project_id });
  const databaseId = process.env.FIRESTORE_DATABASE_ID || "(default)";
  const db = getFirestore(databaseId);

  const manifest = readManifest();
  console.log(`project: ${sa.project_id} · database: ${databaseId}`);
  console.log(`manifest: ${manifest.size} skills from ${MANIFEST_REF}`);
  console.log(APPLY ? "MODE: apply\n" : "MODE: dry run (pass --apply to write)\n");

  const snap = await db.collection("customAgents").get();
  let changed = 0;
  let skipped = 0;
  for (const doc of snap.docs) {
    const data = doc.data();
    const key = data.key as string;
    const entry = manifest.get(key);
    if (!entry?.reason) {
      // Either the skill is not in the manifest (a hand-written agent) or the
      // manifest records no reason. Nothing to copy, and inventing one would be
      // worse than the bare word.
      skipped++;
      continue;
    }
    const current = (data.source?.blocked_reason ?? null) as string | null;
    if (current === entry.reason) {
      skipped++;
      continue;
    }
    const lead = entry.reason.slice(0, 60).replace(/\s+/g, " ");
    console.log(`  ${key}: ${current ? "correcting" : "adding"} (${entry.reason.length} chars)`);
    console.log(`      ${lead}…`);
    changed++;
    if (!APPLY) continue;
    // Merge into the EXISTING source object rather than replacing it: path,
    // status and repoSha are what the import recorded and none of them are this
    // script's to rewrite.
    await doc.ref.set(
      { source: { ...(data.source ?? {}), blocked_reason: entry.reason }, updatedAt: Date.now() },
      { merge: true },
    );
  }
  console.log(
    `\n${changed} doc(s) ${APPLY ? "updated" : "would change"}, ${skipped} unchanged.` +
      (changed && !APPLY ? " Re-run with --apply." : ""),
  );
}

main().then(
  () => process.exit(0),
  (e) => {
    console.error(`FAILED: ${e instanceof Error ? e.message : e}`);
    process.exit(1);
  },
);
