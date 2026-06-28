"use server";

import { revalidatePath } from "next/cache";
import {
  updateTranscript,
  getTranscript,
  getTranscriptByExternalId,
  getUser,
} from "@/lib/data";
import { getCurrentUser } from "@/lib/auth";
import { ingestTranscript, appendMeetingSignalToContextDoc, buildActionItemsByOwner } from "@/lib/transcripts/ingest";
import { listFirefliesTranscripts, fetchFirefliesTranscript } from "@/lib/transcripts/fireflies";
import type { Transcript } from "@/lib/types";
import { requireStaff, requireAdmin } from "./_shared";

/** Assign a transcript to a client, Karos Labs internal, or unassociated.
 *  Pass clientId as a client Firestore id, "__karos__" for Karos Labs internal, or null to unassign. */
export async function assignTranscriptAction(id: string, clientId: string | null) {
  await requireStaff();
  const isKarosInternal = clientId === "__karos__";
  const patch: Partial<Transcript> = isKarosInternal
    ? { clientId: null, isKarosInternal: true, assignment: "manual" }
    : { clientId, isKarosInternal: false, assignment: clientId ? "manual" : "unassigned" };
  await updateTranscript(id, patch);
  const prev = await getTranscript(id);
  revalidatePath("/transcripts");
  if (prev?.clientId) revalidatePath(`/clients/${prev.clientId}`);
}

/** Toggle the "hidden from client" visibility flag. Admin-only. */
export async function setTranscriptHiddenFromClientAction(id: string, hidden: boolean): Promise<void> {
  await requireAdmin();
  await updateTranscript(id, { hiddenFromClient: hidden });
  revalidatePath("/transcripts");
  revalidatePath(`/transcripts/${id}`);
}

export async function ingestManualTranscriptAction(input: {
  title: string;
  participants: string;
  rawText: string;
}) {
  await requireStaff();
  const result = await ingestTranscript(
    {
      externalId: `manual-${Date.now()}`,
      title: input.title.trim() || "Pasted meeting",
      participants: input.participants.split(",").map((p) => p.trim()).filter(Boolean),
      text: input.rawText,
      date: Date.now(),
    },
    "manual",
  );
  revalidatePath("/transcripts");
  return result;
}

/**
 * Bulk-sync recent Fireflies transcripts. The @karoslabs.com invariant is applied inside
 * listFirefliesTranscripts — only agency-attended meetings are ever processed.
 * Deduplicates by externalId; transcripts already in Firestore are skipped.
 */
export async function syncFirefliesAction(): Promise<{ synced: number; skipped: number }> {
  await requireStaff();
  const headers = await listFirefliesTranscripts();
  let synced = 0;
  let skipped = 0;

  for (const h of headers) {
    const existing = await getTranscriptByExternalId(h.externalId);
    if (existing) {
      skipped++;
      continue;
    }
    const t = await fetchFirefliesTranscript(h.externalId);
    if (!t) { skipped++; continue; }
    const result = await ingestTranscript(t, "fireflies");
    if (result.clientId) {
      const stored = await getTranscript(result.id);
      if (stored) {
        try {
          await appendMeetingSignalToContextDoc(result.clientId, { ...stored, id: result.id });
          await updateTranscript(result.id, { contextDocSignalAt: Date.now() });
        } catch { /* Non-fatal */ }
      }
    }
    synced++;
  }

  revalidatePath("/transcripts");
  return { synced, skipped };
}

/**
 * Manually push a transcript as a meeting signal into the client's intel context docs.
 * Staff-only; shows as "Send to Intel" in the transcript detail UI.
 */
export async function updateTranscriptContextSignalAction(
  transcriptId: string,
  clientId: string,
): Promise<void> {
  await requireStaff();
  const t = await getTranscript(transcriptId);
  if (!t) throw new Error("Transcript not found");

  await appendMeetingSignalToContextDoc(clientId, { ...t, id: transcriptId });
  await updateTranscript(transcriptId, { clientId, assignment: "manual", contextDocSignalAt: Date.now() });
  revalidatePath("/transcripts");
  revalidatePath(`/transcripts/${transcriptId}`);
  revalidatePath(`/clients/${clientId}`);
}

export async function archiveTranscriptAction(id: string): Promise<void> {
  await requireStaff();
  await updateTranscript(id, { archived: true });
  revalidatePath("/transcripts");
  revalidatePath(`/transcripts/${id}`);
}

export async function unarchiveTranscriptAction(id: string): Promise<void> {
  await requireStaff();
  await updateTranscript(id, { archived: false });
  revalidatePath("/transcripts");
  revalidatePath(`/transcripts/${id}`);
}

/**
 * Persist a completion toggle for a single action item.
 * When all items are complete, automatically archives the meeting.
 */
export async function toggleActionItemCompletionAction(
  transcriptId: string,
  itemIndex: number,
  completed: boolean,
): Promise<{ allDone: boolean }> {
  const user = await getCurrentUser();
  if (!user || user.disabled) throw new Error("Unauthorized");

  const t = await getTranscript(transcriptId);
  if (!t) throw new Error("Transcript not found");

  if (user.role === "CLIENT_USER") {
    if (!user.clientId || t.clientId !== user.clientId) throw new Error("Forbidden");
  } else if (user.role !== "KAROS_ADMIN" && user.role !== "KAROS_EMPLOYEE") {
    throw new Error("Forbidden");
  }

  const completedSet = new Set(t.completedItems ?? []);
  if (completed) completedSet.add(itemIndex);
  else completedSet.delete(itemIndex);
  const completedItems = Array.from(completedSet);

  const total = t.actionItems?.length ?? 0;
  const validDone = completedItems.filter((i) => i >= 0 && i < total).length;
  const allDone = total > 0 && validDone >= total;
  const patch: Partial<Transcript> = { completedItems };
  if (allDone) patch.archived = true;

  await updateTranscript(transcriptId, patch);
  revalidatePath(`/transcripts/${transcriptId}`);
  if (allDone) revalidatePath("/transcripts");
  return { allDone };
}

/**
 * Reassign a single action item to a new owner name.
 * Rebuilds actionItemsByOwner snapshot from the updated owners array.
 */
export async function setActionItemOwnerAction(
  transcriptId: string,
  itemIndex: number,
  ownerName: string | null,
): Promise<void> {
  await requireStaff();
  const t = await getTranscript(transcriptId);
  if (!t) throw new Error("Transcript not found");

  const total = t.actionItems?.length ?? 0;
  const owners: (string | null)[] = t.actionItemOwners?.length === total
    ? [...t.actionItemOwners]
    : Array.from({ length: total }, (_, i) => {
        if (!t.actionItemsByOwner) return null;
        for (const [name, tasks] of Object.entries(t.actionItemsByOwner)) {
          if (tasks.includes(t.actionItems?.[i] ?? "")) return name === "Unassigned" ? null : name;
        }
        return null;
      });

  if (itemIndex >= 0 && itemIndex < owners.length) owners[itemIndex] = ownerName;
  const actionItemsByOwner = buildActionItemsByOwner(t.actionItems ?? [], owners);

  await updateTranscript(transcriptId, { actionItemOwners: owners, actionItemsByOwner });
  revalidatePath(`/transcripts/${transcriptId}`);
}

/**
 * Explicitly assign (or un-assign) a meeting action item to a user by their UID.
 */
export async function assignActionItemToUserAction(
  transcriptId: string,
  itemIndex: number,
  assignedUserId: string | null,
): Promise<void> {
  const viewer = await getCurrentUser();
  if (!viewer || viewer.disabled) throw new Error("Unauthorized");

  const t = await getTranscript(transcriptId);
  if (!t) throw new Error("Transcript not found");

  if (viewer.role === "CLIENT_USER") {
    if (t.clientId !== viewer.clientId) throw new Error("Forbidden");
    if (assignedUserId !== null && assignedUserId !== viewer.uid) throw new Error("Forbidden");
  }

  const items = t.actionItems ?? [];
  const len = items.length;

  const newOwners = [...(t.actionItemOwners ?? Array<null>(len).fill(null))];
  while (newOwners.length < len) newOwners.push(null);

  const newAssignedIds = [...(t.actionItemAssignedUserIds ?? Array<null>(len).fill(null))];
  while (newAssignedIds.length < len) newAssignedIds.push(null);

  if (assignedUserId === null) {
    newOwners[itemIndex] = null;
    newAssignedIds[itemIndex] = null;
  } else {
    const target = await getUser(assignedUserId);
    newOwners[itemIndex] = target?.name ?? target?.email ?? null;
    newAssignedIds[itemIndex] = assignedUserId;
  }

  const assignedUserIds = [...new Set(newAssignedIds.filter((id): id is string => id !== null))];

  await updateTranscript(transcriptId, {
    actionItemOwners: newOwners,
    actionItemAssignedUserIds: newAssignedIds,
    assignedUserIds,
  });

  revalidatePath(`/transcripts/${transcriptId}`);
}

/**
 * Dismiss a notification item from the bell by marking the action item as complete.
 * Only the user the item is assigned to may call this.
 */
export async function dismissAssignedActionItemAction(
  transcriptId: string,
  itemIndex: number,
): Promise<void> {
  const viewer = await getCurrentUser();
  if (!viewer || viewer.disabled) throw new Error("Unauthorized");

  const t = await getTranscript(transcriptId);
  if (!t) throw new Error("Transcript not found");

  if (t.actionItemAssignedUserIds?.[itemIndex] !== viewer.uid) {
    throw new Error("Not assigned to this item");
  }

  const completed = new Set(t.completedItems ?? []);
  completed.add(itemIndex);
  await updateTranscript(transcriptId, { completedItems: [...completed] });
}
