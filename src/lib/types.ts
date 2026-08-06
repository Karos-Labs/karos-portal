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
  /**
   * Onboarding wizard gate. Set to `false` ONLY at creation time for CLIENT_USER
   * accounts (self-signup via clientKeyId, or admin approval of a pending
   * registration) — the population the 2-step wizard (personal profile + workspace
   * setup) targets. Absent ⇒ never subject to the guard (staff, and all accounts
   * that predate this field). See needsOnboarding() in lib/onboarding.ts.
   */
  hasCompletedOnboarding?: boolean;
  phone?: string;
  /** Uploaded CV/resume URL — powers the employee-advocacy LLM voice. */
  resumeUrl?: string;
  /** Set true once this user completes the LinkedIn employee-seat OAuth flow. */
  linkedInConnected?: boolean;
  /** The EmployeeSeat (within their own client's LinkedIn integration) this user owns. */
  primarySeatId?: string;
  /**
   * CLIENT_USER only: the ClientSeat (the roster the LinkedIn/X content
   * agents draft personal content for) this specific login represents.
   * Absent ⇒ a shared/company login — sees general content only, unless
   * isGroupAdmin. Distinct from primarySeatId above (a different, unrelated
   * seat concept — see ClientSeat's own doc comment).
   */
  seatId?: string | null;
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
  /**
   * LEGACY SPELLING OF `category`, and the reason it is still here.
   *
   * `industry` and `category` were the same fact under two names, with two
   * editors: staff typed an industry into the Clients-page dialog while the
   * client typed a category into their own profile chip, and the copilot and the
   * intel pipeline read only the staff one. They are one field now and
   * `category` is it.
   *
   * NEVER WRITTEN. No editor, action or pipeline sets this any more, and it is
   * read in exactly one place — `clientCategoryValue` in lib/utils.ts, as the
   * fallback for a document written before the rename. Kept on the type because
   * stored documents still carry it; deleting it would delete those clients'
   * only category until somebody retyped it.
   */
  industry?: string;
  /**
   * The client's market category / vertical, self-reported and client-editable.
   * THE field — read through `clientCategoryValue`, written clamped to
   * CLIENT_CATEGORY_MAX_LENGTH by both editors.
   */
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
  /**
   * Plan capacity for LinkedIn employee-advocacy seats. Seats within this limit
   * are free; adding beyond it charges credits per seat (the monetization gate).
   * Absent ⇒ DEFAULT_LINKEDIN_SEAT_LIMIT. Admin-set from client settings.
   */
  linkedinSeatLimit?: number;
  /**
   * Global workspace lock: true while any background AI generation cycle (Intel
   * Report, SEO/GEO, Task Map swarm) is running for this client. Acquired via
   * tryAcquireAiProcessingLock (data.ts) so concurrent triggers can't overlap;
   * always released in a finally block. UI reads this to grey out
   * Regenerate/Refresh Task Map controls and show a "building your workspace"
   * banner for every user on the account.
   */
  isAiProcessing?: boolean;
  /** Epoch millis the current AI-processing lock was acquired — used to detect a stale lock. */
  aiProcessingStartedAt?: number;
  /**
   * Reason the last AI-processing run failed (e.g. out of credits), truncated.
   * Cleared the moment a new run acquires the lock. Lets the UI show what went
   * wrong and that Regenerate/Refresh Task Map are open again, instead of the
   * run just silently vanishing.
   *
   * STAFF-ONLY: this is a raw provider error, and only the admin branch of the
   * banner ever paints it. `toClientPortalView` projects the boolean below in
   * its place — see F69.
   */
  aiProcessingError?: string;
  /**
   * THAT the last run failed, without saying how. The client portal projection
   * sets this instead of `aiProcessingError`: both client-side readers only ever
   * tested the error for truthiness, so the raw provider string was crossing the
   * RSC boundary — readable from view-source — to decide a single branch (F69).
   * Never stored; it exists only on the projected view.
   */
  aiProcessingFailed?: boolean;
  /**
   * Epoch millis the Intel Report + SEO/GEO pipeline last completed successfully,
   * from ANY of its three triggers (new client, admin Regenerate, or the
   * recurring schedule below). Informational — shown in the admin Schedule modal.
   */
  lastIntelReportAt?: number;
  /**
   * Admin-configured recurring regeneration of the Intel Report + SEO/GEO
   * pipeline (client-documents.tsx Schedule modal). This is the ONLY automatic
   * re-trigger besides client creation — see /api/intel-report-schedule, the
   * sole cron that reads these fields. Absent/false ⇒ no recurrence; the
   * pipeline then only runs on client creation or a manual admin Regenerate.
   */
  intelScheduleEnabled?: boolean;
  /** Recur every N months (admin-chosen, not limited to fixed presets). Default 1. */
  intelScheduleIntervalMonths?: number;
  /** Day of month to fire on (1-28, clamped for short months). Default 1. */
  intelScheduleDayOfMonth?: number;
  /**
   * Next scheduled fire time (epoch millis), advanced by the cron on a fixed
   * grid (see computeNextIntelScheduleRun) — independent of unrelated manual
   * regenerations, so the configured cadence never drifts. Null while disabled.
   */
  intelScheduleNextRunAt?: number | null;
  /**
   * IANA zone this client's own calendar DAY is read in (e.g.
   * "America/Sao_Paulo"). Staff-set from the Clients page.
   *
   * THE FIELD lib/scheduling.ts's docstring says does not exist. It said
   * "fixing it properly means giving `Client` an IANA zone (it has none; only
   * `RunCadence.timezone` and `PlannedScheduledRun.timeZone` carry one)", and
   * the daily digest is the first surface that CANNOT work without one: a mail
   * that claims to carry "today's" clips has to know whose today it means, and
   * the server's is a container's, almost always UTC.
   *
   * SCOPE, deliberately narrow. This is read by the digest (which local day it
   * sends, and at which local hour), and by nothing else yet: `startOfDayMs`
   * and the chain planners still bucket on the runtime's zone, exactly as
   * before. Threading it through them is the wider data change that docstring
   * describes, and it is not this field's arrival.
   *
   * Absent ⇒ `runtimeTimeZone()`. Read through `clientTimeZone` (lib/
   * client-timezone), never off the record, so an invalid stored id falls back
   * instead of throwing inside Intl.
   */
  timeZone?: string;
  /**
   * How many clips and how many posts one calendar day holds for this client.
   * Absent ⇒ one item a day, which is what both day planners did before this
   * existed. See lib/daily-pace.ts for the whole rule.
   *
   * `null` is how CLEARING it is stored: `updateClient` merges, so an absent key
   * would leave a previous pace in place when staff empty both boxes. Both
   * absent and null resolve to the same default.
   */
  dailyPace?: ClientDailyPace | null;
  /**
   * Send this client a daily email carrying that day's calendar items.
   * Opt-in, staff-set, default OFF: `/api/daily-digest` skips every client
   * that has not been switched on.
   */
  dailyDigestEnabled?: boolean;
  /**
   * Epoch millis of the START of the last local day a digest was sent for.
   * The cron's idempotence marker: it runs hourly, so without this a client
   * would get the same mail every hour from their local send time to midnight.
   * Written only after a send actually succeeds.
   */
  lastDigestSentDay?: number;
  createdAt: number;
  createdBy: string;
}

/**
 * A client's daily content pace: the per-day ceiling for each of the two lanes
 * a calendar day has.
 *
 * Both numbers are OPTIONAL and the object's PRESENCE is what turns paced
 * placement on. An absent `dailyPace` keeps the single shared slot a day that
 * both planners have always had, so switching this feature on changes nothing
 * for a client nobody has configured. See `resolveDailyPace`.
 */
export interface ClientDailyPace {
  /** Video deliverables (podcast cuts, shorts) one day holds. Default 1. */
  clipsPerDay?: number;
  /** Written posts one day holds, per content family. Default 1. */
  postsPerDay?: number;
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
  | "failed"
  /**
   * Stopped on purpose. Distinct from "failed": folding the two presented a
   * deliberate stop as a breakage, polluted failure counts, and left the person
   * who pressed Cancel unsure whether it had worked. Credits are refunded for
   * this outcome exactly as for a failure.
   */
  | "cancelled";

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
  /**
   * INTERNAL. The lab-repo skill manifest blurb — product codes, pipeline
   * architecture, engineering shorthand. Staff surfaces only. Client surfaces
   * render `clientBlurb`.
   */
  description: string;
  /**
   * What this agent does, in the client's language: 1–2 sentences, sentence
   * case, no lab product codes. Rendered on the client's agent card and in the
   * run dialog. Absent on agents imported before the field existed — surfaces
   * fall back to `description` until an admin writes one.
   */
  clientBlurb?: string | null;
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
  /**
   * Credits a client-fired LAUNCH (the one-time setup run of a client agent)
   * costs. Client-billed and priced ABOVE this agent's per-run `creditCost`,
   * from the MEASURED setup-vs-run USD ratio rather than a guessed multiplier
   * (Phase-3 §6.3). Admin-set per agent after measurement, like creditCost.
   *
   * null ⇒ the price has not been calibrated yet: the CLIENT's self-serve
   * Launch is gated with a visible reason, while staff launches (free, and the
   * runs that produce the measurement) proceed. Deliberately gated rather than
   * charging a provisional number — billing a price nobody consciously set is
   * the F130 placeholder-pricing failure at the most expensive SKU.
   */
  launchCreditCost?: number | null;
  /**
   * Optional per-step model override, keyed by the named subagent identifier
   * the skill's steps delegate to via the Claude Agent SDK's Task tool (e.g.
   * `{"draft-post": "claude-haiku-4-5", "research": "claude-opus-4-8"}`).
   * Threaded through to the agent-service runner as `brief.step_models`; only
   * takes effect for skills whose steps are structured as named subagent
   * delegations matching these keys — see docs/one-pagers/
   * x-agent-v2-integration-contract.md for the naming contract. Undefined ⇒
   * the whole run uses the task type's single default model, as today.
   */
  stepModels?: Record<string, string> | null;
  /**
   * Optional whole-run model override, replacing the custom task type's
   * single default (claude-opus-4-8). Threaded through to the agent-service
   * runner as `brief.model`. Unlike stepModels, this needs no matching named
   * subagent in the skill — use it when a skill's own catalog entry
   * recommends a cheaper tier but has no Task-tool delegation point for
   * stepModels to attach to (e.g. a linear, sequential-turn skill).
   */
  model?: string | null;
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

/* ------------------------- Dynamic Agent Studio -------------------------
 *
 * Spec-driven, no-code agent engine: an admin builds an agent in the Portal's
 * Agent Studio (general settings + input schema + step pipeline), the
 * definition persists as a declarative DynamicAgentSpec, and agent-service's
 * generic execution engine (agent-service/runner/src/dynamic/) reads a job's
 * frozen specSnapshot and runs its steps. Mirrored (structurally identical,
 * not cross-imported) in agent-service's own local type file — see
 * agent-service/src/dynamic-types.ts.
 *
 * This is ADDITIVE: the existing hardcoded agents (X / LinkedIn / Reddit,
 * CustomAgent above) are untouched and keep running down their own path.
 */

/** Client intake field kinds the Agent Studio's input builder can produce. */
export type DynamicAgentInputType = "text" | "textarea" | "file" | "image" | "select";

/**
 * One client-facing intake field, authored by an admin in the Studio's input
 * schema builder and rendered by `dynamic-agent-intake-form.tsx`. `key` is the
 * context-variable name AI-step prompts and code-step scripts read the
 * client's answer under (see DynamicAgentJobPayload.inputs).
 */
export interface DynamicAgentInputDef {
  key: string;
  type: DynamicAgentInputType;
  label: string;
  helpText?: string;
  required: boolean;
  /**
   * Ghost text inside the control, for `text` and `textarea` only.
   *
   * Restricted to those two because they are the only types where HTML has a
   * placeholder at all: a `select` shows its own "Select…" option, and a file
   * input's chrome is drawn by the browser. Distinct from `helpText`, which
   * renders as persistent copy ABOVE the field and stays readable once the
   * client has typed something — a placeholder disappears on first keystroke,
   * so it may hold an example but never an instruction the client still needs.
   */
  placeholder?: string;
  /** Required when type === "select" (the choices); forbidden for every other type. */
  options?: string[];
  /** file/image only: an <input accept> string, e.g. "image/png,image/jpeg". */
  accept?: string;
  /** file/image only: per-file cap in megabytes. */
  maxSizeMb?: number;
  /** Display / submit order — dense and 0-indexed after any reorder. */
  order: number;
}

/**
 * The UI and the spec store the alias only — never a raw model id. Resolved
 * once, service-side, in agent-service/src/task-types.ts's
 * AGENT_MODEL_ALIASES map. // DECISION: no raw model IDs are ever persisted
 * in a DynamicAgentSpec.
 */
export type DynamicAgentModelAlias = "opus" | "sonnet" | "haiku";

/**
 * One pipeline step. A discriminated union on `type` so a `switch (step.type)`
 * narrows to the right shape with no `any`.
 *
 * `dependsOn` exists from day one so the schema is DAG-ready, but
 * // DECISION: v1 is sequential-only — `steps` is executed strictly in the
 * order given, and the runner (agent-service/runner/src/dynamic/step-runner.ts)
 * REJECTS any spec where any step's `dependsOn` is non-empty, with a plain
 * English validation error. This keeps the Pipeline Builder and the Step
 * Runner simple now without a schema migration when DAG execution lands.
 */
export type DynamicAgentStepDef =
  | {
      id: string;
      type: "ai";
      label: string;
      model: DynamicAgentModelAlias;
      /** Markdown prompt, composed with the serialized run context at execution time. */
      prompt: string;
      order: number;
      dependsOn?: string[];
    }
  | {
      id: string;
      type: "code";
      label: string;
      language: "python" | "node";
      /** Receives `context` as JSON on stdin; must write a JSON object to stdout. */
      code: string;
      /** Wall-clock cap in ms; default 30_000, hard cap 120_000. */
      timeoutMs?: number;
      order: number;
      dependsOn?: string[];
    };

/**
 * The declarative agent definition an admin builds in the Agent Studio.
 * Persisted to the global (not client-scoped) `dynamicAgentSpecs` Firestore
 * collection — see CLIENT_SCOPED_COLLECTIONS in lib/data.ts, which
 * deliberately excludes it.
 */
export interface DynamicAgentSpec {
  id: string;
  name: string;
  /**
   * One-line pitch, for places that list agents side by side (the Studio's own
   * list, a client-facing card) where the full `description` would not fit.
   *
   * Optional, and readers fall back to `description` when it is absent, so
   * every spec written before this field existed still renders correctly.
   */
  summary?: string;
  /** The full explanation, shown on the agent's own page. */
  description: string;
  category: string;
  icon: string;
  /** Integer >= 0. Charged once at job creation — see DynamicAgentJobPayload. */
  creditsCost: number;
  active: boolean;
  /** Monotonic integer, bumped on every admin save. See specVersion below. */
  version: number;
  /** Empty/undefined = every client may run this agent. */
  allowedClientIds?: string[];
  inputSchema: DynamicAgentInputDef[];
  steps: DynamicAgentStepDef[];
  createdAt: number;
  updatedAt: number;
  createdBy: string;
  /**
   * The admin who saved the most recent version.
   *
   * ASSUMPTION, flagged: Phase 2 says every update "stamps `updatedAt` /
   * `createdBy`". Taken literally that would overwrite `createdBy` with the
   * editing admin's uid on every save, destroying the authorship the field
   * name promises - so `createdBy` is preserved and the editor is recorded
   * here instead. Absent on specs saved before this field existed.
   */
  updatedBy?: string;
}

/**
 * A single answer collected by the dynamic client intake form. File/image
 * inputs store the uploaded object's reference (id/url/name from the existing
 * GCS-backed context upload — see AgentInputFiles / `/api/clients/[id]/context`),
 * never the raw bytes, per Phase 4 of the Dynamic Agent Studio spec.
 */
export type DynamicAgentInputValue =
  | string
  | string[]
  | { id: string; url: string; name: string }
  | { id: string; url: string; name: string }[]
  | null;

/**
 * The brief payload built by `submit-custom.ts` for a dynamic-agent run.
 *
 * // DECISION: `specSnapshot` is a deep clone of the resolved spec taken at
 * job-creation time, plus `specVersion` (the snapshot's `version` at that
 * moment). The runner executes ONLY this snapshot — never the live spec — so
 * a running job can never observe a mid-flight admin edit.
 */
export interface DynamicAgentJobPayload {
  specId: string;
  specVersion: number;
  specSnapshot: DynamicAgentSpec;
  clientId: string;
  inputs: Record<string, DynamicAgentInputValue>;
  runType?: JobRunType;
  /**
   * Per-step model routing, keyed by step id, carrying the model ALIAS only.
   * This is the brief's existing `step_models` field (the same one the
   * hardcoded custom-agent path populates from CustomAgent.stepModels), reused
   * rather than duplicated — the runner prefers it over the snapshot's own
   * `step.model`. See resolveStepModel() in the dynamic step runner.
   */
  stepModels?: Record<string, string>;
}

/**
 * One executed step of a dynamic run, as PERSISTED on the job.
 *
 * `error` here is a raw engine diagnostic (a model refusal, a script's own
 * exception text) and has ZERO client-facing text readers — the step bar
 * derives its wording from `status`, exactly the way CampaignStepProgress
 * treats `metadata.executionError`. Do not print it on a client screen.
 */
export interface DynamicAgentRunStep {
  stepId: string;
  type: "ai" | "code";
  label: string;
  status: "done" | "failed";
  durationMs: number;
  /** Concrete model this step ran on — staff-facing audit of per-step routing. */
  model?: string;
  error?: string;
}

/**
 * // DECISION: a failed step fails the job at that step, and `failedStepId`,
 * `failedStepIndex` and the partial context are PERSISTED rather than only
 * rendered into an error string. The runner produces this, the agent-service
 * webhook carries it as `dynamic_run`, and the job detail page renders the step
 * bar and the "incomplete" banner from it.
 */
export interface DynamicAgentRunReport {
  specId: string;
  specVersion: number;
  steps: DynamicAgentRunStep[];
  failedStepId?: string;
  failedStepIndex?: number;
  /** True when earlier steps produced output the client can still be shown. */
  hasPartialOutput?: boolean;
}

/**
 * A recurring weekly cadence, local to `timezone`. Days are 0=Sun..6=Sat.
 * e.g. { daysOfWeek: [2,3,4], hour: 9, minute: 0, timezone: "America/Sao_Paulo" }
 * fires Tue/Wed/Thu at 09:00 BRT.
 */
export interface RunCadence {
  daysOfWeek: number[];
  hour: number;
  minute: number;
  /** IANA timezone id. */
  timezone: string;
}

/**
 * A recurring generator run: a CustomAgent fired for a client on a cadence by
 * the /api/scheduler cron. System-fired (never charges the client's credits),
 * always draft-first — the produced asset lands as a draft for human approval.
 * Reuses the referenced agent's entry skill / instructions / skill roots, so a
 * client-scoped generator (entrySkillDir under clients/<slug>/skills/…) runs
 * exactly like any custom agent.
 */
export interface ScheduledRun {
  id: string;
  clientId: string;
  /** The CustomAgent supplying entry_skill_dir / instructions / skill roots. */
  agentId: string;
  /** Denormalized for display + the job title (the agent may be renamed/deleted). */
  label: string;
  /** Denormalized entry dir for at-a-glance display (source of truth = the agent). */
  entrySkillDir: string;
  /** The per-run brief prompt, e.g. "Draft the next company-page post." */
  prompt: string;
  cadence: RunCadence;
  /** Asset type the webhook assigns to deliverables (overrides the custom "note" default). */
  assetType: AssetType;
  /** Platform hint for channels + the recommended publish window (e.g. "linkedin"). */
  platform?: string;
  enabled: boolean;
  /** Epoch millis of the next fire; advanced atomically as each run is claimed. */
  nextRunAt: number;
  lastRunAt?: number | null;
  lastJobId?: string | null;
  /** Why the most recent fire produced no job; null ⇒ the last fire was clean. */
  lastError?: string | null;
  /** Epoch millis of `lastError`. */
  lastErrorAt?: number | null;
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
  /**
   * Platform-hosted URL once the file has been copied into our storage, else the
   * agent service's own URL.
   *
   * WHICH ONE YOU GET DEPENDS ON THE LIST YOU READ IT FROM, and the difference
   * matters because a service URL is a V4 signed link that expires 7 days after
   * the run. `Job.external.artifacts` is the run record and keeps the service URL
   * for anything that could not be copied, so staff can still fetch it; an
   * asset's `meta.artifacts` is written only from files whose bytes reached
   * platform storage (the webhook's `rehosted` list). This comment used to claim
   * client-facing implied re-hosted, which is what finding #47 was.
   *
   * SCOPED TO ASSETS WRITTEN SINCE THAT FIX, because the unscoped version of this
   * sentence — "a client is never given a link that will expire" — was flatly
   * contradicted by `asset-images.ts`, which states the residual at the readers:
   * documents written BEFORE the fix can still hold an agent-service URL in
   * `meta.artifacts`, nothing can recognise one (no host or shape distinguishes it
   * from a legitimate hosted link), and those assets play until their link dies.
   * A backfill is the fix and has not been written. Two comments from one change
   * disagreeing about the same field is worse than either gap.
   */
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

/**
 * How a run was initiated within the launch-vs-runs model (Phase 3).
 *   launch          — the one-time heavy setup run of a client agent
 *   scheduled       — a recurring fire of the umbrella's schedule
 *   manual_template — client pressed "Run this template now"
 *   manual          — any other hand-fired run (incl. note revision passes)
 *   test            — staff Control Room "Test Run": fires for real (real
 *                     cost, real generation) but its output is excluded from
 *                     scheduling/chain-reflow and every client-facing surface
 *                     (mirrors the existing launchDeliverable exclusion), and
 *                     gets its own economics bucket rather than biasing
 *                     "manual"/"untyped" — see credit-reporting.ts.
 * Absent on legacy jobs; analytics buckets those as "before run-type tracking".
 */
export type JobRunType = "launch" | "scheduled" | "manual_template" | "manual" | "test";

export interface Job {
  id: string;
  clientId: string;
  agentId: string;
  /** Exact custom-agent identity for repo-agent runs. Older jobs may only have agentName. */
  customAgentId?: string;
  /** Set instead of customAgentId for a Dynamic Agent Studio run — see DynamicAgentSpec. */
  dynamicAgentSpecId?: string;
  /** Dynamic Agent Studio runs only — the persisted per-step report. */
  dynamicRun?: DynamicAgentRunReport;
  /** See JobRunType. Absent on jobs written before run-type tracking existed. */
  runType?: JobRunType;
  /** The client-agent umbrella (clientAgents doc id) this run belongs to, when one exists. */
  clientAgentId?: string | null;
  /** manual_template + slot-fulfilling runs: which template stream was produced. */
  templateKey?: string | null;
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
  /** Public URL of the generated visual (Firebase Cloud Storage), when one exists. */
  imageUrl?: string | null;
  /**
   * Public URL of the deliverable's video clip (podcast cuts, branded shorts,
   * TikTok). Video deliverables live in GCS block storage — the agent service
   * fetches from there and writes the resulting URL here; the portal only
   * renders it (QA F150 / call directive D1, GCP wiring is infra-side). Clips
   * discovered in meta.videos / meta.artifacts are picked up too — see
   * assetVideos() in lib/asset-images.
   */
  videoUrl?: string | null;
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
  /**
   * Campaign this asset belongs to (campaigns collection id), denormalized from
   * the producing task so the content calendar can group pieces into a capsule
   * without a task join. Absent ⇒ standalone.
   */
  campaignId?: string | null;
  /** Denormalized campaign title for the calendar capsule header. */
  campaignTitle?: string | null;
  /** Epoch millis when the asset was actually pushed to a platform (auto cron or Publish Now). */
  publishedAt?: number;
  /**
   * The platform's own id for the published post (LinkedIn UGC urn, tweet id, IG
   * media id, FB post id, TikTok publish id). Captured at publish time so the
   * analytics sync can fetch this exact post's metrics later. Absent for assets
   * published before this was captured, or platforms that don't return one.
   */
  platformPostId?: string | null;
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
   * ClientSeat.id when this asset is personal content belonging to one
   * employee's own account (LinkedIn/X seat agents) rather than the client's
   * company account. Absent/null ⇒ general content, visible to every client
   * login as before this field existed — see isPersonalAssetVisibleToViewer
   * in lib/asset-visibility.ts, the one place this is enforced.
   */
  personalSeatId?: string | null;
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

/** How often a scheduled agent run repeats. "once" fires a single future run. */
export type PlannedRunCadence = "once" | "daily" | "weekly" | "monthly";

/**
 * A planned agent run: a managed (catalog) product queued to fire at a future
 * time, optionally on a repeating cadence. Created by staff (any cadence) or by
 * a client switching an agent on weekly from its card, in which case
 * `billClientCredits` makes every fire spend that client's credits. The
 * /api/run-scheduled cron submits the actual job via submitCustomAgentJob()
 * when `nextRunAt` passes, then advances (recurring) or completes (once) the
 * schedule.
 */
export interface PlannedScheduledRun {
  id: string;
  clientId: string;
  /** The repo-imported custom agent this run fires. */
  customAgentId: string;
  /**
   * Client-agent umbrella this schedule belongs to (clientAgents doc id). When
   * set, the cron fires slot-aware (Phase-3 §4.3). Absent on schedules created
   * before the umbrella model, and on non-umbrella agents.
   */
  clientAgentId?: string | null;
  /** Snapshot of the agent's display fields — survives the agent being renamed/deleted. */
  agentName: string;
  agentIcon: string;
  agentColor: string;
  /** Free-text request handed to the agent on every fire. */
  prompt: string;
  cadence: PlannedRunCadence;
  /** Local hour (0–23) the run fires. */
  hour: number;
  /** Local minute (0–59) the run fires. */
  minute: number;
  /** weekly cadence: 0=Sun … 6=Sat. */
  weekday?: number;
  /** Multi-fire weekly cadence. When present, supersedes weekday. */
  weekdays?: number[];
  /** monthly cadence: 1–31 (clamped to the month's length). */
  dayOfMonth?: number;
  /**
   * IANA zone the hour/minute above are expressed in — the schedule's intent,
   * captured from whoever set it. `nextRunAt` is derived from (wall clock +
   * this zone), so every recompute must pass it. Absent on rows written before
   * the field existed: those fall back to the runtime's local timezone.
   */
  timeZone?: string;
  /** Distinct deliverables requested from each scheduled run. Defaults to 1. */
  outputsPerRun?: number;
  /**
   * Whether each scheduled fire spends the client's credits — the money switch,
   * and the only field that decides it. The cron passes it to the submit core as
   * `bill`, overriding the actor test that `createdBy` would otherwise imply.
   *
   * Set ONCE, at creation, from the creating actor, and never rewritten: an edit
   * of the pace preserves it. (It used to be recomputed on every save while
   * `createdBy` stayed frozen, so the two disagreed and fires were billed to the
   * wrong party — or to nobody.)
   *
   * `undefined` on rows written before the field existed. Those fall back to the
   * actor test, deliberately: an absent flag is no recorded intent, and reading
   * it as `false` would silently stop charging a fleet of live schedules.
   */
  billClientCredits?: boolean;
  /** Next fire time (epoch millis) — the scheduling cursor the cron drains. */
  nextRunAt: number;
  status: "active" | "paused" | "completed";
  /** Epoch millis of the most recent fire. */
  lastRunAt?: number;
  /** Job id created by the most recent fire. */
  lastJobId?: string;
  /**
   * Human-readable refusal from the most recent fire that produced nothing
   * (out of credits, cap reached, missing intake, service down). A submit
   * refused before a job row exists leaves no job, no failed status and no
   * charge, so this is the only trace it left. Rendered on the agent card so a
   * schedule that can never fire is visible instead of silently green.
   * `null` ⇒ the last fire was clean — undefined does not clear a Firestore
   * field, so cleared must be written as an explicit null.
   */
  lastError?: string | null;
  /** Epoch millis of `lastError`. */
  lastErrorAt?: number | null;
  /**
   * Non-null from the instant a fire CLAIMS its slot until the cron settles that
   * fire (submitted, refused, or thrown), and cleared to null when it does.
   *
   * The claim advances `nextRunAt` and stamps `lastRunAt` in one transaction
   * BEFORE the submit — correct for double-fire safety, and lossy without this
   * field: a Cloud Run timeout or a container recycle in that window leaves a
   * row with a fresh `lastRunAt`, a null `lastError`, an advanced `nextRunAt`
   * and NO job. Nothing else on the row tells that apart from a clean fire, so
   * no alert fires and the "Stuck" flag never trips — `nextRunAt` is
   * legitimately in the future.
   *
   * A row still carrying it at its NEXT claim is that vanished fire, and the
   * cron reports it then. `undefined` on rows written before the field existed,
   * and `null` on every settled row.
   */
  fireInFlightSince?: number | null;
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
  /**
   * INTERNAL ONLY — share of the brand's visual surface this color should
   * occupy, 0-100. It is the agency's own mix guidance for the design work, not
   * something a client is asked to reason about, so it is stripped at the
   * client boundary (toClientPortalView) and clients see swatches only.
   * Never render it behind a client-visible conditional — it must not be in
   * their RSC payload at all.
   */
  usagePct?: number;
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
  /**
   * Answers (across all engines) in which the AI answer-engines named this brand
   * during the most recent SEO/GEO visibility capture. Written by
   * syncCompetitorsFromVisibility after each capture; absent = never measured.
   * Dominates the auto-seed priority score so the tracked-5 surfaces the rivals
   * that actually win the AI conversation, not just the analyst's guess.
   */
  llmMentions?: number;
  /** Epoch millis of the capture that produced llmMentions. */
  llmMentionsAt?: number;
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
  | "meeting-notes"
  // Agent onboarding profile — the identity narrative (handle, off-limits, how
  // they want to come across) for one agent, company + every seat in one doc
  // (see upsertAgentProfileScope/getAgentProfileDocData in data.ts). Only "x"
  // is wired today; the other two exist so LinkedIn/Reddit can adopt the same
  // mechanism later without a type change.
  | "x-agent-profile"
  | "linkedin-agent-profile"
  | "reddit-agent-profile";

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
  | "COMPETITOR_REMOVED"
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
  /**
   * Uid of the admin who was in "View as Client" when this row was written.
   *
   * Present only on rows `sessionSafeActor` re-attributed, so it says WHICH
   * staff member is behind a row whose display name is the agency's. Stored,
   * never displayed — the timeline's RSC projection is a whitelist and this is
   * not on it, so a staff uid never reaches a client's browser.
   *
   * Absent means only "this row does not carry the signal": rows written before
   * the field existed never recorded the difference, so nothing may read its
   * absence as proof the client acted themselves.
   */
  impersonatedBy?: string;
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

/**
 * A LinkedIn employee-advocacy seat: one company employee's connected LinkedIn
 * account, used to publish + measure content under their personal handle. Stored
 * as an array on the client's LinkedIn ClientIntegration doc. Tokens in
 * `credentials` are ENCRYPTED at rest (see src/lib/crypto/token-cipher.ts) —
 * always run them through decryptCredentials before use.
 */
export interface EmployeeSeat {
  id: string;
  employeeName: string;
  employeeEmail: string;
  /** Encrypted OAuth tokens (accessToken, refreshToken) — decrypt before use. */
  credentials: Record<string, string>;
  /** "active" seats are published to + measured; "paused" are skipped. */
  status: "active" | "paused";
  /** Optional placeholder for future enrichment (parsed resume / background). */
  resumeUrl?: string | null;
  backgroundContext?: string | null;
  addedBy: string;
  addedAt: number;
  updatedAt: number;
}

export interface ClientIntegration {
  id: string;
  clientId: string;
  /** Matches PlatformConfig.id, e.g. "instagram" */
  platform: string;
  /** Display name / handle of the connected account (e.g. "@karoslabs") */
  accountName?: string;
  /** Credential key→value pairs matching the platform's field keys. Encrypted at rest — decrypted transparently by listClientIntegrations. */
  credentials: Record<string, string>;
  /**
   * True when stored credentials could not be decrypted in THIS environment
   * (no TOKEN_ENCRYPTION_KEY — e.g. local dev reading production-written
   * blobs). The connection exists; its secrets are unreadable here. Never
   * persisted — set by listClientIntegrations at read time.
   */
  credentialsUnavailable?: boolean;
  /** "manual" = keys pasted by a staff member; "oauth" = OAuth flow */
  method: "manual" | "oauth";
  /**
   * "active" (default / absent) — credentials are valid and operational.
   * "expired" — the publish cron received a 401/403; re-connect required.
   * "reauthenticate" — the analytics sync received a 401/403; same meaning as
   *   expired (needs reconnect), surfaced separately so the source is traceable.
   * Use the `integration-status` helpers rather than comparing this directly.
   */
  status?: "active" | "expired" | "reauthenticate";
  /**
   * When true (default / absent), the publish cron may auto-post scheduled content
   * to this platform. When false, content targeting this platform can only go out
   * via a manual "Publish Now" click — the cron skips it.
   */
  autoPublish?: boolean;
  /** Epoch millis when the cron first detected the token had expired. */
  expiredAt?: number;
  /**
   * LinkedIn employee-advocacy seats (only meaningful on the `linkedin`
   * integration). Each is a connected employee handle we publish + measure under.
   */
  employeeSeats?: EmployeeSeat[];
  connectedBy: string;
  connectedAt: number;
  updatedAt: number;
}

/* ──────────────────── Marketing performance analytics ──────────────────── */

/**
 * Unified, platform-agnostic performance metrics for one published asset.
 * Every social network reports engagement with a different shape (LinkedIn's
 * `impressionCount`, TikTok's `video_views`, Twitter's `impression_count`, …);
 * the analytics ingestion layer normalizes all of them into these four fields
 * (see `normalizePlatformMetrics` in `src/lib/analytics.ts`).
 */
export interface MarketingMetrics {
  /** Times the content was served/rendered on the platform. */
  impressions: number;
  /** Outbound clicks (link clicks, profile taps, CTA presses). */
  clicks: number;
  /** Engagements ÷ impressions as a 0–1 fraction (likes+comments+shares+saves). */
  engagementRate: number;
  /** Total watch time in seconds summed across all views (0 for non-video). */
  videoViewTime: number;
}

/**
 * One performance record per (client, asset, platform) — the analytics half of
 * the Self-Improving Marketing Loop. Written by the analytics sync cron
 * (`/api/analytics/sync`), read by the Task Map engine (`getClientPerformanceBenchmarks`)
 * to bias new content suggestions toward proven winners and away from losers.
 *
 * Doc ID is deterministic `${clientId}_${platform}_${assetId}` so re-syncs upsert
 * in place (one living metrics row per asset+platform, not an append log). The
 * per-client history is queried by the `clientId` field then sorted in JS — the
 * denormalized `engagementScore` makes top/bottom-N ranking a single cheap read,
 * matching this repo's "avoid composite indexes" convention.
 */
export interface ClientMarketingAnalytics {
  id: string;
  clientId: string;
  /** The asset these metrics belong to (assets collection id). */
  assetId: string;
  /** The Task Map task that produced the asset, when known (clientTasks id). */
  taskId?: string | null;
  /** Canonical integration platform key, e.g. "linkedin", "tiktok". */
  platform: string;
  /** Asset type snapshot (e.g. "social_post"), for grouping wins/losses by format. */
  assetType?: string | null;
  /** Human-readable asset label (title / first line) surfaced in benchmarks + insights. */
  assetLabel?: string | null;
  /** Unified metrics, normalized across platforms. */
  metrics: MarketingMetrics;
  /** Denormalized 0–100 weighted engagement score (see `engagementScore`) for cheap ranking. */
  engagementScore: number;
  /** Data provenance: "mock" until the live platform Insights APIs are wired in. */
  source: "mock" | "live";
  /** Epoch millis when the upstream metrics were captured/fetched. */
  capturedAt: number;
  createdAt: number;
  updatedAt: number;
}

/** Top/bottom performers for a client, ranked by `engagementScore`. */
export interface PerformanceBenchmarks {
  clientId: string;
  top: ClientMarketingAnalytics[];
  bottom: ClientMarketingAnalytics[];
  /** Total analytics records considered when ranking. */
  sampleSize: number;
}

/**
 * Cached AI Insights briefing (`/api/clients/[id]/insights`). Stored in
 * `clientInsightsCache`, doc ID = clientId. `digestKey` is a stable JSON snapshot
 * of whichever digest (performance or content-pipeline) produced `text` — the
 * route only calls the LLM again when a freshly-computed digest differs from
 * this, so a page reload doesn't re-spend tokens on an unchanged briefing.
 */
export interface ClientInsightsCache {
  clientId: string;
  digestKey: string;
  text: string;
  generatedAt: number;
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
  clientId: string;
  /** Set on staff (cross-client) feeds so a row can say whose review it is. */
  clientName?: string;
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
   * `customAgentId` — a git-imported custom agent that executes this task instead of a
   * managed product (mutually exclusive with productType);
   * `platform` — canonical integration platform key the task concerns;
   * `completionTrigger` — auto-complete hook: "integration_connected:<platform>" or
   * "product_run:<taskType>" (see task-sync.ts);
   * `externalJobId` — platform Job id of the agent-service run dispatched for this task;
   * `agentName`, `executing`, `type`, `artifact`, `artifactImageUrl`, `artifactAssetIds`,
   * `approvedAssetId`, `adjustmentFeedback`, `executionError`, `aiPlan`, `recipient`,
   * `failedUpload*`, `published*`, `autoCompletedReason`;
   * `noDeliverable` — the run this task dispatched reported success and produced
   * nothing. Never read on its own: `ranWithoutDeliverable` (task-outcome-copy.ts)
   * asks whether the task is still sitting in that state, because only task-sync
   * clears the flag while eight other writers move the state.
   * `disabled` — an admin paused this task (most often because its linked
   * custom agent was turned off); read through `taskIsDisabled`
   * (task-disable-copy.ts), the one predicate every execution-trigger action
   * refuses on. Set and cleared by exactly one action (`setTaskDisabledAction`),
   * so unlike `noDeliverable` it is a standing decision, not a run outcome.
   */
  metadata?: Record<string, unknown>;
  /**
   * Campaign this task belongs to (campaigns collection id) when it's part of a
   * cohesive omnichannel bundle rather than a standalone task. Absent ⇒ standalone.
   */
  campaignId?: string | null;
  /**
   * Task ids this task depends on within its campaign — e.g. a newsletter or
   * social piece depends on the anchor blog being produced first. Advisory
   * ordering for the campaign flow; empty/absent ⇒ no dependencies.
   */
  dependsOnTaskIds?: string[];
  completedAt?: number | null;
  createdBy: string;
  createdAt: number;
  updatedAt: number;
}

/**
 * An omnichannel campaign — a themed bundle of dependent tasks (and the assets
 * they produce) that ship together across channels. One anchor (e.g. a blog),
 * a distribution vehicle (e.g. a newsletter), and matching social pieces, wired
 * with relational dependencies. Lives in the `campaigns` collection.
 */
export interface Campaign {
  id: string;
  clientId: string;
  title: string;
  /** The unifying theme/topic scope, e.g. "Black Friday launch" or a detected trend. */
  themeScope: string;
  /** ISO week key the campaign targets (taskWeekKey format), e.g. "2026-W28". */
  targetWeek: string;
  /** Tasks explicitly linked into this campaign. */
  taskIds: string[];
  /** Assets produced for this campaign (populated as its tasks execute). */
  assetIds: string[];
  status?: "planned" | "active" | "done";
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

/** Per-client operational settings. Stored in `clientSettings` collection. */
export interface ClientSettings {
  clientId: string;
  /**
   * @deprecated Legacy "Autopilot mode" flag. Nothing reads or writes it any
   * more — no scheduled job ever honoured it, so the persistent "on" state was
   * a promise the product never kept (QA F48). Batch runs are one-shot now.
   * Retained on the type only because existing documents still carry the field.
   */
  autopilot?: boolean;
  /** Whether the client has opted into auto-scheduling (approve → auto when integrations exist). */
  autoScheduleEnabled?: boolean;
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
  /**
   * Client-billed SETUP run of a client agent (the one-time launch). Split from
   * custom_agent_run so the ledger can report setup vs recurring separately at
   * its own per-agent price (CustomAgent.launchCreditCost).
   */
  | "agent_launch"
  /** Purchase of an additional LinkedIn employee-advocacy seat beyond the plan limit. */
  | "seat_purchase"
  /**
   * A one-off AI tool the client pressed in the portal — account suggestions on
   * the X intake form, a task-map refresh, an audience simulation. Not the
   * copilot, not a task run, not an agent run: those have their own operations
   * and their own labels, and folding these into one of them would make the
   * client's own spend breakdown name the wrong feature. The reason line
   * carries which tool it was.
   */
  | "ai_tool"
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

/* ─────────────── Agent intake & seats (X e13 · LinkedIn e10) ───────────────
 *
 * Per-agent client data collected ON TOP of onboarding (the buildout brief's
 * layer 2 + 3): company-level agent intake, per-person seats, the two ongoing
 * drop boxes, and per-account draft feedback. Grouped business → agent data →
 * seats → per-seat agent data, stored as flat collections keyed by
 * clientId/seatId per this codebase's convention. Additive — nothing existing
 * routes through these. Seats and the news drop are shared across agents
 * (PORTAL-INPUT-CONTRACT §3: the client types an update once).
 */

/**
 * A seat's AI-built voice profile — swept from the account's own handle/posts
 * by an agent's Setup (launch) run, not asked of the client. Its own sibling
 * collection rather than a field on AgentIntake (which is explicitly ASK-only,
 * see AgentIntake's doc comment) or a doc inside clientContextDocs (whose key
 * has no seat dimension). One doc per (clientId, agent, seatId); `agent` keeps
 * this usable by LinkedIn/Reddit once they adopt the same v2 pattern.
 */
export interface SeatVoiceProfile {
  id: string;
  clientId: string;
  agent: "x" | "linkedin" | "reddit";
  seatId: string;
  /** Markdown content, built by the agent. */
  content: string;
  version: number;
  /** Named sources the sweep drew from (handle, prior posts, etc.), if reported. */
  sources?: string[];
  /** When the sweep that produced this content ran. */
  builtAt: number;
  /** The launch-run job that produced this content, if known. */
  builtByJobId?: string;
  createdAt: number;
  updatedAt: number;
}

/** A person with a seat inside a client business (platform-agnostic). */
export interface ClientSeat {
  id: string;
  clientId: string;
  /** Display name, e.g. "Albert Kattan". */
  name: string;
  /** kebab-case from name ("albert-kattan") — stable key for per-seat agent files. */
  slug: string;
  createdBy: string;
  createdAt: number;
  updatedAt: number;
}

/**
 * One agent's intake for one account: seatId null = the company page,
 * otherwise the seat. One doc per (clientId, agent, seatId). Only ASK fields
 * live here — voice/pillars/cadence are built by the agent, never collected.
 */
export interface AgentIntake {
  id: string;
  clientId: string;
  /** Agent family. Widen the union as more agents get intake. */
  agent: "x" | "linkedin" | "reddit";
  /** null = company-page intake; otherwise the ClientSeat id. */
  seatId: string | null;
  /**
   * Account identity on the platform: X = @handle, LinkedIn = profile/page
   * URL, Reddit = u/username. Null = none yet (company) / pending (seat
   * drafts, cannot post). Undefined for X's docs going forward — the X agent
   * moved this field to its clientContextDocs profile doc (see
   * upsertAgentProfileScope); LinkedIn and Reddit still store it here.
   */
  handle?: string | null;
  /** Company form only: how the brand wants to come across (the one asked voice input). Undefined for X — moved to its clientContextDocs profile doc. */
  comeAcross?: string;
  /** Anything we must never post. Undefined for X — moved to its clientContextDocs profile doc. */
  offLimits?: string;
  /** Engagement roster @handles; empty = engagement lane stays off. */
  roster: string[];
  /**
   * X Premium (long-form posts past 280 chars). Undefined = auto-detect: the
   * agent reads the account's checkmark and its own posting style at run time.
   */
  premium?: boolean;
  /** LinkedIn seats only — the person's company role, in their own words. */
  role?: string;
  /**
   * LinkedIn seats only — the lab seat form's "what should your profile focus
   * on": 2-4 topics the person wants to be known for (do-not-post lives in
   * offLimits).
   */
  focus?: string;
  /**
   * LinkedIn seats only — the inactive-on-LinkedIn fallback: which voice
   * source the person chose when they have little post history.
   * "writing" = a long piece of their own genuine writing (in fallbackText);
   * "about" = who-they-are notes / transcribed voice note (in fallbackText).
   */
  fallbackKind?: "writing" | "about";
  fallbackText?: string;
  /**
   * LinkedIn seats only — private CV upload (substance, not voice). Storage
   * path + durable download URL + original filename; never client-visible
   * outside this intake. The URL lets run-time injection attach the CV as a
   * context file.
   */
  cvPath?: string;
  cvUrl?: string;
  cvName?: string;
  cvUploadedAt?: number;
  /**
   * Reddit only — an honest read of the account's Reddit history (karma, age,
   * prior participation). The lab input contract makes this REQUIRED
   * alongside the username: a brand-new or all-promo account cannot safely
   * carry a product mention, so it runs warming mode until it has genuine
   * history. Auto-fillable from the read-only Reddit connector
   * (fetchRedditAccountHealth) when the client connects their account.
   */
  accountHistory?: string;
  /**
   * Reddit only — subreddits the client already participates in, as a
   * research STARTING POINT. The roster proper is derived by the agent from
   * the audience and category; this never replaces it.
   */
  subreddits?: string[];
  /**
   * Reddit only — subreddits that are off-limits (the client was burned or
   * banned there). Binding: the agent never drafts for these.
   */
  offLimitsSubreddits?: string[];
  /**
   * Reddit only — the disclosure posture the client is comfortable with, in
   * their own words. Used verbatim as the disclosure line on any draft that
   * carries a product mention.
   */
  disclosurePosture?: string;
  /**
   * Reddit only — program mode. "warming" = pure-value answers, zero product
   * mentions, until the account earns history. Undefined = let the agent
   * decide from the account history above (it defaults to warming, the safe
   * direction).
   */
  mode?: "warming" | "established";
  createdBy: string;
  createdAt: number;
  updatedAt: number;
}

/**
 * One row of the SHARED company news drop (SCRUM-51): consumed by the X agent
 * as whats-new.json and by the LinkedIn agent as company-updates.md Section A.
 */
export interface XNewsUpdate {
  id: string;
  clientId: string;
  title: string;
  /** YYYY-MM-DD — grounds the post; required by the engine. */
  date: string;
  detail?: string;
  url?: string;
  /** win/milestone / launch / customer story / culture / event / hire / partnership / other. */
  type?: string;
  /** Where any number in the update comes from (no source = posted without the number). */
  sourceUrl?: string;
  /** Who is featured + consent confirmed (spotlights/customer stories/quotes hold until set). */
  consent?: string;
  createdBy: string;
  createdAt: number;
}

/** One per-seat "Your takes & topics" row (feeds the pov connector; takes.json shape). */
export interface XTake {
  id: string;
  clientId: string;
  seatId: string;
  take: string;
  /** YYYY-MM-DD */
  date: string;
  topic?: string;
  url?: string;
  createdBy: string;
  createdAt: number;
}

/**
 * Per-draft feedback, captured per account so one account's corrections never
 * bleed into another's. Serialized into future runs as that account's
 * Learning Log.
 */
export interface XDraftFeedback {
  id: string;
  clientId: string;
  /** "company", "program" (applies to every account), or a ClientSeat id. */
  account: string;
  jobId?: string;
  assetId?: string;
  /**
   * Which draft in the batch: `${accountTitle} · ${laneHeading}`, minted by the
   * review pane and byte-identical wherever it is written (see x-options.ts's
   * header — the learning log joins on it). Raw lab vocabulary by design;
   * `refLaneLabel` is what a client reads.
   */
  draftRef?: string;
  /** "note" = free-form client feedback, not tied to one draft. */
  action: "posted" | "posted_with_edits" | "not_posted" | "note";
  /** posted_with_edits: the final text the client actually used. */
  finalText?: string;
  /** posted_with_edits: the drafted text before the client's edit — the other half of the diff alongside finalText. */
  originalText?: string;
  /** not_posted: why it was killed. */
  reason?: string;
  createdBy: string;
  createdAt: number;
}

/**
 * LinkedIn (e10) per-draft feedback — same contract as XDraftFeedback plus
 * the lab contract's "edit_request" action, its own collection so
 * per-platform Learning Logs never mix.
 */
export interface LiDraftFeedback {
  id: string;
  clientId: string;
  /** "company", "program" (applies to every account), or a ClientSeat id. */
  account: string;
  jobId?: string;
  assetId?: string;
  /**
   * Which draft in the batch: `${accountTitle} · ${laneHeading}`, minted by the
   * review pane and byte-identical wherever it is written (see x-options.ts's
   * header — the learning log joins on it). Raw lab vocabulary by design;
   * `refLaneLabel` is what a client reads.
   */
  draftRef?: string;
  /**
   * "note" = free-form client feedback, not tied to one draft.
   * "edit_request" = asks for a change to this draft (no posting hand-off).
   */
  action: "posted" | "posted_with_edits" | "not_posted" | "note" | "edit_request";
  /** posted_with_edits: the final text the client actually used. */
  finalText?: string;
  /** posted_with_edits: the drafted text before the client's edit — the other half of the diff alongside finalText. Mirrors XDraftFeedback's field; not yet wired since LinkedIn doesn't use the slot/option-pick model. */
  originalText?: string;
  /** not_posted: why it was killed. edit_request: what to change. */
  reason?: string;
  createdBy: string;
  createdAt: number;
}

/* ────────────── Client agents — the launch-vs-runs model (Phase 3) ──────────────
 *
 * Every content platform a client buys becomes ONE client agent ("Instagram
 * Agent for Geektime"): a per-client umbrella binding a lab agent
 * (customAgents) to the client. It owns a LAUNCH state machine (setup run →
 * template set → live), a registry of child TEMPLATE streams, a SLOT plan the
 * calendar renders (template + day + optional note, never content), two-level
 * FEEDBACK, and a launch-vs-run cost split.
 *
 * Nothing existing is replaced: PlannedScheduledRun stays the firing engine,
 * Asset.templateKey is already the template join key, markAssetPostedAction is
 * still the only client posted-transition. Collections are flat and keyed by
 * clientId per repo convention, Admin-SDK-only (firestore.rules stays
 * deny-all), timestamps epoch millis.
 */

/** Launch lifecycle of a client agent (Phase-3 §2 state machine). */
export type ClientAgentLaunchState =
  /** Bound to the client, nothing run yet. */
  | "not_launched"
  /** Setup job in flight (launchJobId set). */
  | "launching"
  /** Setup deliverables arrived; staff confirming the template registry. */
  | "curating"
  /** Launch complete — the recurring model is active. */
  | "live"
  /** Setup job failed / cancelled; the error is retained for staff. */
  | "launch_failed";

/**
 * One child template stream ("By The Numbers"). A small set (1–8) per
 * umbrella, so they live as an array on the parent doc rather than their own
 * collection.
 */
export interface ClientAgentTemplate {
  /** Slug — THE join key; equals Asset.templateKey for posts in this stream. */
  key: string;
  /** Display name ("By The Numbers"). */
  name: string;
  /** The launch run's rationale — "this is one of your templates because…". */
  rationale?: string;
  status: "active" | "paused" | "retired";
  /** Rotation order (0-based). Drives slot generation; client-editable. */
  position: number;
  /** Where this template came from. */
  source: "launch" | "backfill" | "manual";
  addedAt: number;
}

/**
 * The per-client umbrella agent. Doc id is deterministic —
 * `${clientId}__${agentKeySlug}` (see clientAgentDocId) — so upserts are
 * idempotent and a backfill is race-safe.
 *
 * Deliberately NOT stored here: cadence/hour/zone (owned by the linked
 * PlannedScheduledRun — no second clock), credit balances (clientCredits), and
 * feedback (its own collection; it grows unboundedly).
 */
export interface ClientAgent {
  id: string;
  clientId: string;
  /** customAgents.key of the bound lab agent (stable across re-imports). */
  agentKey: string;
  /** customAgents doc id at bind time (display-metadata lookup). */
  customAgentId: string;
  /** Client-facing name, e.g. "Instagram Agent". Defaults from the custom agent. */
  displayName: string;
  /**
   * Platform identity for icons/labels ("instagram" | "tiktok" | "x" | …),
   * derived at bind time from the agent identity and STORED, so renaming the
   * lab agent cannot silently re-platform the umbrella. Empty string when the
   * agent maps to no social platform.
   */
  platform: string;
  /**
   * Which chain family this umbrella's slots own. While it is live, the slot
   * planner owns this family for this client and plain reflow must not re-date
   * its assets. Absent for an options-mode umbrella (X): it owns no chain
   * family — its slots present picks from batch assets and never re-date.
   */
  chainFamily?: "social" | "email" | "article";
  /**
   * How this umbrella fills its calendar days. Set EXPLICITLY at bind time —
   * never derived from the absence of `chainFamily`.
   *
   * "single"  — one template stream per day (the default product).
   * "options" — the X daily pick-of-3: the client chooses between candidate
   *             drafts on the day, and the umbrella owns no chain family.
   *
   * Deriving this from `chainFamily == null` conflated the X agent with every
   * agent the family classifier simply could not place (a research agent, an
   * SEO agent, an unrecognised import), which would have handed those an
   * options picker they have no candidates for. Absent ⇒ "single", which
   * generates no slots at all while the rotation is empty.
   */
  slotMode?: "single" | "options";

  launchState: ClientAgentLaunchState;
  /** Platform job doc id of the setup run (jobs collection). */
  launchJobId?: string | null;
  launchStartedAt?: number | null;
  launchCompletedAt?: number | null;
  /**
   * Refusal/error retained for launch_failed. Stored RAW (staff truth);
   * clientSafeRefusal() is applied at the page boundary before it can reach a
   * client's RSC payload, exactly as toScheduleRows does for lastError.
   */
  launchError?: string | null;
  /** True when the failed launch's client charge was handed back. */
  launchRefunded?: boolean | null;

  templates: ClientAgentTemplate[];
  /**
   * Default rotation: template keys in firing order. The slot generator cycles
   * this; individual slots may override the template for their day.
   */
  rotation: string[];

  /** The weekly schedule row that fires this umbrella (plannedScheduledRuns id). */
  scheduleRunId?: string | null;

  createdBy: string;
  createdAt: number;
  updatedAt: number;
}

/** A client/staff note attached to one calendar day's slot. */
export interface AgentSlotNote {
  /** ≤ 500 chars, plain text (server-clamped). */
  text: string;
  authorUid: string;
  /**
   * Display name of the author, denormalized at write time — the same reason
   * ClientAgentFeedback keeps createdByName and ActivityLog keeps its actor.
   *
   * A surface serving BOTH viewers cannot derive the label from role alone:
   * "You", computed from authorRole === "client", is right for the client and a
   * lie to the staff member reading the same row. The label is computed from
   * viewer-vs-author; this is the half that has to be stored.
   */
  authorName?: string;
  authorRole: "client" | "staff";
  createdAt: number;
  /** Stamped when a generation/revision run actually received this note. */
  consumedAt?: number | null;
  consumedByJobId?: string | null;
}

/**
 * Recorded when the client picks one of an options slot's choices. The
 * learning-log source of truth stays XDraftFeedback; this is the slot-level
 * render state.
 */
export interface AgentSlotOptionPick {
  /** Which option was chosen — its ref within the linked batch asset, or its option key. */
  optionRef: string;
  /**
   * Humanised angle of the chosen option ("Playbook", "Founder POV"), stored at
   * pick time. The ref's tail is the lab's own lane vocabulary and must never
   * reach a client surface raw (F70); keeping the label here also saves
   * re-reading and re-parsing the batch asset on every render.
   */
  direction?: string;
  pickedAt: number;
  pickedBy: string;
  /** True when the client edited the text before confirming. */
  edited: boolean;
  /**
   * The option's drafted text, captured at pick time — the one moment it's
   * guaranteed correct, since the batch asset it was drawn from can go stale
   * or be re-imported later. Paired with the materialized Asset's (possibly
   * edited) content, this is the durable before/after diff; also copied onto
   * that Asset's `meta.originalText` so mark-as-posted can carry it into
   * XDraftFeedback without re-touching this slot doc.
   */
  originalText?: string;
}

/**
 * A calendar-day intent: template + day (+ optional note). What clients see on
 * the calendar — never content. Doc id `${clientAgentId}__${dateKey}`: one slot
 * per day per umbrella, matching the chain's one-post-per-day-per-family
 * invariant.
 */
export interface AgentSlot {
  id: string;
  clientId: string;
  clientAgentId: string;
  /**
   * Calendar-day identity, "YYYY-MM-DD" in the schedule's zone. This is the
   * INTENT side (wall calendar day + the parent schedule's IANA zone); derived
   * instants are computed through the run-cadence helpers. Not a timestamp —
   * the epoch-millis rule applies to instants, and a slot is a day.
   */
  dateKey: string;
  /**
   * "single" = one template, one post (default). "options" = the daily
   * 3-option pick model (X). Absent ⇒ "single".
   */
  kind?: "single" | "options";
  /**
   * single: the stream this day produces. options: a fixed key ("daily-post")
   * so calendar chips still render a stable label.
   */
  templateKey: string;
  status:
    /** Future intent — nothing client-visible exists. */
    | "planned"
    /** Content exists and the day has arrived (the client can act). */
    | "generated"
    /** Its asset reached status published. */
    | "posted"
    /** Client/staff removed the day (kept for history). */
    | "skipped";
  /**
   * The fulfilling asset once one is matched/created. For an options slot:
   * before the pick, the staff-side batch asset the options are drawn from;
   * after the pick, the materialized per-day asset.
   */
  assetId?: string | null;
  /** The generation job for day-of runs. */
  jobId?: string | null;
  /** options slots only: the candidate refs assigned to this day. */
  optionRefs?: string[];
  /** options slots only: set once the client picks. */
  optionPick?: AgentSlotOptionPick | null;
  note?: AgentSlotNote | null;
  createdBy: string;
  createdAt: number;
  updatedAt: number;
}

/**
 * Two-level client-agent feedback: the whole agent, or one template stream.
 *
 * NOT the existing `Feedback` collection: that one is the doc-correction log
 * (docType / single_doc / global) consumed by the context-doc pipeline, and
 * overloading it would leak template feedback into doc-correction consumers.
 * The per-draft learning logs (XDraftFeedback / LiDraftFeedback) stay the
 * third, item-level tier.
 */
/** What kind of note a feedback row is — see `ClientAgentFeedback.category`. */
export type FeedbackCategory = "tone" | "formatting" | "topic_preference" | "other";

export interface ClientAgentFeedback {
  id: string;
  clientId: string;
  clientAgentId: string;
  /** "agent" = global, shapes every template; "template" = one stream. */
  scope: "agent" | "template";
  /** Required when scope === "template"; must match a registry key. */
  templateKey?: string | null;
  /** ≤ 500 chars, plain text (server-clamped). */
  text: string;
  /**
   * Optional tag for what kind of note this is. Cosmetic only — it changes
   * nothing about scope, caps, or injection (`selectInjectedFeedback` and
   * `renderFeedbackMarkdown` both ignore it entirely); it exists so the
   * analytics history table can be filtered/grouped without re-reading every
   * row's free text. Absent on every row written before this field existed —
   * callers must treat missing as "uncategorized", never backfill a guess.
   */
  category?: FeedbackCategory | null;
  /**
   * active    = injected into every future run.
   * resolved  = STAFF addressed it. Kept, not injected.
   * withdrawn = the AUTHOR took it back. Kept, not injected.
   *
   * The last two are deliberately not one state (D7). "Resolved" is a claim
   * about Karos having acted; a client who withdraws their own note has made no
   * such claim, and collapsing the two told them their note had been handled
   * when nobody had touched it. Only `active` is ever injected, so the run-side
   * behaviour of the two is identical — the difference is entirely about who
   * did it and what the list is therefore allowed to say.
   */
  status: "active" | "resolved" | "withdrawn";
  createdBy: string;
  /**
   * Display name of the author, denormalized at write time. Stored so the
   * feedback list can name whoever wrote a row without handing a client viewer
   * the internal uids of the staff who answered them — the same reason
   * ActivityLog keeps `actor` rather than a uid.
   */
  createdByName?: string;
  creatorRole: "client" | "staff";
  createdAt: number;
  updatedAt: number;
}

/**
 * Reddit per-draft feedback — the same contract as LiDraftFeedback, in its own
 * collection so per-platform Learning Logs never mix, plus the two fields the
 * Reddit contract turns on:
 *
 * - `reasonCode` is a CLOSED set the weekly manager acts on mechanically: two
 *   "too_promotional" rows against one subreddit downgrade that subreddit to
 *   value-only or drop it the same run. Free text alone cannot drive that, and
 *   an unrecognized code silently degrading to prose would corrupt the signal.
 * - `subreddit` is what makes the aggregation possible without a second
 *   collection: the rule is per-subreddit, not per-account.
 *
 * "removed" is Reddit's strongest negative signal — an answer taken down by
 * automod or mods. That pattern is never repeated in that subreddit.
 */
export interface RedditDraftFeedback {
  id: string;
  clientId: string;
  /** "company", "program" (applies to every account), or a ClientSeat id. */
  account: string;
  jobId?: string;
  assetId?: string;
  /**
   * Which draft in the batch: `${accountTitle} · ${laneHeading}`, minted by the
   * review pane and byte-identical wherever it is written (see x-options.ts's
   * header — the learning log joins on it). Raw lab vocabulary by design;
   * `refLaneLabel` is what a client reads.
   */
  draftRef?: string;
  /**
   * "note" = free-form client feedback, not tied to one draft.
   * "edit_request" = asks for a change to this draft (no posting hand-off).
   */
  action: "posted" | "posted_with_edits" | "not_posted" | "note" | "edit_request";
  /** posted_with_edits: the final text the client actually used. */
  finalText?: string;
  /** not_posted: why it was killed. edit_request: what to change. */
  reason?: string;
  /** not_posted: the closed-set reason the manager aggregates per subreddit. */
  reasonCode?: "too_promotional" | "wrong_subreddit" | "thread_died" | "rules" | "removed" | "other";
  /** The subreddit the draft targeted — the key the promo-verdict rule aggregates on. */
  subreddit?: string;
  /** The thread the draft answered, for the audit trail. */
  threadUrl?: string;
  createdBy: string;
  createdAt: number;
}
