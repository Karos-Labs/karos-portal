"use client";

import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { Badge, Button } from "@/components/ui";
import { Icon } from "@/components/icon";
import { SocialPlatformMark } from "@/components/agent-identity";
import { platformForAgentIdentity } from "@/lib/content-platform";
import { ContactUsButton } from "@/components/contact-us-modal";
import { NO_FORMATS_YET } from "@/lib/client-agent-format-copy";
import { moveTemplateKey } from "@/lib/client-agent-runs";
import { markSlotNoteAppliedAction } from "@/lib/actions/slot-note-actions";
import { formatDate, relativeTime } from "@/lib/utils";
import {
  reorderClientAgentTemplatesAction,
  runClientAgentTemplateAction,
  setClientAgentTemplateStatusAction,
} from "@/lib/actions/client-agent-run-actions";
import type { ClientAgentTemplate } from "@/lib/types";
import type { ClientAgentCardRow, TemplateDetail } from "./types";
import { cn } from "@/lib/utils";

/**
 * The parts of the LIVE client agent surface (Phase 3 §7.1 cards 4 and 5).
 *
 * The card that composed them - `ClientAgentLiveCard` - is gone: the archetype
 * detail pages (CD-I1) took over that job, and `agent-detail-panel.tsx` mounts
 * these pieces directly. It was exported and imported by nothing, which on a
 * "use client" module means dead weight shipped to the browser and, worse, a
 * second implementation of rules the live panel already has to get right.
 *
 * THE CHURN RULE (A3/A4) governs every line here. Nothing on this surface may
 * reveal that content for a future day already exists:
 *  • the week strip paints template NAMES on days, never posts, never counts,
 *    and never a "ready"/"generated" distinction - the server sends a label and
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

/* ───────────────────────────── template rows ────────────────────────────── */

export function TemplateRows({
  agent,
  templates,
  details,
  viewer,
  viewerIsClient,
  onFeedback,
  onError,
}: {
  agent: ClientAgentCardRow;
  templates: ClientAgentTemplate[];
  /**
   * What clicking a format opens onto (CD-K1), keyed by template key.
   *
   * Optional so the rows still render for a caller that has not joined the
   * archive - the expansion is the extra, never the row's reason to exist.
   */
  details?: Record<string, TemplateDetail>;
  viewer?: { name: string; email: string };
  /**
   * A client's `postCount` is the archive set, which drops published work past
   * its window - the same reason the page labels its own count "In your
   * Workspace" rather than a lifetime total. The copy below must make the same
   * disclosure, so the two numbers never claim to be different things.
   */
  viewerIsClient?: boolean;
  onFeedback: (template: ClientAgentTemplate) => void;
  onError: (message: string | null) => void;
}) {
  const router = useRouter();
  const [busyKey, setBusyKey] = useState<string | null>(null);
  const [openKey, setOpenKey] = useState<string | null>(null);
  const [, startTransition] = useTransition();

  // The launch card says this too, for the same empty registry — so the sentence
  // lives in client-agent-format-copy and both read it. It used to be written
  // twice, and the two copies had already drifted: the other one called a format
  // a "template stream", which is the schema's word and not the client's.
  if (templates.length === 0) {
    return (
      <p className="mt-4 rounded-md border border-border bg-surface-2/70 px-3 py-2 text-xs text-muted-2">
        {NO_FORMATS_YET}
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
        const detail = details?.[template.key];
        const open = openKey === template.key;
        return (
          <li
            key={template.key}
            className={cn(
              "rounded-md border border-border bg-surface-2/70 px-3 py-2 transition-colors",
              paused && "opacity-70",
              open && "border-neon/40",
            )}
          >
            <div className="flex items-start gap-2">
              <div className="min-w-0 flex-1">
                <div className="flex flex-wrap items-center gap-2">
                  {/* Pressable only when there is something behind it. A
                      disclosure that opens onto nothing is a control that lied
                      about having content. */}
                  {detail ? (
                    <button
                      type="button"
                      aria-expanded={open}
                      onClick={() => setOpenKey(open ? null : template.key)}
                      className="flex min-w-0 items-center gap-1 text-left"
                    >
                      <Icon
                        name="ChevronRight"
                        className={cn(
                          "h-3.5 w-3.5 shrink-0 text-muted-2 transition-transform",
                          open && "rotate-90",
                        )}
                        aria-hidden="true"
                      />
                      <span className="truncate text-sm text-foreground hover:text-neon">
                        {template.name}
                      </span>
                    </button>
                  ) : (
                    <p className="truncate text-sm text-foreground">{template.name}</p>
                  )}
                  {paused && <Badge tone="neutral">Paused</Badge>}
                  {detail && detail.postCount > 0 && (
                    <span className="text-[11px] text-muted-2">
                      {viewerIsClient
                        ? `${detail.postCount} in your Workspace`
                        : `${detail.postCount} post${detail.postCount === 1 ? "" : "s"}`}
                    </span>
                  )}
                </div>
                {template.rationale && !open && (
                  <p className="mt-0.5 line-clamp-2 text-[11px] leading-relaxed text-muted-2">
                    {template.rationale}
                  </p>
                )}
                {/* ── AF-6: an example of each format, without opening it ──
                    Albert asked to see "the different templates we produce for
                    that client and an example of each". The expansion below has
                    always listed a format's posts, but a reader scanning the list
                    had a column of names and no idea what any of them look like.

                    Collapsed only, deliberately: the expansion opens onto the
                    same set with this very post at the top of it, so painting
                    both would show one deliverable twice under two headings.

                    Nothing here is a new permission — `detail.example` is the
                    newest row of the same archive-filtered join the list uses, so
                    a client sees an example only of work that has been delivered
                    to them. */}
                {detail?.example && !open && (
                  <div className="mt-1.5 flex items-center gap-2 rounded-md border border-border/60 bg-surface-2 px-2 py-1.5">
                    {detail.example.imageUrl ? (
                      // eslint-disable-next-line @next/next/no-img-element
                      <img
                        src={detail.example.imageUrl}
                        alt=""
                        className="h-9 w-9 shrink-0 rounded object-cover"
                        loading="lazy"
                      />
                    ) : (
                      <span className="flex h-9 w-9 shrink-0 items-center justify-center rounded bg-surface-2/70 text-muted-2">
                        <Icon name="FileText" className="h-3.5 w-3.5" aria-hidden="true" />
                      </span>
                    )}
                    <span className="min-w-0 flex-1">
                      <span className="block font-mono text-[10px] uppercase tracking-[0.08em] text-muted-2">
                        Example
                      </span>
                      <span className="block truncate text-[11px] text-foreground">
                        {detail.example.title}
                      </span>
                    </span>
                    <span className="shrink-0 text-[11px] text-muted-2">
                      {relativeTime(detail.example.at)}
                    </span>
                  </div>
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
                Run now
              </Button>
              {/* Portal revamp, Surface 03: the cost is a step on the page,
                  never on the button — a visible sibling, not folded into the
                  button's own label. */}
              {agent.runCost != null && (
                <span className="flex items-center gap-1 text-[11px] text-muted-2">
                  <Icon name="Coins" className="h-3 w-3 text-neon" />
                  {agent.runCost} credit{agent.runCost === 1 ? "" : "s"}
                </span>
              )}
              <Button size="sm" variant="ghost" onClick={() => onFeedback(template)}>
                <Icon name="MessageSquare" className="h-3.5 w-3.5" /> Feedback
              </Button>
              <Button size="sm" variant="ghost" disabled={busy} onClick={() => togglePause(template)}>
                <Icon name={paused ? "Play" : "Pause"} className="h-3.5 w-3.5" />
                {paused ? "Resume" : "Pause"}
              </Button>
            </div>
            {/* ── The format, opened (CD-K1) ──
                Why this stream exists, and everything it has actually made.
                The post list is the SAME set the page's archive rides - a
                client's is delivered-work-only, joined server-side on
                Asset.templateKey - so opening a format can never become a
                second route to work that has not been delivered. There is no
                status, no draft count and no "ready" marker anywhere in it,
                for the reason the week strip has none (§4.1). */}
            {open && detail && (
              <div className="mt-2 animate-fade-up space-y-2 border-t border-border/60 pt-2">
                {detail.rationale && (
                  <p className="text-[11px] leading-relaxed text-muted">{detail.rationale}</p>
                )}
                <p className="font-mono text-[10px] uppercase tracking-[0.08em] text-muted-2">
                  {detail.postCount === 0
                    ? "Nothing under this format yet"
                    : `${viewerIsClient ? "In your Workspace under this format" : "What it has made in this format"}${
                        detail.postCount > detail.posts.length
                          ? ` · newest ${detail.posts.length} of ${detail.postCount}`
                          : ""
                      }`}
                </p>
                {detail.posts.length === 0 ? (
                  <p className="text-[11px] text-muted-2">
                    Finished work appears here once your Karos team has approved it.
                  </p>
                ) : (
                  <ul className="space-y-1">
                    {detail.posts.map((post) => (
                      <li
                        key={post.id}
                        className="flex items-center justify-between gap-3 rounded-md border border-border bg-surface-2 px-2 py-1.5"
                      >
                        <span className="min-w-0 flex-1 truncate text-[11px] text-foreground">
                          {post.title}
                        </span>
                        <span className="shrink-0 text-[11px] text-muted-2">
                          {relativeTime(post.at)}
                        </span>
                      </li>
                    ))}
                  </ul>
                )}
                {/* The cap is deliberate - this is a peek at a stream, not the
                    archive - but "newest 6 of 23" with no way to reach the
                    other 17 is a dead end. The Workspace is where all of them
                    already live, and it is the same href the page's archive
                    section links, so the two cannot drift apart. */}
                {detail.postCount > detail.posts.length && (
                  <a
                    href={`/clients/${agent.clientId}/assets`}
                    className="inline-flex items-center gap-1 text-[11px] text-neon hover:underline"
                  >
                    See all in your Workspace
                    <Icon name="ArrowRight" className="h-3 w-3" />
                  </a>
                )}
                <p className="text-[11px] text-muted-2">
                  Added {formatDate(detail.addedAt)}
                  {detail.source === "manual" ? " by your Karos team" : ""}
                </p>
              </div>
            )}
            {/* The reason the run is off, PAINTED - not a tooltip on a control
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
 * The daily pick-of-3 product has no template streams - its product IS the
 * day's choice (§4.5).
 *
 * The picker lands with WP-9. Until it does, this row may only describe what
 * actually ships in this branch (D6): the previous copy said "Pick the one you
 * like, edit it if you want, and post it", which describes three controls that
 * do not exist anywhere in the portal yet. A client who read it would go
 * looking for them. It now names only what is real - the feedback button on
 * this card, and the Workspace where approved posts land - and makes no promise
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
 *
 * AF-20's mark is safe under that rule for one reason worth stating: it is
 * resolved from the AGENT, so it is the same glyph on every chip in the strip.
 * Reading it off a per-day asset would be the churn guard broken - days with a
 * pre-generated post would render differently from day-of days, which is
 * exactly the distinction the strip exists to withhold.
 */
export function WeekStrip({
  week,
  identity,
  clientId,
  onNote,
}: {
  week: ClientAgentCardRow["week"];
  /** The agent's `"<key> <name>"` string - the platform mark's one source here. */
  identity?: string;
  clientId?: string;
  /** Present ⇒ days are pressable and open the note editor (detail page only). */
  onNote?: (day: ClientAgentCardRow["week"][number]) => void;
}) {
  if (week.length === 0) return null;
  const interactive = Boolean(onNote && clientId);
  const platform = identity ? platformForAgentIdentity(null, identity) : null;
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
              {platform && (
                <SocialPlatformMark platform={platform} className="mr-1.5 inline h-3 w-3 align-[-0.1em] text-muted-2" />
              )}
              <span className="text-muted-2">
                {WEEKDAY[at.getUTCDay()]} {at.getUTCDate()}
              </span>
              <span className="ml-1.5 text-foreground">{day.label}</span>
              {/* A note marker, never a fulfilment marker. It says the CLIENT
                  wrote something about this day - which they already know -
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
 * and until now it reached none - the write logged an activity row whose TITLE
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
