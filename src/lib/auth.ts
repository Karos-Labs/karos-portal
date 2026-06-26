import "server-only";

import { cookies } from "next/headers";
import { redirect } from "next/navigation";
import { adminAuth } from "@/lib/firebase/admin";
import { getUser, upsertUser, countUsers, getClientByKeyId } from "@/lib/data";
import type { AppUser, Role } from "@/lib/types";

export const SESSION_COOKIE = "karos_session";
export const IMPERSONATE_COOKIE = "karos_impersonate";

const SESSION_MAX_AGE = 60 * 60 * 24 * 14; // 14 days (seconds)
const IMPERSONATE_MAX_AGE = 60 * 60 * 4;   // 4 hours (seconds)

/**
 * Carries the validated invitation key from the signup form to the server.
 * Everything is re-validated server-side in ensureUserDoc — the client's
 * requestedRole claim is never trusted on its own.
 */
export interface SignupIntent {
  requestedRole?: "KAROS_EMPLOYEE" | "CLIENT_USER";
  /** Raw invitation key entered by the user — validated server-side. */
  invitationKey?: string;
}

/**
 * Ensure a Firestore user doc exists for an authenticated Firebase identity.
 *
 * Bootstrap rule: the very first user ever → KAROS_ADMIN (no env var required).
 *
 * All subsequent users need a valid invitation key:
 *   - KAROS_STAFF_KEY env match → KAROS_EMPLOYEE, auto-approved
 *   - Valid clientKeyId match   → CLIENT_USER, auto-linked to client
 *   - Missing / invalid key     → lands disabled in the Registrations queue
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

  // ── Bootstrap: very first user in the system ──────────────────────────────
  const isFirstUser = (await countUsers()) === 0;
  if (isFirstUser) {
    const user: AppUser = {
      uid: claims.uid,
      email,
      name: claims.name || email.split("@")[0] || "Admin",
      role: "KAROS_ADMIN",
      photoURL: claims.picture ?? null,
      clientId: null,
      assignedClientIds: [],
      disabled: false,
      approvedAt: Date.now(),
      createdAt: Date.now(),
      lastLoginAt: Date.now(),
    };
    await upsertUser(user);
    return user;
  }

  const key = intent?.invitationKey?.trim() ?? "";

  // ── Staff key — auto-approve as KAROS_EMPLOYEE ────────────────────────────
  if (intent?.requestedRole === "KAROS_EMPLOYEE") {
    const staffKey = process.env.KAROS_STAFF_KEY;
    const validKey = !!(staffKey && key === staffKey);
    const user: AppUser = {
      uid: claims.uid,
      email,
      name: claims.name || email.split("@")[0] || "New user",
      role: "KAROS_EMPLOYEE",
      photoURL: claims.picture ?? null,
      clientId: null,
      assignedClientIds: [],
      requestedRole: validKey ? undefined : "KAROS_EMPLOYEE",
      disabled: !validKey,
      approvedAt: validKey ? Date.now() : null,
      createdAt: Date.now(),
      lastLoginAt: Date.now(),
    };
    await upsertUser(user);
    return user;
  }

  // ── Client key — auto-approve and link ───────────────────────────────────
  if (intent?.requestedRole === "CLIENT_USER" && key) {
    const client = await getClientByKeyId(key);
    if (client) {
      const user: AppUser = {
        uid: claims.uid,
        email,
        name: claims.name || email.split("@")[0] || "New user",
        role: "CLIENT_USER",
        photoURL: claims.picture ?? null,
        clientId: client.id,
        assignedClientIds: [],
        disabled: false,
        approvedAt: Date.now(),
        createdAt: Date.now(),
        lastLoginAt: Date.now(),
      };
      await upsertUser(user);
      return user;
    }
    // Invalid key — queue for staff review.
    const user: AppUser = {
      uid: claims.uid,
      email,
      name: claims.name || email.split("@")[0] || "New user",
      role: "CLIENT_USER",
      photoURL: claims.picture ?? null,
      clientId: null,
      assignedClientIds: [],
      requestedRole: "CLIENT_USER",
      disabled: true,
      approvedAt: null,
      createdAt: Date.now(),
      lastLoginAt: Date.now(),
    };
    await upsertUser(user);
    return user;
  }

  // ── No valid key provided — Registrations queue ───────────────────────────
  const user: AppUser = {
    uid: claims.uid,
    email,
    name: claims.name || email.split("@")[0] || "New user",
    role: "KAROS_EMPLOYEE",
    photoURL: claims.picture ?? null,
    clientId: null,
    assignedClientIds: [],
    requestedRole: "KAROS_EMPLOYEE",
    disabled: true,
    approvedAt: null,
    createdAt: Date.now(),
    lastLoginAt: Date.now(),
  };
  await upsertUser(user);
  return user;
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

/**
 * Provision (or no-op for an existing) user doc immediately after signup.
 * Returns the resulting AppUser so the session route can tell the client
 * the final role for routing decisions.
 */
export async function provisionFromSignup(idToken: string, intent: SignupIntent): Promise<AppUser> {
  const decoded = await adminAuth().verifyIdToken(idToken);
  return await ensureUserDoc(
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
 * Resolve a verified ID token to its Firestore user doc without provisioning.
 * Used by the session route for login (non-signup) flows.
 */
export async function getUserFromToken(idToken: string): Promise<AppUser | null> {
  const decoded = await adminAuth().verifyIdToken(idToken);
  return await ensureUserDoc({
    uid: decoded.uid,
    email: decoded.email,
    name: (decoded.name as string) || undefined,
    picture: (decoded.picture as string) || undefined,
  });
}

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

export async function getCurrentUser(): Promise<AppUser | null> {
  const realUser = await getSessionUser();
  if (!realUser) return null;

  if (realUser.role === "KAROS_ADMIN") {
    const store = await cookies();
    const impUid = store.get(IMPERSONATE_COOKIE)?.value;
    if (impUid) {
      const target = await getUser(impUid);
      if (target && !target.disabled) return target;
      store.delete(IMPERSONATE_COOKIE);
    }
  }

  return realUser;
}

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

  if (realUser.role === "KAROS_ADMIN") {
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

export async function startImpersonation(targetUid: string): Promise<void> {
  const realUser = await getSessionUser();
  if (!realUser || realUser.role !== "KAROS_ADMIN") throw new Error("Forbidden");
  const target = await getUser(targetUid);
  if (!target || target.role !== "CLIENT_USER") throw new Error("Can only impersonate CLIENT_USER accounts");
  const store = await cookies();
  store.set(IMPERSONATE_COOKIE, targetUid, {
    httpOnly: true,
    secure: process.env.NODE_ENV === "production",
    sameSite: "lax",
    path: "/",
    maxAge: IMPERSONATE_MAX_AGE,
  });
}

export async function stopImpersonation(): Promise<void> {
  const store = await cookies();
  store.delete(IMPERSONATE_COOKIE);
}

export async function requireUser(roles?: Role[]): Promise<AppUser> {
  const user = await getCurrentUser();
  if (!user) redirect("/login");
  if (user.disabled) redirect("/pending");
  if (roles && !roles.includes(user.role)) redirect("/dashboard");
  return user;
}

export function isAdmin(user: AppUser | null) {
  return user?.role === "KAROS_ADMIN";
}
export function isStaff(user: AppUser | null) {
  return user?.role === "KAROS_ADMIN" || user?.role === "KAROS_EMPLOYEE";
}
