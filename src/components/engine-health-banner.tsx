import { Icon } from "@/components/icon";

/**
 * The agent-engine counterpart to the agent-service "runs are paused"
 * notice (`agents/page.tsx`, `agents/[agentId]/page.tsx`) — SCRUM-264.
 *
 * Mounted only where `shouldShowEngineHealthBanner` (`@/lib/agent-engine/
 * health`) says this client is actually cut over to agent-engine AND its
 * dispatch transport is unconfigured, so it never appears for a client whose
 * runs still go to agent-service unaffected.
 *
 * Two registers, same idiom the agent-service banner already uses on both
 * pages that mount it: a client viewer is told to contact Karos, a staff
 * viewer — the one who clears this — is told the cause.
 */
export function EngineHealthBanner({ viewerIsClient }: { viewerIsClient: boolean }) {
  return (
    <p className="mb-4 rounded-[var(--radius)] border border-warning/30 bg-warning/10 px-4 py-3 text-sm text-warning">
      <Icon name="TriangleAlert" className="mr-1.5 inline h-4 w-4" />
      {viewerIsClient
        ? "Agent runs are paused right now. Starting a new run will not work until this clears. Contact your Karos team if you need a run today. Everything below is unaffected."
        : "Agent runs are paused. This client is routed to agent-engine and its dispatch transport is not configured, so runs will fail until it is set. Everything below is unaffected."}
    </p>
  );
}
