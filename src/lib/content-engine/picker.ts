/**
 * Topic picker — faithful TypeScript port of the karos-labs engine
 * `scripts/produce_next.py:pick_next`.
 *
 * PRESERVED behavior (byte-for-byte intent):
 *  - identity-fingerprint token fusion: drop the format prefix, pure-digit
 *    tokens (years), stopwords, and ≤3-char tokens; what's left is the
 *    distinctive subject — any overlap with a recent entry = the same subject.
 *  - subject cooldown over the last N ledger entries.
 *  - format rotation off the last-used format (bypassed when scoped to a format,
 *    since every candidate then shares the format).
 *  - rank by viability desc → confidence → key asc; never re-pick a used key.
 *
 * Pure module — no I/O. The caller supplies the catalog + ledger + selection
 * config (loaded from Firestore in run.ts, or from disk in the seed script).
 */
import type { CatalogEntry, LedgerEntry, PickResult, SelectionConfig } from "./types";

const CONFIDENCE_RANK: Record<string, number> = { confirmed: 0, likely: 1, needs_research: 2 };

/** Matches `_DEFAULT_STOPWORDS` in produce_next.py. */
const DEFAULT_STOPWORDS = new Set([
  "the", "and", "of", "in", "on", "at", "to", "a", "an", "as", "is", "it",
  "for", "with", "by", "no", "not", "or", "but", "first", "last", "new",
  "big", "one", "two", "six", "all", "same", "side", "story", "night", "set",
]);

/**
 * Identity fingerprint of a subject key: drop the format prefix, pure-digit
 * tokens, stopwords, and tokens ≤3 chars. Mirrors `_subject_tokens`.
 */
function subjectTokens(subjectKey: string, stopwords: Set<string>): Set<string> {
  let parts = subjectKey.split("-");
  if (parts.length > 1) parts = parts.slice(1); // drop the format prefix
  const keep: string[] = [];
  for (const p of parts) {
    if (/^\d+$/.test(p)) continue;
    if (stopwords.has(p)) continue;
    if (p.length <= 3) continue;
    keep.push(p);
  }
  return new Set(keep);
}

export interface PickOptions {
  /** Skip the first N eligible (the "alternate" pick). */
  skip?: number;
  /** Scope to ONE format (a per-format sub-skill); bypasses format rotation. */
  format?: string | null;
}

/**
 * Pick the next topic. Returns null when nothing is eligible (catalog exhausted
 * for the cooldown window / format scope) — mirrors produce_next.py's
 * "no eligible entries left".
 */
export function pickNext(
  catalog: CatalogEntry[],
  ledger: LedgerEntry[],
  selection: SelectionConfig,
  opts: PickOptions = {},
): PickResult | null {
  const skip = opts.skip ?? 0;
  const fmt = opts.format ?? null;
  // Mirror produce_next.py's config defaults for partial/legacy Firestore docs
  // (the seed always writes these, but configs are read with an unchecked cast,
  // and an undefined threshold would silently disable the cooldown dedupe).
  const rotate = selection.rotateFormats ?? true;
  const cooldown = Number.isFinite(selection.subjectCooldown) ? selection.subjectCooldown : 50;
  const minOverlap = Number.isFinite(selection.minSharedTokens) ? selection.minSharedTokens : 1;
  const stopwords = selection.stopwords?.length ? new Set(selection.stopwords) : DEFAULT_STOPWORDS;

  const usedKeys = new Set(ledger.map((e) => e.subjectKey));
  const lastFormat = ledger.length ? ledger[ledger.length - 1].format : null;
  // Python slices `ledger[-cooldown:]`: cooldown 0 → the WHOLE ledger (everything
  // seen is cooled down); negative → the matching tail. Emulate exactly rather
  // than a clamped window, which would invert the cooldown==0 case.
  const recent =
    cooldown < 0
      ? ledger.slice(-cooldown)
      : cooldown === 0
        ? ledger.slice(0)
        : ledger.slice(Math.max(0, ledger.length - cooldown));
  const recentTokenSets = recent.map((e) => subjectTokens(e.subjectKey, stopwords));

  const eligible = (p: CatalogEntry): boolean => {
    const key = String(p.k);
    const pfmt = p.f;
    // When scoped to a format, ONLY that format is eligible AND rotation is
    // bypassed (every candidate shares the format).
    if (fmt !== null && String(pfmt) !== String(fmt)) return false;
    if (usedKeys.has(key)) return false;
    if (rotate && fmt === null && pfmt === lastFormat) return false;
    const tokens = subjectTokens(key, stopwords);
    for (const ts of recentTokenSets) {
      let overlap = 0;
      for (const t of tokens) if (ts.has(t)) overlap++;
      if (overlap >= minOverlap) return false;
    }
    return true;
  };

  const candidates = catalog.filter(eligible);
  candidates.sort((a, b) => {
    const av = Number(a.v ?? 0) || 0;
    const bv = Number(b.v ?? 0) || 0;
    if (bv !== av) return bv - av; // viability desc
    const ac = CONFIDENCE_RANK[String(a.c ?? "")] ?? 9;
    const bc = CONFIDENCE_RANK[String(b.c ?? "")] ?? 9;
    if (ac !== bc) return ac - bc; // confidence rank asc
    const ak = String(a.k);
    const bk = String(b.k);
    // key asc — UTF-16 order; matches Python's codepoint order for the ASCII/BMP
    // hyphenated keys this engine uses (diverges only for astral-plane chars).
    return ak < bk ? -1 : ak > bk ? 1 : 0;
  });

  if (skip >= candidates.length) return null;
  const entry = candidates[skip];
  return {
    entry,
    nextVol: ledger.length + 1,
    subjectKey: String(entry.k),
    displayName: String(entry.n ?? entry.k),
    format: String(entry.f),
    viability: Number(entry.v ?? 0) || 0,
    confidence: String(entry.c ?? ""),
  };
}
