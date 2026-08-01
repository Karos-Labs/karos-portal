import Link from "next/link";
import { Card, CardTitle, StatCard, Badge, EmptyState } from "@/components/ui";
import { Icon } from "@/components/icon";
import { cn, relativeTime } from "@/lib/utils";
import { assetStatusLabel } from "@/lib/asset-status-copy";
import { integrationIsUsable, integrationNeedsReconnect } from "@/lib/integration-status";
import { platformLabel } from "@/lib/integrations/platforms";
import type { Asset, ClientIntegration, Job } from "@/lib/types";

/* Judgment scale: in-progress = amber, live/done = green, in-between = slate.
 *
 * The LABELS that used to sit beside these colours were a third asset-status
 * label map, and this component is read by clients as well as staff — so the
 * chart printed "Published" to the same client whose archive, one tab away, said
 * "Posted". The words now come from the two registers in
 * lib/asset-status-copy.ts, chosen by `viewerIsClient`. Colour stays here
 * because presentation is this component's business, and a colour has no reader.
 *
 * WP-7 swept this file for a per-surface AGENT label map to delete (§7.3) and
 * found none: the analytics stack counts and charts assets, jobs and channels
 * and never names the agent behind one. Add an agent-named row here later — a
 * per-agent breakdown, a "top producing agent" tile — and it takes
 * resolveContentIdentity like every other surface. */
const STATUS_COLOR: Record<Asset["status"], string> = {
  draft: "var(--warning)",
  approved: "var(--success)",
  scheduled: "var(--info)",
  published: "var(--success)",
  delivered: "var(--success)",
};

/** A status Firestore holds and the union doesn't still gets a bar, in slate. */
const UNKNOWN_STATUS_COLOR = "#9c9ca3";

/**
 * The counter tiles, on their own so a caller can place them somewhere the rest
 * of the analytics stack does not go.
 *
 * CD-H1: for a client viewer they are the FIRST thing under the Overview header
 * — the counters are what the dashboard opens with, and F99's tab arrangement
 * had pushed them a screen down behind AI Insights into the Performance tab.
 * The client page renders this directly and passes `hideStats` to
 * <ClientAnalytics/> so the row is never printed twice; staff keep the plain
 * single stack with the tiles in place.
 *
 * FOUR TILES FOR A CLIENT, FIVE FOR STAFF — directive A3, the churn rule, and
 * the fifth tile was the tell. "Agent runs 47 · Last run 6 hours ago" reports
 * neither of the two things a client's dashboard is allowed to report about our
 * machinery:
 *
 *  • the COUNT is every job document ever written for them — scheduled fires,
 *    manual runs, launch/setup runs, Control Room test runs, failures — so it is
 *    a measure of our activity, not of their content, and the number they can see
 *    beside it (Deliverables) does not match it.
 *  • "Last run 6 hours ago" is the batch timestamp. The morning after a weekly
 *    batch fires, a client reading it beside a calendar showing seven upcoming
 *    days can conclude the whole week already exists — which is the one fact the
 *    slot model is built to keep indistinguishable.
 *
 * THE SAME RULE WAS ALREADY WRITTEN ELSEWHERE, and this paragraph used to claim
 * more than was true: it said "the calendar and the Recent activity list were
 * both scrubbed of the generation instant (they stamp a client's rows with
 * `clientDeliveryStamp` instead), and this tile is the copy that was missed."
 * The Recent activity half is right. THE CALENDAR HALF WAS NOT — the calendar
 * reads `clientDeliveryStamp` nowhere, and it carried two live instants of its
 * own: the scheduled-run card's "Last fire · Ran 6 hours ago" and PastRunCard's
 * "Ran 6 hours ago". Both are gated for clients now, in run-calendar.tsx.
 *
 * Which is the point worth keeping: "this is the last copy" is a claim about the
 * whole repo, and the tile it excused was one of four. The four tiles a client
 * keeps all count THEIR content.
 *
 * `viewerIsClient` is REQUIRED with no default, the same device the detail modal
 * uses: a defaulted flag would let the next mount pick silently, and the failure
 * mode here is not a wrong word but a directive breach. A test sweeps src/ for
 * every mount and requires the prop.
 */
export function ClientAnalyticsStats({
  assets,
  jobs,
  integrations,
  viewerIsClient,
}: {
  assets: Asset[];
  jobs: Job[];
  integrations: ClientIntegration[];
  /** Whose counter row this is — see the note above (A3). */
  viewerIsClient: boolean;
}) {
  const published = assets.filter((a) => a.status === "published").length;
  const scheduled = assets.filter((a) => a.status === "scheduled").length;
  const activeChannels = integrations.filter((i) => integrationIsUsable(i));
  // Read inside the staff branch below rather than here: nothing derived from a
  // job may be in scope on the client path, so that the tile cannot be
  // reintroduced by a later edit that only copies a JSX line.
  const lastRun = viewerIsClient ? null : [...jobs].sort((a, b) => b.createdAt - a.createdAt)[0];

  return (
    /* F124 collapsed these four tiles into one thin SummaryStat row on the
       duplication argument; Albert reviewed it on 2026-07-28 and struck the
       finding (CD-G6) — the row read as messy, and the counters are the first
       view. The baseline tiles are the shipped design; do not collapse them
       again.

       The track count follows the tile count so a client's four tiles fill the
       row instead of leaving a fifth column empty. */
    <div className={cn("grid grid-cols-2 gap-4", viewerIsClient ? "lg:grid-cols-4" : "lg:grid-cols-5")}>
      <StatCard label="Published" value={published} />
      <StatCard label="Scheduled" value={scheduled} />
      <StatCard label="Channels" value={activeChannels.length} />
      <StatCard label="Deliverables" value={assets.length} />
      {/* QA F99: a whole bordered panel was spent on one sentence about agent
          runs. It's a counter — it belongs in the counter row. QA F123: the
          sentence also read "20 agent runs · last 9h ago", which isn't one.
          Staff only since A3 — see the component's note. */}
      {!viewerIsClient && (
        <StatCard
          label="Agent runs"
          value={jobs.length}
          hint={lastRun ? `Last run ${relativeTime(lastRun.createdAt)}` : "No runs yet"}
        />
      )}
    </div>
  );
}

export function ClientAnalytics({
  clientId,
  assets,
  jobs,
  integrations,
  viewerIsClient,
  hideStats = false,
}: {
  clientId: string;
  assets: Asset[];
  jobs: Job[];
  integrations: ClientIntegration[];
  /**
   * Which status register the chart reads. REQUIRED, with no default: this
   * component serves both readers from one mount, so a default would quietly
   * hand one of them the other's vocabulary — and deliberately NOT derived from
   * `hideStats`, which answers a different question (has the caller lifted the
   * counter row?) and would tie the words to a layout decision.
   */
  viewerIsClient: boolean;
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
        <ClientAnalyticsStats
          assets={assets}
          jobs={jobs}
          integrations={integrations}
          // The same viewer this component already takes for the chart's words.
          // In practice a client never reaches this branch (their page lifts the
          // row and passes hideStats), but threading the real flag is what makes
          // that a fact about the caller rather than something this line assumes.
          viewerIsClient={viewerIsClient}
        />
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
                const color = STATUS_COLOR[status as Asset["status"]] ?? UNKNOWN_STATUS_COLOR;
                return (
                  <li key={status}>
                    <div className="mb-1 flex items-center justify-between text-xs">
                      <span className="font-medium text-foreground">
                        {assetStatusLabel(status, viewerIsClient)}
                      </span>
                      <span className="text-muted-2">{count}</span>
                    </div>
                    <div className="h-2 overflow-hidden rounded-sm bg-surface-2">
                      <div
                        className="h-full rounded-sm"
                        style={{ width: `${(count / maxCount) * 100}%`, background: color }}
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
            <Link href={`/clients/${clientId}/settings?tab=channels`} className="text-xs text-muted underline-offset-2 hover:text-foreground hover:underline">
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
                    <Link href={`/clients/${clientId}/settings?tab=channels`} className="shrink-0">
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
