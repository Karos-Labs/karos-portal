"use server";

import { revalidatePath } from "next/cache";
import {
  upsertClientIntegration,
  deleteClientIntegration,
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
