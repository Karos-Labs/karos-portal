import { Badge, Card, CardTitle, EmptyState } from "@/components/ui";
import { Icon } from "@/components/icon";
import { BrandFavicon } from "@/components/brand-favicon";
import type { SeoGeoInsights } from "@/lib/seo-geo";
import {
  buildContextLine,
  buildDiscoveredViews,
  buildEngineViews,
  buildGapViews,
  buildPresence,
  buildPromptViews,
  buildRosterChips,
  buildRosterDrift,
  buildScoreViews,
  genericFlagPrefill,
  unwiredRequestPrefill,
  type EngineView,
  type ScoreView,
  type TrackedCompetitorRef,
} from "@/components/seo-geo/presenter";
import { TONE_COLORS } from "@/components/seo-geo/tones";
import { Disclosure } from "@/components/seo-geo/disclosure";
import { FlagButton } from "@/components/seo-geo/flag-button";
import { GapList } from "@/components/seo-geo/gap-list";

/**
 * SEO & GEO insights panel (SCRUM-52 redesign). Server component: all domain
 * markup renders here from presenter view-models; interactivity lives in the
 * small client leaves (disclosure, gap list, flag dialog). Everything a client
 * reads is plain English by construction — internal run-record vocabulary is
 * mapped (never echoed) in seo-geo/presenter.ts, which is unit-tested for leaks.
 */

/** CSS-only hover/focus explainer. Supplementary by design: everything vital is also visible text. */
function InfoTip({ text }: { text: string }) {
  return (
    <span className="group relative inline-flex">
      <button
        type="button"
        aria-label="What this means"
        className="flex h-4 w-4 items-center justify-center rounded-full text-muted-2 transition-colors hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-foreground/25"
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

function Meter({ pct, color, className }: { pct: number; color: string; className?: string }) {
  return (
    <div className={`h-1.5 w-full overflow-hidden rounded-full bg-surface-3 ${className ?? ""}`}>
      <div
        className="h-full rounded-full"
        style={{ width: `${Math.min(100, Math.max(0, pct))}%`, background: color }}
      />
    </div>
  );
}

/* ── 1 · Headline scores ─────────────────────────────────────────── */

function ScoreTile({ view }: { view: ScoreView }) {
  return (
    <Card className="min-w-0">
      <div className="flex items-center gap-1.5">
        <p className="font-mono text-[10px] uppercase leading-snug tracking-[0.08em] text-muted [overflow-wrap:anywhere]">
          {view.label}
        </p>
        <InfoTip text={view.explainer} />
      </div>
      {view.value === null ? (
        <p className="mt-1.5 font-mono text-2xl font-medium text-muted-2">n/a</p>
      ) : (
        <p className="mt-1.5 font-mono text-2xl font-medium">
          <span style={{ color: TONE_COLORS[view.tone] }}>{view.value}</span>
          <span className="ml-1 text-sm font-normal text-muted-2">/100</span>
        </p>
      )}
      <p className="mt-0.5 text-[11px]" style={{ color: TONE_COLORS[view.tone] }}>
        {view.bandLabel}
      </p>
      <div className="mt-2.5">
        <Meter pct={view.coveragePct} color="var(--muted-2)" />
        <p className="mt-1 text-[11px] text-muted-2">{view.coverageLine}</p>
      </div>
      {view.breakdown.length > 0 && (
        <Disclosure summary={view.breakdownTitle} className="mt-3 border-t border-border pt-2.5">
          <ul className="space-y-2">
            {view.breakdown.map((row) => (
              <li key={row.label}>
                <div className="mb-0.5 flex items-baseline justify-between gap-2 text-[11px]">
                  <span className="text-muted">
                    {row.label}
                    {row.note && <span className="text-muted-2"> · {row.note}</span>}
                  </span>
                  {row.pct !== null && <span className="font-mono text-foreground">{row.pct}%</span>}
                </div>
                <Meter pct={row.pct ?? 0} color="var(--foreground)" className="opacity-40" />
              </li>
            ))}
          </ul>
        </Disclosure>
      )}
    </Card>
  );
}

/* ── 2 · Capture context strip ───────────────────────────────────── */

function EngineChip({ view }: { view: EngineView }) {
  return (
    <span className="inline-flex items-center gap-1.5 rounded-md border border-border bg-surface-2 px-2 py-1">
      <span className="text-xs text-foreground">{view.name}</span>
      <Badge tone={view.statusTone}>{view.statusLabel}</Badge>
      <InfoTip text={view.explainer} />
    </span>
  );
}

/* ── 4 · Per-engine comparison ───────────────────────────────────── */

function EngineCard({ view }: { view: EngineView }) {
  return (
    <div className="rounded-md border border-border bg-surface-2 p-3">
      <div className="mb-2 flex flex-wrap items-center justify-between gap-2">
        <span className="flex items-center gap-1.5">
          <span className="text-sm font-medium text-foreground">{view.name}</span>
          <InfoTip text={view.explainer} />
        </span>
        <Badge tone={view.statusTone}>{view.statusLabel}</Badge>
      </div>
      {view.allZero ? (
        <p className="text-xs text-muted-2">
          No brands were named in {view.name}&apos;s answers this run.
        </p>
      ) : (
        <ul className="space-y-2">
          {view.brands.map((b) => (
            <li key={b.name} className={b.measured ? undefined : "opacity-55"}>
              <div className="mb-0.5 flex items-center justify-between gap-2 text-xs">
                <span className="flex min-w-0 items-center gap-1.5">
                  <BrandFavicon website={b.url} faviconSize={32} className="h-4 w-4 rounded-[3px]" />
                  <span
                    className={
                      (b.isClient ? "font-semibold text-foreground" : "text-muted") + " truncate"
                    }
                  >
                    {b.name}
                    {b.isClient && <span className="ml-1 text-[10px] text-muted-2">(you)</span>}
                  </span>
                </span>
                <span className="whitespace-nowrap font-mono text-[11px] text-muted-2">{b.line}</span>
              </div>
              {b.measured ? (
                <div className="h-2 overflow-hidden rounded-sm bg-surface-3">
                  <div
                    className="h-full rounded-sm"
                    style={{
                      width: `${b.pctOfMax}%`,
                      background: b.isClient ? "var(--neon)" : "var(--info)",
                      opacity: b.isClient ? 1 : 0.55,
                    }}
                  />
                </div>
              ) : (
                <div className="h-2 rounded-sm border border-dashed border-border" />
              )}
            </li>
          ))}
        </ul>
      )}
      <div className="mt-2 flex flex-col gap-1 text-xs leading-tight">
        {view.stats.map((s) => (
          <div key={s.label} className="flex items-center justify-between gap-2 text-muted-2">
            <span className="flex min-w-0 items-center gap-1">
              <span className="truncate">{s.label}:</span>
              <InfoTip text={s.explainer} />
            </span>
            <span className="shrink-0 whitespace-nowrap font-mono text-[11px] text-foreground">{s.value}</span>
          </div>
        ))}
      </div>
      {view.ghost && (
        <div className="mt-2 inline-flex items-center gap-1 rounded-[4px] border border-warning/30 bg-warning/10 px-2 py-1 font-mono text-[10px] uppercase tracking-[0.08em] text-warning">
          {view.ghost.label}
          <InfoTip text={view.ghost.explainer} />
        </div>
      )}
    </div>
  );
}

function UnmeasuredEngineCard({ view }: { view: EngineView }) {
  return (
    <div className="rounded-md border border-dashed border-border p-3">
      <div className="mb-1.5 flex flex-wrap items-center justify-between gap-2">
        <span className="text-sm font-medium text-muted">{view.name}</span>
        <Badge tone={view.statusTone}>{view.statusLabel}</Badge>
      </div>
      <p className="text-xs text-muted-2">{view.causeLine}</p>
      {view.flagPrefill && (
        <div className="mt-2">
          <FlagButton subject={view.flagPrefill.subject} message={view.flagPrefill.message} />
        </div>
      )}
    </div>
  );
}

/* ── Panel ───────────────────────────────────────────────────────── */

export function SeoGeoPanel({
  insights,
  trackedCompetitors,
  clientWebsite,
}: {
  insights: SeoGeoInsights | null;
  /** The CURRENT tracked-5 (same selector as the sidebar) — keeps every panel
   *  surface side-by-side with the Competitor Track instead of the frozen
   *  snapshot roster. */
  trackedCompetitors?: TrackedCompetitorRef[];
  /** Client website — drives the client's own favicon in the comparison rows. */
  clientWebsite?: string | null;
}) {
  if (!insights) {
    return (
      <Card>
        <CardTitle className="mb-4">Search &amp; AI visibility</CardTitle>
        <EmptyState
          icon={<Icon name="Radar" className="h-6 w-6" />}
          title="No visibility snapshot yet"
          description="Your first search and AI visibility snapshot usually appears within a day of onboarding. It measures how search engines and AI assistants like ChatGPT and Gemini talk about your brand versus competitors."
          action={
            <FlagButton
              subject="Question about our search and AI visibility snapshot"
              message=""
              label="Ask the Karos team"
            />
          }
        />
      </Card>
    );
  }

  const scores = buildScoreViews(insights);
  const engines = buildEngineViews(insights, trackedCompetitors, clientWebsite);
  const presence = buildPresence(insights);
  const gaps = buildGapViews(insights.gaps, insights.clientId);
  const prompts = buildPromptViews(insights);
  const generic = genericFlagPrefill(insights);
  const citationLeaderboard = insights.citationLeaderboard ?? [];

  const measuredEngines = engines.filter((e) => e.status === "measured");
  const unmeasuredEngines = engines.filter((e) => e.status !== "measured");
  const unwiredNames = engines.filter((e) => e.status === "not-wired").map((e) => e.name);
  const competitorCount = trackedCompetitors?.length ?? Math.max(0, insights.roster.length - 1);
  const noEnginesMeasured = measuredEngines.length === 0;

  // Live-vs-snapshot roster drift (QA Fix 1): the comparison follows the CURRENT
  // tracked list; this banner explains what changed since the capture.
  const drift = buildRosterDrift(insights, trackedCompetitors);
  const discovered = buildDiscoveredViews(insights, trackedCompetitors);
  const rosterChips = buildRosterChips(insights, trackedCompetitors, clientWebsite);

  // Citation leaderboard split (QA Fix 5): "who's quoted instead of you" vs your own baseline.
  const clientCitation = citationLeaderboard.find((r) => r.isClient) ?? null;
  const quotedInstead = citationLeaderboard.filter((r) => !r.isClient);
  const leaderboardMax = Math.max(1, ...quotedInstead.map((x) => x.citations));

  return (
    <div className="space-y-6">
      {/* 1 · Headline scores, coverage shown separately from the grade */}
      <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-3">
        {scores.map((view) => (
          <ScoreTile key={view.key} view={view} />
        ))}
      </div>

      {/* 2 · Where we looked: the "N of 5 engines" disclosure, all engines visible */}
      <Card>
        <p className="font-mono text-[11px] text-muted">{buildContextLine(insights)}</p>
        <div className="mt-3 flex flex-wrap items-center gap-2">
          {engines.map((view) => (
            <EngineChip key={view.engine} view={view} />
          ))}
        </div>
        {unwiredNames.length > 0 && (
          <div className="mt-3">
            <FlagButton
              {...unwiredRequestPrefill(unwiredNames, insights)}
              label={`Want ${unwiredNames.join(" or ")} coverage? Flag it to the Karos team`}
            />
          </div>
        )}
        {noEnginesMeasured && (
          <p className="mt-3 rounded-md border border-info/30 bg-info/10 px-3 py-2 text-xs text-info">
            We couldn&apos;t capture any AI engine answers this run. Your search score and AI
            readiness are unaffected. We&apos;ll retry on the next snapshot.
          </p>
        )}
      </Card>

      {/* 3 · Presence split: the branded-vs-category story + roster share */}
      <Card>
        <CardTitle className="mb-1">Do buyers find you?</CardTitle>
        <p className="mb-4 text-xs text-muted-2">
          Whether AI engines name you when buyers ask by name versus when they ask open category
          questions.
        </p>
        <div className="grid gap-4 sm:grid-cols-2">
          {[presence.brand, presence.category].map((tile) => (
            <div key={tile.heading} className="rounded-md border border-border bg-surface-2 p-3">
              <div className="flex items-center gap-1.5">
                <p className="text-sm font-medium text-foreground">{tile.heading}</p>
                <InfoTip text={tile.explainer} />
              </div>
              <p className="text-[11px] text-muted-2">{tile.caption}</p>
              {tile.fractionLine ? (
                <>
                  <p className="mt-2 font-mono text-lg font-medium text-foreground">
                    {tile.fractionLine}
                  </p>
                  <Meter pct={tile.pct ?? 0} color="var(--neon)" className="mt-1.5" />
                </>
              ) : (
                <p className="mt-2 text-xs text-muted-2">{tile.emptyLine}</p>
              )}
            </div>
          ))}
        </div>
        {presence.takeaway && <p className="mt-3 text-sm text-muted">{presence.takeaway}</p>}
        {presence.rosterShare && (
          <div className="mt-4 border-t border-border pt-3">
            <div className="flex items-center gap-1.5">
              <p className="font-mono text-[10px] uppercase tracking-[0.08em] text-muted">
                Your share of the conversation
              </p>
              <InfoTip text={presence.rosterShare.explainer} />
            </div>
            <div className="mt-1.5 flex items-center gap-3">
              <span className="font-mono text-lg font-medium text-foreground">
                {presence.rosterShare.value}
              </span>
              <Meter pct={presence.rosterShare.pct} color="var(--neon)" className="flex-1" />
            </div>
            <p className="mt-1 text-[11px] text-muted-2">{presence.rosterShare.caption}</p>
          </div>
        )}
      </Card>

      {/* 4 · Engine-by-engine proof: you vs the SAME competitors the sidebar tracks */}
      <Card>
        <CardTitle className="mb-1">You vs competitors on each AI engine</CardTitle>
        <p className="mb-4 text-xs text-muted-2">
          How often each brand gets named when we ask the engines {insights.categoryPresence.total} real
          buyer question{insights.categoryPresence.total === 1 ? "" : "s"} — excluding the{" "}
          {insights.brandPresence.total} question{insights.brandPresence.total === 1 ? "" : "s"} that name
          you directly, so the comparison is like-for-like.
          {competitorCount === 0 && " No competitors tracked yet · ask us to add some."}
        </p>
        {drift.isStale && (
          <p className="mb-4 rounded-md border border-warning/30 bg-warning/10 px-3 py-2 text-xs text-warning">
            Your tracked competitor list changed since this snapshot.
            {drift.added.length > 0 &&
              ` ${drift.added.join(", ")} ${drift.added.length === 1 ? "is" : "are"} measured on the next snapshot.`}
            {drift.removed.length > 0 &&
              ` ${drift.removed.join(", ")} ${drift.removed.length === 1 ? "is" : "are"} no longer tracked and hidden from the comparison.`}
          </p>
        )}
        {measuredEngines.length > 0 && (
          <div className="grid gap-4 lg:grid-cols-3">
            {measuredEngines.map((view) => (
              <EngineCard key={view.engine} view={view} />
            ))}
          </div>
        )}
        {unmeasuredEngines.length > 0 && (
          <div className={`grid gap-4 sm:grid-cols-2 ${measuredEngines.length > 0 ? "mt-4" : ""}`}>
            {unmeasuredEngines.map((view) => (
              <UnmeasuredEngineCard key={view.engine} view={view} />
            ))}
          </div>
        )}
      </Card>

      {/* 4b · Brands the engines volunteered that we don't track yet */}
      {discovered.length > 0 && (
        <Card>
          <CardTitle className="mb-1">Also named by the engines</CardTitle>
          <p className="mb-4 text-xs text-muted-2">
            Brands the AI engines brought up on their own that aren&apos;t on your tracked list —
            the strongest candidates for your competitor track. We fold the top ones into your
            competitor pool automatically.
          </p>
          <ul className="space-y-2">
            {discovered.map((d) => (
              <li key={d.name} className="flex items-center justify-between gap-2 text-xs">
                <span className="flex min-w-0 items-center gap-1.5">
                  <BrandFavicon website={d.url} faviconSize={32} className="h-4 w-4 rounded-[3px]" />
                  <span className="truncate text-muted">{d.name}</span>
                </span>
                <span className="shrink-0 whitespace-nowrap font-mono text-[11px] text-muted-2">
                  {d.line}
                </span>
              </li>
            ))}
          </ul>
        </Card>
      )}

      {/* 5 · The prioritized action plan, in the client's language */}
      <Card>
        <CardTitle className="mb-1">What we&apos;re fixing</CardTitle>
        <p className="mb-4 text-xs text-muted-2">Ordered by expected impact on your scores.</p>
        {gaps.length === 0 ? (
          <EmptyState
            icon={<Icon name="CheckCircle2" className="h-6 w-6" />}
            title="Nothing to fix right now"
            description="Every check we measured passed and no tracked competitor out-ranks you in this snapshot. We keep monitoring every run."
          />
        ) : (
          <GapList gaps={gaps} />
        )}
      </Card>

      {/* 6 · Methodology: the exact questions and roster, no black box */}
      <Card>
        <Disclosure summary={`The ${prompts.length} buyer questions we asked`}>
          <ul className="space-y-1.5">
            {prompts.map((p, i) => (
              <li key={`q-${i}`} className="flex items-center justify-between gap-2 text-xs">
                <span className="text-muted">{p.text}</span>
                {p.tagLabel && (
                  <span className="shrink-0 rounded-[4px] border border-border bg-surface-3 px-1.5 py-0.5 font-mono text-[10px] uppercase tracking-[0.08em] text-muted-2">
                    {p.tagLabel}
                  </span>
                )}
              </li>
            ))}
          </ul>
          <div className="mt-3 border-t border-border pt-3">
            <p className="mb-1.5 font-mono text-[10px] uppercase tracking-[0.08em] text-muted-2">
              Who we compare you against
            </p>
            <div className="flex flex-wrap gap-1.5">
              {rosterChips.map((chip, i) => (
                <span
                  key={`${chip.name}-${i}`}
                  className={
                    chip.isClient
                      ? "inline-flex items-center gap-1 rounded-[4px] border border-neon/30 bg-neon/10 px-2 py-0.5 font-mono text-[10px] uppercase tracking-[0.08em] text-neon"
                      : "inline-flex items-center gap-1 rounded-[4px] border border-border bg-surface-3 px-2 py-0.5 font-mono text-[10px] uppercase tracking-[0.08em] text-muted"
                  }
                >
                  <BrandFavicon website={chip.url} faviconSize={32} className="h-3 w-3 rounded-[2px]" />
                  {chip.name}
                  {chip.isClient && <span>(you)</span>}
                  {chip.pending && <span className="text-muted-2">· next snapshot</span>}
                </span>
              ))}
            </div>
          </div>
          {quotedInstead.length > 0 && (
            <div className="mt-3 border-t border-border pt-3">
              <p className="mb-1.5 font-mono text-[10px] uppercase tracking-[0.08em] text-muted-2">
                Who the engines quote as sources
              </p>
              <ul className="space-y-1.5">
                {quotedInstead.slice(0, 8).map((r) => (
                  <li key={r.domain} className="flex items-center gap-2 text-xs">
                    <BrandFavicon website={r.domain} faviconSize={32} className="h-4 w-4 rounded-[3px]" />
                    <span className="min-w-0 flex-1 truncate text-muted">{r.domain}</span>
                    <span className="w-20 shrink-0">
                      <Meter pct={(r.citations / leaderboardMax) * 100} color="var(--info)" />
                    </span>
                    <span className="w-6 shrink-0 text-right font-mono text-[11px] text-muted-2">
                      {r.citations}
                    </span>
                  </li>
                ))}
              </ul>
              <p className="mt-1.5 text-[11px] text-muted-2">
                {clientCitation
                  ? `Your site was cited ${clientCitation.citations} time${clientCitation.citations === 1 ? "" : "s"} across these answers.`
                  : "Your site was never cited as a source this run — earning citations from these domains' territory is what moves the visibility score."}
              </p>
            </div>
          )}
          <p className="mt-3 text-[11px] text-muted-2">
            We ask every engine the same questions on every snapshot so results stay comparable run
            to run.
          </p>
        </Disclosure>
      </Card>

      {/* 7 · Catch-all flag affordance */}
      <div className="flex justify-end">
        <FlagButton
          subject={generic.subject}
          message={generic.message}
          label="Something look off? Flag it to the Karos team"
        />
      </div>
    </div>
  );
}
