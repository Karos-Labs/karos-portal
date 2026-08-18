import { redirect } from "next/navigation";
import { requireUser, requireVisibleClient } from "@/lib/auth";
import { PageHeader } from "@/components/ui";
import { ClientDownloads } from "@/components/client-downloads";

/**
 * Surface 07 (portal revamp) — its own sidebar tab, distinct from the daily
 * nav: "everything else on the sidebar is something a client does, this is
 * the one thing they take away."
 */
export default async function ClientDownloadsPage({ params }: { params: Promise<{ id: string }> }) {
  const user = await requireUser();
  const { id } = await params;

  if (user.role === "CLIENT_USER") {
    if (user.clientId !== id) redirect(user.clientId ? `/clients/${user.clientId}` : "/assets");
  } else if (user.role !== "KAROS_ADMIN" && user.role !== "KAROS_EMPLOYEE") {
    redirect("/dashboard");
  }

  const client = await requireVisibleClient(user, id);

  return (
    <>
      <PageHeader
        title="Downloads"
        description={`Take a day of ${client.name}'s content with you.`}
      />
      <ClientDownloads clientId={client.id} viewerIsClient={user.role === "CLIENT_USER"} />
    </>
  );
}
