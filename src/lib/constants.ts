/**
 * Central constant registry for Karos CMO.
 * Model IDs and token limits live here — never inline in pipeline files.
 * To upgrade a model: change it once here, rebuild.
 */

export const MODELS = {
  /** High-capability — used for Intel Report generation, research agents, and doc generation. */
  SONNET: "claude-sonnet-4-6",
  /** Fast + cheap — used for summaries, branding extraction, brief generation, and tasks. */
  HAIKU: "claude-haiku-4-5-20251001",
} as const;

export type ModelId = (typeof MODELS)[keyof typeof MODELS];

/** Max output tokens for full internal context documents (Sonnet 4.6 ceiling). */
export const DOC_MAX_TOKENS = 16_000;

/**
 * External answer-engine models used by the SEO/GEO visibility capture
 * (src/lib/intel/seo-geo-providers.ts). Keys come strictly from env:
 * OPENAI_API_KEY / GEMINI_API_KEY (GCP Secret Manager in production).
 */
export const SEO_GEO_CAPTURE = {
  /** Answers the "chatgpt" engine column. */
  OPENAI_MODEL: "gpt-4o-mini",
  /** Answers the "gemini" engine column (search-grounded). */
  GEMINI_MODEL: "gemini-2.5-flash",
} as const;

/** Max output tokens for condensed client-facing documents. */
export const CONDENSE_MAX_TOKENS = 8_000;

/**
 * Company alias email that receives KAROS_ADMIN when signing up with a staff key.
 * Override with KAROS_COMPANY_ALIAS env var to avoid hardcoding business rules in source.
 */
export const COMPANY_ALIAS_EMAIL =
  process.env.KAROS_COMPANY_ALIAS ?? "hello@karoslabs.com";

/**
 * Hard cap on active (pending / in_progress / review_pending) KAROS-MANAGED
 * tasks per client — this bounds the AI-agent execution queue only;
 * client_managed tasks (OAuth onboarding, approvals, website edits) are exempt
 * and uncapped. Set to 15 rather than 10 because a single 7-day multi-channel
 * content-dispatch plan can legitimately exceed 10 agent tasks on its own.
 * Enforced at every task-creation entry point: the Copilot create_tasks and
 * fetch_gmail_context tools and the quick-add ingester.
 */
export const MAX_ACTIVE_TASKS = 15;

/**
 * Display labels for managed action-item statuses, in lifecycle order.
 * Shared by the dashboard UI and the audit-history writers.
 */
export const ACTION_ITEM_STATUS_LABELS = {
  open: "Open",
  in_progress: "In Progress",
  in_review: "In Review",
  done: "Done",
} as const;

export const ACTION_ITEM_STATUSES = ["open", "in_progress", "in_review", "done"] as const;
