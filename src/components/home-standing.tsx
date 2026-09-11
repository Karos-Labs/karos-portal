import Link from "next/link";
import type { ReactNode } from "react";
import { Card, CardTitle } from "@/components/ui";
import { Icon } from "@/components/icon";
import { TONE_COLORS } from "@/components/seo-geo/tones";
import type { PresenceView, ScoreView } from "@/components/seo-geo/presenter";
import { cn } from "@/lib/utils";

/**
 * The shell all three readings share: an accented eyebrow, then the reading.
 *
 * NOT A LINK (SCRUM-418, Albert 2026-09-10). Round 6 made each tile a link
 * because the KPI cells lit up and these did not. But these three are readings
 * of one snapshot that all opened the same report, so per-tile links were three
 * controls doing one job; the card's single header link is the way in now. The
 * KPI card keeps per-cell links, because its cells really do go to different
 * places.
 */
function MeterTile({
  icon,
  label,
  children,
}: {
  icon: string;
  label: string;
  children: ReactNode;
}) {
  return (
    <div className="rounded-md border border-border bg-surface-2 p-3.5">
      {/* No trailing chevron: the eyebrow ends at the label now, because the
          glyph that used to close it was the promise this tile stopped
          making. */}
      <p className="flex items-center gap-1.5 text-[10px] font-semibold uppercase tracking-wider text-muted-2">
        <Icon name={icon} className="h-3.5 w-3.5 shrink-0 text-neon" />
        <span className="min-w-0 flex-1 truncate">{label}</span>
      </p>
      {children}
    </div>
  );
}

/**
 * One percentage as a headline and a meter.
 *
 * THE BAR IS ORANGE (round 6, Albert 2026-09-06). Round 6 briefly made it ink
 * on a grey track; the ruling put it back. The one-orange-per-screen rule is
 * about CONTROLS — a meter fill is data, and data keeps its accent. Losing the
 * link did not change that: this tile stopped being a control, which is
 * precisely the category the ration governs, and the fill was never in it.
 *
 * The track is the same accent at low alpha: the filled part is the number, and
 * the unfilled part is visibly the same measurement rather than background,
 * which matters most at the small values where an accent sliver on `surface-3`
 * read as an empty card.
 */
function ShareMeter({
  icon,
  label,
  caption,
  pct,
  emptyLine,
}: {
  icon: string;
  label: string;
  caption: string;
  pct: number | null;
  emptyLine: string;
}) {
  return (
    <MeterTile icon={icon} label={label}>
      {pct == null ? (
        <p className="mt-2 text-sm text-muted-2">{emptyLine}</p>
      ) : (
        <>
          <p className="stat-number mt-1.5 text-3xl font-semibold leading-none tracking-tight text-foreground">
            {pct}
            <span className="ml-0.5 text-lg font-medium text-muted-2">%</span>
          </p>
          <div className="mt-2.5 h-2 overflow-hidden rounded-full bg-neon/15">
            <div
              className="h-full rounded-full bg-neon"
              style={{ width: `${Math.min(100, Math.max(0, pct))}%` }}
            />
          </div>
          <p className="mt-1.5 text-[11px] leading-snug text-muted-2">{caption}</p>
        </>
      )}
    </MeterTile>
  );
}

/**
 * The visibility score, moved here from the KPI card by SCRUM-418.
 *
 * It is the same `ScoreView` the full report renders (`buildScoreViews`), so
 * this tile and Account Center's Reporting tab cannot quote different numbers
 * for one snapshot. It sits FIRST because it is the headline the two shares
 * below it decompose — and because it was the third link to this card's
 * destination, which is what made all three read as noise.
 *
 * ITS FILL KEEPS THE TONE SCALE while its two neighbours keep the orange, and
 * that difference is the point rather than an oversight: a share is a
 * measurement and takes the data accent, a score is a JUDGMENT and takes the
 * success/warning/info ink the rest of the app judges with. Orange never
 * signals status. The track is the band's own colour at low alpha for the
 * reason the report's meters use it: in light mode `surface-3` is a
 * three-point step off `surface-2`, which is no step, and the unfilled half of
 * the bar simply disappeared.
 */
function ScoreMeter({ view }: { view: ScoreView }) {
  const measured = view.value != null;
  const color = TONE_COLORS[view.tone];
  return (
    <MeterTile icon="Radar" label="Visibility">
      <p className="stat-number mt-1.5 text-3xl font-semibold leading-none tracking-tight text-foreground">
        {measured ? view.value : "\u2013"}
        {measured && <span className="ml-1 text-sm font-medium text-muted-2">/ 100</span>}
      </p>
      <div
        className="mt-2.5 h-2 overflow-hidden rounded-full"
        style={{ background: `color-mix(in srgb, ${color} 18%, transparent)` }}
      >
        <div
          className="h-full rounded-full transition-[width]"
          style={{
            width: `${measured ? Math.min(100, Math.max(0, view.value as number)) : 0}%`,
            background: color,
          }}
        />
      </div>
      <p className="mt-1.5 text-[11px] leading-snug text-muted-2">{view.label}</p>
    </MeterTile>
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
  visibilityScore,
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
   * The full report, for the card's ONE header link.
   *
   * Un-anchored, and nothing appends a fragment to it any more. Round 6 had the
   * cells deep-link to `#presence` and `#share` — the ids seo-geo-panel.tsx
   * writes on the sections these numbers are computed in — which was the right
   * shape while each cell was its own control. With one link for the card there
   * is no per-metric section to aim at, and aiming the single link at one of
   * the three metrics' sections would privilege that metric arbitrarily.
   *
   * WHAT IT ACTUALLY POINTS AT TODAY is Account Center's Reporting tab
   * (`/clients/[id]/settings?tab=reporting`), not a standalone report page.
   * Lola is right that this is a settings surface; there is no report route to
   * send it to yet, so that is a dependency rather than something this card can
   * fix by relabelling its own link.
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
  /** The overall visibility score (SCRUM-418); null when nothing is scored yet. */
  visibilityScore: ScoreView | null;
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
  // Three readings, two of which are conditional, so the column count is
  // counted rather than hardcoded: a `grid-cols-3` holding two tiles leaves a
  // third of the card empty, and that gap reads as a metric that failed to
  // load.
  const tileCount = (visibilityScore ? 1 : 0) + (measured ? 2 : 0);

  return (
    <Card>
      <div className="mb-1 flex items-center justify-between gap-3">
        {/* The orange chip stays (round 6, Albert 2026-09-06). A card's heading
            glyph is decoration, not a control, so it is outside the
            one-orange-per-screen rule — same ruling as the KPI card's. */}
        <CardTitle className="flex min-w-0 items-center gap-2">
          <span className="flex h-6 w-6 shrink-0 items-center justify-center rounded-md bg-neon/10">
            <Icon name="Radar" className="h-3.5 w-3.5 text-neon" />
          </span>
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
      {tileCount > 0 ? (
        <div
          className={cn(
            "grid gap-3",
            tileCount === 2 && "@2xl:grid-cols-2",
            tileCount === 3 && "@2xl:grid-cols-3",
          )}
        >
          {/* The score leads: it is the headline the two shares decompose. */}
          {visibilityScore && <ScoreMeter view={visibilityScore} />}
          {presence && measured && (
          <ShareMeter
            icon="Search"
            label="Named in category answers"
            caption={presence.category.caption}
            pct={presence.category.pct}
            emptyLine={presence.category.emptyLine ?? "Not measured yet."}
          />
          )}
          {!(presence && measured) ? null : presence.rosterShare ? (
            <ShareMeter
              icon="ChartPie"
              label="Your share of the conversation"
              caption={presence.rosterShare.caption}
              pct={presence.rosterShare.pct}
              emptyLine="Not measured yet."
            />
          ) : (
            /* No competitors tracked ⇒ there is no denominator, so this is a
               prompt to create one rather than a 100% that would be an artifact
               of an empty roster.
 
               STILL A LINK, deliberately, on a card where the three meters
               stopped being links. SCRUM-418 says to strip this one too, and
               that would leave "Track a competitor and we'll measure your
               share" as an instruction with no way to follow it — the only
               route from Home to the Competitors tab, removed. It is also not
               what Lola's argument covers: her complaint is three RECAPS that
               all opened one report, and this is not a recap and does not go
               there. It goes somewhere no other control on this card goes, and
               it is the one thing here a client can act on.

               It reads as a control on purpose and cannot be mistaken for a
               fourth metric: dashed border, no figure, no bar. */
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

      {/* The tinted band and its orange sparkle stay (round 6, Albert
          2026-09-06). Round 6 flattened this to a `surface-2` band on the
          argument that a band with no control in it should not carry the
          screen's accent; the ruling is that the accent budget governs
          CONTROLS, and this is the card's read-out of what the numbers mean. */}
      {presence?.takeaway && (
        <p className="mt-3 flex items-start gap-2 rounded-md border border-neon/20 bg-neon/[0.06] px-3 py-2.5 text-sm leading-relaxed text-muted">
          <Icon name="Sparkles" className="mt-0.5 h-3.5 w-3.5 shrink-0 text-neon" />
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
