import "server-only";

import { cookies } from "next/headers";
import { redirect } from "next/navigation";
import { adminAuth } from "@/lib/firebase/admin";
import { getUser, upsertUser, countUsers } from "@/lib/data";
import type { AppUser, Role } from "@/lib/types";

export const SESSION_COOKIE = "karos_session";
const SESSION_MAX_AGE = 60 * 60 * 24 * 14; // 14 days (seconds)

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
  // Bootstrap accounts are admins; everyone else starts at whatever they requested
  // (default employee) but cannot act until an admin confirms the role.
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
    // Admins are active & approved immediately; everyone else needs explicit approval.
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

/** Read & verify the current session. Returns null when unauthenticated. */
export async function getCurrentUser(): Promise<AppUser | null> {
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
