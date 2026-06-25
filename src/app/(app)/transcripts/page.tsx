import { requireUser } from "@/lib/auth";
import { listTranscripts, listClients, listUsers } from "@/lib/data";
import { Card, PageHeader } from "@/components/ui";
import { Icon } from "@/components/icon";
import { ManualIngestButton } from "@/components/transcript-tools";
import { MeetingSyncButton } from "@/components/meeting-sync-button";
import { MeetingAutoSync } from "@/components/meeting-auto-sync";
import { MeetingsClient } from "@/components/meetings-client";

export default async function TranscriptsPage() {
  const user = await requireUser();
  const isStaff = user.role !== "client";

  const [transcripts, clients, users] = await Promise.all([
    user.role === "client" && user.clientId
      ? listTranscripts({ clientId: user.clientId })
      : user.role === "client"
        ? Promise.resolve([])
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
            ? "Fireflies transcripts, auto-summarised and routed to clients."
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
              — new meetings with a{" "}
              <code className="rounded bg-surface-2 px-1 py-0.5 text-xs text-neon">
                @karoslabs.com
              </code>{" "}
              participant are summarised and matched to a client by company name.
            </p>
          </div>
        </Card>
      )}

      <MeetingsClient
        transcripts={transcripts}
        clients={clients}
        users={users}
        currentUserRole={user.role}
        currentClientId={user.role === "client" ? user.clientId : undefined}
      />
    </>
  );
}
