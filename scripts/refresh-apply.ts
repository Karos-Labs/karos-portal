/**
 * CD-G7 — per-client data COMPLETION refresh, step 2 of 2: the CLI write path.
 *
 * Takes one per-client proposal JSON produced by a refresh team from a
 * scripts/refresh-export.ts dump and lands it in Firestore. Dry run by default;
 * `--apply` performs the writes, in a single atomic batch per client.
 *
 *   npx tsx scripts/refresh-apply.ts --file=/abs/path/geektime.proposal.json --client=<id>
 *   npx tsx scripts/refresh-apply.ts --file=... --client=<id> --apply
 *
 * THE RULES NOW LIVE IN src/lib/refresh-apply-core.ts — no-delete, the shrink
 * floors, the docType/tier no-leak table, fill-only profile fields, competitor
 * id ownership, and the palette gates. They moved there so the admin Ops Import
 * page enforces the SAME fences instead of a drifting copy of them; this file is
 * now argument parsing, Firestore I/O, and printing. Behaviour is unchanged.
 *
 * Schema: docs/qa-sweep-2026-07/refresh/BRIEF-TEMPLATE.md
 * Runbook (the UI equivalent): docs/qa-sweep-2026-07/refresh/OPS-IMPORT.md
 */
import path from "node:path";
import { readFileSync } from "node:fs";

import {
  buildWriteOps,
  formatPlanLines,
  validateProposal,
  type CurrentState,
  type Row,
} from "../src/lib/refresh-apply-core";

const ROOT = path.resolve(__dirname, "..");

function loadEnv() {
  for (const line of readFileSync(path.join(ROOT, ".env.local"), "utf8").split("\n")) {
    const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*)\s*$/);
    if (!m) continue;
    let v = m[2];
    if ((v.startsWith('"') && v.endsWith('"')) || (v.startsWith("'") && v.endsWith("'"))) v = v.slice(1, -1);
    if (!(m[1] in process.env)) process.env[m[1]] = v;
  }
}

class ProposalError extends Error {}

function isPlainObject(v: unknown): v is Row {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

/* ── Main ────────────────────────────────────────────────────────────── */

async function main() {
  const argv = process.argv.slice(2);
  const flag = (name: string): string | undefined => {
    const hit = argv.find((a) => a.startsWith(`--${name}=`));
    return hit ? hit.slice(name.length + 3) : undefined;
  };
  const apply = argv.includes("--apply");
  const fileArg = flag("file") ?? argv.find((a) => !a.startsWith("--"));
  const clientArg = flag("client");

  if (!fileArg || !clientArg) {
    console.error(
      "Usage:\n" +
        "  npx tsx scripts/refresh-apply.ts --file=<proposal.json> --client=<clientId> [--apply]\n\n" +
        "--client is mandatory and must match the proposal's clientId — one client per invocation.",
    );
    process.exit(1);
    return;
  }

  console.log(
    apply ? "APPLYING refresh proposal\n" : "DRY RUN — nothing is written. Pass --apply to write.\n",
  );

  const proposalPath = path.resolve(process.cwd(), fileArg);
  let proposal: unknown;
  try {
    proposal = JSON.parse(readFileSync(proposalPath, "utf8"));
  } catch (e) {
    console.error(`Could not read/parse ${proposalPath}: ${String(e)}`);
    process.exit(1);
    return;
  }
  if (!isPlainObject(proposal)) throw new ProposalError("The proposal must be a JSON object.");

  loadEnv();
  const { initializeApp, cert } = await import("firebase-admin/app");
  const { getFirestore } = await import("firebase-admin/firestore");
  initializeApp({ credential: cert(JSON.parse(process.env.FIREBASE_SERVICE_ACCOUNT_KEY!)) });
  const db = getFirestore();

  const clientRef = db.collection("clients").doc(clientArg);
  const clientSnap = await clientRef.get();
  if (!clientSnap.exists) {
    console.error(`No client with id ${clientArg}.`);
    process.exit(1);
    return;
  }
  const storedClient = clientSnap.data() as Row;
  const clientName = String(storedClient.name ?? clientArg);

  const [docsSnap, compSnap] = await Promise.all([
    db.collection("clientContextDocs").where("clientId", "==", clientArg).get(),
    db.collection("clientCompetitors").where("clientId", "==", clientArg).get(),
  ]);

  const storedDocs = new Map<string, Row>();
  for (const d of docsSnap.docs) {
    const v = d.data() as Row;
    storedDocs.set(`${String(v.docType)}@${String(v.tier)}`, { id: d.id, ...v });
  }
  const storedComps: Row[] = compSnap.docs.map((d): Row => ({ id: d.id, ...(d.data() as Row) }));

  const current: CurrentState = {
    clientId: clientArg,
    clientName,
    client: storedClient,
    docs: storedDocs,
    competitors: storedComps,
  };

  const result = validateProposal(proposal, current);
  if (!result.ok) {
    console.error(`\nPROPOSAL REJECTED — ${result.errors.length} problem(s):\n`);
    for (const e of result.errors) console.error(`  ✗ ${e}`);
    console.error("\nNothing was written. Fix the proposal and re-run.");
    process.exit(1);
    return;
  }
  const plan = result.plan;

  for (const line of formatPlanLines(plan)) console.log(line);

  if (plan.warnings.length) {
    console.log(`\nWARNINGS (${plan.warnings.length}) — not blocking, but read them:`);
    for (const w of plan.warnings) console.log(`  ! ${w}`);
  }

  const { docWrites, compWrites, clientTouched, verifyTotal, totalWrites } = plan.counts;

  if (verifyTotal > 0) {
    console.log(
      `\n⚑ ${verifyTotal} [VERIFY] token(s) across internal-tier documents — every one is a claim the team ` +
        "could not confirm. They land in the internal tier only and must be resolved with Albert.",
    );
  }

  if (!totalWrites) {
    console.log("\nNo changes — the proposal matches what is already stored.");
    return;
  }

  if (!apply) {
    console.log(
      `\nDRY RUN — ${docWrites} document write(s), ${compWrites} competitor write(s), ` +
        `${clientTouched ? 1 : 0} client-document update. Re-run with --apply.`,
    );
    return;
  }

  const now = Date.now();
  const batch = db.batch();
  for (const op of buildWriteOps(plan, now)) {
    if (op.kind === "create") {
      batch.set(db.collection(op.collection).doc(), op.data);
    } else {
      batch.set(db.collection(op.collection).doc(op.id), op.data, { merge: true });
    }
  }
  await batch.commit();

  console.log(
    `\nAPPLIED — ${docWrites} document(s), ${compWrites} competitor row(s), ` +
      `${clientTouched ? 1 : 0} client document. Committed atomically at ${new Date(now).toISOString()}.`,
  );
  console.log("Review on localhost now — the portal reads the same Firestore this just wrote.");
}

if (require.main === module) {
  main().catch((e) => {
    console.error(e instanceof ProposalError ? `PROPOSAL REJECTED: ${e.message}` : e);
    process.exit(1);
  });
}
