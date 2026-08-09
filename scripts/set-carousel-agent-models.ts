/**
 * Moves Carousel Setup and Carousel Manager onto claude-sonnet-4-6 instead of
 * the custom task type's default (claude-opus-4-8, see agent-service/src/
 * task-types.ts AGENT_MODEL) — both are structured derivation/bookkeeping
 * work (deriving brand tokens, verifying an existing topic catalogue,
 * per-run state bookkeeping), not the creative judgment calls the actual
 * Carousel Agent (writer) makes, which stays on Opus for now.
 *
 * `effort` has no equivalent override anywhere in agent-service today (not in
 * the JSON schema, not in resolveTaskConfig) — model is the only lever
 * currently wired end to end for a custom agent's whole-run cost.
 *
 * Run: npx tsx --env-file=.env.local scripts/set-carousel-agent-models.ts [--apply]
 * Without --apply it prints what it would do and writes nothing.
 * `FIRESTORE_DATABASE_ID=prep` targets the prep database instead of production.
 */
import { cert, getApps, initializeApp } from "firebase-admin/app";
import { getFirestore } from "firebase-admin/firestore";

const APPLY = process.argv.includes("--apply");

const TARGETS: Record<string, string> = {
  "karos-carousel-setup": "claude-sonnet-4-6",
  "karos-carousel-manager": "claude-sonnet-4-6",
};

function initAdmin() {
  if (!getApps().length) {
    const raw = process.env.FIREBASE_SERVICE_ACCOUNT_KEY;
    if (!raw) throw new Error("FIREBASE_SERVICE_ACCOUNT_KEY not set");
    initializeApp({ credential: cert(JSON.parse(raw)) });
  }
  const databaseId = process.env.FIRESTORE_DATABASE_ID || "(default)";
  console.log(`>>> Firestore database: ${databaseId}`);
  return getFirestore(getApps()[0]!, databaseId);
}

async function main() {
  const db = initAdmin();
  const snap = await db.collection("customAgents").where("key", "in", Object.keys(TARGETS)).get();

  const found = new Set(snap.docs.map((d) => d.data().key as string));
  for (const key of Object.keys(TARGETS)) {
    if (!found.has(key)) console.warn(`>>> WARNING: no customAgents doc found for key "${key}"`);
  }

  for (const doc of snap.docs) {
    const data = doc.data();
    const key = data.key as string;
    const model = TARGETS[key];
    console.log(`[${doc.id}] ${key}: model ${JSON.stringify(data.model ?? null)} -> ${JSON.stringify(model)}`);
    if (APPLY) await doc.ref.update({ model });
  }

  console.log(APPLY ? "\n>>> Applied." : "\n>>> Dry run — pass --apply to write.");
}

main()
  .then(() => process.exit(0))
  .catch((e) => {
    console.error(e);
    process.exit(1);
  });
