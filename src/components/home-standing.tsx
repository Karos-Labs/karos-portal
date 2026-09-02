import Link from "next/link";
import type { ReactNode } from "react";
import { Card, CardTitle } from "@/components/ui";
import { Icon } from "@/components/icon";
import type { PresenceView } from "@/components/seo-geo/presenter";

/**
 * One percentage as a headline + meter. Deliberately not a `StatCard`: the bar
 * is the whole point here, because both numbers on this card are shares and a
 * share without its remainder is just a digit.
 *
 * The bar draws the REMAINDER too (2026-09). It used to be an accent fill on a
 * `surface-3` track, and at 8% that is a two-pixel sliver against a tone the eye
 * reads as "empty card", so the one graphic on the card carried almost no signal
 * at the values that matter most. The track is now tinted with the same accent
 * at low alpha: the filled part is still the number, and the unfilled part is
 * visibly the same measurement rather than background.
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
    <div className="rounded-md border border-border bg-surface-2 p-3.5">
      <p className="flex items-center gap-1.5 text-[10px] font-semibold uppercase tracking-wider text-muted-2">
        <Icon name={icon} className="h-3.5 w-3.5 shrink-0 text-neon" />
        <span className="min-w-0 truncate">{label}</span>
      </p>
      {pct == null ? (
        <p className="mt-2 text-sm text-muted-2">{emptyLine}</p>
      ) : (
        <>
          <p className="mt-1.5 text-3xl font-semibold leading-none tracking-tight text-foreground">
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
    </div>
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
        <CardTitle className="flex min-w-0 items-center gap-2">
          <span className="flex h-6 w-6 shrink-0 items-center justify-center rounded-md bg-neon/10">
            <Icon name="Radar" className="h-3.5 w-3.5 text-neon" />
          </span>
          <span className="min-w-0 truncate">SEO &amp; AI visibility</span>
        </CardTitle>
        <Link
          href={href}
          className="flex shrink-0 items-center gap-1 whitespace-nowrap text-xs text-muted underline-offset-2 transition-colors hover:text-foreground hover:underline"
        >
          See the breakdown
          <Icon name="ChevronRight" className="h-3.5 w-3.5" />
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
          />
          {presence.rosterShare ? (
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
               of an empty roster. */
            <Link
              href={competitorsHref}
              className="row-lift flex flex-col justify-center rounded-md border border-dashed border-border p-3"
            >
              <p className="flex items-center gap-1.5 text-[10px] font-semibold uppercase tracking-wider text-muted-2">
                <Icon name="ChartPie" className="h-3.5 w-3.5 shrink-0 text-muted-3" />
                Your share of the conversation
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
