/**
 * Hex normalization, alone in its own module.
 *
 * Extracted from `branding.ts` so `branding-site-palette.ts` can use it without
 * importing that module — `branding.ts` imports the palette observer, and a
 * cycle between them would be a real one (both are server modules loaded during
 * a run, not type-only). `branding.ts` re-exports it, so every existing
 * importer and `branding.test.ts` are unaffected.
 *
 * No "server-only" here on purpose: this is a pure string function with no
 * server dependency, and marking it would stop a client component formatting a
 * swatch with it.
 */

/** Normalizes `#abc`, `#aabbcc` or `#aabbccdd` to 6-digit lowercase hex; `null` for anything else. */
export function normalizeHex(raw: string): string | null {
  const h = raw.trim().toLowerCase();
  if (/^#[0-9a-f]{3}$/.test(h)) return "#" + h[1] + h[1] + h[2] + h[2] + h[3] + h[3];
  if (/^#[0-9a-f]{6}$/.test(h)) return h;
  if (/^#[0-9a-f]{8}$/.test(h)) return h.slice(0, 7);
  return null;
}
