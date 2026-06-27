"use server";

import { revalidatePath } from "next/cache";
import {
  createClientRequest,
  updateClientRequest,
} from "@/lib/data";
import type { ClientRequest } from "@/lib/types";
import { requireStaff } from "./_shared";

/**
 * Submit a "Request New Client Setup" form from a prospective customer who
 * doesn't have a clientKeyId. Public — no auth required.
 */
export async function submitClientRequestAction(input: {
  companyName: string;
  website?: string;
  adminEmail: string;
  useCase: string;
}): Promise<{ ok: boolean; error?: string }> {
  const companyName = input.companyName.trim();
  const adminEmail = input.adminEmail.trim().toLowerCase();
  const useCase = input.useCase.trim();

  if (!companyName || !adminEmail || !useCase) {
    return { ok: false, error: "Company name, admin email, and use case are required." };
  }

  const data: Omit<ClientRequest, "id"> = {
    companyName,
    website: input.website?.trim() || undefined,
    adminEmail,
    useCase,
    status: "PENDING_APPROVAL",
    submittedAt: Date.now(),
  };

  await createClientRequest(data);

  try {
    const { sendEmail } = await import("@/lib/email");
    const to = process.env.KAROS_EMAIL || "hello@karoslabs.com";
    await sendEmail({
      to,
      subject: `[KarosCMO] New client access request — ${companyName}`,
      html: `
        <div style="font-family:-apple-system,Helvetica,Arial,sans-serif;background:#07090b;padding:32px;color:#e8f0ec;">
          <h2 style="color:#2dff9e;margin:0 0 16px;">New Client Access Request</h2>
          <table style="border-collapse:collapse;width:100%;max-width:560px;">
            <tr><td style="padding:6px 12px 6px 0;color:#8aa2a8;white-space:nowrap;">Company</td><td style="padding:6px 0;"><strong>${companyName}</strong></td></tr>
            <tr><td style="padding:6px 12px 6px 0;color:#8aa2a8;">Website</td><td style="padding:6px 0;">${input.website?.trim() || "—"}</td></tr>
            <tr><td style="padding:6px 12px 6px 0;color:#8aa2a8;">Admin Email</td><td style="padding:6px 0;">${adminEmail}</td></tr>
            <tr><td style="padding:6px 12px 6px 0;color:#8aa2a8;vertical-align:top;">Use Case</td><td style="padding:6px 0;">${useCase}</td></tr>
          </table>
          <p style="margin:20px 0 0;color:#5f7177;font-size:13px;">Review this request in the KarosCMO Registrations dashboard.</p>
        </div>`,
    });
  } catch {
    // Email failure is non-fatal — the request is already saved to Firestore.
  }

  return { ok: true };
}

/**
 * Approve or reject a client access request. Staff-only.
 */
export async function reviewClientRequestAction(
  id: string,
  status: "APPROVED" | "REJECTED",
  reviewNotes?: string,
): Promise<void> {
  const admin = await requireStaff();
  await updateClientRequest(id, {
    status,
    reviewedAt: Date.now(),
    reviewedBy: admin.uid,
    reviewNotes: reviewNotes?.trim() || undefined,
  });
  revalidatePath("/registrations");
}
