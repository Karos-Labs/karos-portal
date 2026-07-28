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
  /** Answers the "gemini" engine column (search-grounded via tools:[{google_search:{}}]).
   *  gemini-flash-latest is the model the a3 dev handoff (2026-07-14) verified live for
   *  grounded capture; older pinned flash models (2.5-flash) are blocked for new keys. */
  GEMINI_MODEL: "gemini-flash-latest",
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
 * Safety valve on the client-level AI-processing lock (Client.isAiProcessing).
 * A lock older than this is treated as stale and silently overridden on the
 * next acquire attempt instead of blocking forever — covers a background run
 * that died without reaching its `finally` (dev-server restart, Turbopack HMR
 * killing an in-flight `after()`, a serverless timeout). The real pipeline
 * (Intel Report + SEO/GEO + Task Map swarm) normally finishes in a few
 * minutes; 20 minutes gives generous headroom before treating it as dead.
 */
export const AI_PROCESSING_LOCK_STALE_MS = 20 * 60 * 1000;

/**
 * Single source of truth for "is the workspace lock actually still in effect" —
 * used both by the server-side acquire check (data.ts) and every UI spot that
 * greys out Regenerate/Refresh Task Map. Pure and import-safe from client
 * components: reading `client.isAiProcessing` directly in the UI would keep
 * showing a locked state forever once a run dies without releasing it, with no
 * way for the user to even click Regenerate to clear it.
 */
export function isAiProcessingLockActive(client: {
  isAiProcessing?: boolean;
  aiProcessingStartedAt?: number;
}): boolean {
  if (!client.isAiProcessing) return false;
  const age = Date.now() - (client.aiProcessingStartedAt ?? 0);
  return age < AI_PROCESSING_LOCK_STALE_MS;
}

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

/**
 * Spendable-credit level at or below which the agency should act BEFORE the
 * client hits a wall. Matches the copilot's own "under 20" prompt rule
 * (src/app/api/clients/[id]/chat/route.ts) so the staff-facing warning and the
 * client-facing nudge fire on the same number.
 *
 * Lives here rather than in credits.ts only because that module is the
 * client-safe pricing surface owned by the billing work; fold the two together
 * when they next meet.
 */
export const LOW_CREDIT_THRESHOLD = 20;

/* ── Narrow-viewport shell chrome (CD-G9) ──────────────────────────────── */

/**
 * Height in px of the mobile bottom tab bar rendered below `md` by every shell
 * that shows the client 4-tab nav — `client-rail.tsx` today, the staff shell in
 * client context once CD-G9a lands. Derived from that bar's own box:
 * `py-2` (8+8) + `h-5` icon (20) + `gap-1` (4) + `text-[10px]` label (~13) +
 * `border-t` (1) = 54.
 *
 * Anything else pinned to the bottom at narrow width must sit directly ABOVE
 * the bar, so the bar and its dependants have to move together.
 */
export const MOBILE_TAB_BAR_H = 54;

/**
 * Tailwind offset that parks a `fixed` element directly above that bar.
 *
 * Spelled out as a literal rather than interpolated from `MOBILE_TAB_BAR_H`
 * because Tailwind extracts class names by scanning source text — a computed
 * `bottom-[${n}px]` produces no CSS at all. Keep the two in sync by hand; the
 * number above is the single source of truth for the bar's own height.
 */
export const MOBILE_TAB_BAR_OFFSET_CLASS = "bottom-[54px]";
