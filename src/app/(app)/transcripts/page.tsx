import Link from "next/link";
import { requireUser } from "@/lib/auth";
import { listTranscripts, listClients } from "@/lib/data";
import { Card, Badge, EmptyState, PageHeader } from "@/components/ui";
import { Icon } from "@/components/icon";
import { ManualIngestButton, TranscriptAssign } from "@/components/transcript-tools";
import { relativeTime } from "@/lib/utils";

export default async function TranscriptsPage() {
  const user = await requireUser();
  const isStaff = user.role !== "client";

  const transcripts = user.role === "client"
    ? (user.clientId ? await listTranscripts({ clientId: user.clientId }) : [])
    : await listTranscripts();
  const clients = isStaff ? await listClients() : [];
  const clientName = (id?: string | null) => clients.find((c) => c.id === id)?.name;

  return (
    <>
      <PageHeader
        title="Meetings"
        description={isStaff ? "Fireflies transcripts, auto-summarised and routed to clients." : "Summaries from your calls with the Karos team."}
        action={isStaff ? <ManualIngestButton /> : undefined}
      />

      {isStaff && (
        <Card className="mb-6 flex items-start gap-3 border-neon/20 bg-neon-soft/30">
          <Icon name="Webhook" className="mt-0.5 h-5 w-5 text-neon" />
          <div className="text-sm">
            <p className="font-medium">Automatic ingestion is live</p>
            <p className="text-muted">
              Point your Fireflies webhook at <code className="rounded bg-surface-2 px-1 py-0.5 text-xs text-neon">/api/ingest/fireflies</code> — new
              meetings are summarised and matched to a client by attendee email domain.
            </p>
          </div>
        </Card>
      )}

      {transcripts.length === 0 ? (
        <EmptyState
          icon={<Icon name="Mic" className="h-7 w-7" />}
          title="No meetings yet"
          description={isStaff ? "Connect Fireflies or paste a transcript to get started." : "Meeting summaries will appear here."}
          action={isStaff ? <ManualIngestButton /> : undefined}
        />
      ) : (
        <div className="space-y-3">
          {transcripts.map((t) => (
            <Card key={t.id} className="flex flex-wrap items-start justify-between gap-3">
              <Link href={`/transcripts/${t.id}`} className="min-w-0 flex-1">
                <div className="flex items-center gap-2">
                  <p className="truncate font-medium">{t.title}</p>
                  {t.assignment === "auto" && <Badge tone="neon">Auto-matched</Badge>}
                  {t.assignment === "unassigned" && <Badge tone="warning">Unassigned</Badge>}
                  {t.source === "fireflies" && <Badge tone="neutral">Fireflies</Badge>}
                </div>
                <p className="mt-1 line-clamp-2 text-sm text-muted">{t.summary || "Processing summary…"}</p>
                <p className="mt-1 text-xs text-muted-2">
                  {relativeTime(t.meetingDate ?? t.createdAt)}
                  {t.participants.length > 0 && ` · ${t.participants.length} participants`}
                  {isStaff && clientName(t.clientId) && ` · ${clientName(t.clientId)}`}
                </p>
              </Link>
              {isStaff && <TranscriptAssign transcriptId={t.id} clients={clients} current={t.clientId} />}
            </Card>
          ))}
        </div>
      )}
    </>
  );
}
