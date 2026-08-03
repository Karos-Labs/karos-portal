/* eslint-disable @typescript-eslint/no-explicit-any */
import { NextRequest } from "next/server";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { clientTimeZone, localDayIn } from "@/lib/client-timezone";
import {
  DIGEST_SEND_HOUR,
  buildDigestEmail,
  digestContentFor,
  digestDateLabel,
  digestIsEmpty,
  digestSubject,
} from "@/lib/daily-digest";
import { clientCalendarEntries } from "@/lib/client-calendar";
import type { Asset, Client } from "@/lib/types";

/**
 * AF-19, second half: "the client receives a DAILY EMAIL from the hello@
 * address carrying that day's two clips and post, with the calendar, synced
 * with the live portal calendar."
 *
 * The ruling made "synced" structural: the mail is DRIVEN BY the calendar. So
 * the interesting assertions here are not that the mail contains a title — they
 * are the four ways a daily mail goes wrong:
 *
 *   · IT ASKS THE WRONG CLOCK. "Today" is the client's, and the server is a
 *     container in UTC. Pinned across two zones on the same instant, where the
 *     DATE itself differs.
 *   · IT SENDS TWICE. The cron ticks hourly; the marker is what makes the
 *     second, third and twelfth tick of a day silent.
 *   · IT SENDS NOTHING TO SAY. An empty day leaves no marker either, so content
 *     that lands at 11:00 still gets its mail at 12:00.
 *   · IT SAYS MORE THAN THE PORTAL DOES. The rows come through the same
 *     projection the Calendar page renders, redaction included.
 */

/* ── whose day it is ─────────────────────────────────────────────────── */

describe("resolving the client's own day", () => {
  // 2026-08-03T23:00Z. In Tokyo that is 08:00 on the FOURTH; in Sao Paulo it is
  // 20:00 on the third. One instant, two different dates.
  const INSTANT = Date.UTC(2026, 7, 3, 23, 0, 0);

  it("reads the date off the client's zone, not the runtime's", () => {
    expect(localDayIn("Asia/Tokyo", INSTANT).dateKey).toBe("2026-08-04");
    expect(localDayIn("America/Sao_Paulo", INSTANT).dateKey).toBe("2026-08-03");
  });

  it("reads the hour off the client's zone, which is what gates the send", () => {
    expect(localDayIn("Asia/Tokyo", INSTANT).hour).toBe(8);
    expect(localDayIn("America/Sao_Paulo", INSTANT).hour).toBe(20);
    // The gate is "at or past", so Tokyo sends on this tick and Sao Paulo has
    // long since sent on an earlier one.
    expect(localDayIn("Asia/Tokyo", INSTANT).hour >= DIGEST_SEND_HOUR).toBe(true);
  });

  it("gives a half-open window that contains its own instant", () => {
    for (const zone of ["Asia/Tokyo", "America/Sao_Paulo", "UTC", "Australia/Adelaide"]) {
      const day = localDayIn(zone, INSTANT);
      expect(INSTANT, zone).toBeGreaterThanOrEqual(day.startMs);
      expect(INSTANT, zone).toBeLessThan(day.endMs);
    }
  });

  it("measures a DST day as the 23 or 25 hours it really is", () => {
    // Adding a fixed 86,400,000 to local midnight would put an 11:00 slot
    // outside its own day on one of these two dates every year.
    const HOUR = 60 * 60 * 1000;
    const spring = localDayIn("America/New_York", Date.UTC(2026, 2, 8, 18, 0, 0));
    const autumn = localDayIn("America/New_York", Date.UTC(2026, 10, 1, 18, 0, 0));
    expect(spring.endMs - spring.startMs).toBe(23 * HOUR);
    expect(autumn.endMs - autumn.startMs).toBe(25 * HOUR);
  });

  it("falls back rather than throwing on a zone somebody typed wrong", () => {
    // This runs inside a cron mailing several clients in one pass, and
    // Intl.DateTimeFormat throws on an unknown id.
    expect(clientTimeZone({ timeZone: "Mars/Olympus" } as Client)).toBe(
      Intl.DateTimeFormat().resolvedOptions().timeZone || "UTC",
    );
    expect(clientTimeZone({ timeZone: "Asia/Tokyo" } as Client)).toBe("Asia/Tokyo");
    expect(() => localDayIn(clientTimeZone({} as Client), INSTANT)).not.toThrow();
  });
});

/* ── the rows ────────────────────────────────────────────────────────── */

function asset(over: Partial<Asset> & { id: string }): Asset {
  return {
    clientId: "c1",
    type: "social_post",
    title: "Post",
    content: "body",
    status: "scheduled",
    createdBy: "u1",
    createdAt: 1_000,
    updatedAt: 1_000,
    ...over,
  } as Asset;
}

describe("turning a day's calendar into the mail's rows", () => {
  const AT = Date.UTC(2026, 7, 3, 11, 0, 0);

  it("splits clips from posts on the same discriminator the pace uses", () => {
    const content = digestContentFor([
      { asset: asset({ id: "c1", videoUrl: "https://cdn.test/c1.mp4", title: "Cut 1" }), kind: "scheduled", at: AT },
      { asset: asset({ id: "c2", videoUrl: "https://cdn.test/c2.mp4", title: "Cut 2" }), kind: "scheduled", at: AT },
      { asset: asset({ id: "p1", title: "The playbook" }), kind: "published", at: AT },
    ]);
    expect(content.clips.map((r) => r.title)).toEqual(["Cut 1", "Cut 2"]);
    expect(content.posts.map((r) => r.title)).toEqual(["The playbook"]);
    expect(digestIsEmpty(content)).toBe(false);
  });

  it("uses the calendar's own words, in the client's register", () => {
    const content = digestContentFor([
      { asset: asset({ id: "p1" }), kind: "published", at: AT },
      { asset: asset({ id: "p2" }), kind: "scheduled", at: AT },
    ]);
    // A client reads "Posted", never "Published" — the register the chip and the
    // detail modal already share.
    expect(content.posts[0].stateLabel).toBe("Posted");
    expect(content.posts[1].stateLabel).toBe("Scheduled post");
  });

  it("drops a row the portal is still hiding rather than mailing a blank", () => {
    // A client far enough east reaches their 08:00 while the server is still on
    // yesterday, so an item on their calendar for today has not unlocked. The
    // projection hands it over redacted; the mail must not print the placeholder.
    const content = digestContentFor([
      { asset: asset({ id: "locked", title: "By The Numbers", locked: true }), kind: "scheduled", at: AT },
    ]);
    expect(digestIsEmpty(content)).toBe(true);
  });

  it("strips the markdown an agent leaves on a title", () => {
    const content = digestContentFor([
      { asset: asset({ id: "p1", title: "## **The playbook**" }), kind: "scheduled", at: AT },
    ]);
    expect(content.posts[0].title).toBe("The playbook");
  });
});

/* ── the mail ────────────────────────────────────────────────────────── */

describe("the mail built from a day's calendar", () => {
  const AT = Date.UTC(2026, 7, 3, 11, 0, 0);
  const content = digestContentFor([
    { asset: asset({ id: "c1", videoUrl: "https://cdn.test/c1.mp4", title: "Cut 1" }), kind: "scheduled", at: AT },
    { asset: asset({ id: "c2", videoUrl: "https://cdn.test/c2.mp4", title: "Cut 2" }), kind: "scheduled", at: AT },
    { asset: asset({ id: "p1", title: "The playbook" }), kind: "published", at: AT },
  ]);
  const CALENDAR = "https://portal.test/calendar";
  const mail = buildDigestEmail({
    recipientName: "Dana",
    dateLabel: digestDateLabel("America/Sao_Paulo", AT),
    content,
    calendarUrl: CALENDAR,
  });
  const markup = String(mail.html);
  /** What a READER sees: the text, with the markup taken out. */
  const readable = markup.replace(/<[^>]*>/g, " ").replace(/&nbsp;/g, " ").replace(/\s+/g, " ");

  it("names the day in the subject, in the client's zone", () => {
    expect(mail.subject).toBe(digestSubject("Monday 3 August"));
    expect(mail.subject).toBe("Your calendar for Monday 3 August");
  });

  it("carries every one of the day's items and its state", () => {
    expect(readable).toContain("Cut 1");
    expect(readable).toContain("Cut 2");
    expect(readable).toContain("The playbook");
    expect(readable).toContain("Posted");
  });

  it("links into the portal, and ends on the calendar", () => {
    expect(markup.match(new RegExp(CALENDAR, "g"))?.length).toBe(4); // 3 rows + the CTA
    expect(readable).toContain("See your calendar");
  });

  it("greets the reader, and drops the greeting when there is no name", () => {
    expect(readable).toContain("Hi Dana,");
    const anonymous = String(
      buildDigestEmail({ recipientName: "", dateLabel: "Monday 3 August", content, calendarUrl: CALENDAR }).html,
    );
    expect(anonymous.replace(/<[^>]*>/g, " ")).not.toContain("Hi ");
  });

  it("obeys the client copy rules a client reads it under (AF-8)", () => {
    // The em dash and the spaced hyphen, asked of the RENDERED TEXT rather than
    // of the source, so a style attribute's hyphens cannot make this red and a
    // dash inside a heading cannot hide from it.
    expect(readable).not.toContain("—");
    expect(readable, "a spaced hyphen between clauses").not.toMatch(/\S[ \t]-[ \t]\S/);
    // And no machinery vocabulary: the mail says clip and post, never the
    // planner's or the database's words.
    for (const word of ["chain", "cron", "asset", "draft", "orderKey", "social_post"]) {
      expect(readable.toLowerCase(), word).not.toContain(word.toLowerCase());
    }
  });

  it("uses the singular heading for a single item", () => {
    const one = digestContentFor([{ asset: asset({ id: "p1", title: "Solo" }), kind: "scheduled", at: AT }]);
    const solo = String(
      buildDigestEmail({ recipientName: "", dateLabel: "Monday 3 August", content: one, calendarUrl: CALENDAR }).html,
    ).replace(/<[^>]*>/g, " ");
    expect(solo).toContain("Post");
    expect(solo).not.toContain("Posts");
  });
});

/* ── the cron ────────────────────────────────────────────────────────── */

const clients: Client[] = [];
const assetsByClient = new Map<string, Asset[]>();
const updates: Array<{ id: string; patch: any }> = [];
let owner: { email: string; name: string } | null = null;
const sentMail: Array<{ to: string | string[]; subject: string; html: unknown }> = [];

vi.mock("server-only", () => ({}));

vi.mock("@/lib/data", () => ({
  listClients: vi.fn(async () => clients),
  listAssets: vi.fn(async (opts?: { clientId?: string }) =>
    opts?.clientId ? (assetsByClient.get(opts.clientId) ?? []) : [],
  ),
  getClientOwner: vi.fn(async () => owner),
  updateClient: vi.fn(async (id: string, patch: any) => {
    updates.push({ id, patch });
    const target = clients.find((c) => c.id === id);
    if (target) Object.assign(target, patch);
  }),
}));

vi.mock("@/lib/email", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/email")>();
  return {
    ...actual,
    sendEmail: vi.fn(async (input: any) => {
      sentMail.push(input);
      return { ok: true, id: "email-1" };
    }),
  };
});

/** 2026-08-03T12:00Z, which is 09:00 in Sao Paulo: past the send hour. */
const NOW = Date.UTC(2026, 7, 3, 12, 0, 0);
const ZONE = "America/Sao_Paulo";

function clientRow(over: Partial<Client> = {}): Client {
  return {
    id: "c1",
    name: "Acme",
    assignedEmployeeIds: [],
    status: "active",
    dailyDigestEnabled: true,
    timeZone: ZONE,
    createdAt: 1_000,
    createdBy: "u1",
    ...over,
  } as Client;
}

/** An item at 11:00 Sao Paulo on 3 August, which is inside that local day. */
function todayItem(over: Partial<Asset> & { id: string }): Asset {
  return asset({ scheduledAt: Date.UTC(2026, 7, 3, 14, 0, 0), ...over });
}

async function runDigest(query = ""): Promise<any> {
  const { GET } = await import("@/app/api/daily-digest/route");
  const res = await GET(new NextRequest(`https://portal.test/api/daily-digest${query}`));
  return res.json();
}

describe("the daily-digest cron", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(NOW);
    clients.length = 0;
    updates.length = 0;
    sentMail.length = 0;
    assetsByClient.clear();
    owner = { email: "dana@acme.test", name: "Dana" };
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("only looks at clients somebody switched on", async () => {
    clients.push(clientRow({ id: "off", dailyDigestEnabled: false }));
    clients.push(clientRow({ id: "paused", status: "paused" }));
    assetsByClient.set("off", [todayItem({ id: "a1" })]);
    assetsByClient.set("paused", [todayItem({ id: "a2" })]);

    const body = await runDigest();
    expect(body.processed).toBe(0);
    expect(sentMail).toHaveLength(0);
  });

  it("sends one mail and marks the local day it sent for", async () => {
    clients.push(clientRow());
    assetsByClient.set("c1", [
      todayItem({ id: "c-1", videoUrl: "https://cdn.test/c1.mp4", title: "Cut 1" }),
      todayItem({ id: "p-1", title: "The playbook" }),
    ]);

    const body = await runDigest();
    expect(body.sent).toBe(1);
    expect(sentMail).toHaveLength(1);
    expect(sentMail[0].to).toBe("dana@acme.test");
    expect(sentMail[0].subject).toBe("Your calendar for Monday 3 August");
    expect(String(sentMail[0].html)).toContain("Cut 1");

    const marker = updates.at(-1)!;
    expect(marker.id).toBe("c1");
    expect(marker.patch.lastDigestSentDay).toBe(localDayIn(ZONE, NOW).startMs);
  });

  it("IDEMPOTENT: the next hourly tick of the same local day sends nothing", async () => {
    clients.push(clientRow());
    assetsByClient.set("c1", [todayItem({ id: "p-1", title: "The playbook" })]);

    await runDigest();
    expect(sentMail).toHaveLength(1);

    // An hour later, same local day. The marker was written onto the row.
    vi.setSystemTime(NOW + 60 * 60 * 1000);
    const second = await runDigest();
    expect(sentMail, "a second mail for one day").toHaveLength(1);
    expect(second.skipped).toBe(1);
    expect(second.results[0].detail).toContain("already sent");
  });

  it("sends again on the NEXT local day", async () => {
    clients.push(clientRow());
    assetsByClient.set("c1", [
      todayItem({ id: "p-1", title: "Monday post" }),
      asset({ id: "p-2", title: "Tuesday post", scheduledAt: Date.UTC(2026, 7, 4, 14, 0, 0) }),
    ]);

    await runDigest();
    vi.setSystemTime(NOW + 24 * 60 * 60 * 1000);
    await runDigest();

    expect(sentMail).toHaveLength(2);
    expect(String(sentMail[0].html)).toContain("Monday post");
    expect(String(sentMail[1].html)).toContain("Tuesday post");
    expect(String(sentMail[1].html), "yesterday's post must not reappear").not.toContain(
      "Monday post",
    );
  });

  it("EMPTY DAY: sends nothing, marks nothing, and says why", async () => {
    clients.push(clientRow());
    // Everything this client has is on other days.
    assetsByClient.set("c1", [
      asset({ id: "p-1", title: "Later", scheduledAt: Date.UTC(2026, 7, 5, 14, 0, 0) }),
    ]);

    const body = await runDigest();
    expect(sentMail).toHaveLength(0);
    expect(updates, "an empty day must leave no marker").toHaveLength(0);
    expect(body.results[0].detail).toContain("no items on the calendar");

    // …so content landing later the same day still gets its mail today.
    assetsByClient.set("c1", [
      asset({ id: "p-1", title: "Later", scheduledAt: Date.UTC(2026, 7, 5, 14, 0, 0) }),
      todayItem({ id: "p-2", title: "Arrived late" }),
    ]);
    vi.setSystemTime(NOW + 3 * 60 * 60 * 1000);
    await runDigest();
    expect(sentMail).toHaveLength(1);
    expect(String(sentMail[0].html)).toContain("Arrived late");
  });

  it("waits for the client's own morning, not the server's", async () => {
    // 09:00 UTC is 06:00 in Sao Paulo, before the send hour, while the same
    // instant is well past it in Tokyo.
    vi.setSystemTime(Date.UTC(2026, 7, 3, 9, 0, 0));
    clients.push(clientRow({ id: "sp", timeZone: "America/Sao_Paulo" }));
    clients.push(clientRow({ id: "jp", timeZone: "Asia/Tokyo" }));
    assetsByClient.set("sp", [todayItem({ id: "a1", title: "Brazil post" })]);
    assetsByClient.set("jp", [todayItem({ id: "a2", title: "Japan post" })]);

    const body = await runDigest();
    expect(sentMail.map((m) => String(m.html).includes("Japan post"))).toEqual([true]);
    const brazil = body.results.find((r: any) => r.clientId === "sp");
    expect(brazil.status).toBe("skipped");
    expect(brazil.detail).toContain("before");
  });

  it("a failed delivery leaves no marker, so the next hour retries", async () => {
    const email = await import("@/lib/email");
    vi.mocked(email.sendEmail).mockResolvedValueOnce({ ok: false, error: "Resend rejected it" });
    clients.push(clientRow());
    assetsByClient.set("c1", [todayItem({ id: "p-1", title: "The playbook" })]);

    const body = await runDigest();
    expect(body.failed).toBe(1);
    expect(updates).toHaveLength(0);
    expect(body.results[0].detail).toBe("Resend rejected it");
  });

  it("says nothing to a workspace with no active seat", async () => {
    owner = null;
    clients.push(clientRow());
    assetsByClient.set("c1", [todayItem({ id: "p-1" })]);

    const body = await runDigest();
    expect(sentMail).toHaveLength(0);
    expect(body.results[0].detail).toContain("no active client seat");
  });

  it("dry run reports the mail it would send and writes nothing", async () => {
    clients.push(clientRow());
    assetsByClient.set("c1", [
      todayItem({ id: "c-1", videoUrl: "https://cdn.test/c1.mp4" }),
      todayItem({ id: "p-1" }),
    ]);

    const body = await runDigest("?dryRun=1");
    expect(sentMail).toHaveLength(0);
    expect(updates).toHaveLength(0);
    expect(body.dryRun).toBe(true);
    expect(body.results[0]).toMatchObject({ clips: 1, posts: 1 });
    expect(body.results[0].detail).toContain("dana@acme.test");
  });

  it("DRIVEN BY THE CALENDAR: the rows are the calendar's own projection", async () => {
    // The claim AF-19 rests on. A draft (never on a client's calendar) and a
    // launch deliverable (never a deliverable) are in this client's assets and
    // must be in neither the calendar nor the mail; the real post is in both.
    const day = todayItem({ id: "p-1", title: "The playbook" });
    const draft = todayItem({ id: "d-1", title: "Internal draft", status: "draft" });
    const launch = todayItem({ id: "l-1", title: "Setup research", meta: { launchDeliverable: true } });
    clients.push(clientRow());
    assetsByClient.set("c1", [day, draft, launch]);

    await runDigest();
    const html = String(sentMail[0].html);

    const onCalendar = clientCalendarEntries([day, draft, launch], { isClient: true, now: NOW });
    expect(onCalendar.map((e) => e.asset.id)).toEqual(["p-1"]);
    expect(html).toContain("The playbook");
    expect(html).not.toContain("Internal draft");
    expect(html).not.toContain("Setup research");
  });
});
