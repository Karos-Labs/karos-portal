import type { ReactNode } from "react";
import { Card } from "@/components/ui";
import { Icon } from "@/components/icon";
import { Disclosure } from "@/components/seo-geo/disclosure";
import { ScorePopover } from "@/components/seo-geo/score-popover";
import { TONE_COLORS } from "@/components/seo-geo/tones";
import type { PresenceTile as PresenceTileView, PresenceView, ScoreView } from "@/components/seo-geo/presenter";

/**
 * The report's readings, as the pieces both surfaces draw them with.
 *
 * ONE ANATOMY FOR ONE NUMBER (Albert, 2026-09-11). Home's "SEO & AI
 * visibility" card quotes three readings of the same snapshot the Reporting
 * tab renders, and it had grown its own tile: an orange icon eyebrow, a thick
 * orange bar, a caption of its own. "Make it look the same as what it is in
 * the reporting, and if they want the details they go there, because it's the
 * exact same type of board." So the tiles live here and both surfaces mount
 * them: the score tile with its band colour, band label and coverage line, the
 * presence tile with its heading and caption, the share block with its inline
 * meter. What differs per surface is only the frame and the detail control:
 * Home puts a tile inside a card and prints the figure plain; the report
 * frames a score as a card of its own and makes the figure a popover.
 *
 * Server-safe: no hooks here. The two interactive leaves (Disclosure,
 * ScorePopover) are client components a server component may render.
 */

/** CSS-only hover/focus explainer. Supplementary by design: everything vital is also visible text. */
export function InfoTip({ text }: { text: string }) {
  return (
    <span className="group relative inline-flex">
      <button
        type="button"
        aria-label="What this means"
        className="focus-ring flex h-4 w-4 items-center justify-center rounded-full text-muted-2 transition-colors hover:text-foreground"
      >
        <Icon name="Info" className="h-3 w-3" />
      </button>
      <span
        role="tooltip"
        className="pointer-events-none absolute bottom-full left-0 z-20 mb-2 w-56 rounded-md border border-border bg-surface-3 px-2.5 py-2 text-left font-sans text-[11px] font-normal normal-case leading-relaxed tracking-normal text-foreground opacity-0 shadow-lg transition-opacity group-focus-within:opacity-100 group-hover:opacity-100 motion-reduce:transition-none"
      >
        {text}
      </span>
    </span>
  );
}

export function Meter({ pct, color, className }: { pct: number; color: string; className?: string }) {
  return (
    <div className={`h-1.5 w-full overflow-hidden rounded-full bg-surface-3 ${className ?? ""}`}>
      <div
        className="h-full rounded-full"
        style={{ width: `${Math.min(100, Math.max(0, pct))}%`, background: color }}
      />
    </div>
  );
}

/**
 * The box the report's presence tiles sit in, and the box every reading takes
 * inside another card: a score tile is a card of its own on the report and
 * this inside Home's card, so the two do not nest one card in another.
 */
export function SurfaceTile({ children }: { children: ReactNode }) {
  return <div className="min-w-0 rounded-md border border-border bg-surface-2 p-3">{children}</div>;
}

/**
 * ONE number treatment across the product (portal feedback round 4, 2026-09):
 * `.stat-number` for the face (sans + tabular numerals, per globals.css), the
 * "/ 100" suffix, and a band-tinted track at low alpha rather than
 * `surface-3`, which in light mode is a three-point step off the card and
 * left the unfilled half invisible.
 *
 * THE METER DRAWS THE SCORE, not data coverage: coverage is a caveat, and it
 * keeps its sentence underneath, where it reads as one.
 *
 * `breakdown` is the report's disclosure of what is behind the score. Home
 * passes false: the details are on the report, one link away.
 */
export function ScoreTile({
  view,
  frame = "card",
  breakdown = true,
}: {
  view: ScoreView;
  frame?: "card" | "tile";
  breakdown?: boolean;
}) {
  const color = TONE_COLORS[view.tone];
  const Frame = frame === "card" ? CardFrame : SurfaceTile;
  return (
    <Frame>
      <div className="flex items-center gap-1.5">
        <p className="font-label text-[10px] uppercase leading-snug tracking-[0.08em] text-muted [overflow-wrap:anywhere]">
          {view.label}
        </p>
        <InfoTip text={view.explainer} />
      </div>
      {view.value === null ? (
        <p className="stat-number mt-1.5 text-3xl font-semibold leading-none tracking-tight text-muted-2">
          &ndash;
        </p>
      ) : (
        <p className="stat-number mt-1.5 text-3xl font-semibold leading-none tracking-tight">
          <span style={{ color }}>{view.value}</span>
          <span className="ml-1 text-sm font-medium text-muted-2">/ 100</span>
        </p>
      )}
      <p className="mt-1.5 text-[11px]" style={{ color }}>
        {view.bandLabel}
      </p>
      <div className="mt-2.5">
        <div
          className="h-2 overflow-hidden rounded-full"
          style={{ background: `color-mix(in srgb, ${color} 18%, transparent)` }}
        >
          <div
            className="h-full rounded-full"
            style={{ width: `${Math.min(100, Math.max(0, view.value ?? 0))}%`, background: color }}
          />
        </div>
        <p className="mt-1.5 text-[11px] leading-snug text-muted-2">{view.coverageLine}</p>
      </div>
      {breakdown && view.breakdown.length > 0 && (
        <Disclosure summary={view.breakdownTitle} className="mt-3 border-t border-border pt-2.5">
          <ul className="space-y-2">
            {view.breakdown.map((row) => (
              <li key={row.label}>
                <div className="mb-0.5 flex items-baseline justify-between gap-2 text-[11px]">
                  <span className="text-muted">
                    {row.label}
                    {row.note && <span className="text-muted-2"> · {row.note}</span>}
                  </span>
                  {row.pct !== null && <span className="stat-number text-foreground">{row.pct}%</span>}
                </div>
                <Meter pct={row.pct ?? 0} color="var(--foreground)" className="opacity-40" />
              </li>
            ))}
          </ul>
        </Disclosure>
      )}
    </Frame>
  );
}

function CardFrame({ children }: { children: ReactNode }) {
  return <Card className="min-w-0">{children}</Card>;
}

/**
 * One presence bucket: how often the engines named the client on the questions
 * that name them, or on the ones that do not.
 *
 * CD-J1 directive 2: the headline is the percentage; the counts it was
 * computed from are one click away, in sentences. On the report that click is
 * the popover; on Home the figure is printed plain, at the same size, because
 * the details are the report's job.
 */
export function PresenceTile({
  tile,
  detail = "popover",
}: {
  tile: PresenceTileView;
  detail?: "popover" | "plain";
}) {
  return (
    <SurfaceTile>
      <div className="flex items-center gap-1.5">
        <p className="text-sm font-medium text-foreground">{tile.heading}</p>
        <InfoTip text={tile.explainer} />
      </div>
      <p className="text-[11px] text-muted-2">{tile.caption}</p>
      {tile.pctLabel ? (
        <>
          <div className="mt-2">
            {detail === "popover" ? (
              <ScorePopover
                value={tile.pctLabel}
                title={tile.detail.title}
                lines={tile.detail.lines}
                srLabel={`${tile.heading}: ${tile.pctLabel}. See how this was measured.`}
              />
            ) : (
              <p className="stat-number inline-flex min-h-6 items-baseline py-0.5 text-2xl font-medium text-foreground">
                {tile.pctLabel}
              </p>
            )}
          </div>
          {/* round 6, Albert 2026-09-06: `--neon`. Meter fills are data, not controls. */}
          <Meter pct={tile.pct ?? 0} color="var(--neon)" className="mt-1.5" />
        </>
      ) : (
        <p className="mt-2 text-xs text-muted-2">{tile.emptyLine}</p>
      )}
    </SurfaceTile>
  );
}

/** The client's slice of every brand mention, on category questions only. */
export function RosterShare({ share }: { share: NonNullable<PresenceView["rosterShare"]> }) {
  return (
    <>
      <div className="flex items-center gap-1.5">
        <p className="font-label text-[10px] uppercase tracking-[0.08em] text-muted">
          Your share of the conversation
        </p>
        {/* Basis stated in the caption below and in this explainer: category
            questions only (CD-J1 directive 3). */}
        <InfoTip text={share.explainer} />
      </div>
      <div className="mt-1.5 flex items-center gap-3">
        <span className="stat-number text-lg font-medium text-foreground">{share.value}</span>
        {/* round 6, Albert 2026-09-06: `--neon`, as above. */}
        <Meter pct={share.pct} color="var(--neon)" className="flex-1" />
      </div>
      <p className="mt-1 text-[11px] text-muted-2">{share.caption}</p>
    </>
  );
}
