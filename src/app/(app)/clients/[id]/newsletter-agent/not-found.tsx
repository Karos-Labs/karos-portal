import { AgentNotOnPlan } from "@/components/agent-not-on-plan";

/**
 * The boundary `requireIntakeAgentAccess`'s `notFound()` lands on for this
 * intake route (flow audit 2026-09, R9). Without it a client without the grant
 * got the workspace-wide "We couldn't find that page" — true of a typo, wrong
 * about a plan, and offering nothing but "Back to dashboard".
 *
 * One file per intake segment because Next resolves the NEAREST boundary and
 * these six routes are siblings, not a shared segment. Everything they say is
 * in the one component.
 */
export default function AgentIntakeNotFound() {
  return <AgentNotOnPlan />;
}
