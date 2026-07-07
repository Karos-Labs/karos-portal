"use server";

import { revalidatePath } from "next/cache";
import {
  upsertClientIntegration,
  deleteClientIntegration,
  setIntegrationAutoPublish,
  listAccessTokens,
  updateAccessToken,
} from "@/lib/data";
import { getCurrentUser } from "@/lib/auth";
import { issueAccessToken } from "@/lib/tokens";
import { requireStaff } from "./_shared";

/**
 * Save (create or overwrite) a social platform integration for a client.
 * Empty-string values are stripped before saving to avoid persisting blank fields.
 */
export async function saveIntegrationAction(
  clientId: string,
  platform: string,
  credentials: Record<string, string>,
  accountName?: string,
): Promise<void> {
  const user = await requireStaff();

  const cleaned: Record<string, string> = {};
  for (const [k, v] of Object.entries(credentials)) {
    if (v.trim()) cleaned[k] = v.trim();
  }

  await upsertClientIntegration({
    clientId,
    platform,
    credentials: cleaned,
    accountName: accountName?.trim() || undefined,
    method: "manual",
    connectedBy: user.uid,
    connectedAt: Date.now(),
    updatedAt: Date.now(),
  });

  revalidatePath(`/clients/${clientId}`);
}

/**
 * Toggle auto-publishing for a connected platform. Off ⇒ the publish cron skips
 * it and content goes out only via manual "Publish Now" (or stays a placeholder).
 * Clients may toggle their own integrations — opting out of automated posting is
 * their decision, not just staff's.
 */
export async function setIntegrationAutoPublishAction(
  clientId: string,
  platform: string,
  enabled: boolean,
): Promise<void> {
  const user = await getCurrentUser();
  if (!user || user.disabled) throw new Error("Unauthorized");
  const isStaff = user.role === "KAROS_ADMIN" || user.role === "KAROS_EMPLOYEE";
  if (!isStaff && user.clientId !== clientId) throw new Error("Forbidden");
  await setIntegrationAutoPublish(clientId, platform, enabled);
  revalidatePath(`/clients/${clientId}`);
}

/** Remove a platform integration and all stored credentials for a client. */
export async function deleteIntegrationAction(
  clientId: string,
  platform: string,
): Promise<void> {
  await requireStaff();
  await deleteClientIntegration(clientId, platform);
  revalidatePath(`/clients/${clientId}`);
}

/** Mint a personal access token for MCP clients. Returns the plaintext ONCE. */
export async function createAccessTokenAction(name: string) {
  const user = await requireStaff();
  const { id, token } = await issueAccessToken(user.uid, name);
  revalidatePath("/connect");
  return { id, token };
}

/** Revoke one of the caller's own tokens. */
export async function revokeAccessTokenAction(id: string) {
  const user = await requireStaff();
  const owned = await listAccessTokens(user.uid);
  if (!owned.some((t) => t.id === id)) throw new Error("Token not found");
  await updateAccessToken(id, { revoked: true });
  revalidatePath("/connect");
}
