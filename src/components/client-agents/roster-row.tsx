import Link from "next/link";
import { Badge } from "@/components/ui";
import { Icon } from "@/components/icon";
import { AgentIdentity } from "@/components/agent-identity";
import { cn, relativeTime } from "@/lib/utils";
import {
  rosterNextLabel,
  rosterRowVerb,
  type RosterAttentionReason,
} from "@/lib/client-agent-rows";
import type { RosterStatus } from "@/lib/client-agents";

/**
 * One agent on the roster, as a full-width ROW (round 6, decision 6).
 *
 * It replaced a two-column card grid, and the reason is what a client opens this
 * page to do: compare. A live Instagram agent and a never-run Reddit agent were
 * the same rectangle with the same two lines in it, so the page could not answer
 * "which of these is working for me, and which one needs me" without opening all
 * of them one at a time. Lists beat cards for comparison (NN/g cards vs tables,
 * Baymard product tables), and the columns are in importance order: who it is,
 * what state it is in, what it last made, when the next one lands, what pressing
 * it does.
 *
 * ONE LINK, no nested controls. The whole row is the target, so middle-click,
 * cmd-click, back and a copyable URL all work for free, and the verb at the end
 * is a LABEL rather than a button: a run gesture belongs on the page that
 * explains what it costs and produces, never fired from a roster that explained
 * nothing. A nested <button> or a second <a> inside a row link is also invalid
 * markup that browsers resolve by silently breaking one of the two.
 *
 * A server component: no state, no handlers, nothing to hydrate.
 */
export function ClientAgentRosterRow({
  href,
  identity,
  icon,
  displayName,
  blurb,
  status,
  lastMade = null,
  nextAt = null,
  attentionReason = null,
  note = null,
  notGranted = false,
  now,
}: {
  href: string;
  /** `"<key> <name>"` - drives the platform mark and the run verb's noun. */
  identity: string;
  icon?: string | null;
  displayName: string;
  blurb: string | null;
  status: RosterStatus;
  /**
   * The newest thing this agent produced that THIS viewer may see, already
   * resolved server-side. A delivered title only: it is something the client
   * already has in their Workspace, which is why naming it here publishes
   * nothing new.
   */
  lastMade?: { title: string; at: number } | null;
  /**
   * The next planned DAY for this agent (epoch millis) - a day on the client's
   * own calendar, or the schedule's next fire. Never a title, never a count:
   * see `rosterNextLabel`.
   */
  nextAt?: number | null;
  /** What an attention state points at, for the verb. */
  attentionReason?: RosterAttentionReason | null;
  /**
   * STAFF-ONLY operator line, already resolved to a sentence server-side, and
   * plain TEXT rather than a link: the whole row is a <Link> and the thing it
   * names is one click away on the page this row opens.
   */
  note?: string | null;
  /**
   * STAFF ONLY (A4): this agent is on the staff superset but not in the client's
   * grants. A neutral badge beside the status word, never a status word of its
   * own - the agent's state is unchanged by who may see it.
   */
  notGranted?: boolean;
  /**
   * The clock every other answer on this page was resolved against. Passed in
   * rather than read here so the row's stamps cannot disagree with the status
   * word beside them.
   */
  now: number;
}) {
  const disabled = status.tone === "disabled";
  const verb = rosterRowVerb({ status, identity, attentionReason });
  // `relativeTime` with the page's clock (round 6 review, E1): the ladder of
  // units was duplicated in `client-agent-rows.ts` purely to take a `now`, and
  // `relativeTime` takes one now.
  const lastMadeStamp = lastMade ? relativeTime(lastMade.at, now) : null;
  const nextLabel = nextAt != null ? rosterNextLabel(nextAt, now) : null;

  // Below @2xl there is no room for three columns beside the name, so the same
  // three facts become one 11px line under it (Baymard's mobile fallback for a
  // comparison table). Same order, same words, one row tall. It carries no
  // "Last made" prefix: at 375px the line has room for about sixty characters
  // and the verb is the end of it, so the label would be paid for by truncating
  // the one part that says what pressing the row does.
  const metaLine = [
    lastMade ? `${lastMade.title} · ${lastMadeStamp}` : null,
    nextLabel ? `Next: ${nextLabel}` : null,
    verb,
  ]
    .filter(Boolean)
    .join(" · ");

  const badges = (
    <span className="flex shrink-0 items-center gap-1.5">
      <RosterStatusBadge status={status} />
      {notGranted && <Badge tone="neutral">Not granted</Badge>}
    </span>
  );

  const inner = (
    <>
      <AgentIdentity identity={identity} size="sm" {...(icon ? { icon } : {})} />
      <div className="min-w-0 flex-1">
        <div className="flex min-w-0 flex-wrap items-center gap-x-2 gap-y-1">
          <p className="min-w-0 truncate text-sm font-medium text-foreground">{displayName}</p>
          <span className="@2xl:hidden">{badges}</span>
        </div>
        {blurb && <p className="truncate text-xs leading-relaxed text-muted">{blurb}</p>}
        {/* A5: the same grey 11px line the client's copy is set in used to carry
            staff-queue facts ("3 drafts waiting for review") on a surface that is
            otherwise identical to the client's. The mono marker says whose line
            this is before the sentence starts. */}
        {note && (
          <p className="mt-1 flex items-baseline gap-1.5 text-[11px] text-muted-2">
            <span className="shrink-0 font-mono text-[9px] uppercase tracking-[0.08em] text-muted-2">
              Internal
            </span>
            {note}
          </p>
        )}
        {metaLine && <p className="mt-1 truncate text-[11px] text-muted-2 @2xl:hidden">{metaLine}</p>}
      </div>
      <span className="hidden @2xl:flex">{badges}</span>
      {/* The STAMP rides the label line, not the value line. A 144px column at
          12px holds about twenty-four characters, so with both on one line a
          long title truncates the stamp away, and "Last made" with no date under
          it says nothing. This way the date always survives and only the title
          is ever cut. */}
      <div className="hidden w-36 shrink-0 @2xl:block @4xl:w-48">
        {lastMade && (
          <>
            <p className="truncate text-[11px] leading-4 text-muted-2">
              Last made · {lastMadeStamp}
            </p>
            <p className="truncate text-xs leading-4 text-foreground">{lastMade.title}</p>
          </>
        )}
      </div>
      <div className="hidden w-20 shrink-0 @2xl:block">
        {nextLabel && (
          <>
            <p className="text-[11px] leading-4 text-muted-2">Next</p>
            <p className="truncate text-xs leading-4 text-foreground">{nextLabel}</p>
          </>
        )}
      </div>
      {verb && (
        <span className="hidden w-28 shrink-0 text-right text-xs font-medium text-foreground @2xl:block">
          {verb}
        </span>
      )}
      {/* ONE trailing glyph, static (round 6 rule 3): no slide, no colour change,
          no second hover signal. A paused agent has nowhere to go - no run, no
          launch, no config reachable through it - so it gets no chevron and no
          link, rather than a promise the page behind it cannot keep. */}
      {!disabled && (
        <Icon name="ChevronRight" className="h-4 w-4 shrink-0 text-muted-2" aria-hidden="true" />
      )}
    </>
  );

  const className = cn(
    "flex min-h-[64px] items-center gap-3 rounded-[var(--radius)] border border-border bg-surface-2 px-3 py-2.5 @2xl:gap-4 @2xl:px-4",
    disabled
      ? "cursor-default opacity-60"
      : // Rule 3, in full: one fill step plus the accent hairline, both carried by
        // `row-lift`, and nothing else. The lift, the shadow ring and the orange
        // chevron this row used to wear were three signals for one meaning.
        "focus-ring row-lift",
  );

  if (disabled) {
    return (
      <div className={className} aria-disabled="true">
        {inner}
      </div>
    );
  }

  return (
    <Link href={href} className={className}>
      {inner}
    </Link>
  );
}

/**
 * The status word, in the one place it is spelled (round 6 ruling 4).
 *
 * Exported because three surfaces render it - this roster, the agent detail
 * page's status line and the Reporting section's agent table - and a copy of it
 * is how the detail page came to carry its own `StatusBadge` that had drifted
 * from this one. The words themselves are `rosterStatus`'s, never restated here.
 *
 * Tones are the judgment scale only (success / warning / info / neutral). Orange
 * never signals status.
 */
export function RosterStatusBadge({ status }: { status: RosterStatus }) {
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
