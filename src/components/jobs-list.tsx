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
import type { JobStatus } from "@/lib/types";
import { cn, relativeTime } from "@/lib/utils";

/** One job as the cross-client list needs it — never the whole doc. */
export interface JobListRow {
  id: string;
  agentName: string;
  title: string;
  clientId: string;
  clientName: string;
  status: JobStatus;
  createdAt: number;
  emailed: boolean;
  /** Present only for custom-agent runs — gates the Retry button (retryJobAction requires it). */
  customAgentId?: string;
  /** Raw failure text, classified inline via job-error-taxonomy.ts. */
  error?: string | null;
}

/** Every state JobStatusBadge can render, in lifecycle order. */
const STATUSES: JobStatus[] = [
  "queued",
  "running",
  "review",
  "approved",
  "delivered",
  "failed",
  "cancelled",
];

/** The three buckets the summary chips group by — a superset of one-status filtering. */
type StatusFilter = "" | "active" | "failed" | "completed" | JobStatus;

const COMPLETED_STATUSES = new Set<JobStatus>(["review", "approved", "delivered"]);

function matchesStatusFilter(job: JobListRow, filter: StatusFilter): boolean {
  if (!filter) return true;
  if (filter === "active") return job.status === "queued" || job.status === "running";
  if (filter === "completed") return COMPLETED_STATUSES.has(job.status);
  return job.status === filter;
}

const PAGE = 50;

/**
 * The staff Jobs & Execution Pipeline: a filter strip + summary chips over
 * every agent run, then 50 rows at a time.
 *
 * This page renders one flat row per run across every client, and it is the
 * page staff use most — at agency scale, finding anything meant scrolling the
 * whole database. Filtering is client-side over rows the server already sent,
 * which is what makes the search instant; the paging cap is what keeps the DOM
 * from being the bottleneck.
 *
 * The summary chips (Active / Failed / Completed) are a second, coarser filter
 * over the SAME `status` state the dropdown drives — clicking one sets it to a
 * composite bucket ("active" = queued|running, "completed" = review|approved|
 * delivered), clicking the same chip again clears it. This mirrors the
 * dashboard's other filter-on-click surfaces (e.g. the Agent Leaderboard)
 * instead of inventing a second, disconnected filter mechanism.
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

  const counts = useMemo(() => {
    let active = 0;
    let failed = 0;
    let completed = 0;
    for (const job of jobs) {
      if (job.status === "queued" || job.status === "running") active++;
      else if (job.status === "failed") failed++;
      else if (COMPLETED_STATUSES.has(job.status)) completed++;
    }
    return { active, failed, completed };
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

  function toggleChip(bucket: "active" | "failed" | "completed") {
    reset(setStatus)(status === bucket ? "" : bucket);
  }

  return (
    <>
      {/* Autonomously ticks the whole list (and every running-row timer on it)
          while any run is in flight — same 4s polling AutoRefresh already
          uses on the single-job detail page — so nobody has to hit refresh to
          watch a run finish. */}
      {counts.active > 0 && <AutoRefresh />}

      <div className="mb-4 flex flex-wrap items-center gap-2">
        <SummaryChip
          label="Active"
          count={counts.active}
          tone="info"
          active={status === "active"}
          onClick={() => toggleChip("active")}
        />
        <SummaryChip
          label="Failed"
          count={counts.failed}
          tone="danger"
          active={status === "failed"}
          onClick={() => toggleChip("failed")}
        />
        <SummaryChip
          label="Completed"
          count={counts.completed}
          tone="neon"
          active={status === "completed"}
          onClick={() => toggleChip("completed")}
        />
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
              {value}
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

const CHIP_TONE_CLASS: Record<"info" | "danger" | "neon", string> = {
  info: "border-info/40 bg-info/10 text-info",
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
  tone: "info" | "danger" | "neon";
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
