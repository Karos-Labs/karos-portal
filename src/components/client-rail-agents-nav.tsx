"use client";

import Link from "next/link";
import { useOptimistic, useState, useTransition } from "react";
import { usePathname, useRouter } from "next/navigation";
import { Icon } from "@/components/icon";
import { AgentMark } from "@/components/agent-identity";
import { cn } from "@/lib/utils";
import { toggleStarredAgentAction } from "@/lib/actions";

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

type StarAction = { agentId: string; starred: boolean };

function applyStarAction(state: string[], action: StarAction): string[] {
  return action.starred
    ? state.includes(action.agentId)
      ? state
      : [...state, action.agentId]
    : state.filter((id) => id !== action.agentId);
}

/** One row inside the open dropdown — pinned and unpinned agents share this exact markup. */
function AgentRow({
  agent,
  href,
  active,
  isStarred,
  isPending,
  onToggleStar,
}: {
  agent: RailAgent;
  href: string;
  active: boolean;
  isStarred: boolean;
  isPending: boolean;
  onToggleStar: (e: React.MouseEvent) => void;
}) {
  return (
    <div className="relative flex items-center">
      <Link
        href={href}
        className={cn(
          "flex flex-1 items-center gap-3 rounded-md py-1.5 pl-3 pr-7 text-sm transition-colors",
          active ? "bg-surface-2 text-foreground" : "text-muted hover:bg-surface-2 hover:text-foreground",
        )}
      >
        {/* AgentMark — the same resolver every other agent-identity render
            site uses (custom-agents.tsx, schedule-run-modal.tsx, asset-card):
            the agent's real platform mark (Instagram, X, LinkedIn, Reddit...)
            when its identity names one, the stored lucide glyph otherwise. A
            plain lucide icon here would drift from what every other surface
            already shows for the same agent. */}
        <AgentMark
          identity={`${agent.key} ${agent.name}`}
          icon={agent.icon ?? undefined}
          className={cn("h-3.5 w-3.5 shrink-0", active ? "text-foreground" : "text-muted-2")}
        />
        <span className="flex-1 truncate">{agent.name}</span>
      </Link>
      <button
        type="button"
        aria-label={isStarred ? `Unstar ${agent.name}` : `Star ${agent.name}`}
        aria-pressed={isStarred}
        disabled={isPending}
        onClick={onToggleStar}
        // Always visible — no hover/focus gate: a hover-only toggle is
        // unreachable on touch and invisible until a client thinks to hover
        // a sidebar row in the first place (#89's shape).
        className={cn(
          "absolute right-2 rounded p-1 transition-colors hover:bg-surface-2 disabled:opacity-50",
          isStarred ? "text-neon" : "text-muted-2",
        )}
      >
        <Icon name="Star" className={cn("h-3.5 w-3.5", isStarred && "fill-current")} />
      </button>
    </div>
  );
}

/**
 * The "AI agents" dropdown, with starred agents sorted to the top of its OWN
 * list (Surface 01, portal revamp; repositioned 2026-08 — see below).
 *
 * `starredIds` (the server prop) is read through `useOptimistic` rather than
 * directly, and the star buttons no longer hide behind hover/focus opacity —
 * both changes exist because the previous shape was invisible to a real
 * report: a client clicked (or couldn't find) a hover-only icon, got no
 * immediate feedback because the prop doesn't change until the server
 * round-trips, and concluded starring "does nothing". The optimistic array
 * flips the icon and the sort order on the same tick as the click;
 * `router.refresh()` after the action settles is what makes that stick past
 * this render — `toggleStarredAgentAction`'s revalidatePath alone cannot
 * reach this component's data source (see that action's own note), so the
 * client-driven refresh is the actual correctness mechanism, not a nicety.
 *
 * REPOSITIONED, NOT REMOVED (2026-08). Starred rows used to render as their
 * own section ABOVE the "AI agents" trigger — direct instructions moved them
 * to live under that tab instead, so the rail's top level is Home / AI agents
 * / Calendar / Downloads and nothing else competes with that fixed set for
 * vertical space. The star still promotes an agent to the FRONT of the list
 * the moment the dropdown opens (a stable sort, so relative order within each
 * group is preserved) — same one-click-away utility, one level down.
 *
 * CAPPED, NOT UNBOUNDED (2026-08). A client with a large granted roster (the
 * catalog runs well past 20) must not turn this into a scroll-heavy list every
 * time the dropdown opens — see `UNSTARRED_AGENT_CAP`.
 */
export function ClientRailAgentsNav({
  clientId,
  home,
  agents,
  starredIds,
}: {
  clientId: string;
  home: string;
  agents: RailAgent[];
  starredIds: string[];
}) {
  const pathname = usePathname();
  const router = useRouter();
  const agentsRoot = `${home}/agents`;
  const [isPending, startTransition] = useTransition();
  const [open, setOpen] = useState(() => pathname.startsWith(agentsRoot));
  const [showAllAgents, setShowAllAgents] = useState(false);
  const [optimisticStarredIds, applyOptimisticStar] = useOptimistic(starredIds, applyStarAction);

  const starredSet = new Set(optimisticStarredIds);
  // Two groups, not one sorted list: starring/unstarring moves an agent
  // between them live (optimistic), and only the unstarred group is ever
  // capped — see UNSTARRED_AGENT_CAP.
  const starredAgents = agents.filter((a) => starredSet.has(a.id));
  const unstarredAgents = agents.filter((a) => !starredSet.has(a.id));
  const visibleUnstarredAgents = showAllAgents
    ? unstarredAgents
    : unstarredAgents.slice(0, UNSTARRED_AGENT_CAP);

  function toggleStar(e: React.MouseEvent, agentId: string, nextStarred: boolean) {
    // Belt and suspenders: the button is a sibling of the row's <Link>, not a
    // descendant, so this shouldn't be needed today — but a star click must
    // NEVER be able to fire a navigation, in this layout or a future one.
    e.preventDefault();
    e.stopPropagation();
    startTransition(async () => {
      applyOptimisticStar({ agentId, starred: nextStarred });
      await toggleStarredAgentAction(clientId, agentId, nextStarred);
      router.refresh();
    });
  }

  return (
    <div className="flex flex-col gap-0.5">
      {/* Link + a separate chevron button, not one combined button — "AI
          agents" used to be a plain NavLink (pressed/active on its own route,
          navigating on click) before this became a disclosure; direct
          instructions asked for BOTH back, not one traded for the other. The
          row navigates to the roster like any other rail item; the chevron is
          the only thing that opens/closes the pinned+dropdown list beneath
          it, matching the star buttons' own split-affordance shape above. */}
      <div className="relative flex items-center">
        <Link
          href={agentsRoot}
          className={cn(
            "group flex flex-1 items-center gap-3 rounded-md py-2 pl-3 pr-7 text-sm transition-colors",
            pathname === agentsRoot || pathname.startsWith(agentsRoot + "/")
              ? "bg-surface-2 text-foreground"
              : "text-muted hover:bg-surface-2 hover:text-foreground",
          )}
        >
          <Icon name="Bot" className="h-4 w-4 shrink-0 text-muted-2 group-hover:text-foreground" />
          <span className="flex-1 text-left">AI agents</span>
        </Link>
        <button
          type="button"
          onClick={() => setOpen((o) => !o)}
          aria-expanded={open}
          aria-label={open ? "Collapse agent list" : "Expand agent list"}
          className="absolute right-2 rounded p-1 text-muted-2 transition-colors hover:bg-surface-3 hover:text-foreground"
        >
          <Icon
            name="ChevronDown"
            className={cn("h-3.5 w-3.5 shrink-0 transition-transform", open && "rotate-180")}
          />
        </button>
      </div>

      {open && (
        // max-h + overflow-y-auto (CD-E3): the rail is a no-scroll surface, so
        // a client with many granted agents must not push the profile card and
        // Brand Colors row below it out of view — the dropdown scrolls itself
        // instead of growing the rail.
        <div className="ml-3 flex max-h-[40vh] flex-col gap-0.5 overflow-y-auto border-l border-border pl-2">
          {agents.length === 0 ? (
            <p className="px-3 py-1.5 text-xs text-muted-2">No agents set up yet.</p>
          ) : (
            <>
              {starredAgents.map((agent) => {
                const href = `${agentsRoot}/${agent.id}`;
                const active = pathname === href || pathname.startsWith(href + "/");
                return (
                  <AgentRow
                    key={agent.id}
                    agent={agent}
                    href={href}
                    active={active}
                    isStarred={true}
                    isPending={isPending}
                    onToggleStar={(e) => toggleStar(e, agent.id, false)}
                  />
                );
              })}
              {/* Only when the list actually has both groups, so a client
                  with zero or all-starred agents never sees an orphaned
                  divider line. */}
              {starredAgents.length > 0 && unstarredAgents.length > 0 && (
                <div className="my-1 border-t border-border" />
              )}
              {visibleUnstarredAgents.map((agent) => {
                const href = `${agentsRoot}/${agent.id}`;
                const active = pathname === href || pathname.startsWith(href + "/");
                return (
                  <AgentRow
                    key={agent.id}
                    agent={agent}
                    href={href}
                    active={active}
                    isStarred={false}
                    isPending={isPending}
                    onToggleStar={(e) => toggleStar(e, agent.id, true)}
                  />
                );
              })}
              {unstarredAgents.length > UNSTARRED_AGENT_CAP && (
                <button
                  type="button"
                  onClick={() => setShowAllAgents((s) => !s)}
                  className="px-3 py-1.5 text-left font-mono text-[10px] uppercase tracking-[0.08em] text-muted-2 transition-colors hover:text-foreground"
                >
                  {showAllAgents ? "Show fewer" : `View all ${agents.length} agents`}
                </button>
              )}
            </>
          )}
        </div>
      )}
    </div>
  );
}
