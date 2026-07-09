"use server";

import { revalidatePath } from "next/cache";
import { creditClientCredits, setClientCreditLimits, getClient } from "@/lib/data";
import { requireAdmin } from "./_shared";

/**
 * NOTE: these actions return errors as data ({ error }) instead of throwing —
 * thrown server-action errors are masked in production builds, which would
 * hide the real cause from the admin UI.
 */

/**
 * Admin-only: add credits to (positive) or deduct credits from (negative) a
 * client's balance. Every change lands in the credit ledger with the actor.
 */
export async function adjustCreditsAction(
  clientId: string,
  amount: number,
  note?: string,
): Promise<{ ok: true; balance: number } | { ok: false; error: string }> {
  try {
    const admin = await requireAdmin();
    if (!Number.isFinite(amount) || !Number.isInteger(amount) || amount === 0) {
      return { ok: false, error: "Enter a non-zero whole number of credits" };
    }
    const client = await getClient(clientId);
    if (!client) return { ok: false, error: "Client not found" };

    const { balance } = await creditClientCredits({
      clientId,
      amount,
      kind: amount > 0 ? "grant" : "adjustment",
      operation: "manual",
      reason: note?.trim() || (amount > 0 ? "Credit grant" : "Credit adjustment"),
      actorUid: admin.uid,
      actorName: admin.name,
    });
    revalidatePath(`/clients/${clientId}/settings`);
    revalidatePath(`/clients/${clientId}`);
    return { ok: true, balance };
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : "Failed to update credits" };
  }
}

/**
 * Admin-only: set the weekly/monthly credit spend caps for a client.
 * Pass null to remove a cap.
 */
export async function setCreditLimitsAction(
  clientId: string,
  weeklyLimit: number | null,
  monthlyLimit: number | null,
): Promise<{ ok: true } | { ok: false; error: string }> {
  try {
    await requireAdmin();
    for (const limit of [weeklyLimit, monthlyLimit]) {
      if (limit != null && (!Number.isInteger(limit) || limit < 0)) {
        return { ok: false, error: "Limits must be whole numbers of credits (or empty for no cap)" };
      }
    }
    const client = await getClient(clientId);
    if (!client) return { ok: false, error: "Client not found" };

    await setClientCreditLimits(clientId, { weeklyLimit, monthlyLimit });
    revalidatePath(`/clients/${clientId}/settings`);
    return { ok: true };
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : "Failed to update limits" };
  }
}
