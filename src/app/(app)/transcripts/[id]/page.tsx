import Link from "next/link";
import { notFound } from "next/navigation";
import { requireUser } from "@/lib/auth";
import { getTranscript, listClients } from "@/lib/data";
import { Card, CardTitle, Badge } from "@/components/ui";
import { Icon } from "@/components/icon";
import { TranscriptAssign } from "@/components/transcript-tools";
import { formatDateTime } from "@/lib/utils";

export default async function TranscriptDetailPage({ params }: { params: Promise<{ id: string }> }) {
  const user = await requireUser();
  const { id } = await params;
  const t = await getTranscript(id);
  if (!t) notFound();
  if (user.role === "client" && t.clientId !== user.clientId) notFound();
  const isStaff = user.role !== "client";
  const clients = isStaff ? await listClients() : [];

  return (
    <>
      <Link href="/transcripts" className="mb-4 inline-flex items-center gap-1 text-xs text-muted hover:text-foreground">
        <Icon name="ArrowLeft" className="h-3.5 w-3.5" /> All meetings
      </Link>

      <div className="mb-6 flex flex-wrap items-start justify-between gap-3">
        <div>
          <div className="flex items-center gap-2">
            <h1 className="text-2xl font-semibold tracking-tight">{t.title}</h1>
            {t.source === "fireflies" && <Badge tone="neutral">Fireflies</Badge>}
          </div>
          <p className="mt-1 text-sm text-muted">
            {formatDateTime(t.meetingDate ?? t.createdAt)}
            {t.durationMin ? ` · ${t.durationMin} min` : ""}
            {t.participants.length > 0 ? ` · ${t.participants.join(", ")}` : ""}
          </p>
        </div>
        {isStaff && <TranscriptAssign transcriptId={t.id} clients={clients} current={t.clientId} />}
      </div>

      <div className="grid gap-6 lg:grid-cols-[1fr_320px]">
        <div className="space-y-6">
          <Card>
            <CardTitle className="mb-2">Summary</CardTitle>
            <p className="whitespace-pre-wrap text-sm text-muted">{t.summary || "No summary available."}</p>
          </Card>
          <Card>
            <CardTitle className="mb-2">Transcript</CardTitle>
            <pre className="max-h-[480px] overflow-auto whitespace-pre-wrap text-xs text-muted">{t.rawText}</pre>
          </Card>
        </div>

        <div className="space-y-6">
          <Card>
            <CardTitle className="mb-3">Action items</CardTitle>
            {(t.actionItems ?? []).length === 0 ? (
              <p className="text-sm text-muted-2">None extracted.</p>
            ) : (
              <ul className="space-y-2">
                {t.actionItems!.map((a, i) => (
                  <li key={i} className="flex gap-2 text-sm">
                    <Icon name="SquareCheck" className="mt-0.5 h-4 w-4 shrink-0 text-neon" />
                    <span className="text-muted">{a}</span>
                  </li>
                ))}
              </ul>
            )}
          </Card>
          {(t.keywords ?? []).length > 0 && (
            <Card>
              <CardTitle className="mb-3">Topics</CardTitle>
              <div className="flex flex-wrap gap-1.5">
                {t.keywords!.map((k) => (
                  <Badge key={k} tone="neutral">{k}</Badge>
                ))}
              </div>
            </Card>
          )}
        </div>
      </div>
    </>
  );
}
