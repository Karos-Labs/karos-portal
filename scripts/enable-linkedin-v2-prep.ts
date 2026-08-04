/**
 * Turn the LinkedIn v2 agents ON in the **prep** database and grant them to a
 * client, so a local dev server has something to click.
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
 * The production docs stay `enabled: false` until the branch is deployed. See the
 * LinkedIn v2 section of ROLLBACK.md.
 *
 * Run: FIRESTORE_DATABASE_ID=prep NODE_PATH=./node_modules npx tsx \
 *        --env-file=.env.local scripts/enable-linkedin-v2-prep.ts [--apply] [--client <id>]
 */
import { cert, getApps, initializeApp } from "firebase-admin/app";
import { getFirestore } from "firebase-admin/firestore";

const APPLY = process.argv.includes("--apply");
const clientArg = process.argv.indexOf("--client");
/** Karos Labs — the pilot client, and the one with real LinkedIn intake on file. */
const DEFAULT_CLIENT = "iZLc0mtwSFXNKE2KkC2d";
const CLIENT_ID = clientArg > -1 ? process.argv[clientArg + 1] : DEFAULT_CLIENT;

const KEYS = [
  "karos-linkedin-setup-v2",
  "karos-linkedin-writer-v2",
  "karos-linkedin-manager-v2",
] as const;

async function main() {
  const databaseId = process.env.FIRESTORE_DATABASE_ID;
  if (databaseId !== "prep") {
    throw new Error(
      `This script only runs against the prep database (FIRESTORE_DATABASE_ID=prep), and it is ${databaseId ?? "unset, which means production"}. ` +
        "Enabling these agents in production before the portal branch is deployed would offer a live client a run with no data attached.",
    );
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
  for (const key of KEYS) {
    const snap = await db.collection("customAgents").where("key", "==", key).limit(1).get();
    if (snap.empty) {
      console.log(`  ${key}: MISSING — run register-linkedin-agent-v2.ts against prep first`);
      continue;
    }
    const ref = snap.docs[0];
    ids.push(ref.id);
    console.log(`  ${key}: ${ref.id} — enabled ${ref.data().enabled} → true`);
    if (APPLY) await ref.ref.set({ enabled: true, updatedAt: Date.now() }, { merge: true });
  }

  const granted: string[] = client.data()!.customAgentIds ?? [];
  const missing = ids.filter((id) => !granted.includes(id));
  console.log(`\ngrant: ${missing.length} of ${ids.length} to add (${granted.length} already on the client)`);
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
        `Then open http://localhost:3000/clients/${CLIENT_ID}/agents`,
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
