/**
 * Find (and, only when told to, remove) duplicate asset documents — the ones
 * the product owner scrolled past on his content calendar on the 30 Jul call.
 *
 * Two signals, deliberately kept apart:
 *
 *   HIGH CONFIDENCE — assets of one client sharing a `meta.gcsPath`. Two
 *     documents pointing at the same object in the bucket ARE the same clip.
 *     These were minted by the bulk-upload "complete" step, which registered a
 *     clip unconditionally, so a replayed call (flaky network, double click,
 *     resumed upload) wrote a second document. That step is idempotent now;
 *     this cleans up what it already wrote.
 *
 *   HEURISTIC — assets of one client sharing a day and a title, with no
 *     gcsPath at all: the older duplicates, from before bulk upload existed.
 *     A title collision is a guess, not a fact, so this section is REPORT
 *     ONLY. `--apply` never touches it. Read it and delete by hand.
 *
 * The keep/drop rule is imported from src/lib/calendar-dedupe — the same
 * function the calendar itself uses to collapse duplicate cells — so this tool
 * and the screen can never disagree about which copy is the real one.
 *
 *   npx tsx scripts/find-duplicate-assets.ts            # dry run — prints the plan
 *   npx tsx scripts/find-duplicate-assets.ts --apply    # deletes the gcsPath losers
 *   npx tsx scripts/find-duplicate-assets.ts --client=<id>   # scope to one client
 *
 * DRY RUN IS THE DEFAULT ON PURPOSE. The credentials in .env.local point at
 * production Firestore, and this is the only code path in the portal that
 * deletes an asset. Read the printed plan first, then re-run with --apply.
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
  status?: string;
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
        `${m.status ?? "—"}  "${m.title}"`,
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

  console.log(
    apply
      ? "APPLYING duplicate-asset cleanup — deletes non-survivors in gcsPath groups only.\n"
      : "DRY RUN — nothing is written. Pass --apply to delete the gcsPath duplicates.\n",
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
      scheduledAt: data.scheduledAt as number | undefined,
      publishedAt: data.publishedAt as number | undefined,
      createdAt: (data.createdAt as number) ?? 0,
      meta: data.meta as Record<string, unknown> | undefined,
      status: data.status as string | undefined,
      _ref: d.ref,
    };
  });

  console.log(`Scanned ${rows.length} asset(s)${clientArg ? ` for client ${clientArg}` : " across all clients"}.`);

  const all = findDuplicateGroups(rows);
  const exact = all.filter((g) => g.kind === "gcsPath");
  const heuristic = all.filter((g) => g.kind === "titleDay");

  // ── High confidence ──────────────────────────────────────────────────
  console.log(`\n=== SAME gcsPath — high confidence (${exact.length} group(s)) ===`);
  if (exact.length === 0) console.log("  none");
  for (const [clientId, groups] of byClient(exact)) {
    console.log(`\n[${clientNames.get(clientId) ?? clientId}]`);
    for (const g of groups) printGroup(g, true);
  }

  // ── Heuristic ────────────────────────────────────────────────────────
  console.log(
    `\n=== SAME client + day + title, no gcsPath — LOWER CONFIDENCE, report only (${heuristic.length} group(s)) ===`,
  );
  console.log("  Never deleted by --apply. A title collision is a guess; review these by hand.");
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
    console.log("Dry run — nothing changed. Re-run with --apply to delete the high-confidence duplicates.");
    return;
  }
  if (losers.length === 0) {
    console.log("Nothing to delete.");
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
