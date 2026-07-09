import { notFound, redirect } from "next/navigation";
import { requireUser } from "@/lib/auth";
import { getClient, listAssets } from "@/lib/data";
import { PageHeader } from "@/components/ui";
import { AssetsView } from "@/components/assets-view";

/**
 * A single client's deliverables, for staff to review and approve. Approving a
 * draft (draft → approved) is what makes it visible in the client's own Library.
 * Client users are sent to their Library (they never see this staff review view).
 */
export default async function ClientAssetsPage({ params }: { params: Promise<{ id: string }> }) {
  const user = await requireUser();
  const { id } = await params;

  if (user.role === "CLIENT_USER") {
    redirect(user.clientId === id ? "/assets" : user.clientId ? `/clients/${user.clientId}` : "/assets");
  } else if (user.role !== "KAROS_ADMIN" && user.role !== "KAROS_EMPLOYEE") {
    redirect("/dashboard");
  }

  const client = await getClient(id);
  if (!client) notFound();

  const assets = await listAssets({ clientId: id });

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
