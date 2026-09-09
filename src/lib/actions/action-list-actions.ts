"use server";

import { revalidatePath } from "next/cache";
import { upsertClientActionState } from "@/lib/data";
import { requireUser } from "@/lib/auth";
import { ACTION_DEFINITIONS } from "@/lib/action-list";
import { SETUP_LADDER_HIDDEN_ACTION_ID } from "@/lib/setup-ladder";

/**
 * Self-service, same auth shape as `updateClientProfileAction` — a CLIENT_USER
 * may act on their own client's action list, staff may act on any client's
 * (View as Client at onboarding, or clearing one up on a support call).
 */
async function authorize(clientId: string): Promise<{ ok: true } | { ok: false; error: string }> {
  const user = await requireUser();
  const isStaff = user.role === "KAROS_ADMIN" || user.role === "KAROS_EMPLOYEE";
  if (!isStaff && !(user.role === "CLIENT_USER" && user.clientId === clientId)) {
    return { ok: false, error: "Not authorized to edit this client's actions." };
  }
  return { ok: true };
}

/**
 * The ids these actions will write a row for.
 *
 * `ACTION_DEFINITIONS` plus ONE reserved id (portal feedback round 4, 2026-09):
 * the setup ladder's "Hide this", which stores the client's dismissal of the
 * finished "Get set up" card. It is not an `ACTION_DEFINITIONS` row because it
 * has no label, no href and no place in any list — it is a per-client flag that
 * happens to want exactly the storage, authorization and permanence
 * `markActionNotRelevantAction` already provides. Allow-listed by name rather
 * than by loosening the check, so an unknown id is still refused.
 */
function isKnownAction(actionId: string): boolean {
  if (actionId === SETUP_LADDER_HIDDEN_ACTION_ID) return true;
  return ACTION_DEFINITIONS.some((a) => a.id === actionId);
}

/**
 * "Dismiss it and it comes back later" — the temporary half of the locked
 * decision's two dismissal mechanisms. Rotates back into the queue after
 * ACTION_DISMISS_COOLDOWN_MS (lib/action-list.ts).
 */
export async function dismissActionAction(
  clientId: string,
  actionId: string,
): Promise<{ ok: true } | { ok: false; error: string }> {
  const auth = await authorize(clientId);
  if (!auth.ok) return auth;
  if (!isKnownAction(actionId)) return { ok: false, error: "Unknown action." };
  await upsertClientActionState(clientId, actionId, "dismissed");
  revalidatePath(`/clients/${clientId}`);
  return { ok: true };
}

/**
 * "Mark it not relevant for me and it does not [come back]" — permanent.
 * This is the ONLY skip in the portal that is irreversible from the client's
 * own side (the locked decision: "the only thing in the portal a client can
 * skip"), which is why there is no un-mark action here — reversing it, if
 * ever needed, is a staff action against the same row, not a client one.
 */
export async function markActionNotRelevantAction(
  clientId: string,
  actionId: string,
): Promise<{ ok: true } | { ok: false; error: string }> {
  const auth = await authorize(clientId);
  if (!auth.ok) return auth;
  if (!isKnownAction(actionId)) return { ok: false, error: "Unknown action." };
  await upsertClientActionState(clientId, actionId, "not_relevant");
  revalidatePath(`/clients/${clientId}`);
  return { ok: true };
}

/**
 * For the event-tracked actions ONLY (lib/action-list.ts's
 * EVENT_TRACKED_ACTION_IDS) — the ones with no live signal to compute "done"
 * from, so completion is a row written the moment the real event happens
 * (a calendar visit, a saved instruction, a sent piece of feedback). Calling
 * this for a live-signal action is harmless (computeActionDone still wins on
 * the next read — see resolveActionList) but pointless, so callers should
 * only ever reach for it from the three real event sites.
 */
export async function markActionDoneAction(
  clientId: string,
  actionId: string,
): Promise<{ ok: true } | { ok: false; error: string }> {
  const auth = await authorize(clientId);
  if (!auth.ok) return auth;
  if (!isKnownAction(actionId)) return { ok: false, error: "Unknown action." };
  await upsertClientActionState(clientId, actionId, "done");
  revalidatePath(`/clients/${clientId}`);
  return { ok: true };
}
