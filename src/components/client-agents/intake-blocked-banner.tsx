import { Icon } from "@/components/icon";

/**
 * SCRUM-404 — "this agent is waiting on something from you".
 *
 * An agent-engine run that resolves to `blocked_intake` never started: a
 * context document the agent is required to be grounded in is not on file. The
 * portal maps that to `job.status: "failed"` (deliberately — see
 * `reconcile.ts`), and the client-facing surfaces deliberately do not show a
 * client our failures (AF-14). The result was a run that vanished for the one
 * person who could clear it: no asset, no notice, and an agent that simply
 * never produced anything.
 *
 * So this reads `job.blockedReason`, which exists only for this outcome, and
 * says the one thing the reader can act on. Same idiom and slot as
 * `EngineHealthBanner`: two registers, warning tone, and an explicit
 * "everything below is unaffected" so the notice cannot be read as the agent
 * being broken.
 *
 * The engine's reason is printed verbatim rather than paraphrased — it names
 * the specific missing document, which is the entire actionable content.
 */
export function IntakeBlockedBanner({
  reason,
  viewerIsClient,
}: {
  reason: string;
  viewerIsClient: boolean;
}) {
  return (
    <p className="mb-4 rounded-[var(--radius)] border border-warning/30 bg-warning/10 px-4 py-3 text-sm text-warning">
      <Icon name="TriangleAlert" className="mr-1.5 inline h-4 w-4" />
      {viewerIsClient
        ? `This agent's last run stopped before it started because something it needs is not on file yet: ${reason} Add it and run again. Nothing below is affected.`
        : `Last run resolved blocked_intake — the run never started. Engine reason: ${reason} Clearing the missing intake and re-running is the fix. Nothing below is affected.`}
    </p>
  );
}
