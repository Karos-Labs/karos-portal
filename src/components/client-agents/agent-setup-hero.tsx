"use client";

import {
  RunCustomAgentModal,
  type AgentSetupState,
  type RunnableAgentSummary,
} from "@/components/custom-agents";
import type { EngineDispatchMap } from "@/lib/agent-engine/engine-dispatch-map";
import type { ContextItem } from "@/lib/types";

/**
 * Surface 03, State 1 — an intake-driven agent that is not set up yet.
 *
 * The fields are the section: the run form drawn in the page on its data pane
 * (`inline`, see RunCustomAgentModal). It was a large Sparkles button that
 * opened the same form in a dialog, which Albert called "a huge ai button and
 * then a pop up once you click it" (2026-09-10). Which fields an agent needs is
 * declared in `custom-agent-launch.ts` and the page prefetches the intake, so
 * there was nothing for the press to discover.
 *
 * Scoped to intake-driven agents (X/LinkedIn/Reddit/Newsletter/Blog/
 * Reputation/Carousel — the ones `AgentSetupState` can answer readiness for).
 * The umbrella launch card is a different product model and is untouched. Once
 * `setup.ready && setup.standUpDone` are both true the page's legacy panel
 * takes over.
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
  /** Forwarded to the run form — see `EngineDispatchMap` (T-B21). */
  engineDispatch: EngineDispatchMap;
  contextItems: ContextItem[];
  viewerIsClient: boolean;
  setup: AgentSetupState;
  previewVideoUrl?: string | null;
}) {
  return (
    <div className="space-y-4">
      {/* NO PLACEHOLDER FRAME (round 6, think-agents §4): the frame returns only
          when there is a video in it. */}
      {previewVideoUrl && (
        <div className="overflow-hidden rounded-[var(--radius)] border border-border bg-surface-2">
          <video src={previewVideoUrl} controls className="aspect-video w-full bg-black" />
        </div>
      )}
      <RunCustomAgentModal
        agent={agent}
        clientId={clientId}
        engineDispatch={engineDispatch}
        contextItems={contextItems}
        viewerIsClient={viewerIsClient}
        setup={setup}
        initialPane="data"
        inline
      />
    </div>
  );
}
