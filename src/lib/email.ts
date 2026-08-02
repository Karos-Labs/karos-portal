import "server-only";

import { Resend } from "resend";

export interface SendEmailInput {
  to: string | string[];
  subject: string;
  /**
   * `Html` is what a template built with the `html` tag below produces. A plain
   * string is still accepted because four senders outside this module hand one
   * over (execution-actions, execution-engine, job-alerts, request-actions) —
   * see the note on `html` for what that costs them.
   */
  html: string | Html;
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
  const from = process.env.EMAIL_FROM || "Karos CMO <donotreply@karoslabs.com>";
  if (!key) {
    return { ok: false, error: "RESEND_API_KEY is not set" };
  }
  try {
    const resend = new Resend(key);
    const { data, error } = await resend.emails.send({
      from,
      to: input.to,
      subject: input.subject,
      html: String(input.html),
      replyTo: input.replyTo,
    });
    if (error) return { ok: false, error: error.message };
    return { ok: true, id: data?.id ?? "" };
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : "Unknown email error" };
  }
}

export function esc(s: string): string {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
}

/**
 * Markup this module built. The class is deliberately NOT exported, so the
 * `html` tag below is the only way to obtain one — there is no `trustedHtml`
 * escape hatch to reach for and no second constructor to audit.
 */
class Markup {
  constructor(private readonly value: string) {}
  toString(): string {
    return this.value;
  }
}

/** The result of the `html` tag. Opaque: only `html` can produce one. */
export type Html = Markup;

/**
 * ESCAPE BY CONSTRUCTION — an HTML email template where every `${}` is escaped
 * unless it is itself an `html` fragment.
 *
 * WHY THIS EXISTS RATHER THAN "escape those three fields too". Both senders of
 * the staff support email escaped the field they EXPECTED to be hostile and
 * interpolated the rest raw: the copilot tool escaped `message` on the very next
 * line while dropping in `client.name` and `user.name ?? user.email`, and
 * sendSupportEmailAction built a `safeMessage` and then interpolated `name`,
 * `email` AND `subject` unescaped. A `<script>`/`<a href>` in a display name
 * therefore rendered inside a mail the recipient reads as platform-generated.
 * Escaping the three named fields fixes today's template and leaves the same
 * bug waiting at the next one, because it asks each author to know which of
 * their values an attacker controls. Here the default is the safe one and
 * markup is what has to be constructed.
 *
 * WHAT IT DOES NOT COVER, stated because the type allows it: `SendEmailInput`
 * still accepts a plain `string`, so the four senders outside this module build
 * their own markup and are unaffected by the tag. Read before claiming they are
 * safe, because they differ:
 *   · execution-actions.ts interpolates the task title, the client name and the
 *     triggering user's name and address RAW;
 *   · request-actions.ts interpolates the company name, website, address and
 *     use-case RAW, from an UNAUTHENTICATED public form;
 *   · execution-engine.ts hand-escapes its two interpolations;
 *   · job-alerts.ts hand-escapes at every CALL SITE, while its own `alertShell`
 *     interpolates the row values and the link raw — the caller-remembers
 *     contract this tag exists to replace, currently honoured.
 * Those files are another fixer's; moving them onto this tag is a separate
 * change, and the first two are the ones that matter.
 *
 * Not an XSS sanitiser: it escapes text into an HTML *text/attribute-value*
 * position, which is where every interpolation in this module's templates sits.
 * It is not safe inside a `<script>` or a bare (unquoted) attribute, and
 * nothing here has either.
 */
export function html(parts: TemplateStringsArray, ...values: unknown[]): Html {
  let out = parts[0] ?? "";
  for (let i = 0; i < values.length; i += 1) {
    out += renderValue(values[i]) + (parts[i + 1] ?? "");
  }
  return new Markup(out);
}

function renderValue(value: unknown): string {
  // An `html` fragment is already escaped — nesting must not double-escape it.
  if (value instanceof Markup) return value.toString();
  // A list of fragments (table rows), so a template can build repeated markup
  // without dropping out of the tag.
  if (Array.isArray(value)) return value.map(renderValue).join("");
  // A conditional row that resolved to nothing renders as nothing, rather than
  // as the words "null"/"undefined".
  if (value === null || value === undefined) return "";
  return esc(String(value));
}

/**
 * THE support request that reaches the Karos inbox — one template, two callers.
 *
 * `sendSupportEmailAction` (the Support form) and the copilot's
 * `sendSupportEmail` tool were two hand-written templates for the same email to
 * the same address, and both carried the same injection. One template means the
 * callers hand over DATA and never markup, which is what makes "did this author
 * remember to escape?" stop being a question anyone has to answer.
 *
 * STAFF COPY, not client copy: the only recipient is `ADMIN_EMAIL`. The client's
 * own identifiers are printed for triage, which is why `client` carries the id
 * as well as the name.
 */
export function supportRequestEmail(opts: {
  fromName: string;
  fromEmail: string;
  subject: string;
  message: string;
  /** Present when the request came from a client workspace (the copilot tool). */
  client?: { name: string; id: string } | null;
}): Html {
  return html`
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
              <td style="padding:5px 0;font-size:14px;color:#e8f0ec;">${opts.fromName} &lt;${opts.fromEmail}&gt;</td>
            </tr>
            ${opts.client
              ? html`<tr>
              <td style="padding:5px 16px 5px 0;color:#9c9ca3;font-size:13px;white-space:nowrap;">Client</td>
              <td style="padding:5px 0;font-size:14px;color:#e8f0ec;">${opts.client.name} (${opts.client.id})</td>
            </tr>`
              : null}
            <tr>
              <td style="padding:5px 16px 5px 0;color:#9c9ca3;font-size:13px;">Subject</td>
              <td style="padding:5px 0;font-size:14px;font-weight:600;color:#e8f0ec;">${opts.subject}</td>
            </tr>
          </table>
          <div style="background:#131a22;border:1px solid #20303a;border-radius:12px;padding:20px;font-size:15px;line-height:1.7;white-space:pre-wrap;color:#e8f0ec;">${opts.message}</div>
          <p style="color:#5f7177;font-size:12px;margin:22px 0 0;">Reply to this email to respond directly to ${opts.fromName}.</p>
        </div>
      </div>
    </div>`;
}

/**
 * Branded HTML wrapper for client-facing deliveries.
 *
 * `body` is typed `Html` rather than `string`: it is the one slot that carries
 * markup, so it is the one slot that has to have been built by the tag. It used
 * to take a string and interpolate it raw beside three hand-`esc`'d fields —
 * the same split-the-difference shape that produced the injection this tag
 * removes.
 */
export function emailShell(opts: {
  clientName: string;
  heading: string;
  intro: string;
  body: Html;
}): Html {
  return html`
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
        <p style="color:#5f7177;font-size:12px;margin:22px 0 0;">Reply to this email to request changes &mdash; your Karos team is on it.</p>
      </div>
    </div>
  </div>`;
}
