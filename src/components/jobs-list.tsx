"use client";

import { useMemo, useState } from "react";
import Link from "next/link";
import { Card, EmptyState, Input, Select } from "@/components/ui";
import { Icon } from "@/components/icon";
import { JobStatusBadge } from "@/components/job-status";
import { JobDeleteButton } from "@/components/job-delete";
import type { JobStatus } from "@/lib/types";
import { relativeTime } from "@/lib/utils";

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

const PAGE = 50;

/**
 * The staff Jobs list: a filter strip over every agent run, then 50 rows at a
 * time.
 *
 * This page renders one flat row per run across every client, and it is the
 * page staff use most — at agency scale, finding anything meant scrolling the
 * whole database. Filtering is client-side over rows the server already sent,
 * which is what makes the search instant; the paging cap is what keeps the DOM
 * from being the bottleneck.
 */
export function JobsList({ jobs, isAdmin }: { jobs: JobListRow[]; isAdmin: boolean }) {
  const [status, setStatus] = useState("");
  const [clientId, setClientId] = useState("");
  const [query, setQuery] = useState("");
  const [limit, setLimit] = useState(PAGE);

  const clients = useMemo(() => {
    const byId = new Map<string, string>();
    for (const job of jobs) byId.set(job.clientId, job.clientName);
    return [...byId].sort((a, b) => a[1].localeCompare(b[1]));
  }, [jobs]);

  const filtered = useMemo(() => {
    const needle = query.trim().toLowerCase();
    return jobs.filter((job) => {
      if (status && job.status !== status) return false;
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

  return (
    <>
      <div className="mb-4 grid gap-2 sm:grid-cols-[1fr_auto_auto]">
        <Input
          value={query}
          onChange={(event) => reset(setQuery)(event.target.value)}
          placeholder="Search agent or title…"
          aria-label="Search jobs"
        />
        <Select
          value={status}
          onChange={(event) => reset(setStatus)(event.target.value)}
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
              {shown.map((job) => (
                <li key={job.id} className="flex items-center transition-colors hover:bg-surface-2/40">
                  <Link
                    href={`/jobs/${job.id}`}
                    className="flex min-w-0 flex-1 items-center justify-between gap-3 px-5 py-4"
                  >
                    <div className="min-w-0">
                      <p className="truncate text-sm font-medium">{job.agentName}</p>
                      <p className="text-xs text-muted-2">
                        {job.clientName} · {relativeTime(job.createdAt)}
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
                </li>
              ))}
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
