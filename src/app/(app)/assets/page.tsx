import { requireUser } from "@/lib/auth";
import { listAssets, listClients } from "@/lib/data";
import { EmptyState, PageHeader, Badge } from "@/components/ui";
import { Icon } from "@/components/icon";
import { AssetCard } from "@/components/asset-card";
import { AssetsView } from "@/components/assets-view";

export default async function AssetsPage({
  searchParams,
}: {
  searchParams: Promise<{ clientId?: string }>;
}) {
  const user = await requireUser();
  const { clientId: viewClientId } = await searchParams;

  if (user.role === "CLIENT_USER") {
    if (!user.clientId) {
      return (
        <>
          <PageHeader title="Your assets" description="Everything your Karos team has created for you." />
          <EmptyState icon={<Icon name="FolderOpen" className="h-7 w-7" />} title="Nothing here yet" description="Your deliverables will show up here as your team creates them." />
        </>
      );
    }
    const allClientAssets = await listAssets({ clientId: user.clientId });
    // Clients only see deliverables their Karos team has approved — drafts stay internal.
    const assets = allClientAssets.filter((a) => a.status !== "draft");
    return (
      <>
        <PageHeader title="Library" description="Your content library and delivery calendar." />
        <AssetsView assets={assets} />
      </>
    );
  }

  const employeeFilter = user.role === "KAROS_EMPLOYEE" ? { employeeId: user.uid } : undefined;
  const clients = await listClients(employeeFilter);

  // Staff arriving via the sidebar's "View as client" nav get the same
  // library/calendar toggle a client sees, scoped to that one client.
  const viewClient = viewClientId ? clients.find((c) => c.id === viewClientId) : undefined;
  if (viewClient) {
    const clientAssets = await listAssets({ clientId: viewClient.id });
    return (
      <>
        <PageHeader title={`${viewClient.name} · Library`} description="Content library and delivery calendar." />
        <AssetsView assets={clientAssets} />
      </>
    );
  }

  const allAssets = await listAssets();
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
