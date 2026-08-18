import Link from "next/link";
import { Card, CardTitle } from "@/components/ui";
import { Icon } from "@/components/icon";
import type { PresenceView } from "@/components/seo-geo/presenter";

/**
 * One percentage as a headline + meter. Deliberately not a `StatCard`: the bar
 * is the whole point here, because both numbers on this card are shares and a
 * share without its remainder is just a digit.
 */
function ShareMeter({
  label,
  caption,
  pct,
  emptyLine,
}: {
  label: string;
  caption: string;
  pct: number | null;
  emptyLine: string;
}) {
  return (
    <div className="rounded-md border border-border bg-surface-2 p-3">
      <p className="text-[10px] font-semibold uppercase tracking-wider text-muted-2">{label}</p>
      {pct == null ? (
        <p className="mt-2 text-sm text-muted-2">{emptyLine}</p>
      ) : (
        <>
          <p className="mt-1 text-2xl font-semibold leading-none text-foreground">{pct}%</p>
          <div className="mt-2 h-1.5 overflow-hidden rounded-full bg-surface-3">
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
 * Home's "Where you stand" widget (2026-08).
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
}: {
  presence: PresenceView;
  href: string;
}) {
  return (
    <Card>
      <div className="mb-1 flex items-center justify-between gap-3">
        <CardTitle className="min-w-0 truncate">Where you stand</CardTitle>
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
      <div className="grid gap-3 @2xl:grid-cols-2">
        <ShareMeter
          label="Named in category answers"
          caption={presence.category.caption}
          pct={presence.category.pct}
          emptyLine={presence.category.emptyLine ?? "Not measured yet."}
        />
        {presence.rosterShare ? (
          <ShareMeter
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
            href={href}
            className="flex flex-col justify-center rounded-md border border-dashed border-border p-3 transition-colors hover:border-border-strong"
          >
            <p className="text-[10px] font-semibold uppercase tracking-wider text-muted-2">
              Your share of the conversation
            </p>
            <p className="mt-1.5 text-sm text-muted-2">
              Track a competitor and we&apos;ll measure your share of the answers against
              them.
            </p>
          </Link>
        )}
      </div>

      {presence.takeaway && (
        <p className="mt-3 flex items-start gap-2 text-sm leading-relaxed text-muted">
          <Icon name="Sparkles" className="mt-0.5 h-3.5 w-3.5 shrink-0 text-neon" />
          {presence.takeaway}
        </p>
      )}
    </Card>
  );
}

/**
 * Is there anything to show? A snapshot where neither bucket was measured would
 * render two "Not measured yet" boxes under a confident heading, which is worse
 * than the card's absence — Home's whole revision is about not spending space
 * on non-answers.
 */
export function hasStanding(presence: PresenceView): boolean {
  return presence.category.pct != null || presence.rosterShare != null;
}
