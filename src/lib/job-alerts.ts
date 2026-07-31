import "server-only";

import { sendEmail, esc } from "@/lib/email";
import { classifyJobError } from "@/lib/job-error-taxonomy";
import type { Client, Job } from "@/lib/types";

/**
 * Failure-alert recipients, from `ADMIN_EMAILS` (comma-separated).
 *
 * `ADMIN_EMAILS` was documented in `.env.example`/`SETUP.md`/`CLAUDE.md` as
 * the admin contact list but was never actually read by any code — the real
 * admin-bootstrap rule in `src/lib/auth.ts` is "first user ever" or a
 * company-alias email, not this var. This is the first thing that reads it:
 * an explicit, operator-set on-call list for agent-run failures, independent
 * of whoever happens to hold the KAROS_ADMIN role in Firestore today.
 *
 * Exported (not inlined) so recipient parsing is unit-testable without a
 * network call.
 */
export function alertRecipients(): string[] {
  return (process.env.ADMIN_EMAILS ?? "")
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);
}

function appUrl(): string {
  return (process.env.NEXT_PUBLIC_APP_URL ?? "http://localhost:3000").replace(/\/+$/, "");
}

function alertShell(opts: { heading: string; rows: Array<[string, string]>; link: string; linkLabel: string }): string {
  const rowsHtml = opts.rows
    .map(
      ([label, value]) => `
        <tr>
          <td style="padding:4px 12px 4px 0;color:#9c9ca3;font-size:12px;white-space:nowrap;vertical-align:top;">${esc(label)}</td>
          <td style="padding:4px 0;color:#e8f0ec;font-size:13px;">${value}</td>
        </tr>`,
    )
    .join("");
  return `
  <div style="background:#07090b;padding:32px 0;font-family:-apple-system,Segoe UI,Roboto,Helvetica,Arial,sans-serif;">
    <div style="max-width:600px;margin:0 auto;background:#0d1117;border:1px solid #20303a;border-radius:16px;overflow:hidden;">
      <div style="padding:24px 28px;border-bottom:1px solid #20303a;">
        <span style="color:#FF6B2C;font-weight:700;font-size:18px;letter-spacing:0.4px;">Karos<span style="color:#e8f0ec;">CMO</span></span>
      </div>
      <div style="padding:28px;color:#e8f0ec;">
        <h1 style="font-size:20px;margin:0 0 16px;color:#e8f0ec;">${esc(opts.heading)}</h1>
        <table style="border-collapse:collapse;width:100%;">${rowsHtml}</table>
        <a href="${opts.link}" style="display:inline-block;margin-top:20px;padding:10px 18px;background:#39ff88;color:#07120a;font-weight:600;font-size:13px;border-radius:8px;text-decoration:none;">${esc(opts.linkLabel)}</a>
      </div>
    </div>
  </div>`;
}

/**
 * Best-effort (never throws) alert for a `Job` that reached a terminal
 * `"failed"` state — call this, not for `"cancelled"` (a deliberate human
 * stop, not a failure). Fired from the three places a job actually
 * terminalizes to failed: the webhook, and reconcileOneJob's shared missed-
 * webhook path (which backs both the cron sweep and the on-demand refresh).
 */
export async function notifyJobFailure(job: Job, client: Client | null): Promise<void> {
  try {
    const to = alertRecipients();
    if (to.length === 0) return;
    const classified = classifyJobError(job.error);
    const clientLabel = client?.name ?? job.clientId;
    const html = alertShell({
      heading: "Agent run failed",
      rows: [
        ["Client", esc(clientLabel)],
        ["Agent", esc(job.agentName)],
        ["Job ID", `<code style="font-size:12px;">${esc(job.id)}</code>`],
        ...(classified ? [["Reason", esc(classified.label)] as [string, string]] : []),
        ["Raw error", `<span style="color:#aebfc4;">${esc(classified?.raw ?? job.error ?? "Unknown error")}</span>`],
      ],
      link: `${appUrl()}/jobs/${job.id}`,
      linkLabel: "Open Job Control Room",
    });
    const result = await sendEmail({
      to,
      subject: `[Karos Alert] Agent run failed — ${clientLabel} — ${job.agentName}`,
      html,
    });
    // The failure this alert is ABOUT is already recorded on the job; if the
    // alert itself also fails to send, at least leave a server-log breadcrumb
    // (same convention as the existing publish-failure alert in
    // execution-actions.ts) rather than a second silent failure.
    if (!result.ok) {
      console.error(`[job-alerts] Failure alert email for job ${job.id} failed: ${result.error}`);
    }
  } catch (e) {
    console.error("[job-alerts] notifyJobFailure failed:", e);
  }
}

/**
 * Same alert, for a scheduled fire that failed to even produce a `Job` doc
 * (the submission itself was refused, or the per-run block threw) — the
 * literal incident this whole feature was built for: a schedule silently not
 * firing, with nothing else to point at.
 */
export async function notifyScheduleFireFailure(opts: {
  clientId: string;
  clientName?: string;
  agentLabel: string;
  scheduleId: string;
  error: string;
}): Promise<void> {
  try {
    const to = alertRecipients();
    if (to.length === 0) return;
    const clientLabel = opts.clientName ?? opts.clientId;
    const html = alertShell({
      heading: "Scheduled run failed to fire",
      rows: [
        ["Client", esc(clientLabel)],
        ["Agent", esc(opts.agentLabel)],
        ["Schedule ID", `<code style="font-size:12px;">${esc(opts.scheduleId)}</code>`],
        ["Raw error", `<span style="color:#aebfc4;">${esc(opts.error)}</span>`],
      ],
      link: `${appUrl()}/clients/${opts.clientId}/agents`,
      linkLabel: "Open client's agents",
    });
    const result = await sendEmail({
      to,
      subject: `[Karos Alert] Scheduled run failed to fire — ${clientLabel} — ${opts.agentLabel}`,
      html,
    });
    if (!result.ok) {
      console.error(
        `[job-alerts] Fire-failure alert email for schedule ${opts.scheduleId} failed: ${result.error}`,
      );
    }
  } catch (e) {
    console.error("[job-alerts] notifyScheduleFireFailure failed:", e);
  }
}

/**
 * Alert for a copilot chat turn that threw or errored mid-stream (token
 * depletion, provider 5xx, etc.) — the chat route has no Job doc to hang a
 * failure off, so this carries the request's own context directly. Fired
 * from the chat route's `streamText` `onError`, which is the only place that
 * actually sees the thrown error (the text-stream response protocol drops it
 * before it ever reaches the browser).
 */
export async function notifyChatbotFailure(opts: {
  clientId: string;
  clientName?: string;
  userEmail?: string;
  error: string;
  stack?: string;
}): Promise<void> {
  try {
    const to = alertRecipients();
    if (to.length === 0) return;
    const clientLabel = opts.clientName ?? opts.clientId;
    const classified = classifyJobError(opts.error);
    const html = alertShell({
      heading: "Copilot chat error",
      rows: [
        ["Client", esc(clientLabel)],
        ...(opts.userEmail ? [["User", esc(opts.userEmail)] as [string, string]] : []),
        ...(classified ? [["Reason", esc(classified.label)] as [string, string]] : []),
        ["Raw error", `<span style="color:#aebfc4;">${esc(classified?.raw ?? opts.error)}</span>`],
        ...(opts.stack
          ? [["Stack", `<pre style="white-space:pre-wrap;font-size:11px;color:#7a8b90;">${esc(opts.stack.slice(0, 4000))}</pre>`] as [string, string]]
          : []),
      ],
      link: `${appUrl()}/clients/${opts.clientId}`,
      linkLabel: "Open client workspace",
    });
    const result = await sendEmail({
      to,
      subject: `[Karos Alert] Copilot chat error — ${clientLabel}`,
      html,
    });
    if (!result.ok) {
      console.error(`[job-alerts] Chatbot-failure alert email for client ${opts.clientId} failed: ${result.error}`);
    }
  } catch (e) {
    console.error("[job-alerts] notifyChatbotFailure failed:", e);
  }
}
