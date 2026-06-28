"use server";

import { randomBytes } from "crypto";
import { after } from "next/server";
import { revalidatePath } from "next/cache";
import { createClient, updateClient, getClientByKeyId } from "@/lib/data";
import { applyBrandingForClient } from "@/lib/branding";
import type { Client } from "@/lib/types";
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
    const { runIntelReportPipeline } = await import("@/lib/intel-report");
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

export async function updateClientAction(id: string, input: Partial<Client> & { domainsCsv?: string }) {
  await requireStaff();
  const patch: Partial<Client> = { ...input };
  if (input.domainsCsv !== undefined) {
    patch.domains = input.domainsCsv.split(",").map((d) => d.trim().toLowerCase()).filter(Boolean);
    delete (patch as { domainsCsv?: string }).domainsCsv;
  }
  if (patch.contactEmail) patch.contactEmail = patch.contactEmail.toLowerCase();
  await updateClient(id, patch);
  revalidatePath(`/clients/${id}`);
  revalidatePath("/clients");
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
