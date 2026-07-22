import { requireUser } from "@/lib/auth";
import { listAssets, listClients } from "@/lib/data";
import { EmptyState, PageHeader } from "@/components/ui";
import { Icon } from "@/components/icon";
import { AssetsView } from "@/components/assets-view";
import { getClientLibraryAssets } from "@/lib/asset-visibility";
import type { Asset } from "@/lib/types";

export default async function AssetsPage({
  searchParams,
}: {
  searchParams: Promise<{ clientId?: string; view?: string; status?: string }>;
}) {
  const user = await requireUser();
  const { clientId: viewClientId, view, status } = await searchParams;
  const initialView = view === "library" ? "library" : "calendar";
  const initialStatus: Asset["status"] | undefined =
    status === "draft" || status === "approved" || status === "scheduled" || status === "delivered" || status === "published"
      ? status
      : undefined;

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
    // THE serialization boundary for requirement H: future-dated posts are
    // whitelist-redacted (no content / imageUrl / meta / real title) before they
    // cross to the client browser. Never pass allClientAssets to a client
    // component in this branch — only the redacted set.
    const assets = getClientLibraryAssets(allClientAssets, { forClient: true });
    return (
      <>
        <PageHeader title="Library" description="Your content library and delivery calendar." />
        <AssetsView assets={assets} viewerIsClient initialView={initialView} initialStatus={initialStatus} />
      </>
    );
  }

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
        <AssetsView assets={clientAssets} initialView={initialView} initialStatus={initialStatus} />
      </>
    );
  }

  const allAssets = await listAssets();
  const clientIds = new Set(clients.map((c) => c.id));
  const assets = user.role === "KAROS_EMPLOYEE" ? allAssets.filter((a) => clientIds.has(a.clientId)) : allAssets;
  return (
    <>
      <PageHeader title="Assets" description="All content generated across your clients." />
      {assets.length === 0 ? (
        <EmptyState icon={<Icon name="FolderOpen" className="h-7 w-7" />} title="No assets yet" description="Run an agent on a client to generate deliverables." />
      ) : (
        <AssetsView
          assets={assets}
          canApprove
          initialView={initialView}
          initialStatus={initialStatus}
          clientNames={Object.fromEntries(clients.map((client) => [client.id, client.name]))}
        />
      )}
    </>
  );
}
