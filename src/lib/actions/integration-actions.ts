"use server";

import { revalidatePath } from "next/cache";
import {
  upsertClientIntegration,
  listClientIntegrations,
  deleteClientIntegration,
  setIntegrationAutoPublish,
  listAccessTokens,
  updateAccessToken,
} from "@/lib/data";
import { PLATFORM_REGISTRY } from "@/lib/integrations/platforms";
import { getCurrentUser } from "@/lib/auth";
import { issueAccessToken } from "@/lib/tokens";
import { autoCompleteTasksOnIntegrationConnect } from "@/lib/task-sync";
import { requireStaff } from "./_shared";

/**
 * Save (create or overwrite) a social platform integration for a client.
 * Empty-string values are stripped before saving to avoid persisting blank fields.
 *
 * A blank password field means "keep the stored secret": secrets never reach the
 * browser, so the form cannot send back what it was not given, and the carry-over
 * happens here. The write is a full overwrite, hence the explicit re-merge.
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

  const secretKeys = (PLATFORM_REGISTRY.find((p) => p.id === platform)?.fields ?? [])
    .filter((f) => f.type === "password")
    .map((f) => f.key);
  if (secretKeys.length > 0) {
    const existing = (await listClientIntegrations(clientId)).find((i) => i.platform === platform);
    for (const key of secretKeys) {
      const stored = existing?.credentials?.[key];
      if (!cleaned[key] && stored) cleaned[key] = stored;
    }
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

  // Task Map sync: connecting the platform completes any matching
  // "Connect <platform>" onboarding task without a manual drag.
  await autoCompleteTasksOnIntegrationConnect(clientId, platform).catch(() => {});

  revalidatePath(`/clients/${clientId}`);
  revalidatePath("/tasks");
}

/**
 * NOTE: the two card-control actions below return errors as data ({ error })
 * instead of throwing. Thrown server-action errors are MASKED in production —
 * Next replaces the message with an opaque digest — so a refusal that throws
 * reaches the browser as unreadable boilerplate. The integrations card renders
 * these strings to clients, so the message has to survive the boundary and has
 * to be written for a client to read. Same convention as credit-actions.ts.
 */
export type IntegrationActionResult = { ok: true; error?: never } | { ok?: never; error: string };

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
): Promise<IntegrationActionResult> {
  try {
    const user = await getCurrentUser();
    if (!user || user.disabled) return { error: "Please sign in again to change this setting." };
    const isStaff = user.role === "KAROS_ADMIN" || user.role === "KAROS_EMPLOYEE";
    if (!isStaff && user.clientId !== clientId) {
      return { error: "You don't have access to this channel." };
    }
    await setIntegrationAutoPublish(clientId, platform, enabled);
    revalidatePath(`/clients/${clientId}`);
    return { ok: true };
  } catch {
    return { error: "Couldn't change auto-publish. Please try again." };
  }
}

/**
 * Remove a platform integration and all stored credentials for a client.
 * Staff-only — a client disconnecting their own channel would orphan the
 * agents publishing to it, so this stays an agency operation.
 */
export async function deleteIntegrationAction(
  clientId: string,
  platform: string,
): Promise<IntegrationActionResult> {
  try {
    const user = await getCurrentUser();
    if (!user || user.disabled) return { error: "Please sign in again to disconnect this channel." };
    if (user.role !== "KAROS_ADMIN" && user.role !== "KAROS_EMPLOYEE") {
      return { error: "Only your Karos team can disconnect a channel — message us and we'll do it." };
    }
    await deleteClientIntegration(clientId, platform);
    revalidatePath(`/clients/${clientId}`);
    return { ok: true };
  } catch {
    return { error: "Couldn't disconnect this channel. Please try again." };
  }
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
