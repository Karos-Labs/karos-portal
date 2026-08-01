import { requireUser, requireVisibleClient } from "@/lib/auth";
import { listClientContextDocs, listClientCompetitors } from "@/lib/data";
import { toStaffShellView } from "@/lib/client-visibility";
import { ClientContextSync } from "@/lib/active-client-context";

/**
 * Nested layout for all /clients/[id]/... routes.
 * For staff, fetches the minimal client data needed by the sidebar and seeds
 * the ActiveClientContext via ClientContextSync so that the Staff Sidebar
 * can show client-specific sections (Documents, Competitors, Brand Colors)
 * throughout the entire client sub-tree without needing a layout switch.
 * CLIENT_USER routes are passed through untouched (their data lives in the
 * top-level app layout's ClientRail shell).
 *
 * The guard is here as well as on every page under it because this layout
 * BUILDS a payload rather than just wrapping one: an unassigned employee who
 * typed the URL used to be handed the whole client document plus every context
 * doc and competitor, before any page decided anything. It is not a substitute
 * for the page's own guard — see requireVisibleClient on why a layout cannot
 * be the only gate — and both resolve through the same React-cached read.
 *
 * `toStaffShellView` is what crosses to the browser, not the client document:
 * ClientContextSync is a "use client" component, so the join token and the rest
 * of the internal fields would otherwise ride along unrendered but readable.
 * contextDocs and competitors cross whole — the rail's Documents panel renders
 * their full markdown (print, download, section reader) and CompetitorTrack
 * renders the roster, so there is nothing there that is not asked for.
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

  // Guard BEFORE the fan-out, not inside it: a refused viewer should not cause
  // this client's documents and competitor roster to be read at all.
  const client = await requireVisibleClient(user, id);
  const [contextDocs, competitors] = await Promise.all([
    listClientContextDocs(id),
    listClientCompetitors(id),
  ]);

  return (
    <>
      <ClientContextSync
        client={toStaffShellView(client)}
        contextDocs={contextDocs}
        competitors={competitors}
        isAdmin={user.role === "KAROS_ADMIN"}
      />
      {children}
    </>
  );
}
