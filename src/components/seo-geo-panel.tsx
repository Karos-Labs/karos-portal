import { Badge, Card, CardTitle, EmptyState } from "@/components/ui";
import { Icon } from "@/components/icon";
import { BrandFavicon } from "@/components/brand-favicon";
import type { SeoGeoInsights } from "@/lib/seo-geo";
import {
  buildAnswerGridViews,
  buildCaptureStrip,
  buildDiscoveredViews,
  buildEngineViews,
  buildGapViews,
  buildCitationView,
  buildIntentPromptViews,
  buildMeasurementBasis,
  buildQuestionPlanLine,
  healRecommendations,
  buildPresence,
  buildPromptViews,
  buildRosterChips,
  buildRosterDrift,
  buildRosterSanity,
  buildScoreViews,
  buildSnapshotTrust,
  capturedNothing,
  formatPrompt,
  genericFlagPrefill,
  type AnswerCellView,
  type AnswerGridView,
  type EngineView,
  type ScoreView,
  type TrackedCompetitorRef,
} from "@/components/seo-geo/presenter";
import { TONE_COLORS } from "@/components/seo-geo/tones";
import { Disclosure } from "@/components/seo-geo/disclosure";
import { FlagButton } from "@/components/seo-geo/flag-button";
import { GapList } from "@/components/seo-geo/gap-list";
import { ScorePopover } from "@/components/seo-geo/score-popover";
import { SeoGeoActionPlan } from "@/components/seo-geo-action-plan";

/**
 * SEO & GEO insights panel (SCRUM-52 redesign). Server component: all domain
 * markup renders here from presenter view-models; interactivity lives in the
 * small client leaves (disclosure, gap list, flag dialog). Everything a client
 * reads is plain English by construction - internal run-record vocabulary is
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

/** One matrix cell: a dot carrying its plain-English outcome as accessible text. */
function AnswerDot({ mark, tone, label }: { mark: AnswerCellView["mark"]; tone: string; label: string }) {
  const color = TONE_COLORS[tone as keyof typeof TONE_COLORS] ?? "var(--muted-3)";
  return (
    <span className="inline-flex items-center justify-center" title={label}>
      <span className="sr-only">{label}</span>
      {mark === "none" ? (
        <span aria-hidden className="text-[11px] text-muted-2">
          &ndash;
        </span>
      ) : (
        <span
          aria-hidden
          className="block h-2.5 w-2.5 rounded-full"
          style={
            mark === "solid"
              ? { background: color }
              : mark === "ring"
                ? { border: `2px solid ${color}` }
                : { border: "1px solid var(--border)" }
          }
        />
      )}
    </span>
  );
}

/**
 * The per-question × per-engine matrix (QA F12) - the exhibit behind every
 * aggregate on the page. Horizontally scrollable in its own container so it never
 * pushes the page sideways.
 */
function AnswerGrid({ view }: { view: AnswerGridView }) {
  return (
    <div>
      <div className="overflow-x-auto">
        <table className="w-full min-w-[420px] border-collapse text-xs">
          <thead>
            <tr>
              <th className="py-1.5 pr-3 text-left font-mono text-[10px] font-normal uppercase tracking-[0.08em] text-muted-2">
                Question
              </th>
              {view.engines.map((e) => (
                <th
                  key={e.engine}
                  className="px-2 py-1.5 text-center font-mono text-[10px] font-normal uppercase tracking-[0.08em] text-muted-2"
                >
                  {e.name}
                </th>
              ))}
            </tr>
          </thead>
          {/* One tbody per intent group (F18): the questions carry a five-way
              taxonomy the pipeline already persists, and the old flat dump threw
              that hierarchy away. */}
          {view.groups.map((group) => (
            <tbody key={group.intentLabel}>
              <tr>
                <th
                  colSpan={view.engines.length + 1}
                  className="border-t border-border pb-1 pt-3 text-left font-mono text-[10px] font-normal uppercase tracking-[0.08em] text-muted-2"
                >
                  {group.intentLabel}
                  {/* CD-J1 bounce 2c: which side of the plan this block sits on.
                      "Comparison" and "Problem" are both category questions, and
                      nothing said which groups feed the competitor comparison. */}
                  {group.basisLabel && (
                    <span className="ml-1.5 normal-case text-muted-3">· {group.basisLabel}</span>
                  )}
                </th>
              </tr>
              {group.rows.map((row, i) => (
                <tr key={`${row.prompt}-${i}`} className="border-t border-border">
                  <td className="py-1.5 pr-3 align-middle text-muted">{row.displayText}</td>
                  {row.cells.map((cell) => (
                    <td key={cell.engine} className="px-2 py-1.5 text-center align-middle">
                      <AnswerDot mark={cell.mark} tone={cell.tone} label={`${cell.engineName}: ${cell.label}`} />
                    </td>
                  ))}
                </tr>
              ))}
            </tbody>
          ))}
        </table>
      </div>
      <div className="mt-2 flex flex-wrap items-center gap-x-3 gap-y-1.5 text-[11px] text-muted-2">
        {view.legend.map((l) => (
          <span key={l.label} className="inline-flex items-center gap-1.5">
            <AnswerDot mark={l.mark} tone={l.tone} label={l.label} />
            <span aria-hidden>{l.label}</span>
          </span>
        ))}
        <span className="inline-flex items-center gap-1.5">
          <AnswerDot mark="none" tone="neutral" label="Not measured" />
          <span aria-hidden>Not measured</span>
        </span>
      </div>
    </div>
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
        <Meter pct={view.coveragePct} color="var(--muted-3)" />
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
                  <BrandFavicon website={b.url} name={b.name} faviconSize={32} className="h-4 w-4 rounded-[3px]" />
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

/* ── Liftable sections (QA F99/F124) ─────────────────────────────────
   The headline scores and the action plan are the two things a client
   reacts to, and inside the full panel they sat four and six screens down.
   They render here by default; the client dashboard mounts them above the
   fold and passes hideScores/hidePlan so nothing is shown twice. */

export function SeoGeoScores({ insights }: { insights: SeoGeoInsights }) {
  const scores = buildScoreViews(insights);
  const trust = buildSnapshotTrust(insights);
  return (
    <div className="space-y-6">
      {/* CD-B4: say it once, above the numbers, when this snapshot was produced
          by a measurement setup we've since replaced - rather than presenting
          superseded maths as the client's position today. It travels WITH the
          scores: lifting the tiles above the fold must not leave the warning
          behind in a collapsed section. */}
      {trust.isLegacy && (
        <div className="rounded-md border border-warning/30 bg-warning/10 px-3.5 py-2.5">
          <p className="flex items-center gap-1.5 text-sm font-medium text-warning">
            <Icon name="TriangleAlert" className="h-4 w-4 shrink-0" />
            {trust.title}
          </p>
          <p className="mt-1 text-xs text-muted">{trust.description}</p>
        </div>
      )}
      <div className="grid grid-cols-1 gap-4 @xl:grid-cols-2 @4xl:grid-cols-3">
        {scores.map((view) => (
          <ScoreTile key={view.key} view={view} />
        ))}
      </div>
    </div>
  );
}

/**
 * The prioritized action plan, in the client's language. The client-facing
 * `recommendations[]` (plain-English title + what it entails + owner, each row
 * with a real Approve control that persists and posts to the activity timeline)
 * is the primary view - `gaps[]` is documented INTERNAL and is demoted to a
 * staff-only technical disclosure (dev-handoff §3b/§4, QA Fix 6/7).
 */
export function SeoGeoPlan({
  insights,
  isClientViewer = false,
}: {
  insights: SeoGeoInsights;
  isClientViewer?: boolean;
}) {
  const trust = buildSnapshotTrust(insights);
  const gaps = buildGapViews(insights.gaps, insights.clientId);
  // `?? []` covers snapshots captured before the plan existed. The copy is
  // re-resolved through today's REC_COPY here, at the server boundary (CD-J1
  // bounce 1): the plan was frozen at capture, so older snapshots still carry the
  // raw engineering labels the copy table exists to replace. Ids are stable, so
  // this heals them without a re-capture - and doing it here, rather than in the
  // client leaf, keeps those labels out of the RSC payload entirely.
  // The approvals ride along for one reason only (AF-11): when two rec ids heal
  // to identical copy they collapse to one row, and the row has to keep the id
  // the client already approved, or a collapsed pair reads as un-approved work.
  const recommendations = healRecommendations(insights.recommendations ?? [], {
    approvedRecIds: insights.approvedRecIds ?? [],
  });
  return (
    <Card>
      <CardTitle className="mb-1">What we&apos;re fixing</CardTitle>
      <p className="mb-4 text-xs text-muted-2">
        Ordered by expected impact on your scores. Approve an item and your Karos team executes it.
      </p>
      {trust.planPending ? (
        <EmptyState
          icon={<Icon name="Radar" className="h-6 w-6" />}
          title="Your action plan lands on the next refresh"
          description="We measured this snapshot but haven't written its plan yet. Your next visibility refresh will list the actions here."
        />
      ) : (
        <SeoGeoActionPlan
          clientId={insights.clientId}
          recommendations={recommendations}
          approvedRecIds={insights.approvedRecIds ?? []}
        />
      )}
      {!isClientViewer && gaps.length > 0 && (
        <Disclosure
          className="mt-4 border-t border-border pt-3"
          summary={`Technical detail. The ${gaps.length} measured gap${gaps.length === 1 ? "" : "s"} behind this plan (staff only)`}
        >
          <GapList gaps={gaps} />
        </Disclosure>
      )}
    </Card>
  );
}

/* ── Panel ───────────────────────────────────────────────────────── */

export function SeoGeoPanel({
  insights,
  trackedCompetitors,
  clientWebsite,
  isClientViewer = false,
  intelScheduleEnabled = false,
  intelScheduleNextRunAt = null,
  isRefreshing = false,
  hideScores = false,
  hidePlan = false,
}: {
  insights: SeoGeoInsights | null;
  /** The CURRENT tracked-5 (same selector as the sidebar) - keeps every panel
   *  surface side-by-side with the Competitor Track instead of the frozen
   *  snapshot roster. */
  trackedCompetitors?: TrackedCompetitorRef[];
  /** Client website - drives the client's own favicon in the comparison rows. */
  clientWebsite?: string | null;
  /** True when the viewer is the client. Gates the internal gap list, which
   *  `SeoGeoInsights.gaps` is explicitly documented as never being rendered raw
   *  to a client (dev-handoff §4). */
  isClientViewer?: boolean;
  /** Whether a recurring refresh will actually fire (QA F20). The report promises
   *  a "next snapshot" throughout; without this the panel cannot say whether one
   *  is ever coming. */
  intelScheduleEnabled?: boolean;
  intelScheduleNextRunAt?: number | null;
  /** A refresh run holds the workspace lock right now - rendered in place on the
   *  capture strip instead of leaving a stale snapshot looking current. */
  isRefreshing?: boolean;
  /** QA F99/F124: the client dashboard lifts the headline scores and the action
   *  plan out of this panel so they sit above the fold instead of five screens
   *  down. Both default to rendering here, so every other call site (and the
   *  staff dashboard) is unchanged. */
  hideScores?: boolean;
  hidePlan?: boolean;
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

  const engines = buildEngineViews(insights, trackedCompetitors, clientWebsite);
  const presence = buildPresence(insights);
  // CD-B4's snapshot-trust view (was this produced by the current pipeline? does
  // it carry a written plan?) is read by SeoGeoScores and SeoGeoPlan, which own
  // the two surfaces that report it.
  const prompts = buildPromptViews(insights);
  // Grouped under plain-English intent headings (F18) - the fallback list for
  // snapshots with no persisted answer grid.
  const promptGroups = buildIntentPromptViews(insights);
  // QA F12: the per-question × per-engine matrix the pipeline has been computing and
  // persisting on every run since SCRUM-52, read by no component until now. It is the
  // exhibit behind every aggregate above; without it the "no black box" claim on this
  // card is unsupported. Null on pre-grid snapshots - the flat list stays the fallback.
  const answerGrid = buildAnswerGridViews(insights);
  const generic = genericFlagPrefill(insights);
  const citationLeaderboard = insights.citationLeaderboard ?? [];

  // QA F23: the AI capture rejected and the pipeline substituted an empty probe
  // set, empty prompt set and a one-name roster. Without this guard the panel
  // renders its full scaffolding against those zeros - "0 real buyer questions",
  // "excluding the 0 questions that name you directly", and a disclosure labelled
  // "The 0 buyer questions we asked" that opens onto an empty box. That reads like
  // the product is broken, when one leg of one run degraded.
  const captureFailed = capturedNothing(insights);

  // QA F20: age, staleness tone, in-place refresh state, and the real "next
  // snapshot" date (or the ask-us-to-schedule route when none will ever fire).
  const strip = buildCaptureStrip(insights, {
    scheduleEnabled: intelScheduleEnabled,
    nextRunAt: intelScheduleNextRunAt,
    refreshing: isRefreshing,
  });

  const measuredEngines = engines.filter((e) => e.status === "measured");
  const unmeasuredEngines = engines.filter((e) => e.status !== "measured");
  // An EMPTY tracked list with a legacy snapshot still renders snapshot rows, so
  // fall back to the snapshot roster count rather than announcing "no competitors".
  const competitorCount = trackedCompetitors?.length
    ? trackedCompetitors.length
    : Math.max(0, insights.roster.length - 1);
  const noEnginesMeasured = measuredEngines.length === 0;

  // Live-vs-snapshot roster drift (QA Fix 1): the comparison follows the CURRENT
  // tracked list; this banner explains what changed since the capture.
  const drift = buildRosterDrift(insights, trackedCompetitors);
  const discovered = buildDiscoveredViews(insights, trackedCompetitors);
  const rosterChips = buildRosterChips(insights, trackedCompetitors, clientWebsite);
  // Staff-only roster verdict (CD-J1 directive 4); null when there is nothing to
  // say - nobody tracked, or no measured answers to check a roster against.
  const rosterSanity = buildRosterSanity(insights, trackedCompetitors);
  // What this snapshot's comparison numbers are actually measured over. A legacy
  // record's figures cover every question; the copy must say so rather than
  // relabel them "category" (CD-J1 bounce 2b).
  const basis = buildMeasurementBasis(insights);
  const questionPlanLine = buildQuestionPlanLine(insights);

  // Citation leaderboard split (QA Fix 5): "who's quoted instead of you" vs your own baseline.
  const quotedInstead = citationLeaderboard.filter((r) => !r.isClient);
  const leaderboardMax = Math.max(1, ...quotedInstead.map((x) => x.citations));

  // QA F133: ONE definition of "cited" for the whole client-facing report.
  // This sentence used to count raw citation OCCURRENCES across ALL captured
  // answers ("cited 11 times") while the fix card a screen above counted the
  // ANSWER RATE across category answers ("cited in 0% of category answers") -
  // two numbers for the same measurement, both stated as fact, reading as the
  // report contradicting itself. Both surfaces now use the engine cards' unit
  // and scope: answers cited, out of measured category answers.
  // Scope-correct and absent-aware (CD-J1 bounce 2b/3), built in the presenter so
  // it is pinned by a test rather than assembled inline here.
  const citation = buildCitationView(insights);

  return (
    <div className="space-y-6">
      {/* 0/1 · CD-B4's legacy-snapshot notice and the headline scores, rendered
          together by SeoGeoScores: the warning qualifies these numbers, so when
          the client dashboard lifts the tiles above the fold the warning has to
          go with them rather than stay behind in a collapsed section. */}
      {!hideScores && <SeoGeoScores insights={insights} />}

      {/* 2 · Where we looked: the "N of 5 engines" disclosure, all engines visible */}
      <Card>
        <p
          className="font-mono text-[11px]"
          style={{ color: strip.tone === "warning" ? TONE_COLORS.warning : "var(--muted)" }}
        >
          {strip.line}
        </p>
        {/* QA F20: an in-place refreshing state, so a stale snapshot never sits
            there looking current while a run is rewriting it. */}
        {strip.refreshing && (
          <p className="mt-1.5 inline-flex items-center gap-1.5 text-[11px] text-neon">
            <Icon name="Loader" className="h-3 w-3 animate-spin" />
            Refreshing this snapshot now. The numbers below are the previous run.
          </p>
        )}
        {!strip.refreshing && strip.nextLine && (
          <p className="mt-1.5 text-[11px] text-muted-2">{strip.nextLine}</p>
        )}
        {/* The report promises a "next snapshot" throughout, and for a client whose
            schedule was never switched on, one never comes. Say so, and give them
            the existing route to ask for one. */}
        {!strip.refreshing && strip.scheduleFlagPrefill && (
          <div className="mt-1.5 flex flex-wrap items-center gap-2">
            <span className="text-[11px] text-muted-2">{strip.noScheduleLine}</span>
            <FlagButton
              subject={strip.scheduleFlagPrefill.subject}
              message={strip.scheduleFlagPrefill.message}
              label="Ask us to schedule refreshes"
            />
          </div>
        )}
        <div className="mt-3 flex flex-wrap items-center gap-2">
          {engines.map((view) => (
            <EngineChip key={view.engine} view={view} />
          ))}
        </div>
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
          questions. Click a score to see how it was measured. Only the category side feeds your
          comparison against competitors. Being named in a question about you isn&apos;t
          visibility.
        </p>
        <div className="grid gap-4 @xl:grid-cols-2">
          {[presence.brand, presence.category].map((tile) => (
            <div key={tile.heading} className="rounded-md border border-border bg-surface-2 p-3">
              <div className="flex items-center gap-1.5">
                <p className="text-sm font-medium text-foreground">{tile.heading}</p>
                <InfoTip text={tile.explainer} />
              </div>
              <p className="text-[11px] text-muted-2">{tile.caption}</p>
              {/* CD-J1 directive 2: the headline is the percentage; the counts it
                  was computed from are one click away, in sentences. */}
              {tile.pctLabel ? (
                <>
                  <div className="mt-2">
                    <ScorePopover
                      value={tile.pctLabel}
                      title={tile.detail.title}
                      lines={tile.detail.lines}
                      srLabel={`${tile.heading}: ${tile.pctLabel}. See how this was measured.`}
                    />
                  </div>
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
              {/* Basis stated in the caption below and in this explainer: category
                  questions only (CD-J1 directive 3). */}
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

      {/* 4 · Engine-by-engine proof: you vs the SAME competitors the sidebar tracks.
          Suppressed entirely on a degraded run (F23): its subtitle interpolates
          three counts that are all zero, and the no-engines banner on the capture
          strip above already explains what happened. */}
      {!captureFailed && (
      <Card>
        <CardTitle className="mb-1">You vs competitors on each AI engine</CardTitle>
        {/* CD-J1 directive 3: name the basis in the subline. Every number in this
            section is measured on category questions only - a question that
            contains your name names you by construction, so counting those would
            hand you a lead over every competitor before an engine said anything. */}
        <p className="mb-4 text-xs text-muted-2">
          {basis.categoryScoped ? "Measured on category questions only. " : ""}
          How often each brand gets named when we ask the engines{" "}
          {insights.categoryPresence.total} real buyer question
          {insights.categoryPresence.total === 1 ? "" : "s"}, and the{" "}
          {insights.brandPresence.total} question{insights.brandPresence.total === 1 ? "" : "s"} that
          name{insights.brandPresence.total === 1 ? "s" : ""} you directly{" "}
          {insights.brandPresence.total === 1 ? "is" : "are"} left out, so the comparison is
          like-for-like.
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
          <div className="grid gap-4 @2xl:grid-cols-2 @4xl:grid-cols-3">
            {measuredEngines.map((view) => (
              <EngineCard key={view.engine} view={view} />
            ))}
          </div>
        )}
        {unmeasuredEngines.length > 0 && (
          <div className={`grid gap-4 @xl:grid-cols-2 ${measuredEngines.length > 0 ? "mt-4" : ""}`}>
            {unmeasuredEngines.map((view) => (
              <UnmeasuredEngineCard key={view.engine} view={view} />
            ))}
          </div>
        )}
      </Card>
      )}

      {/* 4b · Brands the engines volunteered that we don't track yet */}
      {discovered.length > 0 && (
        <Card>
          <CardTitle className="mb-1">Also named by the engines</CardTitle>
          <p className="mb-4 text-xs text-muted-2">
            Brands the AI engines brought up on their own that aren&apos;t on your tracked list,
            the strongest candidates for your competitor track. We fold the top ones into your
            competitor pool automatically.
          </p>
          <ul className="space-y-2">
            {discovered.map((d) => (
              <li key={d.name} className="flex items-center justify-between gap-2 text-xs">
                <span className="flex min-w-0 items-center gap-1.5">
                  <BrandFavicon website={d.url} name={d.name} faviconSize={32} className="h-4 w-4 rounded-[3px]" />
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

      {/* 5 · The prioritized action plan, in the client's language. */}
      {!hidePlan && <SeoGeoPlan insights={insights} isClientViewer={isClientViewer} />}

      {/* 6 · Methodology (QA F18): three named sections, three Cards. These used to
          be one Card whose only affordance was a collapsed row labelled "The 20
          buyer questions we asked" - so the competitor roster and the citation
          leaderboard, both named sections of this report, were children of a
          disclosure that didn't mention them and was closed by default. A client
          asking "who are you comparing me to?" could never find the answer. */}
      {/* F23: no disclosure inviting a click that opens onto an empty box. */}
      {!captureFailed && (
      <Card>
        <Disclosure summary={`The ${prompts.length} questions we asked`}>
          {answerGrid ? (
            <>
              <p className="mb-2 text-xs text-muted-2">
                What each engine did with each question this run.
              </p>
              <AnswerGrid view={answerGrid} />
            </>
          ) : (
            <div className="space-y-3">
              {promptGroups.map((group, gi) => (
                <div key={group.intentLabel || `g-${gi}`}>
                  {group.intentLabel && (
                    <p className="mb-1 font-mono text-[10px] uppercase tracking-[0.08em] text-muted-2">
                      {group.intentLabel}
                      {group.basisLabel && (
                        <span className="ml-1.5 normal-case text-muted-3">· {group.basisLabel}</span>
                      )}
                    </p>
                  )}
                  <ul className="space-y-1.5">
                    {group.prompts.map((p, i) => (
                      <li key={`q-${gi}-${i}`} className="flex items-center justify-between gap-2 text-xs">
                        <span className="text-muted">{formatPrompt(p.text)}</span>
                        {p.tagLabel && (
                          <span className="inline-flex shrink-0 items-center gap-1 rounded-[4px] border border-border bg-surface-3 px-1.5 py-0.5 font-mono text-[10px] uppercase tracking-[0.08em] text-muted-2">
                            {p.tagLabel}
                            {p.tagExplainer && <InfoTip text={p.tagExplainer} />}
                          </span>
                        )}
                      </li>
                    ))}
                  </ul>
                </div>
              ))}
            </div>
          )}
          {/* CD-J1 bounce 2c: state the split in words. The branded count appeared
              nowhere on screen before this - the page showed a category total and a
              grand total and left the client to subtract. */}
          <p className="mt-3 text-[11px] text-muted-2">
            {questionPlanLine} We ask every engine the same questions on every snapshot so results
            stay comparable run to run.
          </p>
        </Disclosure>
      </Card>
      )}

      <Card>
        <CardTitle className="mb-1">Who we compare you against</CardTitle>
        <p className="mb-3 text-xs text-muted-2">
          The brands your visibility is measured against on every snapshot.
        </p>
        {/* CD-J1 directive 4 - STAFF ONLY. A roster of never-named brands makes
            every comparison above honest and meaningless at once: bars at zero
            against opponents who aren't in the race. The client cannot tell that
            apart from "you're losing", so the team gets told instead. A suggestion,
            never an action - the roster is an account decision and nothing here
            mutates it. */}
        {!isClientViewer && rosterSanity && (
          <div className="mb-3 rounded-md border border-warning/30 bg-warning/10 px-3 py-2">
            <p className="flex items-start gap-1.5 text-xs font-medium text-warning">
              <Icon name="TriangleAlert" className="mt-px h-3.5 w-3.5 shrink-0" />
              {rosterSanity.headline}
            </p>
            <p className="mt-1 text-[11px] text-muted">{rosterSanity.detail}</p>
          </div>
        )}
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
              <BrandFavicon website={chip.url} name={chip.name} faviconSize={32} className="h-3 w-3 rounded-[2px]" />
              {chip.name}
              {chip.isClient && <span>(you)</span>}
              {chip.pending && <span className="text-muted-2">· next snapshot</span>}
            </span>
          ))}
        </div>
      </Card>

      {/* QA F19: this Card is NOT gated on there being citations. The client's own
          citation sentence used to be nested inside a `quotedInstead.length > 0`
          check, so the single most important line in the section - your site was
          never cited, and earning citations is what moves the score - was exactly
          the line that could not render when there were no citations at all. The
          zero state deleted its own explanation while the engine cards above kept
          saying "cited as a source: 0 of 14" with nothing to explain it.
          It IS suppressed on a degraded run (F23) - there were no answers to
          count citations across, and the capture-strip banner says so. */}
      {!captureFailed && (
      <Card>
        <CardTitle className="mb-1">Who the engines quote as sources</CardTitle>
        {quotedInstead.length > 0 ? (
          <>
            {/* The bars count citations, the sentence below counts answers - say
                which is which, so two honest numbers don't read as a contradiction. */}
            <p className="mb-3 text-xs text-muted-2">
              How many times each of these {quotedInstead.length} domains was cited across the{" "}
              {basis.answers} we measured.
            </p>
            {/* Every row the data layer returns - the old hard `.slice(0, 8)` against
                a limit of 12 dropped up to four competitor source domains with no
                count, no "show all", and no hint there were more. */}
            <ul className="space-y-1.5">
              {quotedInstead.map((r) => (
                <li key={r.domain} className="flex items-center gap-2 text-xs">
                  <BrandFavicon website={r.domain} name={r.domain} faviconSize={32} className="h-4 w-4 rounded-[3px]" />
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
          </>
        ) : (
          <p className="mb-1 text-xs text-muted-2">
            {/* CD-J1 bounce 3: don't report a measured absence when the snapshot
                simply predates the data. */}
            {citation.emptyLine}
          </p>
        )}
        <p className="mt-2 text-[11px] text-muted-2">{citation.clientLine}</p>
      </Card>
      )}

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
