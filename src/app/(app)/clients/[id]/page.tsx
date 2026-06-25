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
} from "@/lib/data";
import { Card, CardTitle, Badge } from "@/components/ui";
import { Icon } from "@/components/icon";
import { ClientEditor } from "@/components/client-editor";
import { JobStatusBadge } from "@/components/job-status";
import { ClientDashboard } from "@/components/client-dashboard";
import { ChatbotWidget } from "@/components/chatbot-widget";
import { initials, relativeTime } from "@/lib/utils";

export default async function ClientDetailPage({ params }: { params: Promise<{ id: string }> }) {
  const user = await requireUser();
  const { id } = await params;

  // Clients may only view their own account
  if (user.role === "client") {
    if (user.clientId !== id) redirect(user.clientId ? `/clients/${user.clientId}` : "/assets");
  } else if (user.role !== "admin" && user.role !== "employee") {
    redirect("/dashboard");
  }

  const client = await getClient(id);
  if (!client) notFound();

  const [agents, assets, transcripts, jobs, contextItems, report, competitors, contextDocs] = await Promise.all([
    listAgents({ status: "published" }),
    listAssets({ clientId: id }),
    listTranscripts({ clientId: id }),
    listJobs({ clientId: id }),
    listContextItems({ clientId: id }),
    getClientReport(id),
    listClientCompetitors(id),
    // Fetch context docs — tier filtering happens in the UI based on user role
    listClientContextDocs(id),
  ]);

  return (
    <>
      <Link
        href="/clients"
        className="mb-4 inline-flex items-center gap-1 text-xs text-muted hover:text-foreground"
      >
        <Icon name="ArrowLeft" className="h-3.5 w-3.5" /> All clients
      </Link>

      <div className="mb-6 flex flex-wrap items-center justify-between gap-3">
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
        <Badge tone={client.status === "active" ? "neon" : "neutral"}>{client.status}</Badge>
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
          currentUserRole={user.role}
        />

        {/* Sidebar */}
        <div className="space-y-6">
          <ClientEditor client={client} />

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
          </Card>
        </div>
      </div>

      {/* ChatbotWidget is placed here — outside the grid — so position:fixed is
          never trapped by grid/tab/overflow ancestors */}
      <ChatbotWidget clientId={client.id} clientName={client.name} />
    </>
  );
}
