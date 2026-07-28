/**
 * One-time retroactive branding backfill script.
 *
 * For every client in Firestore:
 *   1. Scrapes their configured website URL for colors (meta theme-color, CSS vars,
 *      frequency-ranked hex values) and fonts (Google Fonts, @font-face).
 *   2. Falls back to a preset archetype if scraping yields nothing.
 *   3. Merges with existing data: colours/fonts are refreshed; tone keywords,
 *      guidelines text, and logoUrl from prior manual edits are preserved.
 *   4. Writes the updated brandingGuidelines to the client record.
 *   5. Upserts the branding-guidelines context doc.
 *   6. Injects a BRAND_SYNC block into the brand-voice context doc.
 *
 *   npx tsx scripts/backfill-branding.ts            # dry run — prints the plan
 *   npx tsx scripts/backfill-branding.ts --apply    # writes
 *
 * DRY RUN IS THE DEFAULT ON PURPOSE. The credentials in .env.local point at
 * production Firestore. Read the printed plan first.
 *
 * The script reads Firebase credentials from .env.local automatically.
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
      // Strip surrounding quotes
      if ((val.startsWith('"') && val.endsWith('"')) || (val.startsWith("'") && val.endsWith("'"))) {
        val = val.slice(1, -1);
      }
      if (!process.env[key]) process.env[key] = val;
    }
  } catch {
    // .env.local may not exist in CI or Vercel — that's fine
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

// ── Types (inlined to avoid Next.js server-only imports) ─────────────────────
interface BrandingGuidelines {
  primaryColor?: string;
  secondaryColor?: string;
  fontHeading?: string;
  fontBody?: string;
  toneKeywords?: string[];
  logoUrl?: string;
  guidelines?: string;
  updatedAt: number;
}

interface Client {
  id: string;
  name: string;
  website?: string;
  brandingGuidelines?: BrandingGuidelines;
}

interface ContextDoc {
  id: string;
  clientId: string;
  docType: string;
  tier: string;
  content: string;
  version: number;
  sources?: string[];
  createdAt: number;
  updatedAt: number;
}

// ── Presets (same three archetypes as actions.ts) ────────────────────────────
const PRESETS: Array<Omit<BrandingGuidelines, "updatedAt">> = [
  {
    primaryColor: "#1E293B",
    secondaryColor: "#6366F1",
    fontHeading: "Inter",
    fontBody: "Inter",
    toneKeywords: ["Innovative", "Precise", "Scalable", "Data-driven"],
  },
  {
    primaryColor: "#292524",
    secondaryColor: "#D97706",
    fontHeading: "Playfair Display",
    fontBody: "Georgia",
    toneKeywords: ["Authentic", "Sustainable", "Human", "Crafted"],
  },
  {
    primaryColor: "#09090B",
    secondaryColor: "#10B981",
    fontHeading: "Montserrat",
    fontBody: "Open Sans",
    toneKeywords: ["Bold", "Trustworthy", "Challenger", "Performance"],
  },
];

// ── Color utilities ───────────────────────────────────────────────────────────
function normalizeHex(raw: string): string | null {
  const h = raw.trim().toLowerCase();
  if (/^#[0-9a-f]{3}$/.test(h)) return "#" + h[1] + h[1] + h[2] + h[2] + h[3] + h[3];
  if (/^#[0-9a-f]{6}$/.test(h)) return h;
  if (/^#[0-9a-f]{8}$/.test(h)) return h.slice(0, 7);
  return null;
}

function isUsableColor(hex: string): boolean {
  const r = parseInt(hex.slice(1, 3), 16);
  const g = parseInt(hex.slice(3, 5), 16);
  const b = parseInt(hex.slice(5, 7), 16);
  const luminance = 0.2126 * r + 0.7152 * g + 0.0722 * b;
  const saturation = Math.max(r, g, b) - Math.min(r, g, b);
  return luminance > 12 && luminance < 235 && saturation > 25;
}

// ── Scraper ───────────────────────────────────────────────────────────────────
async function scrapeWebsiteBranding(url: string): Promise<Omit<BrandingGuidelines, "updatedAt"> | null> {
  try {
    const normalized = url.startsWith("http") ? url : `https://${url}`;
    const res = await fetch(normalized, {
      signal: AbortSignal.timeout(8000),
      headers: { "User-Agent": "Mozilla/5.0 (compatible; KarosCMO/1.0; +https://karoslabs.com)" },
    });
    if (!res.ok) return null;
    const html = await res.text();

    // 1. <meta name="theme-color">
    const themeColor =
      normalizeHex(
        html.match(/<meta[^>]+name=["']theme-color["'][^>]+content=["'](#[0-9a-fA-F]{3,8})["']/i)?.[1] ??
        html.match(/<meta[^>]+content=["'](#[0-9a-fA-F]{3,8})["'][^>]+name=["']theme-color["']/i)?.[1] ??
        "",
      ) ?? undefined;

    // 2. All inline <style> block content
    const styleBlocks = [...html.matchAll(/<style[^>]*>([\s\S]*?)<\/style>/gi)].map((m) => m[1]).join("\n");

    // 3. CSS custom property colors
    const cssVarPattern =
      /--(?:[\w-]*(?:primary|brand|accent|main|key|hero|highlight|theme)[\w-]*):\s*(#[0-9a-fA-F]{3,8})/gi;
    const cssVarColors: string[] = [];
    let m: RegExpExecArray | null;
    while ((m = cssVarPattern.exec(styleBlocks)) !== null) {
      const hex = normalizeHex(m[1]);
      if (hex && isUsableColor(hex) && !cssVarColors.includes(hex)) cssVarColors.push(hex);
    }

    // 4. Frequency-ranked hex colors from <style> blocks
    const freqMap = new Map<string, number>();
    const hexScan = /#([0-9a-fA-F]{3,8})\b/g;
    while ((m = hexScan.exec(styleBlocks)) !== null) {
      const hex = normalizeHex("#" + m[1]);
      if (hex && isUsableColor(hex)) freqMap.set(hex, (freqMap.get(hex) ?? 0) + 1);
    }
    const freqColors = [...freqMap.entries()]
      .sort((a, b) => b[1] - a[1])
      .map(([c]) => c)
      .filter((c) => !cssVarColors.includes(c));

    // 5. Google Fonts from <link> and @import
    const gfMatches = [
      ...html.matchAll(/fonts\.googleapis\.com\/css2?\?family=([^"'&;>\s]+)/gi),
      ...styleBlocks.matchAll(/fonts\.googleapis\.com\/css2?\?family=([^"'&;)\s]+)/gi),
    ];
    const googleFonts = gfMatches
      .flatMap((match) =>
        decodeURIComponent(match[1])
          .split("|")
          .map((f) => f.split(":")[0].replace(/\+/g, " ").trim()),
      )
      .filter((f, i, a) => f && a.indexOf(f) === i);

    // 6. @font-face family names
    const fontFacePattern = /@font-face\s*\{[^}]*font-family:\s*['"]?([^;'"}{]+)/gi;
    const localFonts: string[] = [];
    while ((m = fontFacePattern.exec(styleBlocks)) !== null) {
      const family = m[1].trim().replace(/^['"]|['"]$/g, "");
      if (family && !localFonts.includes(family)) localFonts.push(family);
    }

    const colorPool = [themeColor, ...cssVarColors, ...freqColors].filter(Boolean) as string[];
    const primaryColor = colorPool[0];
    const secondaryColor = colorPool.find((c) => c !== primaryColor);
    const allFonts = [...googleFonts, ...localFonts];

    if (!primaryColor && allFonts.length === 0) return null;

    return {
      primaryColor: primaryColor ?? undefined,
      secondaryColor: secondaryColor ?? undefined,
      fontHeading: allFonts[0] ?? undefined,
      fontBody: (allFonts[1] ?? allFonts[0]) ?? undefined,
    };
  } catch {
    return null;
  }
}

// ── Context doc content builders ─────────────────────────────────────────────
function brandingToContextDocContent(g: BrandingGuidelines, clientName: string): string {
  const today = new Date().toISOString().slice(0, 10);
  const lines = [`# Branding Guidelines — ${clientName}`, `_Last updated: ${today}_`, ""];
  if (g.primaryColor || g.secondaryColor) {
    lines.push("## Color Palette");
    if (g.primaryColor) lines.push(`- **Primary:** ${g.primaryColor}`);
    if (g.secondaryColor) lines.push(`- **Secondary/Accent:** ${g.secondaryColor}`);
    lines.push("");
  }
  if (g.fontHeading || g.fontBody) {
    lines.push("## Typography");
    if (g.fontHeading) lines.push(`- **Heading font:** ${g.fontHeading}`);
    if (g.fontBody) lines.push(`- **Body font:** ${g.fontBody}`);
    lines.push("");
  }
  if (g.toneKeywords?.length) {
    lines.push("## Tone & Voice");
    lines.push(`Keywords: ${g.toneKeywords.join(", ")}`);
    lines.push("");
  }
  return lines.join("\n");
}

function buildBrandVoiceSection(g: BrandingGuidelines): string {
  const today = new Date().toISOString().slice(0, 10);
  const lines = [
    "<!-- BRAND_SYNC_START -->",
    `## Visual & Tone Reference (auto-synced from guidelines · ${today})`,
  ];
  if (g.primaryColor) lines.push(`- **Primary Color:** ${g.primaryColor}`);
  if (g.secondaryColor) lines.push(`- **Secondary Color:** ${g.secondaryColor}`);
  if (g.fontHeading) lines.push(`- **Heading Font:** ${g.fontHeading}`);
  if (g.fontBody) lines.push(`- **Body Font:** ${g.fontBody}`);
  if (g.toneKeywords?.length) lines.push(`- **Tone Keywords:** ${g.toneKeywords.join(", ")}`);
  // Note lives in a comment, not on the page — the renderers drop comments, and
  // "edit it in the guidelines UI" is for whoever opens the stored document,
  // not for the client reading this in the portal. Mirrors src/lib/branding.ts.
  lines.push(
    "",
    "<!-- Auto-synced from the Branding Guidelines UI. Edits made here are overwritten on the next sync. -->",
    "<!-- BRAND_SYNC_END -->",
  );
  return lines.join("\n");
}

function injectBrandVoiceSection(content: string, section: string): string {
  const START = "<!-- BRAND_SYNC_START -->";
  const END = "<!-- BRAND_SYNC_END -->";
  const startIdx = content.indexOf(START);
  const endIdx = content.indexOf(END);
  if (startIdx !== -1 && endIdx !== -1) {
    return content.slice(0, startIdx) + section + content.slice(endIdx + END.length);
  }
  // Below the `# ` title, not above it — a `## ` heading above the title stops
  // stripDocPreamble reaching the title, which then reads as body text inside
  // the first section. Mirrors src/lib/branding.ts.
  const titleMatch = content.match(/^[\s\S]*?^#[ \t]+.+\r?\n/m);
  if (titleMatch) {
    const offset = titleMatch[0].length;
    return content.slice(0, offset) + "\n" + section + "\n\n" + content.slice(offset);
  }
  const fmMatch = content.match(/^---[\s\S]*?---\n/);
  if (fmMatch) {
    const offset = fmMatch[0].length;
    return content.slice(0, offset) + "\n" + section + "\n\n" + content.slice(offset);
  }
  return section + "\n\n" + content;
}

// ── Firestore helpers ─────────────────────────────────────────────────────────
async function listAllClients(): Promise<Client[]> {
  const snap = await db.collection("clients").get();
  return snap.docs.map((d) => ({ id: d.id, ...(d.data() as Omit<Client, "id">) }));
}

async function getContextDoc(clientId: string, docType: string): Promise<ContextDoc | null> {
  const snap = await db
    .collection("clientContextDocs")
    .where("clientId", "==", clientId)
    .where("docType", "==", docType)
    .limit(1)
    .get();
  if (snap.empty) return null;
  const d = snap.docs[0];
  return { id: d.id, ...(d.data() as Omit<ContextDoc, "id">) };
}

async function upsertContextDoc(doc: Omit<ContextDoc, "id">, apply: boolean): Promise<void> {
  const snap = await db
    .collection("clientContextDocs")
    .where("clientId", "==", doc.clientId)
    .where("docType", "==", doc.docType)
    .where("tier", "==", doc.tier)
    .limit(1)
    .get();
  if (!apply) return;
  if (!snap.empty) {
    await snap.docs[0].ref.update({ ...doc });
  } else {
    await db.collection("clientContextDocs").add(doc);
  }
}

// ── Main ──────────────────────────────────────────────────────────────────────
async function main() {
  const apply = process.argv.includes("--apply");
  initAdmin();
  db = getFirestore();
  db.settings({ ignoreUndefinedProperties: true });

  console.log(
    apply ? "APPLYING branding backfill\n" : "DRY RUN — nothing is written. Pass --apply to write.\n",
  );

  console.log("🔍 Fetching all clients from Firestore…");
  const clients = await listAllClients();
  console.log(`   Found ${clients.length} client(s)\n`);

  const summary = { scraped: 0, preset: 0, failed: 0 };

  for (const client of clients) {
    const label = `[${client.name} (${client.id})]`;
    try {
      let scraped: Omit<BrandingGuidelines, "updatedAt"> | null = null;

      if (client.website) {
        process.stdout.write(`${label} Scraping ${client.website}… `);
        scraped = await scrapeWebsiteBranding(client.website);
        console.log(scraped ? `✓ primary=${scraped.primaryColor ?? "—"}, font=${scraped.fontHeading ?? "—"}` : "no signals found");
      } else {
        console.log(`${label} No website configured — using preset`);
      }

      const generated = scraped ?? PRESETS[Math.floor(Math.random() * PRESETS.length)];
      const status = scraped ? "scraped" : "preset";

      // Preserve manually curated metadata; refresh visual tokens
      const existing = client.brandingGuidelines;
      const merged: Omit<BrandingGuidelines, "updatedAt"> = {
        ...generated,
        toneKeywords: existing?.toneKeywords?.length ? existing.toneKeywords : generated.toneKeywords,
        guidelines: existing?.guidelines ?? generated.guidelines,
        logoUrl: existing?.logoUrl ?? generated.logoUrl,
      };

      const fullGuidelines: BrandingGuidelines = { ...merged, updatedAt: Date.now() };
      const now = Date.now();

      const [brandingDoc, voiceDoc] = await Promise.all([
        getContextDoc(client.id, "branding-guidelines"),
        getContextDoc(client.id, "brand-voice"),
      ]);

      await Promise.all([
        // Update client record
        apply
          ? db.collection("clients").doc(client.id).update({ brandingGuidelines: fullGuidelines })
          : Promise.resolve(),

        // Upsert branding-guidelines context doc
        upsertContextDoc(
          {
            clientId: client.id,
            docType: "branding-guidelines",
            tier: brandingDoc?.tier ?? "internal",
            content: brandingToContextDocContent(fullGuidelines, client.name),
            version: (brandingDoc?.version ?? 0) + 1,
            sources: brandingDoc?.sources,
            createdAt: brandingDoc?.createdAt ?? now,
            updatedAt: now,
          },
          apply,
        ),

        // Inject BRAND_SYNC block into brand-voice doc (if it exists)
        voiceDoc
          ? upsertContextDoc(
              {
                clientId: client.id,
                docType: "brand-voice",
                tier: voiceDoc.tier,
                content: injectBrandVoiceSection(voiceDoc.content, buildBrandVoiceSection(fullGuidelines)),
                version: voiceDoc.version + 1,
                sources: voiceDoc.sources,
                createdAt: voiceDoc.createdAt,
                updatedAt: now,
              },
              apply,
            )
          : Promise.resolve(),
      ]);

      console.log(`${label} ✅ ${status} — ${apply ? "saved to Firestore" : "planned (nothing written)"}`);
      summary[status]++;
    } catch (err) {
      console.error(`${label} ❌ Failed:`, err);
      summary.failed++;
    }
  }

  console.log("\n── Summary ─────────────────────────────────────────────");
  console.log(`   Total:   ${clients.length}`);
  console.log(`   Scraped: ${summary.scraped}`);
  console.log(`   Preset:  ${summary.preset}`);
  console.log(`   Failed:  ${summary.failed}`);
  console.log("────────────────────────────────────────────────────────\n");
  process.exit(0);
}

// Only when invoked directly — importing this file must never open a Firestore
// connection, let alone write to one.
if (require.main === module) {
  main().catch((e) => {
    console.error(e);
    process.exit(1);
  });
}
