/**
 * Seed shapes for a new client's newsletter config. Every key is always present (so the
 * stored Firestore doc has the full engine JSON shape — never undefined nesting), with
 * contract-allowed defaults filled in and the rest left blank for the questionnaire.
 * Blank required fields are surfaced by `missingBrandFields` as the readiness gate.
 *
 * Prefills from the existing `Client` record where it is safe to (name, website, accent,
 * logo, brand voice) so onboarding starts populated rather than empty.
 */

import type { Client } from "@/lib/types";
import type { ContentFoundation, NewsletterBrand, NewsletterConfig } from "./types";

/** A brand pre-seeded with engine defaults + Client prefills; required fields stay blank. */
export function emptyBrand(client?: Client): NewsletterBrand {
  return {
    _meta: {
      client_id: client?.id ?? "",
      company_name: client?.name ?? "",
      source: "portal onboarding questionnaire",
      status: "draft",
    },
    palette: {
      navy: "",
      navy_2: "",
      cream: "",
      cream_2: "",
      // Seed the accent from the client's existing accent colour when present.
      gold: client?.accentColor ?? "",
      line: "",
      white: "#FFFFFF",
      near_black: "#0A0A0A",
      positive: "#22A06B",
      negative: "#C0392B",
      rule: "60/30/10: base, type/surface, accent. Accent never carries weight.",
    },
    fonts: {
      // Stacks default to safe system fallbacks (the renderer always has something to use);
      // the family + Google Fonts href stay blank so the client picks their real fonts.
      display: { family: "", stack: "Georgia, 'Times New Roman', serif", use: "H1, section heads, pull quotes" },
      body: { family: "", stack: "-apple-system, BlinkMacSystemFont, 'Segoe UI', Arial, sans-serif", use: "body, UI, buttons" },
      mono: { family: "", stack: "ui-monospace, Menlo, Consolas, monospace", use: "labels, kickers, numbers" },
      google_fonts_href: "",
    },
    logo: {
      inline_mark_svg: "",
      inline_mark_svg_inverse: "",
      wordmark: client?.name ?? "",
    },
    voice: {
      archetype: "",
      language: "en",
      hard_rules: ["No em dashes. No double dashes.", "No exclamation points."],
    },
    compliance: {
      _status: "",
      disclaimer_pt: "",
      regulatory_line: "",
      banned_extra: [],
      never: [],
    },
    sender: {
      from_name: "",
      from_email: "",
      reply_to: "",
      reason_line: "",
    },
    newsletter: {
      name: "",
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
      index_title: "",
      index_dek: "",
      meta_description: "",
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

/** An editorial foundation seeded with the two non-negotiable voice rules; rest blank. */
export function emptyFoundation(client?: Client): ContentFoundation {
  return {
    whoTheyAre: client?.description ?? "",
    audience: "",
    voiceRegister: "",
    voiceHardRules: ["No em dashes, en dashes, or double hyphens.", "No exclamation points."],
    pillars: [],
    seedTopics: [],
    keywordTargets: "",
    complianceConstraints: "",
    cadenceNotes: "",
  };
}

/** A complete starting config for a client with no newsletter doc yet. */
export function defaultNewsletterConfig(client: Client): NewsletterConfig {
  return {
    clientId: client.id,
    brand: emptyBrand(client),
    foundation: emptyFoundation(client),
    optIn: false,
    updatedAt: 0,
  };
}

/**
 * Merge a possibly-partial stored config over fresh defaults so the questionnaire always
 * gets a fully-shaped object (defends against docs created by the opt-in toggle alone, or
 * older docs missing newly-added keys).
 */
export function mergeNewsletterConfig(
  client: Client,
  stored: Partial<NewsletterConfig> | null | undefined,
): NewsletterConfig {
  const base = defaultNewsletterConfig(client);
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
