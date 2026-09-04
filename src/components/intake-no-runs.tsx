"use client";

import { EmptyState } from "@/components/ui";
import { Icon } from "@/components/icon";

/**
 * "No runs yet", on an intake page — flow audit 2026-09, R9 · NN/g *Designing
 * Empty States in Complex Applications*.
 *
 * WHAT WAS THERE BEFORE: nothing. All six intake surfaces render their run
 * history as `runs.length > 0 ? <ul/> : null`, so a client who had just filled
 * the form in — the reader most likely to be looking — got a card that stopped
 * after its first paragraph, with no statement that the list was empty rather
 * than broken and no way to make it fill. NN/g's three duties for an empty
 * region are to report system status, teach what will appear there, and offer
 * a control that starts the work; `ui.tsx`'s EmptyState has taken an `action`
 * node the whole time and not one client-facing caller passed one.
 *
 * THE ACTION IS THE AGENT ROSTER, not the archive: the archive is where output
 * lands, and pointing an empty history at an empty archive is a second dead end
 * dressed as a way out. The roster is where the run gestures live ("Create new
 * post", "Run now"), it is always reachable, and it needs nothing from the
 * caller but the client id — these components do not know their own agent's id,
 * and inventing a prop for it would put the same link one prop-hop further from
 * the page that already carries it in its header.
 */
export function IntakeNoRuns({
  clientId,
  /** What this agent produces, in the client's words: "articles", "replies". */
  noun,
}: {
  clientId: string;
  noun: string;
}) {
  return (
    <div className="mt-3">
      <EmptyState
        icon={<Icon name="Clock" className="h-6 w-6" />}
        title="No runs yet"
        description={`Nothing has run for you yet. When it does, the run shows up here and your ${noun} land in your archive.`}
        action={
          <a
            href={`/clients/${clientId}/agents`}
            className="inline-flex items-center gap-1 text-sm font-medium text-foreground hover:text-neon"
          >
            See your agents
            <Icon name="ChevronRight" className="h-3.5 w-3.5" />
          </a>
        }
      />
    </div>
  );
}
