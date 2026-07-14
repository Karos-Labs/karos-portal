"use server";

import { z } from "zod";
import { getCurrentUser } from "@/lib/auth";
import { sendEmail } from "@/lib/email";

const schema = z.object({
  subject: z.string().min(1, "Subject is required").max(200),
  message: z.string().min(10, "Message must be at least 10 characters").max(5000),
});

export async function sendSupportEmailAction(
  input: unknown,
): Promise<{ ok: boolean; error?: string }> {
  const user = await getCurrentUser();
  if (!user) {
    return { ok: false, error: "You must be signed in to contact support." };
  }

  const parsed = schema.safeParse(input);
  if (!parsed.success) {
    return { ok: false, error: parsed.error.issues[0]?.message ?? "Invalid input" };
  }

  const { subject, message } = parsed.data;
  // Identity comes from the authenticated session, never from client input —
  // a support request can't be used to spoof another user's name/email.
  const { name, email } = user;

  const to = process.env.ADMIN_EMAIL ?? "hello@karoslabs.com";

  const safeMessage = message.replace(/</g, "&lt;").replace(/>/g, "&gt;");
  const html = `
    <div style="font-family:-apple-system,Segoe UI,Roboto,Helvetica,Arial,sans-serif;background:#07090b;padding:32px;color:#e8f0ec;">
      <div style="max-width:600px;margin:0 auto;background:#0d1117;border:1px solid #20303a;border-radius:16px;overflow:hidden;">
        <div style="padding:20px 28px;border-bottom:1px solid #20303a;display:flex;align-items:center;gap:10px;">
          <span style="color:#FF6B2C;font-weight:700;font-size:18px;letter-spacing:0.4px;">Karos<span style="color:#e8f0ec;">CMO</span></span>
          <span style="color:#5f7177;font-size:13px;">&#8250; Support Request</span>
        </div>
        <div style="padding:28px;">
          <table style="border-collapse:collapse;margin-bottom:20px;">
            <tr>
              <td style="padding:5px 16px 5px 0;color:#9c9ca3;font-size:13px;white-space:nowrap;">From</td>
              <td style="padding:5px 0;font-size:14px;color:#e8f0ec;">${name} &lt;${email}&gt;</td>
            </tr>
            <tr>
              <td style="padding:5px 16px 5px 0;color:#9c9ca3;font-size:13px;">Subject</td>
              <td style="padding:5px 0;font-size:14px;font-weight:600;color:#e8f0ec;">${subject}</td>
            </tr>
          </table>
          <div style="background:#131a22;border:1px solid #20303a;border-radius:12px;padding:20px;font-size:15px;line-height:1.7;white-space:pre-wrap;color:#e8f0ec;">${safeMessage}</div>
          <p style="color:#5f7177;font-size:12px;margin:22px 0 0;">Reply to this email to respond directly to ${name}.</p>
        </div>
      </div>
    </div>`;

  const result = await sendEmail({ to, subject: `[Support] ${subject}`, html, replyTo: email });

  if (!result.ok) {
    // Surface the real delivery error to server logs for diagnosis (bad/missing
    // RESEND_API_KEY, unverified domain, Resend outage) while keeping the client
    // message generic. Never leak provider internals to the browser.
    console.error(
      `[support] Failed to deliver support email from ${email} (to ${to}): ${result.error}`,
    );
    return { ok: false, error: "Failed to send your message. Please try again." };
  }
  return { ok: true };
}
