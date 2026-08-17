/**
 * Repairs lab-import assets whose stored Firebase Storage download URLs carry
 * a STALE token — one that doesn't match the object's current generation.
 *
 * Root cause (see storage.ts's `uploadBytes` `ifAbsent` option, added
 * alongside this script): before that fix, two overlapping imports of the
 * same lab-run item both uploaded to the SAME deterministic storage path.
 * Whichever upload landed last won the object (a fresh token, a new
 * generation); the OTHER import's Firestore doc kept the token it minted
 * locally, which now matches nothing GCS has — Firebase Storage answers
 * "Permission denied" for it forever. The Firestore-duplicate half of this
 * (two asset docs for one item) was already cleaned up by
 * find-duplicate-assets.ts, keeping the OLDER doc per `compareSurvivors` —
 * which is correct for content identity but says nothing about which token
 * is still live, so the survivor can easily be the one left holding the dead
 * token (confirmed: Karos Labs' "Comeup calvin harris", "Campaign
 * tomorrowland", "Comeup steve aoki" surviving docs all did).
 *
 * For each asset id given, this re-reads the REAL current token for every
 * image URL / file URL from GCS object metadata (bypassing Storage rules
 * entirely via the Admin service account, so a rules issue can't hide the
 * comparison) and rewrites the asset's `meta.images`, `imageUrl`, and
 * `meta.files[].url` to match. Read-only against Firestore until --apply.
 *
 * Usage:
 *   npx tsx --env-file=.env.local scripts/repair-stale-lab-import-tokens.ts <assetId...>            # dry run
 *   npx tsx --env-file=.env.local scripts/repair-stale-lab-import-tokens.ts <assetId...> --apply     # write
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
  } catch {}
}
loadEnvFile(resolve(process.cwd(), ".env.local"));
loadEnvFile(resolve(process.cwd(), ".env"));

import { initializeApp, getApps, cert } from "firebase-admin/app";
import { getFirestore } from "firebase-admin/firestore";
import { GoogleAuth } from "google-auth-library";

function initAdmin() {
  if (!getApps().length) {
    const raw = process.env.FIREBASE_SERVICE_ACCOUNT_KEY;
    const parsed = JSON.parse(raw!);
    initializeApp({ credential: cert(parsed) });
  }
  const databaseId = process.env.FIRESTORE_DATABASE_ID || "(default)";
  return getFirestore(getApps()[0]!, databaseId);
}

const FIREBASE_STORAGE_HOST = "firebasestorage.googleapis.com";

/** Extracts {bucket, objectPath} from a Firebase Storage download URL, or null if it isn't one. */
function parseFirebaseStorageUrl(url: string): { bucket: string; objectPath: string } | null {
  try {
    const u = new URL(url);
    if (u.hostname !== FIREBASE_STORAGE_HOST) return null;
    // /v0/b/<bucket>/o/<encodedPath>
    const m = u.pathname.match(/^\/v0\/b\/([^/]+)\/o\/([^/]+)$/);
    if (!m) return null;
    return { bucket: m[1], objectPath: decodeURIComponent(m[2]) };
  } catch {
    return null;
  }
}

async function main() {
  const apply = process.argv.includes("--apply");
  const assetIds = process.argv.slice(2).filter((a) => !a.startsWith("--"));
  if (assetIds.length === 0) {
    console.error("Usage: repair-stale-lab-import-tokens.ts <assetId...> [--apply]");
    process.exit(1);
    return;
  }

  const db = initAdmin();
  const auth = new GoogleAuth({
    credentials: JSON.parse(process.env.FIREBASE_SERVICE_ACCOUNT_KEY!),
    scopes: ["https://www.googleapis.com/auth/devstorage.read_only"],
  });
  const client = await auth.getClient();
  const { token: accessToken } = await client.getAccessToken();
  if (!accessToken) throw new Error("Could not obtain a GCS access token.");

  // Cache live tokens per (bucket, objectPath) so a URL repeated across
  // meta.images / imageUrl / meta.files only costs one GCS read.
  const liveTokenCache = new Map<string, string | null>();
  async function liveToken(bucket: string, objectPath: string): Promise<string | null> {
    const key = `${bucket}/${objectPath}`;
    if (liveTokenCache.has(key)) return liveTokenCache.get(key)!;
    const res = await fetch(
      `https://storage.googleapis.com/storage/v1/b/${encodeURIComponent(bucket)}/o/${encodeURIComponent(objectPath)}`,
      { headers: { Authorization: `Bearer ${accessToken}` } },
    );
    if (!res.ok) {
      liveTokenCache.set(key, null);
      return null;
    }
    const data = (await res.json()) as { metadata?: { firebaseStorageDownloadTokens?: string } };
    const t = data.metadata?.firebaseStorageDownloadTokens?.split(",")[0] ?? null;
    liveTokenCache.set(key, t);
    return t;
  }

  /** Rewrites a Firebase Storage URL to carry the object's real current token. Unchanged if not such a URL, or already correct, or the object can't be read. */
  async function repairedUrl(url: string): Promise<{ url: string; changed: boolean; note?: string }> {
    const parsed = parseFirebaseStorageUrl(url);
    if (!parsed) return { url, changed: false };
    const real = await liveToken(parsed.bucket, parsed.objectPath);
    if (!real) return { url, changed: false, note: "could not read live object metadata" };
    const stored = new URL(url).searchParams.get("token");
    if (stored === real) return { url, changed: false };
    const fixed = `https://${FIREBASE_STORAGE_HOST}/v0/b/${parsed.bucket}/o/${encodeURIComponent(parsed.objectPath)}?alt=media&token=${real}`;
    return { url: fixed, changed: true };
  }

  for (const id of assetIds) {
    const ref = db.collection("assets").doc(id);
    const snap = await ref.get();
    if (!snap.exists) {
      console.log(`--- ${id}: not found, skipping ---`);
      continue;
    }
    const data = snap.data() as Record<string, unknown>;
    const meta = (data.meta as Record<string, unknown>) ?? {};
    let anyChanged = false;

    console.log(`\n--- ${id} "${data.title}" ---`);

    const images = (meta.images as unknown[] | undefined)?.filter((u): u is string => typeof u === "string") ?? [];
    const newImages: string[] = [];
    for (const url of images) {
      const r = await repairedUrl(url);
      if (r.changed) {
        anyChanged = true;
        console.log(`  meta.images: STALE → repaired\n    old: ${url}\n    new: ${r.url}`);
      } else if (r.note) {
        console.log(`  meta.images: ${r.note}\n    ${url}`);
      }
      newImages.push(r.url);
    }

    let newImageUrl = data.imageUrl as string | null | undefined;
    if (typeof newImageUrl === "string") {
      const r = await repairedUrl(newImageUrl);
      if (r.changed) {
        anyChanged = true;
        console.log(`  imageUrl: STALE → repaired\n    old: ${newImageUrl}\n    new: ${r.url}`);
      } else if (r.note) {
        console.log(`  imageUrl: ${r.note}\n    ${newImageUrl}`);
      }
      newImageUrl = r.url;
    }

    type MetaFile = { name?: string; relPath?: string; url?: string; [k: string]: unknown };
    const files = (meta.files as MetaFile[] | undefined) ?? [];
    const newFiles: MetaFile[] = [];
    for (const f of files) {
      if (typeof f.url !== "string") {
        newFiles.push(f);
        continue;
      }
      const r = await repairedUrl(f.url);
      if (r.changed) {
        anyChanged = true;
        console.log(`  meta.files["${f.name}"]: STALE → repaired\n    old: ${f.url}\n    new: ${r.url}`);
      } else if (r.note) {
        console.log(`  meta.files["${f.name}"]: ${r.note}\n    ${f.url}`);
      }
      newFiles.push({ ...f, url: r.url });
    }

    if (!anyChanged) {
      console.log("  no stale tokens found");
      continue;
    }

    if (!apply) {
      console.log("  (dry run — pass --apply to write these fixes)");
      continue;
    }

    await ref.set(
      {
        meta: {
          ...meta,
          ...(images.length > 0 ? { images: newImages } : {}),
          ...(files.length > 0 ? { files: newFiles } : {}),
        },
        ...(typeof newImageUrl === "string" ? { imageUrl: newImageUrl } : {}),
      },
      { merge: true },
    );
    console.log("  written.");
  }
}

main()
  .then(() => process.exit(0))
  .catch((e) => {
    console.error(e);
    process.exit(1);
  });
