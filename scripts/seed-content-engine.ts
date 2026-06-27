/**
 * Seed a client's content-engine overlay (config + catalog) into Firestore from
 * the karos-labs on-disk overlay, so the native e12 port (picker / QA /
 * generation) can run inside karosCMO.
 *
 * Usage (loads .env.local for the Firebase service-account + project):
 *   npx tsx --env-file=.env.local scripts/seed-content-engine.ts <slug> [clientId]
 *   e.g. npx tsx --env-file=.env.local scripts/seed-content-engine.ts xodigital
 *   Pass an explicit clientId to seed onto an existing app client (avoids creating
 *   a duplicate when the stored name differs).
 *
 * Reads the karos-labs checkout from KAROS_LABS_PATH (default ../karos-labs):
 *   clients/<slug>/internal/content-engine/{config.yaml, research/catalog.yaml, brand/brand.yaml}
 *
 * Idempotent: re-running overwrites the catalog + config docs and reuses the
 * existing client (matched by name). Standalone — it does NOT import the app's
 * "server-only" data/admin modules; it inits firebase-admin itself.
 */
import { readFileSync, existsSync } from "node:fs";
import path from "node:path";
import { parse as parseYaml } from "yaml";
import { initializeApp, getApps, cert, applicationDefault } from "firebase-admin/app";
import { getFirestore } from "firebase-admin/firestore";
import type {
  CatalogEntry,
  ContentCatalog,
  ContentEngineConfig,
} from "../src/lib/content-engine/types";

/* ----------------------------- firestore ----------------------------- */

function initDb() {
  if (!getApps().length) {
    const raw = process.env.FIREBASE_SERVICE_ACCOUNT_KEY;
    const projectId = process.env.FIREBASE_PROJECT_ID || process.env.NEXT_PUBLIC_FIREBASE_PROJECT_ID;
    if (raw) {
      initializeApp({ credential: cert(JSON.parse(raw)) });
    } else if (process.env.FIREBASE_PROJECT_ID && process.env.FIREBASE_CLIENT_EMAIL && process.env.FIREBASE_PRIVATE_KEY) {
      initializeApp({
        credential: cert({
          projectId: process.env.FIREBASE_PROJECT_ID,
          clientEmail: process.env.FIREBASE_CLIENT_EMAIL,
          privateKey: process.env.FIREBASE_PRIVATE_KEY.replace(/\\n/g, "\n"),
        }),
      });
    } else if (projectId) {
      initializeApp({ credential: applicationDefault(), projectId });
    } else {
      throw new Error("No Firebase credentials. Set FIREBASE_SERVICE_ACCOUNT_KEY (or the discrete FIREBASE_* vars) in .env.local.");
    }
  }
  const db = getFirestore();
  try {
    db.settings({ ignoreUndefinedProperties: true });
  } catch {
    /* already configured */
  }
  return db;
}

/* ------------------------------- yaml -------------------------------- */

function readYaml(file: string): Record<string, unknown> {
  if (!existsSync(file)) throw new Error(`missing ${file}`);
  return (parseYaml(readFileSync(file, "utf8")) as Record<string, unknown>) ?? {};
}

function pick<T>(obj: unknown, key: string, fallback: T): T {
  if (obj && typeof obj === "object" && key in (obj as Record<string, unknown>)) {
    const v = (obj as Record<string, unknown>)[key];
    return (v === undefined ? fallback : (v as T));
  }
  return fallback;
}

/* ----------------------------- mapping ------------------------------- */

function mapConfig(clientId: string, cfg: Record<string, unknown>): ContentEngineConfig {
  const voice = (cfg.voice ?? {}) as Record<string, unknown>;
  const qa = (cfg.qa ?? {}) as Record<string, unknown>;
  const chars = (voice.banned_chars ?? {}) as Record<string, unknown>;
  const hashtags = (voice.hashtags ?? {}) as Record<string, unknown>;
  const slides = (cfg.slides ?? {}) as Record<string, unknown>;
  const selection = (cfg.selection ?? {}) as Record<string, unknown>;
  const canvasDefault = ((cfg.canvas ?? {}) as Record<string, unknown>).default as Record<string, unknown> | undefined;
  const mediaImage = ((cfg.media ?? {}) as Record<string, unknown>).image as Record<string, unknown> | undefined;

  return {
    clientId,
    formats: pick<string[]>(cfg, "formats", []),
    selection: {
      rotateFormats: pick(selection, "rotate_formats", true),
      subjectCooldown: pick(selection, "subject_cooldown", 50),
      minSharedTokens: pick(selection, "min_shared_tokens", 1),
    },
    slides: {
      countMin: pick(slides, "count_min", 4),
      countMax: pick(slides, "count_max", 8),
      hookTypes: pick<string[]>(slides, "hook_types", ["hook", "split"]),
      payoffTypes: pick<string[]>(slides, "payoff_types", []),
      closerTypes: pick<string[]>(slides, "closer_types", []),
      bannedTypes: pick<string[]>(slides, "banned_types", []),
    },
    voice: {
      tone: pick(voice, "tone", "") || undefined,
      bannedWords: pick<string[]>(voice, "banned_words", []),
      bannedChars: {
        emoji: pick(chars, "emoji", true),
        exclamation: pick(chars, "exclamation", true),
        emDash: pick(chars, "em_dash", true),
        semicolon: pick(chars, "semicolon", false),
      },
      hashtags: {
        count: pick(hashtags, "count", 2),
        case: pick(hashtags, "case", "lowercase") as "lowercase" | "uppercase" | "none",
      },
      requiredDisclaimer: pick(voice, "required_disclaimer", "") || undefined,
      // qa.require_disclaimer_on_number lives under the `qa` block in config.yaml.
      requireDisclaimerOnNumber: pick(qa, "require_disclaimer_on_number", false),
      oneNumberPerPost: pick(voice, "one_number_per_post", false),
    },
    canvas: canvasDefault
      ? { w: pick(canvasDefault, "w", 1080), h: pick(canvasDefault, "h", 1440), ratio: pick(canvasDefault, "ratio", "3:4") }
      : undefined,
    realImageryOnly: mediaImage ? pick(mediaImage, "real_only", false) : false,
    updatedAt: Date.now(),
  };
}

function mapCatalog(clientId: string, raw: Record<string, unknown>): ContentCatalog {
  const list = (raw.posts ?? raw.catalog ?? raw.topics ?? []) as unknown[];
  const entries = list.filter((e): e is CatalogEntry => !!e && typeof e === "object" && "k" in (e as object));
  return { clientId, entries, updatedAt: Date.now() };
}

function brandVoiceFrom(cfg: Record<string, unknown>, brand: Record<string, unknown>): string {
  const b = (brand.brand ?? cfg.brand ?? {}) as Record<string, unknown>;
  const voice = (cfg.voice ?? {}) as Record<string, unknown>;
  const lines = [
    pick(b, "one_line_positioning", "") as string,
    pick(b, "tagline", "") ? `Tagline: ${pick(b, "tagline", "")}` : "",
    pick(b, "category", "") ? `Category: ${pick(b, "category", "")}` : "",
    pick(voice, "tone", "") ? `Tone: ${pick(voice, "tone", "")}` : "",
    "Language: pt-BR.",
  ].filter(Boolean);
  return lines.join("\n");
}

/* ------------------------------- main -------------------------------- */

async function main() {
  const slug = process.argv[2] || "xodigital";
  const labsRoot = process.env.KAROS_LABS_PATH || path.resolve(process.cwd(), "..", "karos-labs");
  const ceRoot = path.join(labsRoot, "clients", slug, "internal", "content-engine");

  const cfg = readYaml(path.join(ceRoot, "config.yaml"));
  const catalogRaw = readYaml(path.join(ceRoot, "research", "catalog.yaml"));
  const brand = existsSync(path.join(ceRoot, "brand", "brand.yaml")) ? readYaml(path.join(ceRoot, "brand", "brand.yaml")) : {};

  const brandBlock = (brand.brand ?? cfg.brand ?? {}) as Record<string, unknown>;
  const clientName = (pick(brandBlock, "name", "") as string) || "XO Digital";

  const db = initDb();

  // Resolve the target client. Prefer an explicit id (3rd arg) to avoid ever
  // creating a duplicate of an existing app client; otherwise match by name
  // case/whitespace-insensitively and fail loudly on ambiguity.
  const explicitId = process.argv[3];
  let clientId: string;
  if (explicitId) {
    const doc = await db.collection("clients").doc(explicitId).get();
    if (!doc.exists) throw new Error(`No client with id "${explicitId}". Pass a valid clientId or omit it to match/create by name.`);
    clientId = doc.id;
    console.log(`Using explicit client "${(doc.data() as { name?: string }).name ?? clientId}" (${clientId})`);
  } else {
    const all = await db.collection("clients").get();
    const norm = (s: string) => s.trim().toLowerCase();
    const matches = all.docs.filter((d) => norm((d.data() as { name?: string }).name ?? "") === norm(clientName));
    if (matches.length > 1) {
      throw new Error(
        `Multiple clients named "${clientName}": ${matches.map((d) => d.id).join(", ")}. Re-run with an explicit clientId: npx tsx --env-file=.env.local scripts/seed-content-engine.ts ${slug} <clientId>`,
      );
    }
    if (matches.length === 1) {
      clientId = matches[0].id;
      console.log(`Reusing client "${clientName}" (${clientId})`);
    } else {
      const ref = await db.collection("clients").add({
        name: clientName,
        website: pick(brandBlock, "website", "") as string,
        industry: pick(brandBlock, "category", "") as string,
        contactEmail: "",
        domains: [],
        description: pick(brandBlock, "one_line_positioning", "") as string,
        brandVoice: brandVoiceFrom(cfg, brand),
        accentColor: "#0B2545",
        assignedEmployeeIds: [],
        status: "active",
        createdAt: Date.now(),
        createdBy: "seed-script",
      });
      clientId = ref.id;
      console.log(`Created client "${clientName}" (${clientId})`);
    }
  }

  const config = mapConfig(clientId, cfg);
  const catalog = mapCatalog(clientId, catalogRaw);

  await db.collection("contentEngineConfigs").doc(clientId).set(config, { merge: true });
  await db.collection("contentCatalogs").doc(clientId).set(catalog, { merge: true });

  console.log(`Seeded contentEngineConfigs/${clientId} — formats: ${config.formats.join(", ")}`);
  console.log(`Seeded contentCatalogs/${clientId} — ${catalog.entries.length} topics`);
  console.log(`realImageryOnly=${config.realImageryOnly} · disclaimer ${config.voice.requiredDisclaimer ? "set" : "none"} · hashtags ${config.voice.hashtags.count}/${config.voice.hashtags.case}`);
  console.log("Done. Open the client in the app and click “Run content engine”.");
}

main().catch((e) => {
  console.error(e instanceof Error ? e.message : e);
  process.exit(1);
});
