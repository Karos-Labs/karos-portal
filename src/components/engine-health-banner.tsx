import { RunsPausedNotice } from "@/components/runs-paused-notice";

/**
 * The agent-engine counterpart to the agent-service "runs are paused"
 * notice (`agents/page.tsx`, `agents/[agentId]/page.tsx`) — SCRUM-264.
 *
 * Mounted only where `shouldShowEngineHealthBanner` (`@/lib/agent-engine/
 * health`) says this client is actually cut over to agent-engine AND its
 * dispatch transport is unconfigured, so it never appears for a client whose
 * runs still go to agent-service unaffected.
 *
 * Since portal feedback round 2 (2026-09) it is a thin name over
 * RunsPausedNotice: one notice, one register per reader, the cause named
 * only to staff. The export survives because three mounts and their tests
 * address the engine case by this name.
 */
export function EngineHealthBanner({ viewerIsClient }: { viewerIsClient: boolean }) {
  return <RunsPausedNotice viewerIsClient={viewerIsClient} cause="engine" />;
}
