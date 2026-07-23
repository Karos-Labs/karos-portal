"use server";

import { redirect } from "next/navigation";
import { revalidatePath } from "next/cache";
import { randomBytes } from "crypto";
import {
  getUser,
  upsertUser,
  deleteUser,
  createClient,
  clearUserPhone,
} from "@/lib/data";
import {
  getCurrentUser,
  startImpersonation,
  stopImpersonation,
} from "@/lib/auth";
import { adminAuth } from "@/lib/firebase/admin";
import type { AppUser, Role } from "@/lib/types";
import { requireAdmin } from "./_shared";

export async function createTeamMemberAction(input: {
  name: string;
  email: string;
  password: string;
  role: Role;
  clientId?: string;
  assignedClientIds?: string[];
}) {
  await requireAdmin();
  const email = input.email.trim().toLowerCase();
  const userRecord = await adminAuth().createUser({
    email,
    password: input.password,
    displayName: input.name,
    // Admin bypass: manually added users skip the self-signup email-verification
    // gate. Minting them pre-verified lets them log in / set their password
    // without a blocking verification step.
    emailVerified: true,
  });
  const user: AppUser = {
    uid: userRecord.uid,
    email,
    name: input.name.trim(),
    role: input.role,
    clientId: input.role === "CLIENT_USER" ? input.clientId ?? null : null,
    assignedClientIds: input.role === "KAROS_EMPLOYEE" ? input.assignedClientIds ?? [] : [],
    disabled: false,
    approvedAt: Date.now(),
    createdAt: Date.now(),
  };
  await upsertUser(user);
  revalidatePath("/team");
  return { uid: userRecord.uid };
}

/**
 * Approve a pending self-signup: set the final role, link/create a client (for clients) or
 * assign clients (for employees), and flip the account live.
 */
export async function approveRegistrationAction(
  uid: string,
  input: {
    role: Role;
    clientId?: string | null;
    newClientName?: string;
    assignedClientIds?: string[];
  },
) {
  const admin = await requireAdmin();
  const existing = await getUser(uid);
  if (!existing) throw new Error("User not found");

  const patch: Partial<AppUser> = {
    role: input.role,
    disabled: false,
    approvedAt: Date.now(),
    clientId: null,
    assignedClientIds: [],
  };

  if (input.role === "CLIENT_USER") {
    // First time this account gets real client access — run the onboarding wizard.
    patch.hasCompletedOnboarding = false;
    let clientId = input.clientId ?? null;
    const newName = input.newClientName?.trim();
    if (newName) {
      const clientKeyId = `ck_${randomBytes(16).toString("base64url")}`;
      clientId = await createClient({
        name: newName,
        website: "",
        industry: "",
        contactEmail: existing.email,
        domains: [],
        description: "",
        brandVoice: "",
        assignedEmployeeIds: [admin.uid],
        status: "active",
        clientKeyId,
        createdAt: Date.now(),
        createdBy: admin.uid,
      });
    }
    if (!clientId) throw new Error("Pick a client or create a new one for this person.");
    patch.clientId = clientId;
  } else if (input.role === "KAROS_EMPLOYEE") {
    patch.assignedClientIds = input.assignedClientIds ?? [];
  }

  await upsertUser({ ...existing, ...patch });
  await adminAuth().updateUser(uid, { disabled: false }).catch(() => {});
  revalidatePath("/team");
}

/** Reject a pending registration: remove the Firestore doc and the auth account. */
export async function rejectRegistrationAction(uid: string) {
  await requireAdmin();
  await deleteUser(uid);
  await adminAuth().deleteUser(uid).catch(() => {});
  revalidatePath("/team");
}

export async function updateTeamMemberAction(uid: string, patch: Partial<AppUser>) {
  await requireAdmin();
  const existing = await getUser(uid);
  if (!existing) throw new Error("User not found");
  await upsertUser({ ...existing, ...patch });
  if (patch.disabled !== undefined) {
    await adminAuth().updateUser(uid, { disabled: patch.disabled }).catch(() => {});
  }
  revalidatePath("/team");
}

/**
 * Toggle the isGroupAdmin flag on a client user.
 * Admins can toggle anyone; client group-admins can toggle others within their own group.
 */
export async function toggleGroupAdminAction(uid: string, isGroupAdmin: boolean) {
  const user = await getCurrentUser();
  if (!user || user.disabled) throw new Error("Unauthorized");

  const target = await getUser(uid);
  if (!target) throw new Error("User not found");

  if (user.role === "KAROS_ADMIN") {
    await upsertUser({ ...target, isGroupAdmin });
  } else if (user.role === "CLIENT_USER" && user.isGroupAdmin) {
    if (target.clientId !== user.clientId) throw new Error("Forbidden - different group");
    if (target.uid === user.uid) throw new Error("Cannot change your own group admin status");
    await upsertUser({ ...target, isGroupAdmin });
  } else {
    throw new Error("Forbidden");
  }

  revalidatePath("/team");
}

/** Begin impersonating a client user. Redirects to /dashboard as that user on success. */
export async function startImpersonationAction(targetUid: string) {
  await startImpersonation(targetUid);
  redirect("/dashboard");
}

/** End impersonation and return to the admin's real session. Redirects to /team. */
export async function stopImpersonationAction() {
  await stopImpersonation();
  redirect("/team");
}

/** Update the current user's display name (and optional phone) in Firestore + Firebase Auth. */
export async function updateUserProfileAction(name: string, phone?: string): Promise<void> {
  const user = await getCurrentUser();
  if (!user || user.disabled) throw new Error("Unauthorized");
  const trimmed = name.trim();
  if (!trimmed) throw new Error("Name cannot be empty.");
  if (trimmed.length > 100) throw new Error("Name is too long (max 100 characters).");
  const trimmedPhone = phone?.trim();
  await upsertUser({ ...user, name: trimmed, ...(trimmedPhone ? { phone: trimmedPhone } : {}) });
  if (!trimmedPhone && user.phone) await clearUserPhone(user.uid);
  await adminAuth().updateUser(user.uid, { displayName: trimmed });
  revalidatePath("/settings");
}

/**
 * Change the current user's password.
 * Verifies the current password via the Firebase Auth REST API, then updates via Admin SDK.
 */
export async function updatePasswordAction(
  currentPassword: string,
  newPassword: string,
): Promise<void> {
  const user = await getCurrentUser();
  if (!user || user.disabled) throw new Error("Unauthorized");
  if (newPassword.length < 6) throw new Error("New password must be at least 6 characters.");

  const apiKey = process.env.NEXT_PUBLIC_FIREBASE_API_KEY;
  if (!apiKey) throw new Error("Firebase API key is not configured.");

  const verifyRes = await fetch(
    `https://identitytoolkit.googleapis.com/v1/accounts:signInWithPassword?key=${apiKey}`,
    {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        email: user.email,
        password: currentPassword,
        returnSecureToken: false,
      }),
    },
  );
  if (!verifyRes.ok) throw new Error("Current password is incorrect.");

  await adminAuth().updateUser(user.uid, { password: newPassword });
}
