"use client";

import { useState, useRef, useTransition } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { Icon } from "@/components/icon";
import { AgentMark } from "@/components/agent-identity";
import { Button } from "@/components/ui";
import { cn } from "@/lib/utils";
import { addActivityNoteAction } from "@/lib/actions";
import { clientSafeActor } from "@/lib/activity-actors";
import type { ActivityEventType, ActivityLog, ClientReport, Job, Role } from "@/lib/types";

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

function eventsFromLogs(logs: ActivityLog[], viewerIsClient: boolean): TimelineEvent[] {
  return logs.map((l) => ({
    id: l.id,
    timestamp: l.timestamp,
    type: l.type,
    title: l.title,
    description: l.description,
    // The row stores whatever its writer put there, and the automated writers
    // put internal service names in it ("Runway autopilot" via submitManagedJob's
    // synthetic admin). Redacted HERE, at the projection, so every caller of
    // this timeline gets it — staff keep the real name.
    ...clientSafeActor(l.actor, l.actorRole, viewerIsClient),
  }));
}

function eventsFromJobs(jobs: TimelineJob[]): TimelineEvent[] {
  return jobs.map((j) => ({
    id: `job:${j.id}`,
    timestamp: j.createdAt,
    type: "CAMPAIGN_CREATED" as ActivityEventType,
    title: `${j.agentName} delivered a draft`,
    description:
      j.status === "failed"
        ? `Failed: ${j.error ?? "Unknown error"}`
        : j.title || undefined,
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
        actor: "Karos",
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
      actor: "Karos",
      actorRole: "system",
      agentIdentity: day.agentName,
    });
  }

  return events;
}

function eventsFromReport(report: ClientReport | null): TimelineEvent[] {
  if (!report) return [];
  return [
    {
      id: `report:${report.id}`,
      timestamp: report.createdAt,
      type: "INTEL_GENERATION" as ActivityEventType,
      title: "Research report ready",
      description: `Full competitive analysis · Score: ${report.overallScore}/100 (${report.overallGrade}) · ${report.reportDate}`,
      actor: "System AI",
      actorRole: "system" as const,
    },
  ];
}

function buildEvents(
  logs: ActivityLog[],
  jobs: TimelineJob[],
  report: ClientReport | null,
  currentUserRole: Role,
): TimelineEvent[] {
  const viewerIsClient = currentUserRole === "CLIENT_USER";
  const logEvents = eventsFromLogs(logs, viewerIsClient).filter(
    (e) => viewerIsClient === false || e.type !== "MANUAL_NOTE",
  );

  // Deduplicate: if an INTEL_GENERATION log already exists for a date close to the
  // report's createdAt (within 5 min), don't also show the derived report event.
  const hasIntelLog = logEvents.some((e) => e.type === "INTEL_GENERATION");
  const reportEvents = hasIntelLog ? [] : eventsFromReport(report);

  const jobEvents =
    viewerIsClient ? clientEventsFromJobs(jobs) : eventsFromJobs(jobs);

  const all = [...logEvents, ...jobEvents, ...reportEvents];
  // Sort newest first, stable-ish via id as tiebreaker
  return all.sort((a, b) => b.timestamp - a.timestamp || a.id.localeCompare(b.id));
}

/* ── Event type config ───────────────────────────────────────────────── */

const EVENT_CONFIG: Record<
  ActivityEventType,
  { icon: string; dotClass: string; iconClass: string; label: string }
> = {
  SCRAPE: {
    icon: "Globe",
    dotClass: "bg-surface",
    iconClass: "text-foreground/70",
    label: "Website Scraped",
  },
  INTEL_GENERATION: {
    icon: "ChartNoAxesColumn",
    dotClass: "bg-surface",
    iconClass: "text-foreground/70",
    label: "Intel Report",
  },
  CAMPAIGN_CREATED: {
    icon: "Bot",
    dotClass: "bg-surface",
    iconClass: "text-foreground/70",
    label: "Campaign",
  },
  CAMPAIGN_DELIVERED: {
    icon: "Mail",
    dotClass: "bg-surface",
    iconClass: "text-foreground/70",
    label: "Delivered",
  },
  COMPETITOR_ADDED: {
    icon: "UserPlus",
    dotClass: "bg-surface",
    iconClass: "text-foreground/70",
    label: "Competitor Added",
  },
  COMPETITOR_REMOVED: {
    icon: "UserMinus",
    dotClass: "bg-surface",
    iconClass: "text-foreground/70",
    label: "Competitor Removed",
  },
  COMPETITOR_ANALYZED: {
    icon: "Sparkles",
    dotClass: "bg-surface",
    iconClass: "text-foreground/70",
    label: "AI Analysis",
  },
  CONTEXT_DOC_UPDATED: {
    icon: "FileText",
    dotClass: "bg-surface",
    iconClass: "text-foreground/70",
    label: "Docs Updated",
  },
  MANUAL_NOTE: {
    icon: "MessageSquare",
    dotClass: "bg-surface",
    iconClass: "text-foreground/70",
    label: "Note",
  },
  CLIENT_CREATED: {
    icon: "UserCheck",
    dotClass: "bg-surface",
    iconClass: "text-foreground/70",
    label: "Client Created",
  },
  BRANDING_UPDATED: {
    icon: "Palette",
    dotClass: "bg-surface",
    iconClass: "text-foreground/70",
    label: "Branding",
  },
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
  activityLogs: ActivityLog[];
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
              <Link
                href={`/clients/${clientId}/agents`}
                className="mt-2 inline-flex items-center gap-1 text-xs font-medium text-neon hover:underline"
              >
                Run an agent
                <Icon name="ArrowRight" className="h-3 w-3" />
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
