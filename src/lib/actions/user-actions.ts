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
import { sendEmail, emailShell } from "@/lib/email";
import type { AppUser, Role } from "@/lib/types";
import { requireAdmin } from "./_shared";

/** Where a stuck signup should write. Same fallback as sendSupportEmailAction. */
const SUPPORT_EMAIL = process.env.ADMIN_EMAIL ?? "hello@karoslabs.com";

function signInUrl(): string {
  const base = (process.env.NEXT_PUBLIC_APP_URL ?? "http://localhost:3000").replace(/\/+$/, "");
  return `${base}/login`;
}

/**
 * Registration decisions used to be silent on both sides: approve/reject only
 * revalidated /team, so a pending user learned nothing and a rejected one just
 * found their next sign-in failing (QA F115). Delivery soft-fails by design —
 * a mail outage must never block the account decision the admin just made.
 */
async function notifyRegistrationDecision(opts: {
  to: string;
  name: string;
  approved: boolean;
}) {
  const heading = opts.approved ? "You're in" : "About your Karos Labs request";
  const body = opts.approved
    ? `<p style="margin:0 0 14px;">Your Karos Labs workspace is ready. Sign in to pick up where you left off.</p>
       <p style="margin:0;"><a href="${signInUrl()}" style="color:#FF6B2C;font-weight:600;text-decoration:none;">Sign in to Karos Labs &#8250;</a></p>`
    : `<p style="margin:0 0 14px;">We weren't able to approve access for this address at the moment.</p>
       <p style="margin:0;">If you think this is a mistake, reply to this email or write to <a href="mailto:${SUPPORT_EMAIL}" style="color:#FF6B2C;text-decoration:none;">${SUPPORT_EMAIL}</a> and we'll take another look.</p>`;

  const result = await sendEmail({
    to: opts.to,
    subject: opts.approved ? "Your Karos Labs account is approved" : "Your Karos Labs access request",
    html: emailShell({
      clientName: opts.name,
      heading,
      intro: opts.approved
        ? "An agency admin approved your account."
        : "An agency admin reviewed your access request.",
      body,
    }),
    replyTo: SUPPORT_EMAIL,
  });
  if (!result.ok) {
    console.error(
      `[registration] Failed to deliver ${opts.approved ? "approval" : "decline"} mail to ${opts.to}: ${result.error}`,
    );
  }
}

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
  await notifyRegistrationDecision({ to: existing.email, name: existing.name, approved: true });
  revalidatePath("/team");
}

/** Reject a pending registration: remove the Firestore doc and the auth account. */
export async function rejectRegistrationAction(uid: string) {
  await requireAdmin();
  // Capture the address BEFORE the delete — afterwards there is nothing to mail.
  const existing = await getUser(uid);
  await deleteUser(uid);
  await adminAuth().deleteUser(uid).catch(() => {});
  if (existing?.email) {
    await notifyRegistrationDecision({ to: existing.email, name: existing.name, approved: false });
  }
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
    // A client group-admin reaches this, and components render a thrown
    // message straight into their error banner — so it is a sentence, not the
    // HTTP word plus a hyphenated note.
    if (target.clientId !== user.clientId) {
      throw new Error("That person isn't in your workspace, so you can't change their access.");
    }
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
