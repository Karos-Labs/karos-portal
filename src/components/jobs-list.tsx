"use client";

import { useMemo, useState, useTransition } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { Card, EmptyState, Input, Select, Spinner } from "@/components/ui";
import { Icon } from "@/components/icon";
import { JobStatusBadge } from "@/components/job-status";
import { JobDeleteButton } from "@/components/job-delete";
import { AutoRefresh } from "@/components/auto-refresh";
import { retryJobAction } from "@/lib/actions";
import { classifyJobError } from "@/lib/job-error-taxonomy";
import { JOB_STATUS_META, jobStatusLabel } from "@/lib/job-status-copy";
import {
  ALL_JOB_BUCKETS,
  jobBucketLabel,
  jobBucketTone,
  jobInBucket,
  type JobBucket,
} from "@/lib/job-list-buckets";
import type { JobStatus } from "@/lib/types";
import { cn, relativeTime } from "@/lib/utils";

/** One job as the cross-client list needs it - never the whole doc. */
export interface JobListRow {
  id: string;
  agentName: string;
  title: string;
  clientId: string;
  clientName: string;
  status: JobStatus;
  createdAt: number;
  emailed: boolean;
  /** Present only for custom-agent runs - gates the Retry button (retryJobAction requires it). */
  customAgentId?: string;
  /** Raw failure text, classified inline via job-error-taxonomy.ts. */
  error?: string | null;
}

/**
 * Every state the dropdown offers, in lifecycle order — READ OFF THE REGISTER
 * rather than typed here.
 *
 * `JOB_STATUS_META` is a `Record<JobStatus, …>`, which tsc keeps total, and its
 * insertion order already IS the lifecycle order this list was hand-written in. So
 * a state added to the union appears in this filter without anyone remembering,
 * where the literal it replaces would have silently stopped offering one.
 */
const STATUSES = Object.keys(JOB_STATUS_META) as JobStatus[];

/**
 * What the filter state can hold: nothing, one bucket, or one exact status.
 *
 * A bucket key and a status can collide (`review` and `failed` are both), which is
 * harmless here only because `jobInBucket` and `job.status === filter` agree
 * whenever they do — a single-state bucket matches exactly the state it names. The
 * bucket branch is asked first either way.
 */
type StatusFilter = "" | JobBucket | JobStatus;

function matchesStatusFilter(job: JobListRow, filter: StatusFilter): boolean {
  if (!filter) return true;
  // The chips' own test, not a second copy of it — a chip that counts a row the
  // list then hides is the shape of the defect this replaced.
  if ((ALL_JOB_BUCKETS as readonly string[]).includes(filter)) {
    return jobInBucket(job.status, filter as JobBucket);
  }
  return job.status === filter;
}

const PAGE = 50;

/**
 * The staff Jobs & Execution Pipeline: a filter strip + summary chips over
 * every agent run, then 50 rows at a time.
 *
 * This page renders one flat row per run across every client, and it is the
 * page staff use most - at agency scale, finding anything meant scrolling the
 * whole database. Filtering is client-side over rows the server already sent,
 * which is what makes the search instant; the paging cap is what keeps the DOM
 * from being the bottleneck.
 *
 * The summary chips are a second, coarser filter over the SAME `status` state the
 * dropdown drives — clicking one sets it to a bucket, clicking the same chip again
 * clears it. This mirrors the dashboard's other filter-on-click surfaces (e.g. the
 * Agent Leaderboard) instead of inventing a second, disconnected filter mechanism.
 *
 * WHICH buckets exist, what each holds and what each is called all live in
 * lib/job-list-buckets — deliberately not named here. This comment used to say
 * "Active / Failed / Completed" and spell out that "completed" meant
 * review|approved|delivered, and it was accurate: `review` really was counted as
 * completed, so "Completed 14" sat above fourteen rows badged "In review". A
 * grouping described in two places is a grouping that can be wrong in one of
 * them, so the row now renders whatever the module enumerates.
 */
export function JobsList({ jobs, isAdmin }: { jobs: JobListRow[]; isAdmin: boolean }) {
  const [status, setStatus] = useState<StatusFilter>("");
  const [clientId, setClientId] = useState("");
  const [query, setQuery] = useState("");
  const [limit, setLimit] = useState(PAGE);

  const clients = useMemo(() => {
    const byId = new Map<string, string>();
    for (const job of jobs) byId.set(job.clientId, job.clientName);
    return [...byId].sort((a, b) => a[1].localeCompare(b[1]));
  }, [jobs]);

  // Counted off the same predicate the filter uses, over the buckets the module
  // enumerates — so adding a bucket adds a chip, and no chip can count a row the
  // filter would then hide. The old version spelled its own if/else chain beside
  // `matchesStatusFilter`'s, which is how "Completed" came to include `review` in
  // one of them.
  const counts = useMemo(() => {
    const out = new Map<JobBucket, number>(ALL_JOB_BUCKETS.map((b) => [b, 0]));
    for (const job of jobs) {
      for (const bucket of ALL_JOB_BUCKETS) {
        if (jobInBucket(job.status, bucket)) out.set(bucket, out.get(bucket)! + 1);
      }
    }
    return out;
  }, [jobs]);

  const filtered = useMemo(() => {
    const needle = query.trim().toLowerCase();
    return jobs.filter((job) => {
      if (!matchesStatusFilter(job, status)) return false;
      if (clientId && job.clientId !== clientId) return false;
      if (!needle) return true;
      return (
        job.agentName.toLowerCase().includes(needle) || job.title.toLowerCase().includes(needle)
      );
    });
  }, [jobs, status, clientId, query]);

  const shown = filtered.slice(0, limit);

  function reset<T>(setter: (value: T) => void) {
    return (value: T) => {
      setter(value);
      setLimit(PAGE);
    };
  }

  function toggleChip(bucket: JobBucket) {
    reset(setStatus)(status === bucket ? "" : bucket);
  }

  return (
    <>
      {/* Autonomously ticks the whole list (and every running-row timer on it)
          while any run is in flight - same 4s polling AutoRefresh already
          uses on the single-job detail page - so nobody has to hit refresh to
          watch a run finish. */}
      {counts.get("active")! > 0 && <AutoRefresh />}

      <div className="mb-4 flex flex-wrap items-center gap-2">
        {ALL_JOB_BUCKETS.map((bucket) => (
          <SummaryChip
            key={bucket}
            label={jobBucketLabel(bucket)}
            count={counts.get(bucket) ?? 0}
            tone={jobBucketTone(bucket)}
            active={status === bucket}
            onClick={() => toggleChip(bucket)}
          />
        ))}
      </div>

      <div className="mb-4 grid gap-2 sm:grid-cols-[1fr_auto_auto]">
        <Input
          value={query}
          onChange={(event) => reset(setQuery)(event.target.value)}
          placeholder="Search agent or title…"
          aria-label="Search jobs"
        />
        <Select
          value={status}
          onChange={(event) => reset(setStatus)(event.target.value as StatusFilter)}
          aria-label="Filter by status"
        >
          <option value="">All statuses</option>
          {STATUSES.map((value) => (
            <option key={value} value={value}>
              {/* The register, not `{value}`. This dropdown printed the raw
                  database word while the badge on every row it filters printed
                  the register's — one state, two names, one screen, which is the
                  same defect as the calendar legend's "Pending review". */}
              {jobStatusLabel(value)}
            </option>
          ))}
        </Select>
        <Select
          value={clientId}
          onChange={(event) => reset(setClientId)(event.target.value)}
          aria-label="Filter by client"
        >
          <option value="">All clients</option>
          {clients.map(([id, name]) => (
            <option key={id} value={id}>
              {name}
            </option>
          ))}
        </Select>
      </div>

      {filtered.length === 0 ? (
        <EmptyState
          icon={<Icon name="ListChecks" className="h-7 w-7" />}
          title="No jobs match those filters"
          description="Clear the search or pick a different status or client."
        />
      ) : (
        <>
          <Card className="p-0">
            <ul className="divide-y divide-border">
              {shown.map((job) => {
                const inFlight = job.status === "queued" || job.status === "running";
                const classifiedError = job.status === "failed" ? classifyJobError(job.error) : null;
                return (
                  <li key={job.id}>
                    <div className="flex items-center transition-colors hover:bg-surface-2/40">
                      <Link
                        href={`/jobs/${job.id}`}
                        className="flex min-w-0 flex-1 items-center justify-between gap-3 px-5 py-4"
                      >
                        <div className="min-w-0">
                          <p className="truncate text-sm font-medium">{job.agentName}</p>
                          <p className="text-xs text-muted-2">
                            {job.clientName} ·{" "}
                            {inFlight ? "started" : "ran"} {relativeTime(job.createdAt)}
                            {job.emailed && <span className="text-neon-dim"> · emailed</span>}
                          </p>
                        </div>
                        <JobStatusBadge status={job.status} />
                      </Link>
                      {isAdmin && (
                        <div className="pr-3">
                          <JobDeleteButton jobId={job.id} compact />
                        </div>
                      )}
                    </div>
                    {classifiedError && (
                      <div className="flex flex-wrap items-center justify-between gap-2 border-t border-border bg-danger/5 px-5 py-2">
                        <p className="truncate text-xs text-danger" title={classifiedError.raw}>
                          {classifiedError.label}
                        </p>
                        {job.customAgentId && <RetryButton jobId={job.id} />}
                      </div>
                    )}
                  </li>
                );
              })}
            </ul>
          </Card>
          <div className="mt-3 flex items-center justify-between gap-3">
            <p className="text-xs text-muted-2">
              Showing {shown.length} of {filtered.length}
              {filtered.length !== jobs.length ? ` (${jobs.length} total)` : ""}
            </p>
            {shown.length < filtered.length && (
              <button
                type="button"
                onClick={() => setLimit((current) => current + PAGE)}
                className="text-xs text-neon hover:underline"
              >
                Load {Math.min(PAGE, filtered.length - shown.length)} more
              </button>
            )}
          </div>
        </>
      )}
    </>
  );
}

/**
 * Keyed over `jobBucketTone`'s return type, so a tone that module can produce and
 * this table cannot paint is a compile error rather than an unstyled chip.
 */
const CHIP_TONE_CLASS: Record<ReturnType<typeof jobBucketTone>, string> = {
  info: "border-info/40 bg-info/10 text-info",
  warning: "border-warning/40 bg-warning/10 text-warning",
  danger: "border-danger/40 bg-danger/10 text-danger",
  neon: "border-neon/40 bg-neon/10 text-neon",
};

function SummaryChip({
  label,
  count,
  tone,
  active,
  onClick,
}: {
  label: string;
  count: number;
  tone: ReturnType<typeof jobBucketTone>;
  active: boolean;
  onClick: () => void;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      aria-pressed={active}
      className={cn(
        "flex items-center gap-1.5 rounded-full border px-3 py-1 text-xs font-medium transition-opacity hover:opacity-80",
        CHIP_TONE_CLASS[tone],
        !active && "opacity-70",
      )}
    >
      <span>{label}</span>
      <span className="font-mono">{count}</span>
    </button>
  );
}

/** Re-submits a failed custom-agent job (retryJobAction) straight from the cross-client list. */
function RetryButton({ jobId }: { jobId: string }) {
  const router = useRouter();
  const [pending, startTransition] = useTransition();
  const [error, setError] = useState<string | null>(null);

  return (
    <div className="flex shrink-0 items-center gap-2">
      {error && <span className="text-xs text-danger">{error}</span>}
      <button
        type="button"
        disabled={pending}
        onClick={() =>
          startTransition(async () => {
            const result = await retryJobAction(jobId);
            if (result.error) setError(result.error);
            else router.refresh();
          })
        }
        className="flex items-center gap-1 rounded-md border border-border bg-surface px-2 py-1 text-xs text-foreground transition-colors hover:bg-surface-2 disabled:opacity-50"
      >
        {pending ? <Spinner className="h-3.5 w-3.5" /> : <Icon name="RotateCw" className="h-3.5 w-3.5" />}
        Retry
      </button>
    </div>
  );
}
