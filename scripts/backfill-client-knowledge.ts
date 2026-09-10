/**
 * Client knowledge → agent-engine workspace backfill.
 *
 * The reconcile cron (`/api/agent-engine/reconcile`) mirrors every
 * engine-enabled client's knowledge base (context docs, recent transcripts,
 * reference-asset index) into the engine workspace bucket each tick — this
 * script is the FIRST fill and the manual-refresh path, running the exact
 * same builders (`src/lib/agent-engine/knowledge-sync.ts` documents the tier
 * rules, caps and the flat three-file layout; this script re-implements only
 * the Firestore/GCS plumbing, because that module is `server-only`).
 *
 *   npx tsx scripts/backfill-client-knowledge.ts            # dry run — prints the plan
 *   npx tsx scripts/backfill-client-knowledge.ts --apply    # writes to the bucket
 *
 * DRY RUN IS THE DEFAULT ON PURPOSE. The credentials in .env.local point at a
 * real Firestore and a real bucket. Read the printed plan first.
 *
 * Required env (read from .env.local automatically):
 *   FIREBASE_SERVICE_ACCOUNT_KEY (or the split FIREBASE_* trio)
 *   AGENT_ENGINE_WORKSPACE_BUCKET   e.g. karoscmo-prep-agent-artifacts
 *   FIRESTORE_DATABASE_ID           "prep" for prep; unset = default database
 */

import { readFileSync } from "fs";
import { resolve } from "path";

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
    // .env.local may not exist in CI — that's fine
  }
}

loadEnvFile(resolve(process.cwd(), ".env.local"));
loadEnvFile(resolve(process.cwd(), ".env"));

import { initializeApp, getApps, cert } from "firebase-admin/app";
import { getFirestore, type Firestore } from "firebase-admin/firestore";
import { Storage } from "@google-cloud/storage";

function credentials(): Record<string, string> | null {
  const raw = process.env.FIREBASE_SERVICE_ACCOUNT_KEY;
  if (raw) return JSON.parse(raw);
  return null;
}

function initAdmin() {
  if (getApps().length) return;
  const parsed = credentials();
  if (parsed) {
    initializeApp({ credential: cert(parsed) });
    return;
  }
  const projectId = process.env.FIREBASE_PROJECT_ID;
  const clientEmail = process.env.FIREBASE_CLIENT_EMAIL;
  const privateKey = process.env.FIREBASE_PRIVATE_KEY?.replace(/\\n/g, "\n");
  if (projectId && clientEmail && privateKey) {
    initializeApp({ credential: cert({ projectId, clientEmail, privateKey }) });
    return;
  }
  throw new Error("No Firebase credentials found in .env.local");
}

let db: Firestore;

// ── The same selection/caps knowledge-sync.ts applies (kept in step by its tests) ──
const CONTEXT_DOC_CONTENT_CAP = 6_000;
const TRANSCRIPT_COUNT_CAP = 10;

interface ContextDocRow {
  docType: string;
  tier: string;
  version: number;
  content: string;
}

function selectContextDocs(rows: Array<Record<string, unknown>>): ContextDocRow[] {
  const byType = new Map<string, { docType: string; tier: string; version: number; content: string }>();
  for (const row of rows) {
    const tier = String(row.tier ?? "");
    if (tier !== "internal" && tier !== "client") continue;
    const docType = String(row.docType ?? "");
    if (!docType) continue;
    const existing = byType.get(docType);
    const candidate = { docType, tier, version: Number(row.version ?? 0), content: String(row.content ?? "") };
    if (!existing || (existing.tier === "internal" && tier === "client")) byType.set(docType, candidate);
  }
  return [...byType.values()]
    .sort((a, b) => a.docType.localeCompare(b.docType))
    .map((doc) => ({
      ...doc,
      content: doc.content.length > CONTEXT_DOC_CONTENT_CAP ? `${doc.content.slice(0, CONTEXT_DOC_CONTENT_CAP)}\n\n[truncated]` : doc.content,
    }));
}

async function main() {
  const apply = process.argv.includes("--apply");
  initAdmin();
  db = getFirestore(process.env.FIRESTORE_DATABASE_ID || "(default)");

  const bucketName = process.env.AGENT_ENGINE_WORKSPACE_BUCKET;
  if (!bucketName) throw new Error("AGENT_ENGINE_WORKSPACE_BUCKET is not set");
  const parsed = credentials();
  const storage = parsed ? new Storage({ credentials: parsed, projectId: parsed.project_id }) : new Storage();
  const bucket = storage.bucket(bucketName);

  console.log(apply ? `APPLYING knowledge backfill to gs://${bucketName}\n` : "DRY RUN — nothing is written. Pass --apply to write.\n");

  const clientsSnap = await db.collection("clients").get();
  const clients = clientsSnap.docs
    .map((d) => ({ id: d.id, ...(d.data() as { name?: string; agentsRepoSlug?: string }) }))
    .filter((c) => c.agentsRepoSlug);
  console.log(`Found ${clients.length} engine-enabled client(s) (agentsRepoSlug set)\n`);

  for (const client of clients) {
    const label = `[${client.name ?? client.id} → clients/${client.agentsRepoSlug}/knowledge]`;
    try {
      const [docsSnap, transcriptsSnap, itemsSnap] = await Promise.all([
        db.collection("clientContextDocs").where("clientId", "==", client.id).get(),
        db.collection("transcripts").where("clientId", "==", client.id).get(),
        db.collection("contextItems").where("clientId", "==", client.id).get(),
      ]);

      const contextDocs = selectContextDocs(docsSnap.docs.map((d) => d.data()));
      const transcripts = transcriptsSnap.docs
        .map((d) => d.data() as { title?: string; meetingDate?: number; createdAt?: number; summary?: string; actionItems?: string[] })
        .sort((a, b) => (b.meetingDate ?? b.createdAt ?? 0) - (a.meetingDate ?? a.createdAt ?? 0))
        .slice(0, TRANSCRIPT_COUNT_CAP)
        .map((t) => ({
          title: t.title ?? "Untitled meeting",
          ...(t.meetingDate !== undefined ? { meetingDate: t.meetingDate } : {}),
          ...(t.summary !== undefined ? { summary: t.summary } : {}),
          ...(t.actionItems !== undefined && t.actionItems.length > 0 ? { actionItems: t.actionItems } : {}),
        }));
      const assets = itemsSnap.docs
        .map((d) => d.data() as { name?: string; mimeType?: string; note?: string; purpose?: string; url?: string })
        .filter((i) => i.name && i.url)
        .map((i) => ({
          name: i.name!,
          mimeType: i.mimeType ?? "application/octet-stream",
          ...(i.note !== undefined ? { note: i.note } : {}),
          ...(i.purpose !== undefined ? { purpose: i.purpose } : {}),
          url: i.url!,
        }));

      console.log(`${label} ${contextDocs.length} context doc(s), ${transcripts.length} transcript(s), ${assets.length} asset(s)`);
      for (const doc of contextDocs) console.log(`   - ${doc.docType} (${doc.tier}, v${doc.version}, ${doc.content.length} chars)`);

      if (apply) {
        const prefix = `clients/${client.agentsRepoSlug}/knowledge`;
        const syncedAt = Date.now();
        const write = (name: string, value: unknown) =>
          bucket.file(`${prefix}/${name}`).save(JSON.stringify(value, null, 2), { contentType: "application/json", resumable: false });
        await Promise.all([
          write("context-docs.json", { syncedAt, docs: contextDocs }),
          write("transcripts.json", { syncedAt, transcripts }),
          write("assets.json", { syncedAt, assets }),
        ]);
        console.log(`${label} ✅ written`);
      }
    } catch (err) {
      console.error(`${label} ❌ Failed:`, err);
    }
  }
  process.exit(0);
}

if (require.main === module) {
  main().catch((e) => {
    console.error(e);
    process.exit(1);
  });
}
