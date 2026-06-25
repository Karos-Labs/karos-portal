import "server-only";

import { cookies } from "next/headers";
import { redirect } from "next/navigation";
import { adminAuth } from "@/lib/firebase/admin";
import { getUser, upsertUser, countUsers } from "@/lib/data";
import type { AppUser, Role } from "@/lib/types";

export const SESSION_COOKIE = "karos_session";
export const IMPERSONATE_COOKIE = "karos_impersonate";

const SESSION_MAX_AGE = 60 * 60 * 24 * 14; // 14 days (seconds)
const IMPERSONATE_MAX_AGE = 60 * 60 * 4;   // 4 hours (seconds)

function adminEmails(): string[] {
  return (process.env.ADMIN_EMAILS ?? "")
    .split(",")
    .map((e) => e.trim().toLowerCase())
    .filter(Boolean);
}

/** Exchange a Firebase ID token for a long-lived session cookie. */
export async function createSession(idToken: string): Promise<void> {
  const expiresIn = SESSION_MAX_AGE * 1000;
  const sessionCookie = await adminAuth().createSessionCookie(idToken, { expiresIn });
  const store = await cookies();
  store.set(SESSION_COOKIE, sessionCookie, {
    httpOnly: true,
    secure: process.env.NODE_ENV === "production",
    sameSite: "lax",
    path: "/",
    maxAge: SESSION_MAX_AGE,
  });
}

export async function clearSession(): Promise<void> {
  const store = await cookies();
  store.delete(SESSION_COOKIE);
  store.delete(IMPERSONATE_COOKIE);
}

/** What a person selected on the self-signup form. Advisory until an admin approves. */
export interface SignupIntent {
  requestedRole?: "employee" | "client";
  /** Company/brand name a client typed (used to seed a Client record on approval). */
  clientName?: string;
}

/**
 * Ensure a Firestore user doc exists for an authenticated identity.
 * Bootstrap rule: the first-ever user, or any email in ADMIN_EMAILS, becomes an admin
 * (active immediately). Everyone else lands disabled & pending until an admin approves them
 * from the Registrations tab. `intent` (signup-form choices) only applies on first creation.
 */
async function ensureUserDoc(
  claims: { uid: string; email?: string; name?: string; picture?: string },
  intent?: SignupIntent,
): Promise<AppUser> {
  const existing = await getUser(claims.uid);
  const email = (claims.email ?? "").toLowerCase();
  if (existing) {
    if (existing.email !== email && email) {
      await upsertUser({ ...existing, email });
    }
    return existing;
  }

  const isAdminEmail = adminEmails().includes(email);
  const isFirstUser = (await countUsers()) === 0;
  const bootstrap = isAdminEmail || isFirstUser;
  const requested = intent?.requestedRole;
  const role: Role = bootstrap ? "admin" : requested ?? "employee";

  const user: AppUser = {
    uid: claims.uid,
    email,
    name: claims.name || email.split("@")[0] || "New user",
    role,
    photoURL: claims.picture ?? null,
    clientId: null,
    assignedClientIds: [],
    requestedRole: bootstrap ? undefined : requested,
    requestedClientName:
      !bootstrap && requested === "client" ? intent?.clientName?.trim() || "" : undefined,
    disabled: !bootstrap,
    approvedAt: bootstrap ? Date.now() : null,
    createdAt: Date.now(),
    lastLoginAt: Date.now(),
  };
  await upsertUser(user);
  return user;
}

/**
 * Provision (or no-op for an existing) user doc straight after signup, attaching the
 * signup-form intent. Called by the session route so the role/company choice is recorded
 * synchronously rather than racing the first `getCurrentUser()`.
 */
export async function provisionFromSignup(idToken: string, intent: SignupIntent): Promise<void> {
  const decoded = await adminAuth().verifyIdToken(idToken);
  await ensureUserDoc(
    {
      uid: decoded.uid,
      email: decoded.email,
      name: (decoded.name as string) || undefined,
      picture: (decoded.picture as string) || undefined,
    },
    intent,
  );
}

/**
 * Read and verify the real session cookie — never considers impersonation.
 * Used internally by impersonation functions to confirm the caller is an admin.
 */
async function getSessionUser(): Promise<AppUser | null> {
  const store = await cookies();
  const cookie = store.get(SESSION_COOKIE)?.value;
  if (!cookie) return null;
  try {
    const decoded = await adminAuth().verifySessionCookie(cookie, true);
    return await ensureUserDoc({
      uid: decoded.uid,
      email: decoded.email,
      name: (decoded.name as string) || undefined,
      picture: (decoded.picture as string) || undefined,
    });
  } catch {
    return null;
  }
}

/**
 * Read & verify the current session. When an admin has an active impersonation cookie,
 * returns the impersonated client user instead so pages behave exactly as that user would
 * see them. Returns null when unauthenticated.
 */
export async function getCurrentUser(): Promise<AppUser | null> {
  const realUser = await getSessionUser();
  if (!realUser) return null;

  // Only admins can impersonate; check for the overlay cookie.
  if (realUser.role === "admin") {
    const store = await cookies();
    const impUid = store.get(IMPERSONATE_COOKIE)?.value;
    if (impUid) {
      const target = await getUser(impUid);
      if (target && !target.disabled) return target;
      // Stale or invalid cookie — clear it and fall back to real user.
      store.delete(IMPERSONATE_COOKIE);
    }
  }

  return realUser;
}

/**
 * Returns both the effective user (impersonated when active) and the real admin behind it.
 * Use this in layout.tsx where you need to render the banner and pass context to the sidebar.
 * Handles all auth redirects internally.
 */
export async function getViewingContext(): Promise<{
  user: AppUser;
  isImpersonating: boolean;
  realAdmin?: AppUser;
}> {
  const store = await cookies();
  const cookie = store.get(SESSION_COOKIE)?.value;
  if (!cookie) redirect("/login");

  let realUser: AppUser | null = null;
  try {
    const decoded = await adminAuth().verifySessionCookie(cookie, true);
    realUser = await ensureUserDoc({
      uid: decoded.uid,
      email: decoded.email,
      name: (decoded.name as string) || undefined,
      picture: (decoded.picture as string) || undefined,
    });
  } catch {
    redirect("/login");
  }

  if (!realUser) redirect("/login");
  if (realUser.disabled) redirect("/pending");

  if (realUser.role === "admin") {
    const impUid = store.get(IMPERSONATE_COOKIE)?.value;
    if (impUid) {
      const target = await getUser(impUid);
      if (target && !target.disabled) {
        return { user: target, isImpersonating: true, realAdmin: realUser };
      }
      store.delete(IMPERSONATE_COOKIE);
    }
  }

  return { user: realUser, isImpersonating: false };
}

/**
 * Start impersonating a client user. Only callable when the real session is an admin.
 * Sets a short-lived (4h) httpOnly cookie alongside the existing session cookie.
 */
export async function startImpersonation(targetUid: string): Promise<void> {
  const realUser = await getSessionUser();
  if (!realUser || realUser.role !== "admin") throw new Error("Forbidden");
  const target = await getUser(targetUid);
  if (!target || target.role !== "client") throw new Error("Can only impersonate client users");
  const store = await cookies();
  store.set(IMPERSONATE_COOKIE, targetUid, {
    httpOnly: true,
    secure: process.env.NODE_ENV === "production",
    sameSite: "lax",
    path: "/",
    maxAge: IMPERSONATE_MAX_AGE,
  });
}

/**
 * Clear the impersonation cookie. No auth check — clearing only benefits the caller
 * by returning them to their real session. The real session cookie is untouched.
 */
export async function stopImpersonation(): Promise<void> {
  const store = await cookies();
  store.delete(IMPERSONATE_COOKIE);
}

/** Guard a server component / action. Redirects when not allowed. */
export async function requireUser(roles?: Role[]): Promise<AppUser> {
  const user = await getCurrentUser();
  if (!user) redirect("/login");
  if (user.disabled) redirect("/pending");
  if (roles && !roles.includes(user.role)) redirect("/dashboard");
  return user;
}

export function isAdmin(user: AppUser | null) {
  return user?.role === "admin";
}
export function isStaff(user: AppUser | null) {
  return user?.role === "admin" || user?.role === "employee";
}
