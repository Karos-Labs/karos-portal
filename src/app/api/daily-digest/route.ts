import { type NextRequest, NextResponse } from "next/server";
import { getClientOwner, listAssets, listClients, updateClient } from "@/lib/data";
import { sendEmail } from "@/lib/email";
import { requireCronSecret } from "@/lib/cron-auth";
import { calendarEntriesInWindow, clientCalendarEntries } from "@/lib/client-calendar";
import { clientTimeZone, localDayIn } from "@/lib/client-timezone";
import {
  DIGEST_SEND_HOUR,
  buildDigestEmail,
  digestContentFor,
  digestDateLabel,
  digestIsEmpty,
} from "@/lib/daily-digest";

/**
 * Daily digest cron (AF-19).
 *
 * One mail per opted-in client per local day, carrying that day's clips and
 * posts, from the configured EMAIL_FROM address.
 *
 * ── HOURLY, GATED PER CLIENT ─────────────────────────────────────────────────
 * Cloud Scheduler runs this every hour; each client is then gated on THEIR OWN
 * clock (`Client.timeZone`), not the container's. That is the only shape that
 * sends a morning mail to clients in several zones from one job, and it is the
 * F108 contract: never the server's clock. The pattern mirrors `/api/publish` —
 * a cheap tick that mostly finds nothing due.
 *
 * ── IDEMPOTENT BY MARKER, WRITTEN ONLY ON A REAL SEND ────────────────────────
 * `Client.lastDigestSentDay` holds the START of the local day that was sent for.
 * A retry, an overlapping tick or a scheduler replay finds the marker and skips.
 * The marker is written AFTER Resend accepts the mail: a failed send leaves no
 * marker, so the next hour tries again rather than losing the day silently.
 *
 * ── AN EMPTY DAY IS NOT A MAIL ───────────────────────────────────────────────
 * A client with nothing on today's calendar gets nothing, and no marker either,
 * so a day whose content lands at 11:00 still goes out at 12:00. Every skip is
 * named in the response so ops can tell "nothing to send" from "we could not
 * send".
 *
 * ── WHAT IT MAY SAY ──────────────────────────────────────────────────────────
 * The rows come from `lib/client-calendar`, the same projection the Calendar
 * page renders: the client redaction boundary and the duplicate-document dedupe
 * are inside it. So the mail cannot name a post the portal would still be
 * hiding, and it cannot list a document the calendar collapses.
 */
export const maxDuration = 300;

type DigestStatus = "sent" | "skipped" | "failed";

interface ClientResult {
  clientId: string;
  clientName: string;
  status: DigestStatus;
  /** Local day key the decision was made against, e.g. "2026-08-04". */
  day: string;
  /** Why it was skipped or how it failed. Operator copy. */
  detail?: string;
  clips?: number;
  posts?: number;
}

function calendarUrl(): string {
  const base = (process.env.NEXT_PUBLIC_APP_URL ?? "http://localhost:3000").replace(/\/+$/, "");
  return `${base}/calendar`;
}

export async function GET(req: NextRequest) {
  // Auth: Cloud Scheduler sends Authorization: Bearer <CRON_SECRET>. Fails closed
  // in production if CRON_SECRET is unset; open only for local dev convenience.
  const denied = requireCronSecret(req);
  if (denied) return denied;

  // Reports what WOULD go out without sending or marking anything. Same flag
  // /api/runway offers, and the same reason: this cron mails real people.
  const dryRun = new URL(req.url).searchParams.get("dryRun") === "1";

  const now = Date.now();
  const clients = await listClients();
  const enabled = clients.filter((c) => c.dailyDigestEnabled === true && c.status === "active");

  const results: ClientResult[] = [];
  let sent = 0;
  let failed = 0;

  for (const client of enabled) {
    const zone = clientTimeZone(client);
    const day = localDayIn(zone, now);
    const base = { clientId: client.id, clientName: client.name, day: day.dateKey };

    try {
      if (day.hour < DIGEST_SEND_HOUR) {
        results.push({ ...base, status: "skipped", detail: `local hour ${day.hour} is before ${DIGEST_SEND_HOUR}` });
        continue;
      }
      if (client.lastDigestSentDay === day.startMs) {
        results.push({ ...base, status: "skipped", detail: "already sent for this local day" });
        continue;
      }

      // Looked up before the entries below, not after: the mail goes to this
      // ONE person, so their own seat/admin identity is what the personal-
      // content gate has to check — a shared "isClient: true" projection would
      // hand every seat's personal drafts to whichever owner happens to be on
      // file, the same leak class the rest of this projection already guards.
      const owner = await getClientOwner(client.id);
      if (!owner) {
        results.push({ ...base, status: "skipped", detail: "no active client seat to mail" });
        continue;
      }

      const assets = await listAssets({ clientId: client.id });
      // `isClient: true` even though no client is logged in: the AUDIENCE of this
      // mail is the client, so it takes the client projection. Passing the staff
      // one because the caller is a cron would hand a client's inbox the
      // unredacted set, which is the whole class of leak this reuse prevents.
      const entries = clientCalendarEntries(assets, {
        isClient: true,
        now,
        viewer: { role: "CLIENT_USER", seatId: owner.seatId, isGroupAdmin: owner.isGroupAdmin },
      });
      const today = calendarEntriesInWindow(entries, day.startMs, day.endMs);
      const content = digestContentFor(today);

      if (digestIsEmpty(content)) {
        // No marker: content that lands later today still gets its mail today.
        results.push({ ...base, status: "skipped", detail: "no items on the calendar for this local day" });
        continue;
      }

      const mail = buildDigestEmail({
        recipientName: owner.name,
        dateLabel: digestDateLabel(zone, now),
        content,
        calendarUrl: calendarUrl(),
      });

      if (dryRun) {
        results.push({
          ...base,
          status: "skipped",
          detail: `dry run, would mail ${owner.email}`,
          clips: content.clips.length,
          posts: content.posts.length,
        });
        continue;
      }

      const delivery = await sendEmail({ to: owner.email, subject: mail.subject, html: mail.html });
      if (!delivery.ok) {
        failed++;
        results.push({ ...base, status: "failed", detail: delivery.error });
        continue;
      }

      // Marker after delivery, never before: a failure that had already written
      // it would burn the day.
      await updateClient(client.id, { lastDigestSentDay: day.startMs });
      sent++;
      results.push({
        ...base,
        status: "sent",
        clips: content.clips.length,
        posts: content.posts.length,
      });
    } catch (e) {
      failed++;
      results.push({
        ...base,
        status: "failed",
        detail: e instanceof Error ? e.message : "Unknown digest error",
      });
    }
  }

  return NextResponse.json({
    processed: enabled.length,
    sent,
    failed,
    skipped: results.filter((r) => r.status === "skipped").length,
    dryRun,
    results,
  });
}
