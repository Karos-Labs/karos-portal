"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { Card, CardTitle, Badge, Skeleton } from "@/components/ui";
import { Icon } from "@/components/icon";

/**
 * AI Insights — the client-facing readout of the Self-Improving Marketing Loop.
 * Streams a plain-language week-over-week performance briefing (and the
 * optimization moves the engine is making) from /api/clients/[id]/insights, the
 * same way the copilot dock consumes /chat. Mounted in the client dashboard's
 * Performance section.
 */
export function AiInsights({ clientId }: { clientId: string }) {
  const [text, setText] = useState("");
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const abortRef = useRef<AbortController | null>(null);

  // The fetch + stream itself. Every setState here happens after the first
  // `await`, so it's safe to kick off directly from an effect (the
  // set-state-in-effect rule only forbids synchronous updates on mount).
  // `force` bypasses the server's content-based cache — only the explicit
  // "Refresh" click sets it, so a plain page load never re-spends an LLM call
  // on a briefing that hasn't changed.
  const run = useCallback(
    async (controller: AbortController, force: boolean) => {
      try {
        const url = `/api/clients/${clientId}/insights${force ? "?force=1" : ""}`;
        const res = await fetch(url, { signal: controller.signal });
        if (!res.ok) {
          const body = await res.json().catch(() => ({ error: "Request failed" }));
          throw new Error((body as { error?: string }).error ?? `HTTP ${res.status}`);
        }
        const reader = res.body!.getReader();
        const decoder = new TextDecoder();
        let accumulated = "";
        while (true) {
          const { done, value } = await reader.read();
          if (done) break;
          accumulated += decoder.decode(value, { stream: true });
          setText(accumulated);
        }
      } catch (e) {
        if ((e as Error).name === "AbortError") return;
        setError(e instanceof Error ? e.message : "Couldn't load insights.");
      } finally {
        setLoading(false);
      }
    },
    [clientId],
  );

  // Manual refresh (event handler — synchronous resets are fine here). Forces
  // the server to regenerate rather than serve its cached briefing.
  const load = useCallback(() => {
    abortRef.current?.abort();
    const controller = new AbortController();
    abortRef.current = controller;
    setLoading(true);
    setError(null);
    setText("");
    void run(controller, true);
  }, [run]);

  // Initial fetch on mount. State already starts at loading/empty, so no
  // synchronous setState is needed here — just start streaming. Not forced:
  // reuses the cached briefing when nothing's changed since last time.
  useEffect(() => {
    const controller = new AbortController();
    abortRef.current = controller;
    // eslint-disable-next-line react-hooks/set-state-in-effect -- run() only sets state after its first await; starting the stream on mount is intentional
    void run(controller, false);
    return () => controller.abort();
  }, [run]);

  return (
    <Card>
      <div className="mb-4 flex items-center justify-between gap-3">
        <div className="flex items-center gap-2">
          <Icon name="Sparkles" className="h-4 w-4 text-neon" />
          <CardTitle>AI Insights</CardTitle>
          <Badge tone="neon">Beta</Badge>
        </div>
        <button
          type="button"
          onClick={() => void load()}
          disabled={loading}
          className="text-xs text-neon transition-opacity hover:underline disabled:opacity-40"
        >
          {loading ? "Analyzing…" : "Refresh"}
        </button>
      </div>

      {error ? (
        <div className="space-y-2">
          <p className="text-sm text-danger">{error}</p>
          <button
            type="button"
            onClick={() => void load()}
            className="text-xs text-neon hover:underline"
          >
            Try again
          </button>
        </div>
      ) : loading && text === "" ? (
        <div className="space-y-2.5" aria-hidden="true">
          <Skeleton className="h-3 w-1/3" />
          <Skeleton className="h-3 w-full" />
          <Skeleton className="h-3 w-11/12" />
          <Skeleton className="h-3 w-4/5" />
          <Skeleton className="h-3 w-1/4" />
          <Skeleton className="h-3 w-10/12" />
        </div>
      ) : (
        <div className="space-y-1.5 text-sm leading-relaxed text-muted">
          {renderBriefing(text)}
          {loading && <span className="ml-0.5 inline-block h-3.5 w-1.5 animate-pulse-neon bg-neon align-middle" />}
        </div>
      )}
    </Card>
  );
}

/* ── Minimal, dependency-free markdown rendering ─────────────────────── */
/* The briefing uses only **bold** headers and "- " / "• " bullets — render
   those safely as React nodes (no dangerouslySetInnerHTML). */

function renderInline(line: string, keyPrefix: string): React.ReactNode[] {
  // Split on **bold** spans, keeping the delimited groups.
  return line.split(/(\*\*[^*]+\*\*)/g).filter(Boolean).map((part, i) => {
    if (part.startsWith("**") && part.endsWith("**")) {
      return (
        <strong key={`${keyPrefix}-${i}`} className="font-medium text-foreground">
          {part.slice(2, -2)}
        </strong>
      );
    }
    return <span key={`${keyPrefix}-${i}`}>{part}</span>;
  });
}

function renderBriefing(text: string): React.ReactNode {
  const lines = text.split("\n");
  return lines.map((raw, i) => {
    const line = raw.trimEnd();
    if (line.trim() === "") return <div key={i} className="h-1.5" />;
    const bullet = /^\s*[-•]\s+/.test(line);
    if (bullet) {
      const content = line.replace(/^\s*[-•]\s+/, "");
      return (
        <div key={i} className="flex gap-2">
          <span className="mt-[3px] text-neon">•</span>
          <span className="flex-1">{renderInline(content, `l${i}`)}</span>
        </div>
      );
    }
    return <p key={i}>{renderInline(line, `l${i}`)}</p>;
  });
}
