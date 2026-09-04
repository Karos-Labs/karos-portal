import "server-only";

import { normalizeHex } from "@/lib/branding-hex";
import type { BrandColor } from "@/lib/types";

/**
 * The colours a site ACTUALLY declares, read from its own markup and
 * stylesheets by code rather than by a model.
 *
 * ## Why this exists
 *
 * `applyBrandingForClient` asks one model to browse the site and report what it
 * saw, then asks a second to turn that report into a palette. Neither step is
 * constrained to colours that exist. On karoslabs.com it produced
 * `primaryAccent: #6366f1` — Tailwind's `indigo-500`, a value that appears
 * nowhere in that site's HTML or CSS — alongside `#dc602c` for an orange the
 * site actually declares as `#ff6b2c`. Three of the four stored scalars were
 * invented; only `#242429` was real. A client reading their own brand
 * guidelines was told their brand is blue.
 *
 * A model is genuinely good at the judgment here — which colour is the brand's
 * signature, which is the page ground — and genuinely bad at transcribing hex
 * digits. So this module does the transcription and leaves the judgment alone:
 * it collects observed colours as ground truth for the prompt, and
 * `snapToObservedPalette` afterwards repairs any hex the model still invented,
 * keeping the role it assigned.
 *
 * CSS custom properties are collected WITH THEIR NAMES because the name is
 * usually the role, stated by the people who own the brand: karoslabs.com
 * declares `--accent: #ff6b2c` and `--background: #1a1a1a`, which is the whole
 * answer. Nothing here interprets them — that stays the model's job — but a
 * prompt that can quote `--accent` beats one guessing from a screenshot.
 */

/** One colour observed on the live site, with how it was found. */
export interface ObservedColor {
  /** 6-digit lowercase hex. */
  hex: string;
  /** How many times it appeared across the fetched documents. */
  count: number;
  /** CSS custom properties that resolve to it, e.g. `["--accent"]`. */
  cssVars: string[];
}

/** How many stylesheets to follow. A site that needs more is not hiding its palette in the sixth. */
const MAX_STYLESHEETS = 4;
/** Per-document read cap. A stylesheet larger than this is a bundle; its first megabyte still holds the theme. */
const MAX_BYTES = 1_000_000;
const FETCH_TIMEOUT_MS = 15_000;

const HEX_RE = /#([0-9a-fA-F]{3}|[0-9a-fA-F]{6})\b/g;
const CUSTOM_PROP_RE = /(--[A-Za-z0-9_-]+)\s*:\s*(#(?:[0-9a-fA-F]{3}|[0-9a-fA-F]{6}))\b/g;
const STYLESHEET_HREF_RE = /<link\b[^>]*rel=["']?stylesheet["']?[^>]*>/gi;
const HREF_RE = /href=["']([^"']+)["']/i;

/**
 * Colours with no brand meaning, dropped before ranking.
 *
 * Pure black and white and the transparent shorthand appear in every
 * stylesheet ever written (resets, shadows, Tailwind's `--tw-*` gradient
 * placeholders) and would otherwise dominate the frequency count and crowd out
 * the colours that identify the brand. Dropped from the RANKING only — a
 * palette that genuinely is black and white still reaches the model through the
 * custom properties, which are kept whatever their value.
 */
const IGNORED_HEXES = new Set(["#000000", "#ffffff", "#00000000", "#0000"]);

async function fetchText(url: string, fetchImpl: typeof fetch): Promise<string | null> {
  try {
    const response = await fetchImpl(url, { signal: AbortSignal.timeout(FETCH_TIMEOUT_MS), redirect: "follow" });
    if (!response.ok) return null;
    const text = await response.text();
    return text.slice(0, MAX_BYTES);
  } catch {
    // A site that blocks us, times out, or serves something unreadable is a
    // site we simply have no observations for — the caller then leaves the
    // model's palette alone rather than "repairing" it against nothing.
    return null;
  }
}

/** Absolute stylesheet URLs referenced by a page, in document order. */
function stylesheetUrls(html: string, pageUrl: string): string[] {
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
  return [...new Set(urls)].slice(0, MAX_STYLESHEETS);
}

/**
 * Read the palette a domain actually serves.
 *
 * Never throws and never rejects: an unreachable site yields an empty array,
 * which every caller treats as "no observations, change nothing". Branding is
 * a non-fatal side pipeline (`applyBrandingForClient`'s call site catches and
 * logs), and making it fatal here would trade a cosmetic gap for a failed run.
 */
export async function observeSitePalette(domain: string, fetchImpl: typeof fetch = fetch): Promise<ObservedColor[]> {
  const pageUrl = `https://${domain.replace(/^https?:\/\//, "").replace(/\/+$/, "")}/`;
  const html = await fetchText(pageUrl, fetchImpl);
  if (html === null) return [];

  const sheets = await Promise.all(stylesheetUrls(html, pageUrl).map((url) => fetchText(url, fetchImpl)));
  const documents = [html, ...sheets.filter((s): s is string => s !== null)];

  const counts = new Map<string, number>();
  const vars = new Map<string, Set<string>>();

  for (const doc of documents) {
    for (const match of doc.matchAll(HEX_RE)) {
      const hex = normalizeHex(match[0]);
      if (hex) counts.set(hex, (counts.get(hex) ?? 0) + 1);
    }
    for (const match of doc.matchAll(CUSTOM_PROP_RE)) {
      const hex = normalizeHex(match[2]!);
      if (!hex) continue;
      const bucket = vars.get(hex) ?? new Set<string>();
      bucket.add(match[1]!);
      vars.set(hex, bucket);
      // A declared custom property is a deliberate statement about the brand,
      // so it also earns its colour a place in the ranking even when the
      // ignore-list would otherwise drop it.
      counts.set(hex, counts.get(hex) ?? 0);
    }
  }

  return [...counts.entries()]
    .filter(([hex]) => !IGNORED_HEXES.has(hex) || vars.has(hex))
    .map(([hex, count]) => ({ hex, count, cssVars: [...(vars.get(hex) ?? [])].sort() }))
    // Custom properties first — a named colour outranks a frequent one, because
    // frequency measures how much surface a colour covers and a name measures
    // whether anyone decided it mattered.
    .sort((a, b) => Number(b.cssVars.length > 0) - Number(a.cssVars.length > 0) || b.count - a.count || a.hex.localeCompare(b.hex))
    .slice(0, 40);
}

/** The prompt block naming what the site really declares. Empty string when nothing was observed. */
export function describeObservedPalette(observed: readonly ObservedColor[]): string {
  if (observed.length === 0) return "";
  const named = observed.filter((c) => c.cssVars.length > 0);
  const rest = observed.filter((c) => c.cssVars.length === 0).slice(0, 12);

  const lines = [
    "## Source C — Verified site palette (transcribed from the live CSS by code, not by a model)",
    "",
    "EVERY hex you return in `dominantColors` MUST be one of the values listed here, copied exactly.",
    "These were read directly out of the site's own markup and stylesheets. Do not adjust, round,",
    "or substitute a value you believe is close — a hex that is not in this list is wrong by definition.",
    "",
  ];
  if (named.length > 0) {
    lines.push(
      "Declared CSS custom properties (the site's own names for its colours — usually the clearest",
      "statement of role available; a `--accent`/`--brand-*` is the colour the brand ACTS with, while",
      "`--primary` in a component-library theme is often an untouched framework default):",
      ...named.map((c) => `  ${c.cssVars.join(", ")}: ${c.hex}`),
      "",
    );
  }
  if (rest.length > 0) {
    lines.push("Other colours present, by frequency:", `  ${rest.map((c) => c.hex).join(", ")}`, "");
  }
  return lines.join("\n");
}

function rgb(hex: string): [number, number, number] {
  return [Number.parseInt(hex.slice(1, 3), 16), Number.parseInt(hex.slice(3, 5), 16), Number.parseInt(hex.slice(5, 7), 16)];
}

function distance(a: string, b: string): number {
  const [r1, g1, b1] = rgb(a);
  const [r2, g2, b2] = rgb(b);
  return (r1 - r2) ** 2 + (g1 - g2) ** 2 + (b1 - b2) ** 2;
}

/**
 * Replace any hex the site does not actually contain with the observed colour
 * closest to it, keeping the model's own `role` and `dominanceRank`.
 *
 * Repair rather than reject, and repair rather than re-rank. The model's
 * judgment about which colour is the accent and which is the ground is the part
 * it is good at and the part `resolveDominantColorsByRole` depends on; dropping
 * an entry would leave that reader with a hole, and reordering would overrule a
 * judgment this function is not qualified to make. What it does know is that a
 * colour absent from the site cannot be the brand's — so it keeps the intent
 * and fixes the value. `#dc602c` becomes the `#ff6b2c` the site really uses.
 *
 * No observations means no repair. An unreachable site must not cause a
 * confident rewrite of a palette that may have come from a logo file, which is
 * a source this function cannot see.
 */
export function snapToObservedPalette(colors: readonly BrandColor[], observed: readonly ObservedColor[]): BrandColor[] {
  if (observed.length === 0) return [...colors];
  const present = new Set(observed.map((c) => c.hex));

  return colors.map((color) => {
    const hex = normalizeHex(color.hex) ?? color.hex;
    if (present.has(hex)) return { ...color, hex };
    let nearest = observed[0]!.hex;
    let best = Number.POSITIVE_INFINITY;
    for (const candidate of observed) {
      const d = distance(hex, candidate.hex);
      if (d < best) {
        best = d;
        nearest = candidate.hex;
      }
    }
    return { ...color, hex: nearest };
  });
}
