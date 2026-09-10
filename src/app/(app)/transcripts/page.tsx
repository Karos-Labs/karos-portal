import { requireUser } from "@/lib/auth";
import { listTranscripts, listClients, listUsers } from "@/lib/data";
import { Card, PageHeader } from "@/components/ui";
import { Icon } from "@/components/icon";
import { ManualIngestButton } from "@/components/transcript-tools";
import { MeetingSyncButton } from "@/components/meeting-sync-button";
import { MeetingAutoSync } from "@/components/meeting-auto-sync";
import { MeetingsClient } from "@/components/meetings-client";

export default async function TranscriptsPage({
  searchParams,
}: {
  /**
   * `?client=<id>` scopes a STAFF reader's list to one workspace (review wave,
   * 2026-09). It is what the "See all N meetings" link on a client's Account
   * Center sends: that card counts one client's calls, so a link that opened
   * the cross-client list quoted a number the destination did not show. A
   * client reader's list is already scoped to their own workspace below, so the
   * parameter is read for staff only and can widen nobody's access.
   */
  searchParams: Promise<{ client?: string }>;
}) {
  const user = await requireUser();
  const isStaff = user.role !== "CLIENT_USER";
  const { client: clientParam } = await searchParams;
  const scopedClientId = isStaff && clientParam ? clientParam : undefined;

  const [transcripts, clients, users] = await Promise.all([
    user.role === "CLIENT_USER" && user.clientId
      ? listTranscripts({ clientId: user.clientId, excludeHiddenFromClient: true })
      : user.role === "CLIENT_USER"
        ? Promise.resolve([])
        : scopedClientId
          ? listTranscripts({ clientId: scopedClientId })
          : listTranscripts(),
    isStaff ? listClients() : Promise.resolve([]),
    isStaff ? listUsers() : Promise.resolve([]),
  ]);

  return (
    <>
      <PageHeader
        title="Meetings"
        description={
          isStaff
            ? scopedClientId
              ? // Says what the list is showing, because a scoped list that
                // describes itself as the cross-client one is the same
                // mismatch the ?client= link was added to fix.
                `Fireflies transcripts for ${
                  clients.find((c) => c.id === scopedClientId)?.name ?? "this client"
                }.`
              : "Fireflies transcripts, auto-summarized and routed to clients."
            : "Summaries from your calls with the Karos team."
        }
        action={
          isStaff ? (
            <div className="flex flex-wrap items-center gap-2">
              {/* Auto-sync fires silently on page load; manual button remains as fallback */}
              <MeetingAutoSync />
              <MeetingSyncButton />
              <ManualIngestButton />
            </div>
          ) : undefined
        }
      />

      {isStaff && (
        <Card className="mb-6 flex items-start gap-3 border-neon/20 bg-neon-soft/30">
          <Icon name="Webhook" className="mt-0.5 h-5 w-5 text-neon" />
          <div className="text-sm">
            <p className="font-medium">Automatic ingestion is live</p>
            <p className="text-muted">
              Point your Fireflies webhook at{" "}
              <code className="rounded bg-surface-2 px-1 py-0.5 text-xs text-neon">
                /api/ingest/fireflies
              </code>{" "}
              - new meetings with a{" "}
              <code className="rounded bg-surface-2 px-1 py-0.5 text-xs text-neon">
                @karoslabs.com
              </code>{" "}
              participant are summarized and matched to a client by company name.
            </p>
          </div>
        </Card>
      )}

      <MeetingsClient
        transcripts={transcripts}
        clients={clients}
        users={users}
        currentUserRole={user.role}
        currentClientId={user.role === "CLIENT_USER" ? user.clientId : undefined}
      />
    </>
  );
}
