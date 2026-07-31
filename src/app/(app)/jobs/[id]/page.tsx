import Link from "next/link";
import { Suspense } from "react";
import { notFound } from "next/navigation";
import { requireUser } from "@/lib/auth";
import { getJob, getClient, getAsset } from "@/lib/data";
import { Card, CardTitle, Badge, Spinner } from "@/components/ui";
import { Icon } from "@/components/icon";
import { JobStatusBadge } from "@/components/job-status";
import { AssetCard } from "@/components/asset-card";
import { AutoRefresh } from "@/components/auto-refresh";
import { ManagedJobCancelButton } from "@/components/managed-job-cancel";
import { ManagedJobProgress } from "@/components/managed-job-progress";
import { JobDeleteButton } from "@/components/job-delete";
import { JobRetryButton } from "@/components/job-retry";
import { JobTranscript, TranscriptCount } from "@/components/job-transcript";
import { fetchJobTranscript } from "@/lib/agent-service/transcript";
import { pushablePlatformsByClient } from "@/lib/publish-targets";
import { classifyJobError } from "@/lib/job-error-taxonomy";
import { normalizeDashes } from "@/lib/text-utils";
import type { Job } from "@/lib/types";
import { formatDateTime } from "@/lib/utils";

export default async function JobDetailPage({ params }: { params: Promise<{ id: string }> }) {
  const user = await requireUser(["KAROS_ADMIN", "KAROS_EMPLOYEE"]);
  const { id } = await params;
  const job = await getJob(id);
  if (!job) notFound();
  const [client, ...assets] = await Promise.all([
    getClient(job.clientId),
    ...job.assetIds.map((aid) => getAsset(aid)),
  ]);
  const realAssets = assets.filter((a) => !!a);
  const inProgress = job.status === "running" || job.status === "queued";
  const classifiedError = classifyJobError(job.error);

  // F107 - without this the deliverables here rendered with no connectedPlatforms,
  // so Publish Now never appeared on the job page even for an approved post whose
  // client has a usable integration. Same helper /assets uses, so the "pushable"
  // predicate cannot drift; this page is already staff-only, and what crosses to
  // the client component is platform ids, never integration records.
  const connectedPlatforms = (await pushablePlatformsByClient(realAssets))?.[job.clientId];

  return (
    <>
      {inProgress && <AutoRefresh />}
      <Link href="/jobs" className="mb-4 inline-flex items-center gap-1 text-xs text-muted hover:text-foreground">
        <Icon name="ArrowLeft" className="h-3.5 w-3.5" /> All jobs
      </Link>

      <div className="mb-6 flex flex-wrap items-center justify-between gap-3">
        <div>
          <h1 className="text-2xl font-semibold tracking-tight">{job.agentName}</h1>
          <p className="text-sm text-muted">
            {client?.name ?? "-"} · {formatDateTime(job.createdAt)}
            {job.emailedTo && <span className="text-neon-dim"> · emailed to {job.emailedTo}</span>}
          </p>
        </div>
        <div className="flex items-center gap-3">
          {job.external && inProgress && <ManagedJobCancelButton jobId={job.id} />}
          {job.status === "failed" && job.customAgentId && <JobRetryButton jobId={job.id} />}
          {user.role === "KAROS_ADMIN" && <JobDeleteButton jobId={job.id} />}
          <JobStatusBadge status={job.status} />
        </div>
      </div>

      {job.external && <ManagedJobProgress status={job.status} />}

      <div className="grid gap-6 lg:grid-cols-[minmax(0,1fr)_320px]">
        <div className="space-y-6">
          {realAssets.length > 0 && (
            <div>
              <CardTitle className="mb-3">Deliverables</CardTitle>
              <div className="space-y-3">
                {realAssets.map((a) => (
                  <AssetCard
                    key={a.id}
                    asset={a}
                    canApprove
                    {...(connectedPlatforms ? { connectedPlatforms } : {})}
                  />
                ))}
              </div>
            </div>
          )}

          {job.error && (
            <Card className="border-danger/30 bg-danger/5">
              <CardTitle className="mb-1 text-danger">Error</CardTitle>
              {/* Best-effort classification over the raw text below - see
                  job-error-taxonomy.ts's doc comment. Not shown when it can't
                  do better than restate the raw string. */}
              {classifiedError && classifiedError.label !== "Unexpected error" && (
                <p className="mb-1 text-sm font-medium text-danger">{classifiedError.label}</p>
              )}
              <p className="text-sm text-muted">{job.error}</p>
            </Card>
          )}

          {job.rawOutput && (
            <Card>
              <CardTitle className="mb-2">Raw model output</CardTitle>
              <pre className="max-h-96 overflow-auto whitespace-pre-wrap rounded-lg bg-surface-2 p-3 text-xs text-muted">{normalizeDashes(job.rawOutput)}</pre>
            </Card>
          )}

          {job.external?.transcriptUrl && (
            <Suspense
              fallback={
                <Card>
                  <CardTitle className="mb-2">Agent transcript</CardTitle>
                  <p className="flex items-center gap-2 text-sm text-muted-2">
                    <Spinner className="h-3.5 w-3.5" /> Loading the run transcript…
                  </p>
                </Card>
              }
            >
              <TranscriptSection job={job} />
            </Suspense>
          )}
        </div>

        <div className="space-y-6">
          {job.external && (
            <Card>
              <CardTitle className="mb-3">Agent run</CardTitle>
              <dl className="space-y-2 text-sm">
                {job.external.totalCostUsd !== undefined && (
                  <div className="flex justify-between">
                    <dt className="text-xs text-muted-2">Cost (estimate)</dt>
                    <dd>${job.external.totalCostUsd.toFixed(4)}</dd>
                  </div>
                )}
                {job.external.inputTokens !== undefined && (
                  <div className="flex justify-between">
                    <dt className="text-xs text-muted-2">Tokens in / out</dt>
                    <dd>
                      {job.external.inputTokens.toLocaleString()} / {job.external.outputTokens?.toLocaleString() ?? 0}
                    </dd>
                  </div>
                )}
                {job.external.model && (
                  <div className="flex justify-between gap-2">
                    <dt className="text-xs text-muted-2">Model</dt>
                    <dd className="truncate text-xs">{job.external.model}</dd>
                  </div>
                )}
                {job.external.agentsRepoSha && (
                  <div className="flex justify-between">
                    <dt className="text-xs text-muted-2">Agents repo</dt>
                    <dd className="font-mono text-xs">{job.external.agentsRepoSha.slice(0, 10)}</dd>
                  </div>
                )}
              </dl>
              {(job.external.artifacts?.length ?? 0) > 0 && (
                <div className="mt-4">
                  <p className="mb-1.5 text-xs text-muted-2">Artifacts</p>
                  <ul className="space-y-1">
                    {job.external.artifacts!.map((a) => (
                      <li key={a.path} className="flex items-center gap-1.5 text-xs">
                        <Icon name={a.clientFacing ? "FileCheck" : "FileLock"} className="h-3.5 w-3.5 shrink-0 text-muted-2" />
                        {a.url ? (
                          <a href={a.url} target="_blank" rel="noreferrer" className="truncate hover:text-neon">
                            {a.name}
                          </a>
                        ) : (
                          <span className="truncate">{a.name}</span>
                        )}
                        {!a.clientFacing && <Badge tone="neutral">internal</Badge>}
                      </li>
                    ))}
                  </ul>
                </div>
              )}
            </Card>
          )}

          <Card>
            <CardTitle className="mb-3">Inputs</CardTitle>
            {Object.entries(job.input).filter(([, v]) => v).length === 0 ? (
              <p className="text-sm text-muted-2">No inputs.</p>
            ) : (
              <dl className="space-y-2">
                {Object.entries(job.input).filter(([, v]) => v).map(([k, v]) => (
                  <div key={k}>
                    <dt className="text-xs text-muted-2">{k}</dt>
                    <dd className="text-sm">{v}</dd>
                  </div>
                ))}
              </dl>
            )}
          </Card>

          <Card>
            <CardTitle className="mb-3">Run log</CardTitle>
            <ul className="space-y-2.5">
              {job.events.map((e, i) => (
                <li key={i} className="flex gap-2 text-xs">
                  <Icon
                    name={e.level === "error" ? "CircleAlert" : e.level === "success" ? "CircleCheckBig" : "Circle"}
                    className={`mt-0.5 h-3.5 w-3.5 shrink-0 ${e.level === "error" ? "text-danger" : e.level === "success" ? "text-neon" : "text-muted-2"}`}
                  />
                  <div>
                    <p className="text-foreground">{e.message}</p>
                    <p className="text-muted-2">{formatDateTime(e.at)}</p>
                  </div>
                </li>
              ))}
            </ul>
          </Card>
        </div>
      </div>
    </>
  );
}

/** Async island: fetches + parses the SDK run transcript without blocking the page. */
async function TranscriptSection({ job }: { job: Job }) {
  const result = await fetchJobTranscript(job);
  return (
    <Card>
      <div className="mb-3 flex items-center justify-between gap-2">
        <CardTitle>Agent transcript</CardTitle>
        {result.ok && result.turns.length > 0 && <TranscriptCount turns={result.turns} />}
      </div>
      <p className="mb-4 text-xs text-muted-2">What the agent reasoned and the tools it ran to produce the deliverables.</p>
      {result.ok ? (
        <JobTranscript turns={result.turns} truncated={result.truncated} />
      ) : (
        <div className="space-y-2 text-sm text-muted-2">
          <p>{result.reason}</p>
          {result.rawUrl && (
            <a
              href={result.rawUrl}
              target="_blank"
              rel="noreferrer"
              className="inline-flex items-center gap-1 text-xs text-neon-dim hover:text-neon"
            >
              <Icon name="ExternalLink" className="h-3.5 w-3.5" /> Open raw transcript
            </a>
          )}
        </div>
      )}
    </Card>
  );
}
