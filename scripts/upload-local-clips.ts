/**
 * Bulk-upload locally generated podcast-clip MP4s to GCS and register each one
 * as a draft `social_post` Asset for a client — the CLI counterpart of the
 * "Bulk Upload Assets" dropzone (src/components/bulk-upload-clips.tsx), for
 * batches too large/numerous to click through the browser one at a time.
 *
 *   npx tsx scripts/upload-local-clips.ts <localDir> <clientId>                     # dry run — prints the plan
 *   npx tsx scripts/upload-local-clips.ts <localDir> <clientId> --apply             # uploads + registers
 *   npx tsx scripts/upload-local-clips.ts <localDir> <clientId> --apply \
 *     --agent=social_post --schedule-start=2026-08-03                              # also auto-schedules 1/day
 *
 * DRY RUN IS THE DEFAULT ON PURPOSE. The credentials in .env.local point at
 * production Firestore and GCS. Read the printed plan first.
 *
 * Reads Firebase + GCS credentials from .env.local automatically. Uploads
 * directly via the service account (no signed URL needed — this script
 * already holds full credentials, unlike a browser).
 */

import { readFileSync, readdirSync, statSync } from "fs";
import { resolve, join, extname } from "path";
import { execFileSync } from "child_process";

// ── Load .env.local before any Firebase/GCS imports ──────────────────────────
function loadEnvFile(path: string) {
  let content: string;
  try {
    content = readFileSync(path, "utf-8");
  } catch {
    return;
  }
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
      while (!(val.length > 1 && val.endsWith(quote)) && i < lines.length - 1) {
        val += "\n" + lines[++i];
      }
      val = val.slice(1, val.endsWith(quote) ? -1 : undefined);
    }
    if (!process.env[key]) process.env[key] = val;
  }
}

loadEnvFile(resolve(process.cwd(), ".env.local"));
loadEnvFile(resolve(process.cwd(), ".env"));

// ── Firebase Admin + GCS ──────────────────────────────────────────────────────
import { initializeApp, getApps, cert } from "firebase-admin/app";
import { getFirestore } from "firebase-admin/firestore";
import { Storage } from "@google-cloud/storage";
import { planBulkSchedule, detectFormatTags } from "../src/lib/bulk-schedule";
import { chainFamilyFor, startOfDayMs } from "../src/lib/post-chain";
import type { AssetType } from "../src/lib/types";

interface Credentials {
  projectId: string;
  clientEmail: string;
  privateKey: string;
}

function getCredentials(): Credentials | null {
  let raw = process.env.FIREBASE_SERVICE_ACCOUNT_KEY;
  if (raw && ((raw.startsWith("'") && raw.endsWith("'")) || (raw.startsWith('"') && raw.endsWith('"')))) {
    raw = raw.slice(1, -1);
  }
  if (raw) {
    const parsed = JSON.parse(raw) as { project_id: string; client_email: string; private_key: string };
    return { projectId: parsed.project_id, clientEmail: parsed.client_email, privateKey: parsed.private_key };
  }
  const projectId = process.env.FIREBASE_PROJECT_ID;
  const clientEmail = process.env.FIREBASE_CLIENT_EMAIL;
  const privateKey = process.env.FIREBASE_PRIVATE_KEY?.replace(/\\n/g, "\n");
  if (projectId && clientEmail && privateKey) {
    return { projectId, clientEmail, privateKey };
  }
  return null;
}

function initAdmin() {
  if (getApps().length) return;
  const sa = getCredentials();
  if (!sa) {
    throw new Error(
      "No Firebase credentials found. Set FIREBASE_SERVICE_ACCOUNT_KEY or " +
        "FIREBASE_PROJECT_ID + FIREBASE_CLIENT_EMAIL + FIREBASE_PRIVATE_KEY in .env.local",
    );
  }
  initializeApp({ credential: cert(sa) });
}

function initStorage(): Storage {
  const sa = getCredentials();
  if (sa) {
    return new Storage({
      projectId: sa.projectId,
      credentials: { client_email: sa.clientEmail, private_key: sa.privateKey },
    });
  }
  return new Storage(); // Application Default Credentials
}

const VIDEO_EXTENSIONS = new Set([".mp4", ".mov"]);
const CONTENT_TYPE: Record<string, string> = { ".mp4": "video/mp4", ".mov": "video/quicktime" };

/** ffprobe if it's on PATH; undefined (skipped, never fatal) otherwise. */
function probeDurationSeconds(localPath: string): number | undefined {
  try {
    const out = execFileSync(
      "ffprobe",
      ["-v", "error", "-show_entries", "format=duration", "-of", "csv=p=0", localPath],
      { stdio: ["ignore", "pipe", "ignore"] },
    )
      .toString()
      .trim();
    const seconds = Number.parseFloat(out);
    return Number.isFinite(seconds) ? Math.round(seconds) : undefined;
  } catch {
    return undefined; // ffprobe not installed, or the probe failed — not fatal
  }
}

function humanizeFilename(filename: string): string {
  const base = filename.replace(/\.[^./]+$/, "");
  const words = base.replace(/[-_]+/g, " ").trim();
  return words.length > 0 ? words.charAt(0).toUpperCase() + words.slice(1) : filename;
}

async function main() {
  const args = process.argv.slice(2);
  const apply = args.includes("--apply");
  const positional = args.filter((a) => !a.startsWith("--"));
  const [localDir, clientId] = positional;
  const agentFlag = args.find((a) => a.startsWith("--agent="))?.slice("--agent=".length);
  const scheduleStartFlag = args.find((a) => a.startsWith("--schedule-start="))?.slice("--schedule-start=".length);
  const bucketName = process.env.GCS_MEDIA_BUCKET;

  if (!localDir || !clientId) {
    console.error("Usage: npx tsx scripts/upload-local-clips.ts <localDir> <clientId> [--apply] [--agent=social_post] [--schedule-start=YYYY-MM-DD]");
    process.exit(1);
  }
  if (!bucketName) {
    console.error("GCS_MEDIA_BUCKET is not set in .env.local");
    process.exit(1);
  }

  initAdmin();
  const db = getFirestore();
  db.settings({ ignoreUndefinedProperties: true });
  const storage = initStorage();
  const bucket = storage.bucket(bucketName);

  const clientSnap = await db.collection("clients").doc(clientId).get();
  if (!clientSnap.exists) {
    console.error(`Client "${clientId}" not found`);
    process.exit(1);
  }

  const files = readdirSync(localDir)
    .filter((name) => VIDEO_EXTENSIONS.has(extname(name).toLowerCase()))
    .filter((name) => statSync(join(localDir, name)).isFile())
    .sort();

  if (files.length === 0) {
    console.log(`No .mp4/.mov files found in ${localDir}`);
    return;
  }

  console.log(
    apply
      ? `🎬 APPLYING — uploading ${files.length} clip(s) for client "${clientId}"\n`
      : `🎬 DRY RUN — nothing is uploaded. Pass --apply to write.\n   ${files.length} clip(s) found in ${localDir}\n`,
  );

  const registeredIds: string[] = [];
  let failed = 0;

  for (const filename of files) {
    const localPath = join(localDir, filename);
    const sizeBytes = statSync(localPath).size;
    const contentType = CONTENT_TYPE[extname(filename).toLowerCase()] ?? "video/mp4";
    const gcsPath = `clients/${clientId}/podcast-clips/${Date.now()}-${filename.replace(/[^a-zA-Z0-9._-]+/g, "-")}`;

    if (!apply) {
      console.log(`  would upload ${filename} (${(sizeBytes / (1024 * 1024)).toFixed(1)} MB) → gs://${bucketName}/${gcsPath}`);
      continue;
    }

    try {
      await bucket.upload(localPath, { destination: gcsPath, resumable: sizeBytes > 5 * 1024 * 1024 });
      const [videoUrl] = await bucket.file(gcsPath).getSignedUrl({
        version: "v4",
        action: "read",
        expires: Date.now() + 7 * 24 * 60 * 60 * 1000,
      });
      const durationSeconds = probeDurationSeconds(localPath);

      const now = Date.now();
      const ref = await db.collection("assets").add({
        clientId,
        agentId: null,
        type: "social_post" as AssetType,
        title: humanizeFilename(filename),
        content: "",
        meta: {
          bulkUpload: true,
          gcsPath,
          sourceFilename: filename,
          taskType: agentFlag ?? "social_post",
          formatTags: detectFormatTags(filename),
          ...(durationSeconds != null ? { durationSeconds } : {}),
        },
        videoUrl,
        mimeType: contentType,
        channels: ["tiktok"],
        status: "draft",
        createdBy: "upload-local-clips-script",
        createdAt: now,
        updatedAt: now,
      });
      registeredIds.push(ref.id);
      console.log(`  ✅ ${filename} → gs://${bucketName}/${gcsPath} (asset ${ref.id})`);
    } catch (err) {
      failed++;
      console.error(`  ❌ ${filename} failed:`, err);
    }
  }

  if (apply && scheduleStartFlag && registeredIds.length > 0) {
    console.log(`\n🗓  Auto-scheduling ${registeredIds.length} clip(s), 1/day from ${scheduleStartFlag}…`);
    const startAtMs = new Date(`${scheduleStartFlag}T00:00:00`).getTime();

    const allSnap = await db.collection("assets").where("clientId", "==", clientId).get();
    const occupiedDayStarts = new Set<number>();
    for (const doc of allSnap.docs) {
      const data = doc.data() as { type?: AssetType; scheduledAt?: number };
      if (data.scheduledAt != null && chainFamilyFor((data.type ?? "social_post") as AssetType) === "social") {
        occupiedDayStarts.add(startOfDayMs(data.scheduledAt));
      }
    }

    const assignments = planBulkSchedule(registeredIds, { startDayMs: startAtMs, platform: "tiktok", occupiedDayStarts });
    for (const assignment of assignments) {
      await db.collection("assets").doc(assignment.id).update({
        status: "scheduled",
        scheduledAt: assignment.scheduledAt,
        scheduledPlatform: "tiktok",
        publishMode: "manual",
        updatedAt: Date.now(),
      });
      console.log(`  ${assignment.id} → ${new Date(assignment.scheduledAt).toLocaleString()}`);
    }
  }

  console.log("\n── Summary ─────────────────────────────────────────────");
  console.log(`   ${apply ? "Uploaded" : "Would upload"}: ${apply ? registeredIds.length : files.length}`);
  if (apply) console.log(`   Failed:   ${failed}`);
  console.log("────────────────────────────────────────────────────────\n");
  process.exit(failed > 0 ? 1 : 0);
}

if (require.main === module) {
  main().catch((e) => {
    console.error(e);
    process.exit(1);
  });
}
