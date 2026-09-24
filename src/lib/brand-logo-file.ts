/**
 * What a brand logo file has to be before the portal stores it — shared by the
 * upload route (the boundary) and the three upload controls (so a file the
 * route would refuse is refused before it is sent, with the same sentence).
 *
 * ## The numbers are the ENGINE's, not ours
 *
 * The logo exists to be carried on every post, and agent-engine is what
 * carries it: `downloadBrandLogoOutcome` (`packages/tools/karos-media/src/
 * brand-logo.ts`) fetches `brand.json`'s `logoUrl` and refuses anything past
 * `BRAND_LOGO_MAX_BYTES = 4_000_000` or outside its content-type whitelist.
 * This route used to cap at `4 * 1024 * 1024` (4,194,304 bytes), so a logo
 * between the two sizes uploaded here with a success message and was then
 * silently dropped from every slide — the preview in the portal showed it, the
 * posts never did. The cap here is the engine's exact byte count.
 *
 * WebP joined the list for the same reason: the engine has always accepted
 * it, and a mark exported as WebP is a real client's real logo.
 */

/** agent-engine's `BRAND_LOGO_MAX_BYTES` — decimal 4 MB, deliberately not 4 MiB. */
export const BRAND_LOGO_MAX_BYTES = 4_000_000;

/** The content types a logo may be stored as. A subset of the engine's whitelist (which also takes AVIF). */
export const BRAND_LOGO_TYPES = ["image/svg+xml", "image/png", "image/jpeg", "image/webp"] as const;
export type BrandLogoType = (typeof BRAND_LOGO_TYPES)[number];

/** The file picker's `accept` attribute. Extensions too, because some systems hand an SVG over with no type. */
export const BRAND_LOGO_ACCEPT = "image/svg+xml,image/png,image/jpeg,image/webp,.svg,.png,.jpg,.jpeg,.webp";

/** The one line every control prints under its button. */
export const BRAND_LOGO_HINT = "SVG, PNG, JPG or WebP, up to 4 MB. An SVG or a transparent PNG looks best on posts.";

const TYPE_BY_EXTENSION: Record<string, BrandLogoType> = {
  svg: "image/svg+xml",
  png: "image/png",
  jpg: "image/jpeg",
  jpeg: "image/jpeg",
  webp: "image/webp",
};

export type BrandLogoCheck =
  | { ok: true; contentType: BrandLogoType }
  | { ok: false; status: 400 | 413 | 415; error: string };

/**
 * The content type a file will be stored under, or a refusal.
 *
 * The browser's `type` is read first and normalised (`image/jpg` is not a real
 * type but some tools emit it). An EMPTY type — Windows hands SVGs over that
 * way often enough to matter — falls back to the extension. It used to fall
 * back to `image/png`, which stored an SVG labelled as a PNG: the engine then
 * sniffed PNG, found XML, and could not read its ink.
 */
export function checkBrandLogoFile(file: { name?: string; type?: string; size: number }): BrandLogoCheck {
  if (file.size <= 0) return { ok: false, status: 400, error: "That file is empty." };
  if (file.size > BRAND_LOGO_MAX_BYTES) {
    return { ok: false, status: 413, error: "That file is over 4 MB. Export the logo itself rather than a screenshot of it." };
  }
  const declared = (file.type ?? "").trim().toLowerCase();
  const normalised = declared === "image/jpg" ? "image/jpeg" : declared;
  const extension = /\.([a-z0-9]+)$/i.exec(file.name ?? "")?.[1]?.toLowerCase();
  const contentType = normalised.length > 0 ? normalised : extension ? TYPE_BY_EXTENSION[extension] : undefined;
  if (contentType === undefined || !(BRAND_LOGO_TYPES as readonly string[]).includes(contentType)) {
    return { ok: false, status: 415, error: "Only SVG, PNG, JPG and WebP files can be used as a logo." };
  }
  return { ok: true, contentType: contentType as BrandLogoType };
}

/**
 * The logo the ENGINE should carry, or `undefined`.
 *
 * The uploaded logo (`Client.logoUrl`, written by `/api/clients/[id]/logo`)
 * first, the branding guidelines' own `logoUrl` second — the same precedence
 * every portal surface already paints (`client.logoUrl ||
 * brandingGuidelines.logoUrl`). Before this, `brand.json` read ONLY the
 * guidelines' field, which nothing in the portal writes, so a logo uploaded
 * in the portal never reached a single post.
 *
 * https only. The engine fetches nothing else (`gs://` is refused by name in
 * `deriveBrandRenderTokens`), so projecting any other scheme would be a logo
 * that reads as configured and renders as absent.
 */
export function engineBrandLogoUrl(client: { logoUrl?: string; brandingGuidelines?: { logoUrl?: string } }): string | undefined {
  for (const candidate of [client.logoUrl, client.brandingGuidelines?.logoUrl]) {
    const url = candidate?.trim();
    if (url && /^https:\/\//i.test(url)) return url;
  }
  return undefined;
}
