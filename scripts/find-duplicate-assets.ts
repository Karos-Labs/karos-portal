/**
 * Find (and, only when told to, remove) duplicate asset documents — the ones
 * the product owner scrolled past on his content calendar on the 30 Jul call.
 *
 * Two signals, deliberately kept apart:
 *
 *   HIGH CONFIDENCE — assets of one client sharing a `meta.gcsPath` WHOSE
 *     PLACEMENT AGREES: every copy on one day, or undated. These were minted by
 *     the bulk-upload "complete" step, which registered a clip unconditionally,
 *     so a replayed call (flaky network, double click, resumed upload) wrote a
 *     second document. That step is idempotent now; this cleans up what it
 *     already wrote. A clip deliberately reused on two different days is NOT a
 *     duplicate and is never grouped — see lib/calendar-dedupe.
 *
 *   HEURISTIC — assets of one client sharing a day and a title, with no
 *     gcsPath at all: the older duplicates, from before bulk upload existed.
 *     A title collision is a guess, not a fact, so this section is REPORT
 *     ONLY. `--apply` never touches it, and the calendar never acts on it
 *     either. Read it and delete by hand.
 *
 * The keep/drop rule is imported from src/lib/calendar-dedupe — the same
 * function the calendar itself uses to collapse duplicate cells — so this tool
 * and the screen can never disagree about which copy is the real one.
 *
 *   npx tsx scripts/find-duplicate-assets.ts                          # dry run, every client
 *   npx tsx scripts/find-duplicate-assets.ts --client=<id>            # dry run, one client
 *   npx tsx scripts/find-duplicate-assets.ts --client=<id> --apply    # delete that client's losers
 *
 * DRY RUN IS THE DEFAULT ON PURPOSE, and `--apply` REQUIRES `--client`. The
 * credentials in .env.local point at production Firestore and this is the only
 * code path in the portal that deletes an asset, so a fleet-wide unattended
 * delete is not something it can be asked to do — one client per invocation,
 * the same rule scripts/refresh-apply.ts holds. Read the printed plan first.
 */

import { readFileSync } from "node:fs";
import { resolve } from "node:path";

function loadEnvFile(path: string) {
  try {
    for (const line of readFileSync(path, "utf-8").split("\n")) {
      const t = line.trim();
      if (!t || t.startsWith("#")) continue;
      const i = t.indexOf("=");
      if (i === -1) continue;
      const k = t.slice(0, i).trim();
      let v = t.slice(i + 1).trim();
      if ((v.startsWith('"') && v.endsWith('"')) || (v.startsWith("'") && v.endsWith("'"))) v = v.slice(1, -1);
      if (!process.env[k]) process.env[k] = v;
    }
  } catch {
    // .env.local may not exist — credentials can come from the environment.
  }
}
loadEnvFile(resolve(process.cwd(), ".env.local"));
loadEnvFile(resolve(process.cwd(), ".env"));

import { initializeApp, cert, getApps } from "firebase-admin/app";
import { getFirestore } from "firebase-admin/firestore";
import { findDuplicateGroups, type CalendarDedupeAsset, type DuplicateGroup } from "../src/lib/calendar-dedupe";

type AssetRow = CalendarDedupeAsset & {
  _ref: FirebaseFirestore.DocumentReference;
};

/** Firestore batches cap at 500 writes; stay well under it. */
const BATCH_LIMIT = 400;

function initAdmin() {
  if (getApps().length) return;
  const raw = process.env.FIREBASE_SERVICE_ACCOUNT_KEY;
  if (raw) {
    initializeApp({ credential: cert(JSON.parse(raw)) });
    return;
  }
  const projectId = process.env.FIREBASE_PROJECT_ID;
  const clientEmail = process.env.FIREBASE_CLIENT_EMAIL;
  const privateKey = process.env.FIREBASE_PRIVATE_KEY?.replace(/\\n/g, "\n");
  if (projectId && clientEmail && privateKey) {
    initializeApp({ credential: cert({ projectId, clientEmail, privateKey }) });
    return;
  }
  throw new Error(
    "No Firebase credentials found. Set FIREBASE_SERVICE_ACCOUNT_KEY or " +
      "FIREBASE_PROJECT_ID + FIREBASE_CLIENT_EMAIL + FIREBASE_PRIVATE_KEY in .env.local",
  );
}

function stamp(ms?: number): string {
  return typeof ms === "number" && Number.isFinite(ms) ? new Date(ms).toISOString() : "—";
}

function printGroup(group: DuplicateGroup<AssetRow>, deletable: boolean) {
  console.log(`\n  ${group.kind === "gcsPath" ? "path" : "same day + title"}: ${group.label}`);
  for (const m of group.members) {
    const keep = m.id === group.survivor.id;
    const verdict = keep ? "KEEP" : deletable ? "drop" : "dup ";
    console.log(
      `    ${verdict} ${m.id}  created ${stamp(m.createdAt)}  scheduled ${stamp(m.scheduledAt)}  ` +
        `published ${stamp(m.publishedAt)}  ${m.status ?? "—"}  "${m.title}"`,
    );
  }
}

function byClient(groups: DuplicateGroup<AssetRow>[]): Map<string, DuplicateGroup<AssetRow>[]> {
  const out = new Map<string, DuplicateGroup<AssetRow>[]>();
  for (const g of groups) {
    const bucket = out.get(g.clientId);
    if (bucket) bucket.push(g);
    else out.set(g.clientId, [g]);
  }
  return out;
}

async function main() {
  const apply = process.argv.includes("--apply");
  const clientArg = process.argv.find((a) => a.startsWith("--client="))?.slice("--client=".length);

  // --client is mandatory for --apply, and single. Deleting documents across
  // every client in the fleet in one unattended pass is not a capability this
  // script should have: the operator has to name the client whose plan they
  // just read. Same fence scripts/refresh-apply.ts holds on its write path.
  if (apply && !clientArg) {
    console.error(
      "REFUSING TO RUN — --apply requires --client=<id>.\n\n" +
        "  npx tsx scripts/find-duplicate-assets.ts --client=<id>            # read the plan first\n" +
        "  npx tsx scripts/find-duplicate-assets.ts --client=<id> --apply    # then delete\n\n" +
        "One client per invocation. Run the dry run with no --client to see which clients " +
        "have duplicates at all, then apply to them one at a time.",
    );
    process.exit(1);
    return;
  }

  console.log(
    apply
      ? `APPLYING duplicate-asset cleanup for client ${clientArg} — deletes non-survivors in gcsPath groups only.\n`
      : "DRY RUN — nothing is written. Pass --client=<id> --apply to delete that client's gcsPath duplicates.\n",
  );

  initAdmin();
  const db = getFirestore();
  db.settings({ ignoreUndefinedProperties: true });

  const clientSnap = await db.collection("clients").get();
  const clientNames = new Map(clientSnap.docs.map((d) => [d.id, (d.data()?.name as string) ?? d.id]));

  const assetQuery = clientArg
    ? db.collection("assets").where("clientId", "==", clientArg)
    : db.collection("assets");
  const assetSnap = await assetQuery.get();

  const rows: AssetRow[] = assetSnap.docs.map((d) => {
    const data = d.data();
    return {
      id: d.id,
      clientId: (data.clientId as string) ?? "",
      title: (data.title as string) ?? "",
      status: data.status as AssetRow["status"],
      scheduledAt: data.scheduledAt as number | undefined,
      publishedAt: data.publishedAt as number | undefined,
      publishMode: data.publishMode as string | undefined,
      publishError: data.publishError as string | undefined,
      createdAt: (data.createdAt as number) ?? 0,
      meta: data.meta as Record<string, unknown> | undefined,
      _ref: d.ref,
    };
  });

  // A document with no clientId belongs to nobody, and defaulting it to "" would
  // pool every such row into one synthetic client — where two unrelated orphans
  // sharing a path or a title would be reported as each other's duplicate. Drop
  // them from the scan and say so, rather than inventing a client for them.
  const orphans = rows.filter((r) => !r.clientId.trim());
  const scannable = rows.filter((r) => r.clientId.trim());

  console.log(
    `Scanned ${scannable.length} asset(s)${clientArg ? ` for client ${clientArg}` : " across all clients"}.`,
  );
  if (orphans.length) {
    console.log(
      `Skipped ${orphans.length} asset(s) with no clientId — they cannot be attributed to a client, ` +
        "so they are never grouped or deleted. Ids: " +
        orphans
          .slice(0, 20)
          .map((o) => o.id)
          .join(", ") +
        (orphans.length > 20 ? ", …" : ""),
    );
  }

  const all = findDuplicateGroups(scannable);
  const exact = all.filter((g) => g.kind === "gcsPath");
  const heuristic = all.filter((g) => g.kind === "titleDay");

  // ── High confidence ──────────────────────────────────────────────────
  console.log(
    `\n=== SAME gcsPath, agreeing placement — high confidence (${exact.length} group(s)) ===`,
  );
  console.log(
    "  One clip, written more than once. A clip reused on two DIFFERENT days is two real posts " +
      "and is not grouped here at all.",
  );
  if (exact.length === 0) console.log("  none");
  for (const [clientId, groups] of byClient(exact)) {
    console.log(`\n[${clientNames.get(clientId) ?? clientId}]`);
    for (const g of groups) printGroup(g, true);
  }

  // ── Heuristic ────────────────────────────────────────────────────────
  console.log(
    `\n=== SAME client + day + title, no gcsPath — LOWER CONFIDENCE, report only (${heuristic.length} group(s)) ===`,
  );
  console.log(
    "  Never deleted by --apply, and never hidden from the calendar either — a title collision is " +
      "a guess, and the ordinary shape of a templated content plan. Review these by hand.",
  );
  if (heuristic.length === 0) console.log("  none");
  for (const [clientId, groups] of byClient(heuristic)) {
    console.log(`\n[${clientNames.get(clientId) ?? clientId}]`);
    for (const g of groups) printGroup(g, false);
  }

  const losers = exact.flatMap((g) => g.members.filter((m) => m.id !== g.survivor.id));
  const heuristicExtras = heuristic.reduce((n, g) => n + g.members.length - 1, 0);

  console.log(
    `\n${exact.length} high-confidence group(s) · ${losers.length} document(s) to delete · ` +
      `${heuristic.length} heuristic group(s) holding ${heuristicExtras} extra document(s), left alone.`,
  );

  if (!apply) {
    console.log(
      "Dry run — nothing changed. Re-run with --client=<id> --apply to delete that client's " +
        "high-confidence duplicates.",
    );
    return;
  }
  if (losers.length === 0) {
    console.log("Nothing to delete.");
    return;
  }

  // Belt and braces on the --client fence above: the query was already scoped,
  // so a row belonging to anyone else means the scope did not hold. Delete
  // nothing rather than reason about why.
  const foreign = losers.filter((l) => l.clientId !== clientArg);
  if (foreign.length) {
    console.error(
      `\nREFUSING TO DELETE — ${foreign.length} document(s) in the plan do not belong to client ` +
        `${clientArg}: ${foreign.map((f) => `${f.id} (${f.clientId})`).join(", ")}.`,
    );
    process.exit(1);
    return;
  }

  for (let i = 0; i < losers.length; i += BATCH_LIMIT) {
    const batch = db.batch();
    for (const loser of losers.slice(i, i + BATCH_LIMIT)) batch.delete(loser._ref);
    await batch.commit();
  }
  console.log(`Deleted ${losers.length} duplicate document(s).`);
}

// Only when invoked directly — importing this file must never open a Firestore
// connection, let alone delete from one.
if (require.main === module) {
  main()
    .then(() => process.exit(0))
    .catch((e) => {
      console.error(e);
      process.exit(1);
    });
}
