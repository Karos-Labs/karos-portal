import type { SocialPlatform } from "@/components/agent-identity";
import { socialHandleValue } from "@/lib/social-handles";

/**
 * The pure half of the onboarding website scan: which links on a page are the
 * company's own social profiles, what the page says about itself, and which
 * URLs are safe to fetch at all. No I/O here, so every rule is testable
 * against a fixture; the fetching is `onboarding-discovery.ts`.
 */

/** Platforms the scan looks for, with the hosts each one answers on. */
const HOSTS: Record<string, SocialPlatform> = {
  "instagram.com": "instagram",
  "linkedin.com": "linkedin",
  "facebook.com": "facebook",
  "fb.com": "facebook",
  "x.com": "x",
  "twitter.com": "x",
  "tiktok.com": "tiktok",
  "youtube.com": "youtube",
};

/**
 * First path segments that are a platform's own pages, never an account:
 * share buttons, posts, search, login, legal. A footer "share on X" link is the
 * commonest false positive on a real site.
 */
const NOT_AN_ACCOUNT = new Set([
  "share", "sharer", "sharer.php", "intent", "home", "login", "signup", "explore", "search", "hashtag",
  "p", "reel", "reels", "tv", "stories", "status", "i", "watch", "embed", "results", "playlist", "shorts",
  "feed", "posts", "pulse", "sharearticle", "share-offsite", "dialog", "plugins", "tr", "policies", "privacy",
  "legal", "terms", "help", "about", "business", "ads", "settings", "messages", "notifications", "video",
  "discover", "tag", "music", "events", "groups", "gaming", "photo.php", "profile.php", "watch?v", "jobs",
]);

/** LinkedIn only has accounts under these; everything else there is content. */
const LINKEDIN_ACCOUNT_KINDS = new Set(["company", "in", "school", "showcase"]);
/** YouTube account paths other than `/@handle`. */
const YOUTUBE_ACCOUNT_KINDS = new Set(["c", "channel", "user"]);

/**
 * The account a URL points at, or null when it is not a profile. Returns the
 * value in the form the client record stores (`socialHandleValue`): a handle
 * for most networks, `company/x` style for LinkedIn so the page kind survives.
 */
export function socialProfileFromUrl(raw: string): { platform: SocialPlatform; value: string } | null {
  let url: URL;
  try {
    url = new URL(raw.trim(), "https://placeholder.invalid");
  } catch {
    return null;
  }
  // `il.linkedin.com`, `de.linkedin.com`: country mirrors of the same account.
  const host = url.hostname
    .toLowerCase()
    .replace(/^(www|m|mobile)\./, "")
    .replace(/^[a-z]{2}\.(?=linkedin\.com$)/, "");
  const platform = HOSTS[host];
  if (!platform) return null;
  const segments = url.pathname.split("/").filter(Boolean).map(decodeURIComponent);
  if (segments.length === 0) return null;
  const first = segments[0]!.toLowerCase();

  if (platform === "linkedin") {
    if (!LINKEDIN_ACCOUNT_KINDS.has(first) || !segments[1]) return null;
    return { platform, value: `${first}/${segments[1]}` };
  }
  if (platform === "youtube") {
    if (first.startsWith("@") && first.length > 1) return { platform, value: segments[0]!.replace(/^@/, "") };
    if (YOUTUBE_ACCOUNT_KINDS.has(first) && segments[1]) return { platform, value: `${first}/${segments[1]}` };
    return null;
  }
  if (platform === "tiktok") {
    return first.startsWith("@") && first.length > 1 ? { platform, value: segments[0]!.replace(/^@/, "") } : null;
  }
  // A profile is one segment deep; `/name/posts/123` is content under it, and
  // the account is still `name`.
  const handle = segments[0]!.replace(/^@/, "");
  if (NOT_AN_ACCOUNT.has(first) || !/^[a-z0-9._-]+$/i.test(handle)) return null;
  const value = socialHandleValue(platform, handle);
  return value ? { platform, value } : null;
}

/**
 * The company's own profiles among a page's links: the first profile per
 * platform, in document order (headers and footers both list the brand's own
 * accounts; a blog post embedding somebody else's tweet comes later).
 */
export function extractSocialProfiles(html: string): Partial<Record<SocialPlatform, string>> {
  const found: Partial<Record<SocialPlatform, string>> = {};
  const hrefs = html.matchAll(/href\s*=\s*["']([^"'#]+)["']/gi);
  for (const m of hrefs) {
    const profile = socialProfileFromUrl(m[1]!.replace(/&amp;/g, "&"));
    if (profile && !found[profile.platform]) found[profile.platform] = profile.value;
  }
  return found;
}

function attr(tag: string, name: string): string | undefined {
  return new RegExp(`${name}\\s*=\\s*["']([^"']*)["']`, "i").exec(tag)?.[1];
}

function metaContent(html: string, key: string): string | undefined {
  for (const m of html.matchAll(/<meta\b[^>]*>/gi)) {
    const tag = m[0];
    if ((attr(tag, "property") ?? attr(tag, "name"))?.toLowerCase() === key) return attr(tag, "content")?.trim();
  }
  return undefined;
}

function decodeEntities(s: string): string {
  return s
    .replace(/&nbsp;/g, " ")
    .replace(/&amp;/g, "&")
    .replace(/&quot;/g, '"')
    .replace(/&#39;|&apos;/g, "'")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">");
}

export interface SiteMeta {
  title: string;
  description: string;
  siteName: string;
  /** `<meta name="theme-color">` as #RRGGBB, when it is a real colour (not white/black). */
  themeColor: string | null;
  /** Absolute https URL of the best logo candidate, or null. */
  logoUrl: string | null;
  /** The page's visible text, whitespace-collapsed and capped, for the model. */
  text: string;
}

/**
 * What a page says about itself.
 *
 * THE LOGO IS THE HARD PART. A page carries many images called "logo", and
 * most of them are somebody else's: stripe.com's first one is a customer's,
 * from its logo wall. So an image counts only when it is in the page's
 * <header>, or when its alt/src names the brand; failing that, the
 * apple-touch-icon (square, and nearly always the brand's own mark). og:image
 * is not used: it is usually a wide banner, not a mark. No logo is a fine
 * answer; the card then shows the initial.
 */
export function extractSiteMeta(html: string, pageUrl: string, brand = "", maxText = 6000): SiteMeta {
  const abs = (u: string | undefined): string | null => {
    if (!u) return null;
    try {
      const url = new URL(decodeEntities(u), pageUrl);
      return url.protocol === "https:" ? url.toString() : null;
    } catch {
      return null;
    }
  };
  const key = brand.toLowerCase().replace(/[^a-z0-9]/g, "");
  const logoImages = (source: string) =>
    [...source.matchAll(/<img\b[^>]*>/gi)]
      .map((m) => m[0])
      .filter((tag) => /logo/i.test(`${attr(tag, "class") ?? ""} ${attr(tag, "alt") ?? ""} ${attr(tag, "src") ?? ""} ${attr(tag, "id") ?? ""}`));
  // Outside the header, the FILE NAME must carry both the brand and "logo".
  // Not the host: stripe.com serves every image from images.stripeassets.com.
  // Not the alt text: its customer photo is described as "imitating the
  // Stripe logo" (both measured 2026-09-26).
  const fileName = (src: string | undefined) => (src ?? "").split("?")[0]!.split("/").pop() ?? "";
  const namesBrand = (tag: string) => {
    const f = fileName(attr(tag, "src")).toLowerCase();
    return key.length >= 3 && /logo/.test(f) && f.replace(/[^a-z0-9]/g, "").includes(key);
  };

  const header = /<header\b[\s\S]*?<\/header>/i.exec(html)?.[0] ?? "";
  let logo: string | null = null;
  for (const tag of [...logoImages(header), ...logoImages(html).filter(namesBrand)]) {
    logo = abs(attr(tag, "src"));
    if (logo) break;
  }
  if (!logo) {
    for (const m of html.matchAll(/<link\b[^>]*>/gi)) {
      if (/apple-touch-icon/i.test(attr(m[0], "rel") ?? "")) {
        logo = abs(attr(m[0], "href"));
        if (logo) break;
      }
    }
  }

  const title = decodeEntities(/<title[^>]*>([^<]*)<\/title>/i.exec(html)?.[1]?.trim() ?? "");
  const text = decodeEntities(
    html
      .replace(/<(script|style|noscript|svg|template)\b[\s\S]*?<\/\1>/gi, " ")
      .replace(/<!--[\s\S]*?-->/g, " ")
      .replace(/<[^>]+>/g, " "),
  )
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, maxText);

  return {
    title,
    description: decodeEntities(metaContent(html, "description") ?? metaContent(html, "og:description") ?? ""),
    siteName: decodeEntities(metaContent(html, "og:site_name") ?? ""),
    themeColor: brandThemeColor(metaContent(html, "theme-color")),
    logoUrl: logo,
    text,
  };
}

function brandThemeColor(raw: string | undefined): string | null {
  const m = /^#?([0-9a-f]{6}|[0-9a-f]{3})$/i.exec((raw ?? "").trim());
  if (!m) return null;
  const hex = m[1]!.length === 3 ? [...m[1]!].map((c) => c + c).join("") : m[1]!;
  const upper = `#${hex.toUpperCase()}`;
  return upper === "#FFFFFF" || upper === "#000000" ? null : upper;
}

/**
 * Is this a website the server may fetch on a client's behalf? The address is
 * typed by the person onboarding, so it is refused unless it is a plain
 * http(s) URL on a public-looking hostname: no IP literals, no localhost, no
 * internal names, no ports other than the defaults. (A public name that
 * RESOLVES to a private address is not caught here; Cloud Run egress is the
 * backstop for that.)
 */
export function publicWebsiteUrl(raw: string): URL | null {
  const v = raw.trim();
  if (!v || v.length > 500) return null;
  let url: URL;
  try {
    url = new URL(/^https?:\/\//i.test(v) ? v : `https://${v}`);
  } catch {
    return null;
  }
  if (url.protocol !== "https:" && url.protocol !== "http:") return null;
  if (url.username || url.password || url.port) return null;
  const host = url.hostname.toLowerCase();
  if (!/^[a-z0-9-]+(\.[a-z0-9-]+)*\.[a-z]{2,}$/.test(host)) return null; // rejects IPv4/IPv6 literals and bare names
  if (/(^|\.)(localhost|local|internal|localdomain|home|lan|corp)$/.test(host)) return null;
  return url;
}
