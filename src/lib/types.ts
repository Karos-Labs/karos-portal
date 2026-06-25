/**
 * Karos CMO — shared domain types.
 * These mirror the Firestore collections. Timestamps are stored as epoch millis (number)
 * for trivial JSON-serialisation between server and client components.
 */

export type Role = "admin" | "employee" | "client";

export interface AppUser {
  uid: string;
  email: string;
  name: string;
  role: Role;
  photoURL?: string | null;
  /** For role=client — the client account this user belongs to. */
  clientId?: string | null;
  /** For role=employee — clients this employee is assigned to. */
  assignedClientIds?: string[];
  disabled?: boolean;
  /** Client users only: can manage team members within their own client group. */
  isGroupAdmin?: boolean;
  /** The role this person picked at self-signup (advisory — an admin sets the real `role`). */
  requestedRole?: "employee" | "client";
  /** For client self-signups — the company/brand they typed, before being linked to a real Client. */
  requestedClientName?: string;
  /** Set when an admin approves the account. Absent + disabled ⇒ a pending registration. */
  approvedAt?: number | null;
  createdAt: number;
  lastLoginAt?: number;
}

export interface Client {
  id: string;
  name: string;
  website?: string;
  industry?: string;
  /** Primary contact email — also used to auto-route Fireflies transcripts & deliver assets. */
  contactEmail?: string;
  /** Email domains owned by the client, used to auto-assign meeting transcripts. */
  domains?: string[];
  description?: string;
  brandVoice?: string;
  logoUrl?: string;
  accentColor?: string;
  brandingGuidelines?: BrandingGuidelines;
  assignedEmployeeIds: string[];
  status: "active" | "paused" | "archived";
  createdAt: number;
  createdBy: string;
}

/** A field collected from the user before an agent runs. */
export interface AgentField {
  key: string;
  label: string;
  type: "text" | "textarea" | "number" | "select";
  placeholder?: string;
  required?: boolean;
  options?: string[];
  defaultValue?: string;
}

export type AgentCapability =
  | "generate" // produce text/structured content
  | "generate_images" // generate a real image per Instagram post from its visual brief
  | "email_client" // deliver the result to the client by email
  | "create_assets" // persist outputs to the client's asset library
  | "use_transcripts" // ground the run on the client's meeting transcripts
  | "use_brand_voice"; // ground the run on the client's brand voice

/** An "agent" is a reusable skill that employees build inside the app. */
export interface Agent {
  id: string;
  name: string;
  description: string;
  /** lucide icon name, e.g. "Instagram" */
  icon: string;
  color: string;
  /** Anthropic model id. */
  model: string;
  systemPrompt: string;
  /** Structured-output contract the agent should produce (freeform guidance for the model). */
  outputKind: "instagram_posts" | "email" | "article" | "social_posts" | "freeform";
  fields: AgentField[];
  capabilities: AgentCapability[];
  /** Lifecycle: drafts are in-development (test-only); published agents are live & runnable. */
  status: "draft" | "published";
  /** Only meaningful once published — pause/resume runnability. */
  isActive: boolean;
  /** When true, available to every employee. Only meaningful once published. */
  shared: boolean;
  createdBy: string;
  createdAt: number;
  updatedAt: number;
  runCount?: number;
  /** Provenance + idempotency key when seeded from the karos-labs skill library (see labs-import.ts). */
  labsSkillId?: string;
  /**
   * When true: this is an internal Karos system agent (e.g. the Intel Report Agent).
   * Hidden from client-facing views; visible to admins for configuration.
   */
  isSystem?: boolean;
}

export type JobStatus =
  | "queued"
  | "running"
  | "review" // output ready, awaiting employee/client review
  | "approved"
  | "delivered"
  | "failed";

export interface JobRunEvent {
  at: number;
  level: "info" | "error" | "success";
  message: string;
}

export interface Job {
  id: string;
  clientId: string;
  agentId: string;
  agentName: string;
  title: string;
  status: JobStatus;
  input: Record<string, string>;
  /** Raw model output (text) for auditing. */
  rawOutput?: string;
  assetIds: string[];
  emailedTo?: string | null;
  events: JobRunEvent[];
  error?: string | null;
  createdBy: string;
  assignedTo?: string | null;
  createdAt: number;
  updatedAt: number;
}

export type AssetType =
  | "instagram_post"
  | "email"
  | "article"
  | "social_post"
  | "note";

export interface Asset {
  id: string;
  clientId: string;
  jobId?: string | null;
  agentId?: string | null;
  type: AssetType;
  title: string;
  /** Main body (caption / article / email body). */
  content: string;
  /** Extra structured bits e.g. hashtags, image concept, subject line. */
  meta?: Record<string, unknown>;
  /** Public URL of the generated visual (Vercel Blob), when one exists. */
  imageUrl?: string | null;
  status: "draft" | "approved" | "delivered" | "published";
  createdBy: string;
  createdAt: number;
  updatedAt: number;
}

/**
 * A piece of reference material attached to a client (uploaded by an employee) that
 * agents automatically use when running for that client.
 */
export interface ContextItem {
  id: string;
  clientId: string;
  /** image = png/jpeg/webp/gif; document = pdf; text = txt/md/csv; other = stored, not sent to model. */
  kind: "image" | "document" | "text" | "other";
  /** Original filename. */
  name: string;
  mimeType: string;
  sizeBytes: number;
  /** Bucket object path (for deletion). */
  storagePath: string;
  /** Durable public download URL. */
  url: string;
  /** Optional employee description to guide the agent ("primary product shot"). */
  note?: string;
  createdBy: string;
  createdAt: number;
}

/**
 * A personal access token an employee uses to drive the app from an external MCP
 * client (e.g. their own Claude Code). Only the SHA-256 hash is stored; the
 * plaintext is shown once at creation.
 */
export interface AccessToken {
  id: string;
  /** Owning user. */
  uid: string;
  /** Human label, e.g. "MacBook Claude Code". */
  name: string;
  /** First chars of the plaintext token, for display ("karos_pat_ab12…"). */
  prefix: string;
  /** SHA-256 hex of the full plaintext token. */
  tokenHash: string;
  createdAt: number;
  lastUsedAt?: number | null;
  revoked?: boolean;
}

/* ─────────────────────── Intelligence Report ────────────────────────── */

export interface DimensionScore {
  dimension: string;
  /** Integer 0-100, e.g. 20 for 20% */
  weight: number;
  score: number;
}

export interface CompetitorRanking {
  company: string;
  score: number;
  grade: string;
  rank: number;
  bestDimension: string;
  weakestDimension: string;
}

export interface Recommendation {
  number: number;
  title: string;
  description: string;
  priority: number;
  priorityLabel: string;
  /** e.g. "Content", "Brand", "SEO" */
  tag: string;
}

export interface SWOTMatrix {
  strengths: string[];
  weaknesses: string[];
  opportunities: string[];
  threats: string[];
}

export interface BrandVoiceRow {
  dimension: string;
  scores: Record<string, string>;
}

export interface CustomerSentimentEntry {
  company: string;
  rating?: string;
  ratingLabel?: string;
  responseTime?: string;
  wouldReturn?: string;
}

export interface BrandingGuidelines {
  primaryColor?: string;
  secondaryColor?: string;
  fontHeading?: string;
  fontBody?: string;
  toneKeywords?: string[];
  logoUrl?: string;
  /** Free-form markdown guidelines text */
  guidelines?: string;
  /**
   * Inferred or manually set visual aesthetic.
   * Set by the website scraper; can be overridden in the branding modal.
   * E.g. "Minimalist" | "Dark Mode" | "High-Tech" | "Corporate" | "Vibrant" | "Luxury"
   */
  visualStyle?: string;
  updatedAt: number;
}

/** Parsed Digital Intelligence & Competitive Report — one per client. */
export interface ClientReport {
  id: string;
  clientId: string;
  reportDate: string;
  // Company profile extras (from the report, beyond what Client already stores)
  url?: string;
  businessType?: string;
  founded?: string;
  authorization?: string;
  cnpj?: string;
  minInvestment?: string;
  techStack?: string;
  reportStatus?: string;
  // Scores
  overallScore: number;
  overallGrade: string;
  dimensionScores: DimensionScore[];
  competitorRankings: CompetitorRanking[];
  // Full section text (markdown) for each dimension modal
  contentAnalysis: string;
  conversionAnalysis: string;
  seoAnalysis: string;
  geoAnalysis: string;
  positioningAnalysis: string;
  brandAnalysis: string;
  growthAnalysis: string;
  // SWOT + recommendations
  swot: SWOTMatrix;
  recommendations: Recommendation[];
  // Brand voice comparison table
  brandVoiceRows?: BrandVoiceRow[];
  brandVoiceArchetypes?: Array<{ company: string; archetype: string }>;
  brandVoiceTerritory?: string;
  // Customer sentiment (Reclame Aqui + whitespace)
  customerSentiment?: CustomerSentimentEntry[];
  whitespaceOpportunities?: string[];
  // Storage
  rawMarkdown: string;
  reportHtml?: string;
  pdfUrl?: string;
  createdAt: number;
  updatedAt: number;
}

/** A competitor parsed from the report or manually added. */
export interface ClientCompetitor {
  id: string;
  clientId: string;
  company: string;
  url?: string;
  founded?: string;
  marketTier: "Leader" | "Challenger" | "Niche" | "Other";
  minInvestment?: string;
  overlap: "High" | "Medium" | "Low-Med" | "Low";
  deepDive: boolean;
  positioning?: string;
  scale?: string;
  keyStrengths: string[];
  keyWeaknesses: string[];
  threatLevel?: "HIGH" | "MEDIUM" | "LOW";
  /** "report" = imported from MD; "manual" = added by an employee */
  source: "report" | "manual";
  createdAt: number;
  updatedAt: number;
}

/* ────────────────── Client Context Documents ────────────────────────── */

export type ContextDocType =
  | "brand-voice"
  | "market-strategy"
  | "competitor-analysis"
  | "product-information"
  | "branding-guidelines"
  | "client-guidelines"
  | "action-plan"
  | "meeting-notes";

/** Three-tier no-leak boundary. */
export type ContextDocTier = "internal" | "client" | "internal-only";

/**
 * A living context document generated by the onboarding pipeline.
 * Stored in the `clientContextDocs` Firestore collection.
 *
 * Tier rules:
 *   internal      — full analyst-grade markdown; admin/employee only
 *   client        — condensed ~50% derivative; safe for client-role users
 *   internal-only — never published (client-guidelines, action-plan)
 */
export interface ClientContextDoc {
  id: string;
  clientId: string;
  docType: ContextDocType;
  tier: ContextDocTier;
  /** Markdown content. */
  content: string;
  /** Monotonically increasing integer; bump on every write. */
  version: number;
  /** Named sources cited (for "no guessed numbers" audit trail). */
  sources?: string[];
  createdAt: number;
  updatedAt: number;
}

/* ────────────────────────────────────────────────────────────────────── */

export interface Transcript {
  id: string;
  title: string;
  source: "fireflies" | "manual";
  /** External id from Fireflies. */
  externalId?: string;
  clientId?: string | null;
  /** "auto" when matched by domain, "manual" when an employee assigned it. */
  assignment?: "auto" | "manual" | "unassigned";
  meetingDate?: number;
  durationMin?: number;
  participants: string[];
  rawText: string;
  summary?: string;
  actionItems?: string[];
  /** Action items grouped by owner name. Snapshot used for display; actionItemOwners[] is the authoritative per-item structure. */
  actionItemsByOwner?: Record<string, string[]>;
  /** Per-item owner name, parallel to actionItems[]. null = unassigned. */
  actionItemOwners?: (string | null)[];
  /** Maps ownerName → userId for auto-matched users (first-name, unambiguous match only). */
  actionItemUserMap?: Record<string, string>;
  keywords?: string[];
  /** Indices of action items the team has marked complete (persisted to Firestore). */
  completedItems?: number[];
  /** True when the meeting has been archived (manually or auto when all items done). */
  archived?: boolean;
  /**
   * When true: completely hidden from all client-role sessions even if clientId is set.
   * Staff (admin/employee) always see it. Admin-only toggle.
   */
  hiddenFromClient?: boolean;
  /**
   * When true: this is a Karos Labs internal meeting, not associated with any external client.
   * Mutually exclusive with clientId — assignment sets clientId to null.
   */
  isKarosInternal?: boolean;
  /** Epoch millis when this transcript was last pushed as a meeting signal to clientContextDocs. */
  contextDocSignalAt?: number;
  createdAt: number;
}
