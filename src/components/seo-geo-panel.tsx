import { Card, CardTitle, EmptyState } from "@/components/ui";
import { Icon } from "@/components/icon";
import type { SeoGeoInsights } from "@/lib/seo-geo";
import {
  buildContextLine,
  buildEngineViews,
  buildGapViews,
  buildPresence,
  buildPromptViews,
  buildScoreViews,
  engineFlagPrefill,
  formatCaptured,
  genericFlagPrefill,
  type EngineView,
  type ScoreView,
  type Tone,
} from "@/components/seo-geo/presenter";
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

const TONE_COLORS: Record<Tone, string> = {
  success: "var(--success)",
  warning: "var(--warning)",
  danger: "var(--danger)",
  info: "var(--info)",
  neutral: "var(--muted-2)",
};

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

function StatusBadge({ label, tone }: { label: string; tone: Tone }) {
  const tones: Record<Tone, string> = {
    success: "bg-success/10 text-success border-success/30",
    warning: "bg-warning/10 text-warning border-warning/30",
    danger: "bg-danger/10 text-danger border-danger/30",
    info: "bg-info/10 text-info border-info/30",
    neutral: "bg-surface-3 text-muted border-border",
  };
  return (
    <span
      className={`inline-flex items-center gap-1 rounded-[4px] border px-2 py-0.5 font-mono text-[10px] font-medium uppercase tracking-[0.08em] ${tones[tone]}`}
    >
      {label}
    </span>
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
        <p className="mt-1.5 font-mono text-2xl font-medium text-muted-2">—</p>
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
                  {row.pct !== null && <span className="font-mono text-foreground">{row.pct}</span>}
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
    <span className="group relative inline-flex items-center gap-1.5 rounded-md border border-border bg-surface-2 px-2 py-1">
      <span className="text-xs text-foreground">{view.name}</span>
      <StatusBadge label={view.statusLabel} tone={view.statusTone} />
      <span
        role="tooltip"
        className="pointer-events-none absolute bottom-full left-0 z-20 mb-2 w-56 rounded-md border border-border bg-surface-3 px-2.5 py-2 text-left text-[11px] leading-relaxed text-foreground opacity-0 shadow-lg transition-opacity group-hover:opacity-100 motion-reduce:transition-none"
      >
        {view.explainer}
      </span>
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
        <StatusBadge label={view.statusLabel} tone={view.statusTone} />
      </div>
      {view.allZero ? (
        <p className="text-xs text-muted-2">
          No brands were named in {view.name}&apos;s answers this run.
        </p>
      ) : (
        <ul className="space-y-2">
          {view.brands.map((b) => (
            <li key={b.name}>
              <div className="mb-0.5 flex items-center justify-between gap-2 text-xs">
                <span className={b.isClient ? "font-semibold text-foreground" : "text-muted"}>
                  {b.name}
                  {b.isClient && <span className="ml-1 text-[10px] text-muted-2">(you)</span>}
                </span>
                <span className="whitespace-nowrap font-mono text-[11px] text-muted-2">{b.line}</span>
              </div>
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
            </li>
          ))}
        </ul>
      )}
      <div className="mt-2 flex flex-wrap gap-x-4 gap-y-1 text-[11px]">
        {view.stats.map((s) => (
          <span key={s.label} className="inline-flex items-center gap-1 text-muted-2">
            {s.label}: <span className="font-mono text-foreground">{s.value}</span>
            <InfoTip text={s.explainer} />
          </span>
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

function UnmeasuredEngineCard({ view, insights }: { view: EngineView; insights: SeoGeoInsights }) {
  const prefill =
    view.status === "not-wired"
      ? engineFlagPrefill(view.name, insights)
      : {
          subject: `Question about ${view.name} in our AI visibility snapshot`,
          message: `${view.name} shows "no answers this run" on our dashboard (snapshot ${formatCaptured(insights.capturedAt)}). Can you take a look?`,
        };
  return (
    <div className="rounded-md border border-dashed border-border p-3">
      <div className="mb-1.5 flex flex-wrap items-center justify-between gap-2">
        <span className="text-sm font-medium text-muted">{view.name}</span>
        <StatusBadge label={view.statusLabel} tone={view.statusTone} />
      </div>
      <p className="text-xs text-muted-2">{view.causeLine}</p>
      <div className="mt-2">
        <FlagButton subject={prefill.subject} message={prefill.message} />
      </div>
    </div>
  );
}

/* ── Panel ───────────────────────────────────────────────────────── */

export function SeoGeoPanel({ insights }: { insights: SeoGeoInsights | null }) {
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
  const engines = buildEngineViews(insights);
  const presence = buildPresence(insights);
  const gaps = buildGapViews(insights.gaps, insights.clientId);
  const prompts = buildPromptViews(insights);
  const generic = genericFlagPrefill(insights);

  const measuredEngines = engines.filter((e) => e.status === "measured");
  const unmeasuredEngines = engines.filter((e) => e.status !== "measured");
  const unwiredNames = engines.filter((e) => e.status === "not-wired").map((e) => e.name);
  const competitorCount = Math.max(0, insights.roster.length - 1);
  const noEnginesMeasured = measuredEngines.length === 0;

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
              subject={`Request: measure ${unwiredNames.join(" and ")} in our AI visibility snapshot`}
              message={`We'd like ${unwiredNames.join(" and ")} added to our AI visibility snapshot (snapshot ${formatCaptured(insights.capturedAt)}).`}
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

      {/* 4 · Engine-by-engine proof: you vs competitors, nothing hidden */}
      <Card>
        <CardTitle className="mb-1">You vs competitors on each AI engine</CardTitle>
        <p className="mb-4 text-xs text-muted-2">
          How often each brand gets named when we ask the engines {insights.promptSet.length} real
          buyer questions.
          {competitorCount === 0 && " No competitors tracked yet · ask us to add some."}
        </p>
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
              <UnmeasuredEngineCard key={view.engine} view={view} insights={insights} />
            ))}
          </div>
        )}
      </Card>

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
            {prompts.map((p) => (
              <li key={p.text} className="flex items-center justify-between gap-2 text-xs">
                <span className="text-muted">{p.text}</span>
                <span className="shrink-0 rounded-[4px] border border-border bg-surface-3 px-1.5 py-0.5 font-mono text-[10px] uppercase tracking-[0.08em] text-muted-2">
                  {p.tagLabel}
                </span>
              </li>
            ))}
          </ul>
          <div className="mt-3 border-t border-border pt-3">
            <p className="mb-1.5 font-mono text-[10px] uppercase tracking-[0.08em] text-muted-2">
              Who we compare you against
            </p>
            <div className="flex flex-wrap gap-1.5">
              {insights.roster.map((name, i) => (
                <span
                  key={name}
                  className={
                    i === 0
                      ? "inline-flex items-center rounded-[4px] border border-neon/30 bg-neon/10 px-2 py-0.5 font-mono text-[10px] uppercase tracking-[0.08em] text-neon"
                      : "inline-flex items-center rounded-[4px] border border-border bg-surface-3 px-2 py-0.5 font-mono text-[10px] uppercase tracking-[0.08em] text-muted"
                  }
                >
                  {name}
                  {i === 0 && <span className="ml-1">(you)</span>}
                </span>
              ))}
            </div>
          </div>
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
