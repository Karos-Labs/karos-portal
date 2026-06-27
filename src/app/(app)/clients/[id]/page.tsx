import Link from "next/link";
import { notFound } from "next/navigation";
import { requireUser } from "@/lib/auth";
import { getClient, listAgents, listAssets, listTranscripts, listJobs, listContextItems, getContentEngineConfig, getContentCatalog } from "@/lib/data";
import { Card, CardTitle, Badge, EmptyState, Button } from "@/components/ui";
import { Icon } from "@/components/icon";
import { ClientEditor } from "@/components/client-editor";
import { ClientContext } from "@/components/client-context";
import { ClientCompetitors } from "@/components/client-competitors";
import { ContentEngineLauncher } from "@/components/content-engine-launcher";
import { AgentCard } from "@/components/agent-card";
import { AssetCard } from "@/components/asset-card";
import { JobStatusBadge } from "@/components/job-status";
import { initials, relativeTime } from "@/lib/utils";

export default async function ClientDetailPage({ params }: { params: Promise<{ id: string }> }) {
  await requireUser(["admin", "employee"]);
  const { id } = await params;
  const client = await getClient(id);
  if (!client) notFound();

  const [agents, assets, transcripts, jobs, contextItems, ceConfig, ceCatalog] = await Promise.all([
    listAgents({ status: "published" }),
    listAssets({ clientId: id }),
    listTranscripts({ clientId: id }),
    listJobs({ clientId: id }),
    listContextItems({ clientId: id }),
    getContentEngineConfig(id),
    getContentCatalog(id),
  ]);
  const activeAgents = agents.filter((a) => a.isActive);
  // The run needs BOTH a config and a (non-empty) catalog, so only offer it then.
  const contentEngineReady = Boolean(ceConfig && ceCatalog && ceCatalog.entries.length > 0);

  return (
    <>
      <Link href="/clients" className="mb-4 inline-flex items-center gap-1 text-xs text-muted hover:text-foreground">
        <Icon name="ArrowLeft" className="h-3.5 w-3.5" /> All clients
      </Link>

      <div className="mb-6 flex flex-wrap items-center justify-between gap-3">
        <div className="flex items-center gap-3">
          <div
            className="flex h-14 w-14 items-center justify-center rounded-[14px] text-lg font-semibold"
            style={{ background: (client.accentColor ?? "#2dff9e") + "1f", color: client.accentColor ?? "#2dff9e" }}
          >
            {initials(client.name)}
          </div>
          <div>
            <h1 className="text-2xl font-semibold tracking-tight">{client.name}</h1>
            <p className="text-sm text-muted">
              {client.website || client.industry || "—"}
              {client.contactEmail && <span className="text-muted-2"> · {client.contactEmail}</span>}
            </p>
          </div>
        </div>
        <Badge tone={client.status === "active" ? "neon" : "neutral"}>{client.status}</Badge>
      </div>

      <div className="grid gap-6 lg:grid-cols-[1fr_360px]">
        <div className="space-y-6">
          {/* Run agents */}
          <div>
            <div className="mb-3 flex items-center justify-between">
              <CardTitle>Run an agent for {client.name}</CardTitle>
              <Link href="/agents" className="text-xs text-neon hover:underline">Manage agents</Link>
            </div>
            {activeAgents.length === 0 ? (
              <EmptyState icon={<Icon name="Bot" className="h-6 w-6" />} title="No active agents" action={<Link href="/agents/new"><Button size="sm">Create one</Button></Link>} />
            ) : (
              <div className="grid gap-4 sm:grid-cols-2">
                {activeAgents.map((a) => (
                  <AgentCard key={a.id} agent={a} clients={[client]} canEdit={false} />
                ))}
              </div>
            )}
          </div>

          {/* Documents (context library) + competitors */}
          <ClientContext clientId={id} items={contextItems} />
          <ClientCompetitors clientId={id} competitors={client.competitors ?? []} />

          {/* Assets */}
          <div>
            <div className="mb-3 flex items-center justify-between">
              <CardTitle>Assets</CardTitle>
              <span className="text-xs text-muted-2">{assets.length} total</span>
            </div>
            {assets.length === 0 ? (
              <EmptyState icon={<Icon name="FolderOpen" className="h-6 w-6" />} title="No assets yet" description="Run an agent above to generate deliverables." />
            ) : (
              <div className="space-y-3">
                {assets.slice(0, 8).map((a) => (
                  <AssetCard key={a.id} asset={a} canApprove />
                ))}
              </div>
            )}
          </div>
        </div>

        <div className="space-y-6">
          {contentEngineReady && <ContentEngineLauncher clientId={id} clientName={client.name} />}
          <ClientEditor client={client} />

          <Card>
            <CardTitle className="mb-3">Recent jobs</CardTitle>
            {jobs.length === 0 ? (
              <p className="text-sm text-muted-2">No runs yet.</p>
            ) : (
              <ul className="space-y-2">
                {jobs.slice(0, 5).map((j) => (
                  <li key={j.id}>
                    <Link href={`/jobs/${j.id}`} className="flex items-center justify-between gap-2 rounded-lg p-1.5 hover:bg-surface-2">
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
              <Link href="/transcripts" className="text-xs text-neon hover:underline">All</Link>
            </div>
            {transcripts.length === 0 ? (
              <p className="text-sm text-muted-2">No meetings linked yet.</p>
            ) : (
              <ul className="space-y-2">
                {transcripts.slice(0, 5).map((t) => (
                  <li key={t.id}>
                    <Link href={`/transcripts/${t.id}`} className="block rounded-lg p-1.5 hover:bg-surface-2">
                      <p className="truncate text-sm">{t.title}</p>
                      <p className="text-xs text-muted-2">{relativeTime(t.meetingDate ?? t.createdAt)}</p>
                    </Link>
                  </li>
                ))}
              </ul>
            )}
          </Card>
        </div>
      </div>
    </>
  );
}
