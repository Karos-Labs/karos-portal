"use server";

import { randomBytes } from "crypto";
import { after } from "next/server";
import { revalidatePath } from "next/cache";
import { createClient, updateClient, deleteClient, getClientByKeyId } from "@/lib/data";
import { applyBrandingForClient } from "@/lib/branding";
import { requireUser } from "@/lib/auth";
import type { Client, SocialLinks } from "@/lib/types";
import { requireStaff } from "./_shared";

export async function createClientAction(input: {
  name: string;
  website?: string;
  industry?: string;
  contactEmail?: string;
  domains?: string;
  description?: string;
  brandVoice?: string;
  assignedEmployeeIds?: string[];
}): Promise<{ id: string }> {
  const user = await requireStaff();
  // Generate a cryptographically secure, unguessable join token for the new client.
  const clientKeyId = `ck_${randomBytes(16).toString("base64url")}`;
  const id = await createClient({
    name: input.name.trim(),
    website: input.website?.trim() || "",
    industry: input.industry?.trim() || "",
    contactEmail: input.contactEmail?.trim().toLowerCase() || "",
    domains: (input.domains ?? "")
      .split(",")
      .map((d) => d.trim().toLowerCase())
      .filter(Boolean),
    description: input.description?.trim() || "",
    brandVoice: input.brandVoice?.trim() || "",
    assignedEmployeeIds: input.assignedEmployeeIds ?? [user.uid],
    status: "active",
    clientKeyId,
    onboardingStatus: "pending",
    createdAt: Date.now(),
    createdBy: user.uid,
  });

  after(async () => {
    await updateClient(id, { onboardingStatus: "running" });
    const { runIntelReportPipeline } = await import("@/lib/intel");
    const [brandingResult, intelResult] = await Promise.allSettled([
      applyBrandingForClient(id),
      runIntelReportPipeline(id),
    ]);
    if (brandingResult.status === "rejected") {
      console.error("[onboard] Branding generation failed (non-fatal):", brandingResult.reason);
    }
    if (intelResult.status === "rejected") {
      console.error("[onboard] Intel Report generation failed (non-fatal):", intelResult.reason);
    }
    const anyFailed = brandingResult.status === "rejected" || intelResult.status === "rejected";
    await updateClient(id, { onboardingStatus: anyFailed ? "failed" : "done" });
  });

  revalidatePath("/clients");
  return { id };
}

/** Regenerate the clientKeyId for a client. Invalidates any previous join links. */
export async function regenerateClientKeyAction(clientId: string): Promise<{ clientKeyId: string }> {
  await requireStaff();
  const clientKeyId = `ck_${randomBytes(16).toString("base64url")}`;
  await updateClient(clientId, { clientKeyId });
  revalidatePath(`/clients/${clientId}`);
  return { clientKeyId };
}

/**
 * Client-editable profile fields (self-service). A CLIENT_USER may update their
 * own client's category / team size / social links / short description; staff may
 * update any client. Deliberately narrow — no access to keys, employees, status, etc.
 */
export async function updateClientProfileAction(
  id: string,
  input: {
    category?: string;
    teamSize?: string;
    description?: string;
    socialLinks?: SocialLinks;
    // Brand profile fields — editable by the client's own users as well as staff.
    brandVoice?: string;
    contactEmail?: string;
    website?: string;
    industry?: string;
    /** Comma-separated meeting domains, e.g. "company.com, sub.company.com" */
    domainsCsv?: string;
  },
): Promise<{ ok: true } | { ok: false; error: string }> {
  const user = await requireUser();
  const isStaff = user.role === "KAROS_ADMIN" || user.role === "KAROS_EMPLOYEE";
  if (!isStaff && !(user.role === "CLIENT_USER" && user.clientId === id)) {
    return { ok: false, error: "Not authorized to edit this profile." };
  }

  const clean = (v?: string) => (typeof v === "string" ? v.trim() : undefined);
  const patch: Partial<Client> = {};
  if (input.category !== undefined) patch.category = clean(input.category);
  if (input.teamSize !== undefined) patch.teamSize = clean(input.teamSize);
  if (input.description !== undefined) patch.description = clean(input.description);
  if (input.brandVoice !== undefined) patch.brandVoice = clean(input.brandVoice);
  if (input.contactEmail !== undefined) patch.contactEmail = clean(input.contactEmail)?.toLowerCase();
  if (input.website !== undefined) patch.website = clean(input.website);
  if (input.industry !== undefined) patch.industry = clean(input.industry);
  if (input.domainsCsv !== undefined) {
    patch.domains = input.domainsCsv.split(",").map((d) => d.trim().toLowerCase()).filter(Boolean);
  }
  if (input.socialLinks !== undefined) {
    const links: SocialLinks = {};
    for (const [k, val] of Object.entries(input.socialLinks)) {
      const c = clean(val);
      if (c) (links as Record<string, string>)[k] = c;
    }
    patch.socialLinks = links;
  }

  await updateClient(id, patch);
  revalidatePath(`/clients/${id}`);
  return { ok: true };
}

export async function updateClientAction(id: string, input: Partial<Client> & { domainsCsv?: string }) {
  await requireStaff();
  const patch: Partial<Client> = { ...input };
  if (input.domainsCsv !== undefined) {
    patch.domains = input.domainsCsv.split(",").map((d) => d.trim().toLowerCase()).filter(Boolean);
    delete (patch as { domainsCsv?: string }).domainsCsv;
  }
  if (patch.contactEmail) patch.contactEmail = patch.contactEmail.toLowerCase();
  // Immutable / security-sensitive fields — only dedicated actions may change these.
  delete (patch as Partial<Client> & { clientKeyId?: string }).clientKeyId;
  delete (patch as Partial<Client> & { createdAt?: number }).createdAt;
  delete (patch as Partial<Client> & { createdBy?: string }).createdBy;
  await updateClient(id, patch);
  revalidatePath(`/clients/${id}`);
  revalidatePath("/clients");
}

/**
 * Permanently delete a client and revalidate the clients listing.
 * Orphaned sub-documents (jobs, assets, context docs, etc.) referencing
 * this clientId remain in Firestore but are no longer surfaced in the UI.
 * Staff-only — admin or employee access required.
 */
export async function deleteClientAction(clientId: string): Promise<void> {
  await requireStaff();
  await deleteClient(clientId);
  revalidatePath("/clients");
  revalidatePath(`/clients/${clientId}`);
}

/**
 * Validate an invitation key before the user completes signup.
 * Public — no auth required. Returns the resolved role and a display label.
 * The key is re-validated server-side in ensureUserDoc when the session is created.
 */
export async function validateInvitationKeyAction(key: string): Promise<
  | { ok: true; role: "KAROS_EMPLOYEE"; label: string }
  | { ok: true; role: "CLIENT_USER"; clientId: string; label: string }
  | { ok: false; error: string }
> {
  const trimmed = key.trim();
  if (!trimmed) return { ok: false, error: "Enter your invitation key." };

  const staffKey = process.env.KAROS_STAFF_KEY;
  if (staffKey && trimmed === staffKey) {
    return { ok: true, role: "KAROS_EMPLOYEE", label: "Karos Labs Staff" };
  }

  const client = await getClientByKeyId(trimmed);
  if (client) {
    return { ok: true, role: "CLIENT_USER", clientId: client.id, label: client.name };
  }

  return { ok: false, error: "Invalid invitation key. Contact your Karos account manager." };
}
