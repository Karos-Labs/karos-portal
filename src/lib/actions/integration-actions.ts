"use server";

import { revalidatePath } from "next/cache";
import {
  upsertClientIntegration,
  listClientIntegrations,
  deleteClientIntegration,
  setIntegrationAutoPublish,
  setIntegrationAgentAutoPublish,
  listAccessTokens,
  updateAccessToken,
} from "@/lib/data";
import { PLATFORM_REGISTRY } from "@/lib/integrations/platforms";
import { forgetRefreshedCredentials } from "@/lib/integrations/token-refresh";
import { getCurrentUser } from "@/lib/auth";
import { issueAccessToken } from "@/lib/tokens";
import { autoCompleteTasksOnIntegrationConnect } from "@/lib/task-sync";
import { fetchMetaBusinessAccounts, type MetaBusinessAccount } from "@/lib/integrations/meta-business";
import {
  fetchInstagramBusinessAccountInsights,
  type InstagramBusinessAccountInsights,
} from "@/lib/integrations/instagram-business-graph";
import { requireStaff, staffAssignmentRefusal } from "./_shared";

/**
 * Save (create or overwrite) a social platform integration for a client.
 * Empty-string values are stripped before saving to avoid persisting blank fields.
 *
 * A blank password field means "keep the stored secret": secrets never reach the
 * browser, so the form cannot send back what it was not given, and the carry-over
 * happens here. The write is a full overwrite, hence the explicit re-merge.
 *
 * The carry-over list is NOT just the registry's password fields. `refreshToken`
 * and `expiresAt` are OAuth bookkeeping the callback writes and no form renders:
 * X, Instagram and LinkedIn declare only `accessToken`, and `expiresAt` is
 * declared by nobody, so rebuilding the map from registry fields alone would
 * drop them. Dropping them disables CN1's refresh for that channel — for Meta
 * permanently, since the long-lived re-exchange is scheduled off `expiresAt` and
 * a token with no expiry on record is never re-exchanged, so the 60-day token
 * dies and the forced refresh at its 401 is already too late.
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

  const carriedKeys = new Set(
    (PLATFORM_REGISTRY.find((p) => p.id === platform)?.fields ?? [])
      .filter((f) => f.type === "password")
      .map((f) => f.key),
  );
  carriedKeys.add("refreshToken");
  carriedKeys.add("expiresAt");
  const existing = (await listClientIntegrations(clientId)).find((i) => i.platform === platform);
  for (const key of carriedKeys) {
    const stored = existing?.credentials?.[key];
    if (!cleaned[key] && stored) cleaned[key] = stored;
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
    if (await staffAssignmentRefusal(user, clientId)) {
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
 * Toggle whether this client's approved X/LinkedIn agent drafts publish
 * straight through the OAuth publisher THE INSTANT they are approved,
 * instead of waiting for a human to click the draft's own Publish Now
 * button (see ClientIntegration.agentAutoPublish — TIMING only, the button
 * itself is on every draft either way). Same access rule and error-as-data
 * shape as setIntegrationAutoPublishAction — a client may opt their own
 * channel in or out, same as they can for the scheduled-content toggle.
 */
export async function setIntegrationAgentAutoPublishAction(
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
    if (await staffAssignmentRefusal(user, clientId)) {
      return { error: "You don't have access to this channel." };
    }
    await setIntegrationAgentAutoPublish(clientId, platform, enabled);
    revalidatePath(`/clients/${clientId}`);
    return { ok: true };
  } catch {
    return { error: "Couldn't change agent auto-publish. Please try again." };
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
      return { error: "Only your Karos team can disconnect a channel. Message us and we'll do it." };
    }
    await deleteClientIntegration(clientId, platform);
    // Disconnecting has to mean the tokens are gone, not just the Firestore doc:
    // the refresh path keeps a decrypted copy in memory to bridge a cron tick,
    // and a long-lived instance would otherwise hold it past the disconnect.
    forgetRefreshedCredentials(clientId, platform);
    revalidatePath(`/clients/${clientId}`);
    return { ok: true };
  } catch {
    return { error: "Couldn't disconnect this channel. Please try again." };
  }
}

/**
 * Mint a personal access token for MCP clients. Returns the plaintext ONCE.
 *
 * No page revalidation: the one surface that rendered a staff member's token
 * list (`/connect`) is gone (2026-08). The MCP auth path these tokens serve
 * (`src/lib/mcp/auth.ts`) is unaffected — this is only the admin UI for
 * managing them, and this action stays as the write API a future surface
 * would call.
 */
export async function createAccessTokenAction(name: string) {
  const user = await requireStaff();
  const { id, token } = await issueAccessToken(user.uid, name);
  return { id, token };
}

/** Revoke one of the caller's own tokens. */
export async function revokeAccessTokenAction(id: string) {
  const user = await requireStaff();
  const owned = await listAccessTokens(user.uid);
  if (!owned.some((t) => t.id === id)) throw new Error("Token not found");
  await updateAccessToken(id, { revoked: true });
}

export type BusinessInfoResult = { ok: true; accounts: MetaBusinessAccount[] } | { error: string };

/**
 * The Business Manager accounts the client's connected Instagram user
 * administers — `business_management`, read via the same per-client OAuth
 * token the "instagram" card already stores (see oauth.ts / meta-business.ts).
 * Same access rule as setIntegrationAutoPublishAction: staff, or the client
 * viewing their own data.
 */
export async function fetchClientBusinessInfoAction(clientId: string): Promise<BusinessInfoResult> {
  try {
    const user = await getCurrentUser();
    if (!user || user.disabled) return { error: "Please sign in again to view business info." };
    const isStaff = user.role === "KAROS_ADMIN" || user.role === "KAROS_EMPLOYEE";
    if (!isStaff && user.clientId !== clientId) {
      return { error: "You don't have access to this channel." };
    }
    if (await staffAssignmentRefusal(user, clientId)) {
      return { error: "You don't have access to this channel." };
    }
    const integration = (await listClientIntegrations(clientId)).find((i) => i.platform === "instagram");
    const token = integration?.credentials?.accessToken;
    if (!token) return { error: "Connect Instagram first to see business info." };
    const accounts = await fetchMetaBusinessAccounts(token);
    return { ok: true, accounts };
  } catch {
    return { error: "Couldn't load business info. Please try again." };
  }
}

export type InstagramBusinessInsightsResult =
  | { ok: true; insights: InstagramBusinessAccountInsights }
  | { error: string };

/**
 * Account-level insights (reach, profile views) via the "instagram_business"
 * card's own Instagram-Login token — `instagram_business_manage_insights`,
 * against graph.instagram.com (see instagram-business-graph.ts). Same access
 * rule as the other read actions on this file.
 */
export async function fetchClientInstagramBusinessInsightsAction(
  clientId: string,
): Promise<InstagramBusinessInsightsResult> {
  try {
    const user = await getCurrentUser();
    if (!user || user.disabled) return { error: "Please sign in again to view insights." };
    const isStaff = user.role === "KAROS_ADMIN" || user.role === "KAROS_EMPLOYEE";
    if (!isStaff && user.clientId !== clientId) {
      return { error: "You don't have access to this channel." };
    }
    if (await staffAssignmentRefusal(user, clientId)) {
      return { error: "You don't have access to this channel." };
    }
    const integration = (await listClientIntegrations(clientId)).find((i) => i.platform === "instagram_business");
    const token = integration?.credentials?.accessToken;
    if (!token) return { error: "Connect Instagram (direct login) first to see insights." };
    const insights = await fetchInstagramBusinessAccountInsights(token);
    return { ok: true, insights };
  } catch {
    return { error: "Couldn't load insights. Please try again." };
  }
}
