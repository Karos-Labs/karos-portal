/**
 * Mark an already-imported lab client as lab-owned, the way
 * scripts/import-lab-client.ts now marks a new one:
 *
 *   - `profileSource: "lab"` on the client, which puts it in the intel
 *     pipeline's lab mode (Regenerate keeps its curated documents and brand and
 *     adds the Intel Report, the SEO/GEO capture and the action plan);
 *   - `source: "lab"` on the competitor rows the importer seeded from the lab's
 *     profile/competitor-tracking.json, which it used to write as "report" —
 *     the one source every analysis run deletes.
 *
 * Written for N°3 Courchevel 1850 (slug n3), imported on 2026-09-07 before
 * either marker existed.
 *
 * WHICH COMPETITOR ROWS. Only rows that are still exactly what the importer
 * wrote: source "report", a name matching an ACTIVE entry of the lab file
 * (normalized the way the importer dedupes names), and no analysis on them yet
 * (no positioning, no strengths, no weaknesses). A row an analysis run has
 * already enriched is left alone and reported.
 *
 * REFUSES a client that already has an Intel Report unless --force is passed:
 * the report means the pipeline has run there, and a run before this marker
 * existed replaced every document. Marking such a client would freeze the
 * pipeline's documents as if the lab had written them.
 *
 * Touches nothing else: no document, no brand field, no asset.
 *
 * Run (dry run is the default; the database must be named explicitly):
 *   FIRESTORE_DATABASE_ID=prep npx tsx scripts/mark-lab-profile-client.ts n3
 *   FIRESTORE_DATABASE_ID=prep npx tsx scripts/mark-lab-profile-client.ts n3 --apply
 *   FIRESTORE_DATABASE_ID="(default)" npx tsx scripts/mark-lab-profile-client.ts n3 --apply
 * Flags: --lab-root=PATH (default ~/karos-agents), --force, --revert (remove
 * profileSource and put the matched lab rows back to "report").
 */

import { readFileSync, existsSync } from "node:fs";
import { homedir } from "node:os";
import { join, resolve } from "node:path";

// ── Load .env.local before any Firebase imports ──────────────────────────────
function loadEnvFile(path: string) {
  try {
    const content = readFileSync(path, "utf-8");
    for (const line of content.split("\n")) {
      const trimmed = line.trim();
      if (!trimmed || trimmed.startsWith("#")) continue;
      const eqIdx = trimmed.indexOf("=");
      if (eqIdx === -1) continue;
      const key = trimmed.slice(0, eqIdx).trim();
      let val = trimmed.slice(eqIdx + 1).trim();
      if ((val.startsWith('"') && val.endsWith('"')) || (val.startsWith("'") && val.endsWith("'"))) {
        val = val.slice(1, -1);
      }
      if (!process.env[key]) process.env[key] = val;
    }
  } catch {
    // .env.local may not exist — credentials can come from the environment.
  }
}
loadEnvFile(resolve(process.cwd(), ".env.local"));
loadEnvFile(resolve(process.cwd(), ".env"));

import { initializeApp, getApps, cert } from "firebase-admin/app";
import { FieldValue } from "firebase-admin/firestore";
import { getScriptFirestore, resolveScriptDatabaseId } from "./lib/firestore-db";
import { LAB_PROFILE_SOURCE } from "../src/lib/lab-profile";
import type { ClientCompetitor } from "../src/lib/types";

interface LabCompetitorEntry {
  name: string;
  active?: boolean;
}

/** The importer's own name key (import-lab-client.ts, step 3). */
const normalize = (s: string) => s.toLowerCase().replace(/[^a-z0-9]/g, "");

async function main() {
  const args = process.argv.slice(2);
  const slug = args.find((a) => !a.startsWith("--")) ?? "";
  const apply = args.includes("--apply");
  const revert = args.includes("--revert");
  const force = args.includes("--force");
  const labRoot = resolve(args.find((a) => a.startsWith("--lab-root="))?.split("=")[1] ?? join(homedir(), "karos-agents"));
  if (!slug) {
    console.error("Usage: FIRESTORE_DATABASE_ID=prep|(default) npx tsx scripts/mark-lab-profile-client.ts <slug> [--apply] [--revert] [--force] [--lab-root=PATH]");
    process.exit(1);
  }

  const databaseId = resolveScriptDatabaseId();
  console.log(`${apply ? "APPLYING" : "DRY RUN — nothing is written. Pass --apply to write."} · ${revert ? "REVERT" : "MARK"} · database ${databaseId}\n`);

  const trackingPath = join(labRoot, "clients", slug, "profile", "competitor-tracking.json");
  if (!existsSync(trackingPath)) {
    console.error(`No lab competitor file at ${trackingPath}`);
    process.exit(1);
  }
  const tracking = JSON.parse(readFileSync(trackingPath, "utf-8")) as { competitors?: LabCompetitorEntry[] };
  const labNames = new Set((tracking.competitors ?? []).filter((c) => c.active !== false).map((c) => normalize(c.name)));

  const raw = process.env.FIREBASE_SERVICE_ACCOUNT_KEY;
  if (!raw) throw new Error("FIREBASE_SERVICE_ACCOUNT_KEY is not set");
  const app = getApps()[0] ?? initializeApp({ credential: cert(JSON.parse(raw)) });
  const db = getScriptFirestore(app);

  const matches = await db.collection("clients").where("agentsRepoSlug", "==", slug).get();
  if (matches.size !== 1) {
    console.error(`Expected exactly one client with agentsRepoSlug "${slug}", found ${matches.size}.`);
    process.exit(1);
  }
  const clientRef = matches.docs[0]!.ref;
  const client = matches.docs[0]!.data() as { name?: string; profileSource?: string };
  console.log(`▸ ${client.name ?? "(unnamed)"} [${clientRef.id}] · profileSource: ${client.profileSource ?? "(unset)"}`);

  // What the mark will protect, printed so the operator can see these are the lab's.
  const docs = await db.collection("clientContextDocs").where("clientId", "==", clientRef.id).get();
  for (const d of docs.docs.map((x) => x.data()).sort((a, b) => `${a.tier}${a.docType}`.localeCompare(`${b.tier}${b.docType}`))) {
    console.log(`  doc ${String(d.tier).padEnd(13)} ${String(d.docType).padEnd(22)} v${d.version} · ${String(d.content ?? "").length} chars`);
  }

  const report = await db.collection("clientReports").doc(clientRef.id).get();
  if (!revert && report.exists && !force) {
    console.error(
      "\nRefusing: this client already has an Intel Report, so the pipeline has run here and replaced its documents. " +
        "Marking it would freeze those as if the lab had written them. Re-import the lab's documents first, or pass --force.",
    );
    process.exit(1);
  }

  const competitors = await db.collection("clientCompetitors").where("clientId", "==", clientRef.id).get();
  const flips: Array<{ id: string; company: string }> = [];
  for (const doc of competitors.docs) {
    const c = doc.data() as ClientCompetitor;
    const fromLab = labNames.has(normalize(c.company ?? ""));
    if (revert) {
      if (c.source === LAB_PROFILE_SOURCE && fromLab) flips.push({ id: doc.id, company: c.company });
      continue;
    }
    if (c.source !== "report" || !fromLab) {
      console.log(`  keep  [${c.source}] ${c.company}${fromLab ? "" : " (not in the lab file)"}`);
      continue;
    }
    const analysed = Boolean(c.positioning) || (c.keyStrengths ?? []).length > 0 || (c.keyWeaknesses ?? []).length > 0;
    if (analysed) {
      console.log(`  keep  [report] ${c.company} (an analysis run has written to it; not the importer's row any more)`);
      continue;
    }
    flips.push({ id: doc.id, company: c.company });
  }

  const nextSource = revert ? "report" : LAB_PROFILE_SOURCE;
  for (const f of flips) console.log(`  ${apply ? "set " : "would set"} source "${nextSource}" · ${f.company} [${f.id}]`);
  console.log(
    `  ${apply ? "set " : "would set"} client profileSource ${revert ? "(removed)" : `"${LAB_PROFILE_SOURCE}"`}`,
  );

  if (!apply) {
    console.log(`\n${flips.length} competitor row(s) and the client would change. Re-run with --apply.`);
    return;
  }

  const batch = db.batch();
  const now = Date.now();
  for (const f of flips) batch.update(db.collection("clientCompetitors").doc(f.id), { source: nextSource, updatedAt: now });
  batch.update(clientRef, { profileSource: revert ? FieldValue.delete() : LAB_PROFILE_SOURCE });
  await batch.commit();
  console.log(`\n✔ ${flips.length} competitor row(s) and the client updated in ${databaseId}.`);
}

// Only when invoked directly — importing this file must never open a Firestore
// connection, let alone write to one.
if (require.main === module) {
  main().catch((e) => {
    console.error(e);
    process.exit(1);
  });
}
