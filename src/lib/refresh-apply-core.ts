/**
 * The refresh proposal safety boundary — validation, plan, and write shapes.
 *
 * Extracted verbatim from scripts/refresh-apply.ts (CD-G7) so the CLI and the
 * admin Ops Import page share ONE implementation. Every rule below used to live
 * in that script; the script is now a thin adapter over this module. If a check
 * belongs anywhere, it belongs here — a second copy is how a fence rots.
 *
 * PURE ON PURPOSE. No firebase, no `server-only`, no fs, no process. The caller
 * supplies the stored state (`CurrentState`) and commits the returned
 * `WriteOp[]`. That is what lets a CLI run under tsx and a server action under
 * Next share the same fences, and what makes the fences unit-testable without
 * a Firestore.
 *
 * COMPLETION SEMANTICS — enforced here, not merely documented:
 *   · Nothing is ever deleted. This file emits no delete op, and the proposal
 *     schema has no way to express one.
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
 * Schema: docs/qa-sweep-2026-07/refresh/BRIEF-TEMPLATE.md
 */

export type Row = Record<string, unknown>;

/* ── Canonical shapes ────────────────────────────────────────────────── */

/** Written at tier "internal" AND condensed to tier "client" (pipeline.ts:885). */
export const PUBLIC_DOC_TYPES = [
  "brand-voice",
  "market-strategy",
  "competitor-analysis",
  "product-information",
  "branding-guidelines",
  "target-audience",
] as const;

/** Never published — tier "internal-only" only (pipeline.ts:893). */
export const INTERNAL_ONLY_DOC_TYPES = ["client-guidelines", "action-plan"] as const;

/**
 * Legal (docType → tier) pairs. This table IS the no-leak boundary: writing
 * client-guidelines or action-plan at tier "client" would publish an internal
 * document to the client portal. "meeting-notes" is absent on purpose — it is
 * written exclusively by the transcript ingest and is not a refresh target.
 */
export const LEGAL_TIERS: Record<string, readonly string[]> = {
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
/** action-plan legitimately carries only "How to use this" + "Recommendations". */
const MIN_DOC_SECTIONS = 2;
const MAX_COMPETITORS = 40;

export const PROPOSAL_KEYS = [
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

/* ── Plan types ──────────────────────────────────────────────────────── */

export interface DocPlan {
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

export interface CompetitorPlan {
  action: "create" | "update" | "unchanged";
  id: string | null;
  company: string;
  changes: Array<{ field: string; from: unknown; to: unknown }>;
  data: Row;
  /**
   * Set when the proposal asked to CREATE this row but the roster already had
   * it, so the plan folded the create onto the existing row instead of
   * refusing. A proposal is written against an export taken days earlier; the
   * roster moves underneath it. Refusing the whole bundle for a row that merely
   * arrived early made a stale export a hand-editing job (Albert hit exactly
   * this on Geektime). Reconciling at plan time is the fix — and it is visible
   * in the diff, never silent.
   */
  reconciled?: { matchedBy: "name" | "url"; matchedCompany: string };
}

export interface ClientPlan {
  profile: Array<{ field: string; from: unknown; to: unknown }>;
  skippedProfile: Array<{ field: string; reason: string }>;
  colors: { from: Row[]; to: Row[] } | null;
  brandingFill: Array<{ field: string; to: unknown }>;
  /** Snapshot of the stored brandingGuidelines, so apply() needs no re-read. */
  storedBranding: Row;
}

/** The stored state a proposal is validated against. Supplied by the caller. */
export interface CurrentState {
  clientId: string;
  /** The client's stored `name`, for the cross-apply guard. */
  clientName: string;
  /** The stored client document (profile + brandingGuidelines). */
  client: Row;
  /** Stored context docs keyed `docType@tier`, each carrying its `id`. */
  docs: Map<string, Row>;
  /** Stored competitor rows, each carrying its `id`. */
  competitors: Row[];
}

export interface RefreshPlan {
  clientId: string;
  clientName: string;
  docs: DocPlan[];
  competitors: CompetitorPlan[];
  client: ClientPlan;
  /** Validated markdown bodies keyed `docType@tier`. Only these are ever written. */
  docContent: Record<string, string>;
  warnings: string[];
  /** Everything the confirm copy and the result panel need, pre-counted. */
  counts: {
    docWrites: number;
    compWrites: number;
    clientTouched: boolean;
    verifyTotal: number;
    totalWrites: number;
  };
}

export type ValidateResult =
  | { ok: true; plan: RefreshPlan }
  | { ok: false; errors: string[] };

/* ── Validation plumbing ─────────────────────────────────────────────── */

/** Per-call accumulator. Module-level state would leak between clients. */
interface Ctx {
  errors: string[];
  warnings: string[];
  docContent: Map<string, string>;
}

function isPlainObject(v: unknown): v is Row {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

function fail(ctx: Ctx, where: string, msg: string): void {
  ctx.errors.push(`${where}: ${msg}`);
}

/** House-style deviations that are worth a human's eye but must not block a write. */
function warn(ctx: Ctx, where: string, msg: string): void {
  ctx.warnings.push(`${where}: ${msg}`);
}

function rejectUnknownKeys(ctx: Ctx, where: string, obj: Row, allowed: readonly string[]): void {
  for (const k of Object.keys(obj)) {
    if (!allowed.includes(k)) fail(ctx, where, `unknown key "${k}" (allowed: ${allowed.join(", ")})`);
  }
}

function requireString(
  ctx: Ctx,
  where: string,
  v: unknown,
  opts: { min?: number; max?: number } = {},
): string | null {
  if (typeof v !== "string") {
    fail(ctx, where, `expected a string, got ${Array.isArray(v) ? "array" : typeof v}`);
    return null;
  }
  const s = v.trim();
  if (s.length < (opts.min ?? 1)) {
    fail(ctx, where, `blank or too short (min ${opts.min ?? 1} chars) — a refresh never blanks a field`);
    return null;
  }
  if (opts.max && s.length > opts.max) {
    fail(ctx, where, `too long (${s.length} > ${opts.max})`);
    return null;
  }
  return s;
}

function requireStringArray(ctx: Ctx, where: string, v: unknown, max = 40): string[] | null {
  if (!Array.isArray(v)) {
    fail(ctx, where, "expected an array of strings");
    return null;
  }
  if (v.length > max) {
    fail(ctx, where, `too many entries (${v.length} > ${max})`);
    return null;
  }
  const out: string[] = [];
  v.forEach((entry, i) => {
    const s = requireString(ctx, `${where}[${i}]`, entry, { max: 400 });
    if (s) out.push(s);
  });
  return out;
}

/** Bare lowercase host, matching what parseCompetitorInput stores (competitor-input.ts:35). */
function normalizeDomain(ctx: Ctx, where: string, raw: unknown): string | null {
  const s = requireString(ctx, where, raw, { max: 253 });
  if (!s) return null;
  let host: string;
  try {
    host = new URL(s.includes("://") ? s : `https://${s}`).hostname.toLowerCase().replace(/^www\./, "");
  } catch {
    fail(ctx, where, `"${s}" is not a parseable domain or URL`);
    return null;
  }
  if (!/^([a-z0-9](?:[a-z0-9-]*[a-z0-9])?\.)+[a-z]{2,24}$/.test(host)) {
    fail(ctx, where, `"${s}" does not resolve to a real hostname — a competitor row needs a working domain`);
    return null;
  }
  return host;
}

function checkBannedPlaceholders(ctx: Ctx, where: string, content: string): void {
  const lower = content.toLowerCase();
  for (const p of BANNED_PLACEHOLDERS) {
    if (lower.includes(p)) {
      fail(ctx, where, `contains the banned placeholder "${p}" — the pipeline forbids it in any rendered document`);
    }
  }
}

function sectionCount(md: string): number {
  return (md.match(/^## /gm) ?? []).length;
}

/* ── Proposal validation + plan build ────────────────────────────────── */

function buildDocPlans(ctx: Ctx, raw: unknown, stored: Map<string, Row>): DocPlan[] {
  if (raw === undefined) return [];
  if (!Array.isArray(raw)) {
    fail(ctx, "docs", "expected an array");
    return [];
  }
  const plans: DocPlan[] = [];
  const seen = new Set<string>();

  raw.forEach((entry, i) => {
    const where = `docs[${i}]`;
    if (!isPlainObject(entry)) return fail(ctx, where, "expected an object");
    rejectUnknownKeys(ctx, where, entry, ["docType", "tier", "content", "sources", "shrinkApproved"]);

    const docType = requireString(ctx, `${where}.docType`, entry.docType);
    const tier = requireString(ctx, `${where}.tier`, entry.tier);
    if (!docType || !tier) return;

    const legal = LEGAL_TIERS[docType];
    if (!legal) {
      return fail(
        ctx,
        `${where}.docType`,
        `"${docType}" is not a refreshable document type (allowed: ${Object.keys(LEGAL_TIERS).join(", ")})`,
      );
    }
    if (!legal.includes(tier)) {
      return fail(
        ctx,
        `${where}.tier`,
        `"${docType}" may only be written at tier ${legal.map((t) => `"${t}"`).join(" or ")} — ` +
          `"${tier}" would breach the no-leak boundary`,
      );
    }

    const key = `${docType}@${tier}`;
    if (seen.has(key)) return fail(ctx, where, `duplicate entry for ${key}`);
    seen.add(key);

    const content = requireString(ctx, `${where}.content`, entry.content, { min: MIN_DOC_CHARS });
    if (!content) return;
    ctx.docContent.set(key, content);

    if (!content.startsWith("---")) {
      fail(ctx, `${where}.content`, "must begin with the YAML frontmatter `---` (pipeline.ts:522)");
    }
    const sections = sectionCount(content);
    if (sections < MIN_DOC_SECTIONS) {
      fail(ctx, `${where}.content`, `only ${sections} \`## \` sections — a pipeline document has many more`);
    }
    checkBannedPlaceholders(ctx, `${where}.content`, content);
    // Not fatal — some lab-imported documents predate these rules, and refusing
    // the write would leave them frozen. Flag them for the reviewer instead.
    if (/^## Change Log\s*$/m.test(content)) {
      warn(ctx, `${where}.content`, "carries a `## Change Log` section; the pipeline drops it (pipeline.ts:527)");
    }
    if (/\n---\n/.test(content.replace(/^---[\s\S]*?\n---\n/, ""))) {
      warn(ctx, `${where}.content`, "uses `---` horizontal rules in the body; the pipeline uses blank lines (pipeline.ts:526)");
    }

    const verifyTokens = (content.match(/\[VERIFY\]/g) ?? []).length;
    if (tier === "client" && verifyTokens > 0) {
      fail(
        ctx,
        `${where}.content`,
        `${verifyTokens} [VERIFY] token(s) at tier "client" — unverified markers must never reach the client portal. ` +
          "Resolve them, or keep the claim in the internal tier only.",
      );
    }

    let sources: string[] | null = null;
    if (entry.sources !== undefined) sources = requireStringArray(ctx, `${where}.sources`, entry.sources, 200);

    let shrinkApproved: string | null = null;
    if (entry.shrinkApproved !== undefined) {
      shrinkApproved = requireString(ctx, `${where}.shrinkApproved`, entry.shrinkApproved, { min: 20, max: 500 });
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
        ctx,
        `${where}.content`,
        `drops ${prevSections - sections} section(s) (${prevSections} → ${sections}). ` +
          "A completion pass never removes a section.",
      );
    }
    const floor = shrinkApproved ? SHRINK_FLOOR_APPROVED : SHRINK_FLOOR;
    if (prev.length > 0 && content.length < prev.length * floor) {
      fail(
        ctx,
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

function buildCompetitorPlans(ctx: Ctx, raw: unknown, stored: Row[]): CompetitorPlan[] {
  if (raw === undefined) return [];
  if (!isPlainObject(raw)) {
    fail(ctx, "competitors", "expected an object with optional `update` and `create` arrays");
    return [];
  }
  rejectUnknownKeys(ctx, "competitors", raw, ["update", "create"]);

  const byId = new Map(stored.map((c) => [String(c.id), c]));
  const plans: CompetitorPlan[] = [];

  const readFields = (where: string, entry: Row, existing: Row | null): Row => {
    const out: Row = {};
    for (const f of COMPETITOR_FIELDS) {
      const v = entry[f];
      if (v === undefined) continue;
      const w = `${where}.${f}`;
      if (f === "url") {
        const host = normalizeDomain(ctx, w, v);
        if (host) out.url = host;
      } else if (f === "deepDive") {
        if (typeof v !== "boolean") fail(ctx, w, "expected a boolean");
        else out.deepDive = v;
      } else if (f === "marketTier") {
        if (!MARKET_TIERS.includes(v as (typeof MARKET_TIERS)[number])) fail(ctx, w, `expected one of ${MARKET_TIERS.join(" | ")}`);
        else out.marketTier = v;
      } else if (f === "overlap") {
        if (!OVERLAPS.includes(v as (typeof OVERLAPS)[number])) fail(ctx, w, `expected one of ${OVERLAPS.join(" | ")}`);
        else out.overlap = v;
      } else if (f === "threatLevel") {
        if (!THREAT_LEVELS.includes(v as (typeof THREAT_LEVELS)[number])) fail(ctx, w, `expected one of ${THREAT_LEVELS.join(" | ")}`);
        else out.threatLevel = v;
      } else if (f === "keyStrengths" || f === "keyWeaknesses") {
        const arr = requireStringArray(ctx, w, v, 12);
        if (arr) {
          const prevArr = Array.isArray(existing?.[f]) ? (existing[f] as unknown[]) : [];
          if (arr.length === 0 && prevArr.length > 0) {
            fail(ctx, w, `would empty a list that currently holds ${prevArr.length} entries — a refresh never blanks data`);
          } else {
            out[f] = arr;
          }
        }
      } else {
        const s = requireString(ctx, w, v, { max: 2000 });
        if (s) out[f] = s;
      }
    }
    return out;
  };

  if (raw.update !== undefined) {
    if (!Array.isArray(raw.update)) fail(ctx, "competitors.update", "expected an array");
    else
      raw.update.forEach((entry, i) => {
        const where = `competitors.update[${i}]`;
        if (!isPlainObject(entry)) return fail(ctx, where, "expected an object");
        rejectUnknownKeys(ctx, where, entry, ["id", ...COMPETITOR_FIELDS]);

        const id = requireString(ctx, `${where}.id`, entry.id);
        if (!id) return;
        const existing = byId.get(id);
        if (!existing) {
          return fail(
            ctx,
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
    if (!Array.isArray(raw.create)) fail(ctx, "competitors.create", "expected an array");
    else
      raw.create.forEach((entry, i) => {
        const where = `competitors.create[${i}]`;
        if (!isPlainObject(entry)) return fail(ctx, where, "expected an object");
        rejectUnknownKeys(ctx, where, entry, COMPETITOR_FIELDS);

        const data = readFields(where, entry, null);
        if (typeof data.company !== "string") fail(ctx, `${where}.company`, "required on a new competitor row");
        if (typeof data.url !== "string") {
          fail(ctx, `${where}.url`, "required on a new competitor row — a row without a working domain renders as a generic glyph");
        }
        if (typeof data.company !== "string" || typeof data.url !== "string") return;

        const nameKey = data.company.trim().toLowerCase();
        const sameName = (c: Row) => String(c.company ?? "").trim().toLowerCase() === nameKey;
        const sameUrl = (c: Row) =>
          typeof c.url === "string" && c.url.toLowerCase().replace(/^www\./, "") === data.url;
        const matches = stored.filter((c) => sameName(c) || sameUrl(c));
        // Name is the stronger signal: it is what a human recognises the row by.
        const matchedByName = matches.length === 1 && sameName(matches[0]!);
        const dupeInBatch = plans.find((p) => String(p.data.url) === data.url);
        if (dupeInBatch) return fail(ctx, where, `duplicates ${String(dupeInBatch.data.url)} earlier in this proposal`);

        // The roster moves under a proposal written days earlier, so a "create"
        // for a row that has since arrived is a stale export, not an error.
        // Fold it onto the existing row rather than refusing the whole bundle.
        if (matches.length > 1) {
          return fail(
            ctx,
            where,
            `matches ${matches.length} existing rows (${matches.map((m) => `"${String(m.company)}"`).join(", ")}) — ` +
              "which one it means is ambiguous, so put it in `update` with the right row's id",
          );
        }
        if (matches.length === 1) {
          const match = matches[0]!;
          const id = String(match.id);
          if (plans.some((p) => p.id === id)) {
            return fail(
              ctx,
              where,
              `resolves to the existing row "${String(match.company)}", which this proposal already updates — ` +
                "merge the two entries",
            );
          }

          // readFields ran with no `existing`, so the never-blank-a-list rule
          // was not applied. Now that we know which row this is, apply it.
          const merged: Row = { ...data };
          for (const f of ["keyStrengths", "keyWeaknesses"] as const) {
            const next = merged[f];
            const prev = match[f];
            if (Array.isArray(next) && next.length === 0 && Array.isArray(prev) && prev.length > 0) {
              fail(ctx, `${where}.${f}`, `would empty a list that currently holds ${prev.length} entries — a refresh never blanks data`);
            }
          }
          // `company` was the join key when it matched by name, and renaming a
          // roster row on the strength of a URL match is not this pass's call.
          delete merged.company;

          const changes = Object.entries(merged)
            .filter(([k, v]) => JSON.stringify(match[k]) !== JSON.stringify(v))
            .map(([field, to]) => ({ field, from: match[field], to }));

          plans.push({
            action: changes.length ? "update" : "unchanged",
            id,
            company: String(match.company ?? id),
            changes,
            data: merged,
            reconciled: { matchedBy: matchedByName ? "name" : "url", matchedCompany: String(match.company ?? id) },
          });
          return;
        }

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
    fail(ctx, "competitors.create", `would take the roster to ${finalCount} rows (cap ${MAX_COMPETITORS})`);
  }

  return plans;
}

function buildClientPlan(ctx: Ctx, raw: unknown, stored: Row, colorDocSupplied: string | null): ClientPlan {
  const storedBranding = isPlainObject(stored.brandingGuidelines) ? stored.brandingGuidelines : {};
  const plan: ClientPlan = {
    profile: [],
    skippedProfile: [],
    colors: null,
    brandingFill: [],
    storedBranding,
  };
  if (raw === undefined) return plan;
  if (!isPlainObject(raw)) {
    fail(ctx, "client", "expected an object");
    return plan;
  }
  rejectUnknownKeys(ctx, "client", raw, ["profile", "brandingGuidelines"]);

  const isEmpty = (v: unknown) =>
    v === undefined || v === null || (typeof v === "string" && v.trim() === "") ||
    (Array.isArray(v) && v.length === 0) || (isPlainObject(v) && Object.keys(v).length === 0);

  if (raw.profile !== undefined) {
    if (!isPlainObject(raw.profile)) fail(ctx, "client.profile", "expected an object");
    else {
      rejectUnknownKeys(ctx, "client.profile", raw.profile, [...PROFILE_FILL_FIELDS, "socialLinks"]);
      for (const f of PROFILE_FILL_FIELDS) {
        const v = raw.profile[f];
        if (v === undefined) continue;
        const s = requireString(ctx, `client.profile.${f}`, v, { max: 4000 });
        if (!s) continue;
        if (!isEmpty(stored[f])) {
          plan.skippedProfile.push({ field: f, reason: `already set to ${JSON.stringify(stored[f])} — fill-only field` });
          continue;
        }
        plan.profile.push({ field: f, from: stored[f], to: s });
      }
      if (raw.profile.socialLinks !== undefined) {
        const sl = raw.profile.socialLinks;
        if (!isPlainObject(sl)) fail(ctx, "client.profile.socialLinks", "expected an object");
        else {
          rejectUnknownKeys(ctx, "client.profile.socialLinks", sl, SOCIAL_LINK_KEYS);
          const storedLinks = isPlainObject(stored.socialLinks) ? stored.socialLinks : {};
          const merged: Row = { ...storedLinks };
          let touched = false;
          for (const k of SOCIAL_LINK_KEYS) {
            const v = sl[k];
            if (v === undefined) continue;
            const s = requireString(ctx, `client.profile.socialLinks.${k}`, v, { max: 500 });
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
      fail(ctx, "client.brandingGuidelines", "expected an object");
      return plan;
    }
    rejectUnknownKeys(ctx, "client.brandingGuidelines", bg, [...BRANDING_FILL_FIELDS, "dominantColors", "toneKeywords"]);
    const storedBg = storedBranding;

    if (bg.dominantColors !== undefined) {
      const colors = bg.dominantColors;
      if (!Array.isArray(colors)) fail(ctx, "client.brandingGuidelines.dominantColors", "expected an array");
      else if (colors.length < 3 || colors.length > 4) {
        fail(
          ctx,
          "client.brandingGuidelines.dominantColors",
          `expected 3 or 4 colors (CD-E2), got ${colors.length}`,
        );
      } else {
        const out: Row[] = [];
        const hexes = new Set<string>();
        let pctTotal = 0;
        colors.forEach((c, i) => {
          const where = `client.brandingGuidelines.dominantColors[${i}]`;
          if (!isPlainObject(c)) return fail(ctx, where, "expected an object");
          rejectUnknownKeys(ctx, where, c, ["hex", "dominanceRank", "role", "usagePct"]);
          const hex = typeof c.hex === "string" ? c.hex.trim().toLowerCase() : "";
          if (!/^#[0-9a-f]{6}$/.test(hex)) {
            fail(ctx, `${where}.hex`, `expected a 6-digit lowercase hex like "#e91e8c", got ${JSON.stringify(c.hex)}`);
          } else if (hexes.has(hex)) {
            fail(ctx, `${where}.hex`, `duplicate color ${hex}`);
          } else {
            hexes.add(hex);
          }
          if (c.dominanceRank !== i + 1) {
            fail(ctx, `${where}.dominanceRank`, `expected ${i + 1} (array order IS dominance order), got ${JSON.stringify(c.dominanceRank)}`);
          }
          const pct = c.usagePct;
          if (typeof pct !== "number" || !Number.isInteger(pct) || pct < 0 || pct > 100) {
            fail(ctx, `${where}.usagePct`, `expected an integer 0-100, got ${JSON.stringify(pct)}`);
          } else {
            pctTotal += pct;
          }
          let role: string | undefined;
          if (c.role !== undefined) {
            const r = requireString(ctx, `${where}.role`, c.role, { max: 60 });
            if (r) role = r;
          }
          out.push({ hex, dominanceRank: i + 1, ...(role ? { role } : {}), usagePct: pct });
        });
        if (out.length === colors.length && pctTotal !== 100) {
          fail(
            ctx,
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
              ctx,
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
                ctx,
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
      const s = requireString(ctx, `client.brandingGuidelines.${f}`, v, { max: 20000 });
      if (!s) continue;
      if (!isEmpty(storedBg[f])) continue;
      plan.brandingFill.push({ field: f, to: s });
    }
    if (bg.toneKeywords !== undefined) {
      const arr = requireStringArray(ctx, "client.brandingGuidelines.toneKeywords", bg.toneKeywords, 12);
      if (arr && isEmpty(storedBg.toneKeywords)) plan.brandingFill.push({ field: "toneKeywords", to: arr });
    }
  }

  return plan;
}

/* ── Public entry point ──────────────────────────────────────────────── */

/**
 * Validate a proposal against the stored state and produce the plan.
 *
 * Returns every problem at once (not the first) so a reviewer fixes the file in
 * one pass. `ok: false` means NOTHING may be written — the caller must not
 * partially apply. Error order mirrors the original script exactly: root keys,
 * schemaVersion, clientId, client-shape, clientName, then docs → competitors →
 * client.
 */
export function validateProposal(proposal: unknown, current: CurrentState): ValidateResult {
  const ctx: Ctx = { errors: [], warnings: [], docContent: new Map() };

  if (!isPlainObject(proposal)) {
    return { ok: false, errors: ["<root>: the proposal must be a JSON object"] };
  }

  rejectUnknownKeys(ctx, "<root>", proposal, PROPOSAL_KEYS);
  if (proposal.schemaVersion !== 1) {
    fail(ctx, "schemaVersion", `expected 1, got ${JSON.stringify(proposal.schemaVersion)}`);
  }
  if (proposal.clientId !== current.clientId) {
    fail(ctx, "clientId", `proposal targets "${String(proposal.clientId)}" but --client=${current.clientId} was passed`);
  }
  if (!isPlainObject(proposal.client) && proposal.client !== undefined) fail(ctx, "client", "expected an object");

  // Name cross-check: the cheapest guard against applying the wrong file.
  if (typeof proposal.clientName === "string" && proposal.clientName.trim() !== current.clientName) {
    fail(
      ctx,
      "clientName",
      `proposal says "${proposal.clientName}" but ${current.clientId} is "${current.clientName}" — refusing to cross-apply`,
    );
  }

  const docs = buildDocPlans(ctx, proposal.docs, current.docs);
  const brandingDocContent = ctx.docContent.get("branding-guidelines@internal") ?? null;
  const competitors = buildCompetitorPlans(ctx, proposal.competitors, current.competitors);
  const client = buildClientPlan(ctx, proposal.client, current.client, brandingDocContent);

  if (ctx.errors.length) return { ok: false, errors: ctx.errors };

  const docWrites = docs.filter((d) => d.action !== "unchanged").length;
  const compWrites = competitors.filter((c) => c.action !== "unchanged").length;
  const clientTouched = client.profile.length > 0 || client.brandingFill.length > 0 || client.colors != null;

  return {
    ok: true,
    plan: {
      clientId: current.clientId,
      clientName: current.clientName,
      docs,
      competitors,
      client,
      docContent: Object.fromEntries(ctx.docContent),
      warnings: ctx.warnings,
      counts: {
        docWrites,
        compWrites,
        clientTouched,
        verifyTotal: docs.reduce((n, d) => n + d.verifyTokens, 0),
        totalWrites: docWrites + compWrites + (clientTouched ? 1 : 0),
      },
    },
  };
}

/* ── Selection ───────────────────────────────────────────────────────── */

export type PlanItemKind = "doc" | "competitor" | "profile" | "palette";

/**
 * One tickable line in the plan. Staff import a subset — "I should be able to
 * tick if I don't want to import one of the things" — so every write in the
 * plan needs a stable identity the browser can hand back.
 */
export interface PlanItem {
  key: string;
  kind: PlanItemKind;
  label: string;
  /**
   * Items that must be ticked whenever this one is. Surfaced as a
   * disabled-with-reason tick, so a dependency is visible in the UI rather than
   * discovered as a refusal after clicking Import.
   */
  requires: string[];
  /** Why `requires` exists, in the words the tick's tooltip uses. */
  requiresReason: string | null;
}

export const docItemKey = (docType: string, tier: string) => `doc:${docType}@${tier}`;
export const competitorItemKey = (c: CompetitorPlan) => (c.id ? `comp:${c.id}` : `comp:new:${String(c.data.url)}`);
export const PROFILE_ITEM_KEY = "client:profile";
export const PALETTE_ITEM_KEY = "client:palette";

/** The palette's document twin — the one dependency in the plan. */
const BRANDING_DOC_KEY = docItemKey("branding-guidelines", "internal");

/**
 * Every write in the plan, as a tickable item. Unchanged rows are not listed:
 * there is nothing to opt out of.
 */
export function planItems(plan: RefreshPlan): PlanItem[] {
  const items: PlanItem[] = [];

  for (const d of plan.docs) {
    if (d.action === "unchanged") continue;
    items.push({
      key: docItemKey(d.docType, d.tier),
      kind: "doc",
      label: `${d.docType} · ${d.tier}`,
      requires: [],
      requiresReason: null,
    });
  }

  for (const c of plan.competitors) {
    if (c.action === "unchanged") continue;
    items.push({ key: competitorItemKey(c), kind: "competitor", label: c.company, requires: [], requiresReason: null });
  }

  if (plan.client.profile.length > 0 || plan.client.brandingFill.length > 0) {
    items.push({ key: PROFILE_ITEM_KEY, kind: "profile", label: "Client profile fills", requires: [], requiresReason: null });
  }

  if (plan.client.colors) {
    // The app regenerates the branding document from the palette on save, so
    // taking the palette WITHOUT its document leaves every agent reading stale
    // hexes — the same drift the validator refuses at proposal level. Only a
    // real write counts: if the stored document already matches, it is
    // "unchanged", absent from this list, and the palette needs nothing.
    const docIsAWrite = plan.docs.some(
      (d) => d.action !== "unchanged" && docItemKey(d.docType, d.tier) === BRANDING_DOC_KEY,
    );
    items.push({
      key: PALETTE_ITEM_KEY,
      kind: "palette",
      label: "Brand palette",
      requires: docIsAWrite ? [BRANDING_DOC_KEY] : [],
      requiresReason: docIsAWrite
        ? "The app rebuilds the branding document from the palette, so the two must land together — otherwise agents read stale hex codes."
        : null,
    });
  }

  return items;
}

/**
 * Re-check a selection server-side. The UI disables the ticks that would break
 * a dependency, but the selection arrives over the wire, so the rule is
 * enforced here too — the disabled tick is the explanation, not the guarantee.
 */
export function validateSelection(plan: RefreshPlan, selected: ReadonlySet<string>): string[] {
  const errors: string[] = [];
  const items = planItems(plan);
  const byKey = new Map(items.map((i) => [i.key, i]));

  for (const key of selected) {
    if (!byKey.has(key)) errors.push(`"${key}" is not something this plan can write.`);
  }
  for (const item of items) {
    if (!selected.has(item.key)) continue;
    for (const dep of item.requires) {
      if (!selected.has(dep)) {
        errors.push(`${item.label} needs ${byKey.get(dep)?.label ?? dep} in the same import. ${item.requiresReason ?? ""}`.trim());
      }
    }
  }
  return errors;
}

/* ── Write ops ───────────────────────────────────────────────────────── */

/**
 * One Firestore write, described rather than performed. The caller commits
 * these in a single atomic batch — no op here implies a delete, and there is no
 * variant that could express one.
 */
export type WriteOp =
  | { kind: "create"; collection: "clientContextDocs" | "clientCompetitors"; data: Row }
  | { kind: "merge"; collection: "clientContextDocs" | "clientCompetitors" | "clients"; id: string; data: Row };

/**
 * Turn an approved plan into the exact writes the CLI has always performed.
 * Pure: same plan + same `now` ⇒ same ops, so the page's dry run and its apply
 * cannot disagree.
 *
 * `selected` narrows the plan to the ticked subset (see `planItems`). Omit it —
 * as the CLI does — to write everything, which is the behaviour this function
 * has always had.
 */
export function buildWriteOps(plan: RefreshPlan, now: number, selected?: ReadonlySet<string>): WriteOp[] {
  const ops: WriteOp[] = [];
  const wants = (key: string) => selected === undefined || selected.has(key);

  for (const d of plan.docs) {
    if (d.action === "unchanged") continue;
    if (!wants(docItemKey(d.docType, d.tier))) continue;
    const content = plan.docContent[`${d.docType}@${d.tier}`];
    if (content === undefined) {
      throw new Error(`Internal: missing validated content for ${d.docType}@${d.tier}`);
    }
    const base: Row = {
      clientId: plan.clientId,
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
      ops.push({ kind: "create", collection: "clientContextDocs", data: { ...base, createdAt: now } });
    } else {
      ops.push({ kind: "merge", collection: "clientContextDocs", id: d.docId!, data: base });
    }
  }

  for (const c of plan.competitors) {
    if (c.action === "unchanged") continue;
    if (!wants(competitorItemKey(c))) continue;
    if (c.action === "create") {
      ops.push({
        kind: "create",
        collection: "clientCompetitors",
        data: {
          clientId: plan.clientId,
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
        },
      });
    } else {
      ops.push({
        kind: "merge",
        collection: "clientCompetitors",
        id: c.id!,
        data: { ...c.data, updatedAt: now },
      });
    }
  }

  // The profile fills and the palette are two independent ticks that share one
  // `clients` document, so each half is resolved before the patch is built —
  // taking the palette alone must not drag an unticked profile fill along.
  const takeProfile = (plan.client.profile.length > 0 || plan.client.brandingFill.length > 0) && wants(PROFILE_ITEM_KEY);
  const takePalette = plan.client.colors != null && wants(PALETTE_ITEM_KEY);

  if (takeProfile || takePalette) {
    const patch: Row = { updatedAt: now };
    if (takeProfile) for (const p of plan.client.profile) patch[p.field] = p.to;
    if (takePalette || (takeProfile && plan.client.brandingFill.length)) {
      const bg: Row = { ...plan.client.storedBranding };
      if (takeProfile) for (const b of plan.client.brandingFill) bg[b.field] = b.to;
      if (takePalette && plan.client.colors) {
        const to = plan.client.colors.to;
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
    ops.push({ kind: "merge", collection: "clients", id: plan.clientId, data: patch });
  }

  return ops;
}

/* ── Human-readable plan ─────────────────────────────────────────────── */

function short(v: unknown, n = 60): string {
  const s = typeof v === "string" ? v : JSON.stringify(v);
  if (s === undefined) return "—";
  return s.length > n ? `${s.slice(0, n)}…` : s;
}

/**
 * The CLI's dry-run report, one array entry per original console.log call.
 * The Ops Import page renders the plan object directly instead — this exists
 * so the script's stdout did not change when the logic moved here.
 */
export function formatPlanLines(plan: RefreshPlan): string[] {
  const out: string[] = [];
  out.push(`\n═══ ${plan.clientName} (${plan.clientId}) ═══\n`);

  out.push("DOCUMENTS");
  if (!plan.docs.length) out.push("  (none in this proposal)");
  for (const d of plan.docs) {
    const tag = d.action === "create" ? "CREATE " : d.action === "update" ? "UPDATE " : "same   ";
    const delta = d.action === "create" ? `${d.toChars} chars` : `${d.fromChars} → ${d.toChars} chars`;
    const secs = d.action === "create" ? `${d.toSections} sections` : `${d.fromSections} → ${d.toSections} sections`;
    out.push(
      `  ${tag} ${d.docType}@${d.tier}  ${delta} · ${secs} · v${d.fromVersion} → v${d.toVersion}` +
        (d.verifyTokens ? `  ⚑ ${d.verifyTokens} [VERIFY]` : "") +
        (d.sources ? `  · ${d.sources.length} sources` : ""),
    );
  }

  out.push("\nCOMPETITORS");
  if (!plan.competitors.length) out.push("  (none in this proposal)");
  for (const c of plan.competitors) {
    if (c.action === "unchanged") {
      out.push(`  same    ${c.company}`);
      continue;
    }
    out.push(`  ${c.action === "create" ? "CREATE " : "UPDATE "} ${c.company}`);
    for (const ch of c.changes) {
      out.push(
        `            ${ch.field}: ${c.action === "create" ? short(ch.to) : `${short(ch.from)} → ${short(ch.to)}`}`,
      );
    }
  }

  out.push("\nCLIENT");
  const cp = plan.client;
  if (!cp.profile.length && !cp.colors && !cp.brandingFill.length) {
    out.push("  (no client-document changes)");
  }
  for (const p of cp.profile) out.push(`  FILL    ${p.field}: ${short(p.from)} → ${short(p.to)}`);
  for (const s of cp.skippedProfile) out.push(`  skip    ${s.field} — ${s.reason}`);
  for (const b of cp.brandingFill) out.push(`  FILL    brandingGuidelines.${b.field}: ${short(b.to)}`);
  if (cp.colors) {
    const fmt = (arr: Row[]) =>
      arr.length ? arr.map((c) => `${String(c.hex)}${c.usagePct != null ? ` ${String(c.usagePct)}%` : ""}`).join(" · ") : "(none)";
    out.push(`  COLORS  ${fmt(cp.colors.from)}`);
    out.push(`       →  ${fmt(cp.colors.to)}`);
  }

  return out;
}
