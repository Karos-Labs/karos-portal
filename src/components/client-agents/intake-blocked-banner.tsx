import { Icon } from "@/components/icon";

/**
 * SCRUM-404 — "this agent is waiting on something from you".
 *
 * An agent-engine run that resolves to `blocked_intake` never started: a
 * context document the agent must be grounded in is not on file. The portal
 * maps that to `job.status: "failed"` (deliberately — see `reconcile.ts`), and
 * the client-facing surfaces deliberately do not show a client our failures
 * (AF-14). The result was a run that vanished for the one person who could
 * clear it: no asset, no notice, an agent that simply never produced. So this
 * reads `job.blockedReason`, which exists only for this outcome.
 *
 * ## Deliberately shaped like {@link RunsPausedNotice}, not like its predecessor
 *
 * This banner first shipped as a four-sentence amber block — problem, cause,
 * instruction, reassurance — in the same slot. Portal feedback round 2 removed
 * exactly that shape from three places at once, because "read on a client's own
 * agents page it landed as an outage alarm, which is not what a paused queue
 * is." Reintroducing it here would have undone that in the fourth place. Same
 * amber hairline, same `role="status"`, one short line per register.
 *
 * ## Where it legitimately differs
 *
 * `RunsPausedNotice` tells a client not to contact anyone, because Karos clears
 * a paused queue. **Here the client is the only one who can clear it**, so the
 * client register carries the engine's reason verbatim — that reason names the
 * specific missing document, and it is the entire actionable content. Nothing
 * is paraphrased: this component does not restate a decision it does not own.
 */
export function IntakeBlockedBanner({
  reason,
  viewerIsClient,
  outputNoun = "run",
}: {
  /** The engine's `blocked_intake` reason, verbatim. */
  reason: string;
  viewerIsClient: boolean;
  /** What a run produces for this agent ("post", "issue") — the detail page's own word, as `RunsPausedNotice` takes it. */
  outputNoun?: string;
}) {
  const clientCopy = `This agent can't start a ${outputNoun} yet: ${reason} Everything else here still works.`;
  const staffCopy = `Last run resolved blocked_intake, so it never started: ${reason}`;
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
