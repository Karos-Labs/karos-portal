"use client";

import Link from "next/link";
import { useCallback, useEffect, useRef, useState } from "react";
import { Card, CardTitle, Badge, EmptyState, Skeleton } from "@/components/ui";
import { Icon } from "@/components/icon";
import { stripPipelineMarkers } from "@/lib/doc-render";
// Quoted from the pricing home, off the same constant the route charges from.
import { insightsRefreshPrice } from "@/lib/credits";

/**
 * AI Insights — the client-facing readout of the Self-Improving Marketing Loop.
 * Streams a plain-language week-over-week performance briefing (and the
 * optimization moves the engine is making) from /api/clients/[id]/insights, the
 * same way the copilot dock consumes /chat. Mounted in the client dashboard's
 * Performance section.
 */
export function AiInsights({
  clientId,
  viewerIsBilled,
}: {
  clientId: string;
  /**
   * `isBillableClientActor()` for this session, resolved on the server. REQUIRED
   * rather than defaulted: the "Refresh" button spends a credit, and a mount
   * site that forgot to answer would silently go back to charging in silence —
   * so the compiler asks instead of a default deciding.
   */
  viewerIsBilled: boolean;
}) {
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
  const refreshPrice = insightsRefreshPrice(viewerIsBilled);

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
          res.body?.cancel().catch(() => {});
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
        <div className="flex shrink-0 items-center gap-2">
          {/* THE ANNOUNCE. Every "Refresh" is `?force=1`, which skips the cache
              and rebuilds the briefing from a model call the client now pays
              for — so the price is stated at the control, before the press, and
              not learned afterwards from the balance. One line covers all three
              presses in this card (this button and the two "Try again"s below,
              which call the same forced `load()`). */}
          {refreshPrice && (
            <span className="text-[11px] text-muted-2">Each refresh costs {refreshPrice}</span>
          )}
          <button
            type="button"
            onClick={() => void load()}
            disabled={loading}
            className="text-xs text-neon transition-opacity hover:underline disabled:opacity-40"
          >
            {loading ? "Analyzing…" : "Refresh"}
          </button>
        </div>
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
              href={`/clients/${clientId}/settings?tab=channels`}
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
      ) : text.trim() === "" ? (
        // A briefing that fails mid-stream still answers 200 with an empty body
        // (the SDK masks the error into the stream), and an empty body used to
        // render as nothing at all — a badged card with a blank 92px body, seen
        // on the staff lens during the wave-1 walk. Say what happened instead.
        <EmptyState
          icon={<Icon name="Sparkles" className="h-6 w-6" />}
          title="No briefing right now"
          description="We couldn't put this week's briefing together. Try again in a moment."
          action={
            <button type="button" onClick={() => void load()} className="text-xs text-neon hover:underline">
              Try again
            </button>
          }
        />
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

/**
 * The inline spans a briefing can carry, in match order: ***both***, **bold**
 * (which may wrap *emphasis* inside it), *emphasis*, __bold__, _emphasis_.
 *
 * QA F126: this used to match only the double-asterisk form, so whenever the
 * model reached for italics the delimiters landed on the page verbatim ("Top
 * performers: *Playbook* (4.2 score) and *Special Edition*"). Latent rather
 * than always visible — it depends on what the model emits that week — which is
 * how it survived review.
 *
 * The shapes below are the follow-up pass. Each one left a literal delimiter on
 * the page under the first fix — the very symptom F126 is about:
 * - `**bold with *nested* inside**`: `[^*]+` can't cross the inner star, so the
 *   outer span never matched and the inner one matched across the wrong
 *   boundary. `(?:[^*]|\*(?!\*))+?` accepts single stars but stops at the
 *   closing pair; the content is then re-rendered, so nesting works.
 * - `***triple***` and `__bold__`: matched one delimiter in from the edge and
 *   spat the outermost one onto the page. Both now have their own alternative.
 * - `client_id_value`: the underscore branch ate the middle of ordinary tokens
 *   (reachable — asset labels are quoted verbatim into briefings). Word-boundary
 *   guards mean an underscore only opens emphasis at a non-word boundary.
 */
export const INLINE_EMPHASIS_RE =
  /(\*\*\*[^*\n]+\*\*\*|\*\*(?:[^*]|\*(?!\*))+?\*\*|\*[^*\n]+\*|(?<!\w)__[^_\n]+__(?!\w)|(?<!\w)_[^_\n]+_(?!\w))/g;

/**
 * The inside of a delimited span, or null when `part` isn't one. Split() hands
 * back the text between matches as well as the matches themselves, so this
 * re-checks the shape rather than trusting a startsWith: a lone "****" or "___"
 * in prose is text, not an empty emphasis to swallow.
 */
function unwrap(part: string, delim: string): string | null {
  if (part.length <= delim.length * 2) return null;
  if (!part.startsWith(delim) || !part.endsWith(delim)) return null;
  const inner = part.slice(delim.length, -delim.length);
  // A leftover delimiter char at either edge means we're one level off (e.g.
  // reading "***x***" as bold) — let the correct alternative claim it.
  return inner.startsWith(delim[0]) || inner.endsWith(delim[0]) ? null : inner;
}

export function renderInline(line: string, keyPrefix: string, depth = 0): React.ReactNode[] {
  // Bold may carry emphasis inside it; nothing deeper is worth another pass.
  if (depth > 2) return [<span key={`${keyPrefix}-flat`}>{line}</span>];

  return line.split(INLINE_EMPHASIS_RE).filter(Boolean).map((part, i) => {
    const key = `${keyPrefix}-${i}`;

    const both = unwrap(part, "***");
    if (both !== null) {
      return (
        <strong key={key} className="font-semibold text-foreground">
          <em className="italic">{renderInline(both, key, depth + 1)}</em>
        </strong>
      );
    }

    const bold = unwrap(part, "**") ?? unwrap(part, "__");
    if (bold !== null) {
      return (
        <strong key={key} className="font-semibold text-foreground">
          {renderInline(bold, key, depth + 1)}
        </strong>
      );
    }

    const emphasis = unwrap(part, "*") ?? unwrap(part, "_");
    if (emphasis !== null) {
      return (
        <em key={key} className="italic text-foreground/90">
          {emphasis}
        </em>
      );
    }

    return <span key={key}>{part}</span>;
  });
}

export function renderBriefing(text: string): React.ReactNode {
  // The briefing is written over the client's context documents, so anything
  // the pipeline wrote into those can be quoted back into it. This renderer
  // emits React nodes, which means a comment would be shown as text rather
  // than parsed away — same reason doc-render.ts drops them.
  const lines = stripPipelineMarkers(text).split("\n");

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
