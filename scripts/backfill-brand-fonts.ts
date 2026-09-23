/**
 * Re-read every client's HEADING and BODY font from their own website, and
 * correct the stored pair where it disagrees.
 *
 * Why this exists: until `src/lib/brand-fonts.ts` landed, the fonts in a brand
 * kit were a MODEL's answer to "what typeface does this site use". For
 * karoslabs the kit said Space Grotesk / Inter; the site serves Spectral /
 * Hanken Grotesk. The colours from the same extraction were right, because
 * colours had already been made deterministic after a model invented `#6366f1`.
 * Typography never got that treatment, so it stayed a guess — and "Inter" and
 * "Space Grotesk" are exactly the guess a model makes when it cannot resolve
 * `var(--font-serif)` → `var(--font-spectral)` → `"Spectral"`.
 *
 * THIS IS NOT `backfill-branding.ts`, and not a Regenerate. It writes two
 * fields. It never touches the palette, the tone keywords, the voice or the
 * guidelines prose, so a hand-edited brand kit survives it intact — which
 * Regenerate does not.
 *
 * A client whose CSS states no family is LEFT ALONE: the resolver returns
 * nothing rather than guessing, and the model's answer, whatever it was, beats
 * a blank field.
 *
 *   npx tsx scripts/backfill-brand-fonts.ts            # dry run — prints the diff
 *   npx tsx scripts/backfill-brand-fonts.ts --apply    # writes
 *
 * DRY RUN IS THE DEFAULT ON PURPOSE. The credentials in .env.local point at
 * production Firestore. Read the printed diff first.
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
    // .env.local may not exist in CI or in production — that's fine
  }
}

loadEnvFile(resolve(process.cwd(), ".env.local"));
loadEnvFile(resolve(process.cwd(), ".env"));

// ── Firebase Admin SDK ───────────────────────────────────────────────────────
import { initializeApp, getApps, cert } from "firebase-admin/app";
import { getFirestore, type Firestore } from "firebase-admin/firestore";

function initAdmin() {
  if (getApps().length) return;
  const raw = process.env.FIREBASE_SERVICE_ACCOUNT_KEY;
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

/** Assigned by main() — never at module scope, so importing opens no connection. */
let db: Firestore;

// ── The resolver itself is IMPORTED, not transcribed ─────────────────────────
// `src/lib/brand-fonts.ts` is deliberately pure — no "server-only", no Next
// imports — so this script runs the very code the pipeline runs. That closes
// the drift `backfill-brand-role-scalars.ts` had to accept for its own inlined
// copy: the rules that decide a font name exist in one place.
//
// What is NOT shared is the fetching. `observeSiteFonts` lives in
// `branding-site-palette.ts`, which imports "server-only" and cannot load under
// tsx. The lines below are that function's fetch half, and the one thing they
// could drift on is which stylesheets get followed. Keep them in step.
import { resolveBrandFonts, type ResolvedBrandFonts } from "../src/lib/brand-fonts";

const MAX_STYLESHEETS = 4;
const MAX_BYTES = 1_000_000;
const FETCH_TIMEOUT_MS = 15_000;
const STYLESHEET_HREF_RE = /<link\b[^>]*rel=["']?stylesheet["']?[^>]*>/gi;
const HREF_RE = /href=["']([^"']+)["']/i;

function brandPageUrl(site: string): string {
  const trimmed = site.trim();
  try {
    const url = new URL(/^https?:\/\//i.test(trimmed) ? trimmed : `https://${trimmed}`);
    url.search = "";
    url.hash = "";
    return url.toString();
  } catch {
    return `https://${trimmed.replace(/^https?:\/\//i, "").replace(/\/+$/, "")}/`;
  }
}

async function fetchText(url: string): Promise<string | null> {
  try {
    const response = await fetch(url, { signal: AbortSignal.timeout(FETCH_TIMEOUT_MS), redirect: "follow" });
    if (!response.ok) return null;
    return (await response.text()).slice(0, MAX_BYTES);
  } catch {
    return null;
  }
}

async function observeSiteFonts(site: string): Promise<ResolvedBrandFonts> {
  const pageUrl = brandPageUrl(site);
  const html = await fetchText(pageUrl);
  if (html === null) return {};
  const urls: string[] = [];
  for (const tag of html.match(STYLESHEET_HREF_RE) ?? []) {
    const href = HREF_RE.exec(tag)?.[1];
    if (!href) continue;
    try {
      urls.push(new URL(href, pageUrl).toString());
    } catch {
      // A malformed href is skipped, not fatal.
    }
  }
  const sheets = await Promise.all([...new Set(urls)].slice(0, MAX_STYLESHEETS).map((u) => fetchText(u)));
  // <style> blocks only — never the markup itself; see `observeSiteFonts`.
  const inlineCss = [...html.matchAll(/<style[^>]*>([\s\S]*?)<\/style>/gi)].map((m) => m[1]!);
  return resolveBrandFonts([...inlineCss, ...sheets.filter((s): s is string => s !== null)].join("\n"));
}

// ── Firestore ────────────────────────────────────────────────────────────────
interface Client {
  id: string;
  name: string;
  website?: string;
  websiteUrl?: string;
  brandingGuidelines?: { fontHeading?: string; fontBody?: string };
}

async function listAllClients(): Promise<Client[]> {
  const snap = await db.collection("clients").get();
  return snap.docs.map((d) => ({ id: d.id, ...(d.data() as Omit<Client, "id">) }));
}

/** Whatever the client recorded as their site, under either field name in use. */
function siteOf(client: Client): string | undefined {
  const raw = client.website ?? client.websiteUrl;
  return raw && raw.trim().length > 0 ? raw.trim() : undefined;
}

async function main() {
  const apply = process.argv.includes("--apply");
  initAdmin();
  db = getFirestore();
  db.settings({ ignoreUndefinedProperties: true });

  console.log(apply ? "APPLYING brand-font backfill\n" : "DRY RUN — nothing is written. Pass --apply to write.\n");

  const clients = await listAllClients();
  console.log(`Found ${clients.length} client(s)\n`);

  const summary = { changed: 0, agreed: 0, unreadable: 0, noSite: 0, failed: 0 };

  for (const client of clients) {
    const label = `[${client.name} (${client.id})]`;
    const site = siteOf(client);
    if (!site) {
      console.log(`${label} no website recorded — skipped`);
      summary.noSite++;
      continue;
    }
    try {
      const observed = await observeSiteFonts(site);
      if (!observed.fontHeading && !observed.fontBody) {
        // Not a failure. A site behind a bot wall, or one whose CSS states no
        // family, has nothing to correct against — and a blank field is worse
        // than a guessed one.
        console.log(`${label} ${site} — CSS states no family; left alone`);
        summary.unreadable++;
        continue;
      }

      const stored = client.brandingGuidelines ?? {};
      const updates: Record<string, string> = {};
      const diffs: string[] = [];
      for (const key of ["fontHeading", "fontBody"] as const) {
        const next = observed[key];
        if (!next || next === stored[key]) continue;
        updates[`brandingGuidelines.${key}`] = next;
        diffs.push(`      ${key}: ${stored[key] ?? "—"} → ${next}`);
      }

      if (diffs.length === 0) {
        console.log(`${label} ${site} — already matches the site`);
        summary.agreed++;
        continue;
      }

      console.log(`${label} ${site} ${apply ? "writing" : "would write"}:`);
      for (const d of diffs) console.log(d);
      if (observed.source) console.log(`      read from: ${observed.source}`);
      summary.changed++;

      if (apply) {
        await db
          .collection("clients")
          .doc(client.id)
          .update({ ...updates, "brandingGuidelines.updatedAt": Date.now() });
      }
    } catch (err) {
      console.error(`${label} Failed:`, err);
      summary.failed++;
    }
  }

  console.log("\n── Summary ─────────────────────────────────────────────");
  console.log(`   Total:                 ${clients.length}`);
  console.log(`   Corrected:             ${summary.changed}`);
  console.log(`   Already agreed:        ${summary.agreed}`);
  console.log(`   CSS states no family:  ${summary.unreadable}`);
  console.log(`   No website recorded:   ${summary.noSite}`);
  console.log(`   Failed:                ${summary.failed}`);
  console.log("────────────────────────────────────────────────────────");
  console.log(
    "\nThe context docs are NOT rewritten here. They are regenerated from\n" +
      "`brandingGuidelines` on the client's next branding run; until then the\n" +
      "stored doc still names the old font.\n",
  );
  process.exit(0);
}

// Only when invoked directly — importing this file must never open a
// Firestore connection, let alone write to one.
if (require.main === module) {
  main().catch((e) => {
    console.error(e);
    process.exit(1);
  });
}
