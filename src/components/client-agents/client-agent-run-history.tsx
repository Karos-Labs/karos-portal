"use client";

import { useState } from "react";
import { Card, CardTitle, Badge } from "@/components/ui";
import { Icon } from "@/components/icon";
import { relativeTime } from "@/lib/utils";
import { jobStatusMeta } from "@/lib/job-status-copy";
import type { CustomAgentRunRow } from "@/components/custom-agents";

const SHOWN_COLLAPSED = 3;

/**
 * Surface 03 — "Run history shows the last three, and opens to all of them."
 * Client-safe rows only (`toRunRows(jobs, false, umbrellas)` — no prompt, no
 * href, no raw error). This is a NEW client-facing surface: staff have always
 * had AgentRunHistory inside ControlRoom, but nothing client-facing rendered
 * these rows before this component existed.
 */
export function ClientAgentRunHistory({ runs }: { runs: CustomAgentRunRow[] }) {
  const [expanded, setExpanded] = useState(false);
  if (runs.length === 0) return null;

  const shown = expanded ? runs : runs.slice(0, SHOWN_COLLAPSED);

  return (
    <Card>
      <div className="mb-3 flex items-center justify-between">
        <CardTitle>Run history</CardTitle>
        {/* Rendered whenever the list is collapsible in EITHER direction (flow
            audit 2026-09, R19's shape): "Show all" used to disappear once
            pressed, leaving a client scrolling a list they could not close
            again. Same one-control-both-ways rule the competitor list keeps
            (client-context-sections.tsx). */}
        {runs.length > SHOWN_COLLAPSED && (
          <button
            type="button"
            onClick={() => setExpanded((e) => !e)}
            aria-expanded={expanded}
            className="focus-ring text-xs text-muted underline-offset-2 transition-colors hover:text-foreground hover:underline"
          >
            {expanded ? "Show fewer" : "Show all"}
          </button>
        )}
      </div>
      <ul className="space-y-2">
        {shown.map((run) => {
          const meta = jobStatusMeta(run.status);
          return (
            <li
              key={run.id}
              /* INERT, AND DRESSED AS INERT (flow audit 2026-09, R8; round 6
                 rule 3). A client's run row has no destination — /jobs/[id] is
                 staff-only and this view is built from client-safe rows with no
                 href on them — so it carries neither `row-lift` nor a trailing
                 chevron, which is the other half of the rule the rows that DO
                 open now keep. Round 6 took the last piece of the link's
                 costume: the border and the `surface-2` fill are what a row that
                 opens something wears on this very page (agent-archive-rows.tsx,
                 two sections up), so a static box in the same shell is a dead
                 end that looks pressable. It sits on a divider instead. Do not
                 add a hover treatment, a border or a fill here without adding
                 somewhere to go. */
              className="flex items-center justify-between gap-3 border-b border-border px-1 py-2.5 last:border-b-0"
            >
              <div className="min-w-0 flex-1">
                <p className="truncate text-sm font-medium text-foreground">{run.label}</p>
                <p className="mt-0.5 text-xs text-muted-2">{relativeTime(run.createdAt)}</p>
              </div>
              <Badge tone={meta.tone}>
                <Icon name={meta.icon} className="h-3 w-3" />
                {meta.label}
              </Badge>
            </li>
          );
        })}
      </ul>
    </Card>
  );
}
