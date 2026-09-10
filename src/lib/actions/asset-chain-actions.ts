"use server";

import { revalidatePath } from "next/cache";
import { reflowClientChain } from "@/lib/chain";
import { requireStaff } from "./_shared";

/**
 * Staff "Re-plan calendar" recovery action.
 *
 * Re-runs the content chain for one client, re-dating its unposted chain drafts
 * one-per-day in internal generation order (published/staff-booked items stay
 * pinned). This is the manual recovery path for when the best-effort reflow
 * that fires after a lab import or an agent-service webhook did not run — a
 * failed reflow leaves the new posts undated until this action (or the next
 * import/webhook) re-plans them.
 *
 * requireStaff: chain dates are a staff-controlled surface — clients never
 * trigger a reflow. Returns `{ error }` rather than throwing so the calling UI
 * can render the failure inline.
 */
export async function reflowClientCalendarAction(
  clientId: string,
): Promise<{ changed?: number; error?: string }> {
  try {
    await requireStaff();
    if (!clientId || typeof clientId !== "string") {
      return { error: "A client id is required." };
    }
    const { changed } = await reflowClientChain(clientId);
    revalidatePath(`/clients/${clientId}`);
    revalidatePath("/assets");
    return { changed };
  } catch (e) {
    return { error: e instanceof Error ? e.message : "Re-plan failed." };
  }
}
