"use client";

import { useState } from "react";
import { Button } from "@/components/ui";
import { Icon } from "@/components/icon";
import { ContactUsButton } from "@/components/contact-us-modal";
import {
  AgentScheduleModal,
  RunCustomAgentModal,
  type AgentSetupState,
  type ClientAgentScheduleRow,
  type RunnableAgentSummary,
} from "@/components/custom-agents";
import type { ContextItem } from "@/lib/types";

import type { LegacyRunGateResult } from "@/lib/client-agent-runs";

/**
 * An agent that is genuinely producing but has no umbrella doc (CD-H8).
 *
 * This is the flagship case, not an edge one: Karos Labs' own Instagram Agent
 * has a live weekly schedule and predates the umbrella model entirely. Its
 * detail page rendered a stub — a sentence saying it was producing, and nothing
 * else — so the agent Albert screenshots most often was the one with no way to
 * make a post, no way to change its pace, and no sign of anything it had ever
 * made.
 *
 * WHAT IT GETS: the two gestures that need no umbrella. "Create a new post" is
 * the standard priced custom-agent run — the same dialog, launch profile and
 * charge path the generic card uses, not a second implementation. "Adjust pace"
 * is the same paceOnly schedule modal the live card uses, and it is offered
 * because the schedule is exactly what this shape DOES have.
 *
 * WHAT IT DOES NOT GET, deliberately: template rows, the week strip, per-template
 * feedback, notes. Every one of those reads the umbrella's registry or its slot
 * plan, and this agent has neither. Faking them would put invented streams in
 * front of a client — the §9 backfill script is the real fix, and it creates the
 * umbrella rather than pretending one exists.
 *
 * The gate is evaluated SERVER-side and painted, never a title on a disabled
 * control (F25 — the Button primitive sets disabled:pointer-events-none, so a
 * tooltip there can never be read).
 */
export function LegacyAgentPanel({
  clientId,
  agent,
  cost,
  gate,
  schedule,
  setup,
  contextItems,
  viewerIsClient,
  viewer,
  availableCredits,
}: {
  clientId: string;
  agent: RunnableAgentSummary;
  /** Null for staff — quoting them a price they never pay would be a lie. */
  cost: number | null;
  /** Server-evaluated, already resolved to a paintable reason (F25/F131). */
  gate: LegacyRunGateResult;
  schedule: ClientAgentScheduleRow | null;
  setup?: AgentSetupState;
  contextItems: ContextItem[];
  viewerIsClient: boolean;
  viewer?: { name: string; email: string };
  availableCredits?: number;
}) {
  const [running, setRunning] = useState(false);
  const [scheduling, setScheduling] = useState(false);

  return (
    <div className="space-y-6">
      <section>
        <div className="flex flex-wrap items-center gap-3 rounded-[var(--radius)] border border-border bg-surface-2/50 p-4">
          <div className="min-w-0 flex-1">
            <p className="text-sm text-foreground">Create a new post</p>
            <p className="mt-0.5 text-xs text-muted-2">
              {gate.allowed
                ? "Makes one post now. It takes 10–20 minutes, and your Karos team reviews it before it reaches your Workspace."
                : "Making a post now is not available yet."}
            </p>
          </div>
          <Button
            variant="accent"
            disabled={!gate.allowed || running}
            onClick={() => setRunning(true)}
          >
            <Icon name="Sparkles" className="h-4 w-4" />
            {cost != null ? `Create new post · ${cost} credits` : "Create new post"}
          </Button>
        </div>
        {!gate.allowed && gate.reason && (
          <div className="mt-2 rounded-[var(--radius)] border border-warning/30 bg-warning/10 px-4 py-2.5">
            <p className="text-xs text-warning">{gate.reason}</p>
            {gate.href && gate.hrefLabel && (
              <a href={gate.href} className="mt-1 inline-block text-xs text-neon hover:underline">
                {gate.hrefLabel} →
              </a>
            )}
            {gate.code === "credits_short" && viewer && (
              <div className="-mx-4">
                <ContactUsButton variant="row" userName={viewer.name} userEmail={viewer.email} />
              </div>
            )}
          </div>
        )}
      </section>

      <section>
        <div className="mb-2.5">
          <h2 className="font-mono text-[10px] uppercase tracking-[0.08em] text-muted">
            How often it posts
          </h2>
          <p className="mt-1 text-xs text-muted-2">
            {schedule
              ? "This agent is already posting for you on a schedule. Change how often whenever you like."
              : "This agent has no schedule yet — your Karos team sets one up."}
          </p>
        </div>
        <div className="flex flex-wrap items-center gap-2">
          {schedule && (
            <Button variant="subtle" onClick={() => setScheduling(true)}>
              <Icon name="SlidersHorizontal" className="h-4 w-4" /> Adjust pace
            </Button>
          )}
          <p className="text-xs text-muted-2">
            {cost != null ? `${cost} credits per post` : "Staff runs are free"}
          </p>
        </div>
      </section>

      {running && (
        <RunCustomAgentModal
          agent={agent}
          clientId={clientId}
          contextItems={contextItems}
          viewerIsClient={viewerIsClient}
          {...(setup ? { setup } : {})}
          onClose={() => setRunning(false)}
        />
      )}
      {scheduling && schedule && (
        <AgentScheduleModal
          agent={agent}
          clientId={clientId}
          schedule={schedule}
          // Clients get the pace face: how many posts a week, never how they
          // are batched (D3 / A3-A4).
          paceOnly={viewerIsClient}
          {...(availableCredits !== undefined ? { availableCredits } : {})}
          onClose={() => setScheduling(false)}
        />
      )}
    </div>
  );
}
