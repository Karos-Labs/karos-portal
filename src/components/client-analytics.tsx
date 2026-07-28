import Link from "next/link";
import { Card, CardTitle, StatCard, Badge, EmptyState } from "@/components/ui";
import { Icon } from "@/components/icon";
import { relativeTime } from "@/lib/utils";
import { integrationIsUsable } from "@/lib/integration-status";
import type { Asset, ClientIntegration, Job } from "@/lib/types";

/* Judgment scale: in-progress = amber, live/done = green, in-between = slate. */
const STATUS_META: Record<string, { label: string; color: string }> = {
  draft: { label: "Draft", color: "var(--warning)" },
  approved: { label: "Approved", color: "var(--success)" },
  scheduled: { label: "Scheduled", color: "var(--info)" },
  published: { label: "Published", color: "var(--success)" },
  delivered: { label: "Delivered", color: "var(--success)" },
};

export function ClientAnalytics({
  clientId,
  assets,
  jobs,
  integrations,
}: {
  clientId: string;
  assets: Asset[];
  jobs: Job[];
  integrations: ClientIntegration[];
}) {
  const published = assets.filter((a) => a.status === "published").length;
  const scheduled = assets.filter((a) => a.status === "scheduled").length;
  const activeChannels = integrations.filter((i) => integrationIsUsable(i));

  // Content-by-status breakdown
  const byStatus = new Map<string, number>();
  for (const a of assets) byStatus.set(a.status, (byStatus.get(a.status) ?? 0) + 1);
  const statusRows = [...byStatus.entries()].sort((a, b) => b[1] - a[1]);
  const maxCount = Math.max(1, ...statusRows.map(([, n]) => n));

  const lastRun = [...jobs].sort((a, b) => b.createdAt - a.createdAt)[0];

  return (
    <div className="space-y-6">
      {/* Stats */}
      <div className="grid grid-cols-2 gap-4 lg:grid-cols-5">
        <StatCard label="Published" value={published} />
        <StatCard label="Scheduled" value={scheduled} />
        <StatCard label="Channels" value={activeChannels.length} />
        <StatCard label="Deliverables" value={assets.length} />
        {/* QA F99: a whole bordered panel was spent on one sentence about agent
            runs. It's a counter — it belongs in the counter row. QA F123: the
            sentence also read "20 agent runs · last 9h ago", which isn't one. */}
        <StatCard
          label="Agent runs"
          value={jobs.length}
          hint={lastRun ? `Last run ${relativeTime(lastRun.createdAt)}` : "No runs yet"}
        />
      </div>

      <div className="grid gap-6 lg:grid-cols-2">
        {/* Content by status */}
        <Card>
          <CardTitle className="mb-4">Content by status</CardTitle>
          {statusRows.length === 0 ? (
            <EmptyState
              icon={<Icon name="FolderOpen" className="h-6 w-6" />}
              title="No content yet"
              description="Deliverables produced by your agents will be summarized here."
            />
          ) : (
            <ul className="space-y-3">
              {statusRows.map(([status, count]) => {
                const meta = STATUS_META[status] ?? { label: status, color: "#9c9ca3" };
                return (
                  <li key={status}>
                    <div className="mb-1 flex items-center justify-between text-xs">
                      <span className="font-medium text-foreground">{meta.label}</span>
                      <span className="text-muted-2">{count}</span>
                    </div>
                    <div className="h-2 overflow-hidden rounded-sm bg-surface-2">
                      <div
                        className="h-full rounded-sm"
                        style={{ width: `${(count / maxCount) * 100}%`, background: meta.color }}
                      />
                    </div>
                  </li>
                );
              })}
            </ul>
          )}
        </Card>

        {/* Connected channels */}
        <Card>
          <div className="mb-4 flex items-center justify-between">
            <CardTitle>Connected channels</CardTitle>
            <Link href={`/clients/${clientId}/settings`} className="text-xs text-muted underline-offset-2 hover:text-foreground hover:underline">
              Manage
            </Link>
          </div>
          {activeChannels.length === 0 ? (
            <EmptyState
              icon={<Icon name="Plug" className="h-6 w-6" />}
              title="No channels connected"
              description="Connect social channels in Settings so agents can publish and metrics can flow in."
            />
          ) : (
            <ul className="space-y-2">
              {activeChannels.map((i) => (
                <li
                  key={i.platform}
                  className="flex items-center justify-between gap-3 rounded-md border border-border bg-surface-2 px-3 py-2"
                >
                  <div className="min-w-0">
                    <p className="truncate text-sm font-medium capitalize">{i.platform}</p>
                    {i.accountName && <p className="truncate text-xs text-muted-2">{i.accountName}</p>}
                  </div>
                  <Badge tone="neon">
                    <Icon name="CheckCircle2" className="h-3 w-3" />
                    Connected
                  </Badge>
                </li>
              ))}
            </ul>
          )}
        </Card>
      </div>
    </div>
  );
}
