import { requireUser } from "@/lib/auth";
import { listAssets, listClients, listJobs, listAgents } from "@/lib/data";
import { EmptyState, PageHeader, Badge } from "@/components/ui";
import { Icon } from "@/components/icon";
import { AssetCard } from "@/components/asset-card";
import { AssetsView } from "@/components/assets-view";

export default async function AssetsPage() {
  const user = await requireUser();

  if (user.role === "CLIENT_USER") {
    if (!user.clientId) {
      return (
        <>
          <PageHeader title="Your assets" description="Everything your Karos team has created for you." />
          <EmptyState icon={<Icon name="FolderOpen" className="h-7 w-7" />} title="Nothing here yet" description="Your deliverables will show up here as your team creates them." />
        </>
      );
    }
    const [assets, jobs, agents] = await Promise.all([
      listAssets({ clientId: user.clientId }),
      listJobs({ clientId: user.clientId }),
      listAgents({ status: "published" }),
    ]);
    return (
      <>
        <PageHeader title="Library" description="Your content library and delivery calendar." />
        <AssetsView assets={assets} jobs={jobs} agents={agents} />
      </>
    );
  }

  const employeeFilter = user.role === "KAROS_EMPLOYEE" ? { employeeId: user.uid } : undefined;
  const [allAssets, clients] = await Promise.all([listAssets(), listClients(employeeFilter)]);
  const clientIds = new Set(clients.map((c) => c.id));
  const assets = user.role === "KAROS_EMPLOYEE" ? allAssets.filter((a) => clientIds.has(a.clientId)) : allAssets;
  const clientName = (id: string) => clients.find((c) => c.id === id)?.name ?? "Unknown";

  return (
    <>
      <PageHeader title="Assets" description="All content generated across your clients." />
      {assets.length === 0 ? (
        <EmptyState icon={<Icon name="FolderOpen" className="h-7 w-7" />} title="No assets yet" description="Run an agent on a client to generate deliverables." />
      ) : (
        <div className="grid gap-3 lg:grid-cols-2">
          {assets.map((a) => (
            <div key={a.id}>
              <div className="mb-1 flex items-center gap-2">
                <Badge tone="neutral">{clientName(a.clientId)}</Badge>
              </div>
              <AssetCard asset={a} canApprove />
            </div>
          ))}
        </div>
      )}
    </>
  );
}
