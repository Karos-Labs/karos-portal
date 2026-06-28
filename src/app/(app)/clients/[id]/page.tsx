import Link from "next/link";
import { notFound, redirect } from "next/navigation";
import { requireUser } from "@/lib/auth";
import {
  getClient,
  getClientReport,
  listClientCompetitors,
  listClientContextDocs,
  listAgents,
  listAssets,
  listTranscripts,
  listJobs,
  listContextItems,
  listClientActivityLogs,
  listClientIntegrations,
  getContentEngineConfig,
  getContentCatalog,
  getNewsletterConfig,
} from "@/lib/data";
import { missingBrandFields } from "@/lib/newsletter/brand";
import { getOAuthEnabledPlatforms } from "@/lib/integrations/oauth";
import { Card, CardTitle, Badge, Button } from "@/components/ui";
import { Icon } from "@/components/icon";
import { ClientEditor } from "@/components/client-editor";
import { ClientKeyPanel } from "@/components/client-key-panel";
import { ClientKeyInline } from "@/components/client-key-inline";
import { ContentEngineLauncher } from "@/components/content-engine-launcher";
import { JobStatusBadge } from "@/components/job-status";
import { ClientDashboard } from "@/components/client-dashboard";
import { ChatbotWidget } from "@/components/chatbot-widget";
import { PreviewBrandButton } from "@/components/preview-brand-button";
import { initials, relativeTime } from "@/lib/utils";

export default async function ClientDetailPage({ params }: { params: Promise<{ id: string }> }) {
  const user = await requireUser();
  const { id } = await params;

  // CLIENT_USER may only view their own account
  if (user.role === "CLIENT_USER") {
    if (user.clientId !== id) redirect(user.clientId ? `/clients/${user.clientId}` : "/assets");
  } else if (user.role !== "KAROS_ADMIN" && user.role !== "KAROS_EMPLOYEE") {
    redirect("/dashboard");
  }

  const client = await getClient(id);
  if (!client) notFound();

  const oauthEnabledPlatforms = getOAuthEnabledPlatforms();

  const [agents, assets, transcripts, jobs, contextItems, report, competitors, contextDocs, activityLogs, integrations, ceConfig, ceCatalog, nlConfig] = await Promise.all([
    listAgents({ status: "published" }),
    listAssets({ clientId: id }),
    listTranscripts({ clientId: id }),
    listJobs({ clientId: id }),
    listContextItems({ clientId: id }),
    getClientReport(id),
    listClientCompetitors(id),
    // Fetch context docs — tier filtering happens in the UI based on user role
    listClientContextDocs(id),
    listClientActivityLogs(id),
    listClientIntegrations(id),
    getContentEngineConfig(id),
    getContentCatalog(id),
    getNewsletterConfig(id),
  ]);
  // The run needs BOTH a config and a (non-empty) catalog, so only offer it then.
  const contentEngineReady = Boolean(ceConfig && ceCatalog && ceCatalog.entries.length > 0);
  // Newsletter onboarding status: no doc → Not started; required brand fields filled → Ready.
  const newsletterStatus = !nlConfig
    ? "Not started"
    : missingBrandFields(nlConfig.brand).length === 0
      ? "Ready"
      : "Draft";

  return (
    <>
      <Link
        href="/clients"
        className="mb-4 inline-flex items-center gap-1 text-xs text-muted hover:text-foreground"
      >
        <Icon name="ArrowLeft" className="h-3.5 w-3.5" /> All clients
      </Link>

      <div className="mb-6 flex flex-wrap items-center justify-between gap-3">
        {/* Left: avatar + name + meta */}
        <div className="flex items-center gap-3">
          <div
            className="flex h-14 w-14 items-center justify-center rounded-[14px] text-lg font-semibold"
            style={{
              background: (client.accentColor ?? "#2dff9e") + "1f",
              color: client.accentColor ?? "#2dff9e",
            }}
          >
            {initials(client.name)}
          </div>
          <div>
            <h1 className="text-2xl font-semibold tracking-tight">{client.name}</h1>
            <p className="text-sm text-muted">
              {client.website || client.industry || "—"}
              {client.contactEmail && (
                <span className="text-muted-2"> · {client.contactEmail}</span>
              )}
            </p>
          </div>
        </div>

        {/* Right: preview toggle + status badge */}
        <div className="flex items-center gap-2">
          <PreviewBrandButton guidelines={client.brandingGuidelines} />
          <Badge tone={client.status === "active" ? "neon" : "neutral"}>{client.status}</Badge>
        </div>
      </div>

      <div className="grid gap-6 lg:grid-cols-[1fr_360px]">
        {/* Main: tabbed dashboard */}
        <ClientDashboard
          client={client}
          report={report}
          competitors={competitors}
          agents={agents}
          jobs={jobs}
          assets={assets}
          contextItems={contextItems}
          contextDocs={contextDocs}
          integrations={integrations}
          oauthEnabledPlatforms={oauthEnabledPlatforms}
          activityLogs={activityLogs}
          currentUserRole={user.role}
        />

        {/* Sidebar */}
        <div className="space-y-6">
          {contentEngineReady && <ContentEngineLauncher clientId={id} clientName={client.name} />}

          <Card>
            <div className="mb-2 flex items-center justify-between gap-2">
              <CardTitle>Newsletter &amp; blog</CardTitle>
              <span className="rounded-full bg-surface-3 px-2 py-0.5 text-[10px] font-medium uppercase tracking-wide text-muted">e11</span>
            </div>
            <div className="mb-3 flex items-center gap-2">
              <Badge tone={newsletterStatus === "Ready" ? "neon" : newsletterStatus === "Draft" ? "warning" : "neutral"}>
                {newsletterStatus}
              </Badge>
              {nlConfig?.optIn && <Badge tone="info">Weekly opt-in</Badge>}
            </div>
            <p className="mb-3 text-sm text-muted-2">
              Onboarding intake for the weekly newsletter + companion blog: brand, editorial
              foundation, and voice-anchor uploads.
            </p>
            <Link href={`/clients/${id}/newsletter`}>
              <Button size="sm" variant="outline">
                <Icon name="Newspaper" className="h-4 w-4" />
                {newsletterStatus === "Not started" ? "Start setup" : "Open setup"}
              </Button>
            </Link>
          </Card>

          <ClientEditor client={client} />

          {/* Client Access Key — visible to staff only so they can share it with the client */}
          {(user.role === "KAROS_ADMIN" || user.role === "KAROS_EMPLOYEE") && (
            <ClientKeyPanel clientId={client.id} clientKeyId={client.clientKeyId} />
          )}

          <Card>
            <CardTitle className="mb-3">Recent jobs</CardTitle>
            {jobs.length === 0 ? (
              <p className="text-sm text-muted-2">No runs yet.</p>
            ) : (
              <ul className="space-y-2">
                {jobs.slice(0, 5).map((j) => (
                  <li key={j.id}>
                    <Link
                      href={`/jobs/${j.id}`}
                      className="flex items-center justify-between gap-2 rounded-lg p-1.5 hover:bg-surface-2"
                    >
                      <div className="min-w-0">
                        <p className="truncate text-sm">{j.agentName}</p>
                        <p className="text-xs text-muted-2">{relativeTime(j.createdAt)}</p>
                      </div>
                      <JobStatusBadge status={j.status} />
                    </Link>
                  </li>
                ))}
              </ul>
            )}
          </Card>

          <Card>
            <div className="mb-3 flex items-center justify-between">
              <CardTitle>Meetings</CardTitle>
              <Link href="/transcripts" className="text-xs text-neon hover:underline">
                All
              </Link>
            </div>
            {transcripts.length === 0 ? (
              <p className="text-sm text-muted-2">No meetings linked yet.</p>
            ) : (
              <ul className="space-y-2">
                {transcripts.slice(0, 5).map((t) => (
                  <li key={t.id}>
                    <Link
                      href={`/transcripts/${t.id}`}
                      className="block rounded-lg p-1.5 hover:bg-surface-2"
                    >
                      <p className="truncate text-sm">{t.title}</p>
                      <p className="text-xs text-muted-2">
                        {relativeTime(t.meetingDate ?? t.createdAt)}
                      </p>
                    </Link>
                  </li>
                ))}
              </ul>
            )}

            {/* Invite key — low-profile, shown to client users so they can onboard teammates */}
            {user.role === "CLIENT_USER" && client.clientKeyId && (
              <ClientKeyInline clientKeyId={client.clientKeyId} />
            )}
          </Card>
        </div>
      </div>

      {/* ChatbotWidget is placed here — outside the grid — so position:fixed is
          never trapped by grid/tab/overflow ancestors */}
      <ChatbotWidget
        clientId={client.id}
        clientName={client.name}
        agents={agents.filter((a) => a.isActive && !a.isSystem && a.id !== "intel-report-agent")}
      />
    </>
  );
}
