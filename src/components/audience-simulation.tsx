"use client";

import { useCallback, useRef, useState } from "react";
import { Button, Badge, Skeleton, EmptyState } from "@/components/ui";
import { Icon } from "@/components/icon";
// Type-only import — erased at compile time, so the server-only engine never
// reaches the client bundle.
import type { PersonaSimulationResult } from "@/lib/simulation-engine";

/** How many skeleton cards to show while the panel runs (matches MAX_PERSONAS). */
const SKELETON_COUNT = 4;

type Sentiment = "positive" | "neutral" | "negative";

/** Judgment-scale colors keyed to the 1–10 score band. */
function scoreBand(score: number): { color: string; label: string } {
  if (score <= 4) return { color: "var(--danger)", label: "Weak" };
  if (score <= 6) return { color: "var(--warning)", label: "Mixed" };
  return { color: "var(--success)", label: "Strong" };
}

const SENTIMENT_META: Record<Sentiment, { tone: "success" | "warning" | "danger"; icon: string }> = {
  positive: { tone: "success", icon: "TrendingUp" },
  neutral: { tone: "warning", icon: "Minus" },
  negative: { tone: "danger", icon: "TrendingDown" },
};

/**
 * Audience Simulation panel — runs the asset's artifact past the synthetic
 * persona panel on demand and renders each verdict with a color-coded score
 * bar, sentiment indicator, and the raw qualitative critique. Handles the
 * parallel run with a graceful skeleton grid and isolates per-persona failures.
 */
export function AudienceSimulation({ clientId, assetId }: { clientId: string; assetId: string }) {
  const [results, setResults] = useState<PersonaSimulationResult[] | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  // A ref (not state) so a double-click within the same render pass — before
  // `loading` re-renders the button away — still can't fire a second request.
  const runningRef = useRef(false);

  const run = useCallback(async () => {
    if (runningRef.current) return;
    runningRef.current = true;
    setLoading(true);
    setError(null);
    try {
      const res = await fetch(`/api/clients/${clientId}/simulate`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ assetId }),
      });
      if (!res.ok) {
        const body = await res.json().catch(() => ({ error: "Request failed" }));
        throw new Error((body as { error?: string }).error ?? `HTTP ${res.status}`);
      }
      const data = (await res.json()) as { results: PersonaSimulationResult[] };
      setResults(data.results);
    } catch (e) {
      setError(e instanceof Error ? e.message : "Simulation failed. Try again.");
    } finally {
      runningRef.current = false;
      setLoading(false);
    }
  }, [clientId, assetId]);

  // Intro state — nothing run yet.
  if (!results && !loading && !error) {
    return (
      <EmptyState
        icon={<Icon name="Users" className="h-6 w-6" />}
        title="Pre-flight audience simulation"
        description="Test this content against 2–4 distinct stakeholder personas (for example: buyers, strategists, skeptics, or competitors) before you publish."
        action={
          <Button size="sm" onClick={() => void run()}>
            <Icon name="Sparkles" className="h-3.5 w-3.5" />
            Run simulation
          </Button>
        }
      />
    );
  }

  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between gap-3">
        <div className="flex items-center gap-2">
          <Icon name="Users" className="h-4 w-4 text-neon" />
          <p className="text-sm font-medium text-foreground">Synthetic persona panel</p>
        </div>
        {!loading && (
          <button
            type="button"
            onClick={() => void run()}
            className="inline-flex items-center gap-1 text-xs text-neon transition-opacity hover:underline"
          >
            <Icon name="RefreshCw" className="h-3 w-3" />
            Re-run
          </button>
        )}
      </div>

      {error && !loading ? (
        <div className="space-y-2 rounded-md border border-danger/30 bg-danger/10 p-3">
          <p className="text-sm text-danger">{error}</p>
          <button type="button" onClick={() => void run()} className="text-xs text-neon hover:underline">
            Try again
          </button>
        </div>
      ) : null}

      <div className="grid gap-3 sm:grid-cols-2">
        {loading
          ? Array.from({ length: SKELETON_COUNT }).map((_, i) => <PersonaSkeleton key={i} />)
          : results?.map((r) => <PersonaCard key={r.personaId} result={r} />)}
      </div>

      {!loading && results && results.length > 0 && (
        <p className="flex items-start gap-1.5 text-[11px] text-muted-2">
          <Icon name="Info" className="mt-0.5 h-3 w-3 shrink-0" />
          Simulated reactions from AI personas - directional signal to refine before publishing, not a guarantee of real-world results.
        </p>
      )}
    </div>
  );
}

function PersonaCard({ result }: { result: PersonaSimulationResult }) {
  if (result.error || !result.verdict) {
    return (
      <div className="rounded-md border border-border bg-surface-2 p-3">
        <p className="text-sm font-medium text-foreground">{result.personaName}</p>
        <p className="mt-0.5 text-[11px] text-muted-2">{result.archetype}</p>
        <p className="mt-1 text-[11px] text-muted">Perspective: {result.perspective}</p>
        <p className="mt-2 flex items-center gap-1.5 text-xs text-muted">
          <Icon name="TriangleAlert" className="h-3.5 w-3.5 text-warning" />
          Couldn&apos;t get a reading from this persona.
        </p>
        {result.error && <p className="mt-1 text-[11px] text-muted-2">{result.error}</p>}
      </div>
    );
  }

  const { score, sentiment, critique, actionableSuggestion } = result.verdict;
  const band = scoreBand(score);
  const sent = SENTIMENT_META[sentiment];

  return (
    <div className="flex flex-col gap-2.5 rounded-md border border-border bg-surface-2 p-3">
      {/* Header */}
      <div className="flex items-start justify-between gap-2">
        <div className="min-w-0">
          <p className="truncate text-sm font-medium text-foreground">{result.personaName}</p>
          <p className="truncate text-[11px] text-muted-2">{result.archetype}</p>
          <p className="mt-0.5 line-clamp-2 text-[11px] text-muted">Perspective: {result.perspective}</p>
        </div>
        <div className="flex shrink-0 items-baseline gap-0.5 font-mono" style={{ color: band.color }}>
          <span className="text-xl font-semibold leading-none">{score}</span>
          <span className="text-[10px] text-muted-2">/10</span>
        </div>
      </div>

      {/* Score bar */}
      <div>
        <div className="h-1.5 w-full overflow-hidden rounded-full bg-surface-3">
          <div
            className="h-full rounded-full transition-all"
            style={{ width: `${score * 10}%`, backgroundColor: band.color }}
          />
        </div>
        <div className="mt-1.5 flex items-center gap-1.5">
          <Badge tone={sent.tone}>
            <Icon name={sent.icon} className="h-3 w-3" />
            {sentiment}
          </Badge>
          <span className="font-mono text-[10px] uppercase tracking-[0.08em]" style={{ color: band.color }}>
            {band.label}
          </span>
        </div>
      </div>

      {/* Critique */}
      <p className="text-xs leading-relaxed text-muted">{critique}</p>
      {result.painPoints.length > 0 && (
        <div className="space-y-1">
          <p className="text-[10px] font-mono uppercase tracking-[0.08em] text-muted-2">Pain points</p>
          <ul className="space-y-1 text-xs text-muted">
            {result.painPoints.slice(0, 3).map((pain) => (
              <li key={pain} className="flex items-start gap-1.5">
                <span className="mt-0.5 shrink-0 text-muted-2">•</span>
                <span>{pain}</span>
              </li>
            ))}
          </ul>
        </div>
      )}
      <div className="rounded-md border border-border bg-surface-3/60 p-2">
        <p className="text-[10px] font-mono uppercase tracking-[0.08em] text-muted-2">Actionable next step</p>
        <p className="mt-1 text-xs text-foreground/90">{actionableSuggestion}</p>
      </div>
    </div>
  );
}

function PersonaSkeleton() {
  return (
    <div className="flex flex-col gap-2.5 rounded-md border border-border bg-surface-2 p-3">
      <div className="flex items-start justify-between gap-2">
        <div className="min-w-0 flex-1 space-y-1.5">
          <Skeleton className="h-3.5 w-2/3" />
          <Skeleton className="h-2.5 w-1/2" />
        </div>
        <Skeleton className="h-6 w-8" />
      </div>
      <Skeleton className="h-1.5 w-full" />
      <div className="space-y-1.5">
        <Skeleton className="h-2.5 w-full" />
        <Skeleton className="h-2.5 w-11/12" />
        <Skeleton className="h-2.5 w-3/4" />
      </div>
    </div>
  );
}
