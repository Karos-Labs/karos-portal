import { redirect } from "next/navigation";
import { requireUser, requireVisibleClient } from "@/lib/auth";
import {
  getClientSeoGeo,
  listAssets,
  listJobs,
  listClientIntegrations,
  listClientTasks,
  listClientCompetitors,
  listClientFollowerSnapshots,
  listClientSeats,
  listClientActionStates,
  getClientCredits,
} from "@/lib/data";
import { listClientAgents } from "@/lib/data-client-agents";
import { isBillableClientActor, CREDIT_DEFAULTS } from "@/lib/credits";
import { isAiProcessingLockActive } from "@/lib/constants";
import { integrationIsUsable } from "@/lib/integration-status";
import { PageHeader } from "@/components/ui";
import { AiProcessingBanner } from "@/components/ai-processing-banner";
import { ClientAnalytics } from "@/components/client-analytics";
import { AiInsights } from "@/components/ai-insights";
import { ClientHomeOverview } from "@/components/client-home-overview";
import { buildScoreViews, buildPresence } from "@/components/seo-geo/presenter";
import { RegenerateWorkspaceButton } from "@/components/regenerate-workspace-button";
import { getClientLibraryAssets } from "@/lib/asset-visibility";
import { contentLabelsByAsset } from "@/lib/agent-identity-map";
import {
  resolveFollowerHistory,
  totalFollowers,
  combinedFollowerSeries,
  followerGrowthPct,
} from "@/lib/follower-tracking";
import { ActionListWidget } from "@/components/home-action-list";
import {
  resolveActionList,
  toClientActions,
  shouldStartExpanded,
  type ActionSignals,
} from "@/lib/action-list";
import { computePlatformGaps, gapPlatformNames } from "@/lib/calendar-gaps";
import { CalendarSparseBanner } from "@/components/calendar-sparse-banner";
import { CalendarPreviewWidget } from "@/components/home-calendar-preview";
import { HomeKpisWidget } from "@/components/home-kpis";
import { HomeStandingWidget, hasStanding } from "@/components/home-standing";
import { HomeOpsStrip, type OpsStat } from "@/components/home-ops-strip";
import { relativeTime } from "@/lib/utils";
import type { Asset } from "@/lib/types";

/**
 * How many open tasks the attention widget reads.
 *
 * Named rather than inlined because the widget's counts are `.length` of this
 * array, so the cap is part of what those numbers MEAN — `tasksHitLimit` below
 * turns "50" into "50+" when the window is full, instead of printing a
 * truncation as a total.
 */
const TASK_FEED_LIMIT = 50;

export default async function ClientDetailPage({ params }: { params: Promise<{ id: string }> }) {
  const user = await requireUser();
  const { id } = await params;

  // CLIENT_USER may only view their own account.
  if (user.role === "CLIENT_USER") {
    if (user.clientId !== id) redirect(user.clientId ? `/clients/${user.clientId}` : "/assets");
  } else if (user.role !== "KAROS_ADMIN" && user.role !== "KAROS_EMPLOYEE") {
    redirect("/dashboard");
  }

  const client = await requireVisibleClient(user, id);

  const isClientViewer = user.role === "CLIENT_USER";
  // NOT the same question as isClientViewer, and the difference is money: an
  // admin in "View as Client" reads CLIENT_USER but is never charged. Surfaces
  // that quote a price ask this one; surfaces that pick a vocabulary ask the
  // other.
  const viewerIsBilled = isBillableClientActor(user);

  const [
    assets,
    jobs,
    integrations,
    seoGeo,
    tasks,
    competitors,
    umbrellas,
    followerSnapshots,
    seats,
    actionStates,
    credits,
  ] = await Promise.all([
    listAssets({ clientId: id }),
    listJobs({ clientId: id }),
    listClientIntegrations(id),
    getClientSeoGeo(id),
    // Read for BOTH viewers now. It used to be client-only, which left the
    // staff dashboard's Task Map nudge permanently reporting "0 suggestions"
    // — a banner that cannot count is a banner that lies. Where the rows are
    // ALLOWED to go is still split, and deliberately: `tasks` reaches
    // ClientHomeOverview only on the client branch (see that component's note
    // on `clientId` — its attention rows link to an owner-scoped board a staff
    // viewer would land on the wrong tab of). Staff use the count only.
    listClientTasks({ clientId: id, status: ["pending", "review_pending"], limit: TASK_FEED_LIMIT }),
    listClientCompetitors(id),
    // The last five feed client-only Home widgets (Recent Agent Activity's
    // §7.3 join, the KPIs follower chart, the action list's seat count,
    // per-platform connection and billing signals, and stored
    // dismiss/not-relevant/done rows) — read unconditionally rather than
    // gated on isClientViewer since all are cheap, indexed, single-field (or
    // single-doc) reads and gating them would just move the branch into
    // every widget that needs them instead of removing a real cost.
    listClientAgents({ clientId: id }),
    listClientFollowerSnapshots(id),
    listClientSeats(id),
    listClientActionStates(id),
    getClientCredits(id),
  ]);

  // `competitors` is read for ONE thing on this page now — the action list's
  // `hasManualCompetitor` signal below. The tracked-competitor projection that
  // used to be built here fed <SeoGeoPanel/>'s comparison rows, and that panel
  // left this page with the rest of the deep report (see the note above the
  // summary widgets); Account Center's Reporting tab builds the same projection
  // from the same selector, so nothing about what the report compares changed.
  const firstName = user.name?.trim().split(/\s+/)[0];

  // Client viewers must never receive un-redacted future content across the RSC
  // boundary (requirement H / amendment A6). The home overview gets whitelist-
  // redacted placeholders for locked (future-dated) posts; analytics is fed only
  // currently-unlocked assets so upcoming volume isn't revealed in its counts.
  // Staff keep full visibility (invariant A10.6).
  // Locked placeholders are FILTERED here, not passed redacted: the overview's
  // "Recent activity" is delivered work, and a week of slots generated in one
  // minute would render as five "Upcoming post · 3 hours ago" rows - the batch
  // tell the churn rules exist to prevent (delta-lens bounce, 2026-07-28).
  const overviewAssets = isClientViewer
    ? getClientLibraryAssets(assets, {
        forClient: true,
        viewer: { role: user.role, seatId: user.seatId, isGroupAdmin: user.isGroupAdmin },
      }).filter((a) => !a.locked)
    : assets;
  const analyticsAssets = overviewAssets;

  // ── Home widgets (portal revamp, Surface 02) — client viewer only ──
  // eslint-disable-next-line react-hooks/purity -- server component, no re-render concern
  const now = Date.now();

  // Calendar Preview WANTS the locked/future rows overviewAssets just dropped —
  // that is the whole point of a preview — but never their real title:
  // redactLockedAsset already replaces it with a template name or "Upcoming
  // post", and the widget itself reads only `type` and `scheduledPlatform`
  // (absent on a locked row), never `title`.
  const isUpcoming = (a: Asset) => a.status === "scheduled" && (a.scheduledAt ?? 0) > now;
  const upcomingAssets = isClientViewer
    ? getClientLibraryAssets(assets, {
        forClient: true,
        viewer: { role: user.role, seatId: user.seatId, isGroupAdmin: user.isGroupAdmin },
      }).filter(isUpcoming)
    : [];
  // Staff read the unredacted set — there is no future-content rule to keep for
  // an operator, and the preview shows type + platform either way.
  const upcomingStaffAssets = isClientViewer ? [] : assets.filter(isUpcoming);

  // Recent Agent Activity's §7.3 join — same helper the Workspace archive and
  // Account Center's Archive tab use, so this widget cannot name an agent
  // something those two disagree with.
  const agentLabelByAssetId = contentLabelsByAsset(overviewAssets, jobs, umbrellas);

  // KPIs, audience cell: REAL STORED SNAPSHOTS ONLY (D6). The mock fallback is
  // gone — `resolveFollowerHistory` returns an empty series when nothing was
  // captured, and the widget hides the cell rather than filling it in. Nothing
  // writes `clientFollowerSnapshots` yet, so today this is empty for every
  // client and the cell simply does not render; the moment an ingestion cron
  // lands it appears on its own.
  const followerHistoriesByPlatform: Record<string, ReturnType<typeof resolveFollowerHistory>> = {};
  for (const integration of integrations) {
    followerHistoriesByPlatform[integration.platform] = resolveFollowerHistory(
      followerSnapshots,
      integration.platform,
    );
  }
  const followerTotal = totalFollowers(followerHistoriesByPlatform);
  const followerSeries = combinedFollowerSeries(followerHistoriesByPlatform);
  const followerGrowth = followerGrowthPct(followerSeries);
  const channelSummaries = integrations.map((i) => ({
    platform: i.platform,
    usable: integrationIsUsable(i),
  }));

  // The KPI card's score meter and the full report share ONE buildScoreViews
  // call so the widget and the page can never quote different numbers for the
  // same snapshot. Same rule for buildPresence and "Where you stand".
  const scoreViews = seoGeo ? buildScoreViews(seoGeo) : [];
  // D6 kept exactly one of the three: "the overall Google/AI visibility
  // rank" is this view's own established label ("AI visibility today"), not
  // a new metric — search score and AI readiness stay on the full report only.
  const visibilityScore = scoreViews.find((v) => v.key === "visibility") ?? null;
  const presence = seoGeo ? buildPresence(seoGeo) : null;
  const reportHref = `/clients/${id}/settings?tab=reporting`;

  // Next Actions (Surface 08) — the real 15-item engine. Signals are read
  // fresh from data already in hand this render; `actionStates` supplies the
  // client-chosen (dismissed/not_relevant) and event-tracked (12/13/14) rows
  // that no live signal can answer. See lib/action-list.ts for the full
  // precedence rule and the documented proxies (02/05/07/09).
  const actionSignals: ActionSignals = {
    profileComplete: Boolean(client.description?.trim() && client.category?.trim()),
    hasGrantedAgent: (client.customAgentIds?.length ?? 0) > 0,
    grantedAgentCount: client.customAgentIds?.length ?? 0,
    hasRun: jobs.length > 0,
    runCount: jobs.length,
    hasOutput: assets.length > 0,
    hasStarredAgent: (client.starredAgentIds?.length ?? 0) > 0,
    hasManualCompetitor: competitors.some((c) => c.source === "manual"),
    hasUsableChannel: integrations.some((i) => integrationIsUsable(i)),
    seatCount: seats.length,
    connectedPlatformIds: integrations.filter((i) => integrationIsUsable(i)).map((i) => i.platform),
    // Every client gets a default credits doc lazily (getClientCredits), so
    // "the doc exists" would mark this done for a client nobody has touched
    // anything for — only a real deviation from CREDIT_DEFAULTS counts.
    hasBillingConfigured:
      credits.weeklyLimit !== CREDIT_DEFAULTS.weeklyLimit ||
      credits.monthlyLimit !== CREDIT_DEFAULTS.monthlyLimit ||
      credits.balance !== CREDIT_DEFAULTS.startingBalance,
  };
  const actionStatesById = new Map(
    actionStates.map((s) => [s.actionId, { status: s.status, updatedAt: s.updatedAt }]),
  );
  const resolvedActions = resolveActionList(actionSignals, actionStatesById, now);
  const actionListStartExpanded = shouldStartExpanded(resolvedActions);

  // Smart Task Map Fallback (final workflow enhancement) — the same gap math
  // the swarm itself reasons from (lib/calendar-gaps.ts, shared with
  // lib/agent-swarm.ts's buildSwarmContext), and the same `pending` rows
  // calendar-body.tsx surfaces for review — Home only nudges + can trigger
  // generation, the review cards live on the Calendar page (`reviewHref`).
  const usablePlatforms = integrations.filter((i) => integrationIsUsable(i)).map((i) => i.platform);
  const gapPlatforms = gapPlatformNames(computePlatformGaps(assets, usablePlatforms, now));
  const pendingSuggestedTaskCount = tasks.filter(
    (t) => t.status === "pending" && t.owner === "karos_managed" && t.source === "copilot",
  ).length;

  // Newest job, for the ops strip's "Last run" caption. Staff-only reader — a
  // client's dashboard may not carry the batch timestamp (the churn rule; see
  // ClientAnalyticsStats' note), and HomeOpsStrip is never mounted for them.
  const lastJob = [...jobs].sort((a, b) => b.createdAt - a.createdAt)[0];

  const analytics = (
    <ClientAnalytics
      clientId={client.id}
      assets={analyticsAssets}
      jobs={jobs}
      integrations={integrations}
      // The chart names statuses, and this one mount serves both readers: a
      // client reads "Posted", staff read "Awaiting review" (asset-status-copy's
      // two registers). Separate from hideStats below on purpose — that one is
      // about layout, this one is about vocabulary.
      viewerIsClient={isClientViewer}
      // The counter row is lifted out of this component on BOTH branches now:
      // a client's four tiles were lifted to the top of Overview by CD-H1 and
      // then retired by the portal revamp, and staff's five became the one-line
      // HomeOpsStrip below. Neither branch may print them twice.
      hideStats
    />
  );

  // ── Home's summary of the Search & AI visibility report ──
  //
  // THE FULL REPORT NO LONGER RENDERS ON THIS PAGE, FOR ANYONE (2026-08).
  //
  // Surface 09 moved it to Account Center's Reporting tab and took it off the
  // CLIENT branch — but the staff branch went on mounting <SeoGeoPanel/> whole,
  // with `hideScores={false} hidePlan={false}`, on the reasoning that staff
  // "reach it ONLY here". That stopped being true the moment the Reporting tab
  // shipped for staff too (settings/page.tsx builds it for every viewer), so
  // the consolidation had simply not been applied to this half of the file:
  // engine-by-engine breakdowns, the citation-source table and the question log
  // rendered on the dashboard AND one click away, and the dashboard is where a
  // person landed first.
  //
  // So Home carries two summaries and a link — score meters inside the KPI card
  // and the two share numbers in "Where you stand" — and the deep report has
  // exactly one address. Both summaries are projections of the same
  // buildScoreViews / buildPresence calls that page renders from, so this is
  // not a second copy of the report; it is the report's headline.
  const standing = presence && hasStanding(presence) ? (
    <HomeStandingWidget
      presence={presence}
      href={reportHref}
      competitorsHref={`/clients/${id}/settings?tab=competitors`}
    />
  ) : null;

  const kpis = (
    <HomeKpisWidget
      audienceTotal={followerTotal}
      audienceGrowthPct={followerGrowth}
      audienceSeries={followerSeries}
      channels={channelSummaries}
      visibilityScore={visibilityScore}
      reportHref={reportHref}
      channelsHref={`/clients/${id}/settings?tab=settings`}
    />
  );

  /**
   * The retired five tiles, as one line (staff only — see HomeOpsStrip).
   *
   * Four of the five survive; "Channels" does not. It was a bare integer whose
   * only interesting question — is any of them broken? — the KPI card answers
   * properly now, and repeating the total beside it would be the duplication
   * this pass exists to remove. "Awaiting review" is new and is the one number
   * on the old row that was genuinely missing: it is the only counter here that
   * asks somebody to DO something, which is why it is the only one that tints.
   */
  const opsStats: OpsStat[] = [
    {
      label: "Awaiting review",
      value: assets.filter((a) => a.status === "draft").length,
      href: `/clients/${id}/assets`,
      warnWhenNonZero: true,
    },
    {
      label: "Scheduled",
      value: assets.filter(isUpcoming).length,
      // Staff-only strip (see HomeOpsStrip below) — scoped to this client's
      // own calendar, not the flat /calendar route, which resolves to the
      // cross-client overview for a staff viewer (calendar-body.tsx's
      // `isClient` branch is the only one that scopes the flat route, and it
      // keys off `user.clientId`, which a staff viewer here doesn't have).
      href: `/clients/${id}/calendar`,
    },
    {
      label: "Published",
      value: assets.filter((a) => a.status === "published").length,
      href: `/clients/${id}/settings?tab=archive`,
    },
    { label: "Deliverables", value: assets.length, href: `/clients/${id}/assets` },
    {
      label: "Agent runs",
      value: jobs.length,
      href: "/jobs",
      ...(lastJob ? { hint: `Last run ${relativeTime(lastJob.createdAt)}` } : {}),
    },
  ];

  const calendarBanner = (
    <CalendarSparseBanner
      clientId={client.id}
      gapPlatforms={gapPlatforms}
      pendingSuggestionCount={pendingSuggestedTaskCount}
      isAiProcessing={isAiProcessingLockActive(client)}
      viewerIsBilled={viewerIsBilled}
      // This element is reused for both branches below (real CLIENT_USER and
      // staff). The flat /calendar route only resolves to THIS client for a
      // real CLIENT_USER (calendar-body.tsx's `isClient` branch scopes it via
      // `user.clientId`); a staff viewer — including "View as client" — lands
      // on the cross-client overview there instead, so the review link must
      // carry the scoped route explicitly for them.
      reviewHref={isClientViewer ? "/calendar" : `/clients/${id}/calendar`}
    />
  );

  /**
   * THE STAFF DASHBOARD GOT THE SAME TREATMENT AS THE CLIENT ONE (2026-08).
   *
   * It was "the plain single stack: the operator's read-everything view", which
   * in practice meant: five counter tiles, two chart cards, the entire SEO/GEO
   * report, then AI Insights. Three screens before anything a person could act
   * on, and the product owner's verdict was that most of it did not inform —
   * the counters are inventory, the status bars restate the counters, and the
   * report is a page that already exists elsewhere.
   *
   * So this branch is now the client's own information architecture with the
   * operator's extras added, rather than a different page:
   *
   *   1. alerts        — processing banner, then the Task Map / calendar-gap nudge
   *   2. what's next   — upcoming slots + recent agent activity, side by side
   *   3. how we're doing — audience, channel health, the three scores (one card)
   *   4. where we stand — category presence + share of conversation
   *   5. the numbers   — one thin ops strip, the retired five tiles' content
   *   6. performance   — the status/channel charts, below the fold where they belong
   *   7. AI Insights   — the written briefing, last
   *
   * The two things staff keep that a client does not: the ops strip (§5, see
   * HomeOpsStrip for why a client may not have it) and Regenerate in the header.
   */
  if (!isClientViewer) {
    return (
      <>
        <PageHeader
          title="Dashboard"
          description={`Workspace overview for ${client.name}.`}
          // CD-G5: regeneration rewrites the documents AND the SEO/GEO intel, so
          // it needs an entry point at client level and not only in the rail's
          // documents header. Admin-only, same gate as that one - an employee or
          // a client viewer never sees it (client viewers never reach this
          // branch at all).
          action={
            user.role === "KAROS_ADMIN" ? (
              <RegenerateWorkspaceButton
                clientId={client.id}
                isAiProcessing={isAiProcessingLockActive(client)}
              />
            ) : undefined
          }
        />
        <div className="space-y-8">
          {/* CLIENT_USER already sees this via the (app) shell's own wrapper - only
              render here for staff, who use the plain Sidebar shell with no such wrapper. */}
          <AiProcessingBanner client={client} isAdmin={user.role === "KAROS_ADMIN"} />

          {/* `@container` (2026-08). Every grid inside these widgets sizes
              itself against THIS element now instead of the viewport, because
              the content column is the window minus a 288px rail — so a
              viewport-keyed `lg:` fired on a ~700px column and split it into
              two ~330px tracks, which is the unreadable dashboard in the
              product owner's capture. One declaration here makes every child's
              container query resolve against the width they are actually
              given, at any window size, zoom level or rail width. */}
          <section className="@container space-y-6">
            {calendarBanner}
            <div className="grid gap-6 @4xl:grid-cols-2">
              <CalendarPreviewWidget
                upcoming={upcomingStaffAssets}
                calendarHref={`/clients/${id}/calendar`}
              />
              {/* `tasks` is deliberately empty here — see the fetch above and
                  this component's own note on `clientId`: its attention rows
                  link to an owner-scoped board that a staff viewer lands on the
                  wrong tab of. Staff get the Recent activity half, which is the
                  half that joins agent identity (§7.3). */}
              <ClientHomeOverview
                clientId={client.id}
                tasks={[]}
                assets={overviewAssets}
                viewerIsClient={false}
                agentLabelByAssetId={agentLabelByAssetId}
                recentActivityLimit={4}
              />
            </div>
            {kpis}
            {standing}
            <HomeOpsStrip stats={opsStats} />
          </section>

          <section className="space-y-3">
            <p className="font-mono text-[10px] uppercase tracking-[0.08em] text-muted">
              Performance
            </p>
            {analytics}
          </section>
          <section className="space-y-3">
            <p className="font-mono text-[10px] uppercase tracking-[0.08em] text-muted">
              AI Insights
            </p>
            {/* Staff branch — agency overhead, never billed, so no price is
                quoted here even though the refresh does spend Karos money. */}
            <AiInsights clientId={client.id} viewerIsBilled={viewerIsBilled} />
          </section>
        </div>
      </>
    );
  }

  // QA F99 - client dashboard, in value order: what needs the client now
  // (attention + recent), then how they're doing, then where they stand.
  // The full Search & AI visibility report moved off this page entirely
  // (Surface 09 reporting consolidation) — it lives on Account Center's
  // Reporting tab now, next to Competitors, so it has one home instead of
  // rendering here AND there. The oversized "Welcome back" banner - the
  // shallowest element on the page - becomes one line.
  //
  // AI INSIGHTS AND PERFORMANCE ARE GONE FROM THIS BRANCH (2026-08 UI/UX
  // pass). Both sat below everything actionable and restated numbers the
  // widgets above already show: AI Insights is a generated paragraph of the
  // same scores and channel state, and the status/channel charts are
  // inventory, not a next step. AI Insights stays on the STAFF branch below
  // (operators do read it, same viewerIsBilled gate as before); the two
  // <ClientAnalytics/> charts now mount in Account Center → Reporting instead
  // (settings/page.tsx's analyticsSection) — moved, not deleted. After this
  // cut the client Home is exactly: alerts → Next Actions + Calendar Preview
  // → Your numbers → Where you stand → Recent activity. Nothing else belongs
  // here without a fresh product decision.
  return (
    <>
      <p className="mb-6 text-sm text-muted">
        {firstName ? `Welcome back, ${firstName}` : "Welcome back"}. Here&apos;s what&apos;s
        happening across the {client.name} workspace.
      </p>
      <div className="space-y-8">
        <section className="space-y-3">
          <p className="font-mono text-[10px] uppercase tracking-[0.08em] text-muted">Overview</p>
          {/* Portal revamp, Surface 02: the old Published/Scheduled/Channels/
              Deliverables tile row is gone — "Approved, Posted and Draft are
              deleted" (locked decision). Scheduled becomes the Calendar
              Preview widget below; Channels moves into the KPIs widget as
              connection badges; the rest is superseded by real numbers (D6)
              rather than activity counts. */}
          {/* `@container` (2026-08). Every grid inside these widgets sizes
              itself against THIS element now instead of the viewport, because
              the content column is the window minus a 288px rail — so a
              viewport-keyed `lg:` fired on a ~700px column and split it into
              two ~330px tracks, which is the unreadable dashboard in the
              product owner's capture. One declaration here makes every child's
              container query resolve against the width they are actually
              given, at any window size, zoom level or rail width. */}
          <div className="@container space-y-6">
            {calendarBanner}
            <div className="grid gap-6 @4xl:grid-cols-2">
              <ActionListWidget
                clientId={client.id}
                resolved={toClientActions(resolvedActions, client.id)}
                startExpanded={actionListStartExpanded}
              />
              <CalendarPreviewWidget upcoming={upcomingAssets} />
            </div>
            {kpis}
            {/* "Where you stand" replaced the old Reporting chip card here. The
                chips restated the three scores the KPI card now meters two
                inches above; these are the two numbers that were NOT anywhere
                on Home — how often the engines name you in an open category
                question, and how much of that conversation is yours. */}
            {standing}
            <ClientHomeOverview
              clientId={client.id}
              tasks={tasks}
              assets={overviewAssets}
              viewerIsClient={isClientViewer}
              agentLabelByAssetId={agentLabelByAssetId}
              recentActivityLimit={3}
              tasksHitLimit={tasks.length >= TASK_FEED_LIMIT}
            />
          </div>
        </section>
      </div>
    </>
  );
}
