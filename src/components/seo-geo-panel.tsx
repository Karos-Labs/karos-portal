import Link from "next/link";
import { Card, CardTitle, StatCard, Badge, EmptyState } from "@/components/ui";
import { Icon } from "@/components/icon";
import type { SeoGeoInsights } from "@/lib/seo-geo";
import {
  ENGINE_LABELS,
  INTENT_LABELS,
  type ActionKind,
  type CellState,
  type PerEngineVisibility,
  type ProviderSource,
  type QuestionRow,
  type RecImpact,
  type SeoGeoInsights,
} from "@/lib/seo-geo";

/**
 * SEO & GEO insights panel (SCRUM-52 redesign). Server component: all domain
 * markup renders here from presenter view-models; interactivity lives in the
 * small client leaves (disclosure, gap list, flag dialog). Everything a client
 * reads is plain English by construction — internal run-record vocabulary is
 * mapped (never echoed) in seo-geo/presenter.ts, which is unit-tested for leaks.
 */

function ProviderBadge({ source }: { source: ProviderSource | null }) {
  if (!source) return <Badge tone="neutral">no connector</Badge>;
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

/* ── Action-plan controls (dev-handoff §3b) ── */

const IMPACT_TONES: Record<RecImpact, "danger" | "warning" | "neutral"> = {
  high: "danger",
  medium: "warning",
  low: "neutral",
};

const ACTION_KIND_META: Record<ActionKind, { label: string; icon: string }> = {
  one_click: { label: "Apply via agent", icon: "Zap" },
  review_approve: { label: "Review & approve", icon: "PenLine" },
  connect: { label: "Connect", icon: "Plug" },
  guided_manual: { label: "Guided steps", icon: "ListChecks" },
};

/** Every plan item has a control (dev-handoff §3b). guided_manual is advisory (no link). */
function controlHref(clientId: string, actionKind: ActionKind): string | null {
  if (actionKind === "guided_manual") return null;
  return actionKind === "connect" ? `/clients/${clientId}/settings` : `/clients/${clientId}/agents`;
}

/* ── Answer grid (per-question × per-engine, matching the report's matrix) ── */

const CELL_META: Record<CellState, { glyph: string; color: string; title: string }> = {
  named_first: { glyph: "●", color: "var(--neon)", title: "named first among competitors" },
  named: { glyph: "●", color: "var(--foreground)", title: "named in the answer" },
  cited_not_named: { glyph: "◍", color: "var(--warning)", title: "cited as a source but not named (ghost citation)" },
  absent: { glyph: "○", color: "var(--muted-2)", title: "absent from the answer" },
  unavailable: { glyph: "·", color: "var(--muted-2)", title: "engine not measured this run" },
};

function AnswerGrid({ grid, engines }: { grid: QuestionRow[]; engines: string[] }) {
  return (
    <div className="overflow-x-auto">
      <table className="w-full border-collapse text-xs">
        <thead>
          <tr className="text-muted-2">
            <th className="py-1 pr-2 text-left font-medium">Intent</th>
            <th className="py-1 pr-3 text-left font-medium">Question</th>
            {engines.map((e) => (
              <th key={e} className="px-1 py-1 text-center font-medium">
                {ENGINE_LABELS[e as keyof typeof ENGINE_LABELS] ?? e}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {grid.map((row, i) => (
            <tr key={i} className="border-t border-border">
              <td className="py-1 pr-2">
                <span className="font-mono text-[10px] text-muted-2">{INTENT_LABELS[row.intent]}</span>
              </td>
              <td className="max-w-[22ch] truncate py-1 pr-3 text-muted" title={row.prompt}>
                {row.prompt}
              </td>
              {row.cells.map((cell) => {
                const meta = CELL_META[cell.state];
                return (
                  <td key={cell.engine} className="px-1 py-1 text-center" title={`${cell.engine}: ${meta.title}`}>
                    <span style={{ color: meta.color }}>{meta.glyph}</span>
                  </td>
                );
              })}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

/** Horizontal comparative bars: client vs competitors mentions on one engine. */
function EngineShareChart({ engine }: { engine: PerEngineVisibility }) {
  const max = Math.max(1, ...engine.brandMentions.map((b) => b.mentions));
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

  const capturedDate = new Date(insights.capturedAt).toISOString().slice(0, 10);
  const engines = insights.perEngine.filter((e) => e.source !== null || e.promptsTotal > 0);
  // Client-facing action plan (dev-handoff §3b). Old docs pre-dating recommendations[] fall back to [].
  const recommendations = insights.recommendations ?? [];
  // Defensive defaults: insight docs captured before the PDF-contract fields existed
  // won't carry these keys, so fall back rather than crash.
  const answerGrid = insights.answerGrid ?? [];
  const gridEngines = answerGrid[0]?.cells.map((c) => c.engine) ?? [];
  const citationLeaderboard = insights.citationLeaderboard ?? [];
  const cs = insights.citationSummary ?? {
    totalMeasuredAnswers: 0,
    answersCited: 0,
    answersNamed: 0,
    ghostCitations: 0,
  };
  // Trend: previous visibility index + delta (dev-handoff §3a).
  const vh = insights.visibilityHistory ?? [];
  const visPrev = vh.length >= 2 ? vh[vh.length - 2] : null;
  const visDelta = visPrev !== null ? insights.geoVisibilityIndex - visPrev : null;

  return (
    <div className="space-y-6">
      {/* Headline scores (measured-only per the grade rule) */}
      <div className="grid grid-cols-2 gap-4 lg:grid-cols-4">
        <StatCard
          label="SEO score"
          value={<span style={{ color: scoreColor(insights.seoScore) }}>{insights.seoScore}</span>}
          hint={`of 100 · coverage ${insights.seoDataCoveragePct}%`}
        />
        <StatCard
          label="GEO readiness"
          value={<span style={{ color: scoreColor(insights.geoReadiness) }}>{insights.geoReadiness}</span>}
          hint={`of 100 · coverage ${insights.geoReadinessCoveragePct}%`}
        />
        <StatCard
          label="GEO visibility"
          value={
            <span style={{ color: scoreColor(insights.geoVisibilityIndex) }}>
              {insights.geoVisibilityIndex}
              {visDelta !== null && (
                <span className="ml-1.5 align-middle text-xs font-medium" style={{ color: visDelta >= 0 ? "var(--success)" : "var(--danger)" }}>
                  {visDelta >= 0 ? "+" : ""}
                  {visDelta}
                </span>
              )}
            </span>
          }
          hint={visPrev !== null ? `was ${visPrev} · coverage ${insights.geoVisibilityCoveragePct}%` : `of 100 · coverage ${insights.geoVisibilityCoveragePct}%`}
        />
        <StatCard label="Captured" value={capturedDate} hint={`${insights.promptSet.length} buyer-intent prompts`} />
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

      {/* Answer grid — per-question × per-engine (the report's central matrix) */}
      {answerGrid.length > 0 && (
        <Card>
          <CardTitle className="mb-1">Where you rank in AI answers</CardTitle>
          <p className="mb-3 text-xs text-muted-2">
            Each cell is one answer.{" "}
            <span style={{ color: "var(--neon)" }}>●</span> named first ·{" "}
            <span style={{ color: "var(--foreground)" }}>●</span> named ·{" "}
            <span style={{ color: "var(--warning)" }}>◍</span> cited, not named ·{" "}
            <span style={{ color: "var(--muted-2)" }}>○</span> absent ·{" "}
            <span style={{ color: "var(--muted-2)" }}>·</span> not measured
          </p>
          <AnswerGrid grid={answerGrid} engines={gridEngines} />
        </Card>
      )}

      {/* Citation leaderboard + ghost summary */}
      {citationLeaderboard.length > 0 && (
        <Card>
          <CardTitle className="mb-1">Who the engines quote</CardTitle>
          <p className="mb-3 text-xs text-muted-2">
            Cited domains across all measured answers. You were cited in {cs.answersCited}/{cs.totalMeasuredAnswers}{" "}
            answers, named in {cs.answersNamed} — {cs.ghostCitations} ghost citation
            {cs.ghostCitations === 1 ? "" : "s"} to convert.
          </p>
          <ul className="space-y-1.5">
            {citationLeaderboard.map((r) => {
              const max = Math.max(1, ...citationLeaderboard.map((x) => x.citations));
              return (
                <li key={r.domain}>
                  <div className="mb-0.5 flex items-center justify-between text-xs">
                    <span className={r.isClient ? "font-semibold text-foreground" : "text-muted"}>
                      {r.domain}
                      {r.isClient && <span className="ml-1 text-[10px] text-muted-2">(you)</span>}
                    </span>
                    <span className="font-mono text-muted-2">{r.citations}</span>
                  </div>
                  <div className="h-1.5 overflow-hidden rounded-sm bg-surface-3">
                    <div
                      className="h-full rounded-sm"
                      style={{ width: `${(r.citations / max) * 100}%`, background: r.isClient ? "var(--neon)" : "var(--info)" }}
                    />
                  </div>
                </li>
              );
            })}
          </ul>
        </Card>
      )}

      {/* Action plan — client-facing recommendations[] (dev-handoff §3b). Renders ONLY
          impact + vertical + title + a control per action_kind; every internal producer
          field (fix_action, delivery, confidence, evidence, target, id) is excluded by
          construction (§4). Each item's control links to the agent/credential that executes it. */}
      <Card>
        <CardTitle className="mb-1">Action plan</CardTitle>
        <p className="mb-4 text-xs text-muted-2">
          What to improve, ordered by impact. Each item is executed by the Karos agent that owns it.
        </p>
        {recommendations.length === 0 ? (
          <EmptyState
            icon={<Icon name="CheckCircle2" className="h-6 w-6" />}
            title="No open recommendations"
            description="Every measured check passed and no competitor out-ranks this brand in the capture."
          />
        ) : (
          <ul className="space-y-2">
            {recommendations.map((r, i) => {
              const control = ACTION_KIND_META[r.actionKind];
              const href = controlHref(insights.clientId, r.actionKind);
              return (
                <li
                  key={`${r.recId}-${i}`}
                  className="flex flex-wrap items-center justify-between gap-2 rounded-md border border-border bg-surface-2 px-3 py-2"
                  style={{ borderLeft: `3px solid ${IMPACT_TONES[r.impact] === "danger" ? "var(--danger)" : IMPACT_TONES[r.impact] === "warning" ? "var(--warning)" : "var(--muted-2)"}` }}
                >
                  <div className="flex min-w-0 flex-wrap items-center gap-1.5">
                    <Badge tone={IMPACT_TONES[r.impact]}>{r.impact}</Badge>
                    <Badge tone="neutral">{r.vertical}</Badge>
                    <span className="text-sm font-medium text-foreground">{r.title}</span>
                  </div>
                  {href ? (
                    <Link
                      href={href}
                      className="inline-flex shrink-0 items-center gap-1 rounded-md border border-border bg-surface px-2.5 py-1 text-xs font-medium text-foreground transition-colors hover:bg-surface-3"
                    >
                      <Icon name={control.icon} className="h-3 w-3" />
                      {control.label}
                    </Link>
                  ) : (
                    <span className="inline-flex shrink-0 items-center gap-1 rounded-md px-2.5 py-1 text-xs text-muted-2">
                      <Icon name={control.icon} className="h-3 w-3" />
                      {control.label}
                    </span>
                  )}
                </li>
              );
            })}
          </ul>
          <div className="mt-3 border-t border-border pt-3">
            <p className="mb-1.5 font-mono text-[10px] uppercase tracking-[0.08em] text-muted-2">
              Who we compare you against
            </p>
            <div className="flex flex-wrap gap-1.5">
              {insights.roster.map((name, i) => (
                <span
                  key={`${name}-${i}`}
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
