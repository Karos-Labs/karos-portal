import Link from "next/link";
import { Card, CardTitle, Badge } from "@/components/ui";
import { Icon } from "@/components/icon";
import { cn } from "@/lib/utils";
import { platformLabel } from "@/lib/integrations/platforms";
import { TONE_COLORS } from "@/components/seo-geo/tones";
import type { FollowerPoint } from "@/lib/follower-tracking";
import type { ScoreView } from "@/components/seo-geo/presenter";

/** Channels listed before the rest collapse into a "+N more" line. */
const CHANNEL_ROWS = 4;

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

/** A signed percentage in the success/danger ink, or nothing at all when it is null. */
function Delta({ pct }: { pct: number | null }) {
  if (pct == null) return null;
  return (
    <p className={`mt-0.5 text-xs ${pct >= 0 ? "text-success" : "text-danger"}`}>
      <Icon name={pct >= 0 ? "TrendingUp" : "TrendingDown"} className="mr-1 inline h-3 w-3" />
      {pct >= 0 ? "+" : ""}
      {pct.toFixed(1)}%
    </p>
  );
}

/**
 * One score as a labelled meter — the compact form of the big tiles on Account
 * Center's Reporting tab, built from the SAME ScoreView the full report renders
 * (buildScoreViews), so this row and that page cannot quote different numbers
 * for one snapshot.
 *
 * The meter is what makes it readable at this size: a bare integer says
 * nothing about whether it's good, and a bar filled to `value` in the band's
 * own tone answers that without a legend.
 */
function ScoreMeter({ view }: { view: ScoreView }) {
  const measured = view.value != null;
  return (
    <li>
      <div className="mb-1 flex items-baseline justify-between gap-2">
        <span className="truncate text-xs text-muted">{view.label}</span>
        <span className="shrink-0 font-mono text-xs font-semibold text-foreground">
          {measured ? view.value : "–"}
        </span>
      </div>
      <div className="h-1.5 overflow-hidden rounded-full bg-surface-3">
        <div
          className="h-full rounded-full transition-[width]"
          style={{
            width: `${measured ? Math.min(100, Math.max(0, view.value as number)) : 0}%`,
            background: TONE_COLORS[view.tone],
          }}
        />
      </div>
    </li>
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
 * today"), not a new metric invented for this card. Channels stays: it is a
 * separate, independently locked decision ("Channels shows the logos of what
 * they are connected to"), not one of the KPIs D6 was ever asked about.
 */
export function HomeKpisWidget({
  audienceTotal,
  audienceGrowthPct,
  audienceSeries,
  channels,
  visibilityScore,
  reportHref,
  channelsHref,
}: {
  /** Real stored follower snapshots only — an empty series hides the cell entirely. */
  audienceTotal: number;
  audienceGrowthPct: number | null;
  audienceSeries: FollowerPoint[];
  channels: { platform: string; usable: boolean }[];
  /** The one ScoreView D6 kept — null when there is no snapshot to score yet. */
  visibilityScore: ScoreView | null;
  reportHref: string;
  /**
   * Where the real "Reconnect" control lives (Account Center's Settings tab,
   * which mounts IntegrationsTab) — the badge below used to say "Reconnect"
   * over plain, non-interactive text with no href/onClick at all, promising an
   * action it did not perform.
   */
  channelsHref: string;
}) {
  // A single point is a reading, not a trend — the sparkline needs two.
  const showAudience = audienceSeries.length >= 2;

  // A channel that needs reconnecting is the actionable one, so it sorts first
  // — a broken LinkedIn must not fall under the "+2 more" fold while four
  // healthy rows sit above it.
  const sortedChannels = [...channels].sort(
    (a, b) => Number(a.usable) - Number(b.usable) || a.platform.localeCompare(b.platform),
  );
  const shownChannels = sortedChannels.slice(0, CHANNEL_ROWS);
  const extraChannels = sortedChannels.length - shownChannels.length;
  const brokenChannels = sortedChannels.filter((c) => !c.usable).length;

  return (
    <Card>
      <div className="mb-3 flex items-center justify-between gap-3">
        <CardTitle className="min-w-0 truncate">Your numbers</CardTitle>
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
          <div className="rounded-md border border-border bg-surface-2 p-3">
            <p className="text-[10px] font-semibold uppercase tracking-wider text-muted-2">
              Total followers
            </p>
            <p className="mt-1 text-2xl font-semibold text-foreground">
              {audienceTotal.toLocaleString()}
            </p>
            <Delta pct={audienceGrowthPct} />
            <div className="mt-2">
              <Sparkline counts={audienceSeries.map((p) => p.count)} />
            </div>
          </div>
        )}

        {/* Channels — locked separately from D6, unaffected by it */}
        <div className="rounded-md border border-border bg-surface-2 p-3">
          <div className="flex items-baseline justify-between gap-2">
            <p className="text-[10px] font-semibold uppercase tracking-wider text-muted-2">
              Channels
            </p>
            {/* The health summary IS the headline here: a count of connected
                channels is inventory, "one needs attention" is news. */}
            {brokenChannels > 0 && (
              <span className="shrink-0 text-[10px] font-medium text-warning">
                {brokenChannels} need{brokenChannels === 1 ? "s" : ""} attention
              </span>
            )}
          </div>
          {sortedChannels.length === 0 ? (
            <p className="mt-2 text-sm text-muted-2">None connected yet.</p>
          ) : (
            <>
              <ul className="mt-2 space-y-1.5">
                {shownChannels.map((c) => {
                  const badge = (
                    <Badge tone={c.usable ? "neon" : "warning"}>
                      <Icon
                        name={c.usable ? "CircleCheck" : "TriangleAlert"}
                        className="h-3 w-3"
                      />
                      {c.usable ? "Connected" : "Reconnect"}
                    </Badge>
                  );
                  return (
                    <li key={c.platform} className="flex items-center justify-between gap-2">
                      <span className="truncate text-sm text-foreground">
                        {platformLabel(c.platform)}
                      </span>
                      {/* "Reconnect" is a real destination now — it used to be a
                          plain, non-interactive label promising an action it
                          could not perform. A healthy channel has nothing to
                          reconnect, so only the broken row links out. */}
                      {c.usable ? (
                        badge
                      ) : (
                        <Link href={channelsHref} className="transition-opacity hover:opacity-80">
                          {badge}
                        </Link>
                      )}
                    </li>
                  );
                })}
              </ul>
              {extraChannels > 0 && (
                <p className="mt-1.5 text-[11px] text-muted-2">
                  +{extraChannels} more connected
                </p>
              )}
            </>
          )}
        </div>

        {/* AI visibility — the one score D6 kept, of the three buildScoreViews returns */}
        <Link
          href={reportHref}
          className="block rounded-md border border-border bg-surface-2 p-3 transition-colors hover:border-border-strong"
        >
          <p className="text-[10px] font-semibold uppercase tracking-wider text-muted-2">
            Visibility
          </p>
          {visibilityScore ? (
            <ul className="mt-2.5">
              <ScoreMeter view={visibilityScore} />
            </ul>
          ) : (
            <p className="mt-2 text-sm text-muted-2">Not measured yet.</p>
          )}
        </Link>
      </div>
    </Card>
  );
}
