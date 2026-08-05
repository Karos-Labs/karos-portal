"use client";

import { useState } from "react";
import { Button } from "@/components/ui";
import { Icon } from "@/components/icon";
import { ContactUsButton } from "@/components/contact-us-modal";
import { ManagedJobProgress } from "@/components/managed-job-progress";
import {
  AgentScheduleModal,
  CancelRunControl,
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
 * detail page rendered a stub - a sentence saying it was producing, and nothing
 * else - so the agent Albert screenshots most often was the one with no way to
 * make a post, no way to change its pace, and no sign of anything it had ever
 * made.
 *
 * WHAT IT GETS: the two gestures that need no umbrella. "Create a new post" is
 * the standard priced custom-agent run - the same dialog, launch profile and
 * charge path the generic card uses, not a second implementation. "Adjust pace"
 * is the same paceOnly schedule modal the live card uses, and it is offered
 * because the schedule is exactly what this shape DOES have - it lives in
 * SchedulePaceCard below, which the page seats in the status strip's aside
 * slot rather than in this panel's own column.
 *
 * IT ALSO GETS THE RUN BACK (F31). Pressing "Create a new post" here used to
 * produce no visible change whatsoever: the panel showed no run row and no
 * progress, and the page mounted no AutoRefresh for this branch, so a client sat
 * on a static page for the twenty minutes the run takes with no way to tell
 * whether anything had started - and, once F30's control was reachable again,
 * nothing to cancel from. The strip is the pieces that already exist, not a new
 * idiom: the same banner promise the umbrella panel makes, the ManagedJobProgress
 * strip the run rows use, and the same CancelRunControl. What the run PRODUCES
 * still arrives the umbrella way - under "What it has made for you" on the page
 * below, which links the Workspace.
 *
 * WHAT IT DOES NOT GET, deliberately: template rows, the week strip, per-template
 * feedback, notes. Every one of those reads the umbrella's registry or its slot
 * plan, and this agent has neither. Faking them would put invented streams in
 * front of a client - the §9 backfill script is the real fix, and it creates the
 * umbrella rather than pretending one exists.
 *
 * The gate is evaluated SERVER-side and painted, never a title on a disabled
 * control (F25 - the Button primitive sets disabled:pointer-events-none, so a
 * tooltip there can never be read).
 */
export function LegacyAgentPanel({
  clientId,
  agent,
  cost,
  gate,
  setup,
  contextItems,
  viewerIsClient,
  viewer,
  activeRun,
  outageAnnounced,
}: {
  clientId: string;
  agent: RunnableAgentSummary;
  /** Null for staff - quoting them a price they never pay would be a lie. */
  cost: number | null;
  /** Server-evaluated, already resolved to a paintable reason (F25/F131). */
  gate: LegacyRunGateResult;
  /**
   * This agent's run that has not landed yet (F31). Resolved server-side from
   * the client's own jobs, and deliberately just an id and a phase - the strip
   * says a run is happening, never what it will contain.
   */
  activeRun?: { id: string; status: "queued" | "running"; refunds: boolean } | null;
  /**
   * The page has ALREADY said runs are paused, in its own banner.
   *
   * Both lines are warning-styled and land about 150px apart, saying the same
   * thing in two wordings ("...will not work until this clears" / "...will work
   * again once your Karos team clears it"), which reads as two separate
   * problems. The banner is the page-level statement and keeps its wording; the
   * button below it is disabled and its sub-line already says a run is not
   * available, so the gate's own paragraph is what gives way.
   */
  outageAnnounced?: boolean;
  setup?: AgentSetupState;
  contextItems: ContextItem[];
  viewerIsClient: boolean;
  viewer?: { name: string; email: string };
}) {
  const [running, setRunning] = useState(false);

  return (
    <div className="space-y-6">
      {activeRun && (
        <div className="rounded-[var(--radius)] border border-info/30 bg-info/10">
          <div className="flex items-start gap-2 px-4 py-3">
            <span
              className="mt-1.5 h-1.5 w-1.5 shrink-0 rounded-full bg-info animate-pulse-neon"
              aria-hidden="true"
            />
            <p className="text-xs text-info">
              Making your next post now. This takes 10–20 minutes. Your Karos team reviews it when
              it lands, and finished posts appear in your Workspace once approved.
            </p>
          </div>
          <ManagedJobProgress
            status={activeRun.status}
            className="mb-0 rounded-none border-0 border-t border-info/20 bg-transparent px-4 py-2"
          />
          <CancelRunControl runId={activeRun.id} refunds={activeRun.refunds} />
        </div>
      )}

      <section>
        <div className="flex flex-wrap items-center gap-3 rounded-[var(--radius)] border border-border bg-surface-2/50 p-4">
          {/* `basis-56 grow`, not `flex-1`: flex-1 is basis-0, so in a narrow
              column the label had no preferred width at all and shrank to
              about 30px - "Create a new post" wrapped one word per line and the
              button rode over it. A basis wide enough for the sentence means
              the row wraps the BUTTON to its own line instead, which is what
              flex-wrap is on this container for. */}
          <div className="min-w-0 basis-56 grow">
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
        {!gate.allowed && gate.reason && !(outageAnnounced && gate.code === "service_down") && (
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

      {running && (
        <RunCustomAgentModal
          agent={agent}
          clientId={clientId}
          contextItems={contextItems}
          viewerIsClient={viewerIsClient}
          {...(setup ? { setup } : {})}
          // AF-9: this panel IS the agent's page, for both readers. A client
          // already stayed here; a staff member was redirected to /jobs/<id>,
          // away from the run banner and the cancel control this very panel
          // mounts for the run they just started.
          stayOnPage
          onClose={() => setRunning(false)}
        />
      )}
    </div>
  );
}

/**
 * The legacy shape's pace-and-price summary, seated in the status strip's
 * aside slot by the agent detail page (the strip's `aside` prop).
 *
 * It replaces the "How often it posts" section this panel used to render
 * mid-column — an unstyled heading, a sentence and a floating credits line,
 * living two screens away from the status banner that answers the same
 * question ("how does this agent run?"). The copy is unchanged; only where it
 * sits and how it is framed moved. "Adjust pace" keeps the same paceOnly
 * schedule modal — clients get how many posts a week, never how they are
 * batched (D3 / A3-A4).
 */
export function SchedulePaceCard({
  clientId,
  agent,
  cost,
  schedule,
  viewerIsClient,
  availableCredits,
}: {
  clientId: string;
  agent: RunnableAgentSummary;
  /** Null for staff - quoting them a price they never pay would be a lie. */
  cost: number | null;
  schedule: ClientAgentScheduleRow | null;
  viewerIsClient: boolean;
  availableCredits?: number;
}) {
  const [scheduling, setScheduling] = useState(false);
  return (
    // Opaque bg-surface, not /70: the card sits on the strip's TINTED
    // backgrounds, and in light mode a translucent fill dragged muted-2's
    // 12px copy just under the 4.5:1 floor QA F119 re-established for it
    // (~4.46:1). Opaque surface keeps the documented ~4.7:1.
    <div className="rounded-md border border-border/70 bg-surface px-3 py-2.5">
      <h2 className="font-mono text-[10px] uppercase tracking-[0.08em] text-muted">
        How often it posts
      </h2>
      <p className="mt-1 text-xs text-muted-2">
        {schedule
          ? "This agent is already posting for you on a schedule. Change how often whenever you like."
          : "This agent has no schedule yet. Your Karos team sets one up."}
      </p>
      <div className="mt-2 flex flex-wrap items-center gap-x-3 gap-y-1.5">
        {schedule && (
          <Button size="sm" variant="subtle" onClick={() => setScheduling(true)}>
            <Icon name="SlidersHorizontal" className="h-3.5 w-3.5" /> Adjust pace
          </Button>
        )}
        <p className="text-xs text-muted-2">
          {cost != null ? `${cost} credits per post` : "Staff runs are free"}
        </p>
      </div>
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
