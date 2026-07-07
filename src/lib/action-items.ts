import "server-only";

import {
  actionItemDocId,
  getActionItem,
  setActionItem,
  updateTranscript,
} from "@/lib/data";
import { ACTION_ITEM_STATUS_LABELS } from "@/lib/constants";
import type {
  ActionItem,
  ActionItemHistoryEntry,
  ActionItemStatus,
  Transcript,
} from "@/lib/types";

/**
 * Bridge between the legacy per-transcript action-item arrays (actionItems[],
 * actionItemOwners[], actionItemAssignedUserIds[], completedItems[]) and the
 * managed `actionItems` collection (status / assignee / comments / history).
 *
 * The meeting detail page still reads the transcript arrays; the dashboard
 * reads the managed docs. Helpers here keep the two in sync in both directions.
 */

/* ── history helpers ─────────────────────────────────────────────── */

export function historyEntry(
  type: ActionItemHistoryEntry["type"],
  detail: string,
  actor: { id: string; name: string },
): ActionItemHistoryEntry {
  return { at: Date.now(), actorId: actor.id, actorName: actor.name, type, detail };
}

export function statusLabel(status: ActionItemStatus): string {
  return ACTION_ITEM_STATUS_LABELS[status] ?? status;
}

const SYSTEM_ACTOR = { id: "system", name: "Fireflies sync" };

/* ── creation from ingestion ─────────────────────────────────────── */

/**
 * Create managed action-item docs for a freshly ingested transcript.
 * One doc per extracted item at a deterministic id (idempotent on retry).
 * Auto-matched owners (unambiguous first-name match) arrive pre-assigned.
 */
export async function createActionItemDocsForTranscript(
  transcriptId: string,
  t: Omit<Transcript, "id">,
): Promise<void> {
  const items = t.actionItems ?? [];
  if (items.length === 0) return;

  const now = Date.now();
  await Promise.all(
    items.map((text, i) => {
      const ownerName = t.actionItemOwners?.[i] ?? null;
      const assigneeUserId = ownerName ? (t.actionItemUserMap?.[ownerName] ?? null) : null;

      const created = historyEntry(
        "created",
        `Extracted from meeting "${t.title}" by ${t.source === "manual" ? "manual ingest" : "Fireflies sync"}` +
          (assigneeUserId ? ` and auto-assigned to ${ownerName}` : ""),
        SYSTEM_ACTOR,
      );

      const doc: Omit<ActionItem, "id"> = {
        transcriptId,
        transcriptTitle: t.title,
        sourceIndex: i,
        clientId: t.clientId ?? null,
        meetingDate: t.meetingDate,
        text,
        status: "open",
        assigneeUserId,
        assigneeName: assigneeUserId ? ownerName : null,
        comments: [],
        history: [created],
        createdAt: now,
        updatedAt: now,
      };
      return setActionItem(actionItemDocId(transcriptId, i), doc);
    }),
  );
}

/* ── lazy upsert for pre-existing transcripts ────────────────────── */

/**
 * Ensure a managed doc exists for transcript item `index`, creating it from the
 * transcript's current arrays when missing (transcripts ingested before the
 * managed collection existed). Returns the up-to-date doc.
 */
export async function ensureActionItemDoc(
  t: Transcript,
  index: number,
): Promise<ActionItem | null> {
  const text = t.actionItems?.[index];
  if (text === undefined) return null;

  const id = actionItemDocId(t.id, index);
  const existing = await getActionItem(id);
  if (existing) return existing;

  const ownerName = t.actionItemOwners?.[index] ?? null;
  const assigneeUserId =
    t.actionItemAssignedUserIds?.[index] ??
    (ownerName ? (t.actionItemUserMap?.[ownerName] ?? null) : null);
  const done = (t.completedItems ?? []).includes(index);
  const now = Date.now();

  const doc: Omit<ActionItem, "id"> = {
    transcriptId: t.id,
    transcriptTitle: t.title,
    sourceIndex: index,
    clientId: t.clientId ?? null,
    meetingDate: t.meetingDate,
    text,
    status: done ? "done" : "open",
    assigneeUserId,
    assigneeName: assigneeUserId ? ownerName : null,
    comments: [],
    history: [
      historyEntry("created", `Backfilled from meeting "${t.title}"`, SYSTEM_ACTOR),
    ],
    createdAt: t.createdAt ?? now,
    updatedAt: now,
  };
  await setActionItem(id, doc);
  return { id, ...doc };
}

/* ── mirroring managed-doc changes back to the transcript ────────── */

/** Rebuild the actionItemsByOwner display snapshot (same shape ingest produces). */
function groupItemsByOwner(items: string[], owners: (string | null)[]): Record<string, string[]> {
  const result: Record<string, string[]> = {};
  items.forEach((item, i) => {
    const owner = owners[i] ?? "Unassigned";
    (result[owner] ??= []).push(item);
  });
  return result;
}

/**
 * Mirror a managed status change onto the source transcript's completedItems.
 * Matches the meeting-page behaviour: when every item is done the meeting
 * auto-archives.
 */
export async function mirrorStatusToTranscript(
  t: Transcript,
  index: number,
  status: ActionItemStatus,
): Promise<void> {
  const completedSet = new Set(t.completedItems ?? []);
  if (status === "done") completedSet.add(index);
  else completedSet.delete(index);
  const completedItems = [...completedSet];

  const total = t.actionItems?.length ?? 0;
  const validDone = completedItems.filter((i) => i >= 0 && i < total).length;
  const patch: Partial<Transcript> = { completedItems };
  if (total > 0 && validDone >= total) patch.archived = true;

  await updateTranscript(t.id, patch);
}

/**
 * Mirror a managed reassignment onto the source transcript's parallel arrays
 * (owners, per-item user ids, denormalised assignedUserIds, owner snapshot).
 */
export async function mirrorAssigneeToTranscript(
  t: Transcript,
  index: number,
  assignee: { userId: string; name: string } | null,
): Promise<void> {
  const items = t.actionItems ?? [];
  const len = items.length;

  const owners = [...(t.actionItemOwners ?? Array<null>(len).fill(null))];
  while (owners.length < len) owners.push(null);
  const assignedIds = [...(t.actionItemAssignedUserIds ?? Array<null>(len).fill(null))];
  while (assignedIds.length < len) assignedIds.push(null);

  owners[index] = assignee?.name ?? null;
  assignedIds[index] = assignee?.userId ?? null;

  await updateTranscript(t.id, {
    actionItemOwners: owners,
    actionItemAssignedUserIds: assignedIds,
    assignedUserIds: [...new Set(assignedIds.filter((id): id is string => id !== null))],
    actionItemsByOwner: groupItemsByOwner(items, owners),
  });
}
