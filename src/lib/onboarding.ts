import type { AppUser } from "@/lib/types";

/**
 * The 2-step wizard (personal profile + workspace setup) only ever applies to
 * CLIENT_USER accounts created after this field shipped — `hasCompletedOnboarding`
 * is explicitly set to `false` at creation (see auth.ts, user-actions.ts). Any
 * other value (`true`, or absent for pre-existing accounts and all staff) skips it.
 */
export function needsOnboarding(user: Pick<AppUser, "role" | "hasCompletedOnboarding">): boolean {
  return user.role === "CLIENT_USER" && user.hasCompletedOnboarding === false;
}

/**
 * The (app) layout's actual gate decision. Staff "viewing as" a client
 * (`isImpersonating`) must land on the real dashboard, never get funneled into —
 * and stuck in — that client's onboarding wizard just because the client
 * themselves hasn't finished it yet.
 */
export function shouldBlockForOnboarding(ctx: {
  isImpersonating: boolean;
  user: Pick<AppUser, "role" | "hasCompletedOnboarding">;
}): boolean {
  return !ctx.isImpersonating && needsOnboarding(ctx.user);
}
