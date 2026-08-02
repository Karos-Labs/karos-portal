import type { SocialPlatform } from "@/components/agent-identity";

/**
 * A CLIENT'S SOCIAL ACCOUNT, FROM WHATEVER IS STORED IN IT (AF-4).
 *
 * `client.socialLinks` is free text that four different surfaces write to —
 * the company panel's edit form, the onboarding wizard, the client editor, and
 * the importer — so a field called `instagram` holds any of:
 *
 *     @karoslabs · karoslabs · instagram.com/karoslabs
 *     https://www.instagram.com/karoslabs/ · …/karoslabs?igsh=MXY4
 *
 * and the panel rendered all five verbatim, behind a generic @-sign, as
 * unclickable text. "Social accounts render as the PLATFORM'S LOGO +
 * @username (shorten any stored full link to the username), and each row is
 * clickable, opening that profile."
 *
 * So this module answers both halves from one parse: the handle to show, and
 * the profile to open. It is pure and has no React in it — the display rule and
 * the storage rule are the same rule, and the save path normalises through
 * `socialHandleValue` so tomorrow's rows are stored short rather than only
 * displayed short.
 *
 * NOT a validator. A handle nobody can resolve is still the client's own text,
 * and a company panel is not where to tell them their Instagram is wrong: an
 * unparseable value keeps its characters and simply gets no link.
 */

/** Hosts that identify a stored link as belonging to a platform. */
const PLATFORM_HOSTS: Record<SocialPlatform, string[]> = {
  instagram: ["instagram.com"],
  // Both names, because both are in the field: the rename is younger than some
  // of these rows.
  x: ["x.com", "twitter.com"],
  tiktok: ["tiktok.com"],
  linkedin: ["linkedin.com"],
  youtube: ["youtube.com", "youtu.be"],
  facebook: ["facebook.com", "fb.com"],
  reddit: ["reddit.com"],
};

/** Where a bare handle goes when we build a URL for it. */
const PLATFORM_BASE: Record<SocialPlatform, string> = {
  instagram: "https://instagram.com/",
  x: "https://x.com/",
  tiktok: "https://tiktok.com/@",
  linkedin: "https://linkedin.com/company/",
  youtube: "https://youtube.com/@",
  facebook: "https://facebook.com/",
  reddit: "https://reddit.com/user/",
};

/**
 * Path segments that name WHAT KIND of page follows rather than being the
 * handle themselves. `linkedin.com/in/ada` and `linkedin.com/company/karos`
 * are both "the profile", and the segment that says which one has to survive
 * the round trip or every company page turns into a person's.
 */
const PATH_PREFIXES: Partial<Record<SocialPlatform, string[]>> = {
  linkedin: ["in", "company", "school", "showcase"],
  youtube: ["c", "user", "channel"],
  reddit: ["user", "u", "r"],
};

/** Trailing junk a pasted link brings with it. */
function stripQuery(value: string): string {
  return value.split(/[?#]/, 1)[0]!;
}

/** Does this look like a link rather than a handle? */
function looksLikeUrl(value: string): boolean {
  return /^https?:\/\//i.test(value) || /^[\w-]+(\.[\w-]+)+\//.test(value) || value.includes("/");
}

export interface SocialAccount {
  /** Display form, always `@`-prefixed. */
  handle: string;
  /** The bare handle, as it should be STORED — no `@`, no host, no path. */
  value: string;
  /** Absolute profile URL, or null when the stored text yields nothing to open. */
  url: string | null;
}

/**
 * Parse one stored value into the account the panel renders.
 *
 * Returns null only for genuinely empty text, so a caller filtering on truthy
 * gets the same set it did before this module existed.
 */
export function socialAccount(platform: SocialPlatform, raw: string): SocialAccount | null {
  const trimmed = (raw ?? "").trim();
  if (!trimmed) return null;

  if (!looksLikeUrl(trimmed)) {
    // A plain handle: `@karoslabs` or `karoslabs`. Anything else in it (a
    // space, a stray comma) is the client's text and is kept as-is.
    const value = stripQuery(trimmed).replace(/^@+/, "");
    if (!value) return null;
    return { handle: `@${value}`, value, url: PLATFORM_BASE[platform] + value };
  }

  // A link. Take it apart by hand rather than with URL(): the field holds
  // protocol-less values ("instagram.com/foo") that URL() rejects outright, and
  // bare paths ("/foo") that it resolves against nothing.
  const withoutProtocol = trimmed.replace(/^https?:\/\//i, "");
  const [hostOrFirst = "", ...rest] = stripQuery(withoutProtocol).split("/");
  const host = hostOrFirst.toLowerCase().replace(/^www\./, "");
  const isHost = host.includes(".");
  const segments = (isHost ? rest : [hostOrFirst, ...rest]).filter(Boolean);
  if (segments.length === 0) return null;

  // The kind-of-page segment, kept so the URL we rebuild opens the same page.
  const prefixes = PATH_PREFIXES[platform] ?? [];
  let prefix: string | null = null;
  let handleSegment = segments[0]!;
  if (segments.length > 1 && prefixes.includes(segments[0]!.toLowerCase())) {
    prefix = segments[0]!.toLowerCase();
    handleSegment = segments[1]!;
  }

  const value = handleSegment.replace(/^@+/, "");
  if (!value) return null;

  // A link on a host this platform does not own is still a link the client put
  // there — open exactly it, rather than rebuilding a URL on the wrong domain
  // from a segment that may not be a handle at all.
  const known = !isHost || PLATFORM_HOSTS[platform].some((h) => host === h || host.endsWith(`.${h}`));
  if (!known) {
    return { handle: `@${value}`, value, url: `https://${stripQuery(withoutProtocol)}` };
  }

  const base = prefix
    ? `https://${PLATFORM_HOSTS[platform][0]}/${prefix}/`
    : PLATFORM_BASE[platform];
  return { handle: `@${value}`, value, url: base + value };
}

/** The display handle, or the trimmed input when there is nothing to parse. */
export function socialHandle(platform: SocialPlatform, raw: string): string {
  return socialAccount(platform, raw)?.handle ?? (raw ?? "").trim();
}

/**
 * What the save path should WRITE for this field — the shortening rule applied
 * at the point of storage, so a link pasted today is a handle tomorrow.
 * Unparseable text is returned trimmed and otherwise untouched: normalising is
 * not licence to discard what somebody typed.
 */
export function socialHandleValue(platform: SocialPlatform, raw: string): string {
  return socialAccount(platform, raw)?.value ?? (raw ?? "").trim();
}
