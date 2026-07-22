import { Card, CardTitle, StatCard, Badge, EmptyState } from "@/components/ui";
import { Icon } from "@/components/icon";
import { SeoGeoActionPlan } from "@/components/seo-geo-action-plan";
import {
  ENGINE_LABELS,
  INTENT_LABELS,
  type CellState,
  type EngineId,
  type PerEngineVisibility,
  type ProviderSource,
  type QuestionRow,
  type SeoGeoInsights,
} from "@/lib/seo-geo";

/**
 * SEO & GEO insights panel — the client-facing "Search & AI visibility" analytics
 * section. Every engine column carries the provider that produced it. Nothing internal
 * (fix_action, confidence, evidence, …) is rendered here (a3 dev-handoff §4).
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

/** Uppercase the first letter only — preserves brand names/acronyms mid-string (QA Fix 9). */
function sentenceCase(s: string): string {
  const t = s.trim();
  return t ? t.charAt(0).toUpperCase() + t.slice(1) : t;
}

/* ── Answer grid (per-question × per-engine, matching the report's matrix) ── */

const CELL_META: Record<CellState, { glyph: string; color: string; title: string }> = {
  named_first: { glyph: "●", color: "var(--neon)", title: "named first among competitors" },
  named: { glyph: "●", color: "var(--foreground)", title: "named in the answer" },
  cited_not_named: { glyph: "◍", color: "var(--warning)", title: "cited as a source but not named (ghost citation)" },
  absent: { glyph: "○", color: "var(--muted-2)", title: "absent from the answer" },
  unavailable: { glyph: "·", color: "var(--muted-2)", title: "engine not measured this run" },
};

/** Rows tinted/grouped so brand & navigational questions read differently from category (QA Fix 4). */
const INTENT_ROW_TINT: Record<string, string> = {
  brand: "var(--info)",
  navigational: "var(--info)",
};

function AnswerGrid({ grid, engines }: { grid: QuestionRow[]; engines: EngineId[] }) {
  const engineSet = new Set(engines);
  return (
    <div className="overflow-x-auto">
      <table className="w-full border-collapse text-xs">
        <thead>
          <tr className="text-muted-2">
            <th className="py-1 pr-2 text-left font-medium">Intent</th>
            <th className="py-1 pr-3 text-left font-medium">Question</th>
            {engines.map((e) => (
              <th key={e} className="px-1 py-1 text-center font-medium">
                {ENGINE_LABELS[e]}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {grid.map((row, i) => (
            <tr key={i} className="border-t border-border">
              <td className="py-1 pr-2">
                <span
                  className="font-mono text-[10px]"
                  style={{ color: INTENT_ROW_TINT[row.intent] ?? "var(--muted-2)" }}
                >
                  {INTENT_LABELS[row.intent]}
                </span>
              </td>
              <td className="max-w-[26ch] truncate py-1 pr-3 text-muted" title={sentenceCase(row.prompt)}>
                {sentenceCase(row.prompt)}
              </td>
              {row.cells
                .filter((cell) => engineSet.has(cell.engine))
                .map((cell) => {
                  const meta = CELL_META[cell.state];
                  return (
                    <td key={cell.engine} className="px-1 py-1 text-center" title={`${ENGINE_LABELS[cell.engine]}: ${meta.title}`}>
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

/**
 * Client-vs-competitor bars for one engine, computed on CATEGORY questions only (QA Fix 2)
 * — brand/nav prompts name the client and would inflate it to a meaningless 100%.
 */
function EngineShareChart({ engine }: { engine: PerEngineVisibility }) {
  // Docs captured before the category split fall back to the top-level (all-measured) metrics.
  const cat = engine.category ?? {
    promptsMeasured: engine.promptsMeasured,
    mentionRate: engine.mentionRate,
    citationRate: engine.citationRate,
    firstPositionRate: engine.firstPositionRate,
    shareOfVoice: engine.shareOfVoice,
    netSentiment: engine.netSentiment,
    ghostCitationRate: engine.ghostCitationRate,
    topCompetitor: engine.topCompetitor,
    brandMentions: engine.brandMentions,
  };
  const brandNamed = engine.brandNamed ?? 0;
  const brandPromptsMeasured = engine.brandPromptsMeasured ?? 0;
  const max = Math.max(1, ...cat.brandMentions.map((b) => b.mentions));
  const anyCategoryMention = cat.brandMentions.some((b) => b.mentions > 0);
  const unavailable = engine.captureTier === "UNAVAILABLE" || engine.promptsMeasured === 0;

  return (
    <div className="rounded-md border border-border bg-surface-2 p-3">
      <div className="mb-2 flex flex-wrap items-center justify-between gap-2">
        <span className="text-sm font-medium text-foreground">{ENGINE_LABELS[engine.engine]}</span>
        <div className="flex items-center gap-1.5">
          <ProviderBadge source={engine.source} />
          <Badge tone={unavailable ? "neutral" : "neon"}>
            {engine.captureTier === "MEASURED_grounded" ? "measured · grounded" : engine.captureTier.toLowerCase()}
          </Badge>
        </div>
      </div>

      {unavailable ? (
        <p className="text-xs text-muted-2">
          No measured answers this run{engine.source ? "" : " — engine connector not wired yet"}.
        </p>
      ) : !anyCategoryMention ? (
        <p className="text-xs text-muted-2">
          No brand — yours or tracked competitors — was named on the {cat.promptsMeasured} category questions.
          {brandPromptsMeasured > 0 && (
            <>
              {" "}
              On brand questions you were named {brandNamed}/{brandPromptsMeasured}.
            </>
          )}
        </p>
      ) : (
        <>
          <ul className="space-y-2">
            {cat.brandMentions.map((b) => (
              <li key={b.name}>
                <div className="mb-0.5 flex items-center justify-between text-xs">
                  <span className={b.isClient ? "font-semibold text-foreground" : "text-muted"}>
                    {b.name}
                    {b.isClient && <span className="ml-1 text-[10px] text-muted-2">(you)</span>}
                  </span>
                  <span className="font-mono text-muted-2">
                    {b.mentions}/{cat.promptsMeasured}
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
            <span>
              Share of voice: <span className="font-mono text-foreground">{Math.round(cat.shareOfVoice)}%</span>
            </span>
            <span>
              Cited as source: <span className="font-mono text-foreground">{Math.round(cat.citationRate * 100)}%</span>
            </span>
            <span>
              Ranked first: <span className="font-mono text-foreground">{Math.round(cat.firstPositionRate * 100)}%</span>
            </span>
          </div>
          <p className="mt-1 text-[10px] text-muted-2">
            On {cat.promptsMeasured} category questions · brand questions named {brandNamed}/{brandPromptsMeasured}
          </p>
        </>
      )}
    </div>
  );
}

export function SeoGeoPanel({
  insights,
  trackedCompetitors,
}: {
  insights: SeoGeoInsights | null;
  /** Current tracked competitor display names (from the sidebar selector) — used to warn
   *  when the frozen snapshot's roster no longer matches (QA Fix 1). */
  trackedCompetitors?: string[];
}) {
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

  // Old docs pre-dating these fields fall back rather than crash.
  const recommendations = insights.recommendations ?? [];
  const answerGrid = insights.answerGrid ?? [];
  const citationLeaderboard = insights.citationLeaderboard ?? [];
  const cs = insights.citationSummary ?? { totalMeasuredAnswers: 0, answersCited: 0, answersNamed: 0, ghostCitations: 0 };

  // Grid columns: measured engines only (QA Fix 3) — drop the permanently "not measured"
  // Perplexity/Copilot columns and the legend entry that only existed to explain them.
  const measuredEngineIds = new Set(
    insights.perEngine.filter((e) => e.captureTier !== "UNAVAILABLE").map((e) => e.engine),
  );
  const gridEngines = ((answerGrid[0]?.cells ?? []).map((c) => c.engine) as EngineId[]).filter((e) =>
    measuredEngineIds.has(e),
  );

  // Trend delta (dev-handoff §3a).
  const vh = insights.visibilityHistory ?? [];
  const visPrev = vh.length >= 2 ? vh[vh.length - 2] : null;
  const visDelta = visPrev !== null ? insights.geoVisibilityIndex - visPrev : null;

  // Stale-roster warning (QA Fix 1): snapshot roster vs the current tracked list.
  const snapshotCompetitors = insights.roster.slice(1); // roster[0] is the client
  const rosterStale =
    !!trackedCompetitors &&
    trackedCompetitors.length > 0 &&
    (snapshotCompetitors.length !== trackedCompetitors.length ||
      trackedCompetitors.some((c) => !snapshotCompetitors.includes(c)));

  // Citation leaderboard split (QA Fix 5): "who's quoted instead of you" vs your own baseline.
  const clientCitation = citationLeaderboard.find((r) => r.isClient) ?? null;
  const quotedInstead = citationLeaderboard.filter((r) => !r.isClient);
  const leaderboardMax = Math.max(1, ...quotedInstead.map((x) => x.citations));

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
                <span
                  className="ml-1.5 align-middle text-xs font-medium"
                  style={{ color: visDelta >= 0 ? "var(--success)" : "var(--danger)" }}
                >
                  {visDelta >= 0 ? "+" : ""}
                  {visDelta}
                </span>
              )}
            </span>
          }
          hint={
            visPrev !== null
              ? `was ${visPrev} · ${insights.geoVisibilityEnginesMeasured ?? 0} engines measured`
              : `of 100 · ${insights.geoVisibilityEnginesMeasured ?? 0} engines measured`
          }
        />
        <StatCard label="Captured" value={capturedDate} hint={`${insights.promptSet.length} buyer-intent prompts`} />
      </div>

      {rosterStale && (
        <p className="rounded-md border border-warning/30 bg-warning/10 px-3 py-2 text-xs text-warning">
          <Icon name="TriangleAlert" className="mr-1 inline h-3 w-3" />
          Snapshot from {capturedDate} — the tracked competitor list has changed since. Regenerate the Intel Report to refresh this section.
        </p>
      )}

      {/* Per-engine comparative graphs with provider provenance */}
      <Card>
        <div className="mb-1 flex flex-wrap items-center justify-between gap-2">
          <CardTitle>AI answer-engine visibility — you vs tracked competitors</CardTitle>
          <span className="text-[11px] text-muted-2">measured {capturedDate}</span>
        </div>
        <p className="mb-4 text-xs text-muted-2">
          How often each brand is named on the category questions buyers actually ask (brand and navigational prompts
          excluded, so the comparison is like-for-like). Each column is labeled with the model provider that produced it.
        </p>
        <div className="grid gap-4 lg:grid-cols-3">
          {engines.map((e) => (
            <EngineShareChart key={e.engine} engine={e} />
          ))}
        </div>
      </Card>

      {/* Answer grid — per-question × per-engine, measured engines only */}
      {answerGrid.length > 0 && gridEngines.length > 0 && (
        <Card>
          <CardTitle className="mb-1">Where you rank in AI answers</CardTitle>
          <p className="mb-3 text-xs text-muted-2">
            Each cell is one answer.{" "}
            <span style={{ color: "var(--neon)" }}>●</span> named first ·{" "}
            <span style={{ color: "var(--foreground)" }}>●</span> named ·{" "}
            <span style={{ color: "var(--warning)" }}>◍</span> cited, not named ·{" "}
            <span style={{ color: "var(--muted-2)" }}>○</span> absent. Brand &amp; nav rows (tinted intent tag) name you
            by design — read the category rows for market reality.
          </p>
          <AnswerGrid grid={answerGrid} engines={gridEngines} />
        </Card>
      )}

      {/* Who the engines quote INSTEAD of you (QA Fix 5) */}
      {quotedInstead.length > 0 && (
        <Card>
          <CardTitle className="mb-1">Who the engines quote instead</CardTitle>
          <p className="mb-3 text-xs text-muted-2">
            Domains the engines cited as sources on answers where you were <strong>not</strong> the named brand — the
            sources to get into.{" "}
            <span
              title="A ghost citation is when an engine cites your page as a source but doesn't name your brand in the answer — you did the work, a competitor (or no one) gets the credit."
              className="cursor-help underline decoration-dotted underline-offset-2"
            >
              What&apos;s a ghost citation?
            </span>
          </p>
          <ul className="space-y-1.5">
            {quotedInstead.map((r) => (
              <li key={r.domain}>
                <div className="mb-0.5 flex items-center justify-between text-xs">
                  <span className="text-muted">{r.domain}</span>
                  <span className="font-mono text-muted-2">{r.citations}</span>
                </div>
                <div className="h-1.5 overflow-hidden rounded-sm bg-surface-3">
                  <div
                    className="h-full rounded-sm"
                    style={{ width: `${(r.citations / leaderboardMax) * 100}%`, background: "var(--info)" }}
                  />
                </div>
              </li>
            ))}
          </ul>
          <p className="mt-3 border-t border-border pt-2 text-[11px] text-muted-2">
            Your baseline: cited in {cs.answersCited} of {cs.totalMeasuredAnswers} answers, named in {cs.answersNamed}
            {clientCitation ? ` (${clientCitation.domain})` : ""} · {cs.ghostCitations} ghost citation
            {cs.ghostCitations === 1 ? "" : "s"} to convert into named recommendations.
          </p>
        </Card>
      )}

      {/* Action plan — client-facing recommendations[] (dev-handoff §3b/§4, QA Fix 6/7).
          Plain-English title + what-it-entails + owner line, each with a real Approve
          control (persists + logs; no navigation dead end). Rendered by a client component. */}
      <Card>
        <CardTitle className="mb-1">Action plan</CardTitle>
        <p className="mb-4 text-xs text-muted-2">
          What to improve, ordered by impact. Approve an item and your Karos team executes it.
        </p>
        <SeoGeoActionPlan
          clientId={insights.clientId}
          recommendations={recommendations}
          approvedRecIds={insights.approvedRecIds ?? []}
        />
      </Card>
    </div>
  );
}
