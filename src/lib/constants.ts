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

/** Max output tokens for condensed client-facing documents. */
export const CONDENSE_MAX_TOKENS = 8_000;

/**
 * Company alias email that receives KAROS_ADMIN when signing up with a staff key.
 * Override with KAROS_COMPANY_ALIAS env var to avoid hardcoding business rules in source.
 */
export const COMPANY_ALIAS_EMAIL =
  process.env.KAROS_COMPANY_ALIAS ?? "hello@karoslabs.com";
