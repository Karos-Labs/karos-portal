import { Card, CardTitle, StatCard, Badge, EmptyState } from "@/components/ui";
import { Icon } from "@/components/icon";
import {
  ENGINE_LABELS,
  type GapSeverity,
  type PerEngineVisibility,
  type ProviderSource,
  type SeoGeoInsights,
} from "@/lib/seo-geo";

/**
 * SEO & GEO insights panel — comparative graphs over the multi-model visibility
 * capture. Every engine column and every gap carries a provenance badge naming
 * the provider that produced the data point (OpenAI / Gemini / Anthropic).
 */

const SEVERITY_COLORS: Record<GapSeverity, string> = {
  critical: "var(--danger)",
  high: "var(--warning)",
  medium: "var(--info)",
  low: "var(--muted-2)",
};

const SEVERITY_TONES: Record<GapSeverity, "danger" | "warning" | "info" | "neutral"> = {
  critical: "danger",
  high: "warning",
  medium: "info",
  low: "neutral",
};

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
  const topGaps = insights.gaps.slice(0, 8);

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
          value={<span style={{ color: scoreColor(insights.geoVisibilityIndex) }}>{insights.geoVisibilityIndex}</span>}
          hint={`of 100 · coverage ${insights.geoVisibilityCoveragePct}%`}
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

      {/* Gap analysis */}
      <Card>
        <CardTitle className="mb-1">Search-visibility gaps</CardTitle>
        <p className="mb-4 text-xs text-muted-2">
          Computed from the measured client-vs-competitor data, ordered by potential score lift.
        </p>
        {topGaps.length === 0 ? (
          <EmptyState
            icon={<Icon name="CheckCircle2" className="h-6 w-6" />}
            title="No measured gaps"
            description="Every measured check passed and no competitor out-ranks this brand in the capture."
          />
        ) : (
          <ul className="space-y-2">
            {topGaps.map((g, i) => (
              <li
                key={`${g.id}-${i}`}
                className="rounded-md border border-border bg-surface-2 px-3 py-2"
                style={{ borderLeft: `3px solid ${SEVERITY_COLORS[g.severity]}` }}
              >
                <div className="flex flex-wrap items-center gap-1.5">
                  <Badge tone={SEVERITY_TONES[g.severity]}>{g.severity}</Badge>
                  <Badge tone="neutral">{g.lever}</Badge>
                  {g.fixAction !== "manual" && <Badge tone="neutral">fix: {g.fixAction}</Badge>}
                  {g.source && <ProviderBadge source={g.source} />}
                  <span className="text-sm font-medium text-foreground">{g.title}</span>
                </div>
                <p className="mt-1 text-xs text-muted">
                  {g.measured}
                  <span className="text-muted-2"> · goal: {g.benchmark} · {g.delivery} · confidence: {g.confidence}</span>
                </p>
              </li>
            ))}
          </ul>
        )}
      </Card>
    </div>
  );
}
