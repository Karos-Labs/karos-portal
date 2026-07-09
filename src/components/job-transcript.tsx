"use client";

import { useState } from "react";
import { Icon } from "@/components/icon";
import { Badge } from "@/components/ui";
import type { TranscriptTurn, TranscriptBlock } from "@/lib/agent-service/transcript";

/**
 * Renders the agent's run transcript — its reasoning ("thinking"), the text it
 * wrote, and the tool calls / results that produced the deliverables. Tool
 * details and results are collapsed by default to keep the run scannable.
 */
export function JobTranscript({ turns, truncated }: { turns: TranscriptTurn[]; truncated: boolean }) {
  if (turns.length === 0) {
    return <p className="text-sm text-muted-2">The transcript is empty.</p>;
  }
  return (
    <div className="space-y-4">
      {turns.map((turn, i) => (
        <Turn key={i} turn={turn} />
      ))}
      {truncated && (
        <p className="text-xs text-muted-2">Transcript truncated — showing the earliest portion of the run.</p>
      )}
    </div>
  );
}

function Turn({ turn }: { turn: TranscriptTurn }) {
  return (
    <div className="space-y-2">
      {turn.blocks.map((block, i) => (
        <Block key={i} block={block} />
      ))}
    </div>
  );
}

function Block({ block }: { block: TranscriptBlock }) {
  switch (block.kind) {
    case "text":
      return <p className="whitespace-pre-wrap text-sm leading-relaxed text-foreground">{block.text}</p>;

    case "thinking":
      return (
        <Disclosure
          icon="Brain"
          label="Thinking"
          tone="muted"
          preview={firstLine(block.text)}
          defaultOpen={block.text.length < 400}
        >
          <p className="whitespace-pre-wrap text-xs italic leading-relaxed text-muted">{block.text}</p>
        </Disclosure>
      );

    case "tool_use":
      return (
        <Disclosure
          icon="Wrench"
          label={block.name}
          tone="tool"
          preview={inputPreview(block.input)}
        >
          <pre className="max-h-72 overflow-auto whitespace-pre-wrap rounded-md bg-surface-3 p-2 text-[11px] leading-relaxed text-muted">
            {stringify(block.input)}
          </pre>
        </Disclosure>
      );

    case "tool_result":
      return (
        <Disclosure
          icon={block.isError ? "CircleAlert" : "CornerDownRight"}
          label={block.isError ? "Tool error" : "Tool result"}
          tone={block.isError ? "error" : "muted"}
          preview={firstLine(block.text)}
        >
          <pre
            className={`max-h-72 overflow-auto whitespace-pre-wrap rounded-md bg-surface-3 p-2 text-[11px] leading-relaxed ${
              block.isError ? "text-danger" : "text-muted"
            }`}
          >
            {block.text || "(empty)"}
          </pre>
        </Disclosure>
      );
  }
}

function Disclosure({
  icon,
  label,
  tone,
  preview,
  defaultOpen = false,
  children,
}: {
  icon: string;
  label: string;
  tone: "muted" | "tool" | "error";
  preview?: string;
  defaultOpen?: boolean;
  children: React.ReactNode;
}) {
  const [open, setOpen] = useState(defaultOpen);
  const toneColor =
    tone === "error" ? "text-danger" : tone === "tool" ? "text-neon-dim" : "text-muted-2";
  return (
    <div className="rounded-lg border border-border/60 bg-surface-2/40">
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        className="flex w-full items-center gap-2 px-2.5 py-1.5 text-left"
      >
        <Icon name={icon} className={`h-3.5 w-3.5 shrink-0 ${toneColor}`} />
        <span className={`text-xs font-medium ${toneColor}`}>{label}</span>
        {!open && preview && (
          <span className="min-w-0 flex-1 truncate text-xs text-muted-2">{preview}</span>
        )}
        <Icon
          name={open ? "ChevronDown" : "ChevronRight"}
          className="ml-auto h-3.5 w-3.5 shrink-0 text-muted-2"
        />
      </button>
      {open && <div className="border-t border-border/60 px-2.5 py-2">{children}</div>}
    </div>
  );
}

/** Small header badge count helper reused by the page-level section. */
export function TranscriptCount({ turns }: { turns: TranscriptTurn[] }) {
  const tools = turns.reduce(
    (n, t) => n + t.blocks.filter((b) => b.kind === "tool_use").length,
    0,
  );
  return <Badge tone="neutral">{tools} tool call{tools === 1 ? "" : "s"}</Badge>;
}

function firstLine(text: string): string {
  const line = text.split("\n").find((l) => l.trim()) ?? "";
  return line.length > 120 ? `${line.slice(0, 120)}…` : line;
}

function inputPreview(input: unknown): string {
  if (input && typeof input === "object") {
    const entries = Object.entries(input as Record<string, unknown>);
    const pick = entries.find(([k]) => ["command", "prompt", "path", "file_path", "query"].includes(k)) ?? entries[0];
    if (pick) return firstLine(`${pick[0]}: ${stringify(pick[1])}`);
  }
  return firstLine(stringify(input));
}

function stringify(value: unknown): string {
  if (typeof value === "string") return value;
  try {
    return JSON.stringify(value, null, 2);
  } catch {
    return String(value);
  }
}
