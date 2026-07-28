import { redirect } from "next/navigation";
import { requireUser } from "@/lib/auth";
import { listAssets, listClients } from "@/lib/data";
import { EmptyState, PageHeader } from "@/components/ui";
import { Icon } from "@/components/icon";
import { AssetsView } from "@/components/assets-view";
import { getClientLibraryAssets } from "@/lib/asset-visibility";
import { pushablePlatformsByClient } from "@/lib/publish-targets";
import type { Asset } from "@/lib/types";

export default async function AssetsPage({
  searchParams,
}: {
  searchParams: Promise<{ clientId?: string; status?: string }>;
}) {
  const user = await requireUser();
  const { clientId: viewClientId, status } = await searchParams;
  const initialStatus: Asset["status"] | undefined =
    status === "draft" || status === "approved" || status === "scheduled" || status === "delivered" || status === "published"
      ? status
      : undefined;

  // The client Library merged into the Workspace's Archive tab (2026-07) —
  // client users land there; this route stays the staff review surface.
  if (user.role === "CLIENT_USER") redirect("/tasks");

  const employeeFilter = user.role === "KAROS_EMPLOYEE" ? { employeeId: user.uid } : undefined;
  const clients = await listClients(employeeFilter);

  // Staff arriving via the sidebar's "View as client" nav get the same
  // library a client sees, scoped to that one client.
  const viewClient = viewClientId ? clients.find((c) => c.id === viewClientId) : undefined;
  if (viewClient) {
    // Staff "view as client" keeps FULL visibility (invariant A10.6) so they can
    // review/approve upcoming posts — no forClient redaction, no viewerIsClient.
    // Route through getClientLibraryAssets only for the same recency ordering.
    const clientAssets = getClientLibraryAssets(await listAssets({ clientId: viewClient.id }));
    return (
      <>
        <PageHeader title={`${viewClient.name} · Library`} description="Content library and delivery calendar." />
        <AssetsView assets={clientAssets} initialStatus={initialStatus} />
      </>
    );
  }

  const allAssets = await listAssets();
  const clientIds = new Set(clients.map((c) => c.id));
  // Admins and employees alike only see assets of EXISTING (visible) clients —
  // orphaned assets of deleted clients used to leak into this cross-client view.
  const assets = allAssets.filter((a) => clientIds.has(a.clientId));
  const connectedPlatformsByClient = await pushablePlatformsByClient(assets);
  return (
    <>
      <PageHeader title="Assets" description="All content generated across your clients." />
      {assets.length === 0 ? (
        <EmptyState icon={<Icon name="FolderOpen" className="h-7 w-7" />} title="No assets yet" description="Run an agent on a client to generate deliverables." />
      ) : (
        <AssetsView
          assets={assets}
          canApprove
          initialStatus={initialStatus}
          clientNames={Object.fromEntries(clients.map((client) => [client.id, client.name]))}
          {...(connectedPlatformsByClient ? { connectedPlatformsByClient } : {})}
        />
      )}
    </>
  );
}
