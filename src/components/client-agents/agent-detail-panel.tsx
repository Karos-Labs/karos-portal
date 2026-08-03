"use client";

import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { Button } from "@/components/ui";
import { Icon } from "@/components/icon";
import { ContactUsButton } from "@/components/contact-us-modal";
import { AgentScheduleModal, CancelRunControl } from "@/components/custom-agents";
import { ClientAgentFeedbackModal } from "./feedback-modal";
import { OptionsRow, StaffSlotNotes, TemplateRows, WeekStrip } from "./live-card";
import { SlotNoteModal } from "./slot-note-modal";
import { OptionPicked, OptionPicker } from "./option-picker";
import { noRunnableTemplateReason, visibleTemplates } from "@/lib/client-agent-runs";
import { runClientAgentTemplateAction } from "@/lib/actions/client-agent-run-actions";
import type { AgentArchetype } from "@/lib/agent-archetype";
import type { ClientAgentCardRow, TemplateDetail } from "./types";

/**
 * What one run of this agent makes, in the client's words (CD-I1).
 *
 * "Create a new post" is wrong on a clip maker and wrong on a Reddit agent, and
 * a control that misnames its own output is how a client presses a button
 * expecting one thing and is billed for another.
 */
const OUTPUT_NOUN: Record<AgentArchetype, string> = {
  template_calendar: "post",
  clip_maker: "clip",
  daily_finder: "reply",
};

/**
 * The interactive half of an agent's detail page (CD-G1).
 *
 * Everything a client can DO to their agent lives here, and only here: make a
 * post now, steer it with feedback, pause or reorder its formats, change its
 * pace. The roster card that opens this page carries none of it - Albert's
 * ruling is that a run gesture belongs next to the context that explains what
 * it costs and produces, and a grid of cards is not that place.
 *
 * The sections are the WP-2/WP-3 components, lifted rather than forked:
 * TemplateRows, WeekStrip, OptionsRow and the feedback modal are imported from
 * where they already live. A second implementation of a per-template run would
 * be a second gate to keep in step with the server's, which is exactly the
 * F131 hazard the shared pure gate exists to remove.
 *
 * THE CHURN RULE (A3/A4) is unchanged by the move. The week strip still carries
 * a day and a label and nothing else; there is still no batch run history, no
 * draft count, no "ready" marker. A bigger surface is not permission to say
 * more - it is more room to say the same things legibly.
 */
export function AgentDetailPanel({
  agent,
  viewerIsClient,
  viewer,
  archetype = "template_calendar",
  staffNotes,
  templateDetails,
}: {
  agent: ClientAgentCardRow;
  viewerIsClient: boolean;
  viewer?: { name: string; email: string };
  /**
   * Which page shape this panel is the CONTROLS band of (CD-I1).
   *
   * Only `template_calendar` renders the format registry and the week strip.
   * The other two archetypes lead with their own product - a video gallery, a
   * day's finds - and this panel sits under it carrying the gestures that are
   * common to all three: run, steer, pace. Suppressing the two sections is not
   * cosmetic: template rows on a clip maker would offer per-format runs for
   * formats that do not exist, and a second calendar strip under the daily
   * finder's own would show the same days twice in two vocabularies.
   */
  archetype?: AgentArchetype;
  /** Staff only: the client's per-day notes, rendered beside the plan (B2). */
  staffNotes?: boolean;
  /**
   * What clicking a format opens onto (CD-K1) - its full reasoning and the
   * posts made under it, joined server-side on `Asset.templateKey`.
   *
   * Threaded rather than fetched here for the reason everything else on this
   * row is: the join runs through `agentProducedAssets`, so a client's list
   * inherits the delivered-work-only archive filter instead of a component
   * deciding for itself what counts as a post.
   */
  templateDetails?: Record<string, TemplateDetail>;
}) {
  const router = useRouter();
  const [feedback, setFeedback] = useState<
    { scope: "agent" } | { scope: "template"; key: string; name: string } | null
  >(null);
  const [scheduling, setScheduling] = useState(false);
  const [noteDay, setNoteDay] = useState<ClientAgentCardRow["week"][number] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [running, setRunning] = useState(false);
  const [, startTransition] = useTransition();

  const templates = visibleTemplates(agent);
  const noun = OUTPUT_NOUN[archetype];
  // The format registry and the plan strip belong to the template-calendar
  // shape alone - the other two archetypes render their own product above this
  // panel and would otherwise say the same thing twice.
  const showTemplates = archetype === "template_calendar";
  const showWeek = archetype !== "daily_finder";

  // "Create new post" is the page's primary gesture, and it has to resolve to a
  // REAL format - the server runs one template, never an abstract "post". The
  // first format whose gate allows it is the one it uses, and the button names
  // it, so nobody presses a button whose output they cannot predict. When every
  // format is blocked the button carries the first gate's own reason (F25)
  // rather than a generic "unavailable", and it is disabled by the same
  // server-evaluated gate the action re-checks (F131).
  const runnableTemplate = templates.find((t) => agent.templateGates[t.key]?.allowed) ?? null;
  const blocked = templates
    .map((t) => agent.templateGates[t.key])
    .filter((gate) => gate && !gate.allowed);
  // A PAUSED FORMAT IS THE WEAKEST REASON, and it used to win by being first
  // (AF-10). This button is not about one format — it is the page's primary
  // gesture, and it picks whichever format is runnable — so quoting the registry's
  // first blocked gate meant a client whose first format happened to be paused
  // read "This format is paused" while the real answer for every other format was
  // that they were out of credits. The credits rung is also the one that comes
  // with a way out (the Contact-us row below), and it was being hidden by a state
  // the client themselves chose and can undo from the row's own toggle.
  //
  // Ordered rather than special-cased on `credits_short`, so the same rule holds
  // for a setup block or a launch-state block arriving behind a paused row.
  const firstBlock =
    blocked.find((gate) => gate?.code !== "template_paused") ?? blocked[0];
  // An empty registry produces NO gate to quote, so the two shapes that
  // legitimately have no templates - options-mode (final) and a live umbrella
  // whose formats are not seeded yet (temporary) - used to get a dead button
  // with nothing beside it. Same F25 rule: paint the reason or do not disable.
  const blockReason =
    firstBlock?.reason ??
    noRunnableTemplateReason({ optionsMode: agent.optionsMode, hasTemplates: templates.length > 0 });

  function createPost() {
    if (!runnableTemplate) return;
    setError(null);
    setRunning(true);
    startTransition(async () => {
      const result = await runClientAgentTemplateAction({
        clientId: agent.clientId,
        clientAgentId: agent.id,
        templateKey: runnableTemplate.key,
      });
      setRunning(false);
      if (result.error) setError(result.error);
      else router.refresh();
    });
  }

  return (
    <div className="space-y-6">
      {/* The one run this page acknowledges: one the viewer pressed. Scheduled
          fires stay invisible - a "ran 2 hours ago · 7 drafts" line beside a
          week of daily slots is the tell that the days are a batch (§4.1). */}
      {agent.activeRun && (
        <div className="rounded-[var(--radius)] border border-info/30 bg-info/10">
          <div className="flex items-start gap-2 px-4 py-3">
            <span
              className="mt-1.5 h-1.5 w-1.5 shrink-0 rounded-full bg-info animate-pulse-neon"
              aria-hidden="true"
            />
            <p className="text-xs text-info">
              Making your {agent.activeRun.templateName ?? "next"} {noun} now. This takes 10–20
              minutes. Your Karos team reviews it when it lands, and finished work appears in your
              Workspace once approved.
            </p>
          </div>
          {/* F30, restored. The cancel used to ride the generic run rows, and
              CD-G1 removed those from the client's branch - leaving a client
              who mis-fired a billable twenty-minute run with no way to stop it
              and no page to reach that could. The banner is where a client now
              meets that run, so the existing control mounts here rather than a
              second one being written for it. */}
          <CancelRunControl
            runId={agent.activeRun.id}
            refunds={agent.availableCredits !== undefined}
          />
        </div>
      )}

      {/* ── Create new post / clip / reply ── */}
      <section>
        <div className="flex flex-wrap items-center gap-3 rounded-[var(--radius)] border border-border bg-surface-2/50 p-4">
          <div className="min-w-0 flex-1">
            <p className="text-sm text-foreground">Create a new {noun}</p>
            <p className="mt-0.5 text-xs text-muted-2">
              {runnableTemplate
                ? `Makes one ${runnableTemplate.name} ${noun} now. It takes 10–20 minutes, and your Karos team reviews it before it reaches your Workspace.`
                : `Making a ${noun} now is not available yet.`}
            </p>
          </div>
          <Button
            variant="accent"
            disabled={!runnableTemplate || running}
            loading={running}
            onClick={createPost}
          >
            <Icon name="Sparkles" className="h-4 w-4" />
            {agent.runCost != null
              ? `Create new ${noun} · ${agent.runCost} credits`
              : `Create new ${noun}`}
          </Button>
        </div>
        {/* The reason it is off, PAINTED. The Button primitive sets
            disabled:pointer-events-none, so a title on a disabled control can
            never be read, and a reason nobody can read is the same as none. */}
        {!runnableTemplate && blockReason && (
          <div className="mt-2 rounded-[var(--radius)] border border-warning/30 bg-warning/10 px-4 py-2.5">
            <p className="text-xs text-warning">{blockReason}</p>
            {/* The intake rung links the page that fixes it, the same way the
                launch card does for its own intake block. */}
            {firstBlock?.code === "setup_missing" && agent.setupHref && (
              <a
                href={agent.setupHref}
                className="mt-1 inline-block text-xs text-neon hover:underline"
              >
                {agent.setupLabel ?? "Your agent details"} →
              </a>
            )}
            {firstBlock?.code === "credits_short" && viewer && (
              <div className="-mx-4">
                <ContactUsButton variant="row" userName={viewer.name} userEmail={viewer.email} />
              </div>
            )}
          </div>
        )}
        {error && <p className="mt-2 text-xs text-warning">{error}</p>}
      </section>

      {/* ── The formats this agent writes ── template-calendar only. A clip
          maker has no format registry to render (its umbrella binds with no
          chain family and no templates), and the daily finder's product is the
          day's find, which the panel above this one already showed. */}
      {showTemplates && (
      <section>
        <SectionHeading
          title={agent.optionsMode ? "What you get" : "Formats"}
          hint={
            agent.optionsMode
              ? undefined
              : "Each format is a different kind of post. Pause the ones you do not want, and use the arrows to change which comes first."
          }
        />
        {agent.optionsMode ? (
          /* WP-9 retires D6's placeholder. That row existed to describe the
             product without promising the picker, because the picker did not
             exist; it does now, so today's three options ARE the row. The
             placeholder survives only for a day whose options have not been
             assigned yet - where it is still the honest thing to say. */
          agent.today ? (
            agent.today.pickedDirection ? (
              <OptionPicked direction={agent.today.pickedDirection} />
            ) : (
              <OptionPicker
                clientId={agent.clientId}
                slotId={agent.today.slotId}
                options={agent.today.options}
              />
            )
          ) : (
            <OptionsRow />
          )
        ) : (
          <TemplateRows
            agent={agent}
            templates={templates}
            viewerIsClient={viewerIsClient}
            {...(templateDetails ? { details: templateDetails } : {})}
            {...(viewer ? { viewer } : {})}
            onFeedback={(template) =>
              setFeedback({ scope: "template", key: template.key, name: template.name })
            }
            onError={setError}
          />
        )}
      </section>
      )}

      {/* ── Coming up ── */}
      {showWeek && agent.week.length > 0 && (
        <section>
          {/* The strip is where a client can say something about ONE day
              (§4.3). It stays intent-only: a note marker says the client wrote
              something, which they already know, and still reveals nothing
              about whether that day's post exists yet. */}
          <WeekStrip week={agent.week} clientId={agent.clientId} onNote={setNoteDay} />
          {/* B2: the notes reach the people who apply them. The live CARD has
              always mounted this for staff; the detail page is where staff now
              read an agent, so without it the notes a client leaves had no
              staff surface again the moment the card grid was retired. */}
          {staffNotes && <StaffSlotNotes clientId={agent.clientId} week={agent.week} />}
        </section>
      )}

      {/* ── Steering: feedback + pace ── */}
      <section>
        <SectionHeading
          title="Steer this agent"
          hint="Feedback shapes everything it makes from here on. Pace decides how often it works."
        />
        <div className="flex flex-wrap items-center gap-2">
          <Button variant="subtle" onClick={() => setFeedback({ scope: "agent" })}>
            <Icon name="MessageSquare" className="h-4 w-4" /> Give feedback
          </Button>
          {agent.runnable && (
            <Button variant="subtle" onClick={() => setScheduling(true)}>
              <Icon name="SlidersHorizontal" className="h-4 w-4" /> Adjust pace
            </Button>
          )}
          <p className="text-xs text-muted-2">
            {agent.runCost != null ? `${agent.runCost} credits per ${noun}` : "Staff runs are free"}
          </p>
        </div>
      </section>

      {feedback && (
        <ClientAgentFeedbackModal
          clientId={agent.clientId}
          clientAgentId={agent.id}
          agentName={agent.displayName}
          scope={feedback.scope}
          {...(feedback.scope === "template"
            ? { templateKey: feedback.key, templateName: feedback.name }
            : {})}
          rows={agent.feedback}
          viewerIsClient={viewerIsClient}
          onClose={() => setFeedback(null)}
        />
      )}
      {noteDay && (
        <SlotNoteModal
          clientId={agent.clientId}
          day={noteDay}
          onClose={() => setNoteDay(null)}
        />
      )}
      {scheduling && agent.runnable && (
        <AgentScheduleModal
          agent={agent.runnable}
          clientId={agent.clientId}
          // Clients get the pace face of this dialog: how many posts a week,
          // never how they are batched (D3 / A3-A4).
          paceOnly={viewerIsClient}
          {...(agent.schedule ? { schedule: agent.schedule } : {})}
          {...(agent.availableCredits !== undefined
            ? { availableCredits: agent.availableCredits }
            : {})}
          onClose={() => setScheduling(false)}
        />
      )}
    </div>
  );
}

function SectionHeading({ title, hint }: { title: string; hint?: string }) {
  return (
    <div className="mb-2.5">
      <h2 className="font-mono text-[10px] uppercase tracking-[0.08em] text-muted">{title}</h2>
      {hint && <p className="mt-1 text-xs text-muted-2">{hint}</p>}
    </div>
  );
}
