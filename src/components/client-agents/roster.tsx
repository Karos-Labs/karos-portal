import { ClientAgentRosterCard } from "./roster-card";
import type { RosterStatus } from "@/lib/client-agents";

/**
 * One row of the client's agent roster, already resolved server-side.
 *
 * Deliberately NOT ClientAgentCardRow. That type carries everything the old
 * all-in-one card needed — template registries, per-template gates, the week
 * strip, the feedback list, the schedule — and none of it is readable on a
 * roster any more. Sending it anyway would put a client's whole agent state
 * into the RSC payload of a page that shows four words, which is both wasteful
 * and the kind of over-sending that turns into a leak the moment someone adds a
 * field. The roster asks for exactly what it paints.
 */
export interface AgentRosterEntry {
  /** The lab agent's id — the [agentId] segment of the detail route. */
  customAgentId: string;
  /** `"<key> <name>"`, for the platform mark. */
  identity: string;
  icon?: string | null;
  displayName: string;
  blurb: string | null;
  status: RosterStatus;
}

/**
 * The client's agents, as a grid of cards that open (CD-G1).
 *
 * A server component: no state, no handlers, nothing to hydrate — the cards are
 * links. That also keeps the staff bind control and the template curation pane
 * (both client components in client-agents-section.tsx) out of a client's
 * bundle entirely rather than merely out of their view.
 *
 * Spacing is tight at phone width and only opens up from `sm` (CD-G8): Albert's
 * narrow-viewport screenshot showed the agents page stacking near-empty
 * sections with `mt-10` between them, leaving a viewport of dead air above the
 * fold. A section that is mostly cards does not need a 40px gutter to be legible
 * on a 375px screen.
 */
export function ClientAgentRoster({
  clientId,
  entries,
}: {
  clientId: string;
  entries: AgentRosterEntry[];
}) {
  if (entries.length === 0) return null;
  return (
    <section className="mt-5 sm:mt-6">
      <div className="grid gap-2.5 sm:grid-cols-2 sm:gap-3">
        {entries.map((entry) => (
          <ClientAgentRosterCard
            key={entry.customAgentId}
            href={`/clients/${clientId}/agents/${entry.customAgentId}`}
            identity={entry.identity}
            icon={entry.icon ?? null}
            displayName={entry.displayName}
            blurb={entry.blurb}
            status={entry.status}
          />
        ))}
      </div>
    </section>
  );
}
