import { redirect } from "next/navigation";
import { requireUser, requireVisibleClient } from "@/lib/auth";
import { listAssets } from "@/lib/data";
import { PageHeader } from "@/components/ui";
import { AssetsView } from "@/components/assets-view";
import { getClientLibraryAssets } from "@/lib/asset-visibility";

/**
 * A single client's deliverables, for staff to review and approve. Approving a
 * draft (draft → approved) is what makes it visible in the client's own Library.
 * Client users are sent to their Library (they never see this staff review view).
 */
export default async function ClientAssetsPage({ params }: { params: Promise<{ id: string }> }) {
  const user = await requireUser();
  const { id } = await params;

  if (user.role === "CLIENT_USER") {
    // Client Library lives in Account Center's Archive tab now. The Workspace
    // board this used to bounce through is gone entirely (2026-08); a client
    // with no resolvable id falls back to /calendar instead, same as the
    // sidebar's own no-clientId fallback (see sidebar.tsx's homeHref).
    redirect(user.clientId === id ? `/clients/${id}` : user.clientId ? `/clients/${user.clientId}` : "/calendar");
  } else if (user.role !== "KAROS_ADMIN" && user.role !== "KAROS_EMPLOYEE") {
    redirect("/dashboard");
  }

  const client = await requireVisibleClient(user, id);

  const assets = getClientLibraryAssets(await listAssets({ clientId: id }));

  const pendingCount = assets.filter((a) => a.status === "draft").length;

  return (
    <>
      <PageHeader
        title="Assets"
        description={
          pendingCount > 0
            ? `${pendingCount} draft${pendingCount === 1 ? "" : "s"} awaiting review. Approve to publish to ${client.name}.`
            : `Deliverables for ${client.name}. Approved items appear in the client's library.`
        }
      />
      <AssetsView assets={assets} canApprove />
    </>
  );
}
