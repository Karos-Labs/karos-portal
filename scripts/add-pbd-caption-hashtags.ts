/**
 * CD-N — append three relevant hashtags to every UPCOMING Pitch by Deel caption.
 *
 * Albert (2026-08-04): "update all of the captions that we have for them for the
 * upcoming post to add three of the most relevant hashtags we can add there for
 * each of the captions."
 *
 * ── WHAT IT TOUCHES, AND WHAT IT NEVER DOES ──────────────────────────────────
 * Upcoming means status "scheduled" with a future `scheduledAt`: the queue a
 * client has not received yet. Published and past items are what the client
 * already posted from — rewriting those would make the portal disagree with
 * their own TikTok history, so they are out of scope by rule, not by accident.
 *
 * The write is `content` (the caption) and `updatedAt`, nothing else. The
 * portal-feed sync (scripts/sync-pitch-portal-feed.ts) only fills an EMPTY
 * content on an existing asset — "a caption a human replaced in the portal is a
 * deliberate edit" — so tags appended here survive every future sync run.
 *
 * ── HOW "MOST RELEVANT" IS DERIVED ───────────────────────────────────────────
 * Deterministic, per caption, in priority order — every choice is reviewable in
 * the dry-run table before anything is written:
 *   1. The clip's own guest (`meta.person`), slugged: the caption IS about that
 *      person, and a name tag is what a viewer searching them actually types.
 *   2. Topic rules matched against title + caption + about, most specific
 *      first (#ai, #fundraising, #pitchcompetition, a city for a regional-final
 *      post, and so on).
 *   3. Brand and audience fillers (#thepitch, #startups, #venturecapital …)
 *      until there are three.
 * Tags the caption ALREADY carries are never duplicated (case-insensitive), so
 * a caption that arrived with its own tags is topped up, not doubled — and the
 * run is idempotent for free: a second pass derives tags that are all present
 * and writes nothing.
 *
 * ── SAFETY ───────────────────────────────────────────────────────────────────
 * Dry-run by default (prints the full per-caption table); `--apply` writes.
 * Hardcoded to the Pitch by Deel client id, same stance as the feed sync: the
 * derivation vocabulary below is this show's, not a generic one.
 *
 * Usage:
 *   npx tsx scripts/add-pbd-caption-hashtags.ts            # plan only
 *   npx tsx scripts/add-pbd-caption-hashtags.ts --apply    # write
 */

import path from "node:path";
import { existsSync, readFileSync } from "node:fs";
import { cert, getApps, initializeApp } from "firebase-admin/app";
import { getFirestore } from "firebase-admin/firestore";
import type { Asset } from "@/lib/types";

const ROOT = path.resolve(__dirname, "..");

/** Pitch by Deel — same hardcode, same reason, as sync-pitch-portal-feed.ts. */
export const PBD_CLIENT_ID = "jzgdl738dq7DclAdqky1";

export const TAG_COUNT = 3;

/* ═══════════════════════ pure: derivation ═══════════════════════ */

/**
 * Topic rules, most specific first. First match wins a slot, later matches fill
 * the next; a rule's tag never repeats. Patterns run over title + caption +
 * about so a topic named only in the longer `meta.about` still counts.
 *
 * The vocabulary is The Pitch by Deel's own beat — startup/VC clips and
 * competition posts — kept deliberately small so every tag stays defensible as
 * "most relevant" rather than merely present.
 */
const TOPIC_RULES: ReadonlyArray<{ pattern: RegExp; tag: string }> = [
  // Named ecosystems people actually search
  { pattern: /\ba16z\b|andreessen horowitz/i, tag: "a16z" },
  { pattern: /\baws\b|amazon web services/i, tag: "aws" },
  { pattern: /y combinator|\byc\b/i, tag: "ycombinator" },
  // Competition posts ("how they won", regional finals, judges)
  { pattern: /pitch competition|regional final|\bjudges?\b|\bfinalists?\b|how they won|took the .* final/i, tag: "pitchcompetition" },
  { pattern: /\blondon\b/i, tag: "london" },
  { pattern: /\bberlin\b/i, tag: "berlin" },
  { pattern: /\bparis\b|station f/i, tag: "paris" },
  // Domains
  { pattern: /\bai\b|\bagi\b|artificial intelligence|machine learning|\bllms?\b/i, tag: "ai" },
  { pattern: /fintech|payments?\b|banking|neobank/i, tag: "fintech" },
  { pattern: /health insurance|healthtech|health care|healthcare|medical/i, tag: "healthtech" },
  { pattern: /cybersecurity|security compan|crowdstrike/i, tag: "cybersecurity" },
  { pattern: /crypto|web3|blockchain/i, tag: "web3" },
  { pattern: /climate|clean energy/i, tag: "climatetech" },
  { pattern: /\bsaas\b|cloud\b|infrastructure|software compan/i, tag: "saas" },
  // Craft
  { pattern: /fundrais|term sheet|cap table|valuation|\bseed\b|series [ab]\b|raising|\bround\b/i, tag: "fundraising" },
  { pattern: /growth stage|growth-stage|scaling|scale-?up/i, tag: "growth" },
  { pattern: /hiring|talent\b|culture|values\b|leadership|management|\bceo\b/i, tag: "leadership" },
  { pattern: /product[- ]market fit|\bpmf\b|customers?\b|users\b|product\b/i, tag: "product" },
  { pattern: /\bsales\b|selling|go-to-market|\bgtm\b|deals\b/i, tag: "sales" },
  { pattern: /investor|investing|venture|\bvcs?\b|portfolio|\bfund\b/i, tag: "venturecapital" },
];

/**
 * Brand-and-audience fillers, in the order they are reached for. #thepitch is
 * the show's own tag and leads; the rest are the audience every caption serves.
 */
const FILLER_TAGS: readonly string[] = [
  "thepitch",
  "startups",
  "venturecapital",
  "founders",
  "entrepreneurship",
];

/**
 * A person's name as a hashtag: lowercase letters and digits only, diacritics
 * folded (Sebastián → sebastian). Null when the result is too short to be a
 * name or too long to read as a tag.
 */
export function personTag(person: string | undefined | null): string | null {
  if (!person) return null;
  const slug = person
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase()
    .replace(/[^a-z0-9]/g, "");
  return slug.length >= 4 && slug.length <= 24 ? slug : null;
}

/** The fields derivation reads. A subset of Asset so tests need no full doc. */
export interface CaptionFacts {
  title: string;
  content: string;
  /** meta.person — the clip's guest, when the asset is a clip. */
  person?: string | null;
  /** meta.about — the longer editorial note the feed carries. */
  about?: string | null;
}

/**
 * Exactly TAG_COUNT tags, most relevant first, lowercase, unique.
 * Person first, topics next, fillers last — see the module note for why.
 */
export function deriveHashtags(facts: CaptionFacts): string[] {
  const tags: string[] = [];
  const push = (tag: string) => {
    if (tags.length < TAG_COUNT && !tags.includes(tag)) tags.push(tag);
  };

  const person = personTag(facts.person);
  if (person) push(person);

  const haystack = `${facts.title}\n${facts.content}\n${facts.about ?? ""}`;
  for (const rule of TOPIC_RULES) {
    if (tags.length >= TAG_COUNT) break;
    if (rule.pattern.test(haystack)) push(rule.tag);
  }
  for (const filler of FILLER_TAGS) push(filler);
  return tags;
}

/** Every hashtag a caption already carries, lowercased, without the '#'. */
export function existingTags(content: string): Set<string> {
  return new Set([...content.matchAll(/#([\p{L}\p{N}_]+)/gu)].map((m) => m[1].toLowerCase()));
}

/**
 * The caption with the derived tags appended as one trailing line.
 *
 * Tags already present anywhere in the caption are not appended again, which
 * both respects a caption that arrived with its own tags and makes the whole
 * script idempotent: a second run derives tags that are all present and
 * returns the content unchanged.
 */
export function appendHashtags(
  content: string,
  tags: readonly string[],
): { content: string; added: string[] } {
  const present = existingTags(content);
  const added = tags.filter((t) => !present.has(t.toLowerCase()));
  if (added.length === 0) return { content, added };
  const line = added.map((t) => `#${t}`).join(" ");
  return { content: `${content.replace(/\s+$/, "")}\n\n${line}`, added };
}

/** Upcoming = the queue the client has not received: scheduled, in the future. */
export function isUpcoming(asset: Pick<Asset, "status" | "scheduledAt">, now: number): boolean {
  return asset.status === "scheduled" && (asset.scheduledAt ?? 0) >= now;
}

export interface PlannedCaption {
  assetId: string;
  title: string;
  date: string;
  derived: string[];
  added: string[];
  nextContent: string;
}

/** The full plan, in calendar order. `added` empty ⇒ nothing to write. */
export function planCaptions(assets: Asset[], now: number): PlannedCaption[] {
  return assets
    .filter((a) => isUpcoming(a, now))
    .sort((a, b) => (a.scheduledAt ?? 0) - (b.scheduledAt ?? 0))
    .map((a) => {
      const content = a.content ?? "";
      const derived = deriveHashtags({
        title: a.title,
        content,
        person: typeof a.meta?.person === "string" ? a.meta.person : null,
        about: typeof a.meta?.about === "string" ? a.meta.about : null,
      });
      const { content: nextContent, added } = appendHashtags(content, derived);
      return {
        assetId: a.id,
        title: a.title,
        date: new Date(a.scheduledAt!).toISOString().slice(0, 10),
        derived,
        added,
        nextContent,
      };
    });
}

/* ═══════════════════════ impure: main ═══════════════════════ */

function loadEnv() {
  for (const name of [".env.local", ".env"]) {
    const file = path.join(ROOT, name);
    if (!existsSync(file)) continue;
    for (const line of readFileSync(file, "utf8").split("\n")) {
      const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*?)\s*$/);
      if (!m) continue;
      let v = m[2];
      if ((v.startsWith('"') && v.endsWith('"')) || (v.startsWith("'") && v.endsWith("'"))) {
        v = v.slice(1, -1);
      }
      if (!(m[1] in process.env)) process.env[m[1]] = v;
    }
  }
}

function serviceAccount(): { projectId: string; clientEmail: string; privateKey: string } {
  const raw = process.env.FIREBASE_SERVICE_ACCOUNT_KEY;
  if (raw) {
    const p = JSON.parse(raw) as { project_id: string; client_email: string; private_key: string };
    return { projectId: p.project_id, clientEmail: p.client_email, privateKey: p.private_key };
  }
  const projectId = process.env.FIREBASE_PROJECT_ID;
  const clientEmail = process.env.FIREBASE_CLIENT_EMAIL;
  const privateKey = process.env.FIREBASE_PRIVATE_KEY?.replace(/\\n/g, "\n");
  if (!projectId || !clientEmail || !privateKey) {
    throw new Error(
      "No Firebase credentials. Set FIREBASE_SERVICE_ACCOUNT_KEY or the three discrete FIREBASE_* vars in .env.local",
    );
  }
  return { projectId, clientEmail, privateKey };
}

async function main() {
  const apply = process.argv.includes("--apply");
  loadEnv();
  const sa = serviceAccount();
  if (getApps().length === 0) {
    initializeApp({
      credential: cert({ projectId: sa.projectId, clientEmail: sa.clientEmail, privateKey: sa.privateKey }),
    });
  }
  const db = getFirestore();

  const snap = await db.collection("assets").where("clientId", "==", PBD_CLIENT_ID).get();
  const assets = snap.docs.map((d) => ({ id: d.id, ...d.data() })) as Asset[];
  const now = Date.now();
  const plan = planCaptions(assets, now);
  const toWrite = plan.filter((p) => p.added.length > 0);

  console.log(`${apply ? "APPLY" : "DRY RUN"} · project ${sa.projectId} · upcoming ${plan.length} · to update ${toWrite.length}\n`);
  for (const p of plan) {
    const mark = p.added.length === 0 ? "  (already tagged)" : "";
    console.log(`${p.date}  ${p.title.slice(0, 28).padEnd(28)} +${p.added.map((t) => `#${t}`).join(" ")}${mark}`);
  }

  if (!apply) {
    console.log(`\nDry run only. Re-run with --apply to write ${toWrite.length} captions.`);
    return;
  }

  let written = 0;
  for (const p of toWrite) {
    await db.collection("assets").doc(p.assetId).update({ content: p.nextContent, updatedAt: now });
    written++;
  }
  console.log(`\nWrote ${written} captions.`);
}

if (require.main === module) {
  main().catch((e) => {
    console.error(e);
    process.exit(1);
  });
}
