"use client";

import { useState } from "react";
import { Button, Card } from "@/components/ui";
import { Icon } from "@/components/icon";
import {
  RunCustomAgentModal,
  type AgentSetupState,
  type RunnableAgentSummary,
} from "@/components/custom-agents";
import type { EngineDispatchMap } from "@/lib/agent-engine/engine-dispatch-map";
import type { ContextItem } from "@/lib/types";

/**
 * Surface 03, State 1 — "Not set up shows a Setup button and nothing else."
 *
 * Scoped to intake-driven agents (X/LinkedIn/Reddit/Newsletter/Blog/
 * Reputation/Carousel — the ones `AgentSetupState` can answer readiness for).
 * The umbrella-launch-card system (a live/non-live bound agent) is a
 * different, older product model with its own multi-state flow and is
 * untouched — this component only replaces what an intake-driven agent shows
 * BEFORE `setup.ready && setup.standUpDone` are both true. Once they are, the
 * page's existing legacyShape/LegacyAgentPanel render takes over unchanged.
 *
 * "Clicking Setup opens the fields this agent needs, and only those" — reuses
 * RunCustomAgentModal with `initialPane="data"` rather than a second form.
 */
export function AgentSetupHero({
  agent,
  clientId,
  engineDispatch,
  contextItems,
  viewerIsClient,
  setup,
  previewVideoUrl,
}: {
  agent: RunnableAgentSummary;
  clientId: string;
  /** Forwarded to the run dialog — see `EngineDispatchMap` (T-B21). */
  engineDispatch: EngineDispatchMap;
  contextItems: ContextItem[];
  viewerIsClient: boolean;
  setup: AgentSetupState;
  previewVideoUrl?: string | null;
}) {
  const [settingUp, setSettingUp] = useState(false);

  return (
    <Card>
      {/* NO PLACEHOLDER FRAME (round 6, think-agents §4). An empty 16:9 box
          reading "A preview of what this agent does is coming soon" was the
          largest thing on the first screen a client ever sees of an agent, and
          it promised a video nothing in the product produces. The frame returns
          only when there is a video in it. */}
      {previewVideoUrl && (
        <div className="mb-4 overflow-hidden rounded-[var(--radius)] border border-border bg-surface-2">
          <video src={previewVideoUrl} controls className="aspect-video w-full bg-black" />
        </div>
      )}

      <div className="flex flex-col items-center gap-2 text-center">
        <p className="text-sm text-muted-2">
          Save what {agent.name} needs to know, and it starts producing for you.
        </p>
        {/* KEEPS `accent` (round 6 risk review B2). Zero orange is not the rule,
            one is: the setup hero, the launch card and the run panel are
            mutually exclusive states of this page, so exactly one of them
            renders, and this is the control that moves the client forward. */}
        <Button variant="accent" size="lg" onClick={() => setSettingUp(true)}>
          <Icon name="Sparkles" className="h-4 w-4" />
          Set up this agent
        </Button>
      </div>

      {settingUp && (
        <RunCustomAgentModal
          agent={agent}
          clientId={clientId}
          engineDispatch={engineDispatch}
          contextItems={contextItems}
          viewerIsClient={viewerIsClient}
          setup={setup}
          initialPane="data"
          stayOnPage
          onClose={() => setSettingUp(false)}
        />
      )}
    </Card>
  );
}
