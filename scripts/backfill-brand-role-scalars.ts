/**
 * SCRUM-394 (IGSTYLE-9) backfill: re-resolve every client's LEGACY SCALAR
 * color fields (`primaryAccent`, `secondaryAccent`, `brandNeutralDark`,
 * `brandNeutralLight`) from their EXISTING `dominantColors[].role` text,
 * using the same role-based resolver `src/lib/branding.ts`'s accessors now
 * use — instead of the old positional `[0]`/`[1]`/`[2]`/`[3]` read.
 *
 * THIS IS NOT `backfill-branding.ts`. That script re-SCRAPES a client's
 * website from scratch and can invent a brand-new palette. This script
 * touches no external data at all — it re-reads each client's own,
 * already-correct `dominantColors` array (the array itself is never
 * reordered or modified) and only recomputes the four DERIVED scalar
 * fields that mirror it, so a client whose `dominantColors` role text is
 * already accurate but whose legacy scalars were written positionally
 * before this ticket gets those scalars corrected without touching
 * anything else.
 *
 * `dominantColors` stays dominance-ordered — never reordered here, per
 * IGSTYLE-9's own scope note ("Do not re-sort it to fix the mapping — it
 * is correct data; the reader was wrong").
 *
 *   npx tsx scripts/backfill-brand-role-scalars.ts            # dry run — prints the diff
 *   npx tsx scripts/backfill-brand-role-scalars.ts --apply    # writes
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

// ── Inlined role-resolution logic (mirrors src/lib/branding.ts exactly) ──────
// Inlined rather than imported: this script runs under `tsx` outside Next.js,
// and src/lib/branding.ts imports "server-only" plus several Next-server-only
// modules (@/lib/data, @/services/logger) that this script has no business
// pulling in just to reuse four small pure functions. Kept byte-for-byte
// identical in LOGIC to branding.ts's own copy — if that resolver's rules
// ever change, this script's copy must change with it (there is no test
// pinning the two against each other across this file boundary, the same
// limitation product-mapping.ts's own doc comment names for its own
// transcribed constant; flagged here rather than silently risking drift).
interface BrandColor {
  hex: string;
  dominanceRank: number;
  role?: string;
}

interface BrandingGuidelines {
  dominantColors?: BrandColor[];
  primaryAccent?: string;
  secondaryAccent?: string;
  brandNeutralDark?: string;
  brandNeutralLight?: string;
}

interface Client {
  id: string;
  name: string;
  brandingGuidelines?: BrandingGuidelines;
}

function normalizeHex(raw: string): string | null {
  const h = raw.trim().toLowerCase();
  if (/^#[0-9a-f]{3}$/.test(h)) return "#" + h[1] + h[1] + h[2] + h[2] + h[3] + h[3];
  if (/^#[0-9a-f]{6}$/.test(h)) return h;
  if (/^#[0-9a-f]{8}$/.test(h)) return h.slice(0, 7);
  return null;
}

type ColorRoleClassification = "accent" | "neutral" | "unclassified";
const ACCENT_ROLE_KEYWORDS = ["accent", "cta", "highlight", "badge", "signature"];
const NEUTRAL_ROLE_KEYWORDS = ["ground", "surface", "canvas", "background", "ink", "type", "body", "wordmark", "heading"];

function classifyColorRole(role: string | undefined): ColorRoleClassification {
  if (!role) return "unclassified";
  const lower = role.toLowerCase();
  if (ACCENT_ROLE_KEYWORDS.some((kw) => lower.includes(kw))) return "accent";
  if (NEUTRAL_ROLE_KEYWORDS.some((kw) => lower.includes(kw))) return "neutral";
  return "unclassified";
}

function relativeLuminance(hex: string): number {
  const normalized = normalizeHex(hex);
  if (!normalized) return 0;
  const channel = (c: number): number => {
    const s = c / 255;
    return s <= 0.03928 ? s / 12.92 : Math.pow((s + 0.055) / 1.055, 2.4);
  };
  const r = parseInt(normalized.slice(1, 3), 16);
  const g = parseInt(normalized.slice(3, 5), 16);
  const b = parseInt(normalized.slice(5, 7), 16);
  return 0.2126 * channel(r) + 0.7152 * channel(g) + 0.0722 * channel(b);
}

interface RoleResolvedPalette {
  primaryAccent?: string;
  secondaryAccent?: string;
  brandNeutralDark?: string;
  brandNeutralLight?: string;
  resolvedByRole: boolean;
}

function resolveDominantColorsByRole(colors: readonly BrandColor[]): RoleResolvedPalette {
  const classified = colors.map((color) => ({ color, classification: classifyColorRole(color.role) }));
  if (!classified.some((c) => c.classification !== "unclassified")) {
    return { resolvedByRole: false };
  }
  const accents = classified.filter((c) => c.classification === "accent").map((c) => c.color);
  const neutrals = classified.filter((c) => c.classification === "neutral").map((c) => c.color);

  let brandNeutralDark: string | undefined;
  let brandNeutralLight: string | undefined;
  if (neutrals.length >= 2) {
    const byLuminance = [...neutrals].sort((a, b) => relativeLuminance(a.hex) - relativeLuminance(b.hex));
    brandNeutralDark = byLuminance[0]?.hex;
    brandNeutralLight = byLuminance[byLuminance.length - 1]?.hex;
  } else if (neutrals.length === 1) {
    const only = neutrals[0]!;
    if (relativeLuminance(only.hex) < 0.5) brandNeutralDark = only.hex;
    else brandNeutralLight = only.hex;
  }

  return {
    primaryAccent: accents[0]?.hex,
    secondaryAccent: accents[1]?.hex,
    brandNeutralDark,
    brandNeutralLight,
    resolvedByRole: true,
  };
}

// ── Firestore helpers ─────────────────────────────────────────────────────────
async function listAllClients(): Promise<Client[]> {
  const snap = await db.collection("clients").get();
  return snap.docs.map((d) => ({ id: d.id, ...(d.data() as Omit<Client, "id">) }));
}

function fieldDiff(label: string, before: string | undefined, after: string | undefined): string | null {
  if (before === after) return null;
  return `      ${label}: ${before ?? "—"} → ${after ?? "—"}`;
}

// ── Main ──────────────────────────────────────────────────────────────────────
async function main() {
  const apply = process.argv.includes("--apply");
  initAdmin();
  db = getFirestore();
  db.settings({ ignoreUndefinedProperties: true });

  console.log(
    apply
      ? "APPLYING brand-role-scalar backfill\n"
      : "DRY RUN — nothing is written. Pass --apply to write.\n",
  );

  console.log("🔍 Fetching all clients from Firestore…");
  const clients = await listAllClients();
  console.log(`   Found ${clients.length} client(s)\n`);

  const summary = { changed: 0, unchanged: 0, noDominantColors: 0, noRoleTextClassified: 0, failed: 0 };

  for (const client of clients) {
    const label = `[${client.name} (${client.id})]`;
    try {
      const guidelines = client.brandingGuidelines;
      const dominantColors = guidelines?.dominantColors;
      if (!guidelines || !dominantColors?.length) {
        console.log(`${label} no dominantColors array — skipped (nothing to re-resolve from)`);
        summary.noDominantColors++;
        continue;
      }

      const resolved = resolveDominantColorsByRole(dominantColors);
      if (!resolved.resolvedByRole) {
        console.log(`${label} no color's role text classifies — skipped (positional reading unchanged)`);
        summary.noRoleTextClassified++;
        continue;
      }

      const diffs = [
        fieldDiff("primaryAccent", guidelines.primaryAccent, resolved.primaryAccent),
        fieldDiff("secondaryAccent", guidelines.secondaryAccent, resolved.secondaryAccent),
        fieldDiff("brandNeutralDark", guidelines.brandNeutralDark, resolved.brandNeutralDark),
        fieldDiff("brandNeutralLight", guidelines.brandNeutralLight, resolved.brandNeutralLight),
      ].filter((d): d is string => d !== null);

      if (diffs.length === 0) {
        console.log(`${label} already role-correct — no change`);
        summary.unchanged++;
        continue;
      }

      console.log(`${label} ${apply ? "writing" : "would write"}:`);
      for (const d of diffs) console.log(d);
      summary.changed++;

      if (apply) {
        await db
          .collection("clients")
          .doc(client.id)
          .update({
            "brandingGuidelines.primaryAccent": resolved.primaryAccent ?? null,
            "brandingGuidelines.secondaryAccent": resolved.secondaryAccent ?? null,
            "brandingGuidelines.brandNeutralDark": resolved.brandNeutralDark ?? null,
            "brandingGuidelines.brandNeutralLight": resolved.brandNeutralLight ?? null,
            "brandingGuidelines.updatedAt": Date.now(),
          });
      }
    } catch (err) {
      console.error(`${label} ❌ Failed:`, err);
      summary.failed++;
    }
  }

  console.log("\n── Summary ─────────────────────────────────────────────");
  console.log(`   Total:                    ${clients.length}`);
  console.log(`   Changed:                  ${summary.changed}`);
  console.log(`   Already correct:          ${summary.unchanged}`);
  console.log(`   No dominantColors:        ${summary.noDominantColors}`);
  console.log(`   No role text classified:  ${summary.noRoleTextClassified}`);
  console.log(`   Failed:                   ${summary.failed}`);
  console.log("────────────────────────────────────────────────────────\n");
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
