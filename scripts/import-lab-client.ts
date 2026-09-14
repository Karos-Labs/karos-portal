/**
 * Import a karos-agents lab client into the portal — client record, brand
 * (colors + logo), Context OS profile docs, competitor tracking, and every
 * committed lab-run deliverable — straight from a LOCAL checkout of the lab
 * repo (no AGENTS_REPO_GITHUB_TOKEN needed).
 *
 * What it does (idempotent — safe to re-run):
 *   1. Upserts the client (matched by agentsRepoSlug, then by name):
 *      name/website/description from clients/<slug>/config.json + README.md,
 *      accent + brandingGuidelines from profile/brand-colors.json, logo
 *      uploaded from brand/logos/, agentsRepoSlug set for future UI imports.
 *   2. Imports profile/*.md as internal-tier clientContextDocs (skips doc
 *      types that already exist — the portal's regenerate pipeline owns them
 *      after that).
 *   3. Seeds clientCompetitors from profile/competitor-tracking.json (active
 *      competitors only, skipping names already present). Tier mapping keeps
 *      the tracked-5 selector surfacing the direct rivals first.
 *   4. Imports every outputs/<agent>/<run>/client/ deliverable as a draft
 *      asset with the SAME meta.labRun keys the in-app importer writes, so
 *      the UI's lab-import screen shows these runs as already imported.
 *
 * Run — name the database every time; the script refuses to guess:
 *   FIRESTORE_DATABASE_ID=prep npx tsx scripts/import-lab-client.ts geektime                 # dry run — prints the plan
 *   FIRESTORE_DATABASE_ID=prep npx tsx scripts/import-lab-client.ts geektime --apply         # writes to prep
 *   FIRESTORE_DATABASE_ID="(default)" npx tsx scripts/import-lab-client.ts geektime --apply  # writes to PRODUCTION
 *   FIRESTORE_DATABASE_ID=prep npx tsx scripts/import-lab-client.ts geektime --lab-root=/path/to/karos-agents
 *
 * DRY RUN IS THE DEFAULT ON PURPOSE. Read the printed plan first; its opening
 * banner names the database and the storage bucket the run targets. A dry run
 * never opens Firestore, so its plan lists everything as new — it cannot know
 * what the named database already holds.
 *
 * DATABASE. One Firebase project, two databases: "(default)" is production,
 * "prep" is prep, and the credentials in .env.local are for that one project.
 * firebase-admin never reads FIRESTORE_DATABASE_ID itself: a bare
 * getFirestore() opens "(default)" whatever that variable says, so this script
 * used to write to production even when run as FIRESTORE_DATABASE_ID=prep.
 * It now opens Firestore through scripts/lib/firestore-db.ts (SCRUM-374), which
 * opens the named database and refuses — dry run included — when
 * FIRESTORE_DATABASE_ID is unset or unrecognised. Production is never the
 * fallback; it has to be named as "(default)".
 *
 * STORAGE IS SHARED. The logo + deliverable uploads go to
 * NEXT_PUBLIC_FIREBASE_STORAGE_BUCKET (required for --apply), the one bucket
 * prep and production both use, whichever database is named. Their paths are
 * not unique to a database either. The logo is keyed by slug
 * (client-logos/lab-<slug>/). Deliverables are keyed by client id
 * (lab-imports/<clientId>/...), and sync-prep-from-production.ts copies clients
 * to prep under their production ids. The in-app importer writes those same
 * deliverable paths too. So every upload goes through
 * scripts/lib/storage-upload.ts, which never replaces an object: an upload
 * lands only if nothing is at its path yet, and otherwise the object already
 * there is reused with its own download token. Replacing it would mint a new
 * token and leave every record holding the old one pointing at a dead URL —
 * the stale-token failure scripts/repair-stale-lab-import-tokens.ts describes.
 * A reused object keeps its bytes, even if the lab file has changed since.
 *
 * Reads Firebase credentials from .env.local (same pattern as
 * backfill-branding.ts).
 */

import { randomBytes } from "node:crypto";
import { readdirSync, readFileSync, statSync, existsSync } from "node:fs";
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

// ── Firebase Admin ───────────────────────────────────────────────────────────
import { initializeApp, getApps, cert, type App } from "firebase-admin/app";
import type { Firestore } from "firebase-admin/firestore";
import { getScriptFirestore, resolveScriptDatabaseId } from "./lib/firestore-db";
import { uploadIfAbsent } from "./lib/storage-upload";

// Pure portal helpers (client-safe modules — no server-only imports).
import {
  groupRunFiles,
  guessAssetType,
  humanizeItemName,
  pickPrimaryFiles,
  type LabFile,
} from "../src/lib/lab-outputs-shared";
import { chainFamilyFor, orderKeyForLabItem, planClientChain, templateFromItemKey } from "../src/lib/post-chain";
import { recommendedScheduleFields } from "../src/lib/scheduling";
import { clampClientCategoryValue, clientCategoryValue } from "../src/lib/utils";
import type {
  Asset,
  BrandColor,
  BrandingGuidelines,
  Client,
  ClientCompetitor,
  ClientContextDoc,
  ContextDocType,
} from "../src/lib/types";

let app: App;
function initAdmin(): Firestore {
  if (!getApps().length) {
    const raw = process.env.FIREBASE_SERVICE_ACCOUNT_KEY;
    if (raw) {
      app = initializeApp({ credential: cert(JSON.parse(raw)) });
    } else {
      const projectId = process.env.FIREBASE_PROJECT_ID;
      const clientEmail = process.env.FIREBASE_CLIENT_EMAIL;
      const privateKey = process.env.FIREBASE_PRIVATE_KEY?.replace(/\\n/g, "\n");
      if (!projectId || !clientEmail || !privateKey) {
        throw new Error(
          "No Firebase credentials. Set FIREBASE_SERVICE_ACCOUNT_KEY or the three discrete vars in .env.local",
        );
      }
      app = initializeApp({ credential: cert({ projectId, clientEmail, privateKey }) });
    }
  } else {
    app = getApps()[0]!;
  }
  // Opens the database FIRESTORE_DATABASE_ID names, never a bare
  // getFirestore() — that is "(default)", production, whatever the variable
  // says. settings() merges into the instance's existing settings, so the
  // database id survives it.
  const db = getScriptFirestore(app);
  db.settings({ ignoreUndefinedProperties: true });
  return db;
}

// ── Storage (uploads go through scripts/lib/storage-upload.ts) ───────────────
function bucketName(): string {
  const b = process.env.NEXT_PUBLIC_FIREBASE_STORAGE_BUCKET;
  if (!b) throw new Error("NEXT_PUBLIC_FIREBASE_STORAGE_BUCKET is not set");
  return b;
}

async function adminAccessToken(): Promise<string> {
  const cred = (app.options as { credential?: { getAccessToken(): Promise<{ access_token: string }> } }).credential;
  if (!cred) throw new Error("Admin credential unavailable for storage upload");
  const { access_token } = await cred.getAccessToken();
  return access_token;
}

// ── Constants (kept in step with src/lib/lab-outputs.ts + lab-output-actions) ─
const MAX_LAB_FILE_BYTES = 25 * 1024 * 1024;
const MAX_LAB_RUN_BYTES = 500 * 1024 * 1024;
const CONTENT_CHAR_CAP = 100_000;

const CONTENT_TYPES: Record<string, string> = {
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".webp": "image/webp",
  ".gif": "image/gif",
  ".svg": "image/svg+xml",
  ".md": "text/markdown",
  ".txt": "text/plain",
  ".html": "text/html",
  ".json": "application/json",
  ".pdf": "application/pdf",
  ".mp4": "video/mp4",
};
function contentTypeFor(name: string): string {
  const i = name.lastIndexOf(".");
  return (i >= 0 && CONTENT_TYPES[name.slice(i).toLowerCase()]) || "application/octet-stream";
}

/** profile/<file>.md → portal ContextDocType (identical vocabularies by design). */
const PROFILE_DOC_TYPES: Record<string, ContextDocType> = {
  "brand-voice.md": "brand-voice",
  "market-strategy.md": "market-strategy",
  "competitor-analysis.md": "competitor-analysis",
  "product-information.md": "product-information",
  "branding-guidelines.md": "branding-guidelines",
  "target-audience.md": "target-audience",
  "client-guidelines.md": "client-guidelines",
};

/** Lab competitor tier → portal analyst fields. Direct rivals must win the
 *  tracked-5 backfill, so they map to the strongest score combination. */
const TIER_MAP: Record<string, Pick<ClientCompetitor, "marketTier" | "overlap" | "threatLevel">> = {
  direct: { marketTier: "Leader", overlap: "High", threatLevel: "HIGH" },
  secondary: { marketTier: "Challenger", overlap: "Medium", threatLevel: "MEDIUM" },
  niche: { marketTier: "Niche", overlap: "Low-Med", threatLevel: "LOW" },
  international: { marketTier: "Other", overlap: "Low", threatLevel: "LOW" },
};

interface LabCompetitorEntry {
  name: string;
  tier: string;
  website?: string;
  active?: boolean;
  notes?: string;
}

// ── Small helpers ────────────────────────────────────────────────────────────
function readJson<T>(path: string): T {
  return JSON.parse(readFileSync(path, "utf-8")) as T;
}

/** First paragraph under "## Identity" in the lab README — the client brief. */
function descriptionFromReadme(readmePath: string): string {
  try {
    const md = readFileSync(readmePath, "utf-8");
    const m = md.match(/^## Identity\s*\n+([\s\S]*?)(?=\n## |\n*$)/m);
    const para = m?.[1]?.trim().split(/\n\s*\n/)[0]?.replace(/\s+/g, " ").trim();
    return para ? para.slice(0, 600) : "";
  } catch {
    return "";
  }
}

function listFilesRecursive(dir: string, base = dir): Array<{ abs: string; rel: string; size: number }> {
  const out: Array<{ abs: string; rel: string; size: number }> = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    if (entry.name.startsWith(".")) continue;
    const abs = join(dir, entry.name);
    if (entry.isDirectory()) out.push(...listFilesRecursive(abs, base));
    else out.push({ abs, rel: abs.slice(base.length + 1), size: statSync(abs).size });
  }
  return out;
}

/** "By The Numbers" → "by-the-numbers" / back — same as lab-output-actions. */
function slugifyFormat(s: string): string {
  return s.toLowerCase().trim().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "");
}
function titleCaseFormat(s: string): string {
  return s.split(/[-_\s]+/).filter(Boolean).map((w) => w.charAt(0).toUpperCase() + w.slice(1)).join(" ");
}

// ── Main ─────────────────────────────────────────────────────────────────────
async function main() {
  const args = process.argv.slice(2);
  const slug = args.find((a) => !a.startsWith("--")) ?? "";
  const apply = args.includes("--apply");
  // Dry run is the default; `db` stays null below so no write can slip through.
  const dryRun = !apply;
  const labRootArg = args.find((a) => a.startsWith("--lab-root="))?.split("=")[1];
  // `--industry=` still works: it is what every runbook using this script says,
  // and the field it fills is `category` now (see Client.industry).
  const categoryArg = args.find((a) => a.startsWith("--category="))?.split("=")[1]
    ?? args.find((a) => a.startsWith("--industry="))?.split("=")[1];
  if (!slug) {
    console.error(
      'Usage: FIRESTORE_DATABASE_ID=prep|"(default)" npx tsx scripts/import-lab-client.ts <slug> [--apply] [--lab-root=PATH] [--category=TEXT]',
    );
    process.exit(1);
  }

  // Resolved on a dry run too — a plan is never read without knowing which
  // database it is for — and it throws, before anything else happens, when
  // FIRESTORE_DATABASE_ID is unset or unrecognised. initAdmin opens this same
  // database through getScriptFirestore.
  const databaseId = resolveScriptDatabaseId();
  const bucket = process.env.NEXT_PUBLIC_FIREBASE_STORAGE_BUCKET;
  console.log(apply ? "APPLYING lab-client import" : "DRY RUN — nothing is written. Pass --apply to write.");
  console.log(
    `  database: ${databaseId === "(default)" ? "(default) — PRODUCTION" : databaseId}` +
      (apply ? "" : " (a dry run does not open it, so the plan below lists everything as new)"),
  );
  console.log(
    `  storage:  ${bucket || "NEXT_PUBLIC_FIREBASE_STORAGE_BUCKET is not set"} — one bucket shared by prep and ` +
      "production: the logo and deliverable uploads land there whichever database is named, and never " +
      "replace an object already at their path\n",
  );

  const labRoot = resolve(labRootArg ?? join(homedir(), "karos-agents"));
  const clientDir = join(labRoot, "clients", slug);
  if (!existsSync(join(clientDir, "config.json"))) {
    console.error(`No lab client at ${clientDir} (missing config.json)`);
    process.exit(1);
  }

  const config = readJson<{ name?: string; website?: string }>(join(clientDir, "config.json"));
  const name = config.name ?? slug;
  const website = config.website ?? "";
  const description = descriptionFromReadme(join(clientDir, "README.md"));
  const domain = website ? new URL(website).hostname.replace(/^www\./, "") : "";

  console.log(`\n▸ Lab client: ${name} (${slug}) · ${website || "no website"}${dryRun ? "  [DRY RUN]" : ""}`);

  const db = dryRun ? null : initAdmin();
  const now = Date.now();

  // ── 1 · Client record ──────────────────────────────────────────────
  let clientId = "";
  let existingClient: (Partial<Client> & { id: string }) | null = null;
  if (db) {
    const bySlug = await db.collection("clients").where("agentsRepoSlug", "==", slug).limit(1).get();
    const byName = bySlug.empty
      ? await db.collection("clients").where("name", "==", name).limit(1).get()
      : bySlug;
    if (!byName.empty) {
      existingClient = { id: byName.docs[0].id, ...(byName.docs[0].data() as Partial<Client>) };
      clientId = existingClient.id;
    }
  }

  // Brand colors → accent + brandingGuidelines (dedupe repeated hexes).
  let accentColor: string | undefined;
  let dominantColors: BrandColor[] = [];
  const brandColorsPath = join(clientDir, "profile", "brand-colors.json");
  if (existsSync(brandColorsPath)) {
    const tokens = readJson<{ tokens?: Array<{ role?: string; hex?: string }> }>(brandColorsPath).tokens ?? [];
    const seen = new Set<string>();
    for (const t of tokens) {
      const hex = t.hex?.trim();
      if (!hex || seen.has(hex.toLowerCase())) continue;
      seen.add(hex.toLowerCase());
      dominantColors.push({ hex, dominanceRank: dominantColors.length + 1, ...(t.role ? { role: t.role } : {}) });
    }
    dominantColors = dominantColors.slice(0, 4);
    accentColor = dominantColors[0]?.hex;
  }

  // Logo: prefer the square profile disc, fall back to the light logo.
  const logoCandidates = ["geektime-profile-disc.png", "logo-light.svg", "logo-light.png", "logo.png", "logo.svg"]
    .map((f) => join(clientDir, "brand", "logos", f))
    .filter(existsSync);
  // Generic fallback: first raster/vector in brand/logos.
  if (logoCandidates.length === 0) {
    const logosDir = join(clientDir, "brand", "logos");
    if (existsSync(logosDir)) {
      const first = readdirSync(logosDir).find((f) => /\.(png|svg|jpg|jpeg|webp)$/i.test(f));
      if (first) logoCandidates.push(join(logosDir, first));
    }
  }

  let logoUrl = existingClient?.logoUrl ?? "";
  let logoStoragePath = existingClient?.logoStoragePath ?? "";
  if (!logoUrl && logoCandidates.length > 0) {
    const logoFile = logoCandidates[0];
    const fileName = logoFile.split("/").pop()!;
    const logoPath = `client-logos/lab-${slug}/${fileName}`;
    if (dryRun) {
      console.log(`  would upload logo: ${fileName} → ${logoPath} (an object already there is reused, not replaced)`);
    } else {
      // Keyed by slug, not by database: the object at this path may be the one
      // the other database's client record already points at.
      const uploaded = await uploadIfAbsent({
        bytes: readFileSync(logoFile),
        path: logoPath,
        contentType: contentTypeFor(fileName),
        bucket: bucketName(),
        accessToken: await adminAccessToken(),
      });
      logoUrl = uploaded.url;
      logoStoragePath = uploaded.path;
      console.log(
        uploaded.reused
          ? `  ✓ logo already in the bucket (${logoPath}) — reused with its own download token, not replaced`
          : `  ✓ logo uploaded (${fileName})`,
      );
    }
  }

  const brandingGuidelines: BrandingGuidelines | undefined =
    dominantColors.length > 0 || logoUrl
      ? {
          ...(existingClient?.brandingGuidelines ?? {}),
          ...(dominantColors.length > 0
            ? {
                dominantColors,
                primaryAccent: dominantColors[0]?.hex,
                secondaryAccent: dominantColors[1]?.hex,
                brandNeutralDark: dominantColors.find((c) => /ink|dark|charcoal/i.test(c.role ?? ""))?.hex,
                brandNeutralLight: dominantColors.find((c) => /background|light|white/i.test(c.role ?? ""))?.hex,
              }
            : {}),
          ...(logoUrl ? { logoUrl, logoStoragePath } : {}),
          updatedAt: now,
        }
      : undefined;

  const clientPatch: Partial<Client> = {
    name,
    website,
    category: clampClientCategoryValue(
      categoryArg ?? (existingClient ? clientCategoryValue(existingClient) : null) ?? "Technology news & media",
    ),
    ...(description ? { description } : {}),
    ...(domain ? { domains: [...new Set([...(existingClient?.domains ?? []), domain])] } : {}),
    ...(accentColor ? { accentColor } : {}),
    ...(brandingGuidelines ? { brandingGuidelines } : {}),
    ...(logoUrl ? { logoUrl, logoStoragePath } : {}),
    agentsRepoSlug: slug,
    status: "active",
    onboardingStatus: "done",
  };

  if (dryRun) {
    console.log(existingClient ? `  would update client ${clientId}` : "  would create client", {
      ...clientPatch,
      brandingGuidelines: brandingGuidelines ? `${dominantColors.length} colors + logo` : undefined,
    });
    clientId = clientId || "(new)";
  } else if (db) {
    if (existingClient) {
      await db.collection("clients").doc(clientId).set(clientPatch, { merge: true });
      console.log(`  ✓ client updated (${clientId})`);
    } else {
      const ref = await db.collection("clients").add({
        ...clientPatch,
        contactEmail: "",
        brandVoice: "",
        assignedEmployeeIds: [],
        clientKeyId: `ck_${randomBytes(16).toString("base64url")}`,
        createdAt: now,
        createdBy: "lab-import-script",
      });
      clientId = ref.id;
      console.log(`  ✓ client created (${clientId})`);
    }
  }

  // ── 2 · Context docs (internal tier, skip existing) ────────────────
  const profileDir = join(clientDir, "profile");
  let docsCreated = 0;
  let docsSkipped = 0;
  for (const [file, docType] of Object.entries(PROFILE_DOC_TYPES)) {
    const path = join(profileDir, file);
    if (!existsSync(path)) continue;
    const content = readFileSync(path, "utf-8");
    if (dryRun) {
      console.log(`  would import context doc: ${docType} (${content.length} chars)`);
      docsCreated++;
      continue;
    }
    if (!db) continue;
    const existing = await db
      .collection("clientContextDocs")
      .where("clientId", "==", clientId)
      .where("docType", "==", docType)
      .where("tier", "==", "internal")
      .limit(1)
      .get();
    if (!existing.empty) {
      docsSkipped++;
      continue;
    }
    const doc: Omit<ClientContextDoc, "id"> = {
      clientId,
      docType,
      tier: "internal",
      content,
      version: 1,
      createdAt: now,
      updatedAt: now,
    };
    await db.collection("clientContextDocs").add(doc);
    docsCreated++;
  }
  console.log(`  ✓ context docs: ${docsCreated} imported, ${docsSkipped} already present`);

  // ── 3 · Competitors ────────────────────────────────────────────────
  const trackingPath = join(profileDir, "competitor-tracking.json");
  let compCreated = 0;
  let compSkipped = 0;
  if (existsSync(trackingPath)) {
    const tracking = readJson<{ competitors?: LabCompetitorEntry[] }>(trackingPath);
    const entries = (tracking.competitors ?? []).filter((c) => c.active !== false);
    const normalize = (s: string) => s.toLowerCase().replace(/[^a-z0-9]/g, "");
    const existingNames = new Set<string>();
    if (db && !dryRun) {
      const snap = await db.collection("clientCompetitors").where("clientId", "==", clientId).get();
      for (const d of snap.docs) existingNames.add(normalize((d.data() as ClientCompetitor).company ?? ""));
    }
    for (const entry of entries) {
      if (existingNames.has(normalize(entry.name))) {
        compSkipped++;
        continue;
      }
      const mapped = TIER_MAP[entry.tier] ?? TIER_MAP.secondary;
      const row: Omit<ClientCompetitor, "id"> = {
        clientId,
        company: entry.name,
        ...(entry.website ? { url: entry.website } : {}),
        marketTier: mapped.marketTier,
        overlap: mapped.overlap,
        threatLevel: mapped.threatLevel,
        deepDive: false,
        keyStrengths: [],
        keyWeaknesses: [],
        source: "report",
        createdAt: now,
        updatedAt: now,
      };
      if (dryRun) {
        console.log(`  would add competitor: ${entry.name} [${entry.tier} → ${mapped.marketTier}/${mapped.overlap}/${mapped.threatLevel}]`);
      } else if (db) {
        await db.collection("clientCompetitors").add(row);
      }
      compCreated++;
    }
  }
  console.log(`  ✓ competitors: ${compCreated} added, ${compSkipped} already present`);

  // ── 4 · Lab-run deliverables → draft assets ────────────────────────
  const outputsDir = join(clientDir, "outputs");
  let assetsCreated = 0;
  let assetsSkipped = 0;
  let filesReused = 0;
  if (existsSync(outputsDir)) {
    const alreadyImported = new Set<string>();
    if (db && !dryRun) {
      const snap = await db.collection("assets").where("clientId", "==", clientId).get();
      for (const d of snap.docs) {
        const labRun = (d.data().meta as { labRun?: string } | undefined)?.labRun;
        if (typeof labRun === "string") alreadyImported.add(labRun);
      }
    }

    const agentFolders = readdirSync(outputsDir, { withFileTypes: true })
      .filter((e) => e.isDirectory() && !e.name.startsWith("_"))
      .map((e) => e.name);

    for (const agentFolder of agentFolders) {
      const runNames = readdirSync(join(outputsDir, agentFolder), { withFileTypes: true })
        .filter((e) => e.isDirectory())
        .map((e) => e.name);
      for (const runName of runNames) {
        const clientFilesDir = join(outputsDir, agentFolder, runName, "client");
        if (!existsSync(clientFilesDir)) continue;
        const runKey = `${agentFolder}/${runName}`;
        const localFiles = listFilesRecursive(clientFilesDir);
        const labFiles: LabFile[] = localFiles.map((f) => ({
          name: f.rel.split("/").pop()!,
          path: f.abs,
          relPath: f.rel,
          size: f.size,
        }));

        const assetType = guessAssetType(agentFolder);
        const chainFamily = chainFamilyFor(assetType);
        let totalBytes = 0;

        for (const group of groupRunFiles(labFiles)) {
          const itemKey = `${runKey}#${group.key}`;
          if (alreadyImported.has(itemKey)) {
            assetsSkipped++;
            continue;
          }
          const { captionFile, aboutFile, textFile, imageFiles, dataJsonFile } = pickPrimaryFiles(group.files);

          const hosted: Array<{ name: string; relPath: string; url: string; bytes: number }> = [];
          let content = "";
          let about = "";
          let imageUrl: string | null = null;
          const imageUrls: string[] = [];
          let dataJson: { format?: string; date?: string } | null = null;
          let primaryMime: string | undefined;

          for (const file of group.files) {
            if (file.size > MAX_LAB_FILE_BYTES || totalBytes + file.size > MAX_LAB_RUN_BYTES) continue;
            const bytes = readFileSync(file.path);
            totalBytes += bytes.length;
            let url = `(dry-run)://${file.relPath}`;
            if (!dryRun) {
              // The same path importLabRunAction (the in-app importer) writes,
              // under a client id prep shares with production after a sync: the
              // object here may already back an asset in either database.
              const uploaded = await uploadIfAbsent({
                bytes,
                path: `lab-imports/${clientId}/${runKey}/${group.key}/${file.relPath.split("/").pop()}`,
                contentType: contentTypeFor(file.name),
                bucket: bucketName(),
                accessToken: await adminAccessToken(),
              });
              url = uploaded.url;
              if (uploaded.reused) filesReused++;
            }
            hosted.push({ name: file.name, relPath: file.relPath, url, bytes: bytes.length });
            if (file === captionFile || (!captionFile && file === textFile)) {
              content = bytes.toString("utf8").slice(0, CONTENT_CHAR_CAP);
            }
            if (file === aboutFile) about = bytes.toString("utf8").slice(0, 4000);
            if (file === dataJsonFile) {
              try {
                const parsed = JSON.parse(bytes.toString("utf8")) as { format?: unknown; date?: unknown };
                dataJson = {
                  ...(typeof parsed.format === "string" && parsed.format.trim() ? { format: parsed.format.trim() } : {}),
                  ...(typeof parsed.date === "string" && /^\d{4}-\d{2}-\d{2}$/.test(parsed.date) ? { date: parsed.date } : {}),
                };
              } catch {
                dataJson = null;
              }
            }
            if (imageFiles.includes(file)) {
              imageUrls.push(url);
              imageUrl ??= url;
            }
            if (/\.mp4$/i.test(file.name)) primaryMime ??= "video/mp4";
            if (/\.pdf$/i.test(file.name)) primaryMime ??= "application/pdf";
          }
          if (hosted.length === 0) {
            assetsSkipped++;
            continue;
          }

          let template = templateFromItemKey(group.key === "run" ? runName : group.key, []);
          if (dataJson?.format) {
            const key = slugifyFormat(dataJson.format);
            if (key) template = { key, name: titleCaseFormat(dataJson.format) };
          }

          const asset = {
            clientId,
            jobId: null,
            agentId: null,
            type: assetType,
            title: humanizeItemName(group.key === "run" ? runName : group.key),
            content,
            meta: {
              source: "lab-import",
              labRun: itemKey,
              agentFolder,
              ...(about ? { about } : {}),
              ...(imageUrls.length > 0 ? { images: imageUrls } : {}),
              files: hosted,
            },
            imageUrl,
            ...(primaryMime && !imageUrl ? { mimeType: primaryMime } : {}),
            status: "draft" as const,
            ...(template ? { templateKey: template.key, templateName: template.name } : {}),
            orderKey: orderKeyForLabItem(runName, group.key, dataJson?.date),
            ...(chainFamily ? {} : recommendedScheduleFields(assetType, assetsCreated)),
            createdBy: "lab-import-script",
            createdAt: now,
            updatedAt: now,
          };

          if (dryRun) {
            console.log(`  would import asset: [${assetType}] ${asset.title} (${hosted.length} files, run ${runKey})`);
          } else if (db) {
            await db.collection("assets").add(asset);
          }
          assetsCreated++;
        }
      }
    }
  }
  console.log(
    `  ✓ assets: ${assetsCreated} imported, ${assetsSkipped} skipped (already imported / empty)` +
      (filesReused ? `; ${filesReused} file(s) were already in the bucket and were reused, not replaced` : ""),
  );

  // ── 4b · Chain reflow ───────────────────────────────────────────────
  // The in-app importer (lab-output-actions.ts) calls reflowClientChain right
  // after creating drafts, so chain-family types (social/email/article) land
  // with a scheduledAt immediately. This script can't import reflowClientChain
  // (src/lib/chain.ts → data.ts → "server-only", unresolvable outside the
  // Next.js runtime) — so without this step, every chain-family draft this
  // script creates would sit with scheduledAt/recommendedAt permanently null:
  // invisible on the calendar even after staff approval. planClientChain
  // itself is pure/client-safe, so re-implement just the write here.
  //
  // Unconditional (not just when assetsCreated > 0): re-running this script
  // against an already-imported client is also the recovery path for any
  // client left stuck by an earlier run of this script, before this reflow
  // step existed. A no-op run costs one read and zero writes.
  if (!dryRun && db) {
    const snap = await db.collection("assets").where("clientId", "==", clientId).get();
    const clientAssets = snap.docs.map((d) => ({ id: d.id, ...(d.data() as Omit<Asset, "id">) }));
    const assignments = planClientChain(clientAssets, { now });
    if (assignments.length > 0) {
      const batch = db.batch();
      for (const a of assignments) {
        batch.set(
          db.collection("assets").doc(a.id),
          {
            scheduledAt: a.scheduledAt,
            orderKey: a.orderKey,
            recommendedAt: a.scheduledAt,
            recommendedReason: "One post per day - assigned by the content chain",
            // Always manual, never auto: a bulk historical import is not the
            // live per-post trust context applyChainAssignments' auto-schedule
            // branch assumes, so skip that check and stay conservative.
            publishMode: "manual",
            updatedAt: now,
          },
          { merge: true },
        );
      }
      await batch.commit();
      console.log(`  ✓ chain reflow: ${assignments.length} asset(s) dated`);
    } else {
      console.log("  ✓ chain reflow: nothing to date");
    }
  }

  // ── 5 · Activity log ───────────────────────────────────────────────
  if (!dryRun && db && (assetsCreated || compCreated || docsCreated)) {
    await db.collection("clientActivityLogs").add({
      clientId,
      timestamp: Date.now(),
      type: "CAMPAIGN_CREATED",
      title: `Imported lab client "${name}" (${docsCreated} docs, ${compCreated} competitors, ${assetsCreated} assets)`,
      actor: "Lab import script",
      actorRole: "staff",
      metadata: { slug, docsCreated, compCreated, assetsCreated },
    });
  }

  console.log(`\n✔ ${dryRun ? "Dry run complete" : "Import complete"} for ${name}${clientId && clientId !== "(new)" ? ` (client ${clientId})` : ""}.`);
  if (!dryRun) {
    console.log("  Next: open the client in the portal — sidebar Competitor Track, docs, and Archive should all be populated.");
    console.log("  Imported assets land as drafts (dated, chain-scheduled) — staff must still approve each one from /assets before a client can see it.");
    console.log("  The first Intel/SEO-GEO run can be triggered from the client page (Regenerate) when you want measured AI-visibility data.");
  }
}

// Only when invoked directly — importing this file must never open a Firestore
// connection, let alone write to one.
if (require.main === module) {
  main().catch((e) => {
    console.error(e);
    process.exit(1);
  });
}
