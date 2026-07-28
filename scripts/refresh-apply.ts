/**
 * CD-G7 — per-client data COMPLETION refresh, step 2 of 2: the ONLY write path.
 *
 * Takes one per-client proposal JSON produced by a refresh team from a
 * scripts/refresh-export.ts dump and lands it in Firestore. Dry run by default;
 * `--apply` performs the writes, in a single atomic batch per client.
 *
 *   npx tsx scripts/refresh-apply.ts --file=/abs/path/geektime.proposal.json --client=<id>
 *   npx tsx scripts/refresh-apply.ts --file=... --client=<id> --apply
 *
 * COMPLETION SEMANTICS — enforced here, not merely documented:
 *   · Nothing is ever deleted. This file contains no delete/remove call, and
 *     the proposal schema has no way to express one.
 *   · Documents may be updated or created; a document may not shrink by more
 *     than 10% and may never lose a `## ` section. `shrinkApproved` relaxes the
 *     length floor with a written reason; it never relaxes the section floor.
 *   · Competitor rows may be updated or added. A field may not be blanked and
 *     an existing non-empty list may not be emptied.
 *   · Brand colors may be replaced wholesale (that is the point of CD-E2), but
 *     3-4 entries, unique hexes, sequential dominanceRank and usagePct summing
 *     to exactly 100 are all hard gates.
 *   · Every other client profile field is FILL-ONLY: written when the stored
 *     value is empty, skipped (never overwritten) when a human already set it.
 *
 * The proposal is validated with zero tolerance for unknown keys, unknown
 * collections, illegal docType/tier pairs, and the placeholder phrases the
 * intel pipeline bans. This script is the safety boundary for the whole pass —
 * if a check belongs anywhere, it belongs here.
 *
 * Schema: docs/qa-sweep-2026-07/refresh/BRIEF-TEMPLATE.md
 */
import path from "node:path";
import { readFileSync } from "node:fs";

const ROOT = path.resolve(__dirname, "..");

function loadEnv() {
  for (const line of readFileSync(path.join(ROOT, ".env.local"), "utf8").split("\n")) {
    const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*)\s*$/);
    if (!m) continue;
    let v = m[2];
    if ((v.startsWith('"') && v.endsWith('"')) || (v.startsWith("'") && v.endsWith("'"))) v = v.slice(1, -1);
    if (!(m[1] in process.env)) process.env[m[1]] = v;
  }
}

/* ── Canonical shapes (inlined: src/lib/* is server-only, per house convention) ── */

type Row = Record<string, unknown>;

/** Written at tier "internal" AND condensed to tier "client" (pipeline.ts:885). */
const PUBLIC_DOC_TYPES = [
  "brand-voice",
  "market-strategy",
  "competitor-analysis",
  "product-information",
  "branding-guidelines",
  "target-audience",
] as const;

/** Never published — tier "internal-only" only (pipeline.ts:893). */
const INTERNAL_ONLY_DOC_TYPES = ["client-guidelines", "action-plan"] as const;

/**
 * Legal (docType → tier) pairs. This table IS the no-leak boundary: writing
 * client-guidelines or action-plan at tier "client" would publish an internal
 * document to the client portal. "meeting-notes" is absent on purpose — it is
 * written exclusively by the transcript ingest and is not a refresh target.
 */
const LEGAL_TIERS: Record<string, readonly string[]> = {
  ...Object.fromEntries(PUBLIC_DOC_TYPES.map((t) => [t, ["internal", "client"] as const])),
  ...Object.fromEntries(INTERNAL_ONLY_DOC_TYPES.map((t) => [t, ["internal-only"] as const])),
};

/** Profile fields the refresh may FILL when empty. Never overwritten. */
const PROFILE_FILL_FIELDS = [
  "website",
  "industry",
  "category",
  "description",
  "brandVoice",
] as const;

const SOCIAL_LINK_KEYS = [
  "instagram",
  "linkedin",
  "x",
  "tiktok",
  "youtube",
  "facebook",
  "website",
] as const;

/** Branding fields the refresh may FILL when empty (colors are handled separately). */
const BRANDING_FILL_FIELDS = ["fontHeading", "fontBody", "visualStyle", "guidelines"] as const;

/** Competitor fields a proposal may set. id/clientId/source/createdAt and the
 *  machine-measured llmMentions pair are deliberately absent. */
const COMPETITOR_FIELDS = [
  "company",
  "url",
  "founded",
  "marketTier",
  "minInvestment",
  "overlap",
  "deepDive",
  "positioning",
  "scale",
  "keyStrengths",
  "keyWeaknesses",
  "threatLevel",
] as const;

const MARKET_TIERS = ["Leader", "Challenger", "Niche", "Other"] as const;
const OVERLAPS = ["High", "Medium", "Low-Med", "Low"] as const;
const THREAT_LEVELS = ["HIGH", "MEDIUM", "LOW"] as const;

/** Zero-tolerance placeholders (brain.ts RESEARCH_ENGINE_RULES, pipeline.ts:518). */
const BANNED_PLACEHOLDERS = [
  "data unavailable",
  "information not found",
  "no information available",
  "cannot determine",
  "as an ai",
  "i cannot access",
  "i don't have real-time data",
];

/** A document may not shrink past this fraction of the stored version. */
const SHRINK_FLOOR = 0.9;
/** …or past this fraction even with a written `shrinkApproved` reason. */
const SHRINK_FLOOR_APPROVED = 0.5;
const MIN_DOC_CHARS = 800;
const MIN_DOC_SECTIONS = 3;
const MAX_COMPETITORS = 40;

/* ── Validation plumbing ─────────────────────────────────────────────── */

class ProposalError extends Error {}

const errors: string[] = [];
function fail(where: string, msg: string): void {
  errors.push(`${where}: ${msg}`);
}

function isPlainObject(v: unknown): v is Row {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

function rejectUnknownKeys(where: string, obj: Row, allowed: readonly string[]): void {
  for (const k of Object.keys(obj)) {
    if (!allowed.includes(k)) fail(where, `unknown key "${k}" (allowed: ${allowed.join(", ")})`);
  }
}

function requireString(where: string, v: unknown, opts: { min?: number; max?: number } = {}): string | null {
  if (typeof v !== "string") {
    fail(where, `expected a string, got ${Array.isArray(v) ? "array" : typeof v}`);
    return null;
  }
  const s = v.trim();
  if (s.length < (opts.min ?? 1)) {
    fail(where, `blank or too short (min ${opts.min ?? 1} chars) — a refresh never blanks a field`);
    return null;
  }
  if (opts.max && s.length > opts.max) {
    fail(where, `too long (${s.length} > ${opts.max})`);
    return null;
  }
  return s;
}

function requireStringArray(where: string, v: unknown, max = 40): string[] | null {
  if (!Array.isArray(v)) {
    fail(where, "expected an array of strings");
    return null;
  }
  if (v.length > max) {
    fail(where, `too many entries (${v.length} > ${max})`);
    return null;
  }
  const out: string[] = [];
  v.forEach((entry, i) => {
    const s = requireString(`${where}[${i}]`, entry, { max: 400 });
    if (s) out.push(s);
  });
  return out;
}

/** Bare lowercase host, matching what parseCompetitorInput stores (competitor-input.ts:35). */
function normalizeDomain(where: string, raw: unknown): string | null {
  const s = requireString(where, raw, { max: 253 });
  if (!s) return null;
  let host: string;
  try {
    host = new URL(s.includes("://") ? s : `https://${s}`).hostname.toLowerCase().replace(/^www\./, "");
  } catch {
    fail(where, `"${s}" is not a parseable domain or URL`);
    return null;
  }
  if (!/^([a-z0-9](?:[a-z0-9-]*[a-z0-9])?\.)+[a-z]{2,24}$/.test(host)) {
    fail(where, `"${s}" does not resolve to a real hostname — a competitor row needs a working domain`);
    return null;
  }
  return host;
}

function checkBannedPlaceholders(where: string, content: string): void {
  const lower = content.toLowerCase();
  for (const p of BANNED_PLACEHOLDERS) {
    if (lower.includes(p)) fail(where, `contains the banned placeholder "${p}" — the pipeline forbids it in any rendered document`);
  }
}

function sectionCount(md: string): number {
  return (md.match(/^## /gm) ?? []).length;
}

/* ── Plan types ──────────────────────────────────────────────────────── */

interface DocPlan {
  docType: string;
  tier: string;
  action: "create" | "update" | "unchanged";
  docId: string | null;
  fromChars: number;
  toChars: number;
  fromSections: number;
  toSections: number;
  fromVersion: number;
  toVersion: number;
  verifyTokens: number;
  sources: string[] | null;
}

interface CompetitorPlan {
  action: "create" | "update" | "unchanged";
  id: string | null;
  company: string;
  changes: Array<{ field: string; from: unknown; to: unknown }>;
  data: Row;
}

interface ClientPlan {
  profile: Array<{ field: string; from: unknown; to: unknown }>;
  skippedProfile: Array<{ field: string; reason: string }>;
  colors: { from: Row[]; to: Row[] } | null;
  brandingFill: Array<{ field: string; to: unknown }>;
}

/* ── Proposal validation + plan build ────────────────────────────────── */

const PROPOSAL_KEYS = [
  "schemaVersion",
  "clientId",
  "clientName",
  "generatedAt",
  "team",
  "notes",
  "client",
  "docs",
  "competitors",
] as const;

/** Validated markdown bodies, keyed `docType@tier`. Only these are ever written. */
const docContent = new Map<string, string>();

function buildDocPlans(raw: unknown, stored: Map<string, Row>): DocPlan[] {
  if (raw === undefined) return [];
  if (!Array.isArray(raw)) {
    fail("docs", "expected an array");
    return [];
  }
  const plans: DocPlan[] = [];
  const seen = new Set<string>();

  raw.forEach((entry, i) => {
    const where = `docs[${i}]`;
    if (!isPlainObject(entry)) return fail(where, "expected an object");
    rejectUnknownKeys(where, entry, ["docType", "tier", "content", "sources", "shrinkApproved"]);

    const docType = requireString(`${where}.docType`, entry.docType);
    const tier = requireString(`${where}.tier`, entry.tier);
    if (!docType || !tier) return;

    const legal = LEGAL_TIERS[docType];
    if (!legal) {
      return fail(
        `${where}.docType`,
        `"${docType}" is not a refreshable document type (allowed: ${Object.keys(LEGAL_TIERS).join(", ")})`,
      );
    }
    if (!legal.includes(tier)) {
      return fail(
        `${where}.tier`,
        `"${docType}" may only be written at tier ${legal.map((t) => `"${t}"`).join(" or ")} — ` +
          `"${tier}" would breach the no-leak boundary`,
      );
    }

    const key = `${docType}@${tier}`;
    if (seen.has(key)) return fail(where, `duplicate entry for ${key}`);
    seen.add(key);

    const content = requireString(`${where}.content`, entry.content, { min: MIN_DOC_CHARS });
    if (!content) return;
    docContent.set(key, content);

    if (!content.startsWith("---")) {
      fail(`${where}.content`, "must begin with the YAML frontmatter `---` (pipeline.ts:522)");
    }
    const sections = sectionCount(content);
    if (sections < MIN_DOC_SECTIONS) {
      fail(`${where}.content`, `only ${sections} \`## \` sections — a pipeline document has many more`);
    }
    checkBannedPlaceholders(`${where}.content`, content);

    const verifyTokens = (content.match(/\[VERIFY\]/g) ?? []).length;
    if (tier === "client" && verifyTokens > 0) {
      fail(
        `${where}.content`,
        `${verifyTokens} [VERIFY] token(s) at tier "client" — unverified markers must never reach the client portal. ` +
          "Resolve them, or keep the claim in the internal tier only.",
      );
    }

    let sources: string[] | null = null;
    if (entry.sources !== undefined) sources = requireStringArray(`${where}.sources`, entry.sources, 200);

    let shrinkApproved: string | null = null;
    if (entry.shrinkApproved !== undefined) {
      shrinkApproved = requireString(`${where}.shrinkApproved`, entry.shrinkApproved, { min: 20, max: 500 });
    }

    const existing = stored.get(key);
    if (!existing) {
      plans.push({
        docType,
        tier,
        action: "create",
        docId: null,
        fromChars: 0,
        toChars: content.length,
        fromSections: 0,
        toSections: sections,
        fromVersion: 0,
        toVersion: 1,
        verifyTokens,
        sources,
      });
      return;
    }

    const prev = String(existing.content ?? "");
    if (prev === content) {
      plans.push({
        docType,
        tier,
        action: "unchanged",
        docId: String(existing.id),
        fromChars: prev.length,
        toChars: content.length,
        fromSections: sectionCount(prev),
        toSections: sections,
        fromVersion: Number(existing.version ?? 0),
        toVersion: Number(existing.version ?? 0),
        verifyTokens,
        sources,
      });
      return;
    }

    const prevSections = sectionCount(prev);
    if (sections < prevSections) {
      fail(
        `${where}.content`,
        `drops ${prevSections - sections} section(s) (${prevSections} → ${sections}). ` +
          "A completion pass never removes a section.",
      );
    }
    const floor = shrinkApproved ? SHRINK_FLOOR_APPROVED : SHRINK_FLOOR;
    if (prev.length > 0 && content.length < prev.length * floor) {
      fail(
        `${where}.content`,
        `shrinks to ${Math.round((content.length / prev.length) * 100)}% of the stored document ` +
          `(${prev.length} → ${content.length} chars, floor ${Math.round(floor * 100)}%)` +
          (shrinkApproved ? "" : " — add a written `shrinkApproved` reason if this is deliberate"),
      );
    }

    plans.push({
      docType,
      tier,
      action: "update",
      docId: String(existing.id),
      fromChars: prev.length,
      toChars: content.length,
      fromSections: prevSections,
      toSections: sections,
      fromVersion: Number(existing.version ?? 0),
      toVersion: Number(existing.version ?? 0) + 1,
      verifyTokens,
      sources,
    });
  });

  return plans;
}

function buildCompetitorPlans(raw: unknown, stored: Row[]): CompetitorPlan[] {
  if (raw === undefined) return [];
  if (!isPlainObject(raw)) {
    fail("competitors", "expected an object with optional `update` and `create` arrays");
    return [];
  }
  rejectUnknownKeys("competitors", raw, ["update", "create"]);

  const byId = new Map(stored.map((c) => [String(c.id), c]));
  const plans: CompetitorPlan[] = [];

  const readFields = (where: string, entry: Row, existing: Row | null): Row => {
    const out: Row = {};
    for (const f of COMPETITOR_FIELDS) {
      const v = entry[f];
      if (v === undefined) continue;
      const w = `${where}.${f}`;
      if (f === "url") {
        const host = normalizeDomain(w, v);
        if (host) out.url = host;
      } else if (f === "deepDive") {
        if (typeof v !== "boolean") fail(w, "expected a boolean");
        else out.deepDive = v;
      } else if (f === "marketTier") {
        if (!MARKET_TIERS.includes(v as (typeof MARKET_TIERS)[number])) fail(w, `expected one of ${MARKET_TIERS.join(" | ")}`);
        else out.marketTier = v;
      } else if (f === "overlap") {
        if (!OVERLAPS.includes(v as (typeof OVERLAPS)[number])) fail(w, `expected one of ${OVERLAPS.join(" | ")}`);
        else out.overlap = v;
      } else if (f === "threatLevel") {
        if (!THREAT_LEVELS.includes(v as (typeof THREAT_LEVELS)[number])) fail(w, `expected one of ${THREAT_LEVELS.join(" | ")}`);
        else out.threatLevel = v;
      } else if (f === "keyStrengths" || f === "keyWeaknesses") {
        const arr = requireStringArray(w, v, 12);
        if (arr) {
          const prevArr = Array.isArray(existing?.[f]) ? (existing[f] as unknown[]) : [];
          if (arr.length === 0 && prevArr.length > 0) {
            fail(w, `would empty a list that currently holds ${prevArr.length} entries — a refresh never blanks data`);
          } else {
            out[f] = arr;
          }
        }
      } else {
        const s = requireString(w, v, { max: 2000 });
        if (s) out[f] = s;
      }
    }
    return out;
  };

  if (raw.update !== undefined) {
    if (!Array.isArray(raw.update)) fail("competitors.update", "expected an array");
    else
      raw.update.forEach((entry, i) => {
        const where = `competitors.update[${i}]`;
        if (!isPlainObject(entry)) return fail(where, "expected an object");
        rejectUnknownKeys(where, entry, ["id", ...COMPETITOR_FIELDS]);

        const id = requireString(`${where}.id`, entry.id);
        if (!id) return;
        const existing = byId.get(id);
        if (!existing) {
          return fail(
            `${where}.id`,
            `"${id}" is not a competitor of this client — ids come from the export's competitors[].id`,
          );
        }

        const data = readFields(where, entry, existing);
        const changes = Object.entries(data)
          .filter(([k, v]) => JSON.stringify(existing[k]) !== JSON.stringify(v))
          .map(([field, to]) => ({ field, from: existing[field], to }));

        plans.push({
          action: changes.length ? "update" : "unchanged",
          id,
          company: String(existing.company ?? id),
          changes,
          data,
        });
      });
  }

  if (raw.create !== undefined) {
    if (!Array.isArray(raw.create)) fail("competitors.create", "expected an array");
    else
      raw.create.forEach((entry, i) => {
        const where = `competitors.create[${i}]`;
        if (!isPlainObject(entry)) return fail(where, "expected an object");
        rejectUnknownKeys(where, entry, COMPETITOR_FIELDS);

        const data = readFields(where, entry, null);
        if (typeof data.company !== "string") fail(`${where}.company`, "required on a new competitor row");
        if (typeof data.url !== "string") {
          fail(`${where}.url`, "required on a new competitor row — a row without a working domain renders as a generic glyph");
        }
        if (typeof data.company !== "string" || typeof data.url !== "string") return;

        const nameKey = data.company.trim().toLowerCase();
        const clash = stored.find(
          (c) =>
            String(c.company ?? "").trim().toLowerCase() === nameKey ||
            (typeof c.url === "string" && c.url.toLowerCase().replace(/^www\./, "") === data.url),
        );
        if (clash) {
          return fail(
            where,
            `duplicates the existing row "${String(clash.company)}" (${String(clash.url ?? "no url")}) — ` +
              "put it in `update` with that row's id instead",
          );
        }
        const dupeInBatch = plans.find(
          (p) => p.action === "create" && String(p.data.url) === data.url,
        );
        if (dupeInBatch) return fail(where, `duplicates ${String(dupeInBatch.data.url)} earlier in this proposal`);

        plans.push({
          action: "create",
          id: null,
          company: data.company,
          changes: Object.entries(data).map(([field, to]) => ({ field, from: undefined, to })),
          data,
        });
      });
  }

  const finalCount = stored.length + plans.filter((p) => p.action === "create").length;
  if (finalCount > MAX_COMPETITORS) {
    fail("competitors.create", `would take the roster to ${finalCount} rows (cap ${MAX_COMPETITORS})`);
  }

  return plans;
}

function buildClientPlan(raw: unknown, stored: Row, colorDocSupplied: string | null): ClientPlan {
  const plan: ClientPlan = { profile: [], skippedProfile: [], colors: null, brandingFill: [] };
  if (raw === undefined) return plan;
  if (!isPlainObject(raw)) {
    fail("client", "expected an object");
    return plan;
  }
  rejectUnknownKeys("client", raw, ["profile", "brandingGuidelines"]);

  const isEmpty = (v: unknown) =>
    v === undefined || v === null || (typeof v === "string" && v.trim() === "") ||
    (Array.isArray(v) && v.length === 0) || (isPlainObject(v) && Object.keys(v).length === 0);

  if (raw.profile !== undefined) {
    if (!isPlainObject(raw.profile)) fail("client.profile", "expected an object");
    else {
      rejectUnknownKeys("client.profile", raw.profile, [...PROFILE_FILL_FIELDS, "socialLinks"]);
      for (const f of PROFILE_FILL_FIELDS) {
        const v = raw.profile[f];
        if (v === undefined) continue;
        const s = requireString(`client.profile.${f}`, v, { max: 4000 });
        if (!s) continue;
        if (!isEmpty(stored[f])) {
          plan.skippedProfile.push({ field: f, reason: `already set to ${JSON.stringify(stored[f])} — fill-only field` });
          continue;
        }
        plan.profile.push({ field: f, from: stored[f], to: s });
      }
      if (raw.profile.socialLinks !== undefined) {
        const sl = raw.profile.socialLinks;
        if (!isPlainObject(sl)) fail("client.profile.socialLinks", "expected an object");
        else {
          rejectUnknownKeys("client.profile.socialLinks", sl, SOCIAL_LINK_KEYS);
          const storedLinks = isPlainObject(stored.socialLinks) ? stored.socialLinks : {};
          const merged: Row = { ...storedLinks };
          let touched = false;
          for (const k of SOCIAL_LINK_KEYS) {
            const v = sl[k];
            if (v === undefined) continue;
            const s = requireString(`client.profile.socialLinks.${k}`, v, { max: 500 });
            if (!s) continue;
            if (!isEmpty(storedLinks[k])) {
              plan.skippedProfile.push({ field: `socialLinks.${k}`, reason: "already set — fill-only field" });
              continue;
            }
            merged[k] = s;
            touched = true;
          }
          if (touched) plan.profile.push({ field: "socialLinks", from: storedLinks, to: merged });
        }
      }
    }
  }

  if (raw.brandingGuidelines !== undefined) {
    const bg = raw.brandingGuidelines;
    if (!isPlainObject(bg)) {
      fail("client.brandingGuidelines", "expected an object");
      return plan;
    }
    rejectUnknownKeys("client.brandingGuidelines", bg, [...BRANDING_FILL_FIELDS, "dominantColors", "toneKeywords"]);
    const storedBg = isPlainObject(stored.brandingGuidelines) ? stored.brandingGuidelines : {};

    if (bg.dominantColors !== undefined) {
      const colors = bg.dominantColors;
      if (!Array.isArray(colors)) fail("client.brandingGuidelines.dominantColors", "expected an array");
      else if (colors.length < 3 || colors.length > 4) {
        fail(
          "client.brandingGuidelines.dominantColors",
          `expected 3 or 4 colors (CD-E2), got ${colors.length}`,
        );
      } else {
        const out: Row[] = [];
        const hexes = new Set<string>();
        let pctTotal = 0;
        colors.forEach((c, i) => {
          const where = `client.brandingGuidelines.dominantColors[${i}]`;
          if (!isPlainObject(c)) return fail(where, "expected an object");
          rejectUnknownKeys(where, c, ["hex", "dominanceRank", "role", "usagePct"]);
          const hex = typeof c.hex === "string" ? c.hex.trim().toLowerCase() : "";
          if (!/^#[0-9a-f]{6}$/.test(hex)) {
            fail(`${where}.hex`, `expected a 6-digit lowercase hex like "#e91e8c", got ${JSON.stringify(c.hex)}`);
          } else if (hexes.has(hex)) {
            fail(`${where}.hex`, `duplicate color ${hex}`);
          } else {
            hexes.add(hex);
          }
          if (c.dominanceRank !== i + 1) {
            fail(`${where}.dominanceRank`, `expected ${i + 1} (array order IS dominance order), got ${JSON.stringify(c.dominanceRank)}`);
          }
          const pct = c.usagePct;
          if (typeof pct !== "number" || !Number.isInteger(pct) || pct < 0 || pct > 100) {
            fail(`${where}.usagePct`, `expected an integer 0-100, got ${JSON.stringify(pct)}`);
          } else {
            pctTotal += pct;
          }
          let role: string | undefined;
          if (c.role !== undefined) {
            const r = requireString(`${where}.role`, c.role, { max: 60 });
            if (r) role = r;
          }
          out.push({ hex, dominanceRank: i + 1, ...(role ? { role } : {}), usagePct: pct });
        });
        if (out.length === colors.length && pctTotal !== 100) {
          fail(
            "client.brandingGuidelines.dominantColors",
            `usagePct must sum to exactly 100 (CD-E2), got ${pctTotal}`,
          );
        }
        const storedColors = Array.isArray(storedBg.dominantColors) ? (storedBg.dominantColors as Row[]) : [];
        if (JSON.stringify(storedColors) !== JSON.stringify(out)) {
          plan.colors = { from: storedColors, to: out };
          // The app regenerates the branding-guidelines doc from the structured
          // palette on every save (branding-actions.ts:81). A proposal that moves
          // the palette without restating it in the document leaves agents reading
          // stale hexes — refuse rather than create the drift.
          if (!colorDocSupplied) {
            fail(
              "client.brandingGuidelines.dominantColors",
              "changes the palette but the proposal carries no branding-guidelines document at tier \"internal\". " +
                "Ship the updated document in the same proposal so agents never read a stale palette.",
            );
          } else {
            const missing = out
              .map((c) => String(c.hex))
              .filter((hex) => !colorDocSupplied.toLowerCase().includes(hex));
            if (missing.length) {
              fail(
                "client.brandingGuidelines.dominantColors",
                `the supplied branding-guidelines document does not mention ${missing.join(", ")} — palette and document must agree`,
              );
            }
          }
        }
      }
    }

    for (const f of BRANDING_FILL_FIELDS) {
      const v = bg[f];
      if (v === undefined) continue;
      const s = requireString(`client.brandingGuidelines.${f}`, v, { max: 20000 });
      if (!s) continue;
      if (!isEmpty(storedBg[f])) continue;
      plan.brandingFill.push({ field: f, to: s });
    }
    if (bg.toneKeywords !== undefined) {
      const arr = requireStringArray("client.brandingGuidelines.toneKeywords", bg.toneKeywords, 12);
      if (arr && isEmpty(storedBg.toneKeywords)) plan.brandingFill.push({ field: "toneKeywords", to: arr });
    }
  }

  return plan;
}

/* ── Reporting ───────────────────────────────────────────────────────── */

function short(v: unknown, n = 60): string {
  const s = typeof v === "string" ? v : JSON.stringify(v);
  if (s === undefined) return "—";
  return s.length > n ? `${s.slice(0, n)}…` : s;
}

function printPlan(
  clientName: string,
  clientId: string,
  docs: DocPlan[],
  comps: CompetitorPlan[],
  client: ClientPlan,
): void {
  console.log(`\n═══ ${clientName} (${clientId}) ═══\n`);

  console.log("DOCUMENTS");
  if (!docs.length) console.log("  (none in this proposal)");
  for (const d of docs) {
    const tag = d.action === "create" ? "CREATE " : d.action === "update" ? "UPDATE " : "same   ";
    const delta = d.action === "create" ? `${d.toChars} chars` : `${d.fromChars} → ${d.toChars} chars`;
    const secs = d.action === "create" ? `${d.toSections} sections` : `${d.fromSections} → ${d.toSections} sections`;
    console.log(
      `  ${tag} ${d.docType}@${d.tier}  ${delta} · ${secs} · v${d.fromVersion} → v${d.toVersion}` +
        (d.verifyTokens ? `  ⚑ ${d.verifyTokens} [VERIFY]` : "") +
        (d.sources ? `  · ${d.sources.length} sources` : ""),
    );
  }

  console.log("\nCOMPETITORS");
  if (!comps.length) console.log("  (none in this proposal)");
  for (const c of comps) {
    if (c.action === "unchanged") {
      console.log(`  same    ${c.company}`);
      continue;
    }
    console.log(`  ${c.action === "create" ? "CREATE " : "UPDATE "} ${c.company}`);
    for (const ch of c.changes) {
      console.log(
        `            ${ch.field}: ${c.action === "create" ? short(ch.to) : `${short(ch.from)} → ${short(ch.to)}`}`,
      );
    }
  }

  console.log("\nCLIENT");
  if (!client.profile.length && !client.colors && !client.brandingFill.length) {
    console.log("  (no client-document changes)");
  }
  for (const p of client.profile) console.log(`  FILL    ${p.field}: ${short(p.from)} → ${short(p.to)}`);
  for (const s of client.skippedProfile) console.log(`  skip    ${s.field} — ${s.reason}`);
  for (const b of client.brandingFill) console.log(`  FILL    brandingGuidelines.${b.field}: ${short(b.to)}`);
  if (client.colors) {
    const fmt = (arr: Row[]) =>
      arr.length ? arr.map((c) => `${String(c.hex)}${c.usagePct != null ? ` ${String(c.usagePct)}%` : ""}`).join(" · ") : "(none)";
    console.log(`  COLORS  ${fmt(client.colors.from)}`);
    console.log(`       →  ${fmt(client.colors.to)}`);
  }
}

/* ── Main ────────────────────────────────────────────────────────────── */

async function main() {
  const argv = process.argv.slice(2);
  const flag = (name: string): string | undefined => {
    const hit = argv.find((a) => a.startsWith(`--${name}=`));
    return hit ? hit.slice(name.length + 3) : undefined;
  };
  const apply = argv.includes("--apply");
  const fileArg = flag("file") ?? argv.find((a) => !a.startsWith("--"));
  const clientArg = flag("client");

  if (!fileArg || !clientArg) {
    console.error(
      "Usage:\n" +
        "  npx tsx scripts/refresh-apply.ts --file=<proposal.json> --client=<clientId> [--apply]\n\n" +
        "--client is mandatory and must match the proposal's clientId — one client per invocation.",
    );
    process.exit(1);
    return;
  }

  const proposalPath = path.resolve(process.cwd(), fileArg);
  let proposal: unknown;
  try {
    proposal = JSON.parse(readFileSync(proposalPath, "utf8"));
  } catch (e) {
    console.error(`Could not read/parse ${proposalPath}: ${String(e)}`);
    process.exit(1);
    return;
  }
  if (!isPlainObject(proposal)) throw new ProposalError("The proposal must be a JSON object.");

  rejectUnknownKeys("<root>", proposal, PROPOSAL_KEYS);
  if (proposal.schemaVersion !== 1) fail("schemaVersion", `expected 1, got ${JSON.stringify(proposal.schemaVersion)}`);
  if (proposal.clientId !== clientArg) {
    fail("clientId", `proposal targets "${String(proposal.clientId)}" but --client=${clientArg} was passed`);
  }
  if (!isPlainObject(proposal.client) && proposal.client !== undefined) fail("client", "expected an object");

  loadEnv();
  const { initializeApp, cert } = await import("firebase-admin/app");
  const { getFirestore } = await import("firebase-admin/firestore");
  initializeApp({ credential: cert(JSON.parse(process.env.FIREBASE_SERVICE_ACCOUNT_KEY!)) });
  const db = getFirestore();

  const clientRef = db.collection("clients").doc(clientArg);
  const clientSnap = await clientRef.get();
  if (!clientSnap.exists) {
    console.error(`No client with id ${clientArg}.`);
    process.exit(1);
    return;
  }
  const storedClient = clientSnap.data() as Row;
  const clientName = String(storedClient.name ?? clientArg);

  // Name cross-check: the cheapest guard against applying the wrong file.
  if (typeof proposal.clientName === "string" && proposal.clientName.trim() !== clientName) {
    fail(
      "clientName",
      `proposal says "${proposal.clientName}" but ${clientArg} is "${clientName}" — refusing to cross-apply`,
    );
  }

  const [docsSnap, compSnap] = await Promise.all([
    db.collection("clientContextDocs").where("clientId", "==", clientArg).get(),
    db.collection("clientCompetitors").where("clientId", "==", clientArg).get(),
  ]);

  const storedDocs = new Map<string, Row>();
  for (const d of docsSnap.docs) {
    const v = d.data() as Row;
    storedDocs.set(`${String(v.docType)}@${String(v.tier)}`, { id: d.id, ...v });
  }
  const storedComps: Row[] = compSnap.docs.map((d): Row => ({ id: d.id, ...(d.data() as Row) }));

  const docPlans = buildDocPlans(proposal.docs, storedDocs);
  const brandingDocContent = docContent.get("branding-guidelines@internal") ?? null;
  const compPlans = buildCompetitorPlans(proposal.competitors, storedComps);
  const clientPlan = buildClientPlan(proposal.client, storedClient, brandingDocContent);

  if (errors.length) {
    console.error(`\nPROPOSAL REJECTED — ${errors.length} problem(s):\n`);
    for (const e of errors) console.error(`  ✗ ${e}`);
    console.error("\nNothing was written. Fix the proposal and re-run.");
    process.exit(1);
    return;
  }

  printPlan(clientName, clientArg, docPlans, compPlans, clientPlan);

  const docWrites = docPlans.filter((d) => d.action !== "unchanged");
  const compWrites = compPlans.filter((c) => c.action !== "unchanged");
  const clientTouched =
    clientPlan.profile.length > 0 || clientPlan.brandingFill.length > 0 || clientPlan.colors != null;
  const totalWrites = docWrites.length + compWrites.length + (clientTouched ? 1 : 0);

  const verifyTotal = docPlans.reduce((n, d) => n + d.verifyTokens, 0);
  if (verifyTotal > 0) {
    console.log(
      `\n⚑ ${verifyTotal} [VERIFY] token(s) across internal-tier documents — every one is a claim the team ` +
        "could not confirm. They land in the internal tier only and must be resolved with Albert.",
    );
  }

  if (!totalWrites) {
    console.log("\nNo changes — the proposal matches what is already stored.");
    return;
  }

  if (!apply) {
    console.log(
      `\nDRY RUN — ${docWrites.length} document write(s), ${compWrites.length} competitor write(s), ` +
        `${clientTouched ? 1 : 0} client-document update. Re-run with --apply.`,
    );
    return;
  }

  const now = Date.now();
  const batch = db.batch();

  for (const d of docWrites) {
    const content = docContent.get(`${d.docType}@${d.tier}`);
    if (!content) throw new ProposalError(`Internal: missing validated content for ${d.docType}@${d.tier}`);
    const base: Row = {
      clientId: clientArg,
      docType: d.docType,
      tier: d.tier,
      content,
      version: d.toVersion,
      updatedAt: now,
      // A rewritten body invalidates the cached executive summary.
      summary: null,
      summaryVersion: null,
      ...(d.sources ? { sources: d.sources } : {}),
    };
    if (d.action === "create") {
      batch.set(db.collection("clientContextDocs").doc(), { ...base, createdAt: now });
    } else {
      batch.set(db.collection("clientContextDocs").doc(d.docId!), base, { merge: true });
    }
  }

  for (const c of compWrites) {
    if (c.action === "create") {
      batch.set(db.collection("clientCompetitors").doc(), {
        clientId: clientArg,
        company: c.data.company,
        url: c.data.url,
        marketTier: c.data.marketTier ?? "Other",
        overlap: c.data.overlap ?? "Medium",
        deepDive: c.data.deepDive ?? false,
        keyStrengths: c.data.keyStrengths ?? [],
        keyWeaknesses: c.data.keyWeaknesses ?? [],
        ...(c.data.founded ? { founded: c.data.founded } : {}),
        ...(c.data.minInvestment ? { minInvestment: c.data.minInvestment } : {}),
        ...(c.data.positioning ? { positioning: c.data.positioning } : {}),
        ...(c.data.scale ? { scale: c.data.scale } : {}),
        ...(c.data.threatLevel ? { threatLevel: c.data.threatLevel } : {}),
        source: "manual",
        createdAt: now,
        updatedAt: now,
      });
    } else {
      batch.set(db.collection("clientCompetitors").doc(c.id!), { ...c.data, updatedAt: now }, { merge: true });
    }
  }

  if (clientTouched) {
    const patch: Row = { updatedAt: now };
    for (const p of clientPlan.profile) patch[p.field] = p.to;
    if (clientPlan.colors || clientPlan.brandingFill.length) {
      const storedBg = isPlainObject(storedClient.brandingGuidelines) ? storedClient.brandingGuidelines : {};
      const bg: Row = { ...storedBg };
      for (const b of clientPlan.brandingFill) bg[b.field] = b.to;
      if (clientPlan.colors) {
        const to = clientPlan.colors.to;
        bg.dominantColors = to;
        // Legacy scalars mirror dominantColors[0..3].hex — src/lib/branding.ts:762-765.
        bg.primaryAccent = to[0]?.hex;
        bg.secondaryAccent = to[1]?.hex;
        bg.brandNeutralDark = to[2]?.hex;
        bg.brandNeutralLight = to[3]?.hex ?? null;
      }
      bg.updatedAt = now;
      patch.brandingGuidelines = bg;
    }
    batch.set(clientRef, patch, { merge: true });
  }

  await batch.commit();

  console.log(
    `\nAPPLIED — ${docWrites.length} document(s), ${compWrites.length} competitor row(s), ` +
      `${clientTouched ? 1 : 0} client document. Committed atomically at ${new Date(now).toISOString()}.`,
  );
  console.log("Review on localhost now — the portal reads the same Firestore this just wrote.");
}

if (require.main === module) {
  main().catch((e) => {
    console.error(e instanceof ProposalError ? `PROPOSAL REJECTED: ${e.message}` : e);
    process.exit(1);
  });
}
