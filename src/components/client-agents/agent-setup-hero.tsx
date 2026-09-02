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
      <div className="overflow-hidden rounded-[var(--radius)] border border-border bg-surface-2">
        {previewVideoUrl ? (
          <video src={previewVideoUrl} controls className="aspect-video w-full bg-black" />
        ) : (
          <div className="flex aspect-video w-full flex-col items-center justify-center gap-2 text-muted-2">
            <Icon name="Video" className="h-8 w-8" />
            <p className="text-xs">A preview of what this agent does is coming soon.</p>
          </div>
        )}
      </div>

      <div className="mt-4 flex flex-col items-center gap-2 text-center">
        <p className="text-sm text-muted-2">
          Save what {agent.name} needs to know, and it starts producing for you.
        </p>
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
