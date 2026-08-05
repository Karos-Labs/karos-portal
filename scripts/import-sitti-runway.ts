/**
 * One-off import: put the gatekeep runway (14 posts, Thu 2026-08-06 to Wed 2026-08-19) onto the karosCMO calendar so staff and the client
 * see every upcoming post with its date fixed.
 *
 * Mirrors scripts/import-pitch-calendar.ts exactly (same bootstrap, idempotency
 * keyed on meta.labRun, cron-safety assertions, storage upload convention);
 * differences: sitti client, ONE queue file whose days span TWO lab runs
 * (2026-07-24-rerender-v2 + 2026-07-24-batch-01), carousels only.
 *
 * SOURCE (local disk):
 *   <LAB>/clients/sitti/outputs/instagram-agent/2026-08-05-runway-01/internal/ig-queue.json
 *   media under <LAB>/clients/sitti/outputs/instagram-agent/<run>/client/<item>/
 *
 * CLI
 *   npx tsx scripts/import-sitti-calendar.ts            # DRY RUN (default)
 *   npx tsx scripts/import-sitti-calendar.ts --apply    # uploads + Firestore writes
 */

import { readFileSync, existsSync, statSync, readdirSync } from "fs";
import { resolve, dirname, join } from "path";

const argv = process.argv.slice(2);
const APPLY = argv.includes("--apply");

/* ── source locations ─────────────────────────────────────────────────────── */
const LAB_IG_ROOT =
  "/Users/albertkattan/karos-agents/.claude/worktrees/instagram-agent-templates-3c8cb5/clients/sitti/outputs/instagram-agent";
const IG_QUEUE = join(LAB_IG_ROOT, "2026-08-05-runway-01/internal/ig-queue.json");

const RECOMMENDED_REASON = "gatekeep runway import 2026-08-05";
const CONTENT_CHAR_CAP = 100_000;
const ABOUT_CHAR_CAP = 4_000;

/* ── load .env.local before any firebase-admin import (redate pattern) ────── */
function loadEnvFile(path: string) {
  try {
    const content = readFileSync(path, "utf-8");
    const lines = content.split("\n");
    for (let i = 0; i < lines.length; i++) {
      const trimmed = lines[i].trim();
      if (!trimmed || trimmed.startsWith("#")) continue;
      const eqIdx = trimmed.indexOf("=");
      if (eqIdx === -1) continue;
      const key = trimmed.slice(0, eqIdx).trim();
      let val = trimmed.slice(eqIdx + 1).trim();
      const quote = val[0] === '"' || val[0] === "'" ? val[0] : "";
      if (quote) {
        while (!(val.length > 1 && val.endsWith(quote)) && i < lines.length - 1) val += "\n" + lines[++i];
        val = val.slice(1, val.endsWith(quote) ? -1 : undefined);
      }
      if (!process.env[key]) process.env[key] = val;
    }
  } catch {
    /* missing file is fine */
  }
}
function findAndLoadEnv() {
  let dir = process.cwd();
  for (let i = 0; i < 6; i++) {
    const candidate = resolve(dir, ".env.local");
    if (existsSync(candidate)) {
      loadEnvFile(candidate);
      break;
    }
    const parent = dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  loadEnvFile(resolve(process.cwd(), ".env"));
}
findAndLoadEnv();

/* ── firebase-admin ───────────────────────────────────────────────────────── */
import { initializeApp, getApps, cert } from "firebase-admin/app";
import { getFirestore } from "firebase-admin/firestore";
import { getStorage } from "firebase-admin/storage";
import { randomUUID } from "node:crypto";

function initAdmin() {
  if (getApps().length) return;
  let raw = process.env.FIREBASE_SERVICE_ACCOUNT_KEY;
  if (raw && ((raw.startsWith("'") && raw.endsWith("'")) || (raw.startsWith('"') && raw.endsWith('"')))) {
    raw = raw.slice(1, -1);
  }
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
initAdmin();
const db = getFirestore();
db.settings({ ignoreUndefinedProperties: true });

function bucketName(): string {
  const raw = process.env.FIREBASE_STORAGE_BUCKET || process.env.NEXT_PUBLIC_FIREBASE_STORAGE_BUCKET;
  if (!raw) throw new Error("NEXT_PUBLIC_FIREBASE_STORAGE_BUCKET is not set");
  return raw.replace(/^gs:\/\//, "").replace(/\/+$/, "").trim();
}
const BUCKET_NAME = bucketName();
const bucket = getStorage(getApps()[0]!).bucket(BUCKET_NAME);

import { CHAIN_SLOT_HOUR, chainSlotForDay, startOfDayMs, chainFamilyFor } from "../src/lib/post-chain";
import type { Asset, AssetType, Client, PublishMode } from "../src/lib/types";

/* ── helpers ──────────────────────────────────────────────────────────────── */
function iso(t: number | null | undefined): string {
  return t == null ? "—" : new Date(t).toISOString();
}
function slotForDate(ymd: string): number {
  const [y, m, d] = ymd.split("-").map(Number);
  const day = new Date(y, m - 1, d);
  day.setHours(0, 0, 0, 0);
  return chainSlotForDay(startOfDayMs(day.getTime()));
}
function titleCaseWords(slug: string): string {
  return slug
    .split(/[-_\s/]+/)
    .filter(Boolean)
    .map((w) => w.charAt(0).toUpperCase() + w.slice(1))
    .join(" ");
}
const TITLE_OVERRIDES: Record<string, string> = {
  "d06-thu-pick-your-character": "Florentin On A Thursday Night: Pick Your Character",
  "d07-fri-saturday-black-book": "The Saturday Black Book",
  "d08-sat-levinsky-leak": "Levinsky, Leaked",
  "d09-sun-alone-together-map": "For When You Need People, Not Talking",
  "d10-mon-nyc-billionaires-daughter": "New York, According To A Billionaire's Daughter",
  "d11-tue-risky-text": "Cafes For Sending A Risky Text",
  "d12-wed-review-cafe-de-flore": "Cafe De Flore, Reviewed Properly",
  "d13-thu-nyc-saturday-characters": "Choose Your Saturday In New York",
  "d14-fri-fashion-week-starter-pack": "Fashion Week, Uninvited: The Starter Pack",
  "d15-sat-soho-leak": "Soho, Leaked",
  "d16-sun-left-on-read-map": "A Map For The Left On Read",
  "d17-mon-london-retired-party-girl": "London, According To A Retired Party Girl",
  "d18-tue-anti-guide-no-beach": "Tel Aviv Without The Beach",
  "d19-wed-review-gordons": "Gordon's Wine Bar, Reviewed Properly",
};
function humanizeSlug(lastSegment: string): string {
  return TITLE_OVERRIDES[lastSegment] ?? titleCaseWords(lastSegment.replace(/^\d+-/, ""));
}
const CONTENT_TYPES: Record<string, string> = {
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".webp": "image/webp",
};
function contentTypeFor(name: string): string {
  const i = name.lastIndexOf(".");
  return (i >= 0 && CONTENT_TYPES[name.slice(i).toLowerCase()]) || "application/octet-stream";
}
function readTextIfExists(path: string, cap: number): string {
  try {
    return readFileSync(path, "utf-8").slice(0, cap);
  } catch {
    return "";
  }
}
function downloadUrlFor(path: string, token: string): string {
  return `https://firebasestorage.googleapis.com/v0/b/${BUCKET_NAME}/o/${encodeURIComponent(path)}?alt=media&token=${token}`;
}

async function uploadFileIdempotent(
  localPath: string,
  storagePath: string,
  dry: boolean,
): Promise<{ url: string; bytes: number; reused: boolean }> {
  const bytes = statSync(localPath).size;
  const file = bucket.file(storagePath);
  if (dry) {
    return { url: downloadUrlFor(storagePath, randomUUID()), bytes, reused: false };
  }
  try {
    const [md] = await file.getMetadata();
    const existingSize = Number(md.size ?? -1);
    const existingToken =
      (md.metadata?.firebaseStorageDownloadTokens as string | undefined)?.split(",")[0];
    if (existingSize === bytes && existingToken) {
      return { url: downloadUrlFor(storagePath, existingToken), bytes, reused: true };
    }
  } catch {
    /* not found — fall through to upload */
  }
  const token = randomUUID();
  await file.save(readFileSync(localPath), {
    resumable: false,
    contentType: contentTypeFor(storagePath),
    metadata: { metadata: { firebaseStorageDownloadTokens: token } },
  });
  return { url: downloadUrlFor(storagePath, token), bytes, reused: false };
}

/* ── queue shapes ─────────────────────────────────────────────────────────── */
interface IgDay {
  order: number;
  date: string;
  item: string; // "<post-folder>" within the run's client/
  run: string; // lab run name, e.g. "2026-07-24-batch-01"
  lane: string;
  labRun: string; // "instagram-agent/<run>#<item>"
  orderKey: string;
}
interface Queue {
  client: string;
  agent: string;
  generated: string;
  days: IgDay[];
}

interface PlannedAsset {
  labRun: string;
  title: string;
  date: string;
  scheduledAt: number;
  doc: Omit<Asset, "id">;
  existingId: string | null;
  mediaBytes: number;
  mediaUploaded: number;
  mediaCount: number;
}

/* ── build one carousel asset ─────────────────────────────────────────────── */
async function buildCarousel(
  day: IgDay,
  agentFolder: string,
  clientId: string,
  existing: Map<string, { id: string; status: string }>,
  now: number,
  dry: boolean,
): Promise<PlannedAsset> {
  const itemDir = join(LAB_IG_ROOT, day.run, "client", day.item);
  if (!existsSync(itemDir)) throw new Error(`Missing carousel folder: ${itemDir}`);
  const slideFiles = readdirSync(itemDir)
    .filter((f) => /^slide-\d+\.png$/i.test(f))
    .sort((a, b) => parseInt(a.match(/\d+/)![0], 10) - parseInt(b.match(/\d+/)![0], 10));
  if (slideFiles.length === 0) throw new Error(`No slides in ${itemDir}`);

  const hosted: Array<{ name: string; relPath: string; url: string; bytes: number }> = [];
  const imageUrls: string[] = [];
  let bytesTotal = 0;
  let uploadedCount = 0;
  for (const name of slideFiles) {
    const storagePath = `lab-imports/${clientId}/${day.labRun.split("#")[0]}/${day.item}/${name}`;
    const { url, bytes, reused } = await uploadFileIdempotent(join(itemDir, name), storagePath, dry);
    hosted.push({ name, relPath: `${day.item}/${name}`, url, bytes });
    imageUrls.push(url);
    bytesTotal += bytes;
    if (!reused) uploadedCount++;
  }

  const content = readTextIfExists(join(itemDir, "caption.txt"), CONTENT_CHAR_CAP);
  const about = readTextIfExists(join(itemDir, "about.txt"), ABOUT_CHAR_CAP);
  const title = humanizeSlug(day.item);
  const scheduledAt = slotForDate(day.date);
  const ex = existing.get(day.labRun) ?? null;

  const doc: Omit<Asset, "id"> = {
    clientId,
    jobId: null,
    agentId: null,
    type: "instagram_post" as AssetType,
    title,
    content,
    meta: {
      source: "lab-import",
      labRun: day.labRun,
      agentFolder,
      category: day.lane,
      ...(about ? { about } : {}),
      images: imageUrls,
      files: hosted,
    },
    imageUrl: imageUrls[0] ?? null,
    channels: ["instagram"],
    status: "scheduled",
    scheduledAt,
    publishMode: "manual" as PublishMode,
    recommendedAt: scheduledAt,
    recommendedReason: RECOMMENDED_REASON,
    templateKey: day.lane,
    templateName: titleCaseWords(day.lane),
    orderKey: day.orderKey,
    createdBy: "lab-import-script",
    createdAt: now,
    updatedAt: now,
  };

  return {
    labRun: day.labRun,
    title,
    date: day.date,
    scheduledAt,
    doc,
    existingId: ex?.id ?? null,
    mediaBytes: bytesTotal,
    mediaUploaded: uploadedCount,
    mediaCount: slideFiles.length,
  };
}

/* ── client resolution ────────────────────────────────────────────────────── */
async function resolveClient(dry: boolean, now: number): Promise<{ id: string; created: boolean }> {
  const snap = await db.collection("clients").get();
  for (const d of snap.docs) {
    const c = d.data() as { name?: string; agentsRepoSlug?: string };
    if (c.agentsRepoSlug === "sitti" || /\bsitti\b/i.test(c.name ?? "")) {
      return { id: d.id, created: false };
    }
  }
  const minimal: Omit<Client, "id"> = {
    name: "Sitti",
    agentsRepoSlug: "sitti",
    assignedEmployeeIds: [],
    status: "active",
    createdAt: now,
    createdBy: "lab-import-script",
  };
  if (dry) {
    console.log('   (dry) would CREATE client "Sitti" (slug sitti).');
    return { id: "<new-client-id>", created: true };
  }
  const ref = await db.collection("clients").add(minimal);
  console.log(`   created client "Sitti" → ${ref.id}`);
  return { id: ref.id, created: true };
}

/* ── APPLY-only write-access preflight ────────────────────────────────────── */
async function preflightWriteAccess(clientId: string) {
  try {
    const token = randomUUID();
    await bucket.file(`lab-imports/${clientId}/_preflight/write-access-ok.txt`).save(
      Buffer.from(`ok ${new Date().toISOString()}`),
      { resumable: false, contentType: "text/plain", metadata: { metadata: { firebaseStorageDownloadTokens: token } } },
    );
  } catch (e) {
    throw new Error(
      `STOP: Firebase Storage write DENIED for bucket "${BUCKET_NAME}". Detail: ${(e as Error).message}`,
    );
  }
  try {
    await db.collection("_importPreflight").doc("sitti-calendar").set({ at: Date.now(), ok: true }, { merge: true });
  } catch (e) {
    throw new Error(`STOP: Firestore write DENIED. Detail: ${(e as Error).message}`);
  }
}

/* ── main ─────────────────────────────────────────────────────────────────── */
async function main() {
  const now = Date.now();
  console.log(`\nSitti — lab calendar import  ·  ${APPLY ? "APPLY (writes)" : "DRY RUN (no writes)"}`);
  const offMin = new Date().getTimezoneOffset();
  console.log(
    `Host UTC offset: ${-offMin / 60}h  ·  CHAIN_SLOT_HOUR=${CHAIN_SLOT_HOUR} (server-local)  ·  ` +
      `sample slot 2026-07-27 → ${iso(slotForDate("2026-07-27"))}`,
  );
  console.log(`Storage bucket: ${BUCKET_NAME}\n`);

  const ig = JSON.parse(readFileSync(IG_QUEUE, "utf-8")) as Queue;
  console.log(`Queue: agent=${ig.agent} generated=${ig.generated} days=${ig.days.length}`);

  const { id: clientId, created: clientCreated } = await resolveClient(!APPLY, now);
  console.log(`Client: ${clientId}${clientCreated ? " (created)" : ""}\n`);

  const existing = new Map<string, { id: string; status: string }>();
  if (clientId !== "<new-client-id>") {
    const snap = await db.collection("assets").where("clientId", "==", clientId).get();
    for (const d of snap.docs) {
      const a = d.data() as Asset;
      const lr = (a.meta as { labRun?: string } | undefined)?.labRun;
      if (typeof lr === "string") existing.set(lr, { id: d.id, status: a.status });
    }
  }
  console.log(`Existing assets for this client carrying a labRun: ${existing.size}\n`);

  if (APPLY) {
    await preflightWriteAccess(clientId);
    console.log("Write-access preflight: PASS (Storage + Firestore writable)\n");
  }

  const planned: PlannedAsset[] = [];
  const skippedPublished: string[] = [];
  for (const day of ig.days) {
    const ex = existing.get(day.labRun);
    if (ex && ex.status === "published") {
      skippedPublished.push(day.labRun);
      continue;
    }
    planned.push(await buildCarousel(day, ig.agent, clientId, existing, now, !APPLY));
  }

  /* cron-safety assertions (mirror import-pitch-calendar.ts) */
  const nonManual = planned.filter((p) => p.doc.publishMode !== "manual");
  const cronMatches = planned.filter(
    (p) =>
      (p.doc.status === "scheduled" || p.doc.status === "approved") &&
      p.doc.scheduledAt != null &&
      p.doc.scheduledAt <= now &&
      (p.doc.publishMode === "auto" || p.doc.publishMode == null),
  );
  let ok = true;
  if (nonManual.length > 0) {
    ok = false;
    console.error(`\nASSERTION FAILED: ${nonManual.length} asset(s) are not publishMode "manual".`);
  }
  if (cronMatches.length > 0) {
    ok = false;
    console.error(`\nASSERTION FAILED: ${cronMatches.length} asset(s) would match the /api/publish cron predicate.`);
  }
  if (!ok) {
    console.error("\nAborting — no Firestore writes performed.");
    process.exit(1);
  }
  console.log(
    `Cron-safety: PASS — ${planned.length} asset(s), all publishMode "manual", 0 match the /api/publish predicate.`,
  );

  const sumBytes = planned.reduce((s, p) => s + p.mediaBytes, 0);
  const sumUploaded = planned.reduce((s, p) => s + p.mediaUploaded, 0);
  const sumFiles = planned.reduce((s, p) => s + p.mediaCount, 0);
  const newCount = planned.filter((p) => !p.existingId).length;
  const updateCount = planned.filter((p) => p.existingId).length;
  planned.sort((a, b) => a.scheduledAt - b.scheduledAt);

  console.log(`\n${"═".repeat(78)}\nPLAN\n${"═".repeat(78)}`);
  for (const p of planned) {
    console.log(`  ${p.date}  ${p.title}  (${p.mediaCount} slides, ${p.existingId ? "update" : "new"})`);
  }
  console.log(
    `  TOTAL: ${planned.length} assets (${newCount} new, ${updateCount} update) · ${sumFiles} slides · ` +
      `${(sumBytes / 1e6).toFixed(1)} MB · to upload this run: ${sumUploaded}`,
  );
  if (skippedPublished.length > 0) console.log(`  Preserved (already published): ${skippedPublished.length}`);
  console.log(`  Chain family: ${chainFamilyFor("instagram_post")}\n`);

  if (!APPLY) {
    console.log("DRY RUN complete — no uploads, no Firestore writes. Re-run with --apply to persist.\n");
    return;
  }

  console.log("Writing assets to Firestore…");
  const batch = db.batch();
  let created = 0;
  let updated = 0;
  for (const p of planned) {
    if (p.existingId) {
      const { createdAt: _c, createdBy: _cb, ...rest } = p.doc;
      void _c;
      void _cb;
      batch.set(db.collection("assets").doc(p.existingId), { ...rest, updatedAt: Date.now() }, { merge: true });
      updated++;
    } else {
      batch.set(db.collection("assets").doc(), p.doc);
      created++;
    }
  }
  await batch.commit();
  console.log(`\nDone: ${created} created, ${updated} updated in place. Media uploaded this run: ${sumUploaded} file(s).`);
}

main().catch((err) => {
  console.error("\nImport failed:", err);
  process.exit(1);
});
