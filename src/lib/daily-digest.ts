/**
 * THE DAILY DIGEST — the mail a client gets each morning carrying that day's
 * calendar (AF-19).
 *
 * ── DRIVEN BY THE CALENDAR, NOT KEPT IN STEP WITH IT ─────────────────────────
 * The ruling was one source of truth, so this module composes nothing of its
 * own: it is handed `CalendarEntry[]` from `lib/client-calendar` — the same
 * projection the Calendar page renders, redaction boundary and dedupe included —
 * and turns them into rows. "Synced" is therefore not a property anybody has to
 * maintain; there is nothing here that could disagree.
 *
 * ── WHY A LOCKED ROW IS DROPPED RATHER THAN PRINTED ──────────────────────────
 * Today's items are unlocked by definition, and yet the projection is still
 * asked, because "today" is the CLIENT's day and the unlock boundary is the
 * SERVER's (lib/scheduling's stated residual). For a client far enough east,
 * their 08:00 is still yesterday on the server, and an item on their calendar
 * for today has not unlocked yet. `redactLockedAsset` hands those over as a
 * placeholder with the template name for a title, so printing them would mail a
 * row saying nothing. They are dropped instead, which usually empties the day —
 * and an empty day is not sent and leaves no marker, so the hourly cron simply
 * carries the same client to the next hour and sends once the day is real.
 *
 * ── COPY ─────────────────────────────────────────────────────────────────────
 * Client register throughout: "clip", "post", and the calendar's own chip words
 * through `postKindLabel(kind, true)` so the mail cannot name a state the portal
 * does not. Sentence case, no em dash and no spaced hyphen (AF-8) — pinned in
 * daily-digest.test.ts rather than left to a reviewer's eye.
 *
 * No counts of anything but TODAY. The churn rule (A3/A4) is about a client
 * learning the shape of a batch, and a day's own contents are exactly what this
 * mail exists to carry; nothing here reaches past `[startMs, endMs)`.
 */

import { emailShell, html, type Html } from "@/lib/email";
import { paceLaneFor, type PaceLane } from "@/lib/daily-pace";
import { postKindLabel, type CalendarAssetKind } from "@/lib/calendar-kind";
import { stripInlineMarkdown } from "@/lib/doc-render";
import type { CalendarEntry } from "@/lib/client-calendar";

/**
 * The client's local hour the digest goes out at.
 *
 * The cron runs hourly and every client is gated on their own clock, so this is
 * a wall clock in the reader's zone rather than a UTC schedule: 08:00 in Sao
 * Paulo and 08:00 in Tel Aviv are eleven hours apart and both are the morning
 * the mail is for.
 *
 * A FLOOR, not an appointment. The gate is "local hour is at or past this", so a
 * cron tick missed at 08:00 sends at 09:00 rather than skipping the day, and a
 * client whose content only unlocks later in their day still gets the mail that
 * day.
 */
export const DIGEST_SEND_HOUR = 8;

/** One row in the mail. */
export interface DigestRow {
  assetId: string;
  title: string;
  /** The calendar's own chip word for this item, in the client register. */
  stateLabel: string;
  lane: PaceLane;
}

/** A day's rows, split the way the mail prints them. */
export interface DigestContent {
  clips: DigestRow[];
  posts: DigestRow[];
}

/** True when there is nothing to send. */
export function digestIsEmpty(content: DigestContent): boolean {
  return content.clips.length === 0 && content.posts.length === 0;
}

/**
 * Turn a day's calendar entries into the mail's rows.
 *
 * Locked (redacted) entries are dropped here — see the module note. Order is the
 * order the calendar puts them in, which the caller has already sorted by time.
 */
export function digestContentFor(entries: CalendarEntry[]): DigestContent {
  const content: DigestContent = { clips: [], posts: [] };
  for (const entry of entries) {
    if (entry.asset.locked === true) continue;
    const lane = paceLaneFor(entry.asset);
    const row: DigestRow = {
      assetId: entry.asset.id,
      // Titles come straight from an agent, so a leading "#" or "**" is not a
      // title. Same clean the calendar applies to its chips.
      title: cleanTitle(entry.asset.title),
      stateLabel: stateLabelFor(entry.kind),
      lane,
    };
    (lane === "clip" ? content.clips : content.posts).push(row);
  }
  return content;
}

function cleanTitle(title: string): string {
  return stripInlineMarkdown(title.replace(/^#{1,6}\s+/, "")) || title;
}

/** The calendar's word for this chip, in the client's register. Never our own. */
function stateLabelFor(kind: CalendarAssetKind): string {
  return postKindLabel(kind, true);
}

/**
 * "Monday 4 August" in the client's zone.
 *
 * en-GB because its long form has no comma in it, so the subject line reads as
 * one phrase rather than a list. The zone is the client's, so a reader never
 * sees yesterday's date on this morning's mail.
 */
export function digestDateLabel(timeZone: string, atUtcMs: number): string {
  return new Intl.DateTimeFormat("en-GB", {
    timeZone,
    weekday: "long",
    day: "numeric",
    month: "long",
  }).format(new Date(atUtcMs));
}

/** The subject line. Carries the date so a week of these is navigable in an inbox. */
export function digestSubject(dateLabel: string): string {
  return `Your calendar for ${dateLabel}`;
}

function sectionRows(rows: DigestRow[], calendarUrl: string): Html {
  return html`${rows.map(
    (row) => html`<p style="margin:0 0 10px;">
      <a href="${calendarUrl}" style="color:#FF6B2C;font-weight:600;text-decoration:none;">${row.title}</a>
      <span style="color:#9c9ca3;font-size:13px;"> · ${row.stateLabel}</span>
    </p>`,
  )}`;
}

function section(heading: string, rows: DigestRow[], calendarUrl: string): Html {
  if (rows.length === 0) return html``;
  return html`<p style="color:#9c9ca3;font-size:12px;text-transform:uppercase;letter-spacing:0.6px;margin:0 0 8px;">${heading}</p>
    ${sectionRows(rows, calendarUrl)}`;
}

/**
 * The whole mail: subject plus branded body.
 *
 * Every link goes to the calendar, because the calendar is where these items
 * live for a client. There is no per-asset client route in this product (the
 * library redirects a client away), so a link that looked per-item and landed on
 * the same page would be a promise the product cannot keep.
 *
 * NO IMAGES, deliberately, and this is a choice rather than a limitation of the
 * shell: `assetImages` hands back whatever URL the ingest path stored, and its
 * own docstring records the residual that some of those are V4 signed GCS links
 * which expire seven days after their run. A broken image in a mail a client
 * opens every morning is worse than a titled link, and the mail cannot tell the
 * two kinds of URL apart. Titles it is.
 */
export function buildDigestEmail(opts: {
  /** The reader's own name. Empty ⇒ the shell drops the greeting. */
  recipientName: string;
  dateLabel: string;
  content: DigestContent;
  /** Absolute URL of the client's calendar page. */
  calendarUrl: string;
}): { subject: string; html: Html } {
  const { clips, posts } = opts.content;
  const body = html`${section(clips.length === 1 ? "Clip" : "Clips", clips, opts.calendarUrl)}
    ${clips.length > 0 && posts.length > 0
      ? html`<div style="height:1px;background:#20303a;margin:16px 0;"></div>`
      : null}
    ${section(posts.length === 1 ? "Post" : "Posts", posts, opts.calendarUrl)}
    <p style="margin:18px 0 0;">
      <a href="${opts.calendarUrl}" style="color:#FF6B2C;font-weight:600;text-decoration:none;">See your calendar</a>
    </p>`;

  return {
    subject: digestSubject(opts.dateLabel),
    html: emailShell({
      recipientName: opts.recipientName,
      heading: "Today on your calendar",
      intro: `Here is what your calendar holds for ${opts.dateLabel}.`,
      body,
      footer: "Your Karos team set this daily summary up for your account.",
    }),
  };
}
