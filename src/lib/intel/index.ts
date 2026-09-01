import "server-only";

export { INTEL_AGENT_ID, runIntelReportPipeline } from "./report";
export { DEFAULT_INTEL_PROMPT, RESEARCH_ENGINE_RULES, METRICS_RULES, CONDENSATION_RULES } from "./brain";
export { applyDocCorrections } from "./doc-corrections";
// SCRUM-274 (T-B19) — the cutover. `runOnboardPipeline` (the hardcoded
// onboarding pipeline D1 killed, `src/lib/intel/pipeline.ts`) is deleted, not
// merely bypassed — see this ticket's report for the file-by-file account.
// `runAgentOnboardingForClient` below (T-B20/SCRUM-272) is now the only
// producer of the context documents; Phase B of `runIntelReportPipeline`
// (report.ts) calls it directly, not through this barrel.
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
export { refreshClientCondensedDocs, condenseDocs } from "./condense";
export type { CondensedDoc } from "./condense";
