/**
 * Content Engine — native karosCMO port of the karos-labs e12 engine.
 *
 * These types mirror the per-client overlay the karos-labs pipeline kept on disk
 * (config.yaml + research/catalog.yaml + ledger.json), re-homed into Firestore so
 * the picker / QA / generation can run inside karosCMO. Pure type module — no
 * "server-only", so the ops seed script can import it too.
 */

/**
 * One topic in a client's catalog — the picker's menu. Don Techno short-key
 * schema (k/n/f/v/c); brand-specific extras (street, area, anchors…) flow
 * through untouched so the generator can use them.
 */
export interface CatalogEntry {
  /** key: dedup id + identity fingerprint — format prefix then DISTINCTIVE subject tokens. */
  k: string;
  /** name: the full topic line the generator works from. */
  n: string;
  /** format: resolves a template; one of ContentEngineConfig.formats. */
  f: string;
  /** viability 0-100 (from seeds.yaml topic_weights ×100). */
  v: number;
  /** confidence — picker tiebreak. */
  c?: "confirmed" | "likely" | "needs_research" | string;
  [extra: string]: unknown;
}

/** One produced post, recorded so the picker dedupes + cools down future picks. */
export interface LedgerEntry {
  subjectKey: string;
  displayName?: string;
  format: string;
  /** 1-based volume (= ledger length at produce time + 1). */
  vol: number;
  jobId?: string;
  assetId?: string;
  createdAt: number;
}

/** Picker tuning (was config.selection). */
export interface SelectionConfig {
  /** Rotate off the last-used format (bypassed when a pick is scoped to one format). */
  rotateFormats: boolean;
  /** Window of recent ledger entries to dedupe a subject against. */
  subjectCooldown: number;
  /** Token overlap with a recent subject that counts as "the same subject". */
  minSharedTokens: number;
  /** Optional override of the default stopword set used to fingerprint a subject. */
  stopwords?: string[];
}

/** Slide-shape bounds + role rules (was config.slides). */
export interface SlidesConfig {
  countMin: number;
  countMax: number;
  /** Allowed role for slide 1. */
  hookTypes: string[];
  /** At least one slide must carry one of these roles (if non-empty). */
  payoffTypes: string[];
  /** The last slide must carry one of these roles (if non-empty). */
  closerTypes: string[];
  /** Roles no slide may use. */
  bannedTypes: string[];
}

/** Web image-sourcing rules (was config.sourcing + media.image). */
export interface SourcingConfig {
  /** Minimum long-edge px a candidate photo must have. */
  minLongEdge: number;
  /** Acceptable width/height ratio window. */
  aspectMin: number;
  aspectMax: number;
  /** Domains to reject (watermark/stock sites). Defensive — clean providers won't hit these. */
  blockedDomains: string[];
}

/** Lintable voice rules QA enforces (was config.voice). */
export interface VoiceConfig {
  tone?: string;
  bannedWords: string[];
  bannedChars: {
    emoji?: boolean;
    exclamation?: boolean;
    /** Checks U+2014 (—) and the markdown triple-dash --- that renders as one. */
    emDash?: boolean;
    semicolon?: boolean;
  };
  hashtags: { count: number; case: "lowercase" | "uppercase" | "none" };
  /** Must appear VERBATIM in posted copy (diacritics + punctuation exact). */
  requiredDisclaimer?: string;
  /**
   * When true (karos-labs `qa.require_disclaimer_on_number`), the disclaimer is
   * only required on posts that state a number — number-free posts are exempt.
   * When false/absent, the disclaimer is required on every post.
   */
  requireDisclaimerOnNumber?: boolean;
  /** At most one distinct number in posted copy (disclaimer numbers exempt). */
  oneNumberPerPost?: boolean;
}

/** The per-client content-engine config — Firestore: contentEngineConfigs/{clientId}. */
export interface ContentEngineConfig {
  clientId: string;
  formats: string[];
  selection: SelectionConfig;
  slides: SlidesConfig;
  voice: VoiceConfig;
  sourcing?: SourcingConfig;
  canvas?: { w: number; h: number; ratio?: string };
  /**
   * Brand stance: real photography only — no AI-generated imagery (XO:
   * media.real_only). The engine sources real web photos (Apify), so this is
   * satisfied; it's surfaced for the operator and future provider choices.
   */
  realImageryOnly?: boolean;
  updatedAt: number;
}

/** A client's topic catalog — Firestore: contentCatalogs/{clientId}. */
export interface ContentCatalog {
  clientId: string;
  entries: CatalogEntry[];
  updatedAt: number;
}

/** One generated carousel slide. */
export interface CarouselSlide {
  /** Slide role — gated against SlidesConfig (hook/split/list/quote/stat/body/closer…). */
  role: string;
  /** Display headline (Fraunces hook / slide title). */
  headline: string;
  /** Supporting body copy, or null for a pure-headline slide. */
  body: string | null;
  /** Concise search keywords for a REAL photo to pull from the web — NOT published copy. */
  imageQuery: string;
  /** Resolved image URL once sourced (web photo → Firebase Storage). */
  imageUrl?: string | null;
  /** Credit line for the sourced photo (e.g. "Photo via example.com"). */
  attribution?: string | null;
}

/** The picker's choice. */
export interface PickResult {
  entry: CatalogEntry;
  nextVol: number;
  subjectKey: string;
  displayName: string;
  format: string;
  viability: number;
  confidence: string;
}
