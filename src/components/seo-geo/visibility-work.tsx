import Link from "next/link";
import { Badge, buttonClass, Card } from "@/components/ui";
import { AgentIdentity } from "@/components/agent-identity";
import { FlagButton } from "@/components/seo-geo/flag-button";
import { RosterStatusBadge } from "@/components/client-agents/roster-row";
import { VISIBILITY_WORK_STANDFIRST, type VisibilityLever } from "@/lib/visibility-levers";
import type { RosterStatus } from "@/lib/client-agents";

/**
 * "WHAT WE ARE DOING TO IMPROVE YOUR SEO AND GEO" (round 6, 2026-09).
 *
 * Albert: "ADD above it a section ... list every relevant Karos agent with what
 * it does for visibility ... each with a button that links DIRECTLY to that
 * agent's page." Nothing on the Reporting tab connected the scores to the agents
 * that move them: the report's own presenter refuses to name an agent because
 * the panel is never handed the client's grants, and the only "what Karos does"
 * pointer was a hand-built card for one agent (Reputation) sitting after the
 * report. That card is gone; the Reputation agent is a row here.
 *
 * THE STATUS WORD IS THE ROSTER'S OWN, resolved by `buildClientRosterEntries`
 * and painted by the roster's own `RosterStatusBadge`, so Reporting, the Agents
 * page and an agent's detail page cannot hold three opinions about whether an
 * agent is Live. That was the logic bug Albert named, and this section would
 * have been the fourth opinion.
 *
 * ONE new word, for the one state a client's roster never has: "Not on your
 * plan", and it belongs to a row with NO ROSTER ENTRY AT ALL — a family off the
 * catalogue table, which is `status: null` (round 6 review, D4). Every
 * roster-derived row prints the roster's own word, granted or not: an ungranted
 * agent is on the roster because it has already delivered work for this
 * workspace, so "Not on your plan" over a shelf of its posts would be this
 * section contradicting the client's Workspace. What being ungranted costs is
 * the DESTINATION, not the word — a client who opens an ungranted agent's page
 * gets `notFound()`, so the row offers the standard Support trigger instead of a
 * link, and a button that leads to a 404 is worse than no button (risk review
 * C21). One field decides one thing: `status` the badge, `customAgentId` the
 * control.
 *
 * TWO SOURCES OF ROWS (decision 7, approved). The roster answers for the agents
 * this account HAS; the lever table answers for the ones it does not, one row
 * per product FAMILY, so "Not on your plan" is reachable for a client who has
 * never had the agent rather than only for the rare delivered-without-a-grant
 * case. Both kinds carry `granted`, and `sortVisibilityWorkRows` already sends
 * every ungranted row to the bottom band, so the section still reads: what is
 * running, what is being stood up, what is idle, then what this account does
 * not have. The catalogue half is static, so it costs no Firestore read.
 *
 * AND SO THERE IS NO EMPTY STATE (round 6 fix pass). It used to carry one —
 * "No agents are set up on this account yet." plus Support — written before the
 * catalogue half existed. Every lever family now renders a row for every
 * client, granted or not, so `rows` cannot arrive empty from the one caller and
 * that branch was unreachable copy (ruling 8: delete what you replace).
 *
 * NO ORANGE. The section adds no accent: status uses the judgment tones, the one
 * control is `outline`, and the marks are ink. Parity: staff in client context
 * read exactly this, with no staff-only branch — the grant control lives on the
 * Settings tab's admin frame, nowhere near the report.
 *
 * A server component. `FlagButton` is the one client leaf, as in
 * `client-suggestions.tsx` at the other end of the tab.
 */

export interface VisibilityWorkRow {
  /**
   * The row's stable identity, and its React key: the agent's id for a row this
   * account has, the lever family for a catalogue row (which has no agent to be
   * identified by).
   */
  key: string;
  /**
   * The `[agentId]` segment of the detail route, or null when this row has no
   * page to open: a catalogue row (no agent on the account) or an ungranted one
   * (the page would `notFound()`). Null is what puts Support at the row end.
   */
  customAgentId: string | null;
  /** `"<key> <name>"`, for the platform mark. */
  identity: string;
  icon?: string | null;
  /** The name the roster prints for this agent. */
  displayName: string;
  /** The STORED name: R7's one name per agent, which is what a control says. */
  agentName: string;
  /**
   * The lever this row belongs to — the family's sentence, order and internal
   * lever name, straight off `lib/visibility-levers.ts`. Carried WHOLE rather
   * than with the sentence copied out beside it (round 6 review, E4): the sort
   * reads `lever.order`, the row prints `lever.sentence`, and two fields holding
   * one string is one place for them to disagree.
   */
  lever: VisibilityLever;
  /**
   * "Quoted N times in the answers we measured", when this snapshot's citation
   * leaderboard holds a count for the domain this agent publishes to. Null for
   * every row we have not measured, which is most of them.
   */
  quotedCount?: number | null;
  /**
   * The ROSTER's word for this agent, or null when this account has no such
   * agent at all — which is the "Not on your plan" row and the only one.
   */
  status: RosterStatus | null;
}

export function VisibilityWork({
  clientId,
  rows,
}: {
  clientId: string;
  /** Already ordered (state band, then lever order) by the page. */
  rows: VisibilityWorkRow[];
}) {
  return (
    <section id="what-we-are-doing" className="scroll-mt-24 space-y-3">
      <p className="font-mono text-[10px] uppercase tracking-[0.08em] text-muted">
        What we are doing to improve your SEO and GEO
      </p>
      <Card>
        <p className="mb-4 text-xs text-muted-2">{VISIBILITY_WORK_STANDFIRST}</p>
        <ul>
          {rows.map((row) => (
            <li
              key={row.key}
              className="flex flex-col gap-3 border-t border-border py-3 first:border-t-0 first:pt-0 last:pb-0 @2xl:flex-row @2xl:items-start"
            >
              <AgentIdentity identity={row.identity} {...(row.icon ? { icon: row.icon } : {})} />
              <div className="min-w-0 flex-1">
                <div className="flex flex-wrap items-center gap-2">
                  <p className="truncate text-sm font-medium text-foreground">
                    {row.displayName}
                  </p>
                  {/* One badge per row, and never two: the roster's word
                      wherever the roster has one, and the section's own word
                      only where it does not. An agent with no roster entry has
                      no state on this account to report. */}
                  {row.status ? (
                    <RosterStatusBadge status={row.status} />
                  ) : (
                    <Badge tone="neutral">Not on your plan</Badge>
                  )}
                </div>
                <p className="mt-0.5 text-xs leading-relaxed text-muted">
                  {row.lever.sentence}
                </p>
                {row.quotedCount != null && row.quotedCount > 0 && (
                  <p className="mt-1 text-[11px] leading-relaxed text-muted-2">
                    Quoted {row.quotedCount} times in the answers we measured
                  </p>
                )}
              </div>
              {/* ONE control at the row end, and never two. The detail page
                  owns the run gesture (CD-I1), so this opens it and stops
                  there. `Button variant="outline"`'s own recipe, READ from
                  `buttonClass` rather than restated, on a real <Link>: a
                  <button> inside an <a> is invalid markup, and a div with
                  an onClick would give up middle-click, cmd-click and a
                  copyable URL. No glyph after the label (rule 2). */}
              <div className="shrink-0 @2xl:pt-0.5">
                {row.customAgentId ? (
                  <Link
                    href={`/clients/${clientId}/agents/${row.customAgentId}`}
                    className={buttonClass({ variant: "outline", size: "sm" })}
                  >
                    Open {row.agentName}
                  </Link>
                ) : (
                  <FlagButton
                    subject={`Ask about the ${row.agentName}`}
                    message={`We would like to know what the ${row.agentName} would do for us and what it would take to add it.`}
                  />
                )}
              </div>
            </li>
          ))}
        </ul>
      </Card>
    </section>
  );
}
