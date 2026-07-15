import Link from "next/link";
import { notFound } from "next/navigation";
import { requireUser } from "@/lib/auth";
import { getTranscript, listClients, listUsers } from "@/lib/data";
import { Card, CardTitle, Badge } from "@/components/ui";
import { Icon } from "@/components/icon";
import { TranscriptAssign, TranscriptSignalButton, HideFromClientToggle } from "@/components/transcript-tools";
import { MeetingActionItems } from "@/components/meeting-action-items";
import { ArchiveButton } from "@/components/archive-button";
import { formatDateTime } from "@/lib/utils";
import { deriveActionItemOwners } from "@/lib/transcripts/ingest";
import type { AppUser } from "@/lib/types";

export default async function TranscriptDetailPage({ params }: { params: Promise<{ id: string }> }) {
  const user = await requireUser();
  const { id } = await params;
  const t = await getTranscript(id);
  if (!t) notFound();
  // Client guard: hidden meetings and meetings belonging to other clients are invisible
  if (user.role === "CLIENT_USER") {
    if (t.hiddenFromClient || t.clientId !== user.clientId) notFound();
  }
  const isStaff = user.role !== "CLIENT_USER";
  const isAdmin = user.role === "KAROS_ADMIN";

  const [clients, allUsers] = await Promise.all([
    isStaff ? listClients() : Promise.resolve([]),
    isStaff ? listUsers() : Promise.resolve([]),
  ]);

  // Scope the users shown in action-item assignment dropdowns based on the meeting's client association.
  // Scenario A — meeting is associated with a client: admins + employees + that client's users.
  // Scenario B — unassociated or Karos Internal: admins + employees only.
  const users: AppUser[] = isStaff
    ? t.clientId && !t.isKarosInternal
      ? allUsers.filter(
          (u) =>
            u.role === "KAROS_ADMIN" ||
            u.role === "KAROS_EMPLOYEE" ||
            (u.role === "CLIENT_USER" && u.clientId === t.clientId),
        )
      : allUsers.filter((u) => u.role === "KAROS_ADMIN" || u.role === "KAROS_EMPLOYEE")
    // CLIENT_USER: include only themselves so they can self-assign action items
    : [user];

  // Resolve per-item owners: use stored actionItemOwners, or derive from actionItemsByOwner for backward-compat
  const actionItems = t.actionItems ?? [];
  const actionItemOwners: (string | null)[] =
    t.actionItemOwners?.length === actionItems.length
      ? t.actionItemOwners
      : t.actionItemsByOwner && actionItems.length
        ? deriveActionItemOwners(actionItems, t.actionItemsByOwner)
        : actionItems.map(() => null);

  return (
    <>
      <Link href="/transcripts" className="mb-4 inline-flex items-center gap-1 text-xs text-muted hover:text-foreground">
        <Icon name="ArrowLeft" className="h-3.5 w-3.5" /> All meetings
      </Link>

      <div className="mb-6 flex flex-wrap items-start justify-between gap-3">
        <div>
          <div className="flex flex-wrap items-center gap-2">
            <h1 className="text-2xl font-semibold tracking-tight">{t.title}</h1>
            {t.source === "fireflies" && <Badge tone="neutral">Fireflies</Badge>}
            {t.isKarosInternal && <Badge tone="neutral">Karos Labs Internal</Badge>}
            {t.archived && <Badge tone="neutral">Archived</Badge>}
            {t.hiddenFromClient && isStaff && <Badge tone="warning">Hidden from client</Badge>}
            {t.contextDocSignalAt && <Badge tone="neon">Intel</Badge>}
          </div>
          <p className="mt-1 text-sm text-muted">
            {formatDateTime(t.meetingDate ?? t.createdAt)}
            {t.durationMin ? ` · ${t.durationMin} min` : ""}
            {t.participants.length > 0 ? ` · ${t.participants.join(", ")}` : ""}
          </p>
        </div>
        <div className="flex flex-wrap items-center gap-2">
          {isStaff && t.clientId && !t.contextDocSignalAt && (
            <TranscriptSignalButton transcriptId={t.id} clientId={t.clientId} />
          )}
          {/* Hide-from-client toggle — admin only */}
          {isAdmin && (
            <HideFromClientToggle transcriptId={t.id} hiddenFromClient={!!t.hiddenFromClient} />
          )}
          {isStaff && (
            <ArchiveButton transcriptId={t.id} archived={!!t.archived} />
          )}
          {isStaff && (
            <TranscriptAssign
              transcriptId={t.id}
              clients={clients}
              current={t.clientId}
              isKarosInternal={!!t.isKarosInternal}
            />
          )}
        </div>
      </div>

      <div className="grid gap-6 lg:grid-cols-[1fr_360px]">
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
            <MeetingActionItems
              transcriptId={t.id}
              actionItems={actionItems}
              actionItemOwners={actionItemOwners}
              actionItemUserMap={t.actionItemUserMap ?? {}}
              completedItems={t.completedItems ?? []}
              actionItemAssignedUserIds={
                t.actionItemAssignedUserIds ?? actionItems.map(() => null)
              }
              users={users}
              currentUserId={user.uid}
            />
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
