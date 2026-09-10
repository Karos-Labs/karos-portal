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
 * ── IT WAS A BUTTON THAT OPENED A FORM ───────────────────────────────────────
 *
 * This rendered one sentence ("Save what LinkedIn Agent needs to know, and it
 * starts producing for you") over a large accent button with a Sparkles glyph,
 * and the button's only job was to open `RunCustomAgentModal` on its data
 * pane. Albert, 2026-09-10: "still looks like slop. a huge ai button and then a
 * pop up once you click it."
 *
 * Both halves of that were earned:
 *
 *  • THE BUTTON GATED A KNOWN FORM. Which fields an agent needs is not
 *    discovered on click — `custom-agent-launch.ts` declares every agent's
 *    inputs as data, and the page already prefetches the intake. So the press
 *    revealed something the page could simply have shown, and cost the reader a
 *    click and a context switch to reach it.
 *  • THE GLYPH SAID "AI" INSTEAD OF SAYING WHAT HAPPENS. A sparkle on the
 *    primary control is the generic signifier for "machine does magic here",
 *    and on a page that is entirely about a machine it carries no information —
 *    only the tone Albert named. The run verbs elsewhere on this page are plain
 *    words, and this is now one of them.
 *
 * So the fields are the section. Same component, same logic, same save path —
 * `inline` only moves where it paints (see `InlinePanel`). What used to be the
 * page's biggest object is now the thing the reader came to do.
 *
 * Scoped to intake-driven agents (X/LinkedIn/Reddit/Newsletter/Blog/
 * Reputation/Carousel — the ones `AgentSetupState` can answer readiness for).
 * The umbrella-launch-card system is a different, older product model with its
 * own flow and is untouched. Once `setup.ready && setup.standUpDone` are both
 * true the page's legacy panel takes over, unchanged.
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
        stayOnPage
        inline
        // Nothing to close: the form is part of the page. The component still
        // calls this after a save that finishes the setup, and a refresh is
        // what moves the page on to the next state from here.
        onClose={() => {}}
      />
    </div>
  );
}
