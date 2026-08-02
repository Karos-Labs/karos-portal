"use client";

import { useState, useRef, useTransition } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { Icon } from "@/components/icon";
import { AgentMark } from "@/components/agent-identity";
import { Button } from "@/components/ui";
import { cn } from "@/lib/utils";
import { CLIENT_SAFE_ACTOR, SYSTEM_AI_ACTOR_NAME } from "@/lib/activity-actors";
import { researchReportReadyTitle } from "@/lib/activity-titles";
import { intakePageAction } from "@/lib/agent-intake-links";
// The run-state register, from the pure module rather than components/job-status
// — that file re-exports these words but drags `Badge` and JSX along, and this
// row wants the label without the badge.
import { jobStatusLabel } from "@/lib/job-status-copy";
import { addActivityNoteAction } from "@/lib/actions";
import type { ActivityEventType, ClientReport, Job, Role } from "@/lib/types";

/**
 * The ONLY job fields this timeline may hold.
 *
 * It used to take `Job[]`, which the server built by spreading whole job
 * documents — so every row of the payload carried the run's `input` (the
 * operator's prompt and brief), its `events` (the internal execution trace),
 * `clientAgentId`, and `meta.agentsRepoSha`, the git SHA of the private lab
 * repo. None of it is painted; all of it is readable in the RSC payload, which
 * is precisely the case this codebase's redaction rule exists for. Five fields
 * are what the timeline renders, so five fields are what it receives.
 */
export type TimelineJob = Pick<
  Job,
  "id" | "agentName" | "status" | "title" | "createdAt" | "error"
>;

/**
 * The ONLY activity-log fields this timeline may hold — the jobs rule above,
 * applied to the other half of the stream.
 *
 * It used to take `ActivityLog[]` straight off the data layer. That carried
 * `clientId` and a free-form `metadata` bag nothing here paints, and — worse —
 * it carried the row's stored `actor` verbatim, so the internal writer names
 * ("Runway autopilot" and friends, see activity-actors.ts) were sanitized in
 * the BROWSER, on a list the browser had already downloaded. Staff MANUAL_NOTE
 * rows travelled the same way: written by a staff-only composer, filtered out
 * at render, present in full in the RSC payload.
 *
 * Both are now decided server-side (tasks-body.tsx), so what arrives is already
 * this viewer's timeline: client-safe actor names, and no rows they may not
 * read. Staff receive the same fields with nothing redacted.
 */
export interface TimelineActivity {
  id: string;
  timestamp: number;
  type: ActivityEventType;
  title: string;
  description?: string;
  actor: string;
  actorRole: "system" | "staff" | "client";
}

/* ── Unified display event ───────────────────────────────────────────── */

interface TimelineEvent {
  id: string;
  timestamp: number;
  type: ActivityEventType;
  title: string;
  description?: string;
  actor: string;
  actorRole: "system" | "staff" | "client";
  /** Agent name for agent-run events — resolves the real platform logo. */
  agentIdentity?: string;
}

/* ── Event derivation ────────────────────────────────────────────────── */

function eventsFromLogs(logs: TimelineActivity[]): TimelineEvent[] {
  // A straight rename into TimelineEvent's shape. The actor arrives already
  // redacted for this viewer and the staff-only rows are already gone — both
  // decided at the RSC boundary, because an internal string that reaches the
  // browser is readable whether or not this function ever paints it.
  return logs.map((l) => ({
    id: l.id,
    timestamp: l.timestamp,
    type: l.type,
    title: l.title,
    description: l.description,
    actor: l.actor,
    actorRole: l.actorRole,
  }));
}

/**
 * The staff face of the jobs stream: one row per run, titled with that run's
 * OWN state.
 *
 * Every row used to be titled `<agent> delivered a draft`, with no reference to
 * `j.status` — a field the projection does carry (TimelineJob above,
 * populated in tasks-body.tsx). A queued run, a running one, a cancelled one
 * and a failed one all announced a delivery, so this timeline could not be read
 * for run state at all. The status reached the row in exactly one place, the
 * DESCRIPTION, which printed `Failed: …` underneath — so a failed run rendered
 * a single row that claimed the delivery and reported the failure in the same
 * breath.
 *
 * The words come from the run-state register (`job-status-copy.ts`), not from a
 * map spelled here. That register exists because "what do we call this run
 * state" had been answered in more than one place and the copies disagreed —
 * its own docstring names which, and no count is repeated here, because a count
 * in a comment is a claim this file cannot check. Another local answer is the
 * defect, not the fix. The `Failed:` prefix went with the change — the title carries
 * the state now, and printing it twice was how the row contradicted itself in
 * the first place. The error text itself stays, unprefixed, and is still the
 * raw operator-facing message: this branch is staff-only (the client branch
 * below takes its copy from `clientSafeRefusal` at the server boundary).
 *
 * RESIDUAL, stated because the row cannot fix it: the STAMP is `j.createdAt`,
 * the instant the run was submitted, while the LABEL is the run's state as of
 * this render. A run submitted Monday and delivered Tuesday sits under Monday
 * reading "Delivered". Jobs carry no per-transition timestamps, so an honest
 * "delivered at" is a data-layer change rather than a rendering one.
 *
 * Exported for test: a node run cannot mount this component (the staff branch
 * renders AddNoteForm, which calls useRouter), and the rule worth pinning is
 * that no two run states share a title.
 */
export function eventsFromJobs(jobs: TimelineJob[]): TimelineEvent[] {
  return jobs.map((j) => ({
    id: `job:${j.id}`,
    timestamp: j.createdAt,
    type: "CAMPAIGN_CREATED" as ActivityEventType,
    title: `${j.agentName} · ${jobStatusLabel(j.status)}`,
    // The stored error REPLACES the run's own title only when there is one. A
    // failed run with no message used to read "Failed: Unknown error", a phrase
    // that says nothing the title does not now say by itself.
    description: (j.status === "failed" && j.error ? j.error : j.title) || undefined,
    actor: "Staff",
    actorRole: "staff" as const,
    agentIdentity: j.agentName,
  }));
}

/** Server-local calendar day — the grain a client's timeline is aggregated to. */
function dayKeyOf(t: number): string {
  const d = new Date(t);
  return `${d.getFullYear()}-${d.getMonth()}-${d.getDate()}`;
}

/**
 * The client face of the same jobs: ONE row per agent per day (A3/A4).
 *
 * Per-run rows are the batch tell in its purest form. A week of "daily" posts
 * is produced by one or two fires, so the client's timeline printed several
 * "<agent> delivered a draft" lines carrying the SAME minute — the generation
 * lump, itemised, on the screen whose whole job is to narrate steady work. It
 * also said "delivered a draft", and a draft is precisely the thing that is not
 * delivered to a client: it is staff-reviewed first (approveAssetAction calls
 * requireStaff) and the archive excludes it by design.
 *
 * So runs collapse to one row per agent per day, stamped at that day's last
 * fire, and the run's internal title (the catalog product code plus the client
 * name) is dropped. Failures stay one row each — a failed run is a distinct
 * event with its own message — but under a title that matches what happened.
 *
 * AND THAT IS WHY THIS BRANCH DOES NOT ASK `job-status-copy` the way the staff
 * branch above now does. The register answers "what is this ONE run's state
 * called"; a collapsed row has no one run and therefore no one state, and the
 * two words it does need ("worked on your content", "couldn't finish a run")
 * are the only two distinctions a client is told. Pointing this branch at the
 * register to make the two halves match would republish the run ladder —
 * Queued, Running, In review — to the viewer the collapse exists to keep it
 * from.
 */
function clientEventsFromJobs(jobs: TimelineJob[]): TimelineEvent[] {
  const events: TimelineEvent[] = [];
  const days = new Map<string, { agentName: string; at: number }>();

  for (const j of jobs) {
    if (j.status === "failed") {
      events.push({
        id: `job:${j.id}`,
        timestamp: j.createdAt,
        type: "CAMPAIGN_CREATED",
        title: `${j.agentName} couldn't finish a run`,
        // Already routed through clientSafeRefusal at the server boundary.
        description: j.error ?? undefined,
        actor: CLIENT_SAFE_ACTOR,
        actorRole: "system",
        agentIdentity: j.agentName,
      });
      continue;
    }
    const key = `${dayKeyOf(j.createdAt)}::${j.agentName}`;
    const seen = days.get(key);
    if (seen) seen.at = Math.max(seen.at, j.createdAt);
    else days.set(key, { agentName: j.agentName, at: j.createdAt });
  }

  for (const [key, day] of days) {
    events.push({
      id: `job-day:${key}`,
      timestamp: day.at,
      type: "CAMPAIGN_CREATED",
      title: `${day.agentName} worked on your content`,
      actor: CLIENT_SAFE_ACTOR,
      actorRole: "system",
      agentIdentity: day.agentName,
    });
  }

  return events;
}

/**
 * The one row on this timeline with no stored actor.
 *
 * Everything else arrives already redacted from the server projection, which is
 * where a STORED actor has to be decided — a name redacted after the payload
 * shipped has already shipped. This row is derived here, from the report prop,
 * and it signed itself "System AI": an INTERNAL_ACTORS name, reaching a
 * client's timeline through the one door that projection does not cover. Same
 * registry, same answer; the split is by viewer, so staff still see which
 * system wrote it.
 */
function eventsFromReport(report: ClientReport | null, viewerIsClient: boolean): TimelineEvent[] {
  if (!report) return [];
  return [
    {
      id: `report:${report.id}`,
      timestamp: report.createdAt,
      type: "INTEL_GENERATION" as ActivityEventType,
      // Same words the two WRITERS store, from one home: a client reads either
      // this derived row or a persisted one, never both (hasIntelLog below).
      title: researchReportReadyTitle(),
      description: `Full competitive analysis · Score: ${report.overallScore}/100 (${report.overallGrade}) · ${report.reportDate}`,
      actor: viewerIsClient ? CLIENT_SAFE_ACTOR : SYSTEM_AI_ACTOR_NAME,
      actorRole: "system" as const,
    },
  ];
}

function buildEvents(
  logs: TimelineActivity[],
  jobs: TimelineJob[],
  report: ClientReport | null,
  currentUserRole: Role,
): TimelineEvent[] {
  const viewerIsClient = currentUserRole === "CLIENT_USER";
  // No MANUAL_NOTE filter here any more: staff notes are dropped at the server
  // boundary, the same place the launch runs are dropped from `jobs`. Filtering
  // a second time here would be a second answer to "may this viewer read this
  // row", and the one that runs after the payload has shipped is the one that
  // does not count.
  const logEvents = eventsFromLogs(logs);

  // Deduplicate: if an INTEL_GENERATION log already exists for a date close to the
  // report's createdAt (within 5 min), don't also show the derived report event.
  const hasIntelLog = logEvents.some((e) => e.type === "INTEL_GENERATION");
  const reportEvents = hasIntelLog ? [] : eventsFromReport(report, viewerIsClient);

  const jobEvents =
    viewerIsClient ? clientEventsFromJobs(jobs) : eventsFromJobs(jobs);

  const all = [...logEvents, ...jobEvents, ...reportEvents];
  // Sort newest first, stable-ish via id as tiebreaker
  return all.sort((a, b) => b.timestamp - a.timestamp || a.id.localeCompare(b.id));
}

/* ── Event type config ───────────────────────────────────────────────── */

/**
 * The GLYPH each event type draws with. Presentation only — no words.
 *
 * IT CARRIED A `label` AND NOTHING RENDERED IT. `EventRow` reads `icon`,
 * `dotClass` and `iconClass`; the eleven labels beside them were painted
 * nowhere, on any surface, for either viewer. That is worse than dead weight
 * here: it was a second vocabulary for `ActivityEventType`, in Title Case
 * against the sentence-case rule, and one of its entries was the internal
 * product name ("Intel Report") that `researchReportReadyTitle` exists to keep
 * off a client's timeline. A row's words come from its `title` — written by the
 * server (activity-titles.ts) or derived above — and an unrendered map of
 * alternative names is exactly what somebody wires up later because it is
 * sitting there looking authoritative.
 *
 * Deleted rather than corrected: correcting it would have kept a second answer
 * to "what is this event called", spelled better.
 */
const EVENT_CONFIG: Record<
  ActivityEventType,
  { icon: string; dotClass: string; iconClass: string }
> = {
  SCRAPE: { icon: "Globe", dotClass: "bg-surface", iconClass: "text-foreground/70" },
  INTEL_GENERATION: {
    icon: "ChartNoAxesColumn",
    dotClass: "bg-surface",
    iconClass: "text-foreground/70",
  },
  CAMPAIGN_CREATED: { icon: "Bot", dotClass: "bg-surface", iconClass: "text-foreground/70" },
  CAMPAIGN_DELIVERED: { icon: "Mail", dotClass: "bg-surface", iconClass: "text-foreground/70" },
  COMPETITOR_ADDED: { icon: "UserPlus", dotClass: "bg-surface", iconClass: "text-foreground/70" },
  COMPETITOR_REMOVED: {
    icon: "UserMinus",
    dotClass: "bg-surface",
    iconClass: "text-foreground/70",
  },
  COMPETITOR_ANALYZED: {
    icon: "Sparkles",
    dotClass: "bg-surface",
    iconClass: "text-foreground/70",
  },
  CONTEXT_DOC_UPDATED: {
    icon: "FileText",
    dotClass: "bg-surface",
    iconClass: "text-foreground/70",
  },
  MANUAL_NOTE: {
    icon: "MessageSquare",
    dotClass: "bg-surface",
    iconClass: "text-foreground/70",
  },
  CLIENT_CREATED: { icon: "UserCheck", dotClass: "bg-surface", iconClass: "text-foreground/70" },
  BRANDING_UPDATED: { icon: "Palette", dotClass: "bg-surface", iconClass: "text-foreground/70" },
};

/* ── Date helpers ────────────────────────────────────────────────────── */

function getDateLabel(timestamp: number): string {
  const now = new Date();
  const d = new Date(timestamp);
  const todayStart = new Date(now.getFullYear(), now.getMonth(), now.getDate()).getTime();
  const eventDay = new Date(d.getFullYear(), d.getMonth(), d.getDate()).getTime();
  const diffDays = Math.round((todayStart - eventDay) / 86400000);
  if (diffDays === 0) return "Today";
  if (diffDays === 1) return "Yesterday";
  return d.toLocaleDateString("en-US", {
    month: "short",
    day: "numeric",
    year: now.getFullYear() !== d.getFullYear() ? "numeric" : undefined,
  });
}

function formatTime(timestamp: number): string {
  return new Date(timestamp).toLocaleTimeString("en-US", {
    hour: "numeric",
    minute: "2-digit",
    hour12: true,
  });
}

/* ── Sub-components ──────────────────────────────────────────────────── */

function DateDivider({ label }: { label: string }) {
  return (
    <div className="flex items-center gap-3 py-1">
      {/* spacer to align with icon column */}
      <div className="h-px w-10 shrink-0 bg-transparent" />
      <div className="flex flex-1 items-center gap-2">
        <span className="shrink-0 text-[10px] font-semibold uppercase tracking-widest text-muted-2">
          {label}
        </span>
        <div className="h-px flex-1 bg-border" />
      </div>
    </div>
  );
}

function EventRow({ event, isLast }: { event: TimelineEvent; isLast: boolean }) {
  const cfg = EVENT_CONFIG[event.type] ?? EVENT_CONFIG.CAMPAIGN_CREATED;
  return (
    <div className={cn("flex gap-3", !isLast && "pb-5")}>
      {/* Icon dot */}
      <div
        className={cn(
          "relative z-10 flex h-10 w-10 shrink-0 items-center justify-center rounded-md",
          cfg.dotClass,
        )}
      >
        {event.agentIdentity ? (
          <AgentMark identity={event.agentIdentity} icon={cfg.icon} className={cn("h-4 w-4", cfg.iconClass)} />
        ) : (
          <Icon name={cfg.icon} className={cn("h-4 w-4", cfg.iconClass)} />
        )}
      </div>

      {/* Content */}
      <div className="flex-1 min-w-0 pt-[9px]">
        <div className="flex items-start justify-between gap-3">
          <p className="text-sm font-semibold leading-tight text-foreground">{event.title}</p>
          <span className="shrink-0 text-[11px] tabular-nums text-muted-2">
            {formatTime(event.timestamp)}
          </span>
        </div>
        <p className="mt-0.5 text-xs text-muted-2">
          <span
            className={cn(
              "font-medium",
              event.actorRole === "system" && "text-muted",
              event.actorRole === "staff" && "text-muted",
              event.actorRole === "client" && "text-muted",
            )}
          >
            {event.actor}
          </span>
          {event.description && (
            <>
              <span className="mx-1 opacity-40">·</span>
              {event.description}
            </>
          )}
        </p>
      </div>
    </div>
  );
}

/* ── Add Note form ───────────────────────────────────────────────────── */

function AddNoteForm({ clientId }: { clientId: string }) {
  const router = useRouter();
  const [text, setText] = useState("");
  const [adding, startAdd] = useTransition();
  const [error, setError] = useState<string | null>(null);
  const textareaRef = useRef<HTMLTextAreaElement>(null);

  function submit() {
    const trimmed = text.trim();
    if (!trimmed) return;
    setError(null);
    startAdd(async () => {
      try {
        await addActivityNoteAction(clientId, trimmed);
        setText("");
        router.refresh();
      } catch (e) {
        setError(e instanceof Error ? e.message : "Failed to save note");
      }
    });
  }

  return (
    <div className="mb-5 space-y-1.5">
      <div className="flex gap-2">
        <div className="flex h-10 w-10 shrink-0 items-center justify-center rounded-md bg-surface-2">
          <Icon name="MessageSquare" className="h-4 w-4 text-muted-2" />
        </div>
        <textarea
          ref={textareaRef}
          value={text}
          onChange={(e) => {
            setText(e.target.value);
            setError(null);
          }}
          onKeyDown={(e) => {
            if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) submit();
          }}
          disabled={adding}
          rows={2}
          placeholder="Add an internal note… (⌘↵ to save)"
          className={cn(
            "flex-1 resize-none rounded-md border border-border bg-surface-2 px-3 py-2 text-sm text-foreground placeholder:text-muted-2 outline-none transition-colors",
            "focus:border-neon/50 focus:ring-1 focus:ring-neon/20",
            "disabled:cursor-not-allowed disabled:opacity-50",
            error && "border-danger/50",
          )}
        />
        <Button
          size="sm"
          onClick={submit}
          disabled={!text.trim() || adding}
          loading={adding}
          className="self-end"
        >
          <Icon name="Send" className="h-3.5 w-3.5" />
        </Button>
      </div>
      {error && <p className="pl-12 text-[11px] text-danger">{error}</p>}
    </div>
  );
}

/* ── Main component ──────────────────────────────────────────────────── */

const PAGE_SIZE = 15;

interface Props {
  activityLogs: TimelineActivity[];
  jobs: TimelineJob[];
  report: ClientReport | null;
  clientId: string;
  currentUserRole: Role;
}

export function ActivityTimeline({
  activityLogs,
  jobs,
  report,
  clientId,
  currentUserRole,
}: Props) {
  const [shown, setShown] = useState(PAGE_SIZE);

  const isStaff = currentUserRole === "KAROS_ADMIN" || currentUserRole === "KAROS_EMPLOYEE";

  // #92. THE EMPTY STATE IS THE FIRST THING A BRAND-NEW CLIENT SEES ON THIS TAB,
  // and it read "Run an agent →" over a hard-coded link to `/clients/<id>/agents`
  // — the roster whose client branch states in its own comment that it carries no
  // Run button ("a client's run gesture lives only inside a detail page"). That
  // made this the FOURTH control offering a run on a page built to refuse one, so
  // it asks the resolver the other three already ask instead of being edited into
  // a fourth spelling of the same promise.
  //
  // `agentId: null` is the honest answer FROM HERE, not a shortcut. This is a
  // browser component handed a serialized timeline; resolving "which of this
  // client's agents may they open" is a Firestore read, and the surface that
  // mounts it (progress-view.tsx → tasks-body.tsx) is not this change's to edit.
  // So the resolver returns its no-destination branch: the roster, named for what
  // it is, with the verb dropped. It is also the state this empty state describes
  // — a client with nothing on their timeline yet is the client least likely to
  // have a resolvable instance.
  //
  // The real `isStaff` is passed rather than a literal `false`, so the wording
  // stays correct if the control is ever shown to both roles; today only the
  // client branch renders it.
  const runControl = intakePageAction({ clientId, isStaff, agentId: null });

  const allEvents = buildEvents(activityLogs, jobs, report, currentUserRole);
  const visibleEvents = allEvents.slice(0, shown);
  const remaining = allEvents.length - shown;

  // Group by date label for section dividers
  const grouped: Array<{ label: string; events: TimelineEvent[] }> = [];
  for (const event of visibleEvents) {
    const label = getDateLabel(event.timestamp);
    const last = grouped[grouped.length - 1];
    if (last?.label === label) {
      last.events.push(event);
    } else {
      grouped.push({ label, events: [event] });
    }
  }

  return (
    <div>
      {/* Add Note — staff only */}
      {isStaff && <AddNoteForm clientId={clientId} />}

      {/* Empty state */}
      {allEvents.length === 0 && (
        <div className="flex flex-col items-center gap-3 rounded-md border border-dashed border-border py-12 text-center">
          <div className="flex h-12 w-12 items-center justify-center rounded-md bg-surface-2">
            <Icon name="History" className="h-6 w-6 text-muted-2" />
          </div>
          <div>
            <p className="text-sm font-medium text-foreground">No activity yet</p>
            {/* Manual notes are stripped from a client's timeline, and "Intel
                Report" is an internal product name — so neither belongs in a
                list of what to expect (QA F73). */}
            <p className="mt-1 text-xs text-muted-2">
              Every agent run, brand update, and competitor change shows up here as your team works.
            </p>
            {!isStaff && (
              /* The label and the href come from the same call and are rendered
                 on the same element — the arrow rides inside the resolved label,
                 so a control that has lost its destination cannot keep an arrow
                 pointing at one. */
              <Link
                href={runControl.href}
                className="mt-2 inline-flex items-center gap-1 text-xs font-medium text-neon hover:underline"
              >
                {runControl.label}
              </Link>
            )}
          </div>
        </div>
      )}

      {/* Timeline */}
      {allEvents.length > 0 && (
        <div className="relative">
          {/* Vertical connector line — positioned at center of 40px icon column */}
          <div className="absolute left-5 top-0 bottom-0 w-px bg-border" />

          <div>
            {grouped.map((group) => (
              <div key={group.label}>
                <DateDivider label={group.label} />
                <div className="pt-3">
                  {group.events.map((event, i) => (
                    <EventRow
                      key={event.id}
                      event={event}
                      isLast={i === group.events.length - 1}
                    />
                  ))}
                </div>
              </div>
            ))}
          </div>

          {/* Load more */}
          {remaining > 0 && (
            <div className="flex justify-center pt-4">
              <button
                onClick={() => setShown((s) => s + PAGE_SIZE)}
                className="text-xs text-muted-2 underline-offset-2 hover:text-foreground hover:underline transition-colors"
              >
                Show {Math.min(remaining, PAGE_SIZE)} more
                {remaining > PAGE_SIZE && ` of ${remaining}`}
              </button>
            </div>
          )}
        </div>
      )}
    </div>
  );
}
