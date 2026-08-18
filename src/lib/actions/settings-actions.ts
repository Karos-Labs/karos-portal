"use server";

import { revalidatePath } from "next/cache";
import { requireUser } from "@/lib/auth";
import { upsertClientSettings } from "@/lib/data";

/**
 * Toggle the client's auto-scheduling opt-in flag. This controls whether
 * approvals and chain-assigned scheduling may mark drafts as publishMode="auto".
 */
export async function updateAutoScheduleAction(
  clientId: string,
  enabled: boolean,
): Promise<{ ok: boolean; error?: string }> {
  const user = await requireUser();
  if (user.role === "CLIENT_USER" && user.clientId !== clientId) {
    return { ok: false, error: "Forbidden" };
  }

  // Persist the toggle.
  await upsertClientSettings(clientId, { autoScheduleEnabled: enabled, updatedAt: Date.now() });
  // Revalidate settings and calendar surfaces so the UI updates promptly.
  revalidatePath(`/clients/${clientId}`);
  revalidatePath(`/clients/${clientId}/settings`);
  revalidatePath(`/assets`);
  return { ok: true };
}
