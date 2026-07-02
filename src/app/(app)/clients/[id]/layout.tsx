import { requireUser } from "@/lib/auth";
import { getClient, listClientContextDocs, listClientCompetitors } from "@/lib/data";
import { ClientContextSync } from "@/lib/active-client-context";

/**
 * Nested layout for all /clients/[id]/... routes.
 * For staff, fetches the minimal client data needed by the sidebar and seeds
 * the ActiveClientContext via ClientContextSync so that the Staff Sidebar
 * can show client-specific sections (Documents, Competitors, Brand Colors)
 * throughout the entire client sub-tree without needing a layout switch.
 * CLIENT_USER routes are passed through untouched (their data lives in the
 * top-level app layout's ClientRail shell).
 */
export default async function ClientLayout({
  children,
  params,
}: {
  children: React.ReactNode;
  params: Promise<{ id: string }>;
}) {
  const user = await requireUser();
  const { id } = await params;

  const isStaff = user.role === "KAROS_ADMIN" || user.role === "KAROS_EMPLOYEE";
  if (!isStaff) return <>{children}</>;

  const [client, contextDocs, competitors] = await Promise.all([
    getClient(id),
    listClientContextDocs(id),
    listClientCompetitors(id),
  ]);

  return (
    <>
      {client && (
        <ClientContextSync
          client={client}
          contextDocs={contextDocs}
          competitors={competitors}
          isAdmin={user.role === "KAROS_ADMIN"}
        />
      )}
      {children}
    </>
  );
}
