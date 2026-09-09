import Link from "next/link";
import { Badge } from "@/components/ui";
import { Icon } from "@/components/icon";
import { formatDate, relativeTime } from "@/lib/utils";
import { intakeRowHref } from "@/lib/agent-intake-links";
import type { AgentInputsView, AgentSetupFact } from "@/lib/agent-detail-sections";
import type { RosterStatus } from "@/lib/client-agents";
import { RUN_ESTIMATE_SENTENCE } from "@/lib/run-estimate";

/**
 * The dated, categorized bands of an agent's page (CD-K1).
 *
 * Albert: everything about an agent - inputs, outputs, settings - laid out on
 * the agent's own page, in sections, with dates, and an unmistakable LIVE mark
 * when it is running. `AgentStatusLine` is the mark; `AgentInputsSection` is
 * what it runs on; `AgentSetupSection` is what the launch decided. The archive
 * below them is the outputs band and already existed.
 *
 * Server components on purpose. Nothing here holds state, everything they paint
 * was redacted at the RSC boundary, and the two interactive things a reader
 * might want from them - editing an intake form, reordering the rotation - are
 * reached through the surfaces that already own those writes rather than
 * re-implemented here. A second editor for a document that has one is how two
 * surfaces start disagreeing about it.
 *
 * ANIMATION IS CSS-GRADE ONLY: the classes below are declared in globals.css
 * and every one of them is switched off inside the prefers-reduced-motion
 * block there. No library, no effect, nothing that needs hydration.
 */

/* ────────────────────────────── status ─────────────────────────────────── */

/** One fact the status line states, already worded by the page. */
export interface AgentStatusFact {
  /**
   * The whole phrase, as the line says it: "Next post Thu 5", "12 in your
   * Workspace". Not a label/value pair — this is a sentence of facts separated
   * by middots, and a `dt`/`dd` grid was the shape the tinted band had.
   */
  text: string;
  /**
   * Where this fact LIVES, when it has somewhere. "Next post Thu 5" opens the
   * calendar on that day; "12 in your Workspace" opens the archive. A fact with
   * no destination renders as plain text and wears no link affordance (round 6
   * rule 3: a static box may not wear the shell of a link).
   */
  href?: string;
}

/**
 * The agent's state, said ONCE (round 6, decision 10).
 *
 * It replaces the tinted status strip and the header chip that repeated its word
 * a hundred pixels above it — the same answer twice, in two typographic voices,
 * which is the duplication Albert asked about ("is the badge necessary at all").
 * What is left is one 13px line under the page header: a tone dot, the word, the
 * facts that answer "what happens next", and the page's own trailing control.
 * No border, no tint, no mono uppercase.
 *
 * THE DOT CARRIES THE TONE, and only from the judgment scale (success, warning,
 * info, muted). Orange never signals status. The WORD stays ink, so the line
 * reads as a sentence rather than as a coloured alarm.
 *
 * The STATUS ITSELF is not re-derived here. It arrives already resolved by
 * `rosterStatus`, which is where the rule lives that a schedule refusal
 * outranks Live (F24/F129) - an agent whose every fire is turned away is not
 * live, whatever its umbrella says. A line that decided its own tone from
 * `launchState === "live"` would be the second answer that quietly disagrees.
 *
 * IT ALWAYS RENDERS. The old strip stood down unless it had facts, an aside or a
 * live word, so a not-set-up agent had no status statement in the column at all
 * and the chip in the header was the only place the state was said. There is no
 * chip now, so the line is the statement.
 */
export function AgentStatusLine({
  status,
  running,
  noun = "post",
  facts,
  staffNote,
  trailing,
}: {
  /** From `rosterStatus` - never re-derived. The real union, so a tone typo
      is a type error rather than a silent fall-through to idle grey. */
  status: RosterStatus;
  /**
   * `RosterStatus.staffNote`, passed by the page ONLY for a staff viewer — AF-5's
   * operational truth and, since round 6, a last run that failed.
   *
   * Taken as its own prop rather than read off `status` here, because this is a
   * server component and "who may read this" is a decision for the boundary that
   * knows the viewer, not for the component that paints. A client's page passes
   * nothing and the line does not exist in their HTML at all.
   */
  staffNote?: string;
  /**
   * A run THIS viewer started is in flight. Deliberately narrow, and resolved
   * by the page from the same sources the run banners use: a scheduled fire is
   * not something the reader just asked for, and announcing one would say out
   * loud that production is not day-of (A3/A4).
   */
  running: boolean;
  /** What one run of this agent makes, in the client's words (OUTPUT_NOUN). */
  noun?: string;
  facts: AgentStatusFact[];
  /**
   * The page's own control at the END of the line — "Adjust pace" when a
   * schedule exists. A ReactNode because the control is interactive and this
   * file is a server component; what goes here stays the page's call, and this
   * line re-derives nothing.
   */
  trailing?: React.ReactNode;
}) {
  const live = status.tone === "live";
  const dot =
    live
      ? "bg-success"
      : status.tone === "attention"
        ? "bg-warning"
        : status.tone === "progress"
          ? "bg-info"
          : "bg-muted-2";

  return (
    <section className="space-y-1">
      <div className="flex flex-wrap items-center gap-x-2 gap-y-1 text-[13px]">
        <span
          className={`h-2 w-2 shrink-0 rounded-full ${dot} ${live ? "animate-pulse-ring" : ""}`}
          aria-hidden="true"
        />
        <span className="text-foreground">{status.label}</span>
        {facts.map((fact) => (
          <span key={fact.text} className="flex items-center gap-2">
            <span className="text-muted-2" aria-hidden="true">
              ·
            </span>
            {fact.href ? (
              // A quiet text link: muted to foreground with an underline, no
              // glyph after it, and the one shared focus ring (round 6 rule 3).
              <Link href={fact.href} className="focus-ring text-muted hover:text-foreground hover:underline">
                {fact.text}
              </Link>
            ) : (
              <span className="text-muted">{fact.text}</span>
            )}
          </span>
        ))}
        {/* `ml-auto` on a wrapping row: the control sits at the end of the line
            when there is room and drops to its own line when there is not. */}
        {trailing && <span className="ml-auto">{trailing}</span>}
      </div>
      {/* N8's run tray, in its smallest form: the one thing a reader who just
          pressed the button wants to know, on its own line so it cannot push
          the facts around. */}
      {running && (
        <p className="flex items-center gap-1.5 text-xs text-muted-2">
          <Icon name="LoaderCircle" className="h-3 w-3 animate-spin-slow" aria-hidden="true" />
          Working on your next {noun}. This takes {RUN_ESTIMATE_SENTENCE}. You can leave this page.
        </p>
      )}
      {/* The operational truth beside the client-facing word. It sits UNDER the
          line rather than replacing anything in it: the word is what the client
          sees and staff need to know that, so the fix is a second sentence, not
          a different first one. */}
      {staffNote && (
        <p className="text-[11px] text-muted-2">
          <Badge tone="neutral" className="mr-1.5 align-middle">
            Internal
          </Badge>
          {staffNote}
        </p>
      )}
    </section>
  );
}

/* ───────────────────────────── inputs band ─────────────────────────────── */

/**
 * The documents this agent drafts from, each with the date it last changed.
 *
 * These are Daniel's intake surfaces - the company form, one seat per person,
 * the shared news drop, the takes box. They have always existed at
 * `/clients/<id>/<platform>-agent`; the sidebar that linked them was removed in
 * the redesign, so for two months the only way to reach a seat form was to know
 * the URL. This band is the way back, and it deliberately does not FORK the
 * forms: every row's manage link lands on the one page that owns those writes.
 *
 * WHAT EACH ROW CARRIES CHANGED WITH AF-7. Albert, walking the branch: "your X
 * details — this is a button here, but realistically it should show on this
 * page." So a row with answers is now a disclosure that opens onto them in place,
 * and the WRITES still live where they always did: the expansion's own link lands
 * on that row's card on the intake page, and the band's footer link lands on the
 * page. Nothing here edits anything.
 *
 * The old rule was that the answers stayed behind the link "where the client-safe
 * intake views already redact them", the worry being a second payload with a
 * second set of rules. That worry is answered rather than overruled:
 * `toAgentInputRows` builds `answers` by calling THOSE VERY VIEWS
 * (toXIntakeView / toLiIntakeView / toRedditIntakeView), so there is still one
 * whitelist and this band is downstream of it.
 *
 * A row with NOTHING saved keeps its old shape — a plain link straight to its own
 * card on the form (#85, the empty-seat case). A disclosure that opens onto no
 * answers would be a control that lied about having content, and the reader of an
 * empty row wants the form, not a drawer.
 */
export function AgentInputsSection({ view }: { view: AgentInputsView }) {
  const missing = view.rows.filter((row) => !row.filled).length;
  return (
    <section>
      <div className="mb-3 flex flex-wrap items-center justify-between gap-2">
        <h2 className="font-mono text-sm uppercase tracking-[0.1em] text-muted">
          What it runs on
        </h2>
        <Badge tone={view.ready ? "success" : "warning"}>
          {view.ready ? "Ready to run" : "Needs your answers"}
        </Badge>
      </div>
      {/* The lead names the affordance the rows now have. It used to say "open
          any of them to change what it knows", which described a link out; the
          rows show the answers in place and the change happens on the form. */}
      <p className="mb-2.5 text-xs text-muted-2">
        {view.ready
          ? "This agent writes from what you saved here. Open a row to read your answers back."
          : "This agent needs these before it can write for you."}
      </p>
      {/* EVERY ROW IS REACHABLE, and its target is derived from the row's own id
          through `intakeRowHref` — the same function the intake surfaces render
          their anchors with, so a row cannot be added here with nowhere to land
          and neither side can rename the anchor without the other (#85).

          A row with answers reaches it from INSIDE its disclosure (AF-7); a row
          with none is still the link itself, which is the case #85 was about: a
          client with four empty seats clicked the empty seat and got nothing.

          `<details>` rather than state, because these bands are server components
          and everything they paint was redacted at the RSC boundary. Making the
          module a client one to hold a single open/closed boolean would ship the
          whole band to the browser for an affordance the platform already has. */}
      <ul className="space-y-1.5">
        {view.rows.map((row) =>
          row.answers ? (
            <li key={row.id}>
              {/* `row-lift` is the one hover for a bordered, interactive row
                  (round 6 rule 3): one fill step plus the accent hairline. */}
              <details className="group row-lift rounded-[var(--radius)] border border-border bg-surface-2/50">
                <summary className="focus-ring flex cursor-pointer list-none items-center gap-3 px-3 py-2">
                  <Icon
                    name="ChevronRight"
                    className="h-3.5 w-3.5 shrink-0 text-muted-2 transition-transform group-open:rotate-90"
                    aria-hidden="true"
                  />
                  <Icon name={row.icon} className="h-3.5 w-3.5 shrink-0 text-muted-2" />
                  <RowFace row={row} />
                </summary>
                <div className="animate-fade-up space-y-1.5 border-t border-border/60 px-3 py-2">
                  <dl className="space-y-1.5">
                    {row.answers.map((entry, index) => (
                      <div key={`${entry.label}-${index}`}>
                        <dt className="text-[11px] text-muted-2">{entry.label}</dt>
                        {/* Whitespace preserved: these are the client's own
                            sentences, and a multi-line "never post about" answer
                            that collapses into one paragraph reads as a different
                            answer from the one they typed. */}
                        <dd className="whitespace-pre-wrap text-xs leading-relaxed text-foreground">
                          {entry.value}
                        </dd>
                      </div>
                    ))}
                  </dl>
                  {/* The way to CHANGE any of this. Read-only in place, edited on
                      the page that owns the writes — a second editor for a
                      document that has one is how two screens start disagreeing
                      about the same record. */}
                  {/* A quiet text link (round 6 rule 3): muted to foreground
                      with an underline, and no glyph after the label. */}
                  <Link
                    href={intakeRowHref(view.href, row.id)}
                    className="focus-ring inline-flex items-center text-[11px] text-muted hover:text-foreground hover:underline"
                  >
                    Change this
                  </Link>
                </div>
              </details>
            </li>
          ) : (
            <li key={row.id}>
              <Link
                href={intakeRowHref(view.href, row.id)}
                className="focus-ring row-lift flex items-center gap-3 rounded-[var(--radius)] border border-border bg-surface-2/50 px-3 py-2"
              >
                <Icon name={row.icon} className="h-3.5 w-3.5 shrink-0 text-muted-2" />
                <RowFace row={row} />
              </Link>
            </li>
          ),
        )}
      </ul>
      <Link
        href={view.href}
        className="focus-ring mt-2 inline-flex items-center text-xs text-muted hover:text-foreground hover:underline"
      >
        {/* The label is already a full noun phrase in the reader's words
            ("Your X details"), so it stands alone rather than being prefixed
            with a verb that would read as a second imperative next to the
            band's own badge — and no glyph follows it (round 6 rule 3). */}
        {view.label}
      </Link>
      {missing > 0 && (
        <p className="mt-1.5 text-[11px] text-muted-2">
          {missing} of {view.rows.length} still empty.
        </p>
      )}
    </section>
  );
}

/**
 * The part of an input row that reads the same whether the row opens or links.
 *
 * Shared so the two branches cannot drift: the disclosure and the plain link are
 * two affordances over one row, and a date or a badge that appeared on only one
 * of them would make the band's own state depend on whether a client had
 * answered yet.
 */
function RowFace({ row }: { row: AgentInputsView["rows"][number] }) {
  return (
    <>
      <span className="min-w-0 flex-1">
        <span className="block truncate text-xs text-foreground">{row.label}</span>
        <span className="block truncate text-[11px] text-muted-2">{row.detail}</span>
      </span>
      {/* A date on every row, which is the whole point of the band — "who has
          never filled theirs in" is not a question a list of names can answer.
          An empty document reads as empty rather than as a dash, because the two
          are different facts. */}
      <span className="shrink-0 text-[11px] text-muted-2">
        {row.updatedAt === null ? "Never saved" : relativeTime(row.updatedAt)}
      </span>
      {!row.filled && <Badge tone="warning">Empty</Badge>}
    </>
  );
}

/* ──────────────────────────── settings band ────────────────────────────── */

/**
 * What the setup run decided, dated (directive 2).
 *
 * Read-only, and every fact here has an editor somewhere else on this page -
 * the format rows reorder and pause, the pace dialog changes the schedule, the
 * curation pane rewrites the registry. The gap this fills is that none of those
 * editors ever says WHEN any of it happened, so an agent that was set up in
 * March and has not been touched since looked identical to one configured this
 * morning.
 */
export function AgentSetupSection({ facts }: { facts: AgentSetupFact[] }) {
  if (facts.length === 0) return null;
  return (
    <section>
      <h2 className="mb-3 font-mono text-sm uppercase tracking-[0.1em] text-muted">
        How it&rsquo;s set up
      </h2>
      <dl className="grid gap-x-4 gap-y-2 rounded-[var(--radius)] border border-border bg-surface-2/50 px-3 py-2.5 sm:grid-cols-2">
        {facts.map((fact) => (
          <div key={fact.label} className="flex items-baseline justify-between gap-3">
            <dt className="shrink-0 text-[11px] text-muted-2">{fact.label}</dt>
            <dd className="min-w-0 truncate text-right text-xs text-foreground">
              {fact.at !== undefined ? formatDate(fact.at) : fact.value}
            </dd>
          </div>
        ))}
      </dl>
    </section>
  );
}
