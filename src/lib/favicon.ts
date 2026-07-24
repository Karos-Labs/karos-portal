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
