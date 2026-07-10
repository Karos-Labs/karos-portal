/**
 * The hardcoded managed-product catalog (social_post / newsletter_issue /
 * blog_article / landing_page) was retired 2026-07. Every agent is now a
 * repo-imported CustomAgent (see lib/agent-service/custom-agent-import.ts) run
 * through the agent service's single "custom" task type. This file keeps only
 * the shared agent-service agent id stamped on mirrored `jobs` docs.
 */

/** agentId used on the mirrored platform `jobs` docs for managed runs. */
export const AGENT_SERVICE_AGENT_ID = "agent-service";
