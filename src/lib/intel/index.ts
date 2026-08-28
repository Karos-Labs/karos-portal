import "server-only";

export { INTEL_AGENT_ID, runIntelReportPipeline } from "./report";
export { DEFAULT_INTEL_PROMPT, RESEARCH_ENGINE_RULES, METRICS_RULES, CONDENSATION_RULES } from "./brain";
export { TEMPLATES } from "./templates";
export { runOnboardPipeline, applyDocCorrections } from "./pipeline";
// SCRUM-272 (T-B20) — the post-cutover producer of the context documents,
// built on the real agent-engine Intel Report and SEO/GEO agents per D1
// (SCRUM-277, decision 5 of the 2026-08-28 record). It is not yet on the
// onboarding path: flipping `runOnboardPipeline` over to it is the cutover,
// T-B19 / SCRUM-274, which this ticket blocks.
export {
  runAgentOnboarding,
  runAgentOnboardingForClient,
  composeContextDocsFromAgentReports,
  assertContextDocSetShape,
  ContextDocShapeError,
  CONTEXT_DOC_SET_CONTRACT,
  INTERNAL_CONTEXT_DOC_TYPES,
  INTERNAL_ONLY_CONTEXT_DOC_TYPES,
  STORED_CONTEXT_DOC_FIELDS,
  INTEL_REPORT_DELIVERABLE_KIND,
  SEO_GEO_DELIVERABLE_KIND,
} from "./agent-onboarding";
export type { StoredContextDoc, OnboardingDocType, AgentOnboardingDeps } from "./agent-onboarding";
export { runSeoGeoResearch } from "./seo-geo";
export type { SeoGeoResearch } from "./seo-geo";
export { refreshClientCondensedDocs, condenseDocs } from "./condense";
export type { CondensedDoc } from "./condense";
