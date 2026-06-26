import Link from "next/link";
import { notFound } from "next/navigation";
import { requireUser } from "@/lib/auth";
import { getJob, getClient, getAsset } from "@/lib/data";
import { Card, CardTitle, Badge } from "@/components/ui";
import { Icon } from "@/components/icon";
import { JobStatusBadge } from "@/components/job-status";
import { AssetCard } from "@/components/asset-card";
import { AutoRefresh } from "@/components/auto-refresh";
import { formatDateTime } from "@/lib/utils";

export default async function JobDetailPage({ params }: { params: Promise<{ id: string }> }) {
  await requireUser(["KAROS_ADMIN", "KAROS_EMPLOYEE"]);
  const { id } = await params;
  const job = await getJob(id);
  if (!job) notFound();
  const [client, ...assets] = await Promise.all([
    getClient(job.clientId),
    ...job.assetIds.map((aid) => getAsset(aid)),
  ]);
  const realAssets = assets.filter(Boolean);
  const inProgress = job.status === "running" || job.status === "queued";

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
            {client?.name ?? "—"} · {formatDateTime(job.createdAt)}
            {job.emailedTo && <span className="text-neon-dim"> · emailed to {job.emailedTo}</span>}
          </p>
        </div>
        <JobStatusBadge status={job.status} />
      </div>

      <div className="grid gap-6 lg:grid-cols-[1fr_320px]">
        <div className="space-y-6">
          {realAssets.length > 0 && (
            <div>
              <CardTitle className="mb-3">Deliverables</CardTitle>
              <div className="space-y-3">
                {realAssets.map((a) => a && <AssetCard key={a.id} asset={a} canApprove />)}
              </div>
            </div>
          )}

          {job.error && (
            <Card className="border-danger/30 bg-danger/5">
              <CardTitle className="mb-1 text-danger">Error</CardTitle>
              <p className="text-sm text-muted">{job.error}</p>
            </Card>
          )}

          {job.rawOutput && (
            <Card>
              <CardTitle className="mb-2">Raw model output</CardTitle>
              <pre className="max-h-96 overflow-auto whitespace-pre-wrap rounded-lg bg-surface-2 p-3 text-xs text-muted">{job.rawOutput}</pre>
            </Card>
          )}
        </div>

        <div className="space-y-6">
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
