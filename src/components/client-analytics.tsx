import Link from "next/link";
import { Card, CardTitle, StatCard, Badge, EmptyState } from "@/components/ui";
import { Icon } from "@/components/icon";
import { relativeTime } from "@/lib/utils";
import { integrationIsUsable, integrationNeedsReconnect } from "@/lib/integration-status";
import { platformLabel } from "@/lib/integrations/platforms";
import type { Asset, ClientIntegration, Job } from "@/lib/types";

/* Judgment scale: in-progress = amber, live/done = green, in-between = slate.
 *
 * WP-7 swept this file for a per-surface AGENT label map to delete (§7.3) and
 * found none: the analytics stack counts and charts assets, jobs and channels
 * and never names the agent behind one. This map is asset-STATUS vocabulary,
 * the same class as archive-view's STATUS_LABEL, and identity resolution has
 * nothing to say about it. Add an agent-named row here later — a per-agent
 * breakdown, a "top producing agent" tile — and it takes resolveContentIdentity
 * like every other surface. */
const STATUS_META: Record<string, { label: string; color: string }> = {
  draft: { label: "Draft", color: "var(--warning)" },
  approved: { label: "Approved", color: "var(--success)" },
  scheduled: { label: "Scheduled", color: "var(--info)" },
  published: { label: "Published", color: "var(--success)" },
  delivered: { label: "Delivered", color: "var(--success)" },
};

/**
 * The five counter tiles, on their own so a caller can place them somewhere the
 * rest of the analytics stack does not go.
 *
 * CD-H1: for a client viewer they are the FIRST thing under the Overview header
 * — the counters are what the dashboard opens with, and F99's tab arrangement
 * had pushed them a screen down behind AI Insights into the Performance tab.
 * The client page renders this directly and passes `hideStats` to
 * <ClientAnalytics/> so the row is never printed twice; staff keep the plain
 * single stack with the tiles in place.
 */
export function ClientAnalyticsStats({
  assets,
  jobs,
  integrations,
}: {
  assets: Asset[];
  jobs: Job[];
  integrations: ClientIntegration[];
}) {
  const published = assets.filter((a) => a.status === "published").length;
  const scheduled = assets.filter((a) => a.status === "scheduled").length;
  const activeChannels = integrations.filter((i) => integrationIsUsable(i));
  const lastRun = [...jobs].sort((a, b) => b.createdAt - a.createdAt)[0];

  return (
    /* F124 collapsed these four tiles into one thin SummaryStat row on the
       duplication argument; Albert reviewed it on 2026-07-28 and struck the
       finding (CD-G6) — the row read as messy, and the counters are the first
       view. The baseline tiles are the shipped design; do not collapse them
       again. */
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
  );
}

export function ClientAnalytics({
  clientId,
  assets,
  jobs,
  integrations,
  hideStats = false,
}: {
  clientId: string;
  assets: Asset[];
  jobs: Job[];
  integrations: ClientIntegration[];
  /** The caller renders <ClientAnalyticsStats/> itself, higher up the page (CD-H1). */
  hideStats?: boolean;
}) {
  const activeChannels = integrations.filter((i) => integrationIsUsable(i));
  const staleChannels = integrations.filter((i) => integrationNeedsReconnect(i));

  // Content-by-status breakdown
  const byStatus = new Map<string, number>();
  for (const a of assets) byStatus.set(a.status, (byStatus.get(a.status) ?? 0) + 1);
  const statusRows = [...byStatus.entries()].sort((a, b) => b[1] - a[1]);
  const maxCount = Math.max(1, ...statusRows.map(([, n]) => n));

  return (
    <div className="space-y-6">
      {!hideStats && (
        <ClientAnalyticsStats assets={assets} jobs={jobs} integrations={integrations} />
      )}

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

        {/* Connected channels — QA F145: a channel whose token died used to be
            filtered out of this list entirely. It didn't say "broken, click to
            fix"; it just disappeared, and the channel count dropped by one with
            no explanation, so a dead LinkedIn read as "never set up". The card's
            whole job is answering "is LinkedIn actually working?". */}
        <Card>
          <div className="mb-4 flex items-center justify-between">
            <div>
              <CardTitle>Connected channels</CardTitle>
              {staleChannels.length > 0 && (
                <p className="mt-1 text-xs text-warning">
                  {activeChannels.length} working · {staleChannels.length} need
                  {staleChannels.length === 1 ? "s" : ""} attention
                </p>
              )}
            </div>
            <Link href={`/clients/${clientId}/settings`} className="text-xs text-muted underline-offset-2 hover:text-foreground hover:underline">
              Manage
            </Link>
          </div>
          {integrations.length === 0 ? (
            <EmptyState
              icon={<Icon name="Plug" className="h-6 w-6" />}
              title="No channels connected"
              description="Connect social channels in Settings so agents can publish and metrics can flow in."
            />
          ) : (
            <ul className="space-y-2">
              {integrations.map((i) => (
                <li
                  key={i.platform}
                  className="flex items-center justify-between gap-3 rounded-md border border-border bg-surface-2 px-3 py-2"
                >
                  <div className="min-w-0">
                    <p className="truncate text-sm font-medium">{platformLabel(i.platform)}</p>
                    {i.accountName && <p className="truncate text-xs text-muted-2">{i.accountName}</p>}
                  </div>
                  {integrationNeedsReconnect(i) ? (
                    // Same treatment Settings already gives a dead token, plus the
                    // route to fix it — the health truth existed, the dashboard
                    // just refused to show it.
                    <Link href={`/clients/${clientId}/settings`} className="shrink-0">
                      <Badge tone="warning" className="hover:border-warning/60">
                        <Icon name="TriangleAlert" className="h-3 w-3" />
                        Reconnect needed →
                      </Badge>
                    </Link>
                  ) : (
                    <Badge tone="neon">
                      {/* CircleCheck, not CheckCircle2: the latter isn't a name in
                          lucide 1.x, so this badge silently rendered the sparkle
                          fallback (F63's class of defect, called out in F145). */}
                      <Icon name="CircleCheck" className="h-3 w-3" />
                      Connected
                    </Badge>
                  )}
                </li>
              ))}
            </ul>
          )}
        </Card>
      </div>
    </div>
  );
}
