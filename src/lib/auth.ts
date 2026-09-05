import "server-only";

import { cache } from "react";
import { cookies } from "next/headers";
import { notFound, redirect } from "next/navigation";
import type { DecodedIdToken } from "firebase-admin/auth";
import { adminAuth } from "@/lib/firebase/admin";
import { getUser, upsertUser, countUsers, getClient, getClientByKeyId } from "@/lib/data";
import { canViewClient } from "@/lib/client-visibility";
import type { AppUser, Client, Role } from "@/lib/types";

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
 * Mandatory email verification for native (email/password) self-registration.
 *
 * A password account whose email is not yet verified must NOT be granted a
 * session. Social identities (Google) arrive pre-verified from the provider,
 * and admin-created accounts are minted with `emailVerified: true`
 * (see createTeamMemberAction) — both pass this gate. So the check is scoped
 * strictly to the `password` sign-in provider: only self-signups can be caught
 * here, which is exactly the population the verification mandate targets.
 */
export function isEmailUnverified(decoded: DecodedIdToken): boolean {
  return decoded.firebase?.sign_in_provider === "password" && decoded.email_verified !== true;
}

/** Verify a Firebase ID token and return its decoded claims. */
export function verifyIdToken(idToken: string): Promise<DecodedIdToken> {
  return adminAuth().verifyIdToken(idToken);
}

/**
 * Ensure a Firestore user doc exists for an authenticated Firebase identity.
 *
 * Bootstrap rule: the very first user ever → KAROS_ADMIN (no env var required).
 *
 * All subsequent users need a valid invitation key:
 *   - KAROS_STAFF_KEY env match → KAROS_EMPLOYEE, auto-approved
 *     Exception: hello@karoslabs.com (company inbound alias) → KAROS_ADMIN
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
  // Special case: hello@karoslabs.com is the company's shared inbound mail alias.
  // When it signs up with a valid staff key, it gets KAROS_ADMIN so a single
  // inbox can manage the platform without a personal login.
  if (intent?.requestedRole === "KAROS_EMPLOYEE") {
    const staffKey = process.env.KAROS_STAFF_KEY;
    const validKey = !!(staffKey && key === staffKey);
    const isCompanyAlias = email === (process.env.KAROS_COMPANY_ALIAS ?? "hello@karoslabs.com");
    const role: Role = validKey && isCompanyAlias ? "KAROS_ADMIN" : "KAROS_EMPLOYEE";
    const user: AppUser = {
      uid: claims.uid,
      email,
      name: claims.name || email.split("@")[0] || "New user",
      role,
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
        // Fresh client account — send them through the personal profile +
        // workspace setup wizard on first login.
        hasCompletedOnboarding: false,
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
export async function createSession(idToken: string, secure?: boolean): Promise<void> {
  const expiresIn = SESSION_MAX_AGE * 1000;
  const sessionCookie = await adminAuth().createSessionCookie(idToken, { expiresIn });
  // Use caller-supplied flag when available (derived from x-forwarded-proto so
  // HTTP deployments don't silently drop the cookie). Fall back to NODE_ENV.
  const useSecure = secure ?? (process.env.NODE_ENV === "production");
  const store = await cookies();
  store.set(SESSION_COOKIE, sessionCookie, {
    httpOnly: true,
    secure: useSecure,
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
export async function provisionFromSignup(decoded: DecodedIdToken, intent: SignupIntent): Promise<AppUser> {
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
 * Read-only login lookup: returns the existing Firestore user doc for this
 * Firebase UID, or null if none exists.
 *
 * This function NEVER creates a document. If null is returned, the session
 * route rejects the request with "please sign up first." The only path that
 * creates docs is ensureUserDoc, called exclusively from provisionFromSignup
 * (the /signup flow) and getSessionUser (for already-provisioned sessions).
 */
export async function getUserFromToken(decoded: DecodedIdToken): Promise<AppUser | null> {
  return await getUser(decoded.uid);
}

/**
 * Resolve the signed-in identity behind the session cookie — ONCE PER REQUEST.
 *
 * React-`cache`d for a correctness reason, not a speed one. Resolving a session
 * is not a read: `ensureUserDoc` UPSERTS the user document when the address on
 * the Firebase identity has drifted from the stored one, and it can mint a doc
 * outright. Meanwhile `logActivity` resolves the session on every row that
 * claims a client acted (to catch impersonation), and eight of its callers fire
 * it and forget it — so a request could run several independent
 * `verifySessionCookie` + upsert cycles, and an activity log could be the thing
 * that triggered a write to a user record. Sharing one resolution per request
 * means the log can only ever observe the write the request was already making.
 *
 * Same idiom as `getClient` in data.ts. React's cache is per-request, so no
 * identity is ever shared between two requests; callers get a shallow copy so a
 * caller that mutates its user cannot reach into another's.
 *
 * NOT a substitute for re-reading after a cookie change: nothing in this app
 * mints or swaps a session and then re-reads it inside the same request (the
 * session route responds immediately, and both impersonation actions redirect),
 * which is what makes the caching safe.
 */
const resolveSessionUser = cache(async (): Promise<AppUser | null> => {
  const store = await cookies();
  const cookie = store.get(SESSION_COOKIE)?.value;
  if (!cookie) return null;
  try {
    const decoded = await adminAuth().verifySessionCookie(cookie, true);
    // Defence in depth: an unverified password account should never hold a
    // session cookie (the session route refuses to mint one), but never trust it.
    if (isEmailUnverified(decoded)) return null;
    return await ensureUserDoc({
      uid: decoded.uid,
      email: decoded.email,
      name: (decoded.name as string) || undefined,
      picture: (decoded.picture as string) || undefined,
    });
  } catch {
    return null;
  }
});

/**
 * The "View as Client" target, read once per request. `getCurrentUser` runs
 * many times in one request (the layout, the page, every action and every
 * `logActivity` row), and under impersonation each call re-read the target's
 * user document. Same idiom as `resolveSessionUser` above; the same
 * per-request lifetime keeps it correct — `startImpersonation` sets the cookie
 * and redirects, so no request both changes the target and re-reads it.
 */
const impersonationTarget = cache(async (uid: string): Promise<AppUser | null> => getUser(uid));

async function getSessionUser(): Promise<AppUser | null> {
  const user = await resolveSessionUser();
  return user ? { ...user } : null;
}

export async function getCurrentUser(): Promise<AppUser | null> {
  const realUser = await getSessionUser();
  if (!realUser) return null;

  if (realUser.role === "KAROS_ADMIN") {
    const store = await cookies();
    const impUid = store.get(IMPERSONATE_COOKIE)?.value;
    if (impUid) {
      const target = await impersonationTarget(impUid);
      // impersonatedBy is transient — it marks the session so credit charges
      // and other client-billed actions know a staff member is behind it.
      if (target && !target.disabled) return { ...target, impersonatedBy: realUser.uid };
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
  // Through the shared resolver rather than a second inline copy of it: this
  // runs in the app layout on every page, so the duplicate was a second
  // verifySessionCookie plus a second ensureUserDoc (which can write) on every
  // request that also called getCurrentUser. Every arm of the old try/catch —
  // no cookie, a bad cookie, an unverified address, a throw from Firestore —
  // redirected to /login, and every one of them is a null from the resolver.
  const realUser = await getSessionUser();
  if (!realUser) redirect("/login");
  if (realUser.disabled) redirect("/pending");

  const store = await cookies();
  if (realUser.role === "KAROS_ADMIN") {
    const impUid = store.get(IMPERSONATE_COOKIE)?.value;
    if (impUid) {
      const target = await impersonationTarget(impUid);
      if (target && !target.disabled) {
        return {
          user: { ...target, impersonatedBy: realUser.uid },
          isImpersonating: true,
          realAdmin: realUser,
        };
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

/**
 * Load the client behind a `/clients/[id]` route, or refuse — THE server-side
 * half of the assignment fence (see canViewClient for why the fence is a
 * permission and not a sort order).
 *
 * Replaces the `getClient(id); if (!client) notFound()` pair every one of those
 * routes was doing, so "does it exist" and "may you open it" are answered
 * together and a new route under `/clients/[id]` cannot get one without the
 * other. `getClient` is React-`cache`d, so the nested layout and the page it
 * wraps still make one Firestore read between them.
 *
 * ONE response for "no such client" and "not yours", deliberately: a distinct
 * 403 would turn the route into an oracle for which client ids exist. Same
 * idiom `requireTaskAccess` uses for foreign task ids.
 *
 * The layout checks too, and the PAGE's check is the one that counts. A layout
 * is not re-rendered on navigation (next/dist/docs — file-conventions/layout.md
 * and the glossary's "Layout" entry; instant-navigation.md spells out that a
 * client transition only re-renders BELOW the layout the two routes share), so
 * a guard placed only in the layout is skipped on every client-side move
 * between two `/clients/[id]/…` pages. The layout's copy exists for the other
 * reason: it BUILDS a payload (the staff rail), and a payload has to be
 * authorised where it is built.
 *
 * `notFound()` rather than Next's `forbidden()` on purpose — beyond the oracle
 * point above, `forbidden()` needs the `authInterrupts` experimental flag,
 * which this app does not set.
 */
export async function requireVisibleClient(user: AppUser, clientId: string): Promise<Client> {
  const client = await getClient(clientId);
  if (!client || !canViewClient(user, client)) notFound();
  return client;
}

export function isAdmin(user: AppUser | null) {
  return user?.role === "KAROS_ADMIN";
}
export function isStaff(user: AppUser | null) {
  return user?.role === "KAROS_ADMIN" || user?.role === "KAROS_EMPLOYEE";
}
