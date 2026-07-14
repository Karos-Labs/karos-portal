/**
 * Karos CMO — shared domain types.
 * These mirror the Firestore collections. Timestamps are stored as epoch millis (number)
 * for trivial JSON-serialisation between server and client components.
 */

/**
 * Platform roles stored in the `users` Firestore collection.
 * KAROS_ADMIN / KAROS_EMPLOYEE are internal staff; CLIENT_USER is an end-client.
 * Role assignment is purely DB-driven — no env-var bootstrap (except the very first user).
 */
export type Role = "KAROS_ADMIN" | "KAROS_EMPLOYEE" | "CLIENT_USER";

export interface AppUser {
  uid: string;
  email: string;
  name: string;
  role: Role;
  photoURL?: string | null;
  /** For role=CLIENT_USER — the client account this user belongs to. */
  clientId?: string | null;
  /** For role=KAROS_EMPLOYEE — clients this employee is assigned to. */
  assignedClientIds?: string[];
  disabled?: boolean;
  /** CLIENT_USER only: can manage team members within their own client group. */
  isGroupAdmin?: boolean;
  /** Advisory: the role requested at self-signup (KAROS_EMPLOYEE sign-ups go to Registrations queue). */
  requestedRole?: "KAROS_EMPLOYEE" | "CLIENT_USER";
  /** Legacy: company name typed at signup (pre-clientKeyId era). */
  requestedClientName?: string;
  /** Set when staff approves the account. Absent + disabled ⇒ pending registration. */
  approvedAt?: number | null;
  createdAt: number;
  lastLoginAt?: number;
  /**
   * Transient, never persisted: set by auth when a KAROS_ADMIN is viewing as
   * this client user ("View as Client"). Charge gates use it so impersonated
   * sessions never spend the client's real credits.
   */
  impersonatedBy?: string;
}

/** Client-editable social handles / profile URLs. */
export interface SocialLinks {
  instagram?: string;
  linkedin?: string;
  x?: string;
  tiktok?: string;
  youtube?: string;
  facebook?: string;
  website?: string;
}

export interface Client {
  id: string;
  name: string;
  website?: string;
  industry?: string;
  /** Client-editable market category / vertical (self-reported). */
  category?: string;
  /** Client-editable team-size bucket, e.g. "1–10". */
  teamSize?: string;
  /** AI-generated 2-sentence company brief (from context docs). Generated once, cached. */
  brief?: string;
  /** Client-editable social handles / profile URLs. */
  socialLinks?: SocialLinks;
  /** Primary contact email — also used to auto-route Fireflies transcripts & deliver assets. */
  contactEmail?: string;
  /** Email domains owned by the client, used to auto-assign meeting transcripts. */
  domains?: string[];
  description?: string;
  brandVoice?: string;
  logoUrl?: string;
  /** Firebase Storage path for the client logo — used to delete the old file on replacement. */
  logoStoragePath?: string;
  accentColor?: string;
  brandingGuidelines?: BrandingGuidelines;
  assignedEmployeeIds: string[];
  status: "active" | "paused" | "archived";
  /**
   * Cryptographically random join token (128-bit base64url). New CLIENT_USER accounts must
   * supply a valid clientKeyId at signup to be auto-approved and linked to this client.
   * Only staff with access to this client page can see / regenerate the key.
   */
  clientKeyId?: string;
  /**
   * Tracks the background onboarding pipeline kicked off by createClientAction.
   * Absent on legacy clients (created before this field was added).
   *   pending  — pipeline queued but not yet started
   *   running  — at least one pipeline stage is executing
   *   done     — all stages completed successfully
   *   failed   — one or more stages threw; check server logs for details
   */
  onboardingStatus?: "pending" | "running" | "done" | "failed";
  /** Human-readable reason for the last onboarding failure (truncated). Cleared when a new run starts. */
  onboardingError?: string;
  /**
   * This client's folder slug in the karos-agents lab repo (clients/<slug>/).
   * Used by the external agent service to load the client's profile + emitted
   * sub-skills. Absent ⇒ jobs run against client_context/ only.
   */
  agentsRepoSlug?: string;
  /**
   * CustomAgent ids this client's users may run themselves (billed in
   * credits). Managed by admins from the client settings page; absent/empty ⇒
   * the client sees no runnable agents.
   */
  customAgentIds?: string[];
  createdAt: number;
  createdBy: string;
}

/* ─────────────────────── Client Access Requests ────────────────────────── */

/**
 * Submitted when a prospective client does NOT have a clientKeyId and wants Karos
 * staff to set up their account manually. Stored in the `clientRequests` collection.
 */
export interface ClientRequest {
  id: string;
  companyName: string;
  website?: string;
  /** Email of the person who should become the primary admin for that client. */
  adminEmail: string;
  useCase: string;
  status: "PENDING_APPROVAL" | "APPROVED" | "REJECTED";
  submittedAt: number;
  reviewedAt?: number;
  reviewedBy?: string;
  /** Notes left by a Karos staff member when approving/rejecting. */
  reviewNotes?: string;
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

/** Task types the external agent service (agent-service/) can run. */
export type ManagedTaskType = "social_post" | "newsletter_issue" | "blog_article" | "landing_page" | "custom";

/**
 * A platform-defined agent: a stored system prompt bound to an entry skill in
 * the karos-agents repo, runnable through the agent service's "custom" task
 * type with a free-text prompt. Created by admins — imported from the repo's
 * catalog (catalog/agent-runtime-manifest.json) or written by hand. Clients
 * may run one only when its id is in their Client.customAgentIds allowlist.
 */
export interface CustomAgent {
  id: string;
  /** Stable slug (the repo skill_name for imports), unique across agents. */
  key: string;
  name: string;
  description: string;
  /** lucide icon name (see components/icon.tsx). */
  icon: string;
  /** Badge/chip hex color. */
  color: string;
  /** Repo-relative entry skill directory, e.g. "products/live/instagram-agent". */
  entrySkillDir: string;
  /** Extra repo-relative skill roots linked into the run (vendor packs). */
  skillRoots: string[];
  /** Also link the client's emitted skills (clients/<slug>/skills/). */
  includeClientSkills: boolean;
  /** The agent's system-prompt text, appended after the service's common preamble. */
  instructions: string;
  /** Per-run price for billable client actors; null ⇒ CREDIT_COSTS.customAgentRun. */
  creditCost?: number | null;
  /** Hidden from run surfaces when false (still editable by admins). */
  enabled: boolean;
  /** Import provenance (absent on hand-written agents). */
  source?: {
    path: string;
    /** Runtime-manifest status at import time (ready / blocked / unreviewed). */
    status?: string;
    repoSha?: string;
  } | null;
  createdBy: string;
  createdAt: number;
  updatedAt: number;
}

/** One deliverable file produced by an external agent-service job. */
export interface ExternalJobArtifact {
  name: string;
  /** agents-repo-relative path the agent wrote (provenance). */
  path: string;
  bytes: number;
  sha256: string;
  contentType?: string;
  /** Per the lab contract, only files under an outputs client/ folder are client-visible. */
  clientFacing: boolean;
  /** Platform-hosted URL (client-facing, re-hosted) or service URL (internal). */
  url?: string;
}

/** Provenance + results of a job executed by the external agent service. */
export interface ExternalJobInfo {
  serviceJobId: string;
  taskType: ManagedTaskType;
  /** karos-agents commit the job ran against. */
  agentsRepoSha?: string;
  model?: string;
  /** SDK cost estimate; token counts are the authoritative record. */
  totalCostUsd?: number;
  inputTokens?: number;
  outputTokens?: number;
  artifacts?: ExternalJobArtifact[];
  transcriptUrl?: string;
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
  /** Present when this job runs on the external agent service. */
  external?: ExternalJobInfo;
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

/**
 * Three-tier publishing flow for scheduled content:
 *   auto        — the publish cron pushes to the platform API at scheduledAt
 *                 (requires a connected integration with autoPublish enabled)
 *   manual      — lives on the calendar; a user triggers "Publish Now" through
 *                 the platform API when they choose
 *   placeholder — calendar-only roadmap item; Karos never touches the
 *                 client's social accounts for it
 * Legacy assets (scheduled before this field existed) are treated as "auto".
 */
export type PublishMode = "auto" | "manual" | "placeholder";

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
  /**
   * MIME type of the primary downloadable payload, when the asset is a binary file
   * (e.g. "image/jpeg", "video/mp4"). Drives the native download action's format +
   * extension. Absent ⇒ derive from type/imageUrl (image) or fall back to text.
   */
  mimeType?: string;
  /**
   * Distribution channels for this asset — platform ids copied from the generating
   * agent (Agent.channels) at creation. Advisory: pre-selects the target platform in
   * the approve/schedule flow and is surfaced in the calendar detail modal.
   */
  channels?: string[];
  status: "draft" | "approved" | "delivered" | "published" | "scheduled";
  /**
   * Epoch millis — the designated publication slot. Set when an asset is scheduled OR
   * approved onto the calendar. The auto-publish cron pushes it once this time passes
   * (publishMode "auto" only), for both "scheduled" and "approved" assets.
   */
  scheduledAt?: number;
  /** Which platform to publish to (matches ClientIntegration.platform). */
  scheduledPlatform?: string;
  /** How this asset reaches the platform once scheduled. Absent on legacy assets ⇒ "auto". */
  publishMode?: PublishMode;
  /**
   * Agent-recommended optimal publish time (epoch millis), stamped at generation.
   * Advisory only — becomes real once a user schedules the asset (it pre-fills the
   * schedule form and renders as a "suggested" chip on the calendar).
   */
  recommendedAt?: number;
  /** One-line rationale for recommendedAt, e.g. "LinkedIn engagement peaks Tue–Thu mornings". */
  recommendedReason?: string;
  /** Epoch millis when the asset was actually pushed to a platform (auto cron or Publish Now). */
  publishedAt?: number;
  /** Last publish failure (manual or cron), surfaced on the asset card. Cleared on success. */
  publishError?: string;
  /**
   * Epoch millis when a publish attempt claimed this asset. Set transactionally by
   * `claimAssetForPublish` so the auto-cron, a manual "Publish Now", or two overlapping
   * cron ticks can never double-post the same asset. Cleared on success or failure; a
   * stale claim (older than the claim TTL) can be re-taken so a crashed run never wedges.
   */
  publishClaimedAt?: number;
  /**
   * Stable slug identifying the template/format that produced this post
   * (e.g. "by-the-numbers", or the managed taskType for agent-service posts).
   * Derived at creation from the lab item folder / data.json / managed product;
   * backfilled on legacy assets by the re-date migration. Renders as a chip.
   */
  templateKey?: string;
  /** Human chip label for templateKey (e.g. "By The Numbers", "Social posts"). Always paired with templateKey. */
  templateName?: string;
  /**
   * Lexicographically sortable internal-generation-order key driving the
   * one-post-per-day content chain. Lab imports: `${runName}#${itemKey}`
   * (run names lead with YYYY-MM-DD; item keys keep their zero-padded/ISO-date
   * prefix). Other sources: `${ISO-timestamp}#${uniq}`. Both forms lead with a
   * sortable date so cross-source sorting interleaves chronologically. Legacy
   * assets without one are covered by deriveOrderKey() fallbacks at read time.
   */
  orderKey?: string;
  /**
   * DERIVED ONLY — never persisted to Firestore. Set true by the client-facing
   * redaction layer (redactLockedAsset) on copies of future-dated assets so
   * client components can render the locked-placeholder treatment.
   */
  locked?: boolean;
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
  /**
   * What this file is for, when it was attached for a specific engine. Absent ⇒ general
   * agent context. The newsletter engine uses these to find voice anchors vs hero images:
   * `newsletter_reference` = a past newsletter (voice match); `image_pool` = a hero image.
   */
  purpose?: "newsletter_reference" | "image_pool";
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

/**
 * A single entry in the brand's dominant color palette.
 * Colors are ordered strictly by visual dominance (rank 1 = most prominent).
 */
export interface BrandColor {
  /** 6-digit lowercase hex, e.g. "#e91e8c". */
  hex: string;
  /** 1 = most dominant/signature, 2 = supporting, etc. */
  dominanceRank: number;
  /** Optional semantic role if unambiguous, e.g. "Logo fill", "Primary CTA". */
  role?: string;
}

export interface BrandingGuidelines {
  /**
   * Dynamic palette: up to 4 dominant brand colors ordered strictly by visual
   * dominance (rank 1 = most prominent). Slots left empty when a brand genuinely
   * uses fewer colors — never padded with hallucinated values.
   * Prefer this field over the legacy scalar color fields.
   */
  dominantColors?: BrandColor[];
  // Legacy scalar color fields — kept for Firestore backward compatibility.
  // New writes always populate dominantColors; these are mirrored from it.
  /** @deprecated Use dominantColors[0].hex */
  primaryAccent?: string;
  /** @deprecated Use dominantColors[1].hex */
  secondaryAccent?: string;
  /** @deprecated Use dominantColors[2].hex */
  brandNeutralDark?: string;
  /** @deprecated Use dominantColors[3].hex */
  brandNeutralLight?: string;
  /** @deprecated Use primaryAccent */
  primaryColor?: string;
  /** @deprecated Use secondaryAccent */
  secondaryColor?: string;
  /** @deprecated Use brandNeutralDark / brandNeutralLight */
  uiBackground?: string;
  /** @deprecated Use brandNeutralDark / brandNeutralLight */
  uiText?: string;
  fontHeading?: string;
  fontBody?: string;
  toneKeywords?: string[];
  logoUrl?: string;
  /** Firebase Storage path for the uploaded logo — used to delete old files on replacement. */
  logoStoragePath?: string;
  /** Free-form markdown: Brand Voice, Do's, Don'ts. */
  guidelines?: string;
  /** Visual aesthetic archetype. E.g. "Minimalist" | "Dark Mode" | "High-Tech" | "Corporate" | "Vibrant" | "Luxury" */
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
  | "target-audience"
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
  /** Persisted executive summary bullets; generated on demand via Claude Haiku. */
  summary?: string[] | null;
  /** doc.version at which the summary was generated; used to detect stale cache. */
  summaryVersion?: number | null;
  createdAt: number;
  updatedAt: number;
}

/* ─────────────────────── Activity Timeline ─────────────────────────── */

export type ActivityEventType =
  | "SCRAPE"
  | "INTEL_GENERATION"
  | "CAMPAIGN_CREATED"
  | "CAMPAIGN_DELIVERED"
  | "COMPETITOR_ADDED"
  | "COMPETITOR_ANALYZED"
  | "CONTEXT_DOC_UPDATED"
  | "MANUAL_NOTE"
  | "CLIENT_CREATED"
  | "BRANDING_UPDATED";

export interface ActivityLog {
  id: string;
  clientId: string;
  timestamp: number;
  type: ActivityEventType;
  title: string;
  description?: string;
  /** Display name: "System AI", "Tomer H.", etc. */
  actor: string;
  actorRole: "system" | "staff" | "client";
  metadata?: Record<string, unknown>;
}

/* ─────────────────────── Agent Feedback Store ───────────────────────── */

/**
 * Generic feedback / correction log written whenever a client or staff member
 * provides verified corrections to agent-generated content.
 * Intentionally agent-agnostic — any agent can write rows here.
 */
export interface Feedback {
  id: string;
  /** Which agent generated the content being corrected (e.g. "intel-report-agent"). */
  agentId: string;
  /** The client whose generated data is being corrected. */
  clientId: string;
  /** The raw correction text exactly as submitted. */
  feedbackText: string;
  /** Optional: which context doc type the correction targets (e.g. "brand-voice"). */
  docType?: string;
  /**
   * single_doc — correction applied to one specific document.
   * global    — correction applied across all documents for this client.
   */
  scope: "single_doc" | "global";
  createdAt: number;
  /** UID of the user who submitted the correction. */
  createdBy: string;
  creatorRole: "staff" | "client";
}

/* ─────────────────────── Social Integrations ────────────────────────── */

export interface ClientIntegration {
  id: string;
  clientId: string;
  /** Matches PlatformConfig.id, e.g. "instagram" */
  platform: string;
  /** Display name / handle of the connected account (e.g. "@karoslabs") */
  accountName?: string;
  /** Credential key→value pairs matching the platform's field keys */
  credentials: Record<string, string>;
  /** "manual" = keys pasted by a staff member; "oauth" = OAuth flow */
  method: "manual" | "oauth";
  /**
   * "active" (default / absent) — credentials are valid and operational.
   * "expired" — the publish cron received a 401/403; re-connect required.
   */
  status?: "active" | "expired";
  /**
   * When true (default / absent), the publish cron may auto-post scheduled content
   * to this platform. When false, content targeting this platform can only go out
   * via a manual "Publish Now" click — the cron skips it.
   */
  autoPublish?: boolean;
  /** Epoch millis when the cron first detected the token had expired. */
  expiredAt?: number;
  connectedBy: string;
  connectedAt: number;
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
  /** Per-item explicit user ID assignment, parallel to actionItems[]. Drives the notification system. */
  actionItemAssignedUserIds?: (string | null)[];
  /** Denormalised flat array of all unique user IDs assigned to any action item. Enables Firestore array-contains queries. */
  assignedUserIds?: string[];
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

/* ─────────────────── Managed Action Items ───────────────────────────── */

/**
 * Lifecycle status for a managed action item. "open" is the initial state;
 * "done" mirrors back to the source transcript's completedItems.
 */
export type ActionItemStatus = "open" | "in_progress" | "in_review" | "done";

/** A comment/note left on a managed action item. */
export interface ActionItemComment {
  id: string;
  authorId: string;
  authorName: string;
  text: string;
  createdAt: number;
}

/** One entry in an action item's audit trail. Append-only. */
export interface ActionItemHistoryEntry {
  at: number;
  /** "system" for automated events (Fireflies ingestion). */
  actorId: string;
  actorName: string;
  type: "created" | "status_changed" | "reassigned" | "comment_added";
  /** Human-readable description, e.g. 'Marked Done and assigned to Y by Tomer'. */
  detail: string;
}

/**
 * A meeting action item promoted to a fully managed task (Firestore `actionItems`).
 * Doc id is deterministic — `${transcriptId}_${sourceIndex}` — so ingestion and
 * webhook retries are idempotent. The parallel arrays on Transcript remain the
 * source used by the meeting detail page; changes are mirrored both ways.
 */
export interface ActionItem {
  id: string;
  transcriptId: string;
  transcriptTitle: string;
  /** Index into transcript.actionItems[] — keeps the meeting page and dashboard in sync. */
  sourceIndex: number;
  clientId?: string | null;
  meetingDate?: number;
  text: string;
  status: ActionItemStatus;
  assigneeUserId?: string | null;
  assigneeName?: string | null;
  comments: ActionItemComment[];
  history: ActionItemHistoryEntry[];
  /** Future client rollout: when true, the owning client's users may view this item. Staff-only while absent/false. */
  visibleToClient?: boolean;
  createdAt: number;
  updatedAt: number;
}

/* ─────────────────── Notification Centre ───────────────────────────── */

/** A single meeting action item assigned to a user that is not yet completed. */
export interface ActionItemNotification {
  transcriptId: string;
  transcriptTitle: string;
  itemIndex: number;
  text: string;
  meetingDate?: number;
  clientId?: string | null;
}

/* ─────────────────────── Login Audit Logs ───────────────────────────── */

export interface LoginLog {
  id: string;
  uid: string | null;
  email: string | null;
  timestamp: number;
  userAgent?: string | null;
}

/** An AI agent job that has generated content and is awaiting client review. */
export interface AgentReviewNotification {
  jobId: string;
  title: string;
  agentName: string;
  updatedAt: number;
}

/**
 * Emitted by the publish cron when a platform returns HTTP 401/403.
 * Surfaces in the notification bell so staff can prompt the client to re-connect.
 */
export interface IntegrationExpiredNotification {
  clientId: string;
  platform: string;
  expiredAt: number;
}

/* ─────────────────── Proactive Task Board ───────────────────────── */

/**
 * "archived" — terminal storage state: tasks completed ≥7 days ago are swept
 * there (archiveStaleCompletedTasks) so the active board stays clean. Hidden
 * from listClientTasks unless explicitly requested.
 */
export type TaskStatus = "pending" | "in_progress" | "review_pending" | "completed" | "archived";
export type TaskPriority = "high" | "medium" | "low";
export type TaskSource =
  | "gmail"
  | "competitor_research"
  | "brand_audit"
  | "content_dispatch"
  | "copilot"
  | "manual"
  | "custom";

/**
 * "karos_managed" — executed by Karos AI agents or staff (content, drafting, research).
 * "client_managed" — must be executed by the client (website changes, OAuth connects, approvals).
 */
export type TaskOwner = "karos_managed" | "client_managed";

export interface ClientTask {
  id: string;
  clientId: string;
  title: string;
  description?: string;
  status: TaskStatus;
  priority: TaskPriority;
  source: TaskSource;
  /** Which party is responsible for executing this task. Defaults to source-based inference. */
  owner?: TaskOwner;
  sourceLabel?: string;
  /**
   * Contextual priority weight 0–100 (how critical the underlying gap is —
   * e.g. missing core integration ≈ 90, optional secondary post ≈ 30).
   * Set by the Copilot at generation; drives board sorting within a column.
   * Absent ⇒ derived from `priority` (high 80 / medium 50 / low 25).
   */
  weight?: number;
  /**
   * Freeform execution state. Well-known keys:
   * `productType` — the managed product (ManagedTaskType) that executes this task;
   * `platform` — canonical integration platform key the task concerns;
   * `completionTrigger` — auto-complete hook: "integration_connected:<platform>" or
   * "product_run:<taskType>" (see task-sync.ts);
   * `externalJobId` — platform Job id of the agent-service run dispatched for this task;
   * `agentName`, `executing`, `type`, `artifact`, `artifactImageUrl`, `artifactAssetIds`,
   * `approvedAssetId`, `adjustmentFeedback`, `executionError`, `aiPlan`, `recipient`,
   * `failedUpload*`, `published*`, `autoCompletedReason`.
   */
  metadata?: Record<string, unknown>;
  completedAt?: number | null;
  createdBy: string;
  createdAt: number;
  updatedAt: number;
}

/** A comment thread entry on a task ticket. Stored flat in `taskComments` collection. */
export interface TaskComment {
  id: string;
  taskId: string;
  clientId: string;
  content: string;
  authorName: string;
  authorRole: Role;
  createdAt: number;
}

/** Per-client operational settings (e.g. Autopilot mode). Stored in `clientSettings` collection. */
export interface ClientSettings {
  clientId: string;
  autopilot: boolean;
  updatedAt: number;
}

/* ─────────────────────── Client Credits ─────────────────────────── */

/**
 * A client's credit balance + spend caps. Stored in `clientCredits`, doc ID =
 * clientId. Created lazily with defaults on the first charge or grant.
 * CLIENT_USER-initiated AI actions charge this balance; staff work never does.
 * Weekly/monthly caps are the per-client rate limit (null = uncapped); spend
 * counters reset when their UTC window key rolls over.
 */
export interface ClientCredits {
  clientId: string;
  balance: number;
  weeklyLimit: number | null;
  monthlyLimit: number | null;
  /** ISO week of the current spend window, e.g. "2026-W28". */
  weekKey: string;
  weekSpent: number;
  /** Calendar month of the current spend window, e.g. "2026-07". */
  monthKey: string;
  monthSpent: number;
  updatedAt: number;
}

export type CreditEntryKind = "grant" | "charge" | "refund" | "adjustment";

export type CreditOperation =
  /** Legacy — in-app agent runs no longer exist; kept so old ledger entries still render. */
  | "agent_run"
  | "chat_message"
  | "task_execution"
  | "doc_correction"
  /** Client-fired custom agent run on the agent service (jobId = platform job doc id). */
  | "custom_agent_run"
  | "manual";

/**
 * Append-only audit trail of every balance change. Stored in `creditLedger`
 * (its own retained collection — usageLogs are purged after 30 days).
 */
export interface CreditLedgerEntry {
  id: string;
  clientId: string;
  /** Signed change: positive for grants/refunds, negative for charges. */
  delta: number;
  balanceAfter: number;
  kind: CreditEntryKind;
  operation: CreditOperation;
  /** Human label shown in the ledger, e.g. "Agent run · Instagram Pack". */
  reason: string;
  agentId?: string | null;
  jobId?: string | null;
  actorUid: string;
  actorName?: string;
  createdAt: number;
}
