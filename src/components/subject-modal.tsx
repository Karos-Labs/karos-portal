"use client";

import { Modal } from "@/components/modal";
import { Icon } from "@/components/icon";
import { cn } from "@/lib/utils";
import type { SWOTMatrix, DimensionScore } from "@/lib/types";

/* ── Simple markdown renderer ─────────────────────────────────────── */

function renderMarkdown(text: string) {
  if (!text) return null;
  const lines = text.split("\n");
  const nodes: React.ReactNode[] = [];
  let listItems: string[] = [];

  function flushList() {
    if (!listItems.length) return;
    nodes.push(
      <ul key={nodes.length} className="ml-4 list-disc space-y-1 text-sm text-muted">
        {listItems.map((item, i) => (
          <li key={i}>{item}</li>
        ))}
      </ul>,
    );
    listItems = [];
  }

  lines.forEach((line, i) => {
    if (line.startsWith("### ")) {
      flushList();
      nodes.push(
        <h4 key={i} className="mt-4 text-sm font-semibold text-foreground first:mt-0">
          {line.slice(4)}
        </h4>,
      );
    } else if (line.startsWith("## ")) {
      flushList();
      nodes.push(
        <h3 key={i} className="mt-5 text-base font-semibold text-foreground first:mt-0">
          {line.slice(3)}
        </h3>,
      );
    } else if (line.match(/^[->*]\s/)) {
      listItems.push(line.replace(/^[->*]\s+/, "").trim());
    } else if (line.startsWith("|")) {
      flushList();
      // skip table rows — markdown tables are raw, skip for now
    } else if (line.trim()) {
      flushList();
      nodes.push(
        <p key={i} className="text-sm text-muted">
          {line}
        </p>,
      );
    }
  });
  flushList();
  return <>{nodes}</>;
}

/* ── Score pill ───────────────────────────────────────────────────── */

function ScorePill({ score, weight }: { score?: number; weight?: number }) {
  if (score === undefined) return null;
  const color =
    score >= 70
      ? "text-neon border-neon/30 bg-neon-soft"
      : score >= 50
        ? "text-yellow-400 border-yellow-400/30 bg-yellow-400/10"
        : "text-red-400 border-red-400/30 bg-red-400/10";
  return (
    <div className={cn("flex items-center gap-2 rounded-[10px] border px-3 py-1.5", color)}>
      <span className="text-2xl font-bold tabular-nums">{score}</span>
      <div className="text-xs">
        <p className="font-medium">/ 100</p>
        {weight !== undefined && <p className="opacity-70">{weight}% weight</p>}
      </div>
    </div>
  );
}

/* ── SWOT view ────────────────────────────────────────────────────── */

function SwotView({ swot }: { swot: SWOTMatrix }) {
  const quadrants = [
    { label: "Strengths", items: swot.strengths, color: "text-neon", bg: "bg-neon-soft border-neon/20" },
    { label: "Weaknesses", items: swot.weaknesses, color: "text-red-400", bg: "bg-red-400/10 border-red-400/20" },
    { label: "Opportunities", items: swot.opportunities, color: "text-blue-400", bg: "bg-blue-400/10 border-blue-400/20" },
    { label: "Threats", items: swot.threats, color: "text-amber-400", bg: "bg-amber-400/10 border-amber-400/20" },
  ];
  return (
    <div className="grid gap-3 sm:grid-cols-2">
      {quadrants.map((q) => (
        <div key={q.label} className={cn("rounded-[12px] border p-4", q.bg)}>
          <p className={cn("mb-2 text-xs font-semibold uppercase tracking-wider", q.color)}>
            {q.label}
          </p>
          {q.items.length === 0 ? (
            <p className="text-xs text-muted-2">None recorded.</p>
          ) : (
            <ul className="space-y-1.5">
              {q.items.map((item, i) => (
                <li key={i} className="flex gap-2 text-xs text-foreground">
                  <span className={cn("mt-0.5 shrink-0", q.color)}>›</span>
                  <span>{item}</span>
                </li>
              ))}
            </ul>
          )}
        </div>
      ))}
    </div>
  );
}

/* ── Main export ──────────────────────────────────────────────────── */

interface Props {
  open: boolean;
  onClose: () => void;
  title: string;
  icon: string;
  score?: number;
  weight?: number;
  content?: string;
  swot?: SWOTMatrix;
  dimensionScores?: DimensionScore[];
}

export function SubjectModal({ open, onClose, title, icon, score, weight, content, swot }: Props) {
  return (
    <Modal open={open} onClose={onClose} className="max-w-2xl">
      <div className="space-y-5">
        {/* Header */}
        <div className="flex items-start justify-between gap-4">
          <div className="flex items-center gap-3">
            <div className="flex h-10 w-10 shrink-0 items-center justify-center rounded-[10px] bg-neon-soft">
              <Icon name={icon} className="h-5 w-5 text-neon" />
            </div>
            <h2 className="text-lg font-semibold">{title}</h2>
          </div>
          {score !== undefined && <ScorePill score={score} weight={weight} />}
        </div>

        <div className="h-px bg-border" />

        {/* Content */}
        {swot ? (
          <SwotView swot={swot} />
        ) : content ? (
          <div className="space-y-2 max-h-[60vh] overflow-y-auto pr-1">
            {renderMarkdown(content)}
          </div>
        ) : (
          <p className="text-sm text-muted-2">No analysis data available for this section.</p>
        )}
      </div>
    </Modal>
  );
}
