import Link from "next/link";
import { Badge } from "@/components/ui";
import { Icon } from "@/components/icon";
import { AgentIdentity } from "@/components/agent-identity";
import { cn } from "@/lib/utils";
import type { RosterStatus } from "@/lib/client-agents";

/**
 * One agent on the roster (CD-G1).
 *
 * Albert, on seeing the old roster: "they can just click on it, and then it
 * opens… over the whole page. That whole page should be like the Instagram
 * Agent." So the card's entire job is to be recognisable and clickable - a
 * mark, a name, one line of what it gives you, one status word. Everything the
 * old card carried (template rows, Run now, Set schedule, Adjust pace, the week
 * strip) moves to the detail page, because a grid of cards each offering four
 * controls is a control panel, not a roster.
 *
 * NO RUN BUTTON, deliberately and by rule: a client's run gesture now lives
 * only inside a detail page, where the context that explains what a run costs
 * and produces is on screen next to it. A Run button on a roster card is a
 * charge fired from a surface that never explained itself.
 *
 * It is a real <Link>, not a click handler on a div and not a modal. That gives
 * it the whole browser for free - middle-click, cmd-click, back, a copyable URL
 * - and a modal cannot be any of those things. This is a server component: it
 * holds no state and needs no client bundle.
 */
export function ClientAgentRosterCard({
  href,
  identity,
  icon,
  displayName,
  blurb,
  status,
  note,
}: {
  href: string;
  /** `"<key> <name>"` - drives the platform mark. */
  identity: string;
  icon?: string | null;
  displayName: string;
  blurb: string | null;
  status: RosterStatus;
  /**
   * Staff-only operator line, already resolved to a sentence server-side. It
   * is plain TEXT rather than a link on purpose: the whole card is already a
   * <Link>, and a nested anchor is invalid markup that browsers resolve by
   * silently breaking one of the two. The thing it points at is one click away
   * on the page this card opens.
   */
  note?: string | null;
}) {
  const disabled = status.tone === "disabled";

  const inner = (
    <>
      <span
        className="absolute inset-x-0 top-0 h-0.5 bg-foreground/40 opacity-45 transition-opacity group-hover:opacity-90"
        aria-hidden="true"
      />
      <div className="flex items-start gap-3">
        <AgentIdentity identity={identity} {...(icon ? { icon } : {})} />
        <div className="min-w-0 flex-1">
          <div className="flex flex-wrap items-center gap-2">
            <p className="truncate text-base font-medium text-foreground">{displayName}</p>
            <RosterStatusBadge status={status} />
          </div>
          {blurb && (
            <p className="mt-1 line-clamp-2 text-xs leading-relaxed text-muted">{blurb}</p>
          )}
          {note && (
            <p className="mt-1.5 flex items-center gap-1 text-[11px] text-muted-2">
              <Icon name="Dot" className="h-3 w-3 shrink-0" aria-hidden="true" />
              {note}
            </p>
          )}
        </div>
        {/* A paused agent has nowhere to go - no Run, no launch, no config
            reachable through it (the toggle lives on the staff Agents hub) -
            so there is no chevron promising a destination, and no click.
            Blocked here, not just server-side: a client could otherwise open
            the detail page and see a "Coming Soon" agent's setup ladder,
            which is staff/launch bookkeeping that has nothing to do with why
            it's unavailable. */}
        {!disabled && (
          <Icon
            name="ChevronRight"
            className="mt-0.5 h-4 w-4 shrink-0 text-muted-2 transition-all group-hover:translate-x-0.5 group-hover:text-neon"
            aria-hidden="true"
          />
        )}
      </div>
    </>
  );

  const className = cn(
    "card-grad group relative flex flex-col overflow-hidden rounded-[var(--radius)] border border-border p-4 sm:p-5",
    disabled
      ? "opacity-60 cursor-default"
      : // The hover affordance has to be unmistakable (CD-G1): the whole card is
        // the target, so it lifts, brightens its border and slides its chevron -
        // three signals, because a card that only changes border colour reads as
        // decoration rather than as something you can open.
        "transition-all duration-200 hover:-translate-y-0.5 hover:border-neon/50 hover:shadow-[0_0_0_1px_var(--color-neon-soft)] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-neon/60",
  );

  if (disabled) {
    return (
      <div className={className} aria-disabled="true">
        {inner}
      </div>
    );
  }

  // It is a real <Link>, not a click handler on a div and not a modal. That
  // gives it the whole browser for free - middle-click, cmd-click, back, a
  // copyable URL - and a modal cannot be any of those things.
  return (
    <Link href={href} className={className}>
      {inner}
    </Link>
  );
}

function RosterStatusBadge({ status }: { status: RosterStatus }) {
  if (status.tone === "live") {
    return (
      <Badge tone="success">
        <span
          className="h-1.5 w-1.5 rounded-full bg-success animate-pulse-neon"
          aria-hidden="true"
        />
        {status.label}
      </Badge>
    );
  }
  if (status.tone === "attention") return <Badge tone="warning">{status.label}</Badge>;
  if (status.tone === "progress") return <Badge tone="info">{status.label}</Badge>;
  return <Badge tone="neutral">{status.label}</Badge>;
}
