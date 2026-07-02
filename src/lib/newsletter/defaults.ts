/**
 * Seed shapes for a new client's newsletter config. Every key is always present (so the
 * stored Firestore doc has the full engine JSON shape — never undefined nesting), with
 * contract-allowed defaults filled in and the rest left blank for the questionnaire.
 * Blank required fields are surfaced by `missingBrandFields` as the readiness gate.
 *
 * Prefills from everything the system already knows about the client so onboarding starts
 * populated, not empty: the `Client` record (name, website, accent, contact, description),
 * the AI-generated `brandingGuidelines` (palette, fonts, tone, visual style, voice prose),
 * and the intel `ClientReport` (whitespace + SWOT opportunities → seed topics). After this
 * the only required field a real client still needs is the legal-footer disclaimer; the
 * rest is review-and-confirm plus optional voice-anchor uploads.
 *
 * Pure module (no "server-only") so the questionnaire and the save action can both import it.
 */

import type { BrandingGuidelines, Client, ClientReport } from "@/lib/types";
import type { ContentFoundation, NewsletterBrand, NewsletterConfig } from "./types";

/** The other system data we prefill from, beyond the `Client` record itself. */
export interface PrefillSources {
  /** Parsed Digital Intelligence & Competitive Report, if one exists for the client. */
  report?: ClientReport | null;
}

/* ─────────────────────────── prefill helpers ───────────────────────────── */

/** Parse a #rrggbb (or #rgb) hex to [r,g,b] 0-255, or null if not a usable hex. */
function parseHex(raw?: string): [number, number, number] | null {
  if (!raw) return null;
  let h = raw.trim().toLowerCase();
  if (/^#[0-9a-f]{3}$/.test(h)) h = "#" + h[1] + h[1] + h[2] + h[2] + h[3] + h[3];
  if (!/^#[0-9a-f]{6}$/.test(h)) return null;
  return [parseInt(h.slice(1, 3), 16), parseInt(h.slice(3, 5), 16), parseInt(h.slice(5, 7), 16)];
}

/** Perceived-luminance dark check (so we know whether a colour is a dark base or a light surface). */
function isDark(hex?: string): boolean {
  const rgb = parseHex(hex);
  if (!rgb) return false;
  const [r, g, b] = rgb;
  return 0.2126 * r + 0.7152 * g + 0.0722 * b < 128;
}

/** Map the client's UI background/text + accent into the engine's navy/cream/gold slots. */
function paletteFrom(g: BrandingGuidelines | undefined, client: Client) {
  const accent = g?.primaryColor || client.accentColor || "";
  const bg = g?.uiBackground;
  const text = g?.uiText;
  let navy = "";
  let cream = "";
  if (bg && isDark(bg)) {
    // Dark-mode brand: the background is the dark base, text is the light surface.
    navy = bg;
    cream = text && !isDark(text) ? text : "#F7F5F0";
  } else if (bg) {
    // Light-mode brand: the background is the light surface, text is the dark base.
    cream = bg;
    navy = text && isDark(text) ? text : "#0A0A0A";
  } else if (text) {
    // Only a text colour known — use it as the dark base if it is dark.
    navy = isDark(text) ? text : "";
  }
  return { navy, cream, gold: accent };
}

/** Build a usable CSS stack from a family name, falling back to the given system stack. */
function fontStack(family: string | undefined, fallback: string): string {
  const f = family?.trim();
  return f ? `'${f}', ${fallback}` : fallback;
}

/** Build a best-effort Google Fonts href from the heading/body families (blank if neither set). */
function googleFontsHref(heading?: string, body?: string): string {
  const fams = [heading, body]
    .map((f) => f?.trim())
    .filter((f): f is string => !!f)
    .filter((f, i, arr) => arr.indexOf(f) === i)
    .map((f, i) => `family=${encodeURIComponent(f).replace(/%20/g, "+")}:wght@${i === 0 ? "400;600;700" : "400;500"}`);
  return fams.length ? `https://fonts.googleapis.com/css2?${fams.join("&")}&display=swap` : "";
}

/** Pull the prose under a `## Heading` section of the AI guidelines markdown (until the next `## `). */
function sectionText(md: string | undefined, heading: string): string {
  if (!md) return "";
  const lines = md.split("\n");
  const start = lines.findIndex((l) => l.trim().toLowerCase() === `## ${heading}`.toLowerCase());
  if (start === -1) return "";
  const out: string[] = [];
  for (let i = start + 1; i < lines.length; i++) {
    if (lines[i].trim().startsWith("## ")) break;
    out.push(lines[i]);
  }
  return out.join("\n").trim();
}

/** Pull the `- item` bullets under a `## Heading` section of the AI guidelines markdown. */
function sectionList(md: string | undefined, heading: string): string[] {
  return sectionText(md, heading)
    .split("\n")
    .map((l) => l.replace(/^[-*]\s+/, "").trim())
    .filter(Boolean);
}

/** Guess the dominant editorial register from tone keywords + visual style (one of the 4 options). */
function registerFrom(g: BrandingGuidelines | undefined): string {
  const hay = [...(g?.toneKeywords ?? []), g?.visualStyle ?? ""].join(" ").toLowerCase();
  if (!hay.trim()) return "";
  if (/bold|chall|disrupt|fearless|edgy|provoc|rebel/.test(hay)) return "challenger";
  if (/warm|human|friendly|approach|caring|personal|empath|kind/.test(hay)) return "warm";
  if (/corporate|profession|formal|premium|luxury|authorit|expert|trusted|precise/.test(hay)) return "formal";
  return "conversational";
}

/** Concrete content opportunities from the intel report → ready-made seed topics. */
function seedTopicsFrom(report: ClientReport | null | undefined): string[] {
  if (!report) return [];
  const raw = [...(report.whitespaceOpportunities ?? []), ...(report.swot?.opportunities ?? [])];
  const seen = new Set<string>();
  const out: string[] = [];
  for (const t of raw) {
    const v = t.trim();
    const key = v.toLowerCase();
    if (v && !seen.has(key)) {
      seen.add(key);
      out.push(v);
    }
  }
  return out.slice(0, 12);
}

/* ──────────────────────────── seed shapes ──────────────────────────────── */

/** A brand pre-seeded with engine defaults + everything we already know; required fields stay blank. */
export function emptyBrand(client?: Client): NewsletterBrand {
  const g = client?.brandingGuidelines;
  const palette = client ? paletteFrom(g, client) : { navy: "", cream: "", gold: "" };
  const voiceProse = sectionText(g?.guidelines, "Brand Voice");
  const archetype = voiceProse || (g?.toneKeywords?.length ? `${g.toneKeywords.join(", ")}.` : "");
  const contact = client?.contactEmail?.includes("@") ? client.contactEmail : "";

  return {
    _meta: {
      client_id: client?.id ?? "",
      company_name: client?.name ?? "",
      source: "portal onboarding (prefilled from client profile + intel report)",
      status: "draft",
    },
    palette: {
      navy: palette.navy,
      navy_2: "",
      cream: palette.cream,
      cream_2: "",
      // The brand's accent colour fills the engine's accent slot.
      gold: palette.gold,
      line: "",
      white: "#FFFFFF",
      near_black: "#0A0A0A",
      positive: "#22A06B",
      negative: "#C0392B",
      rule: "60/30/10: base, type/surface, accent. Accent never carries weight.",
    },
    fonts: {
      // Stacks default to safe system fallbacks; when we know the brand's families we lead with them.
      display: { family: g?.fontHeading ?? "", stack: fontStack(g?.fontHeading, "Georgia, 'Times New Roman', serif"), use: "H1, section heads, pull quotes" },
      body: { family: g?.fontBody ?? "", stack: fontStack(g?.fontBody, "-apple-system, BlinkMacSystemFont, 'Segoe UI', Arial, sans-serif"), use: "body, UI, buttons" },
      mono: { family: "", stack: "ui-monospace, Menlo, Consolas, monospace", use: "labels, kickers, numbers" },
      google_fonts_href: googleFontsHref(g?.fontHeading, g?.fontBody),
    },
    logo: {
      inline_mark_svg: "",
      inline_mark_svg_inverse: "",
      wordmark: client?.name ?? "",
    },
    voice: {
      archetype,
      language: "en",
      hard_rules: ["No em dashes. No double dashes.", "No exclamation points."],
    },
    compliance: {
      _status: "",
      // Legal footer — never auto-generated; the one required field a real client still fills in.
      disclaimer_pt: "",
      regulatory_line: "",
      banned_extra: [],
      never: [],
    },
    sender: {
      from_name: client?.name ?? "",
      from_email: contact,
      reply_to: contact,
      reason_line: "",
    },
    newsletter: {
      name: client?.name ? `${client.name} Newsletter` : "",
      cadence: "weekly",
      send_day: "Tuesday",
      host_note:
        "Client hosts and sends from their own ESP. Karos generates and surfaces for review/edit/approve. Karos does NOT send.",
      default_cta: { label: "", url: client?.website ?? "" },
      labels: { subject_ab: "Subject lines (A/B)", data: "Data", source: "Source", takeaways: "Takeaways" },
    },
    site_url: client?.website ?? "",
    locale: "en",
    blog: {
      index_title: client?.name ? `${client.name} Blog` : "",
      index_dek: "",
      meta_description: (client?.description ?? "").slice(0, 155),
      ui: {
        kicker_prefix: "Blog",
        featured: "Featured",
        all_articles: "All articles",
        read_min: "min read",
        read_min_short: "min",
        read_more: "Read the guide",
        article: "article",
        articles: "articles",
      },
    },
  };
}

/** An editorial foundation seeded from the client's description, voice and intel report. */
export function emptyFoundation(client?: Client, sources?: PrefillSources): ContentFoundation {
  const g = client?.brandingGuidelines;
  const report = sources?.report;
  const whoTheyAre =
    client?.description?.trim() ||
    (report?.businessType && client?.name ? `${client.name} — ${report.businessType}.` : "");
  // Brand voice rules = the two non-negotiables + any AI-derived "don'ts" (deduped).
  const donts = sectionList(g?.guidelines, "Don'ts").map((d) => (/^(don'?t|avoid|never|no )/i.test(d) ? d : `Avoid: ${d}`));
  const baseRules = ["No em dashes, en dashes, or double hyphens.", "No exclamation points."];
  const seen = new Set(baseRules.map((r) => r.toLowerCase()));
  for (const d of donts) {
    if (!seen.has(d.toLowerCase())) {
      seen.add(d.toLowerCase());
      baseRules.push(d);
    }
  }

  return {
    whoTheyAre,
    audience: "",
    voiceRegister: registerFrom(g),
    voiceHardRules: baseRules,
    pillars: [],
    seedTopics: seedTopicsFrom(report),
    keywordTargets: "",
    complianceConstraints: "",
    cadenceNotes: "",
  };
}

/** A complete starting config for a client with no newsletter doc yet. */
export function defaultNewsletterConfig(client: Client, sources?: PrefillSources): NewsletterConfig {
  return {
    clientId: client.id,
    brand: emptyBrand(client),
    foundation: emptyFoundation(client, sources),
    optIn: false,
    updatedAt: 0,
  };
}

/**
 * Merge a possibly-partial stored config over the prefilled defaults so the questionnaire
 * always gets a fully-shaped object. The prefill (from the client profile + intel report)
 * enriches the base; anything the user has already saved still wins over it. A doc created
 * by the opt-in toggle alone (no `brand`) therefore still receives the full prefill.
 */
export function mergeNewsletterConfig(
  client: Client,
  stored: Partial<NewsletterConfig> | null | undefined,
  sources?: PrefillSources,
): NewsletterConfig {
  const base = defaultNewsletterConfig(client, sources);
  if (!stored) return base;
  return {
    clientId: client.id,
    brand: {
      ...base.brand,
      ...stored.brand,
      _meta: { ...base.brand._meta, ...stored.brand?._meta },
      palette: { ...base.brand.palette, ...stored.brand?.palette },
      fonts: {
        ...base.brand.fonts,
        ...stored.brand?.fonts,
        display: { ...base.brand.fonts.display, ...stored.brand?.fonts?.display },
        body: { ...base.brand.fonts.body, ...stored.brand?.fonts?.body },
        mono: { ...base.brand.fonts.mono, ...stored.brand?.fonts?.mono },
      },
      logo: { ...base.brand.logo, ...stored.brand?.logo },
      voice: { ...base.brand.voice, ...stored.brand?.voice },
      compliance: { ...base.brand.compliance, ...stored.brand?.compliance },
      sender: { ...base.brand.sender, ...stored.brand?.sender },
      newsletter: {
        ...base.brand.newsletter,
        ...stored.brand?.newsletter,
        default_cta: { ...base.brand.newsletter.default_cta, ...stored.brand?.newsletter?.default_cta },
        labels: { ...base.brand.newsletter.labels, ...stored.brand?.newsletter?.labels },
      },
      blog: {
        ...base.brand.blog,
        ...stored.brand?.blog,
        ui: { ...base.brand.blog.ui, ...stored.brand?.blog?.ui },
      },
    },
    foundation: { ...base.foundation, ...stored.foundation },
    optIn: stored.optIn ?? base.optIn,
    updatedAt: stored.updatedAt ?? base.updatedAt,
  };
}
