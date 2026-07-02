import "server-only";

import { Resend } from "resend";

export interface SendEmailInput {
  to: string;
  subject: string;
  html: string;
  replyTo?: string;
}

/**
 * Sends an email via Resend. Returns { ok, id|error }.
 * Soft-fails (never throws) so an agent run can still succeed even if delivery is
 * misconfigured — the job records the email error instead.
 */
export async function sendEmail(input: SendEmailInput): Promise<
  { ok: true; id: string } | { ok: false; error: string }
> {
  const key = process.env.RESEND_API_KEY;
  const from = process.env.EMAIL_FROM || "Karos CMO <onboarding@resend.dev>";
  if (!key) {
    return { ok: false, error: "RESEND_API_KEY is not set" };
  }
  try {
    const resend = new Resend(key);
    const { data, error } = await resend.emails.send({
      from,
      to: input.to,
      subject: input.subject,
      html: input.html,
      replyTo: input.replyTo,
    });
    if (error) return { ok: false, error: error.message };
    return { ok: true, id: data?.id ?? "" };
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : "Unknown email error" };
  }
}

/** Branded HTML wrapper for client-facing deliveries. */
export function emailShell(opts: {
  clientName: string;
  heading: string;
  intro: string;
  body: string;
}) {
  return `
  <div style="background:#07090b;padding:32px 0;font-family:-apple-system,Segoe UI,Roboto,Helvetica,Arial,sans-serif;">
    <div style="max-width:600px;margin:0 auto;background:#0d1117;border:1px solid #20303a;border-radius:16px;overflow:hidden;">
      <div style="padding:24px 28px;border-bottom:1px solid #20303a;">
        <span style="color:#FF6B2C;font-weight:700;font-size:18px;letter-spacing:0.4px;">Karos<span style="color:#e8f0ec;">CMO</span></span>
      </div>
      <div style="padding:28px;color:#e8f0ec;">
        <p style="color:#9c9ca3;font-size:13px;margin:0 0 6px;">Prepared for ${opts.clientName}</p>
        <h1 style="font-size:22px;margin:0 0 12px;color:#e8f0ec;">${opts.heading}</h1>
        <p style="color:#aebfc4;font-size:15px;line-height:1.6;margin:0 0 20px;">${opts.intro}</p>
        <div style="background:#131a22;border:1px solid #20303a;border-radius:12px;padding:20px;color:#e8f0ec;font-size:15px;line-height:1.7;">
          ${opts.body}
        </div>
        <p style="color:#5f7177;font-size:12px;margin:22px 0 0;">Reply to this email to request changes — your Karos team is on it.</p>
      </div>
    </div>
  </div>`;
}
