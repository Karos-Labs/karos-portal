import Form from "next/form";
import Link from "next/link";
import { redirect } from "next/navigation";
import { requireUser } from "@/lib/auth";
import { listAssets, listClients } from "@/lib/data";
import { EmptyState, PageHeader } from "@/components/ui";
import { Icon } from "@/components/icon";
import { AssetsView } from "@/components/assets-view";
import { BulkUploadClips } from "@/components/bulk-upload-clips";
import { getClientLibraryAssets } from "@/lib/asset-visibility";
import { pushablePlatformsByClient } from "@/lib/publish-targets";
import type { Client } from "@/lib/types";

/**
 * The way from the cross-client grid into ONE client's library.
 *
 * `/assets?clientId=` had exactly one entrance in the whole product — the
 * copilot's staff deep-link fallback — so the branch it opens was unreachable
 * by anyone who had not asked the copilot a question. That branch is now the
 * only place outside the AI Agents page that offers bulk clip upload (#107),
 * which makes "unreachable" the difference between the feature having a home
 * and not.
 *
 * A GET form rather than a select with an onChange handler: `next/form`
 * navigates client-side, works with no JS at all, and needs no "use client"
 * boundary in this server component. `required` over an empty first option is
 * what makes it fail closed — submitting nothing cannot navigate.
 */
function ClientLibraryPicker({ clients }: { clients: Client[] }) {
  return (
    <Form action="/assets" className="flex items-center gap-2">
      <select
        name="clientId"
        required
        defaultValue=""
        aria-label="Client library to open"
        className="h-8 max-w-[190px] truncate rounded-md border border-border bg-surface-2 px-2 text-xs text-foreground outline-none focus:border-neon/50"
      >
        <option value="">Choose a client…</option>
        {clients.map((client) => (
          <option key={client.id} value={client.id}>
            {client.name}
          </option>
        ))}
      </select>
      <button
        type="submit"
        className="inline-flex h-8 shrink-0 items-center gap-1.5 rounded-md border border-border px-2.5 text-xs text-muted transition-colors hover:border-neon/40 hover:text-foreground"
      >
        <Icon name="FolderOpen" className="h-3.5 w-3.5" />
        Open library
      </button>
    </Form>
  );
}

export default async function AssetsPage({
  searchParams,
}: {
  searchParams: Promise<{ clientId?: string }>;
}) {
  const user = await requireUser();
  const { clientId: viewClientId } = await searchParams;

  // The client Library merged into Account Center's Archive tab (2026-07) -
  // client users land there; this route stays the staff review surface. The
  // Workspace board this used to bounce through is gone entirely (2026-08),
  // so a client with no resolvable id falls back to /calendar instead, same
  // as the sidebar's own no-clientId fallback (see sidebar.tsx's homeHref).
  if (user.role === "CLIENT_USER") redirect(user.clientId ? `/clients/${user.clientId}` : "/calendar");

  const employeeFilter = user.role === "KAROS_EMPLOYEE" ? { employeeId: user.uid } : undefined;
  const clients = await listClients(employeeFilter);

  const viewClient = viewClientId ? clients.find((c) => c.id === viewClientId) : undefined;
  if (viewClient) {
    // ── One client's library ──
    //
    // WHAT THIS BRANCH IS FOR, decided rather than inherited. The note here used
    // to say staff arrive "via the sidebar's 'View as client' nav", and that
    // entry is gone: clientViewNav is Dashboard / AI Agents / Calendar /
    // Workspace, and sidebar.tsx records why — the Library was merged into the
    // Workspace's Archive tab and "staff review drafts via the global Assets
    // page", which is this route. So this is not a client's-eye preview. It is
    // the staff review grid below, scoped to one client, reached from the picker
    // in that grid's own header and from the copilot's deep link.
    //
    // It delivered the visibility half of invariant A10.6 — full visibility, no
    // forClient redaction, no viewerIsClient, so staff can review and approve
    // upcoming posts — and silently dropped the approving half, so a branch
    // whose own comment promised review AND approval could do neither.
    //
    // NOT THE ONLY SINGLE-CLIENT LIBRARY, and worth knowing before editing
    // either. `/clients/[id]/assets` renders the same grid for one client, is
    // linked from the agent detail page, the task ticket modal and the live
    // card, and already passes `canApprove` (it passes no push targets, so
    // "Publish now" cannot render there). Two routes for one question is a
    // consolidation nobody has made; whichever survives has to keep the clip
    // uploader and the push targets, because those live here and only here.
    //
    // NO NEW AUTHORITY AND NO NEW WRITE PATH. Before: read-only cards. Now: the
    // same approve / schedule / unschedule / publish-now / edit controls the
    // cross-client grid below already renders — the same staff-only server
    // actions, still authorized by `requireStaff` on the server, over the same
    // documents. Nothing here widens what may be written or by whom:
    // `getClientLibraryAssets` with no `forClient` option only SORTS
    // (asset-visibility.ts), and `viewClient` is resolved out of `clients`,
    // THIS user's own visible set, so every card on this branch is a card the
    // cross-client branch already hands the same user with `canApprove`.
    const clientAssets = getClientLibraryAssets(await listAssets({ clientId: viewClient.id }));
    // Per the F107 note on AssetsView: without this map "Publish now" can never
    // render, and the approve panel's manual-push tier then names a control that
    // is not on the card. Scoped to this one client's assets.
    const clientPlatforms = await pushablePlatformsByClient(clientAssets);
    return (
      <>
        <PageHeader
          title={`${viewClient.name} · Library`}
          // Not "Content library and delivery calendar": the calendar moved to
          // the /calendar route (see the AssetsView docstring) and this page has
          // not carried one since.
          description="Everything delivered for this client. Approve what is ready, or add clips by hand."
          action={
            <div className="flex items-center gap-3">
              {/* #107: the second home. Bulk clip upload is manual upload of
                  pre-made podcast MP4/MOVs — no agent is involved — and its only
                  entrance was the action row of a page titled "AI Agents". A
                  client's content library is where a reader looks for it. */}
              <BulkUploadClips clientId={viewClient.id} bucketName={process.env.GCS_MEDIA_BUCKET} />
              <Link
                href="/assets"
                className="inline-flex items-center gap-1.5 text-xs text-muted hover:text-foreground"
              >
                All clients
              </Link>
            </div>
          }
        />
        <AssetsView
          assets={clientAssets}
          canApprove
          {...(clientPlatforms ? { connectedPlatformsByClient: clientPlatforms } : {})}
        />
      </>
    );
  }

  const allAssets = await listAssets();
  const clientIds = new Set(clients.map((c) => c.id));
  // Admins and employees alike only see assets of EXISTING (visible) clients -
  // orphaned assets of deleted clients used to leak into this cross-client view.
  const assets = allAssets.filter((a) => clientIds.has(a.clientId));
  const connectedPlatformsByClient = await pushablePlatformsByClient(assets);
  return (
    <>
      <PageHeader
        title="Assets"
        // Not "All content generated across your clients": a bulk-uploaded
        // podcast clip is not generated by anything, and describing the page as
        // agent output is the same claim the empty state below used to make.
        description="Every deliverable across your clients, however it got here. Open one client to approve their queue or upload clips."
        {...(clients.length > 0 ? { action: <ClientLibraryPicker clients={clients} /> } : {})}
      />
      {assets.length === 0 ? (
        <EmptyState
          icon={<Icon name="FolderOpen" className="h-7 w-7" />}
          title="No assets yet"
          // It read "Run an agent on a client to generate deliverables", which
          // named the one route it knew and so told a reader looking for the
          // clip uploader that no such thing existed (#107). Both routes now.
          description="Deliverables land here when an agent run produces one, and so do clips you upload by hand into a client library."
        />
      ) : (
        <AssetsView
          assets={assets}
          canApprove
          clientNames={Object.fromEntries(clients.map((client) => [client.id, client.name]))}
          {...(connectedPlatformsByClient ? { connectedPlatformsByClient } : {})}
        />
      )}
    </>
  );
}
