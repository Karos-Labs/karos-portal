"use client";

import Link from "next/link";
import { useState } from "react";
import { usePathname } from "next/navigation";
import { Icon } from "@/components/icon";
import { AgentMark } from "@/components/agent-identity";
import { cn } from "@/lib/utils";

export interface RailAgent {
  id: string;
  /** Stable slug (CustomAgent.key) — feeds AgentMark's platform match alongside `name`. */
  key: string;
  name: string;
  icon: string | null;
}

/**
 * Unstarred agents shown before the list collapses behind "View all" — same
 * cap shape as CompetitorTrack's `collapseTo` and the Next Actions widget's
 * 3-item cap: a nav surface stays scannable regardless of how large the
 * client's granted roster grows. Starred agents are NEVER capped — a client
 * curates that set themselves, and hiding one of their own explicit pins
 * behind a "view more" click would be the broken control, not the long list.
 */
const UNSTARRED_AGENT_CAP = 6;

/**
 * One row of the always-open list — the mark and the name, and nothing else.
 *
 * IDENTICAL ANATOMY TO `NavLink` (rail-nav-link.tsx), which is the point
 * (round 6, think-agents §3): the same radius, padding, gap, 16px icon, 14px
 * label, the same hover and active fills, `aria-current="page"` and the one
 * shared focus ring. A child row is a nav row one level down, not a different
 * kind of thing — it is shorter (`py-1.5`, a 32px row) and that is the only
 * difference. Every source consulted says the same thing about a sidebar row:
 * labels visible, front-loaded, one trailing visual at most, and a current row
 * marked with `aria-current` (NN/g vertical nav, Apple HIG sidebars, Material's
 * navigation drawer, Primer's NavList).
 *
 * NO STAR. The rail used to carry one on every row: grey when unpinned (a glyph
 * that means nothing until hovered) and orange when pinned, so a client with
 * four pins spent the one rationed accent four times in the nav. Pinning lives
 * on the agent's own page now (`agent-star-button.tsx`), which is where a
 * client is when they decide an agent is worth keeping to hand.
 */
function AgentRow({
  agent,
  href,
  active,
}: {
  agent: RailAgent;
  href: string;
  active: boolean;
}) {
  return (
    <Link
      href={href}
      {...(active ? { "aria-current": "page" as const } : {})}
      className={cn(
        "focus-ring group flex items-center gap-3 rounded-md px-3 py-1.5 text-sm transition-colors",
        active ? "bg-surface-2 text-foreground" : "text-muted hover:bg-surface-2 hover:text-foreground",
      )}
    >
      {/* AgentMark — the same resolver every other agent-identity render
          site uses (custom-agents.tsx, schedule-run-modal.tsx, asset-card):
          the agent's real platform mark (Instagram, X, LinkedIn, Reddit...)
          when its identity names one, the stored lucide glyph otherwise. A
          plain lucide icon here would drift from what every other surface
          already shows for the same agent. Sized `h-4 w-4` to match NavLink's
          icons, up from 14px. */}
      <AgentMark
        identity={`${agent.key} ${agent.name}`}
        icon={agent.icon ?? undefined}
        className={cn(
          "h-4 w-4 shrink-0",
          active ? "text-foreground" : "text-muted-2 group-hover:text-foreground",
        )}
      />
      <span className="flex-1 truncate">{agent.name}</span>
    </Link>
  );
}

/**
 * The rail's "AI agents" section: a plain link to the roster with the client's
 * agents listed under it, starred first (Surface 01, portal revamp;
 * repositioned 2026-08, un-collapsed 2026-09 — see below).
 *
 * NO DISCLOSURE (portal feedback round 2, 2026-09: "I don't like this menu …
 * perhaps on the sidebar all the agents should always be open by default").
 * The chevron and the `open` state are GONE, not defaulted to true: a control
 * whose only two states are "the list a client wants" and "the list a client
 * wants, hidden" is a control that can only make the rail worse, and it also
 * made the row ambiguous — link on the left, toggle on the right, one row. The
 * agents a client can run are the rail's whole point, so they are simply
 * always drawn. The `max-h-[40vh] overflow-y-auto` guard below is what keeps
 * that honest against the no-scroll contract (CD-E3); it did the real work
 * before too, since the disclosure opened itself on every /agents route.
 *
 * PINNING IS NOT DONE HERE (round 6, think-agents §3). The rows are marks and
 * names; the pin control lives on the agent's own page
 * (`client-agents/agent-star-button.tsx`), so `starredIds` is read here as
 * ORDER and nothing else. That also retired this component's optimistic star
 * array and its write-back into the staff shell's active-client context: both
 * existed to make a toggle in the rail feel immediate, and there is no toggle in
 * the rail. The page's control is only ever mounted under `/clients/[id]`, whose
 * layout mounts ClientContextSync, so its own `router.refresh()` reads a context
 * that has been updated — which is the defect that write-back was for.
 *
 * REPOSITIONED, NOT REMOVED (2026-08). Starred rows used to render as their
 * own section ABOVE the "AI agents" row — direct instructions moved them to
 * live under it instead, so the rail's top level is Home / AI agents /
 * Calendar and nothing else competes with that fixed set for vertical space.
 * A pin still promotes an agent to the FRONT of the list (a stable sort, so
 * relative order within each group is preserved) — same one-click-away
 * utility, one level down.
 *
 * ONE CURRENT ROW (round 6). The "AI agents" row was filled for every
 * `/agents/*` path and the child row was filled too, so two rows read as
 * current at once. The parent is filled on the roster route itself and keeps
 * only `text-foreground` while a child is active, which is what a two-level
 * sidebar is supposed to look like (Primer's NavList: one `aria-current`).
 *
 * CAPPED, NOT UNBOUNDED (2026-08). A client with a large granted roster (the
 * catalog runs well past 20) must not turn this into a scroll-heavy list —
 * see `UNSTARRED_AGENT_CAP`. This matters MORE now that nothing collapses the
 * list: the cap and the scroll guard are the only two things bounding it.
 */
export function ClientRailAgentsNav({
  home,
  agents,
  starredIds,
}: {
  home: string;
  agents: RailAgent[];
  /**
   * `Client.starredAgentIds` — read as ORDER only (pinned rows first). The
   * toggle that used to live on these rows moved to the agent's own page in
   * round 6, so nothing here writes it.
   */
  starredIds: string[];
}) {
  const pathname = usePathname();
  const agentsRoot = `${home}/agents`;
  const [showAllAgents, setShowAllAgents] = useState(false);

  const starredSet = new Set(starredIds);
  // Two groups, not one sorted list: only the unpinned group is ever capped —
  // see UNSTARRED_AGENT_CAP.
  const starredAgents = agents.filter((a) => starredSet.has(a.id));
  const unstarredAgents = agents.filter((a) => !starredSet.has(a.id));
  const visibleUnstarredAgents = showAllAgents
    ? unstarredAgents
    : unstarredAgents.slice(0, UNSTARRED_AGENT_CAP);
  // ONE CURRENT ROW: a child route fills the child, never the parent as well.
  const onAgentsRoot = pathname === agentsRoot;
  const underAgents = onAgentsRoot || pathname.startsWith(agentsRoot + "/");

  return (
    <div className="flex flex-col gap-0.5">
      {/* A plain rail link, nothing else on the row — it navigates to the
          roster like Home and Calendar do, and the list below it is not
          something it governs. (It was a Link + chevron pair; see this
          component's note for why the chevron went.) */}
      <Link
        href={agentsRoot}
        {...(onAgentsRoot ? { "aria-current": "page" as const } : {})}
        className={cn(
          "focus-ring group flex items-center gap-3 rounded-md px-3 py-2 text-sm transition-colors",
          // FILLED ONLY ON THE ROSTER ITSELF (round 6). While a child row is
          // active the parent keeps the ink and gives up the fill, so exactly
          // one row in the rail reads as current.
          onAgentsRoot
            ? "bg-surface-2 text-foreground"
            : underAgents
              ? "text-foreground hover:bg-surface-2"
              : "text-muted hover:bg-surface-2 hover:text-foreground",
        )}
      >
        <Icon name="Bot" className="h-4 w-4 shrink-0 text-muted-2 group-hover:text-foreground" />
        <span className="flex-1 text-left">AI agents</span>
      </Link>

      {/* max-h + overflow-y-auto (CD-E3): the rail is a no-scroll surface, so
          a client with many granted agents must not push the profile card and
          Brand Colors row below it out of view — the list scrolls itself
          instead of growing the rail. Load-bearing now that nothing collapses
          it. */}
      <div className="ml-3 flex max-h-[40vh] flex-col gap-0.5 overflow-y-auto border-l border-border pl-2">
        {agents.length === 0 ? (
          // NEVER A DEAD SENTENCE (round 6). It used to state that no agents
          // were set up and offer nothing; the roster is where a client asks for
          // one, so the empty state is the way there.
          <Link
            href={agentsRoot}
            className="focus-ring rounded-md px-3 py-1.5 text-xs text-muted transition-colors hover:text-foreground hover:underline"
          >
            See your agents
          </Link>
        ) : (
          <>
            {starredAgents.map((agent) => {
              const href = `${agentsRoot}/${agent.id}`;
              const active = pathname === href || pathname.startsWith(href + "/");
              return <AgentRow key={agent.id} agent={agent} href={href} active={active} />;
            })}
            {/* Only when the list actually has both groups, so a client
                with zero or all-pinned agents never sees an orphaned
                divider line. */}
            {starredAgents.length > 0 && unstarredAgents.length > 0 && (
              <div className="my-1 border-t border-border" />
            )}
            {visibleUnstarredAgents.map((agent) => {
              const href = `${agentsRoot}/${agent.id}`;
              const active = pathname === href || pathname.startsWith(href + "/");
              return <AgentRow key={agent.id} agent={agent} href={href} active={active} />;
            })}
            {unstarredAgents.length > UNSTARRED_AGENT_CAP && (
              <button
                type="button"
                onClick={() => setShowAllAgents((s) => !s)}
                className="focus-ring rounded-md px-3 py-1.5 text-left font-mono text-[10px] uppercase tracking-[0.08em] text-muted-2 transition-colors hover:text-foreground"
              >
                {/* The number this control actually reveals — the UNPINNED
                    group, which is the only one the cap applies to. It counted
                    `agents.length`, so a client with 4 pinned and 8 unpinned
                    agents was offered "View all 12 agents" by a button that
                    uncovers 2 more rows, on a list already showing 10 (review
                    wave, 2026-09). */}
                {showAllAgents ? "Show fewer" : `View all ${unstarredAgents.length} agents`}
              </button>
            )}
          </>
        )}
      </div>
    </div>
  );
}
