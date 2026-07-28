"use client";

import Link from "next/link";
import { useCallback, useEffect, useRef, useState } from "react";
import { Card, CardTitle, Badge, EmptyState, Skeleton } from "@/components/ui";
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
  // Demo-data flag (QA Fix 8): the insights API sets X-Insights-Data-Source: mock when the
  // engagement figures are deterministic mock metrics (no live social token). Badge it so a
  // client never mistakes demo numbers for real performance.
  const [isDemoData, setIsDemoData] = useState(false);
  // QA F125: the API refuses to narrate mock engagement figures to a client and answers
  // X-Insights-State: needs-connection instead. Render the connect-a-channel empty state
  // rather than any prose — a warning badge doesn't make invented budget advice safe.
  const [needsConnection, setNeedsConnection] = useState(false);
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
        setIsDemoData(res.headers.get("X-Insights-Data-Source") === "mock");
        if (res.headers.get("X-Insights-State") === "needs-connection") {
          void res.body?.cancel();
          setNeedsConnection(true);
          return;
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
    setNeedsConnection(false);
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
          {isDemoData && <Badge tone="warning">Demo data</Badge>}
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
      ) : needsConnection ? (
        <EmptyState
          icon={<Icon name="Plug" className="h-6 w-6" />}
          title="No performance data yet"
          description="Connect a social account and we'll brief you weekly on what's working."
          action={
            <Link
              href={`/clients/${clientId}/settings`}
              className="text-xs text-neon underline-offset-2 hover:underline"
            >
              Connect a channel
            </Link>
          }
        />
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
        <div className="space-y-1.5 text-[13px] leading-relaxed text-muted">
          {renderBriefing(text)}
          {loading && <span className="ml-0.5 inline-block h-3.5 w-1.5 animate-pulse-neon bg-neon align-middle" />}
        </div>
      )}
    </Card>
  );
}

/* ── Minimal, dependency-free markdown rendering ─────────────────────── */
/* The briefing is Haiku prose: mostly **bold** mini-headers and "- " / "• "
   bullets, but it sometimes reaches for `#`/`##` headings or numbered lists
   too. Render all of that safely as React nodes (no dangerouslySetInnerHTML,
   no markdown dependency) rather than leaving raw syntax on the page. */

function renderInline(line: string, keyPrefix: string): React.ReactNode[] {
  // Split on **bold** spans, keeping the delimited groups.
  return line.split(/(\*\*[^*]+\*\*)/g).filter(Boolean).map((part, i) => {
    if (part.startsWith("**") && part.endsWith("**")) {
      return (
        <strong key={`${keyPrefix}-${i}`} className="font-semibold text-foreground">
          {part.slice(2, -2)}
        </strong>
      );
    }
    return <span key={`${keyPrefix}-${i}`}>{part}</span>;
  });
}

function renderBriefing(text: string): React.ReactNode {
  const lines = text.split("\n");

  // Drop a leading H1 — it's the model restating a title ("# CLIENT - WEEKLY
  // BRIEFING") that only duplicates the card's own "AI Insights" header.
  const firstIdx = lines.findIndex((l) => l.trim() !== "");
  if (firstIdx !== -1 && /^#\s+\S/.test(lines[firstIdx].trim())) {
    lines.splice(firstIdx, 1);
  }

  return lines.map((raw, i) => {
    const line = raw.trimEnd();
    const trimmed = line.trim();
    if (trimmed === "") return <div key={i} className="h-1.5" />;

    // Handle every ATX header level (# … ######), with or without a trailing space, so a
    // stray "#"/"##" never renders as literal syntax (QA Fix 8). The leading title H1 is
    // dropped above; remaining headers get real visual weight as section structure.
    const heading = /^(#{1,6})\s*(.+)/.exec(trimmed);
    if (heading) {
      const top = heading[1].length <= 2; // #/## are section headers; deeper are sub-headers
      return (
        <p
          key={i}
          className={
            top
              ? "mb-1 mt-3 text-sm font-bold text-foreground first:mt-0"
              : "mb-1 mt-2 text-[13px] font-semibold text-foreground/80 first:mt-0"
          }
        >
          {renderInline(heading[2], `h${i}`)}
        </p>
      );
    }

    const numbered = /^\s*(\d+)[.)]\s+(.*)/.exec(line);
    if (numbered) {
      return (
        <div key={i} className="flex gap-2">
          <span className="mt-[1px] shrink-0 tabular-nums text-neon/80">{numbered[1]}.</span>
          <span className="flex-1">{renderInline(numbered[2], `n${i}`)}</span>
        </div>
      );
    }

    const bullet = /^\s*[-•]\s+/.test(line);
    if (bullet) {
      const content = line.replace(/^\s*[-•]\s+/, "");
      return (
        <div key={i} className="flex gap-2">
          <span className="mt-[1px] shrink-0 text-neon">•</span>
          <span className="flex-1">{renderInline(content, `l${i}`)}</span>
        </div>
      );
    }
    return <p key={i}>{renderInline(line, `l${i}`)}</p>;
  });
}
