import Link from "next/link";
import { Card, CardTitle, StatCard, Badge, EmptyState } from "@/components/ui";
import { Icon } from "@/components/icon";
import { cn, relativeTime } from "@/lib/utils";
import { assetStatusLabel } from "@/lib/asset-status-copy";
import { assetsInClientState } from "@/lib/client-state-domain";
// One spelling of the deep link, shared with the KPI card that writes the same
// one - see the module's own note for the staff/client split and the null case.
import { contentStatusHref } from "@/lib/content-status-links";
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
const UNKNOWN_STATUS_COLOR = "var(--muted)";

/**
 * The counter tiles, on their own so a caller can place them somewhere the rest
 * of the analytics stack does not go.
 *
 * CD-H1: for a client viewer they are the FIRST thing under the Overview header
 * - the counters are what the dashboard opens with, and F99's tab arrangement
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
  // THE FOUR TILES COUNT THIS CLIENT'S CONTENT, so they count only states this
  // client's content can be in per `client-state-domain`'s "performance" surface
  // — which now admits every status a client's calendar does, drafts included
  // (see `isClientCalendarStatus`'s docstring for the reversal). "Deliverables"
  // is `assets.length` over the dashboard's library projection, which has always
  // kept drafts by design ("pending work is reviewable"), so the tile's count
  // and the library's own set now agree again.
  //
  // NARROWED HERE, not at the page that feeds it. `clients/[id]/page.tsx` builds
  // one asset set and hands it to two different components — this counter row,
  // lifted to the top of Overview, and <ClientAnalytics/> for the Performance
  // tab — so a narrowing applied where the set is built fixes whichever of them
  // the next edit does not move. Each component asks the same shared question
  // instead. Staff are handed the set unchanged.
  const counted = assetsInClientState("performance", assets, viewerIsClient);
  const published = counted.filter((a) => a.status === "published").length;
  const scheduled = counted.filter((a) => a.status === "scheduled").length;
  const activeChannels = integrations.filter((i) => integrationIsUsable(i));
  // Read inside the staff branch below rather than here: nothing derived from a
  // job may be in scope on the client path, so that the tile cannot be
  // reintroduced by a later edit that only copies a JSX line.
  const lastRun = viewerIsClient ? null : [...jobs].sort((a, b) => b.createdAt - a.createdAt)[0];

  return (
    /* F124 collapsed these four tiles into one thin SummaryStat row on the
       duplication argument; Albert reviewed it on 2026-07-28 and struck the
       finding (CD-G6) - the row read as messy, and the counters are the first
       view. The baseline tiles are the shipped design; do not collapse them
       again.

       The track count follows the tile count so a client's four tiles fill the
       row instead of leaving a fifth column empty. */
    <div className={cn("grid grid-cols-2 gap-4", viewerIsClient ? "lg:grid-cols-4" : "lg:grid-cols-5")}>
      <StatCard label="Published" value={published} />
      <StatCard label="Scheduled" value={scheduled} />
      <StatCard label="Channels" value={activeChannels.length} />
      <StatCard label="Deliverables" value={counted.length} />
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

  // Content-by-status breakdown, over the states this client's content can
  // actually be in per `client-state-domain`'s "performance" surface. That now
  // agrees with the incoming set for a client too — the library projection keeps
  // drafts, and so does the calendar and this chart, by the same reversed
  // decision (see `isClientCalendarStatus`'s docstring). The Workspace archive is
  // the one surface that still withholds "Draft" from a client. Same helper as
  // the tiles, so the bars and the totals above them cannot disagree about what
  // counts; it also drops a status the union has never heard of, which
  // `assetStatusLabel` would otherwise render as its raw stored value.
  const charted = assetsInClientState("performance", assets, viewerIsClient);
  const byStatus = new Map<string, number>();
  for (const a of charted) byStatus.set(a.status, (byStatus.get(a.status) ?? 0) + 1);
  const statusRows = [...byStatus.entries()].sort((a, b) => b[1] - a[1]);
  const maxCount = Math.max(1, ...statusRows.map(([, n]) => n));

  return (
    <div className="@container space-y-6">
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

      {/* `@container`-keyed, same reason as the Home widgets: `lg:` measured the
          window, not the column the 288px rail leaves behind, so these two
          charts halved themselves at a width where neither fit. */}
      <div className="grid gap-6 @4xl:grid-cols-2">
        {/* Content by status */}
        <Card>
          <div className="mb-4 flex items-center justify-between gap-2">
            <CardTitle className="flex min-w-0 items-center gap-2">
              <span className="flex h-6 w-6 shrink-0 items-center justify-center rounded-md bg-neon/10">
                <Icon name="ChartColumn" className="h-3.5 w-3.5 text-neon" />
              </span>
              <span className="min-w-0 truncate">Content by status</span>
            </CardTitle>
            <span className="shrink-0 font-mono text-xs text-muted-2">{charted.length} total</span>
          </div>
          {statusRows.length === 0 ? (
            <EmptyState
              icon={<Icon name="FolderOpen" className="h-6 w-6" />}
              title="No content yet"
              description="Deliverables produced by your agents will be summarized here."
            />
          ) : (
            <ul className="space-y-1.5">
              {statusRows.map(([status, count]) => {
                const color = STATUS_COLOR[status as Asset["status"]] ?? UNKNOWN_STATUS_COLOR;
                const href = contentStatusHref(status, clientId, viewerIsClient);
                const body = (
                  <>
                    <div className="mb-1.5 flex items-center justify-between gap-2 text-xs">
                      <span className="min-w-0 truncate font-medium text-foreground">
                        {assetStatusLabel(status, viewerIsClient)}
                      </span>
                      <span className="flex shrink-0 items-center gap-1.5">
                        <span className="font-mono text-sm font-semibold text-foreground">
                          {count}
                        </span>
                        {href && (
                          <Icon
                            name="ArrowRight"
                            className="h-3 w-3 text-muted-2 opacity-0 transition-opacity group-hover:opacity-100"
                          />
                        )}
                      </span>
                    </div>
                    <div className="h-2.5 overflow-hidden rounded-sm bg-surface-2">
                      <div
                        className="h-full rounded-sm"
                        style={{ width: `${(count / maxCount) * 100}%`, background: color }}
                      />
                    </div>
                  </>
                );
                // A bar with nowhere to go stays a bar. Only the linked ones get
                // the group-hover arrow and the pointer.
                return (
                  <li key={status}>
                    {href ? (
                      <Link
                        href={href}
                        className="group block rounded-md border border-transparent px-2 py-1.5 transition-colors hover:border-neon/30 hover:bg-surface-2"
                      >
                        {body}
                      </Link>
                    ) : (
                      <div className="px-2 py-1.5">{body}</div>
                    )}
                  </li>
                );
              })}
            </ul>
          )}
        </Card>

        {/* Connected channels - QA F145: a channel whose token died used to be
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
            <Link href={`/clients/${clientId}/settings?tab=settings`} className="text-xs text-muted underline-offset-2 hover:text-foreground hover:underline">
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
                  <div className="min-w-0 flex-1">
                    <p className="truncate text-sm font-medium">{platformLabel(i.platform)}</p>
                    {i.accountName && <p className="truncate text-xs text-muted-2">{i.accountName}</p>}
                  </div>
                  {integrationNeedsReconnect(i) ? (
                    // Same treatment Settings already gives a dead token, plus the
                    // route to fix it - the health truth existed, the dashboard
                    // just refused to show it.
                    <Link href={`/clients/${clientId}/settings?tab=settings`} className="shrink-0">
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
