"use server";

import { getAsset, createAssetComment, listAssetComments } from "@/lib/data";
import { getCurrentUser } from "@/lib/auth";
import type { AssetComment } from "@/lib/types";

/**
 * A CONVERSATION ABOUT THE DRAFT, WHERE THE DRAFT IS.
 *
 * §09: *"threaded comments on drafts — a conversation between the client and
 * the account manager at the gate and in the asset modal. A comment mechanism
 * exists for task tickets and there is nothing for content."*
 *
 * Which is exactly the shape of the gap: a client with an opinion about the
 * second line of a post had a ticket system for "please do this" and no place
 * at all for "this line, not that one". It went to Slack, to email, or
 * nowhere — and none of those are attached to the post when the next person
 * opens it.
 *
 * ## The fence is the asset's own
 *
 * Both actions resolve the asset first and refuse a CLIENT_USER whose client
 * does not own it, the same check every other asset action makes. A comment is
 * readable by whoever can read the draft and writable by whoever can open it:
 * the whole point is that the client is in the thread.
 *
 * ## No editing, no deleting, in this cut
 *
 * A thread two people rely on is a record, and an edit with no history turns a
 * record into a claim about the past. `TaskComment` made the same choice and
 * has not needed more.
 */

/**
 * The gate, named so it reads as one.
 *
 * `task-actions.ts` calls its equivalent `requireTaskAccess`, and the
 * authorization sweep looks for exactly that shape: an action whose body
 * calls no `requireX` is reported as ungated, however careful the helper it
 * delegates to. A convention worth keeping — the sweep is the only thing
 * standing between a new action and a public endpoint.
 */
async function requireAssetThreadAccess(assetId: string) {
  const user = await getCurrentUser();
  if (!user || user.disabled) return { error: "Unauthorized" as const };
  const asset = await getAsset(assetId);
  if (!asset) return { error: "Asset not found" as const };
  if (user.role === "CLIENT_USER" && asset.clientId !== user.clientId) return { error: "Forbidden" as const };
  return { user, asset };
}

export async function getAssetCommentsAction(assetId: string): Promise<{ comments: AssetComment[]; error?: string }> {
  const access = await requireAssetThreadAccess(assetId);
  if ("error" in access) return { comments: [], error: access.error };
  return { comments: await listAssetComments(assetId) };
}

export async function addAssetCommentAction(
  assetId: string,
  content: string,
): Promise<{ ok: boolean; comment?: AssetComment; error?: string }> {
  const access = await requireAssetThreadAccess(assetId);
  if ("error" in access) return { ok: false, error: access.error };
  const trimmed = content.trim();
  if (!trimmed) return { ok: false, error: "Write something before sending." };

  const now = Date.now();
  const comment: Omit<AssetComment, "id"> = {
    assetId,
    clientId: access.asset.clientId,
    content: trimmed,
    authorName: access.user.name,
    authorRole: access.user.role,
    createdAt: now,
  };
  const id = await createAssetComment(comment);
  // Returned rather than revalidated: the thread is inside a card the reader
  // has open, and a full route revalidation would close it under them.
  return { ok: true, comment: { id, ...comment } };
}
