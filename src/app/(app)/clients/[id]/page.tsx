import { redirect } from "next/navigation";
import { requireUser, requireVisibleClient } from "@/lib/auth";
import {
  getClientSeoGeo,
  listAssets,
  listJobs,
  listClientIntegrations,
  listClientTasks,
  listClientCompetitors,
} from "@/lib/data";
import { computeTrackedCompetitors } from "@/lib/competitor-priority";
import { isAiProcessingLockActive } from "@/lib/constants";
import { PageHeader } from "@/components/ui";
import { AiProcessingBanner } from "@/components/ai-processing-banner";
import { ClientAnalytics, ClientAnalyticsStats } from "@/components/client-analytics";
import { AiInsights } from "@/components/ai-insights";
import { ClientHomeOverview } from "@/components/client-home-overview";
import { SeoGeoPanel, SeoGeoScores, SeoGeoPlan } from "@/components/seo-geo-panel";
import { ClientDashboardTabs } from "@/components/client-dashboard-tabs";
import { RegenerateWorkspaceButton } from "@/components/regenerate-workspace-button";
import { getClientLibraryAssets } from "@/lib/asset-visibility";
import type { ClientTask } from "@/lib/types";

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

  const [assets, jobs, integrations, seoGeo, tasks, competitors] = await Promise.all([
    listAssets({ clientId: id }),
    listJobs({ clientId: id }),
    listClientIntegrations(id),
    getClientSeoGeo(id),
    isClientViewer
      ? listClientTasks({ clientId: id, status: ["pending", "review_pending"], limit: 50 })
      : Promise.resolve([] as ClientTask[]),
    listClientCompetitors(id),
  ]);

  // The currently-tracked competitors (same selector as the sidebar) drive the panel's
  // comparison rows, so the SEO/GEO view and the Competitor Track always show the SAME
  // five competitors side by side; urls feed the brand favicons (QA Fix 1).
  const trackedCompetitorRefs = computeTrackedCompetitors(competitors).map((c) => ({
    name: c.company,
    ...(c.url ? { url: c.url } : {}),
  }));

  const firstName = user.name?.trim().split(/\s+/)[0];

  // Client viewers must never receive un-redacted future content across the RSC
  // boundary (requirement H / amendment A6). The home overview gets whitelist-
  // redacted placeholders for locked (future-dated) posts; analytics is fed only
  // currently-unlocked assets so upcoming volume isn't revealed in its counts.
  // Staff keep full visibility (invariant A10.6).
  // Locked placeholders are FILTERED here, not passed redacted: the overview's
  // "Recent activity" is delivered work, and a week of slots generated in one
  // minute would render as five "Upcoming post · 3 hours ago" rows — the batch
  // tell the churn rules exist to prevent (delta-lens bounce, 2026-07-28).
  const overviewAssets = isClientViewer
    ? getClientLibraryAssets(assets, { forClient: true }).filter((a) => !a.locked)
    : assets;
  const analyticsAssets = overviewAssets;

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
      // CD-H1: for a client the counter row is lifted to the top of Overview
      // (below), so the Performance tab must not repeat it — the same
      // hide-what-was-lifted contract the visibility panel already uses.
      hideStats={isClientViewer}
    />
  );

  const visibilityPanel = (
    <SeoGeoPanel
      insights={seoGeo}
      trackedCompetitors={trackedCompetitorRefs}
      clientWebsite={client.website}
      isClientViewer={isClientViewer}
      // QA F20: the panel promises a "next snapshot" throughout, and the
      // monthly schedule never fires for a client whose admin never turned
      // it on — so the report ages silently forever. The panel needs to know.
      intelScheduleEnabled={client.intelScheduleEnabled ?? false}
      intelScheduleNextRunAt={client.intelScheduleNextRunAt ?? null}
      isRefreshing={isAiProcessingLockActive(client)}
      // QA F99: for the client the scores and the plan are lifted to the top of
      // the visibility tab (below), so the panel must not repeat them.
      hideScores={isClientViewer && !!seoGeo}
      hidePlan={isClientViewer && !!seoGeo}
    />
  );

  // Staff keep the plain single stack: this is the operator's read-everything
  // view, and the findings below are about what a CLIENT lands on.
  if (!isClientViewer) {
    return (
      <>
        <PageHeader
          title="Dashboard"
          description={`Workspace overview for ${client.name}.`}
          // CD-G5: regeneration rewrites the documents AND the SEO/GEO intel, so
          // it needs an entry point at client level and not only in the rail's
          // documents header. Admin-only, same gate as that one — an employee or
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
          {/* CLIENT_USER already sees this via the (app) shell's own wrapper — only
              render here for staff, who use the plain Sidebar shell with no such wrapper. */}
          <AiProcessingBanner client={client} isAdmin={user.role === "KAROS_ADMIN"} />
          <section className="space-y-3">{analytics}</section>
          <section className="space-y-3">{visibilityPanel}</section>
          <section className="space-y-3">
            <AiInsights clientId={client.id} />
          </section>
        </div>
      </>
    );
  }

  // The whole search-and-AI-visibility story, in reading order, INSIDE its tab:
  // headline scores first (and CD-B4's legacy-snapshot notice rides with them,
  // since SeoGeoScores renders the two together), then the fix list, then the
  // full report with those two suppressed so nothing renders twice.
  //
  // The scores and the plan used to sit outside the tabs, above the segmented
  // control. That put ~1.6 screens of visibility content AHEAD of the control,
  // and selecting "Search & AI visibility" then appended the rest of the report
  // BELOW it — the client read the same subject twice, in two presentations, on
  // one scroll. A tab control has to sit above everything it switches, and
  // nothing behind a tab may also render outside it.
  const visibility = seoGeo ? (
    <div className="space-y-8">
      <section className="space-y-3">
        <p className="font-mono text-[10px] uppercase tracking-[0.08em] text-muted">
          Visibility scores
        </p>
        <SeoGeoScores insights={seoGeo} />
      </section>
      <section className="space-y-3">
        <p className="font-mono text-[10px] uppercase tracking-[0.08em] text-muted">Action plan</p>
        <SeoGeoPlan insights={seoGeo} isClientViewer />
      </section>
      {visibilityPanel}
    </div>
  ) : (
    visibilityPanel
  );

  // QA F99 — client dashboard, in value order. What needs the client now
  // (attention + recent), then the plain-English briefing. Everything heavy (the
  // full performance breakdown and the full visibility report) sits behind a
  // segmented control instead of five screens of always-expanded detail. The
  // oversized "Welcome back" banner — the shallowest element on the page —
  // becomes one line.
  return (
    <>
      <p className="mb-6 text-sm text-muted">
        {firstName ? `Welcome back, ${firstName}` : "Welcome back"} — here&apos;s what&apos;s
        happening across the {client.name} workspace.
      </p>
      <div className="space-y-8">
        <section className="space-y-3">
          <p className="font-mono text-[10px] uppercase tracking-[0.08em] text-muted">Overview</p>
          {/* CD-H1: the five counters open the page. F99 left them inside the
              Performance tab, which put them ~1000px down behind AI Insights —
              the exact complaint CD-G6 struck F124 over. The rest of F99's
              arrangement is untouched; only the stat row moves. */}
          <div className="space-y-6">
            <ClientAnalyticsStats
              assets={analyticsAssets}
              jobs={jobs}
              integrations={integrations}
            />
            <ClientHomeOverview
              tasks={tasks}
              assets={overviewAssets}
              viewerIsClient={isClientViewer}
            />
          </div>
        </section>
        <section className="space-y-3">
          <p className="font-mono text-[10px] uppercase tracking-[0.08em] text-muted">AI Insights</p>
          <AiInsights clientId={client.id} />
        </section>
        <ClientDashboardTabs performance={analytics} visibility={visibility} />
      </div>
    </>
  );
}
