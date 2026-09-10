"use server";

import { randomUUID } from "node:crypto";
import { revalidatePath } from "next/cache";

import {
  getActionItem,
  getTranscript,
  getUser,
  updateActionItem,
} from "@/lib/data";
import {
  historyEntry,
  mirrorAssigneeToTranscript,
  mirrorStatusToTranscript,
  statusLabel,
} from "@/lib/action-items";
import { ACTION_ITEM_STATUSES } from "@/lib/constants";
import { syncActionItemAssignmentToJira } from "@/lib/integrations/jira";
import type { ActionItem, ActionItemComment, ActionItemStatus, AppUser } from "@/lib/types";
import { requireStaff } from "./_shared";

/**
 * Lifecycle actions for managed meeting action items (dashboard task view).
 *
 * Authorization is staff-wide (admin + employee) rather than admin-only so the
 * view can be opened to more roles later without touching the write path; the
 * dashboard panel itself is rendered for admins only. When client users are
 * eventually allowed in, swap requireStaff for a per-item access check against
 * item.clientId + visibleToClient.
 */
async function requireActionItem(id: string): Promise<{ actor: AppUser; item: ActionItem }> {
  const actor = await requireStaff();
  const item = await getActionItem(id);
  if (!item) throw new Error("Action item not found");
  return { actor, item };
}

function revalidateFor(item: ActionItem): void {
  revalidatePath("/dashboard");
  revalidatePath(`/transcripts/${item.transcriptId}`);
}

/** Change the lifecycle status (Open / In Progress / In Review / Done). */
export async function setActionItemStatusAction(
  id: string,
  status: ActionItemStatus,
): Promise<void> {
  if (!ACTION_ITEM_STATUSES.includes(status)) throw new Error("Invalid status");
  const { actor, item } = await requireActionItem(id);
  if (item.status === status) return;

  await updateActionItem(id, {
    status,
    updatedAt: Date.now(),
    history: [
      ...item.history,
      historyEntry(
        "status_changed",
        `Status changed from ${statusLabel(item.status)} to ${statusLabel(status)} by ${actor.name}`,
        { id: actor.uid, name: actor.name },
      ),
    ],
  });

  // Keep the source meeting's checkboxes in step. Non-fatal.
  try {
    const t = await getTranscript(item.transcriptId);
    if (t) await mirrorStatusToTranscript(t, item.sourceIndex, status);
  } catch { /* Non-fatal — the managed doc is authoritative for the dashboard */ }

  revalidateFor(item);
}

/** Hand the item over to another team member (or unassign with null). */
export async function reassignActionItemAction(
  id: string,
  assigneeUserId: string | null,
): Promise<void> {
  const { actor, item } = await requireActionItem(id);
  if ((item.assigneeUserId ?? null) === assigneeUserId) return;

  let assignee: { userId: string; name: string } | null = null;
  let target: AppUser | null = null;
  if (assigneeUserId) {
    target = await getUser(assigneeUserId);
    if (!target || target.disabled) throw new Error("Target user not found");
    assignee = { userId: assigneeUserId, name: target.name ?? target.email };
  }

  const detail = assignee
    ? item.assigneeName
      ? `Reassigned from ${item.assigneeName} to ${assignee.name} by ${actor.name}`
      : `Assigned to ${assignee.name} by ${actor.name}`
    : `Unassigned by ${actor.name}`;
  const reassignedEntry = historyEntry("reassigned", detail, { id: actor.uid, name: actor.name });

  await updateActionItem(id, {
    assigneeUserId: assignee?.userId ?? null,
    assigneeName: assignee?.name ?? null,
    updatedAt: Date.now(),
    history: [...item.history, reassignedEntry],
  });

  // Keep the source meeting's owner arrays and the notification bell in step. Non-fatal.
  try {
    const t = await getTranscript(item.transcriptId);
    if (t) await mirrorAssigneeToTranscript(t, item.sourceIndex, assignee);
    if (assignee && target) {
      const jira = await syncActionItemAssignmentToJira(item, assignee.userId, target.email);
      if (jira) {
        await updateActionItem(id, {
          ...jira,
          history: [
            ...item.history,
            reassignedEntry,
            historyEntry("jira_linked", `Linked to Jira issue ${jira.jiraIssueKey}`, { id: "system", name: "Jira sync" }),
          ],
        });
      }
    }
  } catch { /* Non-fatal */ }

  revalidateFor(item);
}

/** Leave a comment/note on the item. Returns the persisted comment. */
export async function addActionItemCommentAction(
  id: string,
  text: string,
): Promise<ActionItemComment> {
  const { actor, item } = await requireActionItem(id);
  const trimmed = text.trim();
  if (!trimmed) throw new Error("Comment cannot be empty");
  if (trimmed.length > 4000) throw new Error("Comment is too long");

  const comment: ActionItemComment = {
    id: randomUUID(),
    authorId: actor.uid,
    authorName: actor.name,
    text: trimmed,
    createdAt: Date.now(),
  };

  await updateActionItem(id, {
    comments: [...item.comments, comment],
    updatedAt: Date.now(),
    history: [
      ...item.history,
      historyEntry("comment_added", `Comment added by ${actor.name}`, { id: actor.uid, name: actor.name }),
    ],
  });

  revalidateFor(item);
  return comment;
}
