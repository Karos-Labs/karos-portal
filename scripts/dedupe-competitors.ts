/**
 * Merge duplicate competitor rows that describe the same brand — the classic
 * case being a user's pasted-URL manual row ("https://speedrun.a16z.com", no
 * favicon) sitting next to the AI-resolved report row ("Speedrun by a16z",
 * with url). Going forward the app merges these at write time
 * (replaceReportCompetitors manual-merge + quick-add upsert); this script
 * collapses the duplicates that already exist.
 *
 * Merge rules (per duplicate group sharing a brand identity key):
 *   - A MANUAL row wins the slot (user intent), absorbing the best fields from
 *     its report twin(s): canonical company name when the manual one is a raw
 *     URL/domain, url fill, analysis fields it lacks, max llmMentions.
 *   - Report-only groups keep the row with the most measured llmMentions
 *     (then the newest); the rest are deleted.
 *
 *   npx tsx scripts/dedupe-competitors.ts            # dry run — prints the plan
 *   npx tsx scripts/dedupe-competitors.ts --apply    # writes
 *
 * DRY RUN IS THE DEFAULT ON PURPOSE. The credentials in .env.local point at
 * production Firestore. Read the printed plan first.
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
    // env may come from the shell
  }
}
loadEnvFile(resolve(process.cwd(), ".env.local"));
loadEnvFile(resolve(process.cwd(), ".env"));

import { initializeApp, cert, getApps } from "firebase-admin/app";
import { getFirestore } from "firebase-admin/firestore";
import { competitorBrandKeys, looksLikeUrlInput } from "../src/lib/competitor-input";
import type { ClientCompetitor } from "../src/lib/types";

type Row = ClientCompetitor & { _ref: FirebaseFirestore.DocumentReference };

async function main() {
  const apply = process.argv.includes("--apply");
  if (!getApps().length) {
    const raw = process.env.FIREBASE_SERVICE_ACCOUNT_KEY;
    if (!raw) throw new Error("FIREBASE_SERVICE_ACCOUNT_KEY not set");
    initializeApp({ credential: cert(JSON.parse(raw)) });
  }
  const db = getFirestore();
  db.settings({ ignoreUndefinedProperties: true });

  console.log(
    apply ? "APPLYING competitor dedupe\n" : "DRY RUN — nothing is written. Pass --apply to write.\n",
  );

  const clientsSnap = await db.collection("clients").get();
  const clientNames = new Map(clientsSnap.docs.map((d) => [d.id, (d.data().name as string) ?? d.id]));

  const compSnap = await db.collection("clientCompetitors").get();
  const byClient = new Map<string, Row[]>();
  for (const doc of compSnap.docs) {
    const row = { ...(doc.data() as ClientCompetitor), id: doc.id, _ref: doc.ref } as Row;
    if (!row.clientId) continue;
    (byClient.get(row.clientId) ?? byClient.set(row.clientId, []).get(row.clientId)!).push(row);
  }

  let groups = 0;
  let deletions = 0;
  const ops: Array<() => void> = [];
  const batch = db.batch();

  for (const [clientId, rows] of byClient) {
    // Group rows that share ANY brand identity key (transitively).
    const groupOf = new Map<Row, Row[]>();
    const keyOwner = new Map<string, Row[]>();
    for (const row of rows) {
      let group: Row[] | undefined;
      for (const k of competitorBrandKeys(row.company, row.url)) {
        const g = keyOwner.get(k);
        if (g) {
          group = g;
          break;
        }
      }
      if (!group) group = [];
      group.push(row);
      groupOf.set(row, group);
      for (const k of competitorBrandKeys(row.company, row.url)) keyOwner.set(k, group);
    }

    for (const group of new Set(groupOf.values())) {
      if (group.length < 2) continue;
      groups++;

      const manuals = group.filter((r) => r.source === "manual");
      const byMentionsThenNewest = (a: Row, b: Row) =>
        (b.llmMentions ?? 0) - (a.llmMentions ?? 0) || b.createdAt - a.createdAt;
      // Keeper: newest manual row if any (user intent), else best report row.
      const keeper = manuals.length
        ? [...manuals].sort((a, b) => b.createdAt - a.createdAt)[0]
        : [...group].sort(byMentionsThenNewest)[0];
      const losers = group.filter((r) => r !== keeper);
      const bestTwin = [...losers].sort(byMentionsThenNewest)[0];

      const newCompany =
        looksLikeUrlInput(keeper.company) && bestTwin && !looksLikeUrlInput(bestTwin.company)
          ? bestTwin.company
          : keeper.company;
      const patch: Partial<ClientCompetitor> = {
        company: newCompany,
        url: keeper.url ?? losers.find((l) => l.url)?.url,
        positioning: keeper.positioning ?? bestTwin?.positioning,
        keyStrengths: keeper.keyStrengths?.length ? keeper.keyStrengths : bestTwin?.keyStrengths ?? [],
        keyWeaknesses: keeper.keyWeaknesses?.length ? keeper.keyWeaknesses : bestTwin?.keyWeaknesses ?? [],
        threatLevel: keeper.threatLevel ?? bestTwin?.threatLevel,
        llmMentions: Math.max(...group.map((r) => r.llmMentions ?? 0)) || keeper.llmMentions,
        updatedAt: Date.now(),
      };

      console.log(
        `\n[${clientNames.get(clientId) ?? clientId}] merge ${group.length} rows → "${newCompany}" (${keeper.source}${patch.url ? ` · ${patch.url}` : ""})`,
      );
      for (const r of group) {
        console.log(`  ${r === keeper ? "KEEP " : "drop "} [${r.source}] ${r.company}${r.url ? ` (${r.url})` : ""}`);
      }

      ops.push(() => {
        batch.set(keeper._ref, patch, { merge: true });
        for (const l of losers) batch.delete(l._ref);
      });
      deletions += losers.length;
    }
  }

  if (groups === 0) {
    console.log("No duplicate competitor groups found.");
    return;
  }
  console.log(`\n${groups} duplicate group(s), ${deletions} row(s) to remove.`);
  if (!apply) {
    console.log("Dry run — nothing changed. Re-run with --apply to merge.");
    return;
  }
  for (const op of ops) op();
  await batch.commit();
  console.log("Merged.");
}

// Only when invoked directly — importing this file must never open a Firestore
// connection, let alone write to one.
if (require.main === module) {
  main().then(() => process.exit(0)).catch((e) => {
    console.error(e);
    process.exit(1);
  });
}
