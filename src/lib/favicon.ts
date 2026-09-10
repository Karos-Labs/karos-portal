/**
 * Favicon URL derivation — pure + client-safe.
 *
 * Every brand surface (client avatars, competitor track, SEO/GEO comparison
 * rows) falls back to the website's favicon when no uploaded logo exists, so a
 * client or competitor with a known website never renders as a generic
 * placeholder. Served via Google's s2 endpoint: no scraping, cached by Google,
 * and it degrades to a harmless generic globe glyph for unknown hosts (the
 * <img> onError fallback in BrandFavicon handles hard failures).
 */
export function faviconUrl(website: string | null | undefined, size = 32): string | null {
  const raw = website?.trim();
  if (!raw) return null;
  try {
    const host = new URL(raw.includes("://") ? raw : `https://${raw}`).hostname;
    if (!host || !host.includes(".")) return null;
    return `https://www.google.com/s2/favicons?domain=${encodeURIComponent(host)}&sz=${size}`;
  } catch {
    return null;
  }
}

/**
 * A brand NAME that is itself a domain — "ploy.ai", "Okara.ai", "notion.so".
 *
 * Competitor rows only carry `url` when the row was quick-added from a URL or
 * the model happened to return one; report-sourced rows routinely have no url
 * at all, so brands whose name IS their domain fell through to the generic
 * building glyph while their neighbours showed real favicons (CD-F2).
 *
 * Deliberately strict: the WHOLE name must be one dotted token with no spaces,
 * so "Acme Inc." or "U.S. Bank" can never be mistaken for a hostname and fetch
 * some unrelated site's icon.
 */
const BARE_DOMAIN = /^(?:https?:\/\/)?((?:[a-z0-9](?:[a-z0-9-]*[a-z0-9])?\.)+[a-z]{2,24})\/?$/i;

export function domainFromName(name: string | null | undefined): string | null {
  const raw = name?.trim().toLowerCase();
  if (!raw) return null;
  const match = BARE_DOMAIN.exec(raw);
  return match ? match[1] : null;
}

/**
 * Favicon for a brand, preferring its stored website and falling back to a
 * name that is itself a domain. Google's s2 endpoint caches per host, so the
 * derived URL is as cacheable as the stored one — no extra fetch layer.
 */
export function brandFaviconUrl(
  website: string | null | undefined,
  name: string | null | undefined,
  size = 32,
): string | null {
  return faviconUrl(website, size) ?? faviconUrl(domainFromName(name), size);
}
