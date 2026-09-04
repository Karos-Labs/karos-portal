import Link from "next/link";
import type { ReactNode } from "react";
import { Card, CardTitle } from "@/components/ui";
import { Icon } from "@/components/icon";
import type { PresenceView } from "@/components/seo-geo/presenter";

/**
 * One percentage as a headline + meter, AND A LINK TO THE SECTION THAT SHOWS
 * THE WORKING (round 6).
 *
 * IT WAS A STATIC `div` IN THE KPI CELL'S EXACT SHELL — same border, same
 * `surface-2`, same eyebrow, same big figure — sitting one card below three
 * cells that light up and navigate. That is the finding the product owner
 * reported in his own words: the KPI cells light up and these do not. Two
 * readings: either these numbers are dead, or the affordance is decoration. So
 * the whole cell is the target now (rule 1), it hovers one fill step with
 * `row-lift`'s hairline, it ends in one static `ChevronRight`, and it carries
 * `.focus-ring` like every other interactive surface.
 *
 * Deliberately not a `StatCard`: the bar is the whole point here, because both
 * numbers on this card are shares and a share without its remainder is just a
 * digit.
 *
 * THE BAR IS INK (round 6, rule 7). It was an accent fill on an accent-tinted
 * track — two more orange things on the screen whose one orange is supposed to
 * be the ladder's button. The fill is `foreground` and the track is the same
 * decorative grey the KPI card's daily bars use, so the filled part is still
 * the number and the unfilled part is still visibly the same measurement rather
 * than background.
 */
function ShareMeter({
  icon,
  label,
  caption,
  pct,
  emptyLine,
  href,
}: {
  icon: string;
  label: string;
  caption: string;
  pct: number | null;
  emptyLine: string;
  /** The Reporting section this number is computed in. Required: see rule 1. */
  href: string;
}) {
  return (
    <Link
      href={href}
      className="row-lift focus-ring block rounded-md border border-border bg-surface-2 p-3.5"
    >
      <p className="flex items-center gap-1.5 text-[10px] font-semibold uppercase tracking-wider text-muted-2">
        <Icon name={icon} className="h-3.5 w-3.5 shrink-0 text-muted-2" />
        <span className="min-w-0 flex-1 truncate">{label}</span>
        <Icon name="ChevronRight" className="h-3.5 w-3.5 shrink-0 text-muted-2" />
      </p>
      {pct == null ? (
        <p className="mt-2 text-sm text-muted-2">{emptyLine}</p>
      ) : (
        <>
          <p className="mt-1.5 text-3xl font-semibold leading-none tracking-tight text-foreground">
            {pct}
            <span className="ml-0.5 text-lg font-medium text-muted-2">%</span>
          </p>
          <div className="mt-2.5 h-2 overflow-hidden rounded-full bg-muted-3/20">
            <div
              className="h-full rounded-full bg-foreground"
              style={{ width: `${Math.min(100, Math.max(0, pct))}%` }}
            />
          </div>
          <p className="mt-1.5 text-[11px] leading-snug text-muted-2">{caption}</p>
        </>
      )}
    </Link>
  );
}

/**
 * Home's SEO & AI visibility widget (2026-08; renamed 2026-09).
 *
 * IT WAS CALLED "Where you stand", and the product owner's read of that label
 * was that it names no data: a person scanning the dashboard could not tell
 * from the heading whether the card held revenue, deliverables or search
 * results. The title now says which programme the two numbers belong to, and
 * the standfirst underneath still says what they mean. Nothing about the
 * numbers changed with the rename.
 *
 * The two numbers on the Search & AI visibility report that a person actually
 * repeats back to somebody else, and the one sentence that says what they mean
 * together:
 *
 *  • CATEGORY PRESENCE — how often the engines name you when a buyer asks about
 *    your category WITHOUT naming you. "It's the hardest and most valuable place
 *    to show up" (buildPresence), and it is the number the whole SEO/GEO
 *    programme is trying to move.
 *  • SHARE OF CONVERSATION — your slice of every brand mention across you and
 *    the competitors we track, on those same category questions.
 *
 * The by-name presence tile is NOT here on purpose. It reads ~100% for almost
 * every account — asking an engine about a brand by name and being told about
 * that brand is not a finding — so on a summary surface it is a green number
 * that means nothing, sitting next to the two that mean everything. It stays on
 * the full report, where the contrast between the two is the point.
 *
 * Everything is read off `buildPresence(insights)` — the same call Account
 * Center's Reporting tab renders from — so this card is a projection of that
 * page rather than a second calculation of it. Nothing here recomputes a rate,
 * and a snapshot with nothing measured collapses to the caller rendering
 * nothing at all (see `hasStanding`).
 */
export function HomeStandingWidget({
  presence,
  href,
  competitorsHref,
  footer,
}: {
  /**
   * Nullable since 2026-09, and only for the `footer` caller below: a staff
   * viewer keeps this card (and the control in its footer) on an account with
   * no snapshot yet, because "there is nothing measured" is exactly when an
   * operator wants the refresh. A CLIENT caller still gates the whole card on
   * `hasStanding` and never reaches the empty branch — see that function.
   */
  presence: PresenceView | null;
  /**
   * The Reporting tab, un-anchored. THE CELLS APPEND THEIR OWN FRAGMENTS
   * (round 6): `#presence` and `#share`, the two ids seo-geo-panel.tsx writes on
   * the sections these numbers are computed in, by the same device
   * `#visibility-scores` already used for the KPI card's visibility cell. Built
   * here rather than threaded as two more props, because the fragment is a fact
   * about the panel this card is a projection of, not a routing decision the
   * caller makes.
   */
  href: string;
  /**
   * Where the empty-roster prompt below sends a client to actually track one
   * — Account Center's Competitors tab, which has always had a self-serve
   * "Add competitor" control. The prompt used to reuse `href` (the full
   * Reporting tab breakdown), landing the client one tab away from the
   * control its own copy promised, on a tab whose own empty state tells them
   * to contact staff instead.
   */
  competitorsHref: string;
  /**
   * A control that acts on THIS data, plus the sentence saying what it does
   * (2026-09). Today that is the admin's "Regenerate", which was in the page
   * header: a button captioned only by a tooltip, sitting beside the page title
   * with nothing around it naming what it rebuilds, while the numbers it
   * rewrites were three widgets down the page.
   *
   * COMPOSED BY THE CALLER, not by this file, and that is load-bearing twice
   * over. The control is admin-only and the caller already holds the role
   * check, so the gate stays in one place; and the explanatory sentence beside
   * it is staff copy, which `client-copy-boundary.test.ts` would (correctly)
   * hold to the client punctuation rules if it were a literal in this
   * client-reachable module.
   */
  footer?: ReactNode;
}) {
  const measured = presence != null && hasStanding(presence);

  return (
    <Card>
      <div className="mb-1 flex items-center justify-between gap-3">
        {/* Bare glyph, no orange chip — same demotion as the KPI card's. */}
        <CardTitle className="flex min-w-0 items-center gap-2">
          <Icon name="Radar" className="h-3.5 w-3.5 shrink-0 text-muted-2" />
          <span className="min-w-0 truncate">SEO &amp; AI visibility</span>
        </CardTitle>
        {/* A QUIET TEXT LINK, AND IT NAMES WHERE IT GOES (round 6). It said
            "See the breakdown" and carried a chevron: rows carry chevrons, text
            links do not, and "the breakdown" names no destination. Quiet links
            hover muted to foreground with an underline, and nothing else. */}
        <Link
          href={href}
          className="focus-ring shrink-0 whitespace-nowrap text-xs text-muted underline-offset-2 transition-colors hover:text-foreground hover:underline"
        >
          Open the full report
        </Link>
      </div>
      {/* No em dash: client-facing copy is held to the plain-language rules in
          client-copy-boundary.test.ts, which a dash-joined clause fails. */}
      <p className="mb-3 text-sm text-muted-2">
        How often AI engines name you when buyers ask about your category, and how much of
        that conversation is yours.
      </p>

      {/* Container-driven for the same reason as the KPI card above. */}
      {presence && measured ? (
        <div className="grid gap-3 @2xl:grid-cols-2">
          <ShareMeter
            icon="Search"
            label="Named in category answers"
            caption={presence.category.caption}
            pct={presence.category.pct}
            emptyLine={presence.category.emptyLine ?? "Not measured yet."}
            href={`${href}#presence`}
          />
          {presence.rosterShare ? (
            <ShareMeter
              icon="ChartPie"
              label="Your share of the conversation"
              caption={presence.rosterShare.caption}
              pct={presence.rosterShare.pct}
              emptyLine="Not measured yet."
              href={`${href}#share`}
            />
          ) : (
            /* No competitors tracked ⇒ there is no denominator, so this is a
               prompt to create one rather than a 100% that would be an artifact
               of an empty roster. */
            <Link
              href={competitorsHref}
              className="row-lift focus-ring flex flex-col justify-center rounded-md border border-dashed border-border p-3"
            >
              <p className="flex items-center gap-1.5 text-[10px] font-semibold uppercase tracking-wider text-muted-2">
                <Icon name="ChartPie" className="h-3.5 w-3.5 shrink-0 text-muted-3" />
                <span className="min-w-0 flex-1">Your share of the conversation</span>
                {/* It was a link with `row-lift` and no chevron and no focus
                    style: the same shell as the two cells beside it, minus both
                    halves of the affordance. */}
                <Icon name="ChevronRight" className="h-3.5 w-3.5 shrink-0 text-muted-2" />
              </p>
              <p className="mt-1.5 text-sm text-muted-2">
                Track a competitor and we&apos;ll measure your share of the answers against
                them.
              </p>
            </Link>
          )}
        </div>
      ) : (
        /* Staff-only branch in practice: a client caller gates on hasStanding. */
        <div className="flex items-center gap-3 rounded-md border border-dashed border-border px-3 py-3">
          <Icon name="Radar" className="h-4 w-4 shrink-0 text-muted-3" />
          <p className="text-sm text-muted-2">
            No visibility snapshot has been measured for this account yet.
          </p>
        </div>
      )}

      {/* THE TAKEAWAY IS A SENTENCE, NOT AN ALERT (round 6, rule 7). It sat in
          an orange-washed, orange-bordered band with an orange sparkle, which
          on a card of grey numbers read as the most important thing on Home —
          and it does nothing: there is no control in it and nowhere to press.
          A `surface-2` band with the glyph in `muted-2` says the same words. */}
      {presence?.takeaway && (
        <p className="mt-3 flex items-start gap-2 rounded-md bg-surface-2 px-3 py-2.5 text-sm leading-relaxed text-muted">
          <Icon name="Sparkles" className="mt-0.5 h-3.5 w-3.5 shrink-0 text-muted-2" />
          {presence.takeaway}
        </p>
      )}

      {footer && <div className="mt-4 border-t border-border pt-3.5">{footer}</div>}
    </Card>
  );
}

/**
 * Is there anything to show? A snapshot where neither bucket was measured would
 * render two "Not measured yet" boxes under a confident heading, which is worse
 * than the card's absence — Home's whole revision is about not spending space
 * on non-answers.
 *
 * STILL THE CLIENT'S GATE, unchanged. The widget grew an empty branch of its own
 * in 2026-09 so a staff viewer keeps the refresh control on an unmeasured
 * account; this function is what keeps that branch off a client's dashboard.
 */
export function hasStanding(presence: PresenceView): boolean {
  return presence.category.pct != null || presence.rosterShare != null;
}
