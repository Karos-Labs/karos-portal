"use server";

import { z } from "zod";
import { getCurrentUser } from "@/lib/auth";
import { sendEmail, supportRequestEmail } from "@/lib/email";

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

  // The template escapes every field it is handed (see `supportRequestEmail`).
  // This built its own markup and escaped ONE of the four values it dropped in:
  // `message` became `safeMessage`, while `name`, `email` and `subject` went in
  // raw — so a display name or a subject line carrying markup rendered as
  // markup in a mail the Karos inbox reads as platform-generated. Escaping the
  // other three here would have left the copilot's copy of this same template,
  // three files away, still doing it.
  const result = await sendEmail({
    to,
    subject: `[Support] ${subject}`,
    html: supportRequestEmail({ fromName: name, fromEmail: email, subject, message }),
    replyTo: email,
  });

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
