/**
 * Newsletter + Blog Engine — native karosCMO port of the karos-labs e11 engine.
 *
 * These types mirror the two per-client config files the karos-labs pipeline kept on
 * disk (the brand JSON `scripts/newsletter/brands/<slug>.json` + the editorial
 * `CONTENT-FOUNDATION.md`), re-homed into a single Firestore doc so the onboarding
 * questionnaire can write them and the generator can read them inside karosCMO.
 *
 * Pure type module — no "server-only", so the questionnaire (client component) can
 * import the brand-readiness check and the future seed/run can import it too.
 *
 * `NewsletterBrand` keeps the engine's exact JSON shape (palette/fonts/logo names are
 * slots — values are the client's). Bucket C (past newsletters + image pool) is NOT
 * here: it reuses the existing `ContextItem` collection, tagged via `purpose`.
 */

/** Colour slots — names are fixed, hex values are the client's (need not be navy/cream/gold). */
export interface BrandPalette {
  navy: string;
  navy_2: string;
  cream: string;
  cream_2: string;
  gold: string;
  line: string;
  white: string;
  near_black: string;
  positive: string;
  negative: string;
  /** The colour-usage rule, e.g. "60/30/10: base, type/surface, accent." */
  rule: string;
}

export interface BrandFont {
  family: string;
  /** Full CSS font-stack with fallbacks — what the renderers actually use (required by the gate). */
  stack: string;
  use: string;
}

export interface BrandFonts {
  display: BrandFont;
  body: BrandFont;
  mono: BrandFont;
  /** Google Fonts <link> href that loads the three families above. */
  google_fonts_href: string;
}

export interface BrandLogo {
  /** Inline SVG mark, dark/navy version. */
  inline_mark_svg: string;
  /** Inline SVG mark, light/inverse version (for the light theme). */
  inline_mark_svg_inverse: string;
  wordmark: string;
}

export interface BrandVoice {
  /** Brand persona, e.g. "Senior advisor who has seen every cycle. Challenger, not arrogant." */
  archetype: string;
  language: string;
  hard_rules: string[];
}

export interface BrandCompliance {
  /** Note on whether the disclaimer is client-confirmed + any open legal questions. */
  _status?: string;
  /**
   * Locked legal/educational footer in the client's language. The compliance gate
   * NEVER scans this field (it legitimately says "not advice" etc.). Field name kept
   * from the engine (`disclaimer_pt`).
   */
  disclaimer_pt: string;
  /** Regulatory identifiers / company registration line, or "" if none. */
  regulatory_line: string;
  /** Client-specific literal phrases the deterministic gate must also block. */
  banned_extra: string[];
  /** Client-specific phrases that must never appear (e.g. promised returns for a fintech). */
  never: string[];
}

export interface BrandSender {
  from_name: string;
  from_email: string;
  reply_to: string;
  /** The "why you got this" line in the client's language. */
  reason_line: string;
}

export interface BrandCta {
  label: string;
  url: string;
}

/** Localised UI labels the newsletter renderer prints (default EN; pt-BR etc. set per client). */
export interface NewsletterLabels {
  subject_ab: string;
  data: string;
  source: string;
  takeaways: string;
}

export interface BrandNewsletter {
  name: string;
  cadence: string;
  send_day: string;
  /** Reminder that the client sends from their own ESP; Karos never sends. */
  host_note?: string;
  default_cta: BrandCta;
  labels: NewsletterLabels;
}

/** Localised UI labels for the blog index/article chrome. */
export interface BlogUiLabels {
  kicker_prefix: string;
  featured: string;
  all_articles: string;
  read_min: string;
  read_min_short: string;
  read_more: string;
  article: string;
  articles: string;
}

export interface BrandBlog {
  index_title: string;
  index_dek: string;
  meta_description: string;
  ui: BlogUiLabels;
}

export interface BrandMeta {
  /** Slug / id this brand belongs to (the karosCMO clientId). */
  client_id: string;
  company_name: string;
  /** Where the brand truth came from (brand guide, site, questionnaire). */
  source?: string;
  status?: string;
}

/** Bucket A — the visual/identity layer (engine JSON shape). */
export interface NewsletterBrand {
  _meta: BrandMeta;
  palette: BrandPalette;
  fonts: BrandFonts;
  logo: BrandLogo;
  voice: BrandVoice;
  compliance: BrandCompliance;
  sender: BrandSender;
  newsletter: BrandNewsletter;
  site_url: string;
  /** BCP-47 code: "en", "pt-BR", "es"… drives <html lang> + UI labels. */
  locale: string;
  blog: BrandBlog;
}

/**
 * Bucket B — the editorial brain (was `CONTENT-FOUNDATION.md`). Structured here so the
 * questionnaire edits fields; `composeFoundationMarkdown` renders the §-numbered doc the
 * agent reads. List fields are raw lines (each a "Pillar — note" / "Topic — pillar").
 */
export interface ContentFoundation {
  /** §1 — one paragraph: what they do/sell, what makes them different. */
  whoTheyAre: string;
  /** §1 — who reads this, their level, what they decide on. */
  audience: string;
  /** §2 — dominant register: formal / conversational / challenger / warm. */
  voiceRegister: string;
  /** §2 — hard voice rules (sentence length, how to open, banned buzzwords). */
  voiceHardRules: string[];
  /** §3 — the 4-6 themes the client wants to be known for (one per line). */
  pillars: string[];
  /** §4 — 8-15 concrete seed topics (one per line, tagged to a pillar). */
  seedTopics: string[];
  /** §5 — keyword/GEO clusters + reader questions for the blog. */
  keywordTargets: string;
  /** §6 — legal/ethical constraints (mirror the strict ones into brand.compliance.never). */
  complianceConstraints: string;
  /** §7 — cadence notes / seasonal exceptions. */
  cadenceNotes: string;
}

/**
 * The per-client newsletter+blog config — Firestore: newsletterConfigs/{clientId}.
 * Holds both buckets A & B plus the opt-in cost guard (enforced by the scheduler later).
 */
export interface NewsletterConfig {
  clientId: string;
  brand: NewsletterBrand;
  foundation: ContentFoundation;
  /** G0 cost guard — only opted-in clients are ever run by the weekly job. */
  optIn?: boolean;
  updatedAt: number;
}
