"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import Link from "next/link";
import { Modal } from "@/components/modal";
import { Icon } from "@/components/icon";
import { cn } from "@/lib/utils";
// Type-only import — the server-only swarm engine never reaches the client bundle.
import type { SwarmEvent, SwarmAgentId } from "@/lib/agent-swarm";

/** Terminal accent per agent. */
const AGENT_COLOR: Record<SwarmAgentId, string> = {
  seo: "text-success",
  creative: "text-neon",
  data: "text-info",
};

type Line =
  | { kind: "round"; round: number; total: number }
  | { kind: "agent"; agent: SwarmAgentId; emoji: string; name: string; message: string }
  | { kind: "consensus"; count: number }
  | { kind: "persisted"; note: string }
  | { kind: "system"; message: string };

type Status = "running" | "done" | "error";

/**
 * The Strategy War Room — a live terminal that streams the multi-agent Task Map
 * debate over SSE. Replaces the plain refresh spinner: the SEO, Creative, and
 * Data agents argue round-by-round in the console; on consensus it flashes the
 * result, refreshes the board, and closes.
 */
export function StrategyWarRoom({
  clientId,
  onClose,
  onComplete,
}: {
  clientId: string;
  onClose: () => void;
  /** Fired once when consensus is persisted — parent refreshes the Task Map. */
  onComplete: () => void;
}) {
  const [lines, setLines] = useState<Line[]>([]);
  const [status, setStatus] = useState<Status>("running");
  const [created, setCreated] = useState<number | null>(null);
  const [error, setError] = useState<string | null>(null);
  const abortRef = useRef<AbortController | null>(null);
  const scrollRef = useRef<HTMLDivElement>(null);
  const completedRef = useRef(false);

  const handleEvent = useCallback(
    (ev: SwarmEvent) => {
      switch (ev.type) {
        case "round_start":
          setLines((p) => [...p, { kind: "round", round: ev.round, total: ev.totalRounds }]);
          break;
        case "agent_message":
          setLines((p) => [
            ...p,
            { kind: "agent", agent: ev.agent, emoji: ev.emoji, name: ev.agentName, message: ev.message },
          ]);
          break;
        case "consensus":
          setLines((p) => [...p, { kind: "consensus", count: ev.taskCount }]);
          break;
        case "persisted":
          setLines((p) => [...p, { kind: "persisted", note: ev.note }]);
          setCreated(ev.created);
          break;
        case "done":
          setStatus("done");
          setCreated(ev.created);
          break;
        case "error":
          setLines((p) => [...p, { kind: "system", message: ev.message }]);
          setStatus("error");
          setError(ev.message);
          break;
      }
    },
    [],
  );

  const stream = useCallback(
    async (controller: AbortController) => {
      try {
        const res = await fetch(`/api/tasks/generate-swarm?clientId=${encodeURIComponent(clientId)}`, {
          signal: controller.signal,
        });
        if (!res.ok || !res.body) {
          const body = await res.json().catch(() => ({ error: "Request failed" }));
          throw new Error((body as { error?: string }).error ?? `HTTP ${res.status}`);
        }
        const reader = res.body.getReader();
        const decoder = new TextDecoder();
        let buffer = "";
        while (true) {
          const { done, value } = await reader.read();
          if (done) break;
          buffer += decoder.decode(value, { stream: true });
          const parts = buffer.split("\n\n");
          buffer = parts.pop() ?? "";
          for (const part of parts) {
            const dataLine = part.split("\n").find((l) => l.startsWith("data:"));
            if (!dataLine) continue;
            const json = dataLine.slice(5).trim();
            if (!json) continue;
            try {
              handleEvent(JSON.parse(json) as SwarmEvent);
            } catch {
              /* ignore malformed frame */
            }
          }
        }
      } catch (e) {
        if ((e as Error).name === "AbortError") return;
        setStatus("error");
        setError(e instanceof Error ? e.message : "The war room lost connection.");
      }
    },
    [clientId, handleEvent],
  );

  // Start the debate stream on mount.
  useEffect(() => {
    const controller = new AbortController();
    abortRef.current = controller;
    // eslint-disable-next-line react-hooks/set-state-in-effect -- stream() only sets state after its first await; starting on mount is intentional
    void stream(controller);
    return () => controller.abort();
  }, [stream]);

  // Auto-scroll the console as lines arrive.
  useEffect(() => {
    scrollRef.current?.scrollTo({ top: scrollRef.current.scrollHeight, behavior: "smooth" });
  }, [lines]);

  // Once consensus lands, refresh the board — but stay open. The modal used to
  // close itself after 1.6s, which left nothing to click and no way to reach
  // the tasks it had just created (QA F65).
  useEffect(() => {
    if (status !== "done" || completedRef.current) return;
    completedRef.current = true;
    onComplete();
  }, [status, onComplete]);

  return (
    <Modal open onClose={onClose} className="max-w-2xl">
      <div className="space-y-3">
        {/* Header */}
        <div className="flex items-center gap-2.5">
          <span className="relative flex h-2.5 w-2.5">
            <span
              className={cn(
                "absolute inline-flex h-full w-full rounded-full opacity-75",
                status === "running" && "animate-ping bg-neon",
                status === "done" && "bg-success",
                status === "error" && "bg-danger",
              )}
            />
            <span
              className={cn(
                "relative inline-flex h-2.5 w-2.5 rounded-full",
                status === "running" ? "bg-neon" : status === "done" ? "bg-success" : "bg-danger",
              )}
            />
          </span>
          <h2 className="font-mono text-sm font-semibold uppercase tracking-[0.14em] text-foreground">
            The Strategy War Room
          </h2>
        </div>
        <p className="text-xs text-muted-2">
          Three specialist agents are debating your Task Map live — proposing, critiquing, and
          stress-testing against your analytics until they reach consensus.
        </p>

        {/* Console */}
        <div
          ref={scrollRef}
          className="h-80 overflow-y-auto rounded-md border border-border bg-surface-deep p-3 font-mono text-xs leading-relaxed"
        >
          {lines.length === 0 && status === "running" && (
            <p className="text-muted-2">Convening the panel…</p>
          )}
          <div className="space-y-1.5">
            {lines.map((line, i) => (
              <ConsoleLine key={i} line={line} />
            ))}
            {status === "running" && (
              <span className="inline-block h-3 w-1.5 animate-pulse-neon bg-neon align-middle" />
            )}
          </div>
        </div>

        {/* Footer */}
        {status === "done" && (
          <div className="flex flex-wrap items-center justify-between gap-2 rounded-md border border-success/30 bg-success/10 px-3 py-2 text-sm text-success">
            <p className="flex min-w-0 items-center gap-2">
              <Icon name="CircleCheck" className="h-4 w-4 shrink-0" />
              Consensus reached — {created ?? 0} task{created === 1 ? "" : "s"} locked into your map.
            </p>
            <Link
              href="/tasks"
              onClick={onClose}
              className="shrink-0 font-semibold underline underline-offset-2 hover:opacity-80"
            >
              View task map →
            </Link>
          </div>
        )}
        {status === "error" && (
          <div className="flex items-center justify-between gap-2 rounded-md border border-danger/30 bg-danger/10 px-3 py-2">
            <p className="flex items-center gap-2 text-sm text-danger">
              <Icon name="TriangleAlert" className="h-4 w-4 shrink-0" />
              {error ?? "The debate failed."}
            </p>
            <button type="button" onClick={onClose} className="text-xs text-neon hover:underline">
              Close
            </button>
          </div>
        )}
      </div>
    </Modal>
  );
}

function ConsoleLine({ line }: { line: Line }) {
  switch (line.kind) {
    case "round":
      return (
        <div className="flex items-center gap-2 pt-1 text-muted-2">
          <span className="h-px flex-1 bg-border" />
          <span className="uppercase tracking-[0.12em]">
            Round {line.round} / {line.total}
          </span>
          <span className="h-px flex-1 bg-border" />
        </div>
      );
    case "agent":
      return (
        <div className="flex gap-2">
          <span className="shrink-0">{line.emoji}</span>
          <p className="flex-1 text-foreground/90">
            <span className={cn("font-semibold", AGENT_COLOR[line.agent])}>{line.name}:</span>{" "}
            {line.message}
          </p>
        </div>
      );
    case "consensus":
      return (
        <p className="pt-1 font-semibold text-neon">
          ✅ Consensus locked — {line.count} optimal task{line.count === 1 ? "" : "s"}.
        </p>
      );
    case "persisted":
      return <p className="text-muted">↳ {line.note}</p>;
    case "system":
      return <p className="text-danger">⚠ {line.message}</p>;
  }
}
