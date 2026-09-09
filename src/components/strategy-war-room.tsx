"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import Link from "next/link";
import { Modal } from "@/components/modal";
import { Icon } from "@/components/icon";
import { cn } from "@/lib/utils";
import { MAX_ACTIVE_TASKS } from "@/lib/constants";
// Type-only import - the server-only swarm engine never reaches the client bundle.
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
  | { kind: "campaign"; title: string; themeScope: string; count: number }
  | { kind: "system"; message: string };

type Status = "running" | "done" | "error";

/**
 * The Strategy War Room - a live terminal that streams the multi-agent Task Map
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
  /** Fired once when consensus is persisted - parent refreshes the Task Map. */
  onComplete: () => void;
}) {
  const [lines, setLines] = useState<Line[]>([]);
  const [status, setStatus] = useState<Status>("running");
  const [created, setCreated] = useState<number | null>(null);
  /**
   * Why the save produced what it produced. Zero created is a routine outcome
   * - every candidate that duplicates the board or overflows the active-task
   * ceiling is dropped - and the only explanation used to be one grey console
   * line under a green "Consensus reached" banner (QA F90).
   */
  const [outcome, setOutcome] = useState<{
    note: string;
    duplicatesSkipped: number;
    capSkipped: number;
  } | null>(null);
  const [error, setError] = useState<string | null>(null);
  /** Live round counter, so the wait is legible while the agents debate. */
  const [progress, setProgress] = useState<{ round: number; total: number } | null>(null);
  /**
   * Escape and a backdrop click both reach Modal's onClose, which unmounts this
   * component and aborts the stream - the server then skips persistence, so
   * six sequential model calls are discarded with no warning (QA F93). While a
   * run is live, a close request raises this confirmation instead.
   */
  const [confirmingClose, setConfirmingClose] = useState(false);
  const abortRef = useRef<AbortController | null>(null);
  const scrollRef = useRef<HTMLDivElement>(null);
  const completedRef = useRef(false);

  const handleEvent = useCallback(
    (ev: SwarmEvent) => {
      switch (ev.type) {
        case "round_start":
          setLines((p) => [...p, { kind: "round", round: ev.round, total: ev.totalRounds }]);
          setProgress({ round: ev.round, total: ev.totalRounds });
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
          setOutcome({
            note: ev.note,
            duplicatesSkipped: ev.duplicatesSkipped,
            capSkipped: ev.capSkipped,
          });
          break;
        // A high-weight trend also builds a full campaign. The engine has always
        // emitted this frame; with no case for it the console parsed and dropped
        // it, so the client saw cards appear that nothing had mentioned (QA F92).
        case "campaign":
          setLines((p) => [
            ...p,
            { kind: "campaign", title: ev.title, themeScope: ev.themeScope, count: ev.taskCount },
          ]);
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
        const res = await fetch(`/api/tasks/generate-swarm`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ clientId }),
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

  // Once consensus lands, refresh the board - but stay open. The modal used to
  // close itself after 1.6s, which left nothing to click and no way to reach
  // the tasks it had just created (QA F65).
  useEffect(() => {
    if (status !== "done" || completedRef.current) return;
    completedRef.current = true;
    onComplete();
  }, [status, onComplete]);

  // Every dismissal path - Escape, the backdrop, the corner X - comes through
  // Modal's onClose, so intercepting here covers all three.
  const requestClose = useCallback(() => {
    if (status === "running") {
      setConfirmingClose(true);
      return;
    }
    onClose();
  }, [status, onClose]);

  return (
    <Modal open onClose={requestClose} className="max-w-2xl">
      <div className="space-y-3">
        {/* Header - pr-8 clears the Modal's absolutely-positioned close button,
            same convention as Modal's own title. */}
        <div className="flex items-center gap-2.5 pr-8">
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
          {/* Mono stays — this is a label, which is the face's job — but at 500,
              the heaviest weight DM Mono actually ships. */}
          <h2 className="font-mono text-sm font-medium uppercase tracking-[0.14em] text-foreground">
            The Strategy War Room
          </h2>
          {status === "running" && progress && (
            <span className="ml-auto shrink-0 font-mono text-[10px] uppercase tracking-[0.12em] text-muted-2">
              Round {progress.round} / {progress.total}
            </span>
          )}
        </div>
        <p className="text-xs text-muted-2">
          Three specialist agents are debating your Task Map live, proposing, critiquing, and
          stress-testing against your analytics until they reach consensus. This takes about a
          minute; leaving before it finishes discards the run.
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

        {/* Running footer - an explicit way out, so Escape is not the only
            instinct available mid-run (QA F93). */}
        {status === "running" &&
          (confirmingClose ? (
            <div className="flex flex-wrap items-center justify-between gap-2 rounded-md border border-warning/30 bg-warning/10 px-3 py-2">
              <p className="flex min-w-0 items-center gap-2 text-sm text-warning">
                <Icon name="TriangleAlert" className="h-4 w-4 shrink-0" />
                The agents are still working. Leaving now discards the run. Nothing is saved.
              </p>
              <div className="flex shrink-0 items-center gap-3">
                <button
                  type="button"
                  onClick={() => setConfirmingClose(false)}
                  className="text-xs font-semibold text-neon hover:underline"
                >
                  Keep running
                </button>
                <button
                  type="button"
                  onClick={onClose}
                  className="text-xs text-muted-2 underline underline-offset-2 hover:text-foreground"
                >
                  Discard run
                </button>
              </div>
            </div>
          ) : (
            <div className="flex items-center justify-between gap-2 px-1">
              <p className="text-[11px] text-muted-2">Keep this open. The run stops if you leave.</p>
              <button
                type="button"
                onClick={() => setConfirmingClose(true)}
                className="shrink-0 text-xs text-muted-2 underline underline-offset-2 hover:text-foreground"
              >
                Cancel run
              </button>
            </div>
          ))}

        {/* Footer - a green tick over "0 tasks locked" was the last thing a
            client saw after a minute of waiting, with no idea why nothing
            happened (QA F90). Zero created gets its own neutral panel that
            says what was dropped and what to do next. */}
        {status === "done" && (created ?? 0) > 0 && (
          <div className="flex flex-wrap items-center justify-between gap-2 rounded-md border border-success/30 bg-success/10 px-3 py-2 text-sm text-success">
            <p className="flex min-w-0 items-center gap-2">
              <Icon name="CircleCheck" className="h-4 w-4 shrink-0" />
              Consensus reached · {created} task{created === 1 ? "" : "s"} locked into your map.
            </p>
            <Link
              href={`/clients/${clientId}`}
              onClick={onClose}
              className="shrink-0 font-semibold underline underline-offset-2 hover:opacity-80"
            >
              View task map →
            </Link>
          </div>
        )}
        {status === "done" && (created ?? 0) === 0 && (
          <div className="space-y-1.5 rounded-md border border-warning/30 bg-warning/10 px-3 py-2 text-sm text-warning">
            <p className="flex items-center gap-2 font-medium">
              <Icon name="Info" className="h-4 w-4 shrink-0" />
              Nothing new to add. No tasks were created.
            </p>
            <p className="text-xs opacity-90">{zeroOutcomeExplanation(outcome)}</p>
            <div className="flex flex-wrap items-center gap-3 pt-0.5">
              <Link
                href={`/clients/${clientId}`}
                onClick={onClose}
                className="text-xs font-semibold underline underline-offset-2 hover:opacity-80"
              >
                Open your task map →
              </Link>
              <button type="button" onClick={onClose} className="text-xs underline underline-offset-2 hover:opacity-80">
                Close
              </button>
            </div>
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

/**
 * Plain-English reason a finished run created nothing, plus the concrete next
 * step. Falls back to the engine's own note when the counts don't explain it.
 *
 * WHOSE LIMIT, and these two sentences had it wrong. `capSkipped` comes from the
 * cap in task-dedup.ts, which counts KAROS-RUN tasks that are still open and has
 * no opinion about the ones a client adds by hand — so "your board is already at
 * the 15-active-task limit" is false for a client looking at a board of twenty of
 * their own tasks, and "active" is the code's word for the counted set rather
 * than the client's. Same defect as `queueCapacitySkipNote` had, and the sweep
 * that keeps that note in one home cannot see these: it looks for a literal
 * saying "deferred", "dropped" or "not added", and neither of these says any of
 * the three.
 *
 * WHAT THE NEXT STEP POINTS AT is the other thing to get right, and the two-count
 * branch had it dangling: its subject is the PROPOSALS, so "approve or complete
 * some of those" pointed at the one thing in the sentence a client can do neither
 * of. It names the work instead. Whoever rewords these should check the nearest
 * plural before reaching for "those".
 *
 * They state the rule rather than reuse the note, because the shapes differ — the
 * note is a lowercase fragment for a parenthesised list, these are sentences that
 * end in the next step. The RULE has one home (task-dedup.ts's capacity policy);
 * whoever changes what the cap counts has to restate it in both places.
 */
function zeroOutcomeExplanation(
  outcome: { note: string; duplicatesSkipped: number; capSkipped: number } | null,
): string {
  if (!outcome) return "The debate finished without a saved result. Try running it again.";
  const { duplicatesSkipped, capSkipped } = outcome;
  if (capSkipped > 0 && duplicatesSkipped > 0) {
    return `Every proposal was either already on your board (${duplicatesSkipped}) or over the ${MAX_ACTIVE_TASKS}-task limit on work Karos runs for you (${capSkipped}). Approve or complete some of that work, then run this again.`;
  }
  if (capSkipped > 0) {
    return `Karos already has its limit of ${MAX_ACTIVE_TASKS} open tasks for you, so ${capSkipped} proposal${capSkipped === 1 ? "" : "s"} could not be added. Approve or complete some of those, then run this again.`;
  }
  if (duplicatesSkipped > 0) {
    return `All ${duplicatesSkipped} proposal${duplicatesSkipped === 1 ? "" : "s"} already exist on your board. Your task map is up to date.`;
  }
  return outcome.note;
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
          ✅ Consensus locked · {line.count} optimal task{line.count === 1 ? "" : "s"}.
        </p>
      );
    case "persisted":
      return <p className="text-muted">↳ {line.note}</p>;
    case "campaign":
      return (
        <p className="pt-1 text-info">
          🎬 Campaign built · “{line.title}” ({line.themeScope}): {line.count} extra task
          {line.count === 1 ? "" : "s"} added to your board.
        </p>
      );
    case "system":
      return <p className="text-danger">⚠ {line.message}</p>;
  }
}
