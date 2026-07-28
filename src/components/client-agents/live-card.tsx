"use client";

import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { Badge, Button } from "@/components/ui";
import { Icon } from "@/components/icon";
import { AgentIdentity } from "@/components/agent-identity";
import { ContactUsButton } from "@/components/contact-us-modal";
import { AgentScheduleModal } from "@/components/custom-agents";
import { ClientAgentFeedbackModal } from "./feedback-modal";
import { moveTemplateKey, visibleTemplates } from "@/lib/client-agent-runs";
import { markSlotNoteAppliedAction } from "@/lib/actions/slot-note-actions";
import { relativeTime } from "@/lib/utils";
import {
  reorderClientAgentTemplatesAction,
  runClientAgentTemplateAction,
  setClientAgentTemplateStatusAction,
} from "@/lib/actions/client-agent-run-actions";
import type { ClientAgentTemplate } from "@/lib/types";
import type { ClientAgentCardRow } from "./types";
import { cn } from "@/lib/utils";

/**
 * The LIVE client agent (Phase 3 §7.1 cards 4 and 5).
 *
 * This is the card the whole umbrella exists for: the client's agent, its
 * template streams, what is coming this week, and the two ways to steer it
 * (feedback and pace). It replaces today's generic custom-agent card for
 * umbrella-bound agents — the page decides which one an agent gets.
 *
 * THE CHURN RULE (A3/A4) governs every line here. Nothing on this card may
 * reveal that content for a future day already exists:
 *  • the week strip paints template NAMES on days, never posts, never counts,
 *    and never a "ready"/"generated" distinction — the server sends a label and
 *    a date and nothing else, so there is no state here to leak;
 *  • there is no batch run history, no "7 drafts" pill, no last-run line. A row
 *    reading "ran 2 hours ago · 7 assets" beside a week of daily slots is the
 *    tell that the days are a presentation of a batch (§4.1 items 3–4);
 *  • "Run now" is offered per FORMAT, phrased as making one post now, because
 *    that is exactly what it does.
 *
 * Every disabled control paints its reason (F25): the Button primitive sets
 * `disabled:pointer-events-none`, so a `title` on a disabled control can never
 * be read, and a reason nobody can read is the same as no reason. The gates
 * themselves are evaluated SERVER-side with the same pure function the actions
 * run (client-agent-runs.ts), so no row can offer a press the server refuses.
 */
export function ClientAgentLiveCard({
  agent,
  viewerIsClient,
  viewer,
}: {
  agent: ClientAgentCardRow;
  viewerIsClient: boolean;
  viewer?: { name: string; email: string };
}) {
  const [feedback, setFeedback] = useState<
    { scope: "agent" } | { scope: "template"; key: string; name: string } | null
  >(null);
  const [scheduling, setScheduling] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const templates = visibleTemplates(agent);
  // A refused schedule outranks "Live" (the F24/F129 precedence the generic
  // card already follows): an agent whose every fire is being turned away is
  // not live, whatever its umbrella says.
  const refusal = agent.schedule?.status === "active" ? agent.schedule.lastError?.trim() || null : null;

  return (
    <div className="card-grad group relative flex flex-col overflow-hidden rounded-[var(--radius)] border border-border p-5 transition-all duration-200 hover:border-border-strong">
      <span
        className="absolute inset-x-0 top-0 h-0.5 bg-foreground/40 opacity-45 transition-opacity group-hover:opacity-80"
        aria-hidden="true"
      />
      <div className="flex items-start gap-3">
        <AgentIdentity identity={agent.identity} icon={agent.icon} />
        <div className="min-w-0 flex-1">
          <p className="mb-1 font-mono text-[9px] uppercase tracking-[0.16em] text-muted-2">
            AI agent
          </p>
          <div className="flex flex-wrap items-center gap-2">
            <p className="truncate text-base font-medium">{agent.displayName}</p>
            {refusal ? (
              <Badge tone="warning">Needs attention</Badge>
            ) : (
              <Badge tone="success">
                <span
                  className="h-1.5 w-1.5 rounded-full bg-success animate-pulse-neon"
                  aria-hidden="true"
                />
                Live
              </Badge>
            )}
          </div>
          {agent.blurb && (
            <p className="mt-0.5 line-clamp-2 text-xs leading-relaxed text-muted">{agent.blurb}</p>
          )}
        </div>
      </div>

      {refusal && (
        <div className="mt-3 rounded-md border border-warning/30 bg-warning/10 px-3 py-2">
          <p className="text-[11px] text-warning">{refusal}</p>
          {viewer && (
            <div className="-mx-3">
              <ContactUsButton variant="row" userName={viewer.name} userEmail={viewer.email} />
            </div>
          )}
        </div>
      )}

      {/* The only run this card acknowledges: one the viewer pressed. It takes
          10–20 minutes and there is no run row under an umbrella card, so
          without this "Run now" looked like it did nothing (F31's medicine).
          The sentence is the run-STARTED form the design pins (§3 / v2.1), the
          same one the generic run dialog uses — future tense, because nobody is
          reviewing anything yet. */}
      {agent.activeRun && (
        <div className="mt-3 flex items-center gap-2 rounded-md border border-info/30 bg-info/10 px-3 py-2">
          <span
            className="h-1.5 w-1.5 shrink-0 rounded-full bg-info animate-pulse-neon"
            aria-hidden="true"
          />
          <p className="text-[11px] text-info">
            Making your {agent.activeRun.templateName ?? "next"} post now — this takes 10–20
            minutes. Your Karos team reviews it when it lands, and finished posts appear in your
            Workspace once approved.
          </p>
        </div>
      )}

      {agent.optionsMode ? (
        <OptionsRow />
      ) : (
        <TemplateRows
          agent={agent}
          templates={templates}
          viewer={viewer}
          onFeedback={(template) =>
            setFeedback({ scope: "template", key: template.key, name: template.name })
          }
          onError={setError}
        />
      )}

      <WeekStrip week={agent.week} />
      {/* B2: the notes reach the people who apply them. */}
      {!viewerIsClient && <StaffSlotNotes clientId={agent.clientId} week={agent.week} />}

      <div className="mt-auto flex flex-wrap items-center justify-between gap-2 border-t border-border/60 pt-3">
        <p className="text-xs text-muted-2">
          {agent.runCost != null ? `${agent.runCost} credits per post` : "Staff runs are free"}
        </p>
        <div className="flex gap-1.5">
          <Button size="sm" variant="ghost" onClick={() => setFeedback({ scope: "agent" })}>
            <Icon name="MessageSquare" className="h-3.5 w-3.5" /> Give feedback
          </Button>
          {agent.runnable && (
            <Button size="sm" variant="subtle" onClick={() => setScheduling(true)}>
              <Icon name="SlidersHorizontal" className="h-3.5 w-3.5" /> Adjust pace
            </Button>
          )}
        </div>
      </div>
      {error && <p className="mt-2 text-[11px] text-warning">{error}</p>}

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

/* ───────────────────────────── template rows ────────────────────────────── */

export function TemplateRows({
  agent,
  templates,
  viewer,
  onFeedback,
  onError,
}: {
  agent: ClientAgentCardRow;
  templates: ClientAgentTemplate[];
  viewer?: { name: string; email: string };
  onFeedback: (template: ClientAgentTemplate) => void;
  onError: (message: string | null) => void;
}) {
  const router = useRouter();
  const [busyKey, setBusyKey] = useState<string | null>(null);
  const [, startTransition] = useTransition();

  if (templates.length === 0) {
    return (
      <p className="mt-4 rounded-md border border-border bg-surface-2/70 px-3 py-2 text-xs text-muted-2">
        This agent has no formats registered yet — your Karos team is setting them up.
      </p>
    );
  }

  const keys = templates.map((t) => t.key);

  function run(template: ClientAgentTemplate) {
    onError(null);
    setBusyKey(template.key);
    startTransition(async () => {
      const result = await runClientAgentTemplateAction({
        clientId: agent.clientId,
        clientAgentId: agent.id,
        templateKey: template.key,
      });
      setBusyKey(null);
      if (result.error) onError(result.error);
      else router.refresh();
    });
  }

  function togglePause(template: ClientAgentTemplate) {
    onError(null);
    setBusyKey(template.key);
    startTransition(async () => {
      const result = await setClientAgentTemplateStatusAction({
        clientId: agent.clientId,
        clientAgentId: agent.id,
        templateKey: template.key,
        status: template.status === "active" ? "paused" : "active",
      });
      setBusyKey(null);
      if (result.error) onError(result.error);
      else router.refresh();
    });
  }

  function move(template: ClientAgentTemplate, direction: "up" | "down") {
    onError(null);
    setBusyKey(template.key);
    startTransition(async () => {
      const result = await reorderClientAgentTemplatesAction({
        clientId: agent.clientId,
        clientAgentId: agent.id,
        orderedKeys: moveTemplateKey(keys, template.key, direction),
      });
      setBusyKey(null);
      if (result.error) onError(result.error);
      else router.refresh();
    });
  }

  return (
    <ul className="mt-4 space-y-2">
      {templates.map((template, index) => {
        const gate = agent.templateGates[template.key];
        const allowed = gate?.allowed ?? false;
        const paused = template.status === "paused";
        const busy = busyKey === template.key;
        return (
          <li
            key={template.key}
            className={cn(
              "rounded-md border border-border bg-surface-2/70 px-3 py-2",
              paused && "opacity-70",
            )}
          >
            <div className="flex items-start gap-2">
              <div className="min-w-0 flex-1">
                <div className="flex flex-wrap items-center gap-2">
                  <p className="truncate text-sm text-foreground">{template.name}</p>
                  {paused && <Badge tone="neutral">Paused</Badge>}
                </div>
                {template.rationale && (
                  <p className="mt-0.5 line-clamp-2 text-[11px] leading-relaxed text-muted-2">
                    {template.rationale}
                  </p>
                )}
              </div>
              <div className="flex shrink-0 items-center gap-0.5">
                <Button
                  size="sm"
                  variant="ghost"
                  aria-label={`Move ${template.name} up`}
                  disabled={index === 0 || busy}
                  onClick={() => move(template, "up")}
                >
                  <Icon name="ChevronUp" className="h-3.5 w-3.5" />
                </Button>
                <Button
                  size="sm"
                  variant="ghost"
                  aria-label={`Move ${template.name} down`}
                  disabled={index === templates.length - 1 || busy}
                  onClick={() => move(template, "down")}
                >
                  <Icon name="ChevronDown" className="h-3.5 w-3.5" />
                </Button>
              </div>
            </div>
            <div className="mt-1.5 flex flex-wrap items-center gap-1.5">
              <Button
                size="sm"
                variant="ghost"
                disabled={!allowed || busy}
                loading={busy}
                onClick={() => run(template)}
              >
                <Icon name="Play" className="h-3.5 w-3.5" />
                {agent.runCost != null ? `Run now · ${agent.runCost} credits` : "Run now"}
              </Button>
              <Button size="sm" variant="ghost" onClick={() => onFeedback(template)}>
                <Icon name="MessageSquare" className="h-3.5 w-3.5" /> Feedback
              </Button>
              <Button size="sm" variant="ghost" disabled={busy} onClick={() => togglePause(template)}>
                <Icon name={paused ? "Play" : "Pause"} className="h-3.5 w-3.5" />
                {paused ? "Resume" : "Pause"}
              </Button>
            </div>
            {/* The reason the run is off, PAINTED — not a tooltip on a control
                that cannot receive a pointer. A paused format explains itself
                through its own toggle, so only the other blockers get a line. */}
            {!allowed && gate?.reason && gate.code !== "template_paused" && (
              <div className="mt-1.5 space-y-1 border-t border-border/60 pt-1.5">
                <p className="text-[11px] text-warning">{gate.reason}</p>
                {gate.code === "credits_short" && viewer && (
                  <div className="-mx-3">
                    <ContactUsButton variant="row" userName={viewer.name} userEmail={viewer.email} />
                  </div>
                )}
              </div>
            )}
          </li>
        );
      })}
    </ul>
  );
}

/* ──────────────────────── options mode (X, card 5) ──────────────────────── */

/**
 * The daily pick-of-3 product has no template streams — its product IS the
 * day's choice (§4.5).
 *
 * The picker lands with WP-9. Until it does, this row may only describe what
 * actually ships in this branch (D6): the previous copy said "Pick the one you
 * like, edit it if you want, and post it", which describes three controls that
 * do not exist anywhere in the portal yet. A client who read it would go
 * looking for them. It now names only what is real — the feedback button on
 * this card, and the Workspace where approved posts land — and makes no promise
 * about a future release, since a promise dated "soon" is the same defect one
 * release later.
 */
export function OptionsRow() {
  return (
    <div className="mt-4 rounded-md border border-border bg-surface-2/70 px-3 py-2">
      <p className="text-sm text-foreground">Today&rsquo;s post</p>
      <p className="mt-0.5 text-[11px] text-muted-2">
        This agent writes one post a day for you. Use Give feedback to steer what it makes, and
        approved posts appear in your Workspace.
      </p>
    </div>
  );
}

/* ──────────────────────────────── week strip ────────────────────────────── */

const WEEKDAY = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];

/**
 * The next few days of the plan.
 *
 * A day carries a template NAME and nothing else. There is deliberately no
 * "ready"/"coming" distinction, no asset link and no count: a pre-generated
 * post and a day-of run project into an identical chip, and that
 * indistinguishability is the churn guard, not a copy choice (§4.1).
 */
export function WeekStrip({
  week,
  clientId,
  onNote,
}: {
  week: ClientAgentCardRow["week"];
  clientId?: string;
  /** Present ⇒ days are pressable and open the note editor (detail page only). */
  onNote?: (day: ClientAgentCardRow["week"][number]) => void;
}) {
  if (week.length === 0) return null;
  const interactive = Boolean(onNote && clientId);
  return (
    <div className="mt-4">
      <p className="mb-1.5 font-mono text-[10px] uppercase tracking-[0.08em] text-muted">
        Coming up
      </p>
      <ul className="flex flex-wrap gap-1.5">
        {week.map((day) => {
          const [y, mo, d] = day.dateKey.split("-").map(Number);
          const at = new Date(Date.UTC(y, mo - 1, d));
          const body = (
            <>
              <span className="text-muted-2">
                {WEEKDAY[at.getUTCDay()]} {at.getUTCDate()}
              </span>
              <span className="ml-1.5 text-foreground">{day.label}</span>
              {/* A note marker, never a fulfilment marker. It says the CLIENT
                  wrote something about this day — which they already know —
                  and reveals nothing about whether the post exists yet. */}
              {day.note && (
                <Icon
                  name="MessageSquare"
                  className="ml-1.5 inline h-3 w-3 text-neon"
                  aria-label="Has a note"
                />
              )}
            </>
          );
          return (
            <li key={day.dateKey}>
              {interactive && day.canNote ? (
                <button
                  type="button"
                  onClick={() => onNote?.(day)}
                  className="rounded-md border border-border bg-surface-2 px-2 py-1 text-[11px] transition-colors hover:border-neon/50"
                >
                  {body}
                </button>
              ) : (
                <span className="inline-block rounded-md border border-border bg-surface-2 px-2 py-1 text-[11px]">
                  {body}
                </span>
              )}
            </li>
          );
        })}
      </ul>
      {interactive && (
        <p className="mt-1.5 text-[11px] text-muted-2">
          Something specific in mind for a day? Tap it and leave a note.
        </p>
      )}
    </div>
  );
}

/* ─────────────────────── staff: notes the client left ───────────────────── */

/**
 * The notes a client left on specific days, for the people who apply them (B2).
 *
 * Path 3 of §4.3 is the one that ships: a human reads the note and folds it
 * into that day's post. That only works if the note actually reaches a human,
 * and until now it reached none — the write logged an activity row whose TITLE
 * named the day but whose text lived only in metadata nothing renders, and
 * `markSlotNoteAppliedAction` had no caller at all, so "applied" was a state the
 * product could describe and never enter.
 *
 * Staff-only, and mounted beside the plan rather than on the asset card: the
 * slot→asset link only exists once something has been matched or picked, so an
 * asset-card mount would show nothing for exactly the days that need a human.
 */
export function StaffSlotNotes({
  clientId,
  week,
}: {
  clientId: string;
  week: ClientAgentCardRow["week"];
}) {
  const router = useRouter();
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [, startTransition] = useTransition();

  const withNotes = week.filter((day) => day.note);
  if (withNotes.length === 0) return null;

  function markApplied(slotId: string) {
    setError(null);
    setBusy(slotId);
    startTransition(async () => {
      const result = await markSlotNoteAppliedAction({ clientId, slotId });
      setBusy(null);
      if (result.error) setError(result.error);
      else router.refresh();
    });
  }

  return (
    <div className="mt-4 rounded-md border border-neon/25 bg-neon-soft/20 p-3">
      <p className="mb-2 flex items-center gap-1.5 font-mono text-[10px] uppercase tracking-[0.08em] text-muted">
        <Icon name="MessageSquare" className="h-3.5 w-3.5" />
        Client notes on specific days
      </p>
      <ul className="space-y-2">
        {withNotes.map((day) => (
          <li key={day.dateKey} className="rounded-md border border-border bg-surface-2/70 p-2.5">
            <div className="flex flex-wrap items-center justify-between gap-2">
              <span className="font-mono text-[11px] text-foreground">{day.dateKey}</span>
              {day.note?.applied ? (
                <Badge tone="success">Applied</Badge>
              ) : (
                <Button
                  size="sm"
                  variant="ghost"
                  disabled={busy === day.slotId}
                  loading={busy === day.slotId}
                  onClick={() => markApplied(day.slotId)}
                >
                  Mark applied
                </Button>
              )}
            </div>
            <p className="mt-1 whitespace-pre-wrap text-xs text-foreground">{day.note?.text}</p>
            <p className="mt-1 text-[11px] text-muted-2">
              {day.note?.authorName} · {relativeTime(day.note?.createdAt ?? 0)}
            </p>
          </li>
        ))}
      </ul>
      {error && <p className="mt-2 text-[11px] text-warning">{error}</p>}
    </div>
  );
}
