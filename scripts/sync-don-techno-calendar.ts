/**
 * Don Techno's weekly runway → the karosCMO content calendar.
 *
 * The don-techno-auto engine (github.com/karoslabs/don-techno-auto) plans and
 * builds 18 Instagram posts a week into the shared Dropbox
 * (`~/Dropbox/DonTechnoAuto/queue/week/<week>/<post>/`: the reel or the slides,
 * `caption.md`, `sources.md`, `data.json`) and writes Daniel a `RUNWAY.md`.
 * Daniel posts by hand: there is no Instagram API in that system, on purpose.
 * This script mirrors that queue onto the portal calendar so Daniel opens the
 * portal instead of Dropbox: one calendar entry per post at its Madrid posting
 * time, with the caption to paste, the credit line, the collaborator to invite,
 * the media to download and the sources behind it.
 *
 * What it reads (all local, nothing paid):
 *   <dropbox>/queue/week/<week>/<slug>/       the built posts (and <dropbox>/posts/<slug>/ once posted)
 *   <repo>/data/runway/<week>.json            the plan: date, post_time, format, subject, kicker, credit, collaborator
 *   <repo>/data/catalog/posts.jsonl           the catalog: built / posted / rejected, the Instagram URL once live
 *
 * What it writes (Firestore `assets` + Firebase Storage):
 *   one `instagram_post` asset per built post, keyed by meta.labRun = "dontechno/<week>#<slug>"
 *   media at lab-imports/lab-dontechno/<week>/<slug>/<file> (one copy shared by prep and production, reused when already there)
 *   a cover frame (ffmpeg, first slide at 1 s) for video-led posts so the calendar has a thumbnail
 *
 * Idempotent and re-runnable after every Sunday build and after every publish:
 *   - a new post is created as `scheduled` (publishMode "manual": the portal never auto-posts it)
 *   - an existing post is updated in place (caption, media, plan time, title)
 *   - a post the catalog marks posted becomes `published` with its Instagram link
 *   - a post the catalog marks rejected is never created (and reported if it already exists)
 *   - a scheduledAt someone moved by hand in the portal is kept unless the runway itself moved
 *   - a status the portal advanced (approved, published) is never downgraded
 *
 * CLI (dry run by default; the database is named, never guessed):
 *   FIRESTORE_DATABASE_ID=prep        npx tsx scripts/sync-don-techno-calendar.ts
 *   FIRESTORE_DATABASE_ID=prep        npx tsx scripts/sync-don-techno-calendar.ts --apply
 *   FIRESTORE_DATABASE_ID="(default)" npx tsx scripts/sync-don-techno-calendar.ts --apply
 *   options: --week=2026-W39   --client=<clientId>   --dropbox=<path>   --repo=<path>   --no-cover   --release-now
 *
 * --release-now: every post the plan dates in the future is dated TODAY (Madrid)
 * instead, at its planned time of day plus five minutes per day it was moved,
 * so the whole queue is open to the client at once and still reads in plan
 * order. The plan's own time stays in meta.runwayScheduledAt. Albert,
 * 2026-09-23: the engine builds new posts every day and Daniel should be able
 * to open and post everything that is built, not wait for the planned day.
 *            --report=<path> (write the portal's status of every runway asset as JSON, for the
 *            engine's catalog: a post the portal marked published becomes posted there)
 *            --report-only (the report and nothing else)
 *
 * The engine's wrapper `scripts/karos_push.sh` (don-techno-auto) runs this after every build
 * and every morning, so a new post is on the calendar without a manual step.
 */

import { execFileSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { basename, join, resolve } from "node:path";

function loadEnvFile(path: string) {
  try {
    for (const line of readFileSync(path, "utf-8").split("\n")) {
      const trimmed = line.trim();
      if (!trimmed || trimmed.startsWith("#")) continue;
      const eq = trimmed.indexOf("=");
      if (eq === -1) continue;
      const key = trimmed.slice(0, eq).trim();
      let val = trimmed.slice(eq + 1).trim();
      if ((val.startsWith('"') && val.endsWith('"')) || (val.startsWith("'") && val.endsWith("'"))) val = val.slice(1, -1);
      if (!process.env[key]) process.env[key] = val;
    }
  } catch {
    /* no env file: credentials may come from the environment */
  }
}
loadEnvFile(resolve(process.cwd(), ".env.local"));
loadEnvFile(resolve(process.cwd(), ".env"));

import { cert, getApps, initializeApp, type App } from "firebase-admin/app";
import type { Firestore } from "firebase-admin/firestore";
import { getStorage } from "firebase-admin/storage";
import { getScriptFirestore, resolveScriptDatabaseId } from "./lib/firestore-db";
import type { Asset, AssetType, PublishMode } from "../src/lib/types";

/* ── settings ─────────────────────────────────────────────────────────── */
const SLUG = "dontechno";
const SOURCE = "don-techno-auto";
/** Keyed by slug, not client id: prep and production point at ONE copy of each file (the same rule as `client-logos/lab-<slug>/`). */
const STORAGE_ROOT = `lab-imports/lab-${SLUG}`;
const POSTING_TIME_ZONE = "Europe/Madrid";
const CONTENT_CHAR_CAP = 100_000;
const ABOUT_CHAR_CAP = 4_000;
const MAX_FILE_BYTES = 400 * 1024 * 1024;
/** A slot with no time in the plan falls back to the engine's fixed times. */
const DEFAULT_TIME_BY_SLOT: Record<string, string> = { "reel-1": "10:00", carousel: "18:00", "reel-2": "21:00" };
const FORMAT_LABELS: Record<string, string> = {
  news_card_2slide: "News card",
  unexpected_people: "Unexpected people",
  unexpected_people_reel: "Unexpected people reel",
  place_headline: "Place headline",
  celebrity_crossover: "Celebrity crossover",
  decks_footage: "Decks footage",
  sample_origin: "Sample origin",
  sample_origin_reel: "Sample origin reel",
  nostalgia_reel: "Nostalgia reel",
  nostalgia_card: "Nostalgia card",
  moment_reel: "Moment reel",
  news_clip_reel: "News clip reel",
  own_meme: "Meme",
};

/* ── CLI ──────────────────────────────────────────────────────────────── */
const argv = process.argv.slice(2);
const APPLY = argv.includes("--apply");
const NO_COVER = argv.includes("--no-cover");
const RELEASE_NOW = argv.includes("--release-now");
const flag = (name: string) => argv.find((a) => a.startsWith(`--${name}=`))?.split("=").slice(1).join("=");
const WEEK_FILTER = flag("week");
const CLIENT_ID_ARG = flag("client");
// The Dropbox root is a flag, not an env var, so the repo's env inventory stays exact (the engine's own DT_DROPBOX is its business).
const DROPBOX = resolve(flag("dropbox") ?? join(homedir(), "Dropbox", "DonTechnoAuto"));
const REPO = resolve(flag("repo") ?? join(homedir(), "Code", "don-techno-auto"));
/**
 * --report=<path>: write what the portal holds for every runway asset (labRun, status,
 * publishedAt, scheduledAt) as JSON, so the engine can mark a post the portal published as
 * posted in its catalog (the reverse direction; the engine's daily job reads it). Read-only.
 * --report-only: write the report and stop before the plan.
 */
const REPORT = flag("report");
const REPORT_ONLY = argv.includes("--report-only");

/* ── firebase ─────────────────────────────────────────────────────────── */
function initAdmin(): App {
  if (getApps().length) return getApps()[0]!;
  const raw = process.env.FIREBASE_SERVICE_ACCOUNT_KEY;
  if (raw) return initializeApp({ credential: cert(JSON.parse(raw)) });
  const projectId = process.env.FIREBASE_PROJECT_ID;
  const clientEmail = process.env.FIREBASE_CLIENT_EMAIL;
  const privateKey = process.env.FIREBASE_PRIVATE_KEY?.replace(/\\n/g, "\n");
  if (!projectId || !clientEmail || !privateKey) {
    throw new Error("No Firebase credentials. Set FIREBASE_SERVICE_ACCOUNT_KEY or the three discrete vars in .env.local");
  }
  return initializeApp({ credential: cert({ projectId, clientEmail, privateKey }) });
}
function bucketName(): string {
  const raw = process.env.FIREBASE_STORAGE_BUCKET || process.env.NEXT_PUBLIC_FIREBASE_STORAGE_BUCKET;
  if (!raw) throw new Error("NEXT_PUBLIC_FIREBASE_STORAGE_BUCKET is not set");
  return raw.replace(/^gs:\/\//, "").replace(/\/+$/, "").trim();
}
const CONTENT_TYPES: Record<string, string> = {
  ".mp4": "video/mp4",
  ".mov": "video/quicktime",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".webp": "image/webp",
  ".md": "text/markdown",
  ".txt": "text/plain",
  ".json": "application/json",
};
function contentTypeFor(name: string): string {
  const i = name.lastIndexOf(".");
  return (i >= 0 && CONTENT_TYPES[name.slice(i).toLowerCase()]) || "application/octet-stream";
}
function downloadUrl(bucket: string, path: string, token: string): string {
  return `https://firebasestorage.googleapis.com/v0/b/${bucket}/o/${encodeURIComponent(path)}?alt=media&token=${token}`;
}

type Uploaded = { url: string; bytes: number; reused: boolean };
/** Upload once: an object already there with the same size keeps its URL (and its token, which both databases share). */
async function uploadOnce(app: App, localPath: string, storagePath: string, apply: boolean): Promise<Uploaded> {
  const name = bucketName();
  const file = getStorage(app).bucket(name).file(storagePath);
  const bytes = statSync(localPath).size;
  try {
    const [md] = await file.getMetadata();
    const token = (md.metadata?.firebaseStorageDownloadTokens as string | undefined)?.split(",")[0];
    if (Number(md.size ?? -1) === bytes && token) return { url: downloadUrl(name, storagePath, token), bytes, reused: true };
  } catch {
    /* not there yet */
  }
  const token = randomUUID();
  if (apply) {
    await file.save(readFileSync(localPath), {
      resumable: bytes > 8 * 1024 * 1024,
      contentType: contentTypeFor(storagePath),
      metadata: { metadata: { firebaseStorageDownloadTokens: token } },
    });
  }
  return { url: downloadUrl(name, storagePath, token), bytes, reused: false };
}

/* ── time ─────────────────────────────────────────────────────────────── */
function tzOffsetMs(ts: number, timeZone: string): number {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone,
    hourCycle: "h23",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
  }).formatToParts(new Date(ts));
  const get = (t: string) => Number(parts.find((p) => p.type === t)?.value);
  const local = Date.UTC(get("year"), get("month") - 1, get("day"), get("hour"), get("minute"), get("second"));
  return local - Math.floor(ts / 1000) * 1000;
}
/** "2026-09-25" + "18:00" in Europe/Madrid → epoch millis. */
function zonedToUtc(ymd: string, hm: string, timeZone: string): number {
  const [y, m, d] = ymd.split("-").map(Number);
  const [h, mi] = hm.split(":").map(Number);
  const asUtc = Date.UTC(y, m - 1, d, h, mi);
  let ts = asUtc - tzOffsetMs(asUtc, timeZone);
  const again = asUtc - tzOffsetMs(ts, timeZone);
  if (again !== ts) ts = again;
  return ts;
}
/** Today's date in the posting zone, as YYYY-MM-DD. */
function todayInZone(timeZone: string, now: number): string {
  const parts = new Intl.DateTimeFormat("en-CA", { timeZone, year: "numeric", month: "2-digit", day: "2-digit" }).formatToParts(new Date(now));
  const get = (t: string) => parts.find((p) => p.type === t)?.value;
  return `${get("year")}-${get("month")}-${get("day")}`;
}
function daysBetween(fromYmd: string, toYmd: string): number {
  const d = (ymd: string) => {
    const [y, m, dd] = ymd.split("-").map(Number);
    return Date.UTC(y, m - 1, dd);
  };
  return Math.round((d(toYmd) - d(fromYmd)) / 86_400_000);
}
/**
 * Where --release-now puts a post the plan dates after today: today, at the
 * planned time of day, plus five minutes for every day it was pulled forward,
 * so three 10:00 reels from three days land at 10:00, 10:05 and 10:10.
 */
function releaseSlot(plannedDate: string, time: string, now: number): number | null {
  const today = todayInZone(POSTING_TIME_ZONE, now);
  const ahead = daysBetween(today, plannedDate);
  if (ahead <= 0) return null;
  return zonedToUtc(today, time, POSTING_TIME_ZONE) + ahead * 5 * 60_000;
}
function iso(t: number | null | undefined): string {
  return t == null ? "—" : new Date(t).toISOString().replace(".000Z", "Z");
}
function humanDate(ymd: string): string {
  const [y, m, d] = ymd.split("-").map(Number);
  return new Date(Date.UTC(y, m - 1, d)).toLocaleDateString("en-GB", { weekday: "long", day: "numeric", month: "long", timeZone: "UTC" });
}

/* ── the engine's files ───────────────────────────────────────────────── */
interface PlanSlot {
  id: string;
  date: string;
  slot: string;
  post_time?: string;
  format?: string | null;
  status?: string;
  subject?: string | null;
  kicker?: string | null;
  credit?: string | null;
  collaborator?: string | null;
  output_dir?: string | null;
}
interface PostData {
  slug?: string;
  week?: string;
  slot?: string;
  format?: string;
  kind?: string;
  caption?: string;
  slides?: Array<{ n?: number; kind?: string; video?: string; image?: string; source?: string; credit?: string }>;
}
interface CatalogRecord {
  id: string;
  status?: string;
  date?: string;
  instagram_url?: string;
  format?: string;
  kind?: string;
}

function readJson<T>(path: string): T | null {
  try {
    return JSON.parse(readFileSync(path, "utf-8")) as T;
  } catch {
    return null;
  }
}
function readText(path: string, cap: number): string {
  try {
    return readFileSync(path, "utf-8").slice(0, cap);
  } catch {
    return "";
  }
}
function loadCatalog(): Map<string, CatalogRecord> {
  const out = new Map<string, CatalogRecord>();
  const path = join(REPO, "data", "catalog", "posts.jsonl");
  if (!existsSync(path)) return out;
  for (const line of readFileSync(path, "utf-8").split("\n")) {
    if (!line.trim()) continue;
    try {
      const rec = JSON.parse(line) as CatalogRecord;
      if (rec.id?.startsWith("post:")) out.set(rec.id.slice(5), rec);
    } catch {
      /* a bad line never blocks the sync */
    }
  }
  return out;
}
function loadPlan(week: string): Map<string, PlanSlot> {
  const out = new Map<string, PlanSlot>();
  const plan = readJson<{ slots?: PlanSlot[] }>(join(REPO, "data", "runway", `${week}.json`));
  for (const slot of plan?.slots ?? []) {
    const dir = slot.output_dir?.replace(/\/+$/, "");
    if (dir) out.set(basename(dir), slot);
  }
  return out;
}
function mediaFiles(dir: string): string[] {
  return readdirSync(dir)
    .filter((f) => /^slide-\d+\.(mp4|mov|png|jpe?g|webp)$/i.test(f))
    .sort((a, b) => parseInt(a.match(/\d+/)![0], 10) - parseInt(b.match(/\d+/)![0], 10));
}
function titleCase(s: string): string {
  return s.split(/[-_\s]+/).filter(Boolean).map((w) => w.charAt(0).toUpperCase() + w.slice(1)).join(" ");
}
function formatLabel(format: string | undefined, kind: string | undefined): { key: string; name: string } {
  const key = (format || kind || "post").toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "");
  return { key, name: FORMAT_LABELS[format ?? ""] ?? titleCase(format ?? kind ?? "post") };
}

/** A cover frame for a video-led post: the calendar and the archive want a thumbnail; the player uses it as its poster. */
function extractCover(videoPath: string, workDir: string): string | null {
  if (NO_COVER) return null;
  const out = join(workDir, `${basename(videoPath, ".mp4")}-cover.jpg`);
  try {
    execFileSync(
      "ffmpeg",
      ["-y", "-loglevel", "error", "-ss", "1", "-i", videoPath, "-frames:v", "1", "-vf", "scale=720:-2", "-q:v", "4", out],
      { stdio: ["ignore", "ignore", "pipe"] },
    );
    return existsSync(out) ? out : null;
  } catch {
    return null;
  }
}

/* ── one post ─────────────────────────────────────────────────────────── */
interface Planned {
  labRun: string;
  slug: string;
  week: string;
  where: "queue" | "posts";
  kind: "reel" | "carousel";
  date: string;
  time: string;
  scheduledAt: number;
  plannedAt: number;
  catalogStatus: string;
  doc: Omit<Asset, "id">;
  existing: (Asset & { id: string }) | null;
  action: "create" | "update" | "skip-rejected" | "unchanged";
  mediaBytes: number;
  uploads: number;
  files: number;
}

async function buildPost(args: {
  app: App;
  clientId: string;
  week: string;
  dir: string;
  where: "queue" | "posts";
  slot: PlanSlot | undefined;
  catalog: CatalogRecord | undefined;
  existing: (Asset & { id: string }) | null;
  now: number;
  workDir: string;
}): Promise<Planned | null> {
  const { app, clientId, week, dir, where, slot, catalog, existing, now, workDir } = args;
  const slug = basename(dir);
  const files = mediaFiles(dir);
  if (files.length === 0) return null;
  const data = readJson<PostData>(join(dir, "data.json")) ?? {};
  const isVideo = (f: string) => /\.(mp4|mov)$/i.test(f);
  const kind: "reel" | "carousel" = data.kind === "reel" || (files.length === 1 && isVideo(files[0]) && /reel/.test(slug)) ? "reel" : "carousel";
  const date = slot?.date ?? data.slot?.split("/")[0] ?? slug.slice(0, 10);
  const slotName = slot?.slot ?? data.slot?.split("/")[1] ?? (kind === "carousel" ? "carousel" : "reel-1");
  const time = slot?.post_time ?? DEFAULT_TIME_BY_SLOT[slotName] ?? "18:00";
  const plannedAt = zonedToUtc(date, time, POSTING_TIME_ZONE);
  const released = RELEASE_NOW ? releaseSlot(date, time, now) : null;
  const scheduledAt = released ?? plannedAt;
  const labRun = `${SLUG}/${week}#${slug}`;
  const catalogStatus = catalog?.status ?? (where === "posts" ? "posted" : "built");

  const hosted: Array<{ name: string; relPath: string; url: string; bytes: number; contentType: string }> = [];
  let mediaBytes = 0;
  let uploads = 0;
  const imageUrls: string[] = [];
  const videoUrls: string[] = [];
  for (const name of files) {
    const local = join(dir, name);
    const bytes = statSync(local).size;
    if (bytes > MAX_FILE_BYTES) {
      console.warn(`  ! ${slug}/${name} is ${(bytes / 1e6).toFixed(0)} MB, over the ${MAX_FILE_BYTES / 1e6} MB cap: skipped`);
      continue;
    }
    const storagePath = `${STORAGE_ROOT}/${week}/${slug}/${name}`;
    const up = await uploadOnce(app, local, storagePath, APPLY);
    hosted.push({ name, relPath: `${slug}/${name}`, url: up.url, bytes: up.bytes, contentType: contentTypeFor(name) });
    mediaBytes += up.bytes;
    if (!up.reused) uploads++;
    (isVideo(name) ? videoUrls : imageUrls).push(up.url);
  }
  if (hosted.length === 0) return null;

  // The cover: the first image slide, else a frame from the first video.
  let imageUrl: string | null = imageUrls[0] ?? null;
  if (!imageUrl && isVideo(files[0])) {
    const coverPath = `${STORAGE_ROOT}/${week}/${slug}/cover.jpg`;
    const bucket = getStorage(app).bucket(bucketName()).file(coverPath);
    let reusedCover: string | null = null;
    try {
      const [md] = await bucket.getMetadata();
      const token = (md.metadata?.firebaseStorageDownloadTokens as string | undefined)?.split(",")[0];
      if (token) reusedCover = downloadUrl(bucketName(), coverPath, token);
    } catch {
      /* no cover yet */
    }
    if (reusedCover) imageUrl = reusedCover;
    else {
      const frame = extractCover(join(dir, files[0]), workDir);
      if (frame) {
        const up = await uploadOnce(app, frame, coverPath, APPLY);
        imageUrl = up.url;
        if (!up.reused) uploads++;
      }
    }
  }

  // The sources file travels as a named attachment, so the reviewer can check a claim from the calendar.
  const sourcesLocal = join(dir, "sources.md");
  if (existsSync(sourcesLocal)) {
    const up = await uploadOnce(app, sourcesLocal, `${STORAGE_ROOT}/${week}/${slug}/sources.md`, APPLY);
    hosted.push({ name: "sources.md", relPath: `${slug}/sources.md`, url: up.url, bytes: up.bytes, contentType: "text/markdown" });
    if (!up.reused) uploads++;
  }

  const caption = (readText(join(dir, "caption.md"), CONTENT_CHAR_CAP) || data.caption || "").trim();
  const template = formatLabel(slot?.format ?? data.format, kind);
  const title = (slot?.subject?.trim() || titleCase(slug.replace(/^\d{4}-\d{2}-\d{2}-/, ""))).slice(0, 160);
  const howToPost =
    kind === "reel"
      ? `Post ${files[0]} as a Reel, original audio on, no cover.`
      : `Post as a carousel, ${files.length} slide${files.length === 1 ? "" : "s"} in order (${files[0]} first).`;
  const about = [
    `${kind === "reel" ? "Reel" : "Carousel"} for ${humanDate(date)} at ${time} (${POSTING_TIME_ZONE.replace("Europe/", "")}), weekly runway ${week}, slot ${slotName}.`,
    howToPost,
    slot?.credit ? `Credit: ${slot.credit}` : "",
    slot?.collaborator ? `Invite as collaborator: ${slot.collaborator}` : "",
    "Paste the caption as it is.",
  ]
    .filter(Boolean)
    .join(" ")
    .slice(0, ABOUT_CHAR_CAP);

  const posted = catalogStatus === "posted";
  const meta: Record<string, unknown> = {
    source: SOURCE,
    labRun,
    agentFolder: "instagram-agent",
    week,
    slot: slotName,
    date,
    postTime: time,
    postTimeZone: POSTING_TIME_ZONE,
    runwayScheduledAt: plannedAt,
    ...(released != null ? { releasedAt: now } : {}),
    format: slot?.format ?? data.format ?? null,
    kind,
    ...(slot?.kicker ? { kicker: slot.kicker } : {}),
    ...(slot?.credit ? { credit: slot.credit } : {}),
    ...(slot?.collaborator ? { collaborator: slot.collaborator } : {}),
    engineStatus: catalogStatus,
    ...(catalog?.instagram_url ? { instagramUrl: catalog.instagram_url } : {}),
    about,
    ...(imageUrls.length > 0 ? { images: imageUrls } : {}),
    files: hosted,
    syncedAt: now,
  };

  const doc: Omit<Asset, "id"> = {
    clientId,
    jobId: null,
    agentId: null,
    type: "instagram_post" as AssetType,
    title,
    content: caption,
    meta,
    imageUrl,
    videoUrl: kind === "reel" ? (videoUrls[0] ?? null) : null,
    ...(kind === "reel" ? { mimeType: "video/mp4" } : {}),
    channels: ["instagram"],
    status: posted ? "published" : "scheduled",
    scheduledAt,
    scheduledPlatform: "instagram",
    publishMode: "manual" as PublishMode,
    recommendedAt: plannedAt,
    recommendedReason: `Weekly runway ${week}: ${slotName} at ${time} ${POSTING_TIME_ZONE.replace("Europe/", "")}`,
    ...(posted ? { publishedAt: Math.min(plannedAt, now) } : {}),
    templateKey: template.key,
    templateName: template.name,
    orderKey: `${date}T${time}#${slug}`,
    createdBy: "don-techno-sync",
    createdAt: existing?.createdAt ?? now,
    updatedAt: now,
  };

  let action: Planned["action"] = existing ? "update" : "create";
  if (catalogStatus === "rejected") action = "skip-rejected";
  return {
    labRun,
    slug,
    week,
    where,
    kind,
    date,
    time,
    scheduledAt,
    plannedAt,
    catalogStatus,
    doc,
    existing,
    action,
    mediaBytes,
    uploads,
    files: hosted.length,
  };
}

/** The fields an update may touch, honouring what the portal changed since the last sync. */
function updatePatch(p: Planned): Partial<Asset> {
  const ex = p.existing!;
  const exMeta = (ex.meta ?? {}) as Record<string, unknown>;
  const patch: Partial<Asset> = {
    title: p.doc.title,
    content: p.doc.content,
    meta: { ...exMeta, ...p.doc.meta },
    imageUrl: p.doc.imageUrl,
    videoUrl: p.doc.videoUrl,
    ...(p.doc.mimeType ? { mimeType: p.doc.mimeType } : {}),
    channels: p.doc.channels,
    templateKey: p.doc.templateKey,
    templateName: p.doc.templateName,
    orderKey: p.doc.orderKey,
    publishMode: "manual",
    recommendedAt: p.doc.recommendedAt,
    recommendedReason: p.doc.recommendedReason,
    updatedAt: p.doc.updatedAt,
  };
  const runwayMoved = exMeta.runwayScheduledAt !== p.plannedAt;
  const handMoved = ex.scheduledAt != null && ex.scheduledAt !== exMeta.runwayScheduledAt;
  // --release-now pulls a future-dated post to today even if someone moved it by hand.
  const releasing = RELEASE_NOW && p.scheduledAt !== p.plannedAt && ex.scheduledAt != null && ex.scheduledAt > p.scheduledAt;
  if (releasing || runwayMoved || !handMoved || ex.scheduledAt == null) patch.scheduledAt = p.scheduledAt;
  const portalPublished = ex.status === "published" || ex.publishedAt != null;
  if (p.catalogStatus === "posted" && !portalPublished) {
    patch.status = "published";
    patch.publishedAt = p.doc.publishedAt;
  }
  // Never downgrade: a draft the portal approved or scheduled keeps its status.
  return patch;
}

function changed(p: Planned, patch: Partial<Asset>): boolean {
  const ex = p.existing!;
  const exMeta = (ex.meta ?? {}) as Record<string, unknown>;
  const newMeta = (patch.meta ?? {}) as Record<string, unknown>;
  const metaKeys = ["labRun", "week", "slot", "date", "postTime", "format", "kind", "kicker", "credit", "collaborator", "engineStatus", "instagramUrl", "about", "images"];
  const filesOf = (m: Record<string, unknown>) => JSON.stringify(((m.files as Array<{ url: string }> | undefined) ?? []).map((f) => f.url));
  return (
    ex.title !== patch.title ||
    ex.content !== patch.content ||
    (ex.imageUrl ?? null) !== (patch.imageUrl ?? null) ||
    (ex.videoUrl ?? null) !== (patch.videoUrl ?? null) ||
    ex.templateKey !== patch.templateKey ||
    ex.orderKey !== patch.orderKey ||
    (patch.scheduledAt != null && ex.scheduledAt !== patch.scheduledAt) ||
    (patch.status != null && ex.status !== patch.status) ||
    filesOf(exMeta) !== filesOf(newMeta) ||
    metaKeys.some((k) => JSON.stringify(exMeta[k] ?? null) !== JSON.stringify(newMeta[k] ?? null))
  );
}

/* ── main ─────────────────────────────────────────────────────────────── */
async function resolveClientId(db: Firestore): Promise<string> {
  if (CLIENT_ID_ARG) {
    const snap = await db.collection("clients").doc(CLIENT_ID_ARG).get();
    if (!snap.exists) throw new Error(`No client ${CLIENT_ID_ARG}`);
    return snap.id;
  }
  const bySlug = await db.collection("clients").where("agentsRepoSlug", "==", SLUG).limit(1).get();
  if (bySlug.empty) throw new Error(`No client with agentsRepoSlug "${SLUG}". Run scripts/import-lab-client.ts ${SLUG} --apply first.`);
  return bySlug.docs[0].id;
}

async function preflightWriteAccess(app: App, db: Firestore, clientId: string) {
  const file = getStorage(app).bucket(bucketName()).file(`lab-imports/${clientId}/_preflight/write-access-ok.txt`);
  await file.save(Buffer.from(`ok ${new Date().toISOString()}`), { resumable: false, contentType: "text/plain" });
  await db.collection("_importPreflight").doc(`${SLUG}-calendar`).set({ at: Date.now(), ok: true }, { merge: true });
}

async function main() {
  const databaseId = resolveScriptDatabaseId();
  console.log(
    `\nDon Techno runway → calendar · ${APPLY ? "APPLY (writes)" : "DRY RUN (no writes)"} · database ${databaseId === "(default)" ? "(default) — PRODUCTION" : databaseId}`,
  );
  console.log(`Dropbox: ${DROPBOX}\nEngine repo: ${REPO}\nStorage bucket: ${bucketName()}`);
  if (!existsSync(join(DROPBOX, "queue", "week"))) throw new Error(`No queue/week under ${DROPBOX}`);

  const app = initAdmin();
  const db = getScriptFirestore(app);
  db.settings({ ignoreUndefinedProperties: true });
  const now = Date.now();
  const clientId = await resolveClientId(db);
  console.log(`Client: ${clientId}`);

  const existing = new Map<string, Asset & { id: string }>();
  const snap = await db.collection("assets").where("clientId", "==", clientId).get();
  for (const d of snap.docs) {
    const a = { ...(d.data() as Asset), id: d.id };
    const lr = (a.meta as { labRun?: string } | undefined)?.labRun;
    if (typeof lr === "string" && lr.startsWith(`${SLUG}/`)) existing.set(lr, a);
  }
  console.log(`Existing runway assets on this client: ${existing.size}`);

  if (REPORT) {
    const rows = [...existing.entries()]
      .map(([labRun, a]) => ({
        labRun,
        week: labRun.slice(SLUG.length + 1).split("#")[0] ?? null,
        slug: labRun.split("#")[1] ?? null,
        assetId: a.id,
        status: a.status,
        publishedAt: a.publishedAt ?? null,
        scheduledAt: a.scheduledAt ?? null,
        platformPostId: a.platformPostId ?? null,
        engineStatus: ((a.meta as { engineStatus?: string } | undefined)?.engineStatus ?? null),
      }))
      .sort((x, y) => (x.labRun < y.labRun ? -1 : 1));
    writeFileSync(REPORT, JSON.stringify({ clientId, databaseId, at: now, assets: rows }, null, 2) + "\n");
    console.log(`Report: ${rows.length} asset(s) → ${REPORT}`);
    if (REPORT_ONLY) return;
  }

  const catalog = loadCatalog();
  const weeks = readdirSync(join(DROPBOX, "queue", "week"))
    .filter((w) => /^\d{4}-W\d{2}$/.test(w) && (!WEEK_FILTER || w === WEEK_FILTER))
    .sort();
  // Posted folders were dragged to posts/; their data.json still names the week.
  const postedDirs: Array<{ dir: string; week: string }> = [];
  const postsRoot = join(DROPBOX, "posts");
  if (existsSync(postsRoot)) {
    for (const name of readdirSync(postsRoot)) {
      const dir = join(postsRoot, name);
      if (!statSync(dir).isDirectory()) continue;
      const data = readJson<PostData>(join(dir, "data.json"));
      if (data?.week && /^\d{4}-W\d{2}$/.test(data.week) && (!WEEK_FILTER || data.week === WEEK_FILTER)) postedDirs.push({ dir, week: data.week });
    }
  }
  const allWeeks = [...new Set([...weeks, ...postedDirs.map((p) => p.week)])].sort();
  console.log(`Weeks: ${allWeeks.join(", ") || "none"}`);

  const workDir = mkdtempSync(join(tmpdir(), "dt-covers-"));
  const planned: Planned[] = [];
  const skippedNoMedia: string[] = [];
  try {
    for (const week of allWeeks) {
      const plan = loadPlan(week);
      const queueRoot = join(DROPBOX, "queue", "week", week);
      const dirs: Array<{ dir: string; where: "queue" | "posts" }> = [];
      if (existsSync(queueRoot)) {
        for (const name of readdirSync(queueRoot)) {
          const dir = join(queueRoot, name);
          if (statSync(dir).isDirectory() && !name.startsWith(".") && !name.startsWith("_")) dirs.push({ dir, where: "queue" });
        }
      }
      for (const p of postedDirs.filter((x) => x.week === week)) dirs.push({ dir: p.dir, where: "posts" });
      for (const { dir, where } of dirs.sort((a, b) => basename(a.dir).localeCompare(basename(b.dir)))) {
        const slug = basename(dir);
        const slot = plan.get(slug);
        const cat = catalog.get(slug);
        if (cat?.status === "rejected" && !existing.has(`${SLUG}/${week}#${slug}`)) continue;
        const built = await buildPost({ app, clientId, week, dir, where, slot, catalog: cat, existing: existing.get(`${SLUG}/${week}#${slug}`) ?? null, now, workDir });
        if (!built) {
          skippedNoMedia.push(slug);
          continue;
        }
        if (built.action === "update" && !changed(built, updatePatch(built))) built.action = "unchanged";
        planned.push(built);
      }
    }
  } finally {
    rmSync(workDir, { recursive: true, force: true });
  }

  /* cron safety: nothing here may ever match the auto-publish predicate */
  const cronMatches = planned.filter(
    (p) => p.action === "create" && p.doc.status !== "published" && (p.doc.publishMode === "auto" || p.doc.publishMode == null) && (p.doc.scheduledAt ?? Infinity) <= now,
  );
  const nonManual = planned.filter((p) => p.doc.publishMode !== "manual");
  if (cronMatches.length || nonManual.length) {
    console.error(`\nASSERTION FAILED: ${nonManual.length} non-manual, ${cronMatches.length} cron-matching. Nothing written.`);
    process.exit(1);
  }

  console.log("\nPlan:");
  for (const p of planned) {
    const flag = p.action === "create" ? "+" : p.action === "update" ? "~" : p.action === "unchanged" ? "=" : "x";
    console.log(
      `  ${flag} ${p.date} ${p.time} ${p.kind.padEnd(8)} ${p.slug}\n      ${p.doc.title}\n      ${p.doc.status} · ${iso(p.scheduledAt)}${p.scheduledAt !== p.plannedAt ? ` (released; plan ${iso(p.plannedAt)})` : ""} · ${p.files} files (${(p.mediaBytes / 1e6).toFixed(1)} MB, ${p.uploads} to upload) · catalog ${p.catalogStatus}${p.existing ? ` · asset ${p.existing.id}` : ""}`,
    );
  }
  if (skippedNoMedia.length) console.log(`\nNo media yet (not synced): ${skippedNoMedia.join(", ")}`);
  const counts = planned.reduce<Record<string, number>>((acc, p) => ((acc[p.action] = (acc[p.action] ?? 0) + 1), acc), {});
  console.log(`\nSummary: ${JSON.stringify(counts)} · upload ${(planned.reduce((s, p) => s + (p.uploads ? p.mediaBytes : 0), 0) / 1e6).toFixed(0)} MB`);

  if (!APPLY) {
    console.log("\nDry run: nothing written. Pass --apply to upload the media and write the calendar.");
    return;
  }
  await preflightWriteAccess(app, db, clientId);
  let created = 0;
  let updated = 0;
  for (const p of planned) {
    if (p.action === "create") {
      const ref = await db.collection("assets").add(p.doc);
      created++;
      console.log(`  created ${ref.id}  ${p.slug}`);
    } else if (p.action === "update") {
      await db.collection("assets").doc(p.existing!.id).set(updatePatch(p), { merge: true });
      updated++;
      console.log(`  updated ${p.existing!.id}  ${p.slug}`);
    } else if (p.action === "skip-rejected") {
      console.warn(`  ! ${p.slug} is rejected in the engine's catalog but exists as asset ${p.existing!.id}: left alone, unschedule it by hand`);
    }
  }
  console.log(`\n✔ Done: ${created} created, ${updated} updated, ${counts.unchanged ?? 0} unchanged.`);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
