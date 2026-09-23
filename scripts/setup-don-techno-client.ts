/**
 * Don Techno (@don.techno): the portal fields the lab import cannot set.
 *
 * `scripts/import-lab-client.ts dontechno` creates the client, its seven
 * context documents, the brand palette and the nine tracked pages from
 * `clients/dontechno/` in karos-agents. This script finishes the profile:
 *
 *   1. The logo is the Instagram profile picture (Albert, 2026-09-23), not
 *      the transparent white mark the importer picks (`logo-light.png`, which
 *      is invisible on a light surface). The picture is uploaded ONCE to a
 *      path shared by prep and production and reused when it already exists,
 *      so the second database never kills the first one's download token.
 *   2. Social links: Instagram, TikTok and the Linktree (the bio link, in the
 *      `website` slot of socialLinks; `client.website` stays empty on purpose
 *      so no site scraper is ever pointed at Linktree).
 *   3. A clean description (the importer truncates the README paragraph at
 *      600 characters, mid-sentence).
 *   4. Brand fonts, tone and a short guidelines note on the branding record.
 *   5. The Instagram Agent granted and starred, so Daniel's page shows it.
 *
 * Idempotent: every write is a merge of exactly these fields. Dry run by
 * default; the database is named on the command line, never guessed:
 *
 *   FIRESTORE_DATABASE_ID=prep        npx tsx scripts/setup-don-techno-client.ts
 *   FIRESTORE_DATABASE_ID=prep        npx tsx scripts/setup-don-techno-client.ts --apply
 *   FIRESTORE_DATABASE_ID="(default)" npx tsx scripts/setup-don-techno-client.ts --apply
 */

import { existsSync, readFileSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { resolve } from "node:path";
import { randomUUID } from "node:crypto";

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
import { getStorage } from "firebase-admin/storage";
import { getScriptFirestore, resolveScriptDatabaseId } from "./lib/firestore-db";
import type { BrandingGuidelines, Client, SocialLinks } from "../src/lib/types";

const SLUG = "dontechno";
const INSTAGRAM_AGENT_KEY = "karos-instagram-agent";
const LOGO_STORAGE_PATH = `client-logos/lab-${SLUG}/dontechno-profile-picture.png`;

const DESCRIPTION =
  "Don Techno (@don.techno) is a verified Instagram page about house music parties: 504,677 followers and " +
  "1,079 posts since March 2022, bio \"Dance Music / House & Techno\", no website. It posts short, bright party " +
  "moments, artist clips, nostalgia reels around house classics, news cards and story carousels, with afro, deep, " +
  "organic and Latin house underneath, and runs fifteen free WhatsApp guestlist communities through its Linktree.";

const SOCIAL_LINKS: SocialLinks = {
  instagram: "https://www.instagram.com/don.techno/",
  tiktok: "https://www.tiktok.com/@don.techno",
  website: "https://linktr.ee/dontechno",
};

const BRAND_GUIDELINES_NOTE = [
  "**Voice.** Dry, knowing, brief: the last person in the group chat at 5 AM. Say what happened, where and when, the way you would tell a friend.",
  "",
  "**Do:** one complete sentence per headline; a checkable fact (a year, a place, a number, a name) on every text slide; the artist's face and NAME on slide 1; credit every clip in the caption; proper capitalisation in captions; exactly two lowercase hashtags on runway posts.",
  "",
  "**Don't:** em-dashes, emoji, exclamation marks, CTAs, hype words (epic, insane, banger, fire, legendary, iconic), critic words (masterclass, hypnotic, journey), lists or timeline slides, text over a face, dark footage, invented facts.",
  "",
  "**Look.** Pure monochrome type and marks (ink #0A0A0A on paper #F4F1EA); colour only through photography and video, which run in full native colour. Albert Sans for everything said, JetBrains Mono for metadata. Carousels 1080 x 1440, reels 1080 x 1920 with no cover, the white DT mark top-left of every slide.",
].join("\n");

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

function downloadUrl(bucket: string, path: string, token: string): string {
  return `https://firebasestorage.googleapis.com/v0/b/${bucket}/o/${encodeURIComponent(path)}?alt=media&token=${token}`;
}

/** Upload the file once; a later run (or the other database) reuses the object and its token. */
async function uploadOnce(app: App, localPath: string, storagePath: string, apply: boolean): Promise<{ url: string; reused: boolean }> {
  const name = bucketName();
  const file = getStorage(app).bucket(name).file(storagePath);
  const bytes = statSync(localPath).size;
  try {
    const [md] = await file.getMetadata();
    const token = (md.metadata?.firebaseStorageDownloadTokens as string | undefined)?.split(",")[0];
    if (Number(md.size ?? -1) === bytes && token) return { url: downloadUrl(name, storagePath, token), reused: true };
  } catch {
    /* not there yet */
  }
  const token = randomUUID();
  if (apply) {
    await file.save(readFileSync(localPath), {
      resumable: false,
      contentType: "image/png",
      metadata: { metadata: { firebaseStorageDownloadTokens: token } },
    });
  }
  return { url: downloadUrl(name, storagePath, token), reused: false };
}

async function main() {
  const args = process.argv.slice(2);
  const apply = args.includes("--apply");
  const labRoot = resolve(args.find((a) => a.startsWith("--lab-root="))?.split("=")[1] ?? resolve(homedir(), "karos-agents"));
  const logoFile = resolve(labRoot, "clients", SLUG, "brand", "logos", "logo.png");
  if (!existsSync(logoFile)) throw new Error(`Profile picture not found: ${logoFile}`);

  const databaseId = resolveScriptDatabaseId();
  console.log(`${apply ? "APPLYING" : "DRY RUN (pass --apply to write)"} · database ${databaseId === "(default)" ? "(default) — PRODUCTION" : databaseId}`);

  const app = initAdmin();
  const db = getScriptFirestore(app);
  db.settings({ ignoreUndefinedProperties: true });

  const bySlug = await db.collection("clients").where("agentsRepoSlug", "==", SLUG).limit(1).get();
  if (bySlug.empty) throw new Error(`No client with agentsRepoSlug "${SLUG}" in ${databaseId}. Run scripts/import-lab-client.ts ${SLUG} --apply first.`);
  const ref = bySlug.docs[0].ref;
  const client = { id: ref.id, ...(bySlug.docs[0].data() as Partial<Client>) };
  console.log(`Client: ${client.name} (${client.id})`);

  const agentSnap = await db.collection("customAgents").where("key", "==", INSTAGRAM_AGENT_KEY).limit(1).get();
  if (agentSnap.empty) throw new Error(`No customAgents doc with key ${INSTAGRAM_AGENT_KEY} in ${databaseId}`);
  const agentId = agentSnap.docs[0].id;
  const agentEnabled = agentSnap.docs[0].data().enabled !== false;
  console.log(`Instagram Agent: ${agentId} (${agentEnabled ? "enabled" : "DISABLED in this database — granted, but not runnable until enabled"})`);

  const logo = await uploadOnce(app, logoFile, LOGO_STORAGE_PATH, apply);
  console.log(`Logo: ${logo.reused ? "reusing" : apply ? "uploaded" : "would upload"} ${LOGO_STORAGE_PATH}`);

  const now = Date.now();
  const branding: BrandingGuidelines = {
    ...(client.brandingGuidelines ?? { updatedAt: now }),
    logoUrl: logo.url,
    logoStoragePath: LOGO_STORAGE_PATH,
    fontHeading: "Albert Sans",
    fontBody: "Albert Sans",
    toneKeywords: ["dry", "knowing", "brief", "specific", "no hype"],
    visualStyle: "Monochrome editorial",
    guidelines: BRAND_GUIDELINES_NOTE,
    updatedAt: now,
  };
  const customAgentIds = [...new Set([...(client.customAgentIds ?? []), agentId])];
  const starredAgentIds = [...new Set([agentId, ...(client.starredAgentIds ?? [])])];

  const patch: Partial<Client> = {
    website: "",
    description: DESCRIPTION,
    socialLinks: { ...(client.socialLinks ?? {}), ...SOCIAL_LINKS },
    logoUrl: logo.url,
    logoStoragePath: LOGO_STORAGE_PATH,
    brandingGuidelines: branding,
    customAgentIds,
    starredAgentIds,
    updatedAt: now,
  } as Partial<Client>;

  console.log("Patch:", {
    ...patch,
    brandingGuidelines: `${(branding.dominantColors ?? []).length} colours, fonts ${branding.fontHeading}, logo ${LOGO_STORAGE_PATH}`,
    description: `${DESCRIPTION.slice(0, 80)}…`,
  });

  if (!apply) {
    console.log("\nDry run: nothing written.");
    return;
  }
  await ref.set(patch, { merge: true });
  console.log(`\n✔ ${client.name} (${client.id}) updated in ${databaseId}.`);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
