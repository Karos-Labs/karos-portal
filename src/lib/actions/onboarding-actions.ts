"use server";

import { after } from "next/server";
import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import { logGenerationFailure, ownAccountSession, requireFirstOnboarding } from "./_shared";
import {
  upsertUser,
  completeOnboarding,
  clearUserPhone,
  tryAcquireAiProcessingLock,
  releaseAiProcessingLock,
  updateClient,
} from "@/lib/data";
import { adminAuth } from "@/lib/firebase/admin";
import { clampClientCategoryValue } from "@/lib/utils";
import { addEmployeeSeatAction } from "./seat-actions";

/** Step 1 — persisted on "Next" (and before any LinkedIn OAuth redirect) so no
 * draft state is lost on the full-page round trip. */
export async function saveOnboardingProfileAction(input: { name: string; phone?: string }): Promise<void> {
  // These three actions each wrote the impersonation rule out inline, with
  // three sentences between them, while five sibling self-writes (the profile
  // action, the password change, and the avatar and resume routes) did not
  // write it at all. One rule, one sentence — see IMPERSONATED_SELF_WRITE_MESSAGE.
  const session = await ownAccountSession();
  if (!session.ok) throw new Error(session.error);
  const { user } = session;
  const name = input.name.trim();
  if (!name) throw new Error("Name cannot be empty.");
  if (name.length > 100) throw new Error("Name is too long (max 100 characters).");

  const phone = input.phone?.trim();
  await upsertUser({ ...user, name, ...(phone ? { phone } : {}) });
  if (!phone && user.phone) await clearUserPhone(user.uid);
  await adminAuth().updateUser(user.uid, { displayName: name }).catch(() => {});
  revalidatePath("/onboarding");
}

/**
 * Registers the current user as their workspace's primary LinkedIn employee-advocacy
 * seat, reusing the standard seat pipeline (monetization gate included). Idempotent —
 * returns the existing seat if "Connect LinkedIn" is clicked more than once.
 */
export async function ensureOwnEmployeeSeatAction(): Promise<{ seatId: string } | { error: string }> {
  // The `{ error }` form of the same gate — this action returns rather than
  // throws, so it takes the result shape instead of the throwing wrapper.
  const session = await ownAccountSession();
  if (!session.ok) return { error: session.error };
  const { user } = session;
  if (user.role !== "CLIENT_USER" || !user.clientId) return { error: "Forbidden" };
  if (user.primarySeatId) return { seatId: user.primarySeatId };

  const result = await addEmployeeSeatAction(user.clientId, {
    employeeName: user.name,
    employeeEmail: user.email,
    resumeUrl: user.resumeUrl ?? null,
  });
  if (!result.ok || !result.seatId) {
    return { error: !result.ok ? result.error : "Could not create your employee seat." };
  }

  await upsertUser({ ...user, primarySeatId: result.seatId });
  return { seatId: result.seatId };
}

/**
 * Step 2 "Finish Setup" — persists the final profile fields, flips
 * hasCompletedOnboarding + the workspace patch in one transaction, then redirects.
 */
export async function completeOnboardingAction(input: {
  name: string;
  phone?: string;
  clientName: string;
  /**
   * The wizard's "Industry / niche" box. It writes `category` — the ONE field
   * behind the profile chip — and not the legacy `industry` it used to, so a
   * client's very first answer lands where their own editor will find it.
   */
  category?: string;
  brandVoice?: string;
}): Promise<void> {
  const session = await ownAccountSession();
  if (!session.ok) throw new Error(session.error);
  const { user } = session;
  if (user.role !== "CLIENT_USER" || !user.clientId) throw new Error("Forbidden");
  // The gate that makes the free AI provisioning below affordable: this may run
  // once per account. Until now only the (app) layout's redirect enforced that,
  // and a redirect does not gate a server action.
  await requireFirstOnboarding(user);

  const name = input.name.trim();
  if (!name) throw new Error("Name cannot be empty.");
  const clientName = input.clientName.trim();
  if (!clientName) throw new Error("Company name is required.");

  const phone = input.phone?.trim();
  await upsertUser({ ...user, name, ...(phone ? { phone } : {}) });
  if (!phone && user.phone) await clearUserPhone(user.uid);
  await adminAuth().updateUser(user.uid, { displayName: name }).catch(() => {});

  // Clamped on the way in, like every other write to this field: the chip that
  // will show it has one line, whichever form typed it.
  const category = clampClientCategoryValue(input.category);
  await completeOnboarding(user.uid, user.clientId, {
    name: clientName,
    category: category || undefined,
    brandVoice: input.brandVoice?.trim() || undefined,
  });

  // Fire-and-forget: build the client's Intel Report + SEO/GEO + Task Map from
  // the freshly-entered workspace details so they land in a tailored workspace
  // without waiting on staff or a cron. `after()` runs once this response has
  // been sent, so "Finish Setup" redirects instantly regardless of how long the
  // pipeline takes. Guarded by the shared AI-processing lock so it can never
  // overlap a manual Regenerate / Refresh Task Map click (or a duplicate
  // "Finish Setup" submission) for the same client.
  const clientId = user.clientId;
  const createdBy = user.uid;
  after(async () => {
    if (!(await tryAcquireAiProcessingLock(clientId))) return;
    let failure: string | undefined;
    try {
      const { runIntelReportPipeline } = await import("@/lib/intel");
      const { buildSwarmContext, runSwarmToCompletion } = await import("@/lib/agent-swarm");
      await runIntelReportPipeline(clientId);
      await updateClient(clientId, { lastIntelReportAt: Date.now() });
      const context = await buildSwarmContext(clientId);
      await runSwarmToCompletion({ clientId, createdBy, context });
    } catch (e) {
      failure = e instanceof Error ? e.message : String(e);
      console.error("[onboarding] Post-onboarding AI generation failed:", e);
    } finally {
      // Passing `failure` here (undefined on success) both releases the lock and
      // persists WHY it failed — e.g. an out-of-credits error — so the UI can
      // show the reason instead of the run just silently vanishing, and so
      // Regenerate/Refresh Task Map are usable again the moment this exits.
      await releaseAiProcessingLock(clientId, failure);
      await logGenerationFailure(clientId, failure);
    }
  });

  revalidatePath("/dashboard");
  revalidatePath(`/clients/${user.clientId}/settings`);
  redirect("/dashboard");
}
