import { notFound, redirect } from "next/navigation";
import { requireUser } from "@/lib/auth";
import {
  getClient,
  listAssets,
  listJobs,
  listClientIntegrations,
  getContentEngineConfig,
  getContentCatalog,
} from "@/lib/data";
import { PageHeader } from "@/components/ui";
import { ContentEngineLauncher } from "@/components/content-engine-launcher";
import { ClientAnalytics } from "@/components/client-analytics";

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

  const [assets, jobs, integrations, ceConfig, ceCatalog] = await Promise.all([
    listAssets({ clientId: id }),
    listJobs({ clientId: id }),
    listClientIntegrations(id),
    getContentEngineConfig(id),
    getContentCatalog(id),
  ]);

  const contentEngineReady = Boolean(ceConfig && ceCatalog && ceCatalog.entries.length > 0);

  return (
    <>
      <PageHeader title="Analytics" description={`Performance snapshot for ${client.name}.`} />
      {contentEngineReady && (
        <div className="mb-6">
          <ContentEngineLauncher clientId={client.id} clientName={client.name} />
        </div>
      )}
      <ClientAnalytics
        clientId={client.id}
        clientName={client.name}
        assets={assets}
        jobs={jobs}
        integrations={integrations}
      />
    </>
  );
}
