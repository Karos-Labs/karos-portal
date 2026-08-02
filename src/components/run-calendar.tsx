"use client";

import { useMemo, useState } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { Icon } from "@/components/icon";
import { AgentMark } from "@/components/agent-identity";
import { Badge, Button } from "@/components/ui";
import { jobStatusMeta } from "@/components/job-status";
import { ImageLightbox } from "@/components/image-lightbox";
import { AssetDetailModal } from "@/components/asset-detail-modal";
import { MarkPostedRow } from "@/components/mark-posted-row";
import { ScheduleRunModal } from "@/components/schedule-run-modal";
import { setPlannedRunStatusAction, deletePlannedRunAction } from "@/lib/actions/planned-run-actions";
import { pastRunHasNoDeliverables, showsPastRunReviewControl } from "@/lib/calendar-past-runs";
import { cn, relativeTime } from "@/lib/utils";
import type { AssetImage } from "@/lib/asset-images";
import {
  calendarFilterKeyMatchable,
  calendarFilterLabel,
  postKindLabel,
  type CalendarAssetKind,
  type CalendarFilterKey,
} from "@/lib/calendar-kind";
import type { Asset, AssetType, JobStatus, PlannedRunCadence } from "@/lib/types";

/* ── Serializable shapes built by the calendar page ──────────────────── */

export interface RunAssetView {
  id: string;
  type: AssetType;
  title: string;
  textPreview: string;
  images: AssetImage[];
}

export interface CalendarRun {
  /** jobId (past) or scheduledRunId (scheduled). */
  id: string;
  kind: "past" | "scheduled";
  clientId: string;
  /** Set for staff overview (admin / employee across clients). */
  clientName?: string;
  /** Run date (past: job time) or next fire (scheduled). */
  at: number;
  /** The agent's display name/color/icon. */
  productName: string;
  productColor: string;
  productIcon: string;
  // past
  jobStatus?: JobStatus;
  /** Composed by the server: "drafted 8 posts". Never the record's own summary text. */
  outputSummary?: string;
  /** Staff-only tooltip carrying the job id — omitted from a client's payload. */
  staffRef?: string;
  assets?: RunAssetView[];
  /** Every image across the run's assets, in order — feeds the run lightbox. */
  images?: AssetImage[];
  // scheduled
  cadence?: PlannedRunCadence;
  cadenceLabel?: string;
  /**
   * IANA zone this schedule's wall clock was set in. Present on scheduled runs
   * only: a past run is an instant, a schedule is an intent, and the intent is
   * a wall clock that means nothing without its zone.
   *
   * PRINTED, NOT BUCKETED. It pins `timeStr` so the hour shown is the hour the
   * schedule was set to, and `zoneLabel` names the clock beside it. Which day
   * CELL the chip lands in is the viewer's question, not the schedule's — see
   * `dayKey`.
   */
  timeZone?: string;
  /** Short zone label ("GMT-3") printed next to a schedule's wall clock. */
  zoneLabel?: string;
  /** The free-text request this run fires each time. */
  prompt?: string;
  agentDescription?: string;
  /**
   * The schedule's OWN track record — distinct from `jobStatus` above, which
   * only exists on a "past" (already-fired) entry. A "scheduled" card is a
   * pure future projection with no job of its own yet, so this is the only
   * way it can say anything about whether the schedule has actually been
   * firing: when it last ran, whether that fire produced a job to inspect,
   * and whether the fire itself was refused before a job ever existed
   * (PlannedScheduledRun.lastError — a submission refusal, not a job failure).
   *
   * SENT TO BOTH VIEWERS on purpose, unlike `lastJobId` below. The card renders
   * it two ways — the instant for staff, a date-free sentence for a client — so
   * withholding the field would delete a client's only signal that the schedule
   * has ever fired. See the "Last fire" panel in ScheduledRunCard, and rule 3 of
   * lib/calendar-past-runs for what depends on that signal.
   */
  lastRunAt?: number;
  /** Staff-only: the job the schedule's most recent fire produced, if any — links to /jobs/[id]. */
  lastJobId?: string;
  lastError?: string | null;
  lastErrorAt?: number | null;
  /**
   * The schedule's raw stored `nextRunAt` was already behind "now" when this
   * occurrence was projected — it hasn't fired when it should have. Distinct
   * from `lastError` (a recorded refusal reason may or may not exist yet;
   * this is purely "the clock says it's overdue").
   *
   * `stuckLabel`/`stuckMessage` are resolved server-side (calendar-body.tsx),
   * not derived here from a plain boolean — the copy differs by viewer
   * (staff get the operational "Stuck" / "check the Jobs page" wording;
   * clients get a professional, reassuring line with none of that internal
   * vocabulary), and this codebase's rule is that redaction happens at the
   * server boundary, never at render. Both present together or neither.
   */
  stuckLabel?: string;
  stuckMessage?: string;
}

/** Repo agent option for the schedule-a-run form. */
export interface ScheduleAgentOption {
  id: string;
  name: string;
  description: string;
  icon: string;
  color: string;
}

export interface CalendarPost {
  assetId: string;
  clientId: string;
  clientName?: string;
  title: string;
  at: number;
  /**
   * The shared union, NOT a copy of its members. It was spelled out again here,
   * which meant the maps below could quietly fall short of it: they are keyed
   * over this type, so one union in one home is what makes a new kind a compile
   * error at every chip, label, tone and filter instead of a silent default.
   */
  kind: CalendarAssetKind;
  images: AssetImage[];
  textPreview: string;
  /**
   * Set when the kind carries a publish explanation — a "failed" post's last
   * attempt error, or a "held" post's ordering-hold sentence. Shown in the chip
   * tooltip; the detail modal reads it off the asset itself.
   */
  publishError?: string;
}

export interface CalendarClientOption {
  id: string;
  name: string;
}

// The named calendar statuses a viewer can hide are `CalendarFilterKey`
// (lib/calendar-kind): every CalendarPost kind plus "review", which maps to
// CalendarRun.jobStatus. The union moved there with the rule for which of its
// members a given viewer can actually match — one home for both.

/* ── Constants ───────────────────────────────────────────────────────── */

const DAY_LABELS = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];
const MONTH_NAMES = [
  "January", "February", "March", "April", "May", "June",
  "July", "August", "September", "October", "November", "December",
];

/**
 * Which day cell an entry belongs in — ONE CLOCK FOR THE WHOLE GRID.
 *
 * The grid is drawn from the viewer's own `Date`: the month it opens on, the
 * day numbers in the cells and the "today" ring all come from there, and a cell
 * key is a viewer-local calendar date. So an entry's cell has to be decided on
 * that same clock, or it lands in a cell whose number contradicts it.
 *
 * IT DID NOT USED TO BE. This took an optional `timeZone` and a scheduled run
 * passed its own stored zone, so run chips were bucketed on the schedule's
 * calendar while post chips, the day numbering and "today" were on the
 * viewer's — three sources for one grid. Whenever the two zones put an instant
 * on different dates (a Tokyo morning slot seen from São Paulo; a São Paulo
 * evening slot seen from Tokyo) the chip for a run sat one cell away from the
 * posts that run produces and from the day it will actually reach the viewer.
 * The zone it was pinned to is not the viewer's either: a schedule's zone is
 * the browser zone of whoever CREATED it, so on a staff-created schedule it is
 * a staff member's clock, shown to a client.
 *
 * The schedule's own zone is still what gets PRINTED — `timeStr(run.at,
 * run.timeZone)` plus the `zoneLabel` suffix — because the wall clock is the
 * intent and the intent is worth showing. Cell answers "which of your days";
 * label answers "on whose clock".
 *
 * RESIDUAL, stated rather than dodged: `new Date()` is the drawing runtime's,
 * so a server render (UTC in production) and the browser can disagree about
 * every one of the three at once, for the few hours a day their dates differ.
 * That was already true of the day numbers, the "today" ring and every post
 * chip; pinning run chips alone to the schedule's zone never removed it, it
 * only made the run chip disagree with the cell it was sitting in. Everything
 * now shifts together, which is the property that makes the grid readable.
 */
function dayKey(at: number): string {
  const d = new Date(at);
  return `${d.getFullYear()}-${d.getMonth()}-${d.getDate()}`;
}

function timeStr(at: number, timeZone?: string): string {
  // Pinned locale: SSR (Node) and the browser must format identically or the
  // chip title attributes trigger hydration mismatches. Pinning the zone too
  // (for schedules) closes the other half of that gap.
  return new Date(at).toLocaleTimeString("en-US", {
    hour: "numeric",
    minute: "2-digit",
    ...(timeZone ? { timeZone } : {}),
  });
}

/* ── Chips ───────────────────────────────────────────────────────────── */

/**
 * Chip metrics. `cell` is the month grid; `row` is the mobile agenda, where a
 * chip is the full-width control you tap to open a post. Both clear the 24px
 * minimum for a touch target — the grid chips were about 17px tall.
 */
const CHIP_SIZE = {
  cell: "px-1 py-1 text-[11px] min-h-[24px]",
  row: "px-2 py-2 text-xs min-h-[36px]",
} as const;

type ChipSize = keyof typeof CHIP_SIZE;

function RunChip({ run, size = "cell" }: { run: CalendarRun; size?: ChipSize }) {
  const scheduled = run.kind === "scheduled";
  const failed = run.jobStatus === "failed";
  return (
    <div
      className={cn(
        "flex items-center gap-1 rounded leading-tight truncate",
        CHIP_SIZE[size],
        scheduled
          ? "border border-dashed border-foreground/30 bg-foreground/[0.03] text-foreground/70"
          : failed
            ? "bg-danger/15 text-danger"
            : "bg-foreground/[0.07] text-foreground/85",
      )}
      title={`${scheduled ? "Scheduled" : "Ran"} · ${run.productName} · ${timeStr(run.at, run.timeZone)}${
        scheduled && run.zoneLabel ? ` ${run.zoneLabel}` : ""
      }${run.clientName ? ` · ${run.clientName}` : ""}`}
    >
      <AgentMark identity={run.productName} icon={run.productIcon} className="h-2.5 w-2.5 shrink-0" />
      <span className="truncate">{run.productName}</span>
    </div>
  );
}

const POST_CHIP_CLASS: Record<CalendarPost["kind"], string> = {
  published: "bg-success/15 text-success",
  scheduled: "border border-dashed border-info/50 bg-info/10 text-info",
  placeholder: "border border-dashed border-muted-2/50 bg-foreground/[0.04] text-muted",
  failed: "bg-danger/15 text-danger",
  // Solid border against placeholder's dashed one, and no danger tint: a held
  // post is real, dated work that is simply next in line.
  held: "border border-muted-2/60 bg-foreground/[0.06] text-foreground/70",
  draft: "border border-dashed border-muted-2/40 bg-foreground/[0.02] text-muted-2",
};


/**
 * The day card's badge tone, per kind.
 *
 * A Record because the ternary chain this replaces ended `: "Placeholder"` — so
 * the day card called a FAILED post, a DRAFT and (once "held" existed) a held
 * post "Placeholder", three states it has no business naming after a fourth.
 * The chip one cell above already read "Failed to publish" off the map below,
 * which is how a card and its own chip disagreed about the same post.
 */
const POST_KIND_TONE: Record<CalendarPost["kind"], "success" | "info" | "neutral" | "danger"> = {
  published: "success",
  scheduled: "info",
  placeholder: "neutral",
  failed: "danger",
  held: "neutral",
  draft: "neutral",
};

function PostChip({
  post,
  viewerIsClient = false,
  onOpen,
  size = "cell",
}: {
  viewerIsClient?: boolean;
  post: CalendarPost;
  onOpen: (assetId: string) => void;
  size?: ChipSize;
}) {
  return (
    <button
      type="button"
      onClick={(event) => {
        event.stopPropagation();
        onOpen(post.assetId);
      }}
      className={cn(
        "flex w-full items-center gap-1 rounded leading-tight truncate text-left transition-opacity hover:opacity-80 focus:outline-none focus:ring-1 focus:ring-neon/50",
        CHIP_SIZE[size],
        POST_CHIP_CLASS[post.kind],
      )}
      /* Whether an explanation travels at all is decided once, at the server
         projection (calendar-body) — so this prints whatever arrived rather than
         re-deciding which kinds are allowed one, which is how the held post's
         sentence would have been dropped on the way to the tooltip. */
      title={`${postKindLabel(post.kind, viewerIsClient)}${post.publishError ? ` · ${post.publishError}` : ""} · ${post.title} · ${timeStr(post.at)}`}
    >
      <div className="h-1.5 w-1.5 shrink-0 rounded-full bg-current opacity-70" />
      <span className="truncate">{post.title}</span>
    </button>
  );
}

/* ── Day detail ──────────────────────────────────────────────────────── */

function ScheduledRunCard({
  run,
  canManage,
  canDelete,
  canOpenJob,
  viewerIsClient,
  onPaused,
}: {
  run: CalendarRun;
  /** Pause this schedule. Clients may manage their own (requireClientAccess). */
  canManage: boolean;
  /** Delete it outright — staff only; a client's undo is a staff member. */
  canDelete: boolean;
  /** Staff. /jobs/[id] is staff-guarded and silently redirects a client to /dashboard. */
  canOpenJob: boolean;
  /**
   * Whether this card is being read by the client whose schedule it is — asked
   * for the two "Last fire" lines below (A3: staff get the instant, a client
   * gets the date-free fact), and NOT derived from `canOpenJob`.
   *
   * The three booleans above are capability questions ("may this viewer open a
   * job / pause / delete") and this is a disclosure one. They agree today, which
   * is exactly why keying the churn rule to one of them would be the wrong shape:
   * a capability flag is free to change for capability reasons and would move a
   * directive with it.
   */
  viewerIsClient: boolean;
  /**
   * Raised when the pause has actually landed. THE ACKNOWLEDGEMENT DOES NOT
   * BELONG ON THIS CARD, which is why it leaves through a callback instead of a
   * local flag: the calendar is built from ACTIVE schedules only
   * (calendar-body), so the row leaves the page's data the moment the write
   * succeeds and this component unmounts on the very refresh that follows. A
   * flag set here printed a reassurance that never survived to be read. The
   * calendar owns it now, and owns the resume that goes with it.
   */
  onPaused: (run: CalendarRun) => void;
}) {
  const router = useRouter();
  const [busy, setBusy] = useState<null | "pause" | "delete">(null);
  const [error, setError] = useState<string | null>(null);
  const [confirmingDelete, setConfirmingDelete] = useState(false);

  // Both handlers previously ignored the result and never cleared the busy
  // flag: a refused call span forever with no message and left the card on
  // screen as if nothing had happened.
  async function remove() {
    if (busy) return;
    setBusy("delete");
    setError(null);
    try {
      const res = await deletePlannedRunAction(run.id);
      if (res?.error) {
        setError(res.error);
        setConfirmingDelete(false);
        return;
      }
      router.refresh();
    } catch (e) {
      setError(e instanceof Error ? e.message : "Couldn't delete this schedule.");
    } finally {
      setBusy(null);
    }
  }

  // No `finally` here, unlike `remove` above, and that is the point: on success
  // this card is about to be unmounted by the refresh below (the calendar
  // carries active schedules only), so `busy` is left set and the controls stay
  // disabled for the moment in between rather than inviting a second click at a
  // schedule that is already paused. Both failure paths clear it themselves.
  async function pause() {
    if (busy) return;
    setBusy("pause");
    setError(null);
    try {
      const res = await setPlannedRunStatusAction(run.id, "paused");
      if (res?.error) {
        setError(res.error);
        setBusy(null);
        return;
      }
      onPaused(run);
      router.refresh();
    } catch (e) {
      setError(e instanceof Error ? e.message : "Couldn't pause this schedule.");
      setBusy(null);
    }
  }

  return (
    <div className="rounded-lg border border-border bg-surface p-3">
      <div className="flex items-start gap-2.5">
        <div className="flex h-8 w-8 shrink-0 items-center justify-center rounded-lg border border-foreground/10 bg-foreground/[0.04] text-foreground/80">
          <AgentMark identity={run.productName} icon={run.productIcon} className="h-4 w-4" />
        </div>
        <div className="min-w-0 flex-1">
          <div className="flex flex-wrap items-center gap-2">
            <p className="text-sm font-medium">{run.productName}</p>
            {/* A stuck schedule's "next" time below is a stale, already-passed
                cursor (see projectRunOccurrences's doc comment) — labeling it
                "Upcoming" would restate the exact misrepresentation this flag
                exists to stop. Label/message are both resolved server-side
                (calendar-body.tsx) so the copy is already correct for this
                viewer — never decided here. */}
            <Badge tone={run.stuckLabel ? "danger" : "info"}>{run.stuckLabel ?? "Upcoming"}</Badge>
            {run.clientName && <Badge tone="neutral">{run.clientName}</Badge>}
          </div>
          {/* One clock, stated once. The cadence label already carries the
              wall-clock time and its zone, so printing a second, differently
              derived time here is what made the two contradict each other. */}
          <p className="mt-0.5 text-xs text-muted-2">
            {run.cadenceLabel} · {run.stuckLabel ? "was due" : "next"} {timeStr(run.at, run.timeZone)}
            {run.zoneLabel ? ` ${run.zoneLabel}` : ""}
          </p>
          {run.stuckMessage && <p className="mt-1.5 text-xs text-danger">{run.stuckMessage}</p>}
          {run.agentDescription && <p className="mt-1.5 text-xs text-muted-2">{run.agentDescription}</p>}
          <div className="mt-2.5 border-t border-border pt-2">
            <p className="mb-1 text-[11px] font-medium uppercase tracking-wide text-muted-2">Will run</p>
            <p className="text-xs italic text-muted">
              {run.prompt ? `“${run.prompt}”` : "Runs the agent's default playbook."}
            </p>
          </div>
          {/* The schedule's own track record — this card IS a future
              projection with no job of its own, so this is the only place it
              can say whether the schedule has actually been firing. A recent
              lastError means the fire was REFUSED before a job ever existed
              (credit cap, missing intake, agent service unreachable) — there
              is nothing to link to for that outcome, only the reason. */}
          {/* A3 TAKES THE INSTANT, NOT THE FACT. "Ran 6 hours ago" under a
              heading reading "Last fire", beside this card's own cadence label
              and a grid of upcoming days, is the batch timestamp — the same tell
              the dashboard's "Agent runs · Last run …" tile was carrying, on a
              surface a client reaches from their own calendar. So a client is
              never told WHEN the schedule last fired.

              WHAT ELSE WAS FLOWING THROUGH THIS PANEL, enumerated, because the
              first cut of this gate was `!viewerIsClient` over the whole panel
              and that took a remedy with it (rule: a fix that closes a hole must
              not take the remedy with it — so name everything the hole carried,
              not just the line you were looking at):

                · THE REFUSAL (`lastError`). Kept for a client. It is the only
                  thing that can explain a fire refused before any job existed,
                  calendar-body already paraphrases it through clientSafeRefusal
                  for exactly this reader, and gating it would re-open the
                  silent-refusal gap that treatment was added to close.

                · THAT THE SCHEDULE HAS FIRED AT ALL (`lastRunAt`). Also kept for
                  a client, as a DATE-FREE sentence. This panel is the substitute
                  lib/calendar-past-runs rule 3 names, and that module really
                  depends on it: `projectPastRuns` drops every past-run card whose
                  visible deliverables are empty for a client — which is every
                  `queued`/`running` run and every batch whose posts are all still
                  locked — so with this line gated to staff, a client whose
                  schedule fired and is STILL WORKING, or delivered only locked
                  posts, had no surface anywhere saying the agent ran. The
                  "Delayed" case was the worst of it: a stuck label and nothing
                  else.

              The two are not the same disclosure. "Ran 4 hours ago" dates the
              batch; "This schedule has run before" cannot, however many times a
              client reloads the page. */}
          {(run.lastError || run.lastRunAt) && (
            <div className="mt-2.5 border-t border-border pt-2">
              <p className="mb-1 text-[11px] font-medium uppercase tracking-wide text-muted-2">
                Last fire
              </p>
              {/* THREE SIBLING GATES, not the ternary this was. An error still
                  wins over a success, now by the explicit `!run.lastError` on
                  both success branches rather than by branch order — and the
                  shape is the point: `{!viewerIsClient && …}` is a gate a source
                  guard can bound to its own braces, so
                  status-render-sweep.test.ts can assert from the filesystem that
                  the dated line IS inside a staff gate and that the refusal and
                  the date-free line are NOT. Written as a ternary, none of it was
                  mechanically checkable and the test that claimed to check it
                  passed on the broken code. */}
              {run.lastError && (
                <p className="text-xs text-danger">
                  Failed to fire {run.lastErrorAt ? relativeTime(run.lastErrorAt) : ""} · {run.lastError}
                </p>
              )}
              {!viewerIsClient && !run.lastError && run.lastRunAt && (
                <p className="text-xs text-muted-2">
                  Ran {relativeTime(run.lastRunAt)}
                  {canOpenJob && run.lastJobId && (
                    <>
                      {" · "}
                      <Link href={`/jobs/${run.lastJobId}`} className="text-neon-dim hover:text-neon">
                        View job
                      </Link>
                    </>
                  )}
                </p>
              )}
              {/* The client's half of the same fact, with no instant in it and
                  nothing to link to (/jobs/[id] is staff-guarded). Pinned by
                  VALUE in status-render-sweep.test.ts — gate and sentence
                  together, as one string — so it cannot drift into naming a time
                  and cannot quietly disappear. */}
              {viewerIsClient && !run.lastError && run.lastRunAt && (
                <p className="text-xs text-muted-2">This schedule has run before.</p>
              )}
            </div>
          )}
          {(canManage || canDelete) && (
            <div className="mt-3 space-y-2">
              {confirmingDelete ? (
                <>
                  <p className="text-xs text-danger">
                    Delete this schedule permanently? The agent stops running on this cadence and
                    it can&apos;t be undone. To stop it temporarily, pause it instead.
                  </p>
                  <div className="flex flex-wrap gap-2">
                    <Button
                      size="sm"
                      variant="danger"
                      onClick={remove}
                      loading={busy === "delete"}
                      disabled={busy != null}
                    >
                      Yes, delete it
                    </Button>
                    <Button
                      size="sm"
                      variant="ghost"
                      onClick={() => setConfirmingDelete(false)}
                      disabled={busy != null}
                    >
                      Keep it
                    </Button>
                  </div>
                </>
              ) : (
                <div className="flex flex-wrap gap-2">
                  {canManage && (
                    <Button
                      size="sm"
                      variant="ghost"
                      onClick={pause}
                      loading={busy === "pause"}
                      disabled={busy != null}
                    >
                      Pause
                    </Button>
                  )}
                  {canDelete && (
                    // Named for what it does. "Cancel" sat next to a dismissible
                    // card and destroyed the schedule on one click.
                    <Button
                      size="sm"
                      variant="danger"
                      onClick={() => setConfirmingDelete(true)}
                      disabled={busy != null}
                    >
                      Delete schedule
                    </Button>
                  )}
                </div>
              )}
            </div>
          )}
          {error && <p className="mt-2 text-xs text-danger">{error}</p>}
        </div>
      </div>
    </div>
  );
}

/** The one fact the calendar keeps about a schedule it has just lost. */
interface PausedRunMemo {
  id: string;
  productName: string;
}

/** One paused schedule, as the durable strip needs it. Identity only — never projected. */
export interface PausedScheduleView {
  id: string;
  productName: string;
  /** "weekly · Mon-Fri", "monthly", "one-off" — resolved server-side like every other cadence label. */
  cadenceLabel?: string;
  clientName?: string;
}

/**
 * EVERY paused schedule, from DATA, always.
 *
 * `PausedRunNotice` above acknowledges the press that just happened and dies
 * with the component's state. This is the half that survives a reload — and it
 * is why a client can no longer pause themselves into a corner:
 * `calendar-body` drops paused rows from the projection deliberately (painting
 * days a schedule will not run is the same class of lie), so before this the
 * ONLY route back was the AI Agents page, which shows nothing at all for cadence
 * "monthly" or "once".
 *
 * Identity and a cadence label, never occurrences. A paused schedule has no
 * upcoming days and must not appear to have any.
 */
function PausedScheduleStrip({ schedules }: { schedules: readonly PausedScheduleView[] }) {
  if (schedules.length === 0) return null;
  return (
    <div className="rounded-[var(--radius)] border border-border bg-surface-2/30 px-4 py-3">
      <p className="mb-2 text-[11px] font-mono font-medium uppercase tracking-[0.14em] text-muted-2">
        Paused schedules
      </p>
      <ul className="space-y-2">
        {schedules.map((s) => (
          <li key={s.id} className="flex flex-wrap items-center justify-between gap-x-4 gap-y-1.5">
            <p className="min-w-0 text-xs text-muted">
              <span className="font-medium text-foreground">{s.productName}</span>
              {s.clientName ? ` · ${s.clientName}` : ""}
              {s.cadenceLabel ? ` · ${s.cadenceLabel}` : ""}
            </p>
            <PausedScheduleResume id={s.id} />
          </li>
        ))}
      </ul>
    </div>
  );
}

/** Resume for one strip row. Its own state, so one refusal cannot blank the others. */
function PausedScheduleResume({ id }: { id: string }) {
  const router = useRouter();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function resume() {
    if (busy) return;
    setBusy(true);
    setError(null);
    try {
      // The same action and the same gates the notice runs: a resume re-arms
      // paid recurring fires, so it can legitimately refuse (credit cap, agent
      // setup, an elapsed one-off) and the client reads that answer.
      const res = await setPlannedRunStatusAction(id, "active");
      if (res?.error) {
        setError(res.error);
        setBusy(false);
        return;
      }
      router.refresh();
    } catch (e) {
      setError(e instanceof Error ? e.message : "Couldn't resume this schedule.");
      setBusy(false);
    }
  }

  return (
    <span className="flex shrink-0 items-center gap-2">
      {error && <span className="text-xs text-danger">{error}</span>}
      <Button size="sm" variant="outline" onClick={resume} loading={busy}>
        Resume
      </Button>
    </span>
  );
}

/**
 * WHAT HAPPENED TO THE SCHEDULE THAT JUST VANISHED, and the only way back to it
 * on this surface.
 *
 * Two things live here, and neither could live on the card that raises them.
 *
 * 1. THE ACKNOWLEDGEMENT. `scheduledRuns.filter((r) => r.status === "active")`
 *    in calendar-body is what the whole calendar is built from, so a paused
 *    schedule leaves the page's data outright: every chip for it disappears from
 *    the grid and `selectedScheduled` stops containing it, which unmounts
 *    ScheduledRunCard on the same refresh. The reassurance used to be a local
 *    flag on that card, so the client's schedule blinked out and the sentence
 *    explaining it was destroyed in the same tick. This component is a child of
 *    the calendar, which the refresh keeps.
 *
 * 2. THE REVERSE DOOR. `canManage` renders Pause and there was no resume branch
 *    anywhere on this screen — and a paused schedule is not on this screen to
 *    grow one. So the calendar could stop a schedule and could not start it
 *    again. Resume is the SAME server action with the other reversible status,
 *    the pair a CLIENT_USER is already allowed (setPlannedRunStatusAction
 *    authorizes with requireClientAccess and refuses "completed" both ways).
 *
 * It can REFUSE — a resume re-arms paid recurring fires, so it runs the same
 * gates a create does (credit cap, agent setup, an elapsed one-off), and those
 * answers are already written for this viewer. So the returned error is printed
 * rather than swallowed, and the notice stays up when it fires.
 *
 * IT DOES NOT NAME THE AI AGENTS PAGE, and the first version did. That page's
 * schedule row comes from `toScheduleRows`, and `weeklyFireDays` returns null for
 * cadence "monthly" and "once" — so for those two the row is dropped and the
 * schedule is on NO surface once this notice goes. Telling a client to resume
 * somewhere the schedule does not appear re-creates the one-way door this whole
 * change exists to close, for the two cadences least likely to be noticed.
 *
 * The durable answer is `PausedScheduleStrip` below, which is rendered from
 * DATA rather than from this component's state, so it survives a reload for
 * every cadence. This notice is only the acknowledgement of the press that just
 * happened, and it points there.
 *
 * `role="status"` + `aria-live="polite"`: pausing unmounts the card the button
 * was in, so focus falls to <body> and this renders a full calendar above the
 * viewport — a keyboard or screen-reader client would otherwise be told nothing
 * at all, which is the half of this finding that is not about pixels.
 */
function PausedRunNotice({ run, onDone }: { run: PausedRunMemo; onDone: () => void }) {
  const router = useRouter();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function resume() {
    if (busy) return;
    setBusy(true);
    setError(null);
    try {
      const res = await setPlannedRunStatusAction(run.id, "active");
      if (res?.error) {
        setError(res.error);
        setBusy(false);
        return;
      }
      onDone();
      router.refresh();
    } catch (e) {
      setError(e instanceof Error ? e.message : "Couldn't resume this schedule.");
      setBusy(false);
    }
  }

  return (
    <div
      role="status"
      aria-live="polite"
      className="rounded-[var(--radius)] border border-border bg-surface-2/40 px-4 py-3"
    >
      <div className="flex flex-wrap items-center justify-between gap-x-4 gap-y-2">
        <p className="min-w-0 text-xs text-muted">
          <span className="font-medium text-foreground">{run.productName}</span> is paused. It
          won&apos;t run again until you resume it, here or under Paused schedules below.
        </p>
        <div className="flex shrink-0 gap-2">
          <Button size="sm" variant="outline" onClick={resume} loading={busy}>
            Resume
          </Button>
          <Button size="sm" variant="ghost" onClick={onDone} disabled={busy}>
            Dismiss
          </Button>
        </div>
      </div>
      {error && <p className="mt-2 text-xs text-danger">{error}</p>}
    </div>
  );
}

/**
 * What a fired run with NO recorded state is called — the absence of a
 * `JobStatus`, not an unrecognised one, which is why it is not in
 * `JOB_STATUS_META` and does not go through `jobStatusMeta`.
 *
 * Deliberately NOT a second name for any state the register already names: it is
 * only ever reached when there is nothing to look up.
 */
const NO_RUN_STATUS = { tone: "neutral" as const, label: "Done" };

/** `Button` renders a <button>; an anchor can't nest one, so it borrows the look. */
const REVIEW_BUTTON_CLASS =
  "inline-flex h-8 items-center justify-center gap-1.5 rounded-md border border-border px-3 text-xs text-foreground transition-all duration-200 hover:border-foreground/30 hover:bg-foreground/[0.04] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-foreground/25";

function PastRunCard({
  run,
  canOpenJob,
  viewerIsClient,
  onOpenLightbox,
  onOpenAsset,
}: {
  run: CalendarRun;
  /** Staff. /jobs/[id] is staff-guarded and silently redirects a client to /dashboard. */
  canOpenJob: boolean;
  /**
   * THE DISCLOSURE QUESTION, not `canOpenJob` reused. The two agree today, and
   * that is exactly the trap this campaign has already fallen into: a capability
   * flag is free to move for capability reasons, and what this decides is whether
   * a client is shown the moment their content was generated (A3).
   */
  viewerIsClient: boolean;
  onOpenLightbox: (images: AssetImage[], index: number) => void;
  onOpenAsset: (assetId: string) => void;
}) {
  const images = run.images ?? [];
  const textAssets = (run.assets ?? []).filter((a) => a.images.length === 0 && a.textPreview);
  // TWO questions, and the version this replaced answered both with "Done".
  //
  // An UNRECOGNISED status now resolves through `jobStatusMeta` like every other
  // reader of the map, so a stored value the union has never heard of no longer
  // reads "Done" here and "Queued" on the badge one screen over. The ABSENCE of a
  // status is the other question and it keeps its own answer: this card only ever
  // renders a run that has already fired, so "Queued" would be a worse lie than a
  // neutral word. Not reachable from the one producer today — calendar-body sets
  // `jobStatus: j.status` from a required field — but `CalendarRun` is shared with
  // the scheduled-run card, where the field genuinely is absent, so the branch
  // stays and says why.
  const status = run.jobStatus ? jobStatusMeta(run.jobStatus) : NO_RUN_STATUS;
  const inFlight = run.jobStatus === "queued" || run.jobStatus === "running";

  // Where "review this" actually goes. Staff get the run detail page the
  // notification bell already links to; a client gets the deliverable itself,
  // in the same detail panel the post cards below open. Telling someone
  // something is ready to review and giving them nothing to click is the gap —
  // so the badge's claim and the existence of a target are asked as one
  // question (lib/calendar-past-runs), which is also what the server projection
  // that builds these rows guarantees for a client viewer.
  const firstAssetId = run.assets?.[0]?.id;
  const href = canOpenJob ? `/jobs/${run.id}` : null;
  const openAsset = !canOpenJob && firstAssetId ? () => onOpenAsset(firstAssetId) : null;
  // Derived from the RESOLVED target, not from a proxy for it. The module's
  // predicate asks `assets.length > 0` while `openAsset` needs a truthy id — the
  // same rule in two spellings, and an empty-string id would have rendered a
  // dead "Review deliverable" behind a non-null assertion. Not reachable from
  // the one caller (ids are Firestore doc ids), but it re-opened the exact gap
  // this module exists to close. `showsPastRunReviewControl` still guards the
  // server-side guarantee; here the button asks whether it has somewhere to go.
  const showReviewControl = showsPastRunReviewControl(run, { canOpenJob }) && Boolean(href || openAsset);

  const heading = (
    <>
      <p className="text-sm font-medium">{run.productName}</p>
      {/* Never `run.jobStatus` raw — that prints the database enum. */}
      <Badge tone={status.tone}>{status.label}</Badge>
      {run.clientName && <Badge tone="neutral">{run.clientName}</Badge>}
    </>
  );

  return (
    // Product code and job id are staff bookkeeping — a tooltip the server only
    // fills in for staff, never body copy on a client's screen.
    <div className="rounded-lg border border-border bg-surface p-3" title={run.staffRef}>
      <div className="flex items-start gap-2.5">
        <div className="flex h-8 w-8 shrink-0 items-center justify-center rounded-lg border border-foreground/10 bg-foreground/[0.04] text-foreground/80">
          <AgentMark identity={run.productName} icon={run.productIcon} className="h-4 w-4" />
        </div>
        <div className="min-w-0 flex-1">
          {href ? (
            <Link
              href={href}
              className="flex flex-wrap items-center gap-2 rounded-sm transition-opacity hover:opacity-80 focus:outline-none focus-visible:ring-1 focus-visible:ring-neon/50"
            >
              {heading}
            </Link>
          ) : openAsset ? (
            <button
              type="button"
              onClick={openAsset}
              className="flex flex-wrap items-center gap-2 rounded-sm text-left transition-opacity hover:opacity-80 focus:outline-none focus-visible:ring-1 focus-visible:ring-neon/50"
            >
              {heading}
            </button>
          ) : (
            <div className="flex flex-wrap items-center gap-2">{heading}</div>
          )}
          {/*
            A3, THE CHURN RULE, on the card the scheduled-run panel's own "Last
            fire" gate was fixed for — this was the copy that was missed. A client
            reading "Ran 6 hours ago" on three cards under the same day learns
            those posts were produced together, which is the one fact the slot
            model exists to keep indistinguishable. `projectPastRuns` only drops a
            past-run card that has NO visible deliverables, so a client with a
            partly-unlocked weekly batch sees several of these.

            The run's own summary stays — it describes what they received, not
            when it was made — and the day this card sits under already dates it.
            Staff keep the instant; it is what the run record is for.
          */}
          {(!viewerIsClient || run.outputSummary) && (
            <p className="mt-0.5 text-xs text-muted-2">
              {run.outputSummary ?? ""}
              {!viewerIsClient && (
                <>
                  {run.outputSummary ? " · " : ""}
                  {inFlight ? "Started" : "Ran"} {timeStr(run.at)}
                </>
              )}
            </p>
          )}

          {showReviewControl && (
            <div className="mt-2">
              {href ? (
                <Link href={href} className={REVIEW_BUTTON_CLASS}>
                  Review deliverable
                  <Icon name="ArrowRight" className="h-3.5 w-3.5" />
                </Link>
              ) : (
                <Button size="sm" variant="outline" onClick={openAsset ?? undefined}>
                  Review deliverable
                  <Icon name="ArrowRight" className="h-3.5 w-3.5" />
                </Button>
              )}
            </div>
          )}

          {inFlight ? (
            <p className="mt-2 text-xs text-muted-2">In progress…</p>
          ) : run.jobStatus === "failed" ? (
            <p className="mt-2 text-xs text-danger">The run failed and produced no assets.</p>
          ) : pastRunHasNoDeliverables(run) ? (
            // Asked of the run's DELIVERABLES, not of what this card happens to
            // paint below. The old condition was `no images && no text
            // previews`, so a run that delivered a clip with no caption — one
            // asset, nothing either gallery can render inline — was announced as
            // having produced nothing, one line under its own "1 post" summary.
            //
            // What reaches a client here is decided on the server: a client's
            // card is only built when the run has actually delivered them
            // something (projectPastRuns in lib/calendar-past-runs), so this
            // line speaks about a run that produced nothing at all.
            <p className="mt-2 text-xs text-muted-2">This run produced no assets.</p>
          ) : null}

          {/* Image gallery — click any to slide through the whole run */}
          {images.length > 0 && (
            <div className="mt-2.5 flex flex-wrap gap-1.5">
              {images.map((img, i) => (
                <button
                  key={img.url + i}
                  onClick={() => onOpenLightbox(images, i)}
                  className="h-16 w-16 overflow-hidden rounded-md border border-border transition-opacity hover:opacity-80"
                  title={img.caption ?? `Image ${i + 1}`}
                >
                  {/* eslint-disable-next-line @next/next/no-img-element */}
                  <img src={img.url} alt="" className="h-full w-full object-cover" />
                </button>
              ))}
            </div>
          )}

          {/* Text deliverables (articles, emails, captions) */}
          {textAssets.length > 0 && (
            <div className="mt-2.5 space-y-1.5">
              {textAssets.map((a) => (
                <div key={a.id} className="rounded-md border border-border bg-surface-2 p-2">
                  <p className="text-xs font-medium text-foreground">{a.title}</p>
                  <p className="mt-0.5 line-clamp-2 text-[11px] text-muted-2">{a.textPreview}</p>
                </div>
              ))}
            </div>
          )}
        </div>
      </div>
    </div>
  );
}

function PostCard({
  post,
  viewerIsClient = false,
  asset,
  onOpenLightbox,
  onOpenDetails,
}: {
  viewerIsClient?: boolean;
  post: CalendarPost;
  /** The underlying asset, when the viewer has it — drives Mark as posted. */
  asset?: Asset;
  onOpenLightbox: (images: AssetImage[], index: number) => void;
  onOpenDetails: (assetId: string) => void;
}) {
  // Read off the shared maps, not a ternary chain that fell through to
  // "Placeholder" for every kind it hadn't been told about.
  const tone = POST_KIND_TONE[post.kind];
  const label = postKindLabel(post.kind, viewerIsClient);
  return (
    <div
      onClick={() => onOpenDetails(post.assetId)}
      role="button"
      tabIndex={0}
      onKeyDown={(event) => {
        if (event.key === "Enter" || event.key === " ") {
          event.preventDefault();
          onOpenDetails(post.assetId);
        }
      }}
      className="flex w-full items-start gap-2.5 rounded-lg border border-border bg-surface p-3 text-left transition-colors hover:bg-surface-2 focus:outline-none focus:ring-1 focus:ring-neon/50"
    >
      {post.images[0] ? (
        <button
          type="button"
          onClick={() => onOpenLightbox(post.images, 0)}
          onMouseDown={(event) => event.stopPropagation()}
          onClickCapture={(event) => event.stopPropagation()}
          className="h-12 w-12 shrink-0 overflow-hidden rounded-md border border-border transition-opacity hover:opacity-80"
        >
          {/* eslint-disable-next-line @next/next/no-img-element */}
          <img src={post.images[0].url} alt="" className="h-full w-full object-cover" />
        </button>
      ) : (
        <div className="flex h-12 w-12 shrink-0 items-center justify-center rounded-md border border-border bg-surface-2 text-muted-2">
          <Icon name="FileText" className="h-5 w-5" />
        </div>
      )}
      <div className="min-w-0 flex-1">
        <div className="flex flex-wrap items-center gap-2">
          <p className="truncate text-sm font-medium">{post.title}</p>
          <Badge tone={tone}>{label}</Badge>
          {post.clientName && <Badge tone="neutral">{post.clientName}</Badge>}
        </div>
        <p className="mt-0.5 text-xs text-muted-2">{timeStr(post.at)}</p>
        {post.textPreview && <p className="mt-1 line-clamp-2 text-[11px] text-muted-2">{post.textPreview}</p>}
        {/* Day-card attestation: the client posts by hand, then says so here —
            the same single transition the detail modal offers (QA F149). */}
        {asset && <MarkPostedRow asset={asset} variant="chip" />}
      </div>
    </div>
  );
}

/* ── Main component ──────────────────────────────────────────────────── */

export function RunCalendar({
  runs,
  pausedSchedules = [],
  posts,
  assets,
  viewerIsClient = false,
  canSchedule = false,
  canManageRuns = false,
  clients = [],
  agents = [],
  connectedPlatformsByClient,
  defaultClientId,
}: {
  runs: CalendarRun[];
  /**
   * Paused schedules, NOT projected onto days. `calendar-body` filters paused
   * rows out of `runs` on purpose; these come through separately so the way
   * back survives a reload for every cadence.
   */
  pausedSchedules?: readonly PausedScheduleView[];
  posts: CalendarPost[];
  assets: Asset[];
  /**
   * Whose words the detail modal uses for an asset's status — the client
   * register ("Posted") or the staff one ("Published"). Deliberately NOT
   * `!canSchedule`: that answers "may this viewer schedule a run", and staff in
   * View as Client are true for it while a client is false, so reusing it would
   * be a second, differently-shaped answer to "who is reading this".
   */
  viewerIsClient?: boolean;
  /** Staff on their own clients — shows the "Schedule a run" button + staff-only controls. */
  canSchedule?: boolean;
  /**
   * May pause a scheduled run. True for clients on their own calendar too:
   * setPlannedRunStatusAction authorizes with requireClientAccess and allows a
   * CLIENT_USER exactly the reversible statuses (paused/active), and pausing
   * was already possible for them one page over, on AI Agents. Deleting is
   * gated separately, on the server as well as here.
   */
  canManageRuns?: boolean;
  clients?: CalendarClientOption[];
  agents?: ScheduleAgentOption[];
  /**
   * clientId → usable publish platforms. Feeds the staff-only Publish Now in the
   * asset detail modal; the page never builds it for a client viewer, so nothing
   * extra reaches a client's payload.
   */
  connectedPlatformsByClient?: Record<string, string[]>;
  defaultClientId?: string;
}) {
  const today = useMemo(() => new Date(), []);
  const [viewYear, setViewYear] = useState(today.getFullYear());
  const [viewMonth, setViewMonth] = useState(today.getMonth());
  const [selectedKey, setSelectedKey] = useState<string | null>(null);
  const [lightbox, setLightbox] = useState<{ images: AssetImage[]; index: number } | null>(null);
  const [openAssetId, setOpenAssetId] = useState<string | null>(null);
  const [scheduleOpen, setScheduleOpen] = useState(false);
  /** Day clicked on an empty cell, carried into the schedule form as a prefill. */
  const [schedulePrefillAt, setSchedulePrefillAt] = useState<number | null>(null);
  /**
   * The schedule this viewer has just paused. Held HERE and not on the card
   * that paused it: the pause takes the row out of `runs` entirely, so the card
   * is unmounted by the refresh that follows and anything it was saying goes
   * with it. See PausedRunNotice.
   */
  const [pausedRun, setPausedRun] = useState<PausedRunMemo | null>(null);
  // Status filter: which of the named calendar statuses are currently hidden.
  // "review" is a CalendarRun bucket (jobStatus === "review", i.e. Pending
  // Review) — everything else is a CalendarPost kind.
  const [hiddenStatuses, setHiddenStatuses] = useState<Set<CalendarFilterKey>>(new Set());
  const toggleStatus = (key: CalendarFilterKey) =>
    setHiddenStatuses((prev) => {
      const next = new Set(prev);
      if (next.has(key)) next.delete(key);
      else next.add(key);
      return next;
    });
  const assetById = useMemo(() => new Map(assets.map((a) => [a.id, a])), [assets]);
  const openAsset = openAssetId ? assetById.get(openAssetId) ?? null : null;

  const visiblePosts = useMemo(
    () => posts.filter((p) => !hiddenStatuses.has(p.kind)),
    [posts, hiddenStatuses],
  );
  const visibleRuns = useMemo(
    () => runs.filter((r) => !(r.jobStatus === "review" && hiddenStatuses.has("review"))),
    [runs, hiddenStatuses],
  );

  const runsByDay = useMemo(() => {
    const m = new Map<string, CalendarRun[]>();
    for (const r of visibleRuns) {
      const k = dayKey(r.at);
      (m.get(k) ?? m.set(k, []).get(k)!).push(r);
    }
    return m;
  }, [visibleRuns]);

  const postsByDay = useMemo(() => {
    const m = new Map<string, CalendarPost[]>();
    for (const p of visiblePosts) {
      const k = dayKey(p.at);
      (m.get(k) ?? m.set(k, []).get(k)!).push(p);
    }
    return m;
  }, [visiblePosts]);

  const totalDays = new Date(viewYear, viewMonth + 1, 0).getDate();
  const firstDayOfWeek = new Date(viewYear, viewMonth, 1).getDay();
  const totalCells = Math.ceil((firstDayOfWeek + totalDays) / 7) * 7;
  const isCurrentMonth = viewYear === today.getFullYear() && viewMonth === today.getMonth();

  // Distinct scheduled runs, not chip count — a recurring run now projects one
  // chip per future occurrence, which would otherwise inflate this summary.
  const upcomingCount = new Set(runs.filter((r) => r.kind === "scheduled").map((r) => r.id)).size;
  const pastCount = runs.filter((r) => r.kind === "past").length;

  // Phone agenda: seven columns across ~340px gives each day about 48px, so
  // every chip truncates to nothing and the month reads as coloured slivers.
  // Below `sm` the grid is replaced by this list of days that actually have
  // something on them.
  const agendaDays = useMemo(() => {
    const out: { key: string; day: number; runs: CalendarRun[]; posts: CalendarPost[] }[] = [];
    for (let day = 1; day <= totalDays; day++) {
      const key = `${viewYear}-${viewMonth}-${day}`;
      const dayRuns = runsByDay.get(key) ?? [];
      const dayPosts = postsByDay.get(key) ?? [];
      if (dayRuns.length + dayPosts.length > 0) out.push({ key, day, runs: dayRuns, posts: dayPosts });
    }
    return out;
  }, [totalDays, viewYear, viewMonth, runsByDay, postsByDay]);

  function prevMonth() {
    setSelectedKey(null);
    if (viewMonth === 0) { setViewYear((y) => y - 1); setViewMonth(11); } else setViewMonth((m) => m - 1);
  }
  function nextMonth() {
    setSelectedKey(null);
    if (viewMonth === 11) { setViewYear((y) => y + 1); setViewMonth(0); } else setViewMonth((m) => m + 1);
  }

  const selectedRuns = selectedKey ? (runsByDay.get(selectedKey) ?? []) : [];
  const selectedPosts = selectedKey ? (postsByDay.get(selectedKey) ?? []) : [];
  const selectedScheduled = selectedRuns.filter((r) => r.kind === "scheduled").sort((a, b) => a.at - b.at);
  const selectedPast = selectedRuns.filter((r) => r.kind === "past").sort((a, b) => b.at - a.at);

  const selectedLabel = selectedKey
    ? (() => {
        const [y, m, d] = selectedKey.split("-").map(Number);
        return new Date(y, m, d).toLocaleDateString("en-US", { weekday: "long", month: "long", day: "numeric" });
      })()
    : "";

  const openLightbox = (images: AssetImage[], index: number) => setLightbox({ images, index });

  return (
    <div className="space-y-4">
      {/* Outside the grid AND outside the day detail below: both of those are
          rebuilt from `runs`, which no longer contains the schedule this is
          about. */}
      {pausedRun && <PausedRunNotice run={pausedRun} onDone={() => setPausedRun(null)} />}
      <PausedScheduleStrip schedules={pausedSchedules} />
      <div className="overflow-hidden rounded-[var(--radius)] border border-border bg-surface">
        {/* Header — wraps as a row before it wraps a control's label. Nothing
            here had a minimum width, so at laptop width the primary action
            broke first and read "Schedule a / run" beside a two-line heading. */}
        <div className="flex flex-wrap items-center justify-between gap-x-3 gap-y-2 border-b border-border px-4 py-3">
          <div className="flex min-w-0 items-center gap-2.5">
            <div className="flex h-7 w-7 shrink-0 items-center justify-center rounded-md border border-foreground/10 bg-foreground/[0.04]">
              <Icon name="CalendarClock" className="h-3.5 w-3.5 text-foreground/70" />
            </div>
            <div className="min-w-0">
              <p className="truncate text-sm font-medium leading-tight">Agent Calendar</p>
              <p className="truncate text-[11px] text-muted-2">
                {upcomingCount === 0 && pastCount === 0
                  ? "No runs yet"
                  : [
                      upcomingCount > 0 ? `${upcomingCount} upcoming` : null,
                      pastCount > 0 ? `${pastCount} completed` : null,
                    ].filter(Boolean).join(" · ")}
              </p>
            </div>
          </div>

          <div className="flex shrink-0 items-center gap-3">
            {canSchedule && (
              <Button
                size="sm"
                variant="accent"
                className="shrink-0 whitespace-nowrap"
                onClick={() => setScheduleOpen(true)}
              >
                <Icon name="Plus" className="h-3.5 w-3.5" />
                Schedule a run
              </Button>
            )}
            <div className="flex items-center gap-1">
              <button onClick={prevMonth} className="flex h-7 w-7 shrink-0 items-center justify-center rounded-lg text-muted transition-colors hover:bg-surface-2 hover:text-foreground">
                <Icon name="ChevronLeft" className="h-4 w-4" />
              </button>
              <span className="w-[130px] shrink-0 whitespace-nowrap text-center text-sm font-medium">{MONTH_NAMES[viewMonth]} {viewYear}</span>
              <button onClick={nextMonth} className="flex h-7 w-7 shrink-0 items-center justify-center rounded-lg text-muted transition-colors hover:bg-surface-2 hover:text-foreground">
                <Icon name="ChevronRight" className="h-4 w-4" />
              </button>
            </div>
          </div>
        </div>

        {/* Day-of-week header — seven columns need width to mean anything */}
        <div className="hidden grid-cols-7 border-b border-border sm:grid">
          {DAY_LABELS.map((d) => (
            <div key={d} className="py-1.5 text-center text-[10px] font-mono font-medium uppercase tracking-[0.14em] text-muted-2">{d}</div>
          ))}
        </div>

        {/* Grid */}
        <div className="hidden grid-cols-7 sm:grid">
          {Array.from({ length: totalCells }, (_, i) => {
            const day = i - firstDayOfWeek + 1;
            const isValid = day >= 1 && day <= totalDays;
            const isToday = isValid && isCurrentMonth && day === today.getDate();
            const key = isValid ? `${viewYear}-${viewMonth}-${day}` : "";
            const dayRuns = isValid ? (runsByDay.get(key) ?? []) : [];
            const dayPosts = isValid ? (postsByDay.get(key) ?? []) : [];
            const chipCount = dayRuns.length + dayPosts.length;
            const isLastCol = (i + 1) % 7 === 0;
            const isSelected = key !== "" && key === selectedKey;

            // An empty day is where staff want to PUT something — clicking one
            // opens the schedule form with that date already filled in.
            const canScheduleHere = isValid && chipCount === 0 && canSchedule;
            const activate = () => {
              if (!isValid) return;
              if (chipCount > 0) setSelectedKey(key);
              else if (canScheduleHere) {
                setSchedulePrefillAt(new Date(viewYear, viewMonth, day, 9, 0, 0, 0).getTime());
                setScheduleOpen(true);
              }
            };
            const interactive = isValid && (chipCount > 0 || canScheduleHere);

            return (
              <div
                key={i}
                onClick={activate}
                role={interactive ? "button" : undefined}
                tabIndex={interactive ? 0 : -1}
                aria-label={canScheduleHere ? `Schedule a run on ${MONTH_NAMES[viewMonth]} ${day}` : undefined}
                onKeyDown={(event) => {
                  if (!interactive) return;
                  if (event.key === "Enter" || event.key === " ") {
                    event.preventDefault();
                    activate();
                  }
                }}
                className={cn(
                  "min-h-[84px] border-b border-r border-border p-1 text-left align-top transition-colors",
                  !isValid && "bg-surface-deep",
                  isToday && "bg-foreground/[0.04]",
                  isSelected && "bg-neon-soft/40 ring-1 ring-inset ring-neon/40",
                  interactive && "cursor-pointer hover:bg-surface-2",
                  isLastCol && "border-r-0",
                )}
              >
                {isValid && (
                  <>
                    <span className={cn(
                      "mb-1 flex h-5 w-5 items-center justify-center rounded-full text-[11px] font-medium leading-none",
                      isToday ? "bg-primary text-primary-foreground font-bold" : "text-muted-2",
                    )}>
                      {day}
                    </span>
                    <div className="space-y-[3px]">
                      {dayRuns.slice(0, 3).map((r) => <RunChip key={r.kind + r.id} run={r} />)}
                    {dayRuns.length < 3 &&
                      dayPosts
                        .slice(0, 3 - dayRuns.length)
                        .map((p) => (
                          <PostChip key={p.assetId} post={p} onOpen={setOpenAssetId} viewerIsClient={viewerIsClient} />
                        ))}
                    {chipCount > 3 && <p className="pl-1 text-[11px] text-muted-2">+{chipCount - 3} more</p>}
                  </div>
                </>
              )}
              </div>
            );
          })}
        </div>

        {/* Phone agenda — only the days with something on them */}
        <ul className="divide-y divide-border sm:hidden">
          {agendaDays.length === 0 ? (
            <li className="px-4 py-6 text-center text-xs text-muted-2">
              Nothing scheduled in {MONTH_NAMES[viewMonth]}.
            </li>
          ) : (
            agendaDays.map(({ key, day, runs: dayRuns, posts: dayPosts }) => {
              const isToday = isCurrentMonth && day === today.getDate();
              return (
                <li key={key} className={cn("px-3 py-2.5", isToday && "bg-foreground/[0.04]")}>
                  <button
                    type="button"
                    onClick={() => setSelectedKey(key)}
                    className="mb-1.5 flex min-h-[24px] w-full items-center gap-2 text-left"
                  >
                    <span className="text-xs font-semibold">
                      {DAY_LABELS[new Date(viewYear, viewMonth, day).getDay()]} {day}
                    </span>
                    <span className="text-[11px] text-muted-2">
                      {dayRuns.length + dayPosts.length} item
                      {dayRuns.length + dayPosts.length === 1 ? "" : "s"}
                    </span>
                    <Icon name="ChevronRight" className="ml-auto h-3.5 w-3.5 text-muted-2" />
                  </button>
                  <div className="space-y-1.5">
                    {dayRuns.map((r) => <RunChip key={r.kind + r.id} run={r} size="row" />)}
                    {dayPosts.map((p) => (
                      <PostChip key={p.assetId} post={p} onOpen={setOpenAssetId} size="row" viewerIsClient={viewerIsClient} />
                    ))}
                  </div>
                </li>
              );
            })
          )}
        </ul>

        {/* Legend + status filter — each chip toggles that status's visibility on the grid above. */}
        <div className="flex flex-wrap items-center gap-x-5 gap-y-1 border-t border-border px-4 py-2">
          <LegendDot className="border border-dashed border-foreground/40 bg-foreground/[0.03]" label="Scheduled run" />
          <LegendDot className="bg-foreground/25" label="Completed run" />
          {(Object.keys(STATUS_FILTER_CHIP_CLASS) as CalendarFilterKey[])
            // A filter this viewer's calendar can never make dim anything is not
            // offered at all — see calendarFilterKeyMatchable for which those are
            // and why. The chips a client CAN match are unchanged.
            .filter((key) => calendarFilterKeyMatchable(key, viewerIsClient))
            .map((key) => (
              <FilterChip
                key={key}
                className={STATUS_FILTER_CHIP_CLASS[key]}
                // No `key === "published" ? …` here any more. That ternary was the
                // second spelling of an override the label module already owned.
                label={calendarFilterLabel(key, viewerIsClient)}
                hidden={hiddenStatuses.has(key)}
                onClick={() => toggleStatus(key)}
              />
            ))}
        </div>
      </div>

      {/* Day detail */}
      {selectedKey && (
        <div className="rounded-[var(--radius)] border border-border bg-surface-2/40 p-4">
          <div className="mb-3 flex items-center justify-between">
            <h3 className="text-sm font-semibold">{selectedLabel}</h3>
            <button onClick={() => setSelectedKey(null)} className="rounded-md p-1 text-muted-2 hover:bg-surface-2 hover:text-foreground" aria-label="Close">
              <Icon name="X" className="h-4 w-4" />
            </button>
          </div>

          {selectedScheduled.length + selectedPast.length + selectedPosts.length === 0 ? (
            <p className="text-xs text-muted-2">Nothing on this day.</p>
          ) : (
            <div className="space-y-4">
              {selectedScheduled.length > 0 && (
                <Section title="Upcoming runs">
                  {selectedScheduled.map((r) => (
                    <ScheduledRunCard
                      key={r.id}
                      run={r}
                      canManage={canManageRuns || canSchedule}
                      canDelete={canSchedule}
                      canOpenJob={canSchedule}
                      // The disclosure question, threaded from this component's own
                      // viewer rather than reusing one of the capability flags above.
                      viewerIsClient={viewerIsClient}
                      // Only the two fields the notice prints and acts on: the
                      // whole CalendarRun is a projected occurrence, and holding
                      // one past the refresh that deleted its row would leave a
                      // stale "next fire" in state for a schedule that has none.
                      onPaused={(r) => setPausedRun({ id: r.id, productName: r.productName })}
                    />
                  ))}
                </Section>
              )}
              {selectedPast.length > 0 && (
                <Section title="Completed runs">
                  {selectedPast.map((r) => (
                    <PastRunCard
                      key={r.id}
                      run={r}
                      canOpenJob={canSchedule}
                      viewerIsClient={viewerIsClient}
                      onOpenLightbox={openLightbox}
                      onOpenAsset={setOpenAssetId}
                    />
                  ))}
                </Section>
              )}
              {selectedPosts.length > 0 && (
                <Section title="Posts">
                  {selectedPosts.sort((a, b) => a.at - b.at).map((p) => (
                    <PostCard
                      viewerIsClient={viewerIsClient}
                      key={p.assetId}
                      post={p}
                      asset={assetById.get(p.assetId)}
                      onOpenLightbox={openLightbox}
                      onOpenDetails={setOpenAssetId}
                    />
                  ))}
                </Section>
              )}
            </div>
          )}
        </div>
      )}

      {lightbox && (
        <ImageLightbox
          images={lightbox.images}
          index={lightbox.index}
          onIndexChange={(i) => setLightbox((s) => (s ? { ...s, index: i } : s))}
          onClose={() => setLightbox(null)}
        />
      )}

      <AssetDetailModal
        asset={openAsset}
        open={openAsset != null}
        onClose={() => setOpenAssetId(null)}
        viewerIsClient={viewerIsClient}
        canPublish={canSchedule}
        connectedPlatforms={openAsset ? connectedPlatformsByClient?.[openAsset.clientId] ?? [] : []}
      />

      {scheduleOpen && (
        <ScheduleRunModal
          clients={clients}
          agents={agents}
          defaultClientId={defaultClientId}
          {...(schedulePrefillAt != null ? { prefillAt: schedulePrefillAt } : {})}
          onClose={() => {
            setScheduleOpen(false);
            setSchedulePrefillAt(null);
          }}
        />
      )}
    </div>
  );
}

function LegendDot({ className, label }: { className: string; label: string }) {
  return (
    <div className="flex items-center gap-1.5 text-[11px] text-muted-2">
      <div className={cn("h-2.5 w-3.5 rounded-sm", className)} />
      {label}
    </div>
  );
}

/**
 * The legend, which is also the filter — its SWATCHES. A RECORD rather than the
 * array it was: an array satisfies its element type however short it is, so a new
 * `CalendarAssetKind` would have drawn chips on the grid that the legend never
 * named and the filter could never hide. Keyed over the union, a missing member
 * is a compile error. Rendered in insertion order.
 *
 * Every member is NAMED here — that is what the Record buys — but not every
 * member is OFFERED to every viewer: the render site filters through
 * `calendarFilterKeyMatchable`, which is where the per-viewer answer and its
 * enumeration live. Today that withholds exactly one chip from a client
 * ("draft", a status their calendar is never built from); "held" and the rest
 * stay, because a client's calendar can hold them.
 *
 * THE LABELS ARE NO LONGER HERE. They moved to `calendarFilterLabel`
 * (lib/calendar-kind) because two of them were wrong in a way a component-local
 * map hides: `review` invented "Pending review" for a `JobStatus` the run card
 * below this legend already calls "In review", and `published` had its viewer
 * override written both here and at the render site. Only the classes stayed —
 * presentation is this component's business, the same split asset-status-copy.ts
 * made.
 */
const STATUS_FILTER_CHIP_CLASS: Record<CalendarFilterKey, string> = {
  draft: POST_CHIP_CLASS.draft,
  scheduled: POST_CHIP_CLASS.scheduled,
  published: POST_CHIP_CLASS.published,
  held: POST_CHIP_CLASS.held,
  placeholder: POST_CHIP_CLASS.placeholder,
  failed: POST_CHIP_CLASS.failed,
  review: "bg-warning/25",
};

/** A legend dot that also toggles that status's visibility on the grid — dimmed while hidden. */
function FilterChip({
  className,
  label,
  hidden,
  onClick,
}: {
  className: string;
  label: string;
  hidden: boolean;
  onClick: () => void;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      aria-pressed={!hidden}
      // THE TEMPLATE CARRIES THE GRAMMAR, NOT THE LABEL. `Show ${label} items`
      // forces every legend word to be a bare adjective, which is what pushed this
      // register into inventing short names — and #97 was the bill for one of them
      // ("Pending review" for a state the sanctioned register calls "In review",
      // three lines of scroll apart on the same screen). Lower-casing made it
      // worse: the client-visible chip read "Show in review items". Quoting the
      // label instead lets a register keep its real words.
      title={hidden ? `Show "${label}" items` : `Hide "${label}" items`}
      className={cn(
        "flex items-center gap-1.5 rounded text-[11px] transition-opacity hover:opacity-100 focus:outline-none focus:ring-1 focus:ring-neon/50",
        hidden ? "opacity-40" : "opacity-100",
      )}
    >
      <div className={cn("h-2.5 w-3.5 rounded-sm", className)} />
      <span className={hidden ? "text-muted-2 line-through" : "text-muted-2"}>{label}</span>
    </button>
  );
}

function Section({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <div>
      <p className="mb-2 text-[11px] font-medium uppercase tracking-wide text-muted-2">{title}</p>
      <div className="space-y-2">{children}</div>
    </div>
  );
}
