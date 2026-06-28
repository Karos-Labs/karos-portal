/**
 * Brand validation — native port of karos-labs `scripts/lib/brand.mjs`.
 *
 * The engine must NEVER silently fall back to another client's identity: if the brand
 * config is missing a field the renderers need, generation must stop. Here that gate is
 * split in two so it serves both the engine and the onboarding UI:
 *   - `missingBrandFields` — non-throwing, drives the questionnaire's readiness banner.
 *   - `assertBrand`        — throws (used by the generator before it produces anything).
 *
 * Pure module (no "server-only") so the client questionnaire can import the readiness check.
 */

import type { NewsletterBrand } from "./types";

/** A partially-filled brand, as it exists mid-onboarding. */
export type DeepPartial<T> = {
  [K in keyof T]?: T[K] extends object ? DeepPartial<T[K]> : T[K];
};

type BrandLike = DeepPartial<NewsletterBrand> | null | undefined;

/**
 * Required fields, mirroring karos-labs `assertBrand`. Every renderer needs these and the
 * engine assumes NO client default for any of them. `compliance.disclaimer_pt` keeps its
 * engine field name (it is the locked footer, in the client's language).
 */
const REQUIRED: ReadonlyArray<readonly [string, (b: BrandLike) => unknown]> = [
  ["_meta.company_name", (b) => b?._meta?.company_name],
  ["palette.navy", (b) => b?.palette?.navy],
  ["palette.cream", (b) => b?.palette?.cream],
  ["palette.gold", (b) => b?.palette?.gold],
  ["fonts.display.stack", (b) => b?.fonts?.display?.stack],
  ["fonts.body.stack", (b) => b?.fonts?.body?.stack],
  ["fonts.mono.stack", (b) => b?.fonts?.mono?.stack],
  ["fonts.google_fonts_href", (b) => b?.fonts?.google_fonts_href],
  ["site_url", (b) => b?.site_url],
  ["locale", (b) => b?.locale],
  ["compliance.disclaimer_pt", (b) => b?.compliance?.disclaimer_pt],
];

/** Dotted paths of every required field still missing/blank (empty ⇒ the brand is "ready"). */
export function missingBrandFields(brand: BrandLike): string[] {
  if (!brand || typeof brand !== "object") return REQUIRED.map(([k]) => k);
  return REQUIRED.filter(([, get]) => {
    const v = get(brand);
    return v == null || v === "";
  }).map(([k]) => k);
}

/** True once every required brand field is present — the brand can be generated against. */
export function isBrandReady(brand: BrandLike): boolean {
  return missingBrandFields(brand).length === 0;
}

/** Throws if the brand is missing any field the engine needs. No client default is assumed. */
export function assertBrand(brand: BrandLike, ctx = "brand"): void {
  const missing = missingBrandFields(brand);
  if (missing.length) {
    throw new Error(
      `${ctx}: brand config is missing required field(s): ${missing.join(", ")}. ` +
        `The engine does not assume any client default — fill these in before generating.`,
    );
  }
}
