/**
 * Competitor quick-add input parsing — pure + client-safe.
 *
 * Users paste whatever identifies the rival: a name ("Whop"), a domain
 * ("speedrun.a16z.com"), or a full URL ("https://speedrun.a16z.com/…").
 * Storing a pasted URL as the display name used to create the classic
 * duplicate: an ugly raw-URL manual row (no favicon) PLUS the AI-resolved
 * "Speedrun by a16z" report row. Parsing up front gives the manual row a real
 * `url` (favicon renders immediately, brand-key matching works), and the
 * URL-ish company name is later replaced by the analysis's canonical name via
 * the manual-merge in replaceReportCompetitors.
 */

import { brandKeys } from "@/lib/seo-geo";

/** True when the input reads as a URL/domain rather than a company name. */
export function looksLikeUrlInput(raw: string): boolean {
  const s = raw.trim();
  if (!s || /\s/.test(s)) return false;
  if (/^https?:\/\//i.test(s)) return true;
  // Bare domain (optionally with a path): at least one dot-separated label + TLD.
  return /^([a-z0-9-]+\.)+[a-z]{2,}(\/\S*)?$/i.test(s);
}

/**
 * Normalize a quick-add input into { company, url }. URL-ish input keeps the
 * hostname as a provisional display name (never a guessed brand — the AI
 * analysis supplies the canonical name), with `url` set so the favicon and
 * identity keys work from the first render.
 */
export function parseCompetitorInput(raw: string): { company: string; url?: string } {
  const s = raw.trim();
  if (!looksLikeUrlInput(s)) return { company: s };
  try {
    const host = new URL(s.includes("://") ? s : `https://${s}`).hostname
      .toLowerCase()
      .replace(/^www\./, "");
    if (!host.includes(".")) return { company: s };
    return { company: host, url: host };
  } catch {
    return { company: s };
  }
}

/**
 * Identity keys for a stored competitor row, tolerating LEGACY rows whose
 * company is a raw pasted URL with no `url` field (pre-parse quick-adds).
 * Without this, "https://speedrun.a16z.com" keys as gibberish and never merges
 * with its resolved "Speedrun by a16z" twin. Use this — not brandKeys directly —
 * anywhere competitor ROWS are matched against each other.
 */
export function competitorBrandKeys(company: string, url?: string): string[] {
  if (!url && looksLikeUrlInput(company)) {
    const parsed = parseCompetitorInput(company);
    return brandKeys(parsed.company, parsed.url);
  }
  return brandKeys(company, url);
}
