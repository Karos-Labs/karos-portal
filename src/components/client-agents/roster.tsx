import { ClientAgentRosterRow } from "./roster-row";
import type { RosterAttentionReason } from "@/lib/client-agent-rows";
import type { RosterStatus } from "@/lib/client-agents";

/**
 * One row of the client's agent roster, already resolved server-side.
 *
 * Deliberately NOT ClientAgentCardRow. That type carries everything the old
 * all-in-one card needed - template registries, per-template gates, the week
 * strip, the feedback list, the schedule - and none of it is readable on a
 * roster any more. Sending it anyway would put a client's whole agent state
 * into the RSC payload of a page that shows four words, which is both wasteful
 * and the kind of over-sending that turns into a leak the moment someone adds a
 * field. The roster asks for exactly what it paints.
 */
export interface AgentRosterEntry {
  /** The lab agent's id - the [agentId] segment of the detail route. */
  customAgentId: string;
  /** `"<key> <name>"`, for the platform mark. */
  identity: string;
  icon?: string | null;
  displayName: string;
  blurb: string | null;
  status: RosterStatus;
  /**
   * The newest thing this agent produced that THIS viewer may see: the title and
   * the viewer's own deliverable stamp (round 6, think-agents §4).
   *
   * A DELIVERED title, and only that. It is already in the client's Workspace,
   * so naming it on the roster publishes nothing they cannot already read - and
   * that is exactly why the field carries no status, no draft marker and no
   * count. Anything that distinguished a pre-generated post from a day-of one
   * would put the batch shape back on the page the archive filter took it off
   * (A3/A4).
   */
  lastMade?: { title: string; at: number } | null;
  /**
   * The next planned DAY for this agent (epoch millis): the earliest client-
   * visible calendar item inside the 14-day window, or the schedule's next fire
   * when there is nothing on the calendar yet.
   *
   * A DAY, never a title and never a count. The client's own calendar already
   * shows that day as a locked chip, which is the whole reason it may be named
   * here; what sits on it is the calendar's business.
   */
  nextAt?: number | null;
  /**
   * Why an "attention" row needs someone: which of the three fixes it points at.
   * The status WORD is unchanged by it (ruling 4 keeps the seven words); this is
   * the reason behind the word, and it is what decides the row's verb.
   */
  attentionReason?: RosterAttentionReason | null;
  /**
   * STAFF ONLY: one line of operator state - drafts waiting, an empty intake,
   * the schedule's pace (CD-I1).
   *
   * The client's roster never sets it, and that is the whole design: "3 drafts
   * waiting for review" is a fact about the staff queue, and on a client's
   * roster it would announce that work exists before anyone approved it (A3/A4).
   * It is a STRING, resolved server-side, not a set of fields the row
   * re-derives - the row cannot leak what it was never sent.
   *
   * Rendered behind a mono INTERNAL marker (parity pass 2026-09): it used to be
   * a plain grey line under the blurb, indistinguishable from the client's own
   * copy, on a surface that otherwise looks identical to theirs.
   */
  note?: string | null;
  /**
   * STAFF ONLY: this agent is not in the client's `customAgentIds` (A4, parity
   * pass 2026-09).
   *
   * The staff roster is a SUPERSET of the client's — every enabled bound agent,
   * so an operator can see what is available to grant — and until this flag
   * nothing distinguished the extra rows from the client's own. Kept out of
   * `status` deliberately: the agent's status is whatever it is, and this is a
   * fact about which VIEW you are looking at.
   */
  notGranted?: boolean;
}

/**
 * The client's agents, as a stack of full-width rows that open (round 6,
 * decision 6).
 *
 * A server component: no state, no handlers, nothing to hydrate - the rows are
 * links. That also keeps the staff bind control and the template curation pane
 * (both client components in client-agents-section.tsx) out of a client's
 * bundle entirely rather than merely out of their view.
 *
 * Spacing is tight at phone width and only opens up from `sm` (CD-G8): Albert's
 * narrow-viewport screenshot showed the agents page stacking near-empty
 * sections with `mt-10` between them, leaving a viewport of dead air above the
 * fold.
 */
export function ClientAgentRoster({
  clientId,
  entries,
  now: nowProp,
}: {
  clientId: string;
  entries: AgentRosterEntry[];
  /**
   * The clock the page resolved every other answer against (the delivered-work
   * join, the refusal window, the upcoming predicate). Optional only so the
   * roster keeps rendering for a caller that has not threaded it; a caller that
   * has one should pass it, so a row's "2d ago" cannot disagree with the status
   * word beside it.
   */
  now?: number;
}) {
  if (entries.length === 0) return null;
  // A server component renders once per request, so the fallback is a single
  // read and not a re-render hazard. It is only a fallback: a caller that
  // resolved the page's statuses against its own `now` should pass that one, so
  // a row's stamp and the badge beside it report the same moment. The directive
  // has to be the LAST line before the statement (it applies to the next SOURCE
  // line), which is the shape client-home-overview.tsx settled on.
  // eslint-disable-next-line react-hooks/purity
  const now = nowProp ?? Date.now();
  return (
    <section className="mt-5 sm:mt-6">
      <div className="space-y-2">
        {entries.map((entry) => (
          <ClientAgentRosterRow
            key={entry.customAgentId}
            href={`/clients/${clientId}/agents/${entry.customAgentId}`}
            identity={entry.identity}
            icon={entry.icon ?? null}
            displayName={entry.displayName}
            blurb={entry.blurb}
            status={entry.status}
            lastMade={entry.lastMade ?? null}
            nextAt={entry.nextAt ?? null}
            attentionReason={entry.attentionReason ?? null}
            note={entry.note ?? null}
            notGranted={entry.notGranted ?? false}
            now={now}
          />
        ))}
      </div>
    </section>
  );
}
