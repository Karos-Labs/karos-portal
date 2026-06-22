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
  keywords?: string[];
  createdAt: number;
}
