"use client";

import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { Button } from "@/components/ui";
import { Icon } from "@/components/icon";
import { ContactUsButton } from "@/components/contact-us-modal";
import { AgentScheduleModal, CancelRunControl } from "@/components/custom-agents";
import { ClientAgentFeedbackModal } from "./feedback-modal";
import { OptionsRow, TemplateRows, WeekStrip } from "./live-card";
import { SlotNoteModal } from "./slot-note-modal";
import { OptionPicked, OptionPicker } from "./option-picker";
import { noRunnableTemplateReason, visibleTemplates } from "@/lib/client-agent-runs";
import { runClientAgentTemplateAction } from "@/lib/actions/client-agent-run-actions";
import type { ClientAgentCardRow } from "./types";

/**
 * The interactive half of an agent's detail page (CD-G1).
 *
 * Everything a client can DO to their agent lives here, and only here: make a
 * post now, steer it with feedback, pause or reorder its formats, change its
 * pace. The roster card that opens this page carries none of it — Albert's
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
 * more — it is more room to say the same things legibly.
 */
export function AgentDetailPanel({
  agent,
  viewerIsClient,
  viewer,
}: {
  agent: ClientAgentCardRow;
  viewerIsClient: boolean;
  viewer?: { name: string; email: string };
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

  // "Create new post" is the page's primary gesture, and it has to resolve to a
  // REAL format — the server runs one template, never an abstract "post". The
  // first format whose gate allows it is the one it uses, and the button names
  // it, so nobody presses a button whose output they cannot predict. When every
  // format is blocked the button carries the first gate's own reason (F25)
  // rather than a generic "unavailable", and it is disabled by the same
  // server-evaluated gate the action re-checks (F131).
  const runnableTemplate = templates.find((t) => agent.templateGates[t.key]?.allowed) ?? null;
  const firstBlock = templates
    .map((t) => agent.templateGates[t.key])
    .find((gate) => gate && !gate.allowed);
  // An empty registry produces NO gate to quote, so the two shapes that
  // legitimately have no templates — options-mode (final) and a live umbrella
  // whose formats are not seeded yet (temporary) — used to get a dead button
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
          fires stay invisible — a "ran 2 hours ago · 7 drafts" line beside a
          week of daily slots is the tell that the days are a batch (§4.1). */}
      {agent.activeRun && (
        <div className="rounded-[var(--radius)] border border-info/30 bg-info/10">
          <div className="flex items-start gap-2 px-4 py-3">
            <span
              className="mt-1.5 h-1.5 w-1.5 shrink-0 rounded-full bg-info animate-pulse-neon"
              aria-hidden="true"
            />
            <p className="text-xs text-info">
              Making your {agent.activeRun.templateName ?? "next"} post now — this takes 10–20
              minutes. Your Karos team reviews it when it lands, and finished posts appear in your
              Workspace once approved.
            </p>
          </div>
          {/* F30, restored. The cancel used to ride the generic run rows, and
              CD-G1 removed those from the client's branch — leaving a client
              who mis-fired a billable twenty-minute run with no way to stop it
              and no page to reach that could. The banner is where a client now
              meets that run, so the existing control mounts here rather than a
              second one being written for it. */}
          <CancelRunControl runId={agent.activeRun.id} />
        </div>
      )}

      {/* ── Create new post ── */}
      <section>
        <div className="flex flex-wrap items-center gap-3 rounded-[var(--radius)] border border-border bg-surface-2/50 p-4">
          <div className="min-w-0 flex-1">
            <p className="text-sm text-foreground">Create a new post</p>
            <p className="mt-0.5 text-xs text-muted-2">
              {runnableTemplate
                ? `Makes one ${runnableTemplate.name} post now. It takes 10–20 minutes, and your Karos team reviews it before it reaches your Workspace.`
                : "Making a post now is not available yet."}
            </p>
          </div>
          <Button
            variant="accent"
            disabled={!runnableTemplate || running}
            loading={running}
            onClick={createPost}
          >
            <Icon name="Sparkles" className="h-4 w-4" />
            {agent.runCost != null ? `Create new post · ${agent.runCost} credits` : "Create new post"}
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
                Set up your {agent.setupLabel ?? "agent data"} →
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

      {/* ── The formats this agent writes ── */}
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
             assigned yet — where it is still the honest thing to say. */
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
            {...(viewer ? { viewer } : {})}
            onFeedback={(template) =>
              setFeedback({ scope: "template", key: template.key, name: template.name })
            }
            onError={setError}
          />
        )}
      </section>

      {/* ── Coming up ── */}
      {agent.week.length > 0 && (
        <section>
          {/* The strip is where a client can say something about ONE day
              (§4.3). It stays intent-only: a note marker says the client wrote
              something, which they already know, and still reveals nothing
              about whether that day's post exists yet. */}
          <WeekStrip week={agent.week} clientId={agent.clientId} onNote={setNoteDay} />
        </section>
      )}

      {/* ── Steering: feedback + pace ── */}
      <section>
        <SectionHeading
          title="Steer this agent"
          hint="Feedback shapes everything it writes from here on. Pace decides how often it posts."
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
            {agent.runCost != null ? `${agent.runCost} credits per post` : "Staff runs are free"}
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
