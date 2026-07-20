import Link from "next/link";
import { Card, CardTitle, StatCard, Badge, EmptyState } from "@/components/ui";
import { Icon } from "@/components/icon";
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
 * SEO & GEO insights panel — comparative graphs over the multi-model visibility
 * capture. Every engine column and every gap carries a provenance badge naming
 * the provider that produced the data point (OpenAI / Gemini / Anthropic).
 */

function ProviderBadge({ source }: { source: ProviderSource | null }) {
  if (!source) return <Badge tone="neutral">no connector</Badge>;
  return (
    <Badge tone="info">
      <Icon name="Cpu" className="h-3 w-3" />
      source: {source}
    </Badge>
  );
}

function scoreColor(score: number): string {
  if (score >= 70) return "var(--success)";
  if (score >= 40) return "var(--warning)";
  return "var(--danger)";
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
    <div className="rounded-md border border-border bg-surface-2 p-3">
      <div className="mb-2 flex flex-wrap items-center justify-between gap-2">
        <span className="text-sm font-medium text-foreground">{ENGINE_LABELS[engine.engine]}</span>
        <div className="flex items-center gap-1.5">
          <ProviderBadge source={engine.source} />
          <Badge tone={engine.captureTier === "UNAVAILABLE" ? "neutral" : "neon"}>
            {engine.captureTier === "MEASURED_grounded" ? "measured · grounded" : engine.captureTier.toLowerCase()}
          </Badge>
        </div>
      </div>
      {engine.captureTier === "UNAVAILABLE" || engine.promptsMeasured === 0 ? (
        <p className="text-xs text-muted-2">
          No measured answers this run{engine.source ? "" : " — engine connector not wired yet"}.
        </p>
      ) : (
        <>
          <ul className="space-y-2">
            {engine.brandMentions.map((b) => (
              <li key={b.name}>
                <div className="mb-0.5 flex items-center justify-between text-xs">
                  <span className={b.isClient ? "font-semibold text-foreground" : "text-muted"}>
                    {b.name}
                    {b.isClient && <span className="ml-1 text-[10px] text-muted-2">(client)</span>}
                  </span>
                  <span className="font-mono text-muted-2">
                    {b.mentions}/{engine.promptsMeasured}
                  </span>
                </div>
                <div className="h-2 overflow-hidden rounded-sm bg-surface-3">
                  <div
                    className="h-full rounded-sm"
                    style={{
                      width: `${(b.mentions / max) * 100}%`,
                      background: b.isClient ? "var(--neon)" : "var(--info)",
                      opacity: b.isClient ? 1 : 0.55,
                    }}
                  />
                </div>
              </li>
            ))}
          </ul>
          <div className="mt-2 flex flex-wrap gap-x-4 gap-y-1 text-[11px] text-muted-2">
            <span>Share of voice: <span className="font-mono text-foreground">{Math.round(engine.shareOfVoice)}%</span></span>
            <span>Cited as source: <span className="font-mono text-foreground">{Math.round(engine.citationRate * 100)}%</span></span>
            <span>Ranked first: <span className="font-mono text-foreground">{Math.round(engine.firstPositionRate * 100)}%</span></span>
          </div>
        </>
      )}
    </div>
  );
}

export function SeoGeoPanel({ insights }: { insights: SeoGeoInsights | null }) {
  if (!insights) {
    return (
      <Card>
        <CardTitle className="mb-4">Search &amp; AI visibility</CardTitle>
        <EmptyState
          icon={<Icon name="Radar" className="h-6 w-6" />}
          title="No SEO/GEO capture yet"
          description="Run the Intel Report pipeline to audit the site and measure how AI answer engines (ChatGPT, Gemini, Claude) talk about this brand vs its competitors."
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

      {/* Per-engine comparative graphs with provider provenance */}
      <Card>
        <div className="mb-1 flex flex-wrap items-center justify-between gap-2">
          <CardTitle>AI answer-engine visibility — client vs competitors</CardTitle>
        </div>
        <p className="mb-4 text-xs text-muted-2">
          How often each brand is named when buyers ask the engines real category questions. Each engine column is
          labeled with the model provider that produced its data.
        </p>
        <div className="grid gap-4 lg:grid-cols-3">
          {engines.map((e) => (
            <EngineShareChart key={e.engine} engine={e} />
          ))}
        </div>
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
        )}
      </Card>
    </div>
  );
}
