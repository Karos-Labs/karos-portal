/**
 * Backfills natural, topic-first titles onto EXISTING X deliverable assets,
 * so a client scrolling their archive (or the calendar) can tell old runs
 * apart — the operator's titling spec of 2026-08-11, applied to the rows that
 * predate the webhook titler (lib/asset-titles.ts).
 *
 * Scope, deliberately narrow:
 *   - X deliverables only (content carries the parsed "# Account" /
 *     "## Avenue" shape) — LinkedIn and Reddit get their own pass after this
 *     one is reviewed.
 *   - Only assets whose title is still the generic agent-name placeholder
 *     ("X Agent", "X Agent v2 (unreviewed)", "X drafts", or an unstripped
 *     "X Agent - <client>"). A title someone typed by hand is never touched.
 *   - Skips launch deliverables, test runs, and anything already titled by
 *     the webhook titler (meta.titleGenerated).
 *
 * Honesty for legacy batches: an old delivery holding a week of drafts gets
 * "<topic> · N drafts", so the row cannot promise one post and open onto
 * twenty. A single-post delivery gets the topic alone.
 *
 * REVERSIBLE: every write stores the old title in meta.titlePrevious, and
 * marks meta.titleGenerated + meta.titleBackfilled.
 *
 * DRY-RUN BY DEFAULT — prints old -> new and writes nothing.
 *
 * Usage:
 *   npx tsx scripts/backfill-x-asset-titles.ts               # dry run, production "(default)"
 *   npx tsx scripts/backfill-x-asset-titles.ts --db=prep     # dry run, prep
 *   npx tsx scripts/backfill-x-asset-titles.ts --write       # write, production
 *   npx tsx scripts/backfill-x-asset-titles.ts --db=both --write
 *
 * Needs .env.local (or env) with Firebase admin credentials AND
 * ANTHROPIC_API_KEY (the AI SDK reads it for the Haiku titling calls).
 */

import { readFileSync } from "node:fs";
import { resolve } from "node:path";

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
import { getFirestore, type Firestore } from "firebase-admin/firestore";
import { generateText } from "ai";
import { createAnthropic } from "@ai-sdk/anthropic";
import {
  isGenericXTitle,
  looksLikeXDrafts,
  sanitizeGeneratedTitle,
  TITLE_CONTENT_SAMPLE_CHARS,
  TITLE_PROMPT,
  xDraftCount,
} from "../src/lib/asset-title-core";

function initAdmin() {
  if (!getApps().length) {
    const raw = process.env.FIREBASE_SERVICE_ACCOUNT_KEY;
    if (raw) {
      const parsed = JSON.parse(raw);
      console.log(`>>> Firebase project: ${parsed.project_id}`);
      initializeApp({ credential: cert(parsed) });
    } else {
      const projectId = process.env.FIREBASE_PROJECT_ID;
      const clientEmail = process.env.FIREBASE_CLIENT_EMAIL;
      const privateKey = process.env.FIREBASE_PRIVATE_KEY?.replace(/\\n/g, "\n");
      if (!projectId || !clientEmail || !privateKey) {
        throw new Error("No Firebase credentials found in .env.local");
      }
      initializeApp({ credential: cert({ projectId, clientEmail, privateKey }) });
    }
  }
  return getApps()[0]!;
}

// Same model id the webhook titler uses (lib/constants MODELS.HAIKU) —
// duplicated here because importing constants.ts would work but the id is the
// only thing needed, and the script must stay runnable standalone.
const HAIKU = "claude-haiku-4-5-20251001";


async function processDatabase(app: ReturnType<typeof initAdmin>, databaseId: string, write: boolean) {
  const db: Firestore = databaseId === "(default)" ? getFirestore(app) : getFirestore(app, databaseId);
  const anthropic = createAnthropic({ apiKey: process.env.ANTHROPIC_API_KEY });
  console.log(`\n=== database: ${databaseId} (${write ? "WRITE" : "dry run"}) ===`);

  const snap = await db.collection("assets").where("agentId", "==", "agent-service").get();
  console.log(`>>> ${snap.size} agent-service assets`);

  let retitled = 0;
  let skipped = 0;
  for (const doc of snap.docs) {
    const data = doc.data();
    const meta = (data.meta ?? {}) as Record<string, unknown>;
    const content = typeof data.content === "string" ? data.content : "";
    if (
      meta.titleGenerated === true ||
      meta.launchDeliverable === true ||
      meta.testRun === true ||
      !looksLikeXDrafts(content) ||
      !isGenericXTitle(typeof data.title === "string" ? data.title : "")
    ) {
      skipped += 1;
      continue;
    }

    const { text } = await generateText({
      model: anthropic(HAIKU),
      prompt: TITLE_PROMPT + content.slice(0, TITLE_CONTENT_SAMPLE_CHARS),
      maxOutputTokens: 50,
      temperature: 0.2,
    });
    const topic = sanitizeGeneratedTitle(text ?? "", "X Agent");
    if (!topic) {
      console.log(`  !! ${doc.id}: no usable title came back — left as "${data.title}"`);
      continue;
    }
    const n = xDraftCount(content);
    const title = n > 1 ? `${topic} · ${n} drafts` : topic;
    console.log(`  ${write ? "WROTE" : "would"} ${doc.id} [${data.clientId}]: "${data.title}" -> "${title}"`);
    if (write) {
      await doc.ref.update({
        title,
        "meta.titleGenerated": true,
        "meta.titleBackfilled": true,
        "meta.titlePrevious": data.title ?? "",
        updatedAt: Date.now(),
      });
    }
    retitled += 1;
    // Polite pacing for the model calls; the whole archive is small.
    await new Promise((r) => setTimeout(r, 150));
  }
  console.log(`>>> ${retitled} retitled, ${skipped} skipped (${write ? "written" : "dry run — nothing written"})`);
}

async function main() {
  if (!process.env.ANTHROPIC_API_KEY) {
    throw new Error("ANTHROPIC_API_KEY is not set — the titling calls need it.");
  }
  const write = process.argv.includes("--write");
  const dbArg = process.argv.find((a) => a.startsWith("--db="))?.slice(5) ?? "default";
  const databases =
    dbArg === "both" ? ["(default)", "prep"] : dbArg === "prep" ? ["prep"] : ["(default)"];
  const app = initAdmin();
  for (const databaseId of databases) {
    await processDatabase(app, databaseId, write);
  }
}

main()
  .then(() => process.exit(0))
  .catch((e) => {
    console.error(e);
    process.exit(1);
  });
