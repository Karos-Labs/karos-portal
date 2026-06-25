import { requireUser } from "@/lib/auth";
import { listAssets, listClients } from "@/lib/data";
import { EmptyState, PageHeader, Badge } from "@/components/ui";
import { Icon } from "@/components/icon";
import { AssetCard } from "@/components/asset-card";

export default async function AssetsPage() {
  const user = await requireUser();

  if (user.role === "client") {
    const assets = user.clientId ? await listAssets({ clientId: user.clientId }) : [];
    return (
      <>
        <PageHeader title="Your assets" description="Everything your Karos team has created for you." />
        {assets.length === 0 ? (
          <EmptyState icon={<Icon name="FolderOpen" className="h-7 w-7" />} title="Nothing here yet" description="Your deliverables will show up here as your team creates them." />
        ) : (
          <div className="grid gap-3 lg:grid-cols-2">
            {assets.map((a) => (
              <AssetCard key={a.id} asset={a} canApprove />
            ))}
          </div>
        )}
      </>
    );
  }

  const employeeFilter = user.role === "employee" ? { employeeId: user.uid } : undefined;
  const [allAssets, clients] = await Promise.all([listAssets(), listClients(employeeFilter)]);
  const clientIds = new Set(clients.map((c) => c.id));
  const assets = user.role === "employee" ? allAssets.filter((a) => clientIds.has(a.clientId)) : allAssets;
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
