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
  getClientSeat,
} from "@/lib/data";
import {
  getCurrentUser,
  startImpersonation,
  stopImpersonation,
} from "@/lib/auth";
import { adminAuth } from "@/lib/firebase/admin";
import { sendEmail, emailShell, html } from "@/lib/email";
import type { AppUser, Role } from "@/lib/types";
import { ownAccountSession, requireAdmin } from "./_shared";

/** Where a stuck signup should write. Same fallback as sendSupportEmailAction. */
const SUPPORT_EMAIL = process.env.ADMIN_EMAIL ?? "hello@karoslabs.com";

function signInUrl(): string {
  const base = (process.env.APP_URL ?? "http://localhost:3000").replace(/\/+$/, "");
  return `${base}/login`;
}

/**
 * Registration decisions used to be silent on both sides: approve/reject only
 * revalidated /team, so a pending user learned nothing and a rejected one just
 * found their next sign-in failing (QA F115). Delivery soft-fails by design —
 * a mail outage must never block the account decision the admin just made.
 *
 * SOFT-FAIL MEANS THE WHOLE FUNCTION, not just the send. `sendEmail` returns a
 * result rather than throwing, so the old `if (!result.ok)` looked like it
 * honoured the promise above — but everything BEFORE the send could still throw
 * past it, and both callers `await` this with no catch, after the upsert has
 * already landed. That is the worst place to fail: the account is decided, the
 * `revalidatePath` never runs, and the admin sees a thrown error over a change
 * that did happen. Wrapped so the promise in the previous paragraph is kept by
 * the code and not only by the comment.
 */
async function notifyRegistrationDecision(opts: {
  to: string;
  name: string;
  approved: boolean;
}) {
  try {
    await deliverRegistrationDecision(opts);
  } catch (e) {
    console.error(
      `[registration] Failed to build ${opts.approved ? "approval" : "decline"} mail for ${opts.to}:`,
      e,
    );
  }
}

async function deliverRegistrationDecision(opts: {
  to: string;
  name: string;
  approved: boolean;
}) {
  const heading = opts.approved ? "You're in" : "About your Karos Labs request";
  // `html` rather than a bare template literal: `emailShell` now takes markup
  // only from the tag, which is what keeps an interpolated value from reaching
  // a client's mail unescaped. Both values here are ours (env-derived), so
  // nothing changes about what these two mails render.
  const body = opts.approved
    // "Sign in to get started", not "pick up where you left off": this person has
    // never been inside the workspace — they were a pending self-signup — and an
    // approved CLIENT_USER is sent to the onboarding wizard, not back to anything.
    ? html`<p style="margin:0 0 14px;">Your Karos Labs workspace is ready. Sign in to get started.</p>
       <p style="margin:0;"><a href="${signInUrl()}" style="color:#FF6B2C;font-weight:600;text-decoration:none;">Sign in to Karos Labs &#8250;</a></p>`
    : html`<p style="margin:0 0 14px;">We weren't able to approve access for this address at the moment.</p>
       <p style="margin:0;">If you think this is a mistake, reply to this email or write to <a href="mailto:${SUPPORT_EMAIL}" style="color:#FF6B2C;text-decoration:none;">${SUPPORT_EMAIL}</a> and we'll take another look.</p>`;

  const result = await sendEmail({
    to: opts.to,
    subject: opts.approved ? "Your Karos Labs account is approved" : "Your Karos Labs access request",
    html: emailShell({
      recipientName: opts.name,
      heading,
      intro: opts.approved
        ? "An agency admin approved your account."
        : "An agency admin reviewed your access request.",
      body,
      // ONE CLOSING LINE PER OCCASION, and neither of them is the shell's old
      // deliverable footer (QA #150). The approval mail's reply path is real —
      // `replyTo` below is the support address — and nothing in its body has
      // offered it yet. The decline mail's body offers that same path in its
      // last sentence, so its footer is null rather than a second copy of one
      // invitation.
      footer: opts.approved
        ? "Questions about your account? Reply to this email and it reaches the Karos Labs team."
        : null,
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
  /** CLIENT_USER only: which of that client's seats this login represents. */
  seatId?: string | null;
}) {
  await requireAdmin();
  const email = input.email.trim().toLowerCase();
  const clientId = input.role === "CLIENT_USER" ? input.clientId ?? null : null;
  if (input.role === "CLIENT_USER" && input.seatId) {
    const seat = await getClientSeat(input.seatId);
    if (!seat || seat.clientId !== clientId) {
      throw new Error("That seat isn't in this client's roster.");
    }
  }
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
    clientId,
    assignedClientIds: input.role === "KAROS_EMPLOYEE" ? input.assignedClientIds ?? [] : [],
    ...(input.role === "CLIENT_USER" ? { seatId: input.seatId ?? null } : {}),
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
        category: "",
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

/** Remove an existing team member: the Firestore doc and the Firebase Auth account both go. */
export async function deleteTeamMemberAction(uid: string) {
  const admin = await requireAdmin();
  if (uid === admin.uid) throw new Error("You can't delete your own account.");
  const existing = await getUser(uid);
  if (!existing) throw new Error("User not found");
  await deleteUser(uid);
  await adminAuth().deleteUser(uid).catch(() => {});
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

/**
 * Link (or unlink) a client login to one of that client's seats — "this
 * login IS this specific employee," the identity personal-content visibility
 * checks against (see isPersonalAssetVisibleToViewer in lib/asset-visibility).
 * Same dual permission as toggleGroupAdminAction above: an admin can set
 * anyone's; a client group-admin can set it for others in their own group.
 */
export async function updateSeatAssignmentAction(uid: string, seatId: string | null) {
  const user = await getCurrentUser();
  if (!user || user.disabled) throw new Error("Unauthorized");

  const target = await getUser(uid);
  if (!target) throw new Error("User not found");
  if (target.role !== "CLIENT_USER") throw new Error("Only client logins can be linked to a seat.");

  // Permission decided BEFORE the seat-ownership check below, not after: that
  // check's error names which client a seat belongs to, and asking it first
  // would let any authenticated caller probe another tenant's seat roster
  // through an action they have no permission to use at all.
  if (user.role === "KAROS_ADMIN") {
    // Admin may set anyone's.
  } else if (user.role === "CLIENT_USER" && user.isGroupAdmin) {
    if (target.clientId !== user.clientId) {
      throw new Error("That person isn't in your workspace, so you can't change their seat.");
    }
    if (target.uid === user.uid) throw new Error("Cannot change your own seat link");
  } else {
    throw new Error("Forbidden");
  }

  if (seatId) {
    const seat = await getClientSeat(seatId);
    if (!seat || seat.clientId !== target.clientId) {
      throw new Error("That seat isn't in this client's roster.");
    }
  }

  await upsertUser({ ...target, seatId });
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

/**
 * Update the current user's display name (and optional phone) in Firestore +
 * Firebase Auth.
 *
 * `ownAccountSession` rather than `getCurrentUser`: under "View as Client" the
 * session's subject is the CLIENT, so this rewrote their display name and phone
 * — and mirrored the name onto their Firebase Auth identity — with no marker on
 * the write and no activity row. See the note on IMPERSONATED_SELF_WRITE_MESSAGE.
 */
export async function updateUserProfileAction(name: string, phone?: string): Promise<void> {
  const session = await ownAccountSession();
  if (!session.ok) throw new Error(session.error);
  const { user } = session;
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
  // Through the same gate as its siblings, and NOT because this one was
  // exploitable: the verification round trip below signs in as the SUBJECT's
  // email, which an impersonating admin cannot pass without the client's
  // current password. That is an accident of the verification step rather than
  // a decision, and it is the only thing standing between "View as Client" and
  // taking over the account. Stated here so the accident stops being the guard.
  const session = await ownAccountSession();
  if (!session.ok) throw new Error(session.error);
  const { user } = session;
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
