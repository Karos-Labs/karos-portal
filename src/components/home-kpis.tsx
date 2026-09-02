import Link from "next/link";
import { Card, CardTitle } from "@/components/ui";
import { Icon } from "@/components/icon";
import { cn } from "@/lib/utils";
import { TONE_COLORS } from "@/components/seo-geo/tones";
import { THROUGHPUT_WINDOW_DAYS, type ContentThroughput } from "@/lib/content-throughput";
import type { FollowerPoint } from "@/lib/follower-tracking";
import type { ScoreView } from "@/components/seo-geo/presenter";

/** A minimal inline sparkline — no charting dependency for a handful of points. */
function Sparkline({ counts }: { counts: number[] }) {
  if (counts.length < 2) return null;
  const width = 160;
  const height = 36;
  const min = Math.min(...counts);
  const max = Math.max(...counts);
  const span = max - min || 1;
  const step = width / (counts.length - 1);
  const points = counts
    .map((c, i) => `${i * step},${height - ((c - min) / span) * height}`)
    .join(" ");

  return (
    <svg
      viewBox={`0 0 ${width} ${height}`}
      className="h-9 w-full"
      preserveAspectRatio="none"
      aria-hidden="true"
    >
      <polyline
        points={points}
        fill="none"
        stroke="var(--neon)"
        strokeWidth="2"
        strokeLinejoin="round"
        strokeLinecap="round"
      />
    </svg>
  );
}

/**
 * The weekly-throughput bars (2026-09).
 *
 * Bars rather than a second sparkline: these are four discrete counts, and a
 * line between them implies a reading in between that nobody took. An empty
 * week still draws its track, so a quiet fortnight looks quiet.
 */
function WeeklyBars({ counts }: { counts: number[] }) {
  const max = Math.max(1, ...counts);
  return (
    <div className="mt-2 flex h-9 items-end gap-1" aria-hidden="true">
      {counts.map((c, i) => (
        <div key={i} className="flex h-full flex-1 items-end rounded-sm bg-neon/10">
          <div
            className="w-full rounded-sm bg-neon"
            style={{ height: `${Math.max(c > 0 ? 12 : 0, (c / max) * 100)}%` }}
          />
        </div>
      ))}
    </div>
  );
}

/**
 * A signed percentage in the success/danger ink, or nothing at all when it is
 * null. `text` is the already-formatted magnitude (the two callers round to
 * different precisions), `note` the quiet basis clause after it.
 */
function Delta({ pct, text, note }: { pct: number | null; text: string; note?: string }) {
  if (pct == null) return null;
  return (
    <p className={`mt-0.5 text-xs ${pct >= 0 ? "text-success" : "text-danger"}`}>
      <Icon name={pct >= 0 ? "TrendingUp" : "TrendingDown"} className="mr-1 inline h-3 w-3" />
      {pct >= 0 ? "+" : ""}
      {text}
      {note ? <span className="ml-1 text-muted-2">{note}</span> : null}
    </p>
  );
}

/** The shared shell of a KPI cell: an accented eyebrow, then whatever the cell is. */
function Cell({
  icon,
  label,
  children,
  className,
}: {
  icon: string;
  label: string;
  children: React.ReactNode;
  className?: string;
}) {
  return (
    <div className={cn("rounded-md border border-border bg-surface-2 p-3.5", className)}>
      <p className="flex items-center gap-1.5 text-[10px] font-semibold uppercase tracking-wider text-muted-2">
        <Icon name={icon} className="h-3.5 w-3.5 shrink-0 text-neon" />
        <span className="min-w-0 truncate">{label}</span>
      </p>
      {children}
    </div>
  );
}

/**
 * The visibility score as a headline + meter, built from the SAME ScoreView the
 * full report renders (buildScoreViews), so this cell and Account Center's
 * Reporting tab cannot quote different numbers for one snapshot.
 *
 * SHAPED LIKE ITS TWO NEIGHBOURS as of 2026-09 — big numeral, meter, caption —
 * where it used to be a label/value row over a thin bar. Three cells side by
 * side, one of them arranged differently, made the card read as two KPIs and an
 * afterthought; the point of the row is that they are three readings of the same
 * kind. The meter stays because it is what makes the number mean anything at
 * this size: a bare 61 says nothing about whether 61 is good.
 *
 * The TRACK is the band's own colour at low alpha, not `surface-3`. In light
 * mode surface-3 is #e9e7df on a surface-2 cell of #eceae2 — a three-point step,
 * which is no step: the unfilled half of the meter simply disappeared and the
 * bar had no readable length. Same device the SEO share meters use.
 */
function ScoreCell({ view }: { view: ScoreView }) {
  const measured = view.value != null;
  const color = TONE_COLORS[view.tone];
  return (
    <>
      <p className="mt-1.5 text-3xl font-semibold leading-none tracking-tight text-foreground">
        {measured ? view.value : "–"}
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
    </>
  );
}

/**
 * Home's KPI row (portal revamp, Surface 02; content settled by D6, the
 * client-zero answer to the one question this page's own history left open).
 *
 * D6 — "KPIs that survive: total followers + growth chart, and the overall
 * Google/AI visibility rank. Nothing else." This is a full reversal of the
 * PRIOR ruling that lived here ("the first cell is not followers any more,
 * and that is the point" — because no follower ingestion existed and the
 * number was a seeded PRNG). That prior ruling is still honored on the one
 * axis that matters: this cell renders ONLY from real stored snapshots
 * (`audienceSeries`), same as before, and stays absent — never seeded, never
 * badged — until an ingestion cron actually writes one. D6 changed WHICH
 * measured thing gets the headline cell back, not the never-fabricate rule.
 *
 * The published-content stand-in that filled this slot in between
 * (lib/content-output.ts) is deleted, not kept around unused — it was a
 * stopgap for exactly the gap D6 now answers, and nothing else read it.
 *
 * "Nothing else" is also why this card no longer prints all three
 * buildScoreViews meters (search score, AI readiness, AI visibility): the
 * caller passes only the "visibility" one now — "the overall Google/AI
 * visibility rank" is that score's own established label ("AI visibility
 * today"), not a new metric invented for this card.
 *
 * ── THE CHANNELS CELL IS GONE (2026-09) ──────────────────────────────────
 *
 * It listed this client's channels one per row with a Connected/Reconnect
 * badge each, and the analytics stack's "Connected channels" card listed the
 * same channels with MORE detail (the account name on each, the same reconnect
 * link). Two lists of one thing, the shorter one first. The product owner's
 * instruction was to keep the detailed list in one place and spend the freed
 * cell on a high-level metric, so:
 *
 *  • the detailed list stays in "Connected channels" (client-analytics.tsx),
 *    which is Account Center's Reporting tab for a client and the Performance
 *    section for staff, next to the Settings tab that actually fixes one;
 *  • this cell becomes CONTENT PUBLISHED — live deliverables in the last 30
 *    days, the change against the 30 before it, and four weekly bars.
 *
 * That cell's own note about the Channels decision ("locked separately from
 * D6") is not being overruled quietly: D6 never covered Channels, and this
 * change is not a D6 revision either. It is the de-duplication pass, and what
 * it removes is the SECOND copy of a list, not the information.
 *
 * The one thing the removed cell said that the detailed card does not repeat
 * on this page is "N need attention". That did not vanish either — it is an
 * attention row in "Needs your attention" now, which is where a thing that
 * asks the reader to act belongs.
 */
export function HomeKpisWidget({
  audienceTotal,
  audienceGrowthPct,
  audienceSeries,
  throughput,
  visibilityScore,
  reportHref,
  contentHref,
}: {
  /** Real stored follower snapshots only — an empty series hides the cell entirely. */
  audienceTotal: number;
  audienceGrowthPct: number | null;
  audienceSeries: FollowerPoint[];
  /** Live-deliverable throughput — see lib/content-throughput.ts. */
  throughput: ContentThroughput;
  /** The one ScoreView D6 kept — null when there is no snapshot to score yet. */
  visibilityScore: ScoreView | null;
  reportHref: string;
  /** Where the throughput cell opens the content it counts. */
  contentHref: string;
}) {
  // A single point is a reading, not a trend — the sparkline needs two.
  const showAudience = audienceSeries.length >= 2;

  return (
    <Card>
      <div className="mb-3 flex items-center justify-between gap-3">
        <CardTitle className="flex min-w-0 items-center gap-2">
          <span className="flex h-6 w-6 shrink-0 items-center justify-center rounded-md bg-neon/10">
            <Icon name="ChartColumn" className="h-3.5 w-3.5 text-neon" />
          </span>
          <span className="min-w-0 truncate">Your numbers</span>
        </CardTitle>
        <Link
          href={reportHref}
          className="flex shrink-0 items-center gap-1 whitespace-nowrap text-xs text-muted underline-offset-2 transition-colors hover:text-foreground hover:underline"
        >
          Full report
          <Icon name="ChevronRight" className="h-3.5 w-3.5" />
        </Link>
      </div>

      {/* Container queries, not viewport breakpoints (2026-08). `sm:`/`lg:` ask
          the window, and this card lives in a column the 288px rail has already
          narrowed — so a 1024px window split it into cells too narrow for their
          own labels. `@xl` is 36rem of THIS grid, measured where the cells
          actually are. Three cells (with audience) go straight to three
          columns AT `@xl` rather than stepping through two first — two
          columns would leave the third cell alone in a half-empty second row
          for the entire `@xl`–`@4xl` range, not just avoid it above `@4xl`. */}
      <div className={cn("grid gap-4", showAudience ? "@xl:grid-cols-3" : "@xl:grid-cols-2")}>
        {/* Audience — the D6 cell, real snapshots only; absent when there are none */}
        {showAudience && (
          <Cell icon="Users" label="Total followers">
            <p className="mt-1.5 text-3xl font-semibold leading-none tracking-tight text-foreground">
              {audienceTotal.toLocaleString()}
            </p>
            <Delta
              pct={audienceGrowthPct}
              text={audienceGrowthPct == null ? "" : `${audienceGrowthPct.toFixed(1)}%`}
            />
            <div className="mt-2">
              <Sparkline counts={audienceSeries.map((p) => p.count)} />
            </div>
          </Cell>
        )}

        {/* Content published — the cell the duplicated channel list vacated */}
        <Link href={contentHref} className="block">
          <Cell
            icon="Send"
            label={`Published · ${THROUGHPUT_WINDOW_DAYS} days`}
            className="row-lift h-full"
          >
            <p className="mt-1.5 text-3xl font-semibold leading-none tracking-tight text-foreground">
              {throughput.count.toLocaleString()}
            </p>
            {throughput.deltaPct == null ? (
              <p className="mt-0.5 text-xs text-muted-2">
                {throughput.count === 0 ? "Nothing posted yet" : "First measured window"}
              </p>
            ) : (
              <Delta
                pct={throughput.deltaPct}
                text={`${throughput.deltaPct}%`}
                note="vs previous 30 days"
              />
            )}
            <WeeklyBars counts={throughput.weekly} />
          </Cell>
        </Link>

        {/* AI visibility — the one score D6 kept, of the three buildScoreViews returns */}
        <Link href={reportHref} className="block">
          <Cell icon="Radar" label="Visibility" className="row-lift h-full">
            {visibilityScore ? (
              <ScoreCell view={visibilityScore} />
            ) : (
              <p className="mt-2 text-sm text-muted-2">Not measured yet.</p>
            )}
          </Cell>
        </Link>
      </div>
    </Card>
  );
}
