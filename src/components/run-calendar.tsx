"use client";

import { useMemo, useState } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { Icon } from "@/components/icon";
import { AgentMark } from "@/components/agent-identity";
import { Badge, Button } from "@/components/ui";
import { JOB_STATUS_META } from "@/components/job-status";
import { ImageLightbox } from "@/components/image-lightbox";
import { AssetDetailModal } from "@/components/asset-detail-modal";
import { MarkPostedRow } from "@/components/mark-posted-row";
import { ScheduleRunModal } from "@/components/schedule-run-modal";
import { setPlannedRunStatusAction, deletePlannedRunAction } from "@/lib/actions/planned-run-actions";
import { cn, relativeTime } from "@/lib/utils";
import type { AssetImage } from "@/lib/asset-images";
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
  /** Staff-only tooltip carrying the job id - omitted from a client's payload. */
  staffRef?: string;
  assets?: RunAssetView[];
  /** Every image across the run's assets, in order - feeds the run lightbox. */
  images?: AssetImage[];
  // scheduled
  cadence?: PlannedRunCadence;
  cadenceLabel?: string;
  /**
   * IANA zone this schedule's wall clock was set in. Present on scheduled runs
   * only: a past run is an instant, a schedule is an intent, and the intent is
   * what has to be printed and bucketed consistently on server and browser.
   */
  timeZone?: string;
  /** Short zone label ("GMT-3") printed next to a schedule's wall clock. */
  zoneLabel?: string;
  /** The free-text request this run fires each time. */
  prompt?: string;
  agentDescription?: string;
  /**
   * The schedule's OWN track record - distinct from `jobStatus` above, which
   * only exists on a "past" (already-fired) entry. A "scheduled" card is a
   * pure future projection with no job of its own yet, so this is the only
   * way it can say anything about whether the schedule has actually been
   * firing: when it last ran, whether that fire produced a job to inspect,
   * and whether the fire itself was refused before a job ever existed
   * (PlannedScheduledRun.lastError - a submission refusal, not a job failure).
   */
  lastRunAt?: number;
  /** Staff-only: the job the schedule's most recent fire produced, if any - links to /jobs/[id]. */
  lastJobId?: string;
  lastError?: string | null;
  lastErrorAt?: number | null;
  /**
   * The schedule's raw stored `nextRunAt` was already behind "now" when this
   * occurrence was projected - it hasn't fired when it should have. Distinct
   * from `lastError` (a recorded refusal reason may or may not exist yet;
   * this is purely "the clock says it's overdue").
   *
   * `stuckLabel`/`stuckMessage` are resolved server-side (calendar-body.tsx),
   * not derived here from a plain boolean - the copy differs by viewer
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
  kind: "scheduled" | "published" | "placeholder" | "failed" | "draft";
  images: AssetImage[];
  textPreview: string;
  /** Set when kind is "failed" - the last publish attempt's error, shown in the chip tooltip and detail modal. */
  publishError?: string;
}

export interface CalendarClientOption {
  id: string;
  name: string;
}

/** The named calendar statuses a viewer can hide. "review" maps to CalendarRun.jobStatus, the rest to CalendarPost.kind. */
type StatusFilterKey = CalendarPost["kind"] | "review";

/* ── Constants ───────────────────────────────────────────────────────── */

const DAY_LABELS = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];
const MONTH_NAMES = [
  "January", "February", "March", "April", "May", "June",
  "July", "August", "September", "October", "November", "December",
];

/**
 * Which day cell an entry belongs in.
 *
 * With `timeZone` the day is resolved in that zone - the same answer on the
 * server render and in the browser, whatever either runtime's own zone is. A
 * scheduled run passes its stored zone (the day the person actually picked);
 * past runs and published posts are instants and stay in the viewer's day.
 */
function dayKey(at: number, timeZone?: string): string {
  if (timeZone) {
    const parts = new Intl.DateTimeFormat("en-US", {
      timeZone,
      year: "numeric",
      month: "numeric",
      day: "numeric",
    }).formatToParts(new Date(at));
    const get = (t: string) => Number(parts.find((p) => p.type === t)?.value);
    // Month is zero-based here to match the grid's `${year}-${month}-${day}` key.
    return `${get("year")}-${get("month") - 1}-${get("day")}`;
  }
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
 * minimum for a touch target - the grid chips were about 17px tall.
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
      }${run.clientName ? ` - ${run.clientName}` : ""}`}
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
  draft: "border border-dashed border-muted-2/40 bg-foreground/[0.02] text-muted-2",
};

const POST_KIND_LABEL: Record<CalendarPost["kind"], string> = {
  published: "Published",
  scheduled: "Scheduled post",
  placeholder: "Placeholder",
  failed: "Failed to publish",
  draft: "Draft",
};

function PostChip({
  post,
  onOpen,
  size = "cell",
}: {
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
      title={`${POST_KIND_LABEL[post.kind]}${post.kind === "failed" && post.publishError ? ` - ${post.publishError}` : ""} · ${post.title} · ${timeStr(post.at)}`}
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
}: {
  run: CalendarRun;
  /** Pause this schedule. Clients may manage their own (requireClientAccess). */
  canManage: boolean;
  /** Delete it outright - staff only; a client's undo is a staff member. */
  canDelete: boolean;
  /** Staff. /jobs/[id] is staff-guarded and silently redirects a client to /dashboard. */
  canOpenJob: boolean;
}) {
  const router = useRouter();
  const [busy, setBusy] = useState<null | "pause" | "delete">(null);
  const [error, setError] = useState<string | null>(null);
  const [confirmingDelete, setConfirmingDelete] = useState(false);
  const [paused, setPaused] = useState(false);

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

  async function pause() {
    if (busy) return;
    setBusy("pause");
    setError(null);
    try {
      const res = await setPlannedRunStatusAction(run.id, "paused");
      if (res?.error) {
        setError(res.error);
        return;
      }
      // The calendar only carries active schedules, so this card is about to
      // disappear - say so rather than letting it blink out.
      setPaused(true);
      router.refresh();
    } catch (e) {
      setError(e instanceof Error ? e.message : "Couldn't pause this schedule.");
    } finally {
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
                cursor (see projectRunOccurrences's doc comment) - labeling it
                "Upcoming" would restate the exact misrepresentation this flag
                exists to stop. Label/message are both resolved server-side
                (calendar-body.tsx) so the copy is already correct for this
                viewer - never decided here. */}
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
          {/* The schedule's own track record - this card IS a future
              projection with no job of its own, so this is the only place it
              can say whether the schedule has actually been firing. A recent
              lastError means the fire was REFUSED before a job ever existed
              (credit cap, missing intake, agent service unreachable) - there
              is nothing to link to for that outcome, only the reason. */}
          {(run.lastRunAt || run.lastError) && (
            <div className="mt-2.5 border-t border-border pt-2">
              <p className="mb-1 text-[11px] font-medium uppercase tracking-wide text-muted-2">
                Last fire
              </p>
              {run.lastError ? (
                <p className="text-xs text-danger">
                  Failed to fire {run.lastErrorAt ? relativeTime(run.lastErrorAt) : ""} - {run.lastError}
                </p>
              ) : run.lastRunAt ? (
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
              ) : null}
            </div>
          )}
          {paused ? (
            <p className="mt-3 text-xs text-muted-2">
              Paused. It won&apos;t fire again until you resume it on the AI Agents page.
            </p>
          ) : (
            (canManage || canDelete) && (
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
            )
          )}
          {error && <p className="mt-2 text-xs text-danger">{error}</p>}
        </div>
      </div>
    </div>
  );
}

/** `Button` renders a <button>; an anchor can't nest one, so it borrows the look. */
const REVIEW_BUTTON_CLASS =
  "inline-flex h-8 items-center justify-center gap-1.5 rounded-md border border-border px-3 text-xs text-foreground transition-all duration-200 hover:border-foreground/30 hover:bg-foreground/[0.04] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-foreground/25";

function PastRunCard({
  run,
  canOpenJob,
  onOpenLightbox,
  onOpenAsset,
}: {
  run: CalendarRun;
  /** Staff. /jobs/[id] is staff-guarded and silently redirects a client to /dashboard. */
  canOpenJob: boolean;
  onOpenLightbox: (images: AssetImage[], index: number) => void;
  onOpenAsset: (assetId: string) => void;
}) {
  const images = run.images ?? [];
  const textAssets = (run.assets ?? []).filter((a) => a.images.length === 0 && a.textPreview);
  const status = run.jobStatus
    ? JOB_STATUS_META[run.jobStatus] ?? { tone: "neutral" as const, label: "Done" }
    : { tone: "neutral" as const, label: "Done" };
  const inFlight = run.jobStatus === "queued" || run.jobStatus === "running";

  // Where "review this" actually goes. Staff get the run detail page the
  // notification bell already links to; a client gets the deliverable itself,
  // in the same detail panel the post cards below open. Telling someone
  // something is ready to review and giving them nothing to click is the gap.
  const firstAssetId = run.assets?.[0]?.id;
  const reviewable = run.jobStatus === "review";
  const href = canOpenJob ? `/jobs/${run.id}` : null;
  const openAsset = !canOpenJob && firstAssetId ? () => onOpenAsset(firstAssetId) : null;

  const heading = (
    <>
      <p className="text-sm font-medium">{run.productName}</p>
      {/* Never `run.jobStatus` raw - that prints the database enum. */}
      <Badge tone={status.tone}>{status.label}</Badge>
      {run.clientName && <Badge tone="neutral">{run.clientName}</Badge>}
    </>
  );

  return (
    // Product code and job id are staff bookkeeping - a tooltip the server only
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
          <p className="mt-0.5 text-xs text-muted-2">
            {run.outputSummary ? `${run.outputSummary} · ` : ""}
            {inFlight ? "Started" : "Ran"} {timeStr(run.at)}
          </p>

          {reviewable && (href || openAsset) && (
            <div className="mt-2">
              {href ? (
                <Link href={href} className={REVIEW_BUTTON_CLASS}>
                  Review deliverable
                  <Icon name="ArrowRight" className="h-3.5 w-3.5" />
                </Link>
              ) : (
                <Button size="sm" variant="outline" onClick={openAsset!}>
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
          ) : images.length === 0 && textAssets.length === 0 ? (
            <p className="mt-2 text-xs text-muted-2">No client-facing assets from this run.</p>
          ) : null}

          {/* Image gallery - click any to slide through the whole run */}
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
  asset,
  onOpenLightbox,
  onOpenDetails,
}: {
  post: CalendarPost;
  /** The underlying asset, when the viewer has it - drives Mark as posted. */
  asset?: Asset;
  onOpenLightbox: (images: AssetImage[], index: number) => void;
  onOpenDetails: (assetId: string) => void;
}) {
  const tone = post.kind === "published" ? "success" : post.kind === "scheduled" ? "info" : "neutral";
  const label = post.kind === "published" ? "Published" : post.kind === "scheduled" ? "Scheduled" : "Placeholder";
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
        {/* Day-card attestation: the client posts by hand, then says so here -
            the same single transition the detail modal offers (QA F149). */}
        {asset && <MarkPostedRow asset={asset} compact />}
      </div>
    </div>
  );
}

/* ── Main component ──────────────────────────────────────────────────── */

export function RunCalendar({
  runs,
  posts,
  assets,
  canSchedule = false,
  canManageRuns = false,
  clients = [],
  agents = [],
  connectedPlatformsByClient,
  defaultClientId,
}: {
  runs: CalendarRun[];
  posts: CalendarPost[];
  assets: Asset[];
  /** Staff on their own clients - shows the "Schedule a run" button + staff-only controls. */
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
  // Status filter: which of the named calendar statuses are currently hidden.
  // "review" is a CalendarRun bucket (jobStatus === "review", i.e. Pending
  // Review) - everything else is a CalendarPost kind.
  const [hiddenStatuses, setHiddenStatuses] = useState<Set<StatusFilterKey>>(new Set());
  const toggleStatus = (key: StatusFilterKey) =>
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
      const k = dayKey(r.at, r.timeZone);
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

  // Distinct scheduled runs, not chip count - a recurring run now projects one
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
      <div className="overflow-hidden rounded-[var(--radius)] border border-border bg-surface">
        {/* Header - wraps as a row before it wraps a control's label. Nothing
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

        {/* Day-of-week header - seven columns need width to mean anything */}
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

            // An empty day is where staff want to PUT something - clicking one
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
                          <PostChip key={p.assetId} post={p} onOpen={setOpenAssetId} />
                        ))}
                    {chipCount > 3 && <p className="pl-1 text-[11px] text-muted-2">+{chipCount - 3} more</p>}
                  </div>
                </>
              )}
              </div>
            );
          })}
        </div>

        {/* Phone agenda - only the days with something on them */}
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
                      <PostChip key={p.assetId} post={p} onOpen={setOpenAssetId} size="row" />
                    ))}
                  </div>
                </li>
              );
            })
          )}
        </ul>

        {/* Legend + status filter - each chip toggles that status's visibility on the grid above. */}
        <div className="flex flex-wrap items-center gap-x-5 gap-y-1 border-t border-border px-4 py-2">
          <LegendDot className="border border-dashed border-foreground/40 bg-foreground/[0.03]" label="Scheduled run" />
          <LegendDot className="bg-foreground/25" label="Completed run" />
          {STATUS_FILTER_CHIPS.map((chip) => (
            <FilterChip
              key={chip.key}
              className={chip.className}
              label={chip.label}
              hidden={hiddenStatuses.has(chip.key)}
              onClick={() => toggleStatus(chip.key)}
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

const STATUS_FILTER_CHIPS: Array<{ key: StatusFilterKey; label: string; className: string }> = [
  { key: "draft", label: "Draft", className: POST_CHIP_CLASS.draft },
  { key: "scheduled", label: "Scheduled", className: POST_CHIP_CLASS.scheduled },
  { key: "published", label: "Published", className: POST_CHIP_CLASS.published },
  { key: "placeholder", label: "Placeholder", className: POST_CHIP_CLASS.placeholder },
  { key: "failed", label: "Failed", className: POST_CHIP_CLASS.failed },
  { key: "review", label: "Pending review", className: "bg-warning/25" },
];

/** A legend dot that also toggles that status's visibility on the grid - dimmed while hidden. */
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
      title={hidden ? `Show ${label.toLowerCase()} items` : `Hide ${label.toLowerCase()} items`}
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
