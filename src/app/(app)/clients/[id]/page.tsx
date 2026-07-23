import { notFound, redirect } from "next/navigation";
import { requireUser } from "@/lib/auth";
import {
  getClient,
  getClientSeoGeo,
  listAssets,
  listJobs,
  listClientIntegrations,
  listClientTasks,
  listClientCompetitors,
} from "@/lib/data";
import { computeTrackedCompetitors } from "@/lib/competitor-priority";
import { PageHeader } from "@/components/ui";
import { AiProcessingBanner } from "@/components/ai-processing-banner";
import { ClientAnalytics } from "@/components/client-analytics";
import { AiInsights } from "@/components/ai-insights";
import { ClientHomeOverview } from "@/components/client-home-overview";
import { SeoGeoPanel } from "@/components/seo-geo-panel";
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

  const client = await getClient(id);
  if (!client) notFound();

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

  // The currently-tracked competitor names (same selector as the sidebar) let the panel
  // warn when its frozen snapshot's roster has drifted from the live list (QA Fix 1).
  const trackedCompetitorNames = computeTrackedCompetitors(competitors).map((c) => c.company);

  const firstName = user.name?.trim().split(/\s+/)[0];

  // Client viewers must never receive un-redacted future content across the RSC
  // boundary (requirement H / amendment A6). The home overview gets whitelist-
  // redacted placeholders for locked (future-dated) posts; analytics is fed only
  // currently-unlocked assets so upcoming volume isn't revealed in its counts.
  // Staff keep full visibility (invariant A10.6).
  const overviewAssets = isClientViewer
    ? getClientLibraryAssets(assets, { forClient: true })
    : assets;
  const analyticsAssets = isClientViewer
    ? overviewAssets.filter((a) => !a.locked)
    : assets;

  return (
    <>
      {isClientViewer ? (
        <PageHeader
          title={firstName ? `Welcome back, ${firstName}` : "Welcome back"}
          description={`Here's what's happening across the ${client.name} workspace.`}
        />
      ) : (
        <PageHeader title="Dashboard" description={`Workspace overview for ${client.name}.`} />
      )}
      <div className="space-y-8">
        {/* CLIENT_USER already sees this via the (app) shell's own wrapper — only
            render here for staff, who use the plain Sidebar shell with no such wrapper. */}
        {!isClientViewer && <AiProcessingBanner client={client} isAdmin={user.role === "KAROS_ADMIN"} />}
        {isClientViewer && (
          <section className="space-y-3">
            <p className="font-mono text-[10px] uppercase tracking-[0.08em] text-muted">Overview</p>
            <ClientHomeOverview jobs={jobs} tasks={tasks} assets={overviewAssets} />
          </section>
        )}
        <section className="space-y-3">
          {isClientViewer && (
            <p className="font-mono text-[10px] uppercase tracking-[0.08em] text-muted">Performance</p>
          )}
          <ClientAnalytics
            clientId={client.id}
            clientName={client.name}
            assets={analyticsAssets}
            jobs={jobs}
            integrations={integrations}
          />
        </section>
        <section className="space-y-3">
          {isClientViewer && (
            <p className="font-mono text-[10px] uppercase tracking-[0.08em] text-muted">Search &amp; AI visibility</p>
          )}
          <SeoGeoPanel insights={seoGeo} trackedCompetitors={trackedCompetitorNames} />
        </section>
        <section className="space-y-3">
          {isClientViewer && (
            <p className="font-mono text-[10px] uppercase tracking-[0.08em] text-muted">AI Insights</p>
          )}
          <AiInsights clientId={client.id} />
        </section>
      </div>
    </>
  );
}
