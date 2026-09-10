import { Icon } from "@/components/icon";

/**
 * THE ONE "runs are paused" notice (portal feedback round 2, 2026-09).
 *
 * It used to be three hand-copied paragraphs — the roster page, the agent
 * detail page and the agent-engine counterpart (`EngineHealthBanner`) — each a
 * four-sentence block of amber text: the problem, a warning, an instruction
 * to contact Karos, and a reassurance. Read on a client's own agents page it
 * landed as an outage alarm, which is not what a paused queue is. The product
 * owner's note on it was one word: fix.
 *
 * One component, one register per reader, one short sentence each:
 *   · a CLIENT is told the state and that nothing else is affected — the
 *     Karos team already knows, so "contact us" is not their job;
 *   · STAFF, who are the people who clear it, are told the cause.
 * Same amber hairline as before (warning is the right tone; it is the volume
 * that was wrong), and `role="status"` so a screen reader hears it once
 * rather than as an alert on every render.
 */
export function RunsPausedNotice({
  viewerIsClient,
  cause,
  outputNoun = "run",
}: {
  viewerIsClient: boolean;
  /**
   * Which transport is down. `service`: the agent-service environment is not
   * configured (AGENT_SERVICE_URL / AGENT_SERVICE_TOKEN). `engine`: this client
   * is routed to agent-engine and its dispatch transport is unconfigured.
   */
  cause: "service" | "engine";
  /** What a run produces for this agent ("post", "issue") — the detail page's own word. */
  outputNoun?: string;
}) {
  const clientCopy = `Runs are paused for the moment, so a new ${outputNoun} can't start yet. Everything else here still works.`;
  const staffCopy =
    cause === "engine"
      ? "Runs are paused: this client is routed to agent-engine and its dispatch transport is not configured."
      : "Runs are paused: the agent-service environment is not configured (AGENT_SERVICE_URL / AGENT_SERVICE_TOKEN).";
  return (
    <p
      role="status"
      className="mb-4 flex items-start gap-2.5 rounded-[var(--radius)] border border-warning/30 bg-warning/10 px-4 py-3 text-sm text-warning"
    >
      <Icon name="TriangleAlert" className="mt-0.5 h-4 w-4 shrink-0" aria-hidden="true" />
      <span>{viewerIsClient ? clientCopy : staffCopy}</span>
    </p>
  );
}
