import { readFileSync } from "node:fs";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import {
  PBD_CLIENT_ID,
  assetMatchKeys,
  buildMatchIndex,
  calendarDays,
  clipObjectPath,
  dayStartForDate,
  deriveClipShape,
  firebaseDownloadUrl,
  matchOne,
  mergeClipFile,
  pairIndexesForOrder,
  planPortalFeed,
  planTotals,
  queueClipsForOrder,
  queueMatchKeys,
  resolveDayCarousel,
  resolveDayClips,
  slotForDate,
  splitLabRun,
  withClipUrl,
  type IgDay,
  type IgQueue,
  type LocalClip,
  type PublishQueue,
  type QueueDay,
  type SentLog,
} from "../../../scripts/sync-pitch-portal-feed";
import { assetVideos } from "@/lib/asset-images";
import { clientCalendarEntries } from "@/lib/client-calendar";
import { paceLaneFor } from "@/lib/daily-pace";
import { CHAIN_SLOT_HOUR, chainSlotForDay, startOfDayMs } from "@/lib/post-chain";
import type { Asset } from "@/lib/types";

/**
 * CD-M / AF-19 — the Pitch by Deel portal-feed sync, pinned against the ACTUAL
 * routine files (`~/The Pitch Auto/portal-feed`).
 *
 * WHY THE FIXTURES ARE VERBATIM. Every entry below is copied out of
 * publish-queue.json, ig-queue.json and sent-log.json unedited — the real
 * `labRun`/`orderKey` strings, the real empty `company` on Lucy Yueting Liu, the
 * real gap at 2026-07-25 where no mail went out. The rule this suite exists to
 * protect is a rule about THOSE files; a fixture rewritten into a tidier shape
 * would pass while the script mis-paired production.
 *
 * THE RULE (portal_daily_email.py, `clips_for_day`): the calendar day the queue
 * calls order N carries queue POSITIONS 2(N-1) and 2(N-1)+1 — that is, the clips
 * the queue calls order 2N-1 and 2N. The queue's own per-entry `date` is a
 * one-clip-a-day artefact and is NOT the day the clip is published on.
 */

/* ── fixtures: publish-queue.json, positions 1..26 ─────────────────── */

function q(
  order: number,
  date: string,
  item: string,
  pool: string,
  person: string,
  company: string,
  show: string,
): QueueDay {
  return {
    order,
    date,
    item,
    pool,
    person,
    company,
    show,
    labRun: `tiktok-agent/2026-07-23-podcast-clips-02#${item}`,
    orderKey: `2026-07-23-podcast-clips-02#${String(order).padStart(3, "0")}`,
  };
}

const QUEUE_DAYS: QueueDay[] = [
  q(1, "2026-07-24", "partner-execs/jamie-dimon-01", "partner-execs", "Jamie Dimon", "J.P. Morgan", "The Axios Show"),
  q(2, "2026-07-25", "judges/alex-bouaziz-01", "judges", "Alex Bouaziz", "Deel", "OutSail"),
  q(3, "2026-07-26", "partner-execs/ben-horowitz-01", "partner-execs", "Ben Horowitz", "a16z", "Invest Like the Best"),
  q(4, "2026-07-27", "partner-execs/george-kurtz-01", "partner-execs", "George Kurtz", "CrowdStrike", "Accel Spotlight On"),
  q(5, "2026-07-28", "partner-execs/ariel-assaraf-01", "partner-execs", "Ariel Assaraf", "Coralogix", "Boardroom Club"),
  q(6, "2026-07-29", "judges/ryan-hoover-01", "judges", "Ryan Hoover", "Weekend Fund", "Angel with Jason Calacanis"),
  q(7, "2026-07-30", "partner-execs/marc-andreessen-01", "partner-execs", "Marc Andreessen", "a16z", "The Joe Rogan Experience"),
  q(8, "2026-07-31", "partner-execs/patrick-collison-01", "partner-execs", "Patrick Collison", "Stripe", "TBPN"),
  q(9, "2026-08-01", "partner-execs/david-fialkow-01", "partner-execs", "David Fialkow", "General Catalyst", "Invested by Aleph"),
  q(10, "2026-08-02", "judges/anish-acharya-01", "judges", "Anish Acharya", "a16z", "The a16z Show"),
  q(11, "2026-08-03", "partner-execs/pedro-arnt-01", "partner-execs", "Pedro Arnt", "dLocal", "Lessons from Leading"),
  q(12, "2026-08-04", "partner-execs/hemant-taneja-01", "partner-execs", "Hemant Taneja", "General Catalyst", "The Generalist"),
  q(13, "2026-08-05", "judges/andrew-d-souza-01", "judges", "Andrew D'Souza", "Boardy", "The Startup CEO Show"),
  q(14, "2026-08-06", "partner-execs/chris-dixon-01", "partner-execs", "Chris Dixon", "a16z", "The Twenty Minute VC (20VC)"),
  q(15, "2026-08-07", "partner-execs/sundar-pichai-01", "partner-execs", "Sundar Pichai", "Google", "Decoder with Nilay Patel"),
  q(16, "2026-08-08", "partner-execs/jack-zhang-01", "partner-execs", "Jack Zhang", "Airwallex", "Founders in Arms"),
  q(17, "2026-08-09", "judges/rajat-bhargava-01", "judges", "Rajat Bhargava", "JumpCloud", "The Tech Icon"),
  q(18, "2026-08-10", "partner-execs/nico-laqua-01", "partner-execs", "Nico Laqua", "Corgi", "Fellows Forum"),
  q(19, "2026-08-11", "partner-execs/yuri-sagalov-01", "partner-execs", "Yuri Sagalov", "General Catalyst", "Build Mode (TechCrunch)"),
  q(20, "2026-08-12", "judges/roxanne-varza-01", "judges", "Roxanne Varza", "Station F", "Slush 2024"),
  q(21, "2026-08-13", "partner-execs/david-ulevitch-01", "partner-execs", "David Ulevitch", "a16z", "Sourcery with Molly O'Shea"),
  // company is EMPTY in the real file. Kept, because a person with no company is
  // a shape the title/report path has to survive.
  q(22, "2026-08-14", "partner-execs/lucy-yueting-liu-01", "partner-execs", "Lucy Yueting Liu", "", "Money Talks (Sifted)"),
  q(23, "2026-08-15", "partner-execs/paul-ahlstrom-02", "partner-execs", "Paul Ahlstrom", "Alta", "Silicon Slopes Show"),
  q(24, "2026-08-16", "judges/charles-gorintin-01", "judges", "Charles Gorintin", "Alan", "alphalist CTO Podcast"),
  q(25, "2026-08-17", "partner-execs/martin-casado-01", "partner-execs", "Martin Casado", "a16z", "Latent Space"),
  q(26, "2026-08-18", "partner-execs/werner-vogels-01", "partner-execs", "Werner Vogels", "AWS", "Tech Talks Daily"),
];

const QUEUE: PublishQueue = { agent: "tiktok-agent", run: "2026-07-23-podcast-clips-02", days: QUEUE_DAYS };

/* ── fixtures: ig-queue.json, days 1..13 ───────────────────────────── */

function ig(order: number, date: string, item: string): IgDay {
  return {
    order,
    date,
    item,
    category: item.split("/")[0],
    labRun: `instagram-agent/2026-07-23-pitch-school-v3#${item}`,
    orderKey: `2026-07-23-pitch-school-v3#${String(order).padStart(3, "0")}`,
  };
}

const IG: IgQueue = {
  agent: "instagram-agent",
  run: "2026-07-23-pitch-school-v3",
  days: [
    ig(1, "2026-07-24", "career-path/justin-mateen"),
    ig(2, "2026-07-25", "pitch-school/tam-sam-som-three-circles"),
    ig(3, "2026-07-26", "winners/alpic"),
    ig(4, "2026-07-27", "on-stage/the-tour-same-two-minutes"),
    ig(5, "2026-07-28", "pitch-school/first-round-truths"),
    ig(6, "2026-07-29", "career-path/george-kurtz"),
    ig(7, "2026-07-30", "winners/smart-bricks"),
    ig(8, "2026-07-31", "pitch-school/clarity-beats-completeness"),
    ig(9, "2026-08-01", "on-stage/berlin-the-room-was-full"),
    ig(10, "2026-08-02", "career-path/alex-bouaziz"),
    ig(11, "2026-08-03", "pitch-school/runway-the-zero-date"),
    ig(12, "2026-08-04", "winners/zeely-ai"),
    ig(13, "2026-08-05", "how-they-won/famnest-london"),
  ],
};

/* ── fixtures: sent-log.json, verbatim ─────────────────────────────── */

const SENT_LOG: SentLog = {
  // Pre-queue, the single-clip mail shape. Outside the queue's date range.
  "2026-07-20": { day: 1, clip: "partner-execs/jamie-dimon-01", ig: "01-london-inside-jpmorgan" },
  "2026-07-22": {
    day: 3,
    clips: ["partner-execs/paul-ahlstrom-01", "partner-execs/swami-sivasubramanian-01"],
    carousel: "19-two-minute-structure",
  },
  "2026-07-24": { day: 1, clips: ["partner-execs/jamie-dimon-01", "judges/alex-bouaziz-01"], carousel: "justin-mateen" },
  // NOTE: no 2026-07-25 entry. No mail went out that day; the rule has to cover it.
  "2026-07-26": { day: 3, clips: ["partner-execs/ariel-assaraf-01", "judges/ryan-hoover-01"], carousel: "alpic" },
  "2026-07-27": {
    day: 4,
    clips: ["partner-execs/marc-andreessen-01", "partner-execs/patrick-collison-01"],
    carousel: "the-tour-same-two-minutes",
    resend_note: "Updated carousel for 27 July.",
  },
  "2026-07-28": { day: 5, clips: ["partner-execs/david-fialkow-01", "judges/anish-acharya-01"], carousel: "first-round-truths" },
  "2026-07-29": { day: 6, clips: ["partner-execs/pedro-arnt-01", "partner-execs/hemant-taneja-01"], carousel: "george-kurtz" },
  "2026-07-30": { day: 7, clips: ["judges/andrew-d-souza-01", "partner-execs/chris-dixon-01"], carousel: "smart-bricks" },
  "2026-07-31": { day: 8, clips: ["partner-execs/sundar-pichai-01", "partner-execs/jack-zhang-01"], carousel: "clarity-beats-completeness" },
  "2026-08-01": { day: 9, clips: ["judges/rajat-bhargava-01", "partner-execs/nico-laqua-01"], carousel: "berlin-the-room-was-full" },
  "2026-08-02": { day: 10, clips: ["partner-execs/yuri-sagalov-01", "judges/roxanne-varza-01"], carousel: "alex-bouaziz" },
  "2026-08-03": { day: 11, clips: ["partner-execs/david-ulevitch-01", "partner-execs/lucy-yueting-liu-01"], carousel: "runway-the-zero-date" },
  "2026-08-04": { day: 12, clips: ["partner-execs/paul-ahlstrom-02", "judges/charles-gorintin-01"], carousel: "zeely-ai" },
  "2026-08-05": { day: 13, clips: ["partner-execs/martin-casado-01", "partner-execs/werner-vogels-01"], carousel: "famnest-london" },
};

/* ── helpers ───────────────────────────────────────────────────────── */

const NOW = new Date(2026, 7, 3, 9, 30, 0).getTime(); // Mon 3 Aug 2026, local
const BUCKET = "karoscmo.firebasestorage.app";

function localClipsFor(days: QueueDay[]): Map<string, LocalClip> {
  return new Map(
    days.map((d) => [
      d.item,
      {
        caption: `Caption for ${d.person}.`,
        about: `Clip from ${d.show}.`,
        mp4Path: `/feed/clips/${d.item}/clip.mp4`,
        mp4Bytes: 12_000_000,
      },
    ]),
  );
}

function bucketFor(days: QueueDay[], opts: { missing?: string[] } = {}) {
  const missing = new Set(opts.missing ?? []);
  return new Map(
    days.map((d) => {
      const objectPath = clipObjectPath(PBD_CLIENT_ID, d.labRun);
      return [
        d.item,
        missing.has(d.item)
          ? { objectPath, exists: false, url: null }
          : {
              objectPath,
              exists: true,
              url: firebaseDownloadUrl(BUCKET, objectPath, `tok-${d.order}`),
              sizeBytes: 12_000_000,
            },
      ];
    }),
  );
}

/**
 * The portal as it stands: ONE clip document per queue POSITION, sitting on that
 * position's own `date` (the one-clip-a-day import), titled with the person,
 * with no video attached. Past days were marked published on their own day.
 */
function existingClipAssets(days: QueueDay[]): Asset[] {
  return days.map((d) => {
    const at = slotForDate(d.date);
    const past = dayStartForDate(d.date) < startOfDayMs(NOW);
    return {
      id: `clip-${d.order}`,
      clientId: PBD_CLIENT_ID,
      type: "social_post",
      title: d.person,
      content: "",
      meta: { source: "lab-import", labRun: d.labRun, agentFolder: "tiktok-agent" },
      imageUrl: null,
      status: past ? "published" : "scheduled",
      scheduledAt: at,
      ...(past ? { publishedAt: at } : {}),
      publishMode: "manual",
      templateKey: "podcast-clips",
      templateName: "Podcast clips",
      orderKey: d.orderKey,
      createdBy: "lab-import-script",
      createdAt: NOW - 1_000_000,
      updatedAt: NOW - 1_000_000,
    } satisfies Asset;
  });
}

function existingCarouselAssets(entries: IgDay[]): Asset[] {
  return entries.map((e) => {
    const at = slotForDate(e.date);
    const past = dayStartForDate(e.date) < startOfDayMs(NOW);
    return {
      id: `ig-${e.order}`,
      clientId: PBD_CLIENT_ID,
      type: "instagram_post",
      title: e.item.split("/")[1],
      content: "Carousel caption.",
      meta: {
        source: "lab-import",
        labRun: e.labRun,
        agentFolder: "instagram-agent",
        images: ["https://firebasestorage.googleapis.com/v0/b/b/o/slide-1.png?alt=media&token=t"],
      },
      imageUrl: "https://firebasestorage.googleapis.com/v0/b/b/o/slide-1.png?alt=media&token=t",
      status: past ? "published" : "scheduled",
      scheduledAt: at,
      ...(past ? { publishedAt: at } : {}),
      publishMode: "manual",
      orderKey: e.orderKey,
      createdBy: "lab-import-script",
      createdAt: NOW - 1_000_000,
      updatedAt: NOW - 1_000_000,
    } satisfies Asset;
  });
}

function plan(overrides: Partial<Parameters<typeof planPortalFeed>[0]> = {}) {
  return planPortalFeed({
    clientId: PBD_CLIENT_ID,
    bucket: BUCKET,
    queue: QUEUE,
    ig: IG,
    sentLog: SENT_LOG,
    assets: [...existingClipAssets(QUEUE_DAYS), ...existingCarouselAssets(IG.days)],
    localClips: localClipsFor(QUEUE_DAYS),
    bucketState: bucketFor(QUEUE_DAYS),
    todayMs: NOW,
    now: NOW,
    ...overrides,
  });
}

/** Fold a plan back into a document set, the way --apply would. */
function applyPlan(assets: Asset[], p: ReturnType<typeof planPortalFeed>): Asset[] {
  const byId = new Map(assets.map((a) => [a.id, { ...a }]));
  let n = 0;
  for (const day of p.days) {
    for (const clip of day.clips) {
      if (clip.kind === "create") {
        const doc = withClipUrl(clip.payload, "https://example.test/late.mp4") as unknown as Asset;
        byId.set(`created-${++n}`, { ...doc, id: `created-${n}` });
      } else if (clip.kind === "update" && clip.assetId) {
        const before = byId.get(clip.assetId)!;
        byId.set(clip.assetId, { ...before, ...(clip.payload as Partial<Asset>) });
      }
    }
    const c = day.carousel;
    if ((c.status === "redate" || c.status === "restatus") && c.assetId) {
      const before = byId.get(c.assetId)!;
      byId.set(c.assetId, { ...before, ...(c.payload as Partial<Asset>) });
    }
  }
  return [...byId.values()];
}

/* ══════════════════════════════════════════════════════════════════ */

describe("the pairing rule", () => {
  it("takes queue positions 2(N-1) and 2(N-1)+1 for a day of order N", () => {
    expect(pairIndexesForOrder(1)).toEqual([0, 1]);
    expect(pairIndexesForOrder(10)).toEqual([18, 19]);
    expect(pairIndexesForOrder(11)).toEqual([20, 21]);
  });

  it("gives day 1 (2026-07-24) Jamie Dimon and Alex Bouaziz", () => {
    expect(queueClipsForOrder(QUEUE_DAYS, 1).map((c) => c.person)).toEqual(["Jamie Dimon", "Alex Bouaziz"]);
  });

  it("gives day 10 (2026-08-02) Yuri Sagalov and Roxanne Varza, not Anish Acharya", () => {
    const pair = queueClipsForOrder(QUEUE_DAYS, 10);
    expect(pair.map((c) => c.person)).toEqual(["Yuri Sagalov", "Roxanne Varza"]);
    // The queue entry whose own `date` is 2026-08-02 is Anish Acharya. That date
    // is the artefact the rule exists to override.
    expect(QUEUE_DAYS.find((d) => d.date === "2026-08-02")?.person).toBe("Anish Acharya");
  });

  it("gives day 11 (2026-08-03) David Ulevitch and Lucy Yueting Liu", () => {
    expect(queueClipsForOrder(QUEUE_DAYS, 11).map((c) => c.person)).toEqual([
      "David Ulevitch",
      "Lucy Yueting Liu",
    ]);
  });

  it("reproduces every sent-log day the queue covers", () => {
    for (const [date, entry] of Object.entries(SENT_LOG)) {
      const day = QUEUE_DAYS.find((d) => d.date === date);
      if (!day || !entry.clips) continue; // pre-queue days
      expect(queueClipsForOrder(QUEUE_DAYS, day.order).map((c) => c.item), date).toEqual(entry.clips);
    }
  });

  it("burns two positions a day, so 26 positions are 13 calendar days", () => {
    expect(calendarDays(QUEUE_DAYS)).toHaveLength(13);
    expect(calendarDays(QUEUE_DAYS).at(-1)?.date).toBe("2026-08-05");
  });

  it("leaves an odd queue with a final single-clip day rather than dropping it", () => {
    const odd = QUEUE_DAYS.slice(0, 5);
    expect(calendarDays(odd)).toHaveLength(3);
    expect(queueClipsForOrder(odd, 3)).toHaveLength(1);
  });
});

describe("the sent-log override", () => {
  it("uses the rule for a day no mail went out on (2026-07-25)", () => {
    const day = QUEUE_DAYS[1];
    const r = resolveDayClips(day, QUEUE_DAYS, SENT_LOG);
    expect(r.source).toBe("queue-rule");
    expect(r.clips.map((c) => c.person)).toEqual(["Ben Horowitz", "George Kurtz"]);
    expect(r.overridesRule).toBe(false);
  });

  it("agrees with the rule on every day both know about", () => {
    for (const day of calendarDays(QUEUE_DAYS)) {
      const r = resolveDayClips(day, QUEUE_DAYS, SENT_LOG);
      expect(r.overridesRule, day.date).toBe(false);
      expect(r.unresolvedSentItems, day.date).toEqual([]);
    }
  });

  it("MIRRORS THE MAIL when a hand re-send named a different pair", () => {
    const resent: SentLog = {
      ...SENT_LOG,
      "2026-07-24": { day: 1, clips: ["judges/ryan-hoover-01", "partner-execs/sundar-pichai-01"] },
    };
    const r = resolveDayClips(QUEUE_DAYS[0], QUEUE_DAYS, resent);
    expect(r.source).toBe("sent-log");
    expect(r.overridesRule).toBe(true);
    expect(r.clips.map((c) => c.person)).toEqual(["Ryan Hoover", "Sundar Pichai"]);
  });

  it("reads the old single-clip mail shape too", () => {
    const old: SentLog = { "2026-07-24": { day: 1, clip: "judges/ryan-hoover-01" } };
    const r = resolveDayClips(QUEUE_DAYS[0], QUEUE_DAYS, old);
    expect(r.source).toBe("sent-log");
    expect(r.clips.map((c) => c.item)).toEqual(["judges/ryan-hoover-01"]);
  });

  it("names an item the queue does not contain instead of guessing at one", () => {
    const stray: SentLog = {
      ...SENT_LOG,
      "2026-07-24": { day: 1, clips: ["partner-execs/jamie-dimon-01", "relevant/who-is-this-99"] },
    };
    const r = resolveDayClips(QUEUE_DAYS[0], QUEUE_DAYS, stray);
    expect(r.unresolvedSentItems).toEqual(["relevant/who-is-this-99"]);
    expect(r.clips.map((c) => c.item)).toEqual(["partner-execs/jamie-dimon-01"]);
  });

  it("falls back to the rule when a log entry resolves to nothing at all", () => {
    const junk: SentLog = { "2026-07-24": { day: 1, clips: ["gone/one", "gone/two"] } };
    const r = resolveDayClips(QUEUE_DAYS[0], QUEUE_DAYS, junk);
    expect(r.source).toBe("queue-rule");
    expect(r.unresolvedSentItems).toEqual(["gone/one", "gone/two"]);
    expect(r.clips.map((c) => c.person)).toEqual(["Jamie Dimon", "Alex Bouaziz"]);
  });
});

describe("the carousel", () => {
  it("matches ig-queue on the DAY, and sent-log records only the folder leaf", () => {
    const r = resolveDayCarousel("2026-08-03", IG.days, SENT_LOG);
    expect(r.entry?.item).toBe("pitch-school/runway-the-zero-date");
    expect(r.sentName).toBe("runway-the-zero-date");
    expect(r.agrees).toBe(true);
  });

  it("agrees on every day the real files share", () => {
    for (const day of calendarDays(QUEUE_DAYS)) {
      expect(resolveDayCarousel(day.date, IG.days, SENT_LOG).agrees, day.date).toBe(true);
    }
  });

  it("reports a disagreement rather than picking a winner", () => {
    const log: SentLog = { ...SENT_LOG, "2026-08-03": { day: 11, carousel: "some-other-carousel" } };
    expect(resolveDayCarousel("2026-08-03", IG.days, log).agrees).toBe(false);
  });
});

describe("bucket path mapping", () => {
  it("puts a clip where the lab importer would have put it", () => {
    expect(clipObjectPath(PBD_CLIENT_ID, QUEUE_DAYS[1].labRun)).toBe(
      "lab-imports/jzgdl738dq7DclAdqky1/tiktok-agent/2026-07-23-podcast-clips-02/judges/alex-bouaziz-01/clip.mp4",
    );
  });

  it("splits a labRun into the run key and the routine's own item id", () => {
    expect(splitLabRun(QUEUE_DAYS[0].labRun)).toEqual({
      runKey: "tiktok-agent/2026-07-23-podcast-clips-02",
      item: "partner-execs/jamie-dimon-01",
    });
  });

  it("mints the same durable download URL shape import-lab-client.ts does", () => {
    expect(firebaseDownloadUrl(BUCKET, "lab-imports/a/b/clip.mp4", "tok")).toBe(
      "https://firebasestorage.googleapis.com/v0/b/karoscmo.firebasestorage.app/o/lab-imports%2Fa%2Fb%2Fclip.mp4?alt=media&token=tok",
    );
  });
});

describe("the day slot", () => {
  it("is the chain's own slot, not a second opinion about it", () => {
    for (const date of ["2026-07-24", "2026-08-03", "2026-11-14"]) {
      expect(slotForDate(date)).toBe(chainSlotForDay(dayStartForDate(date)));
      expect(new Date(slotForDate(date)).getHours()).toBe(CHAIN_SLOT_HOUR);
    }
  });
});

describe("matching, and the idempotence key", () => {
  it("matches on the item id, the labRun and the orderKey, in that order", () => {
    const target = QUEUE_DAYS[3];
    const byLabRun = { meta: { labRun: target.labRun } };
    const byOrderKey = { orderKey: target.orderKey };
    const byMarker = { meta: { portalFeedItem: target.item } };
    expect(assetMatchKeys(byLabRun)).toContain(`item:${target.item}`);
    expect(assetMatchKeys(byOrderKey)).toContain(`orderKey:${target.orderKey}`);
    expect(assetMatchKeys(byMarker)).toEqual([`item:${target.item}`]);
    expect(queueMatchKeys(target)[0]).toBe(`item:${target.item}`);
  });

  it("recognises a document by OUR marker even after a human retitles and re-dates it", () => {
    const target = QUEUE_DAYS[0];
    const mangled: Asset = {
      ...existingClipAssets([target])[0],
      title: "Renamed by hand",
      meta: { portalFeedItem: target.item },
      orderKey: "",
    };
    const index = buildMatchIndex([mangled]);
    expect(matchOne(index, queueMatchKeys(target), new Set()).asset?.id).toBe(mangled.id);
  });

  it("refuses to choose when two documents claim one identity", () => {
    const target = QUEUE_DAYS[0];
    const [a] = existingClipAssets([target]);
    const twin = { ...a, id: "clip-1-copy" };
    const hit = matchOne(buildMatchIndex([a, twin]), queueMatchKeys(target), new Set());
    expect(hit.asset).toBeNull();
    expect(hit.ambiguous?.map((x) => x.id)).toEqual(["clip-1", "clip-1-copy"]);
  });

  it("CONVERGES: applying the plan and re-planning changes nothing", () => {
    const assets = [...existingClipAssets(QUEUE_DAYS), ...existingCarouselAssets(IG.days)];
    const first = plan({ assets });
    expect(planTotals(first).update).toBeGreaterThan(0);

    const after = applyPlan(assets, first);
    const second = plan({ assets: after });
    const t = planTotals(second);
    expect(t.create).toBe(0);
    expect(t.update).toBe(0);
    expect(t.blocked).toBe(0);
    expect(t.unchanged).toBe(t.clipsPlanned);
    expect(t.carouselChanged).toBe(0);
    expect(second.ambiguities).toEqual([]);
  });
});

describe("the plan over the real files", () => {
  it("puts two clips and one carousel on every day", () => {
    const p = plan();
    expect(p.days).toHaveLength(13);
    for (const day of p.days) {
      expect(day.clips, day.date).toHaveLength(2);
      expect(day.carousel.status, day.date).not.toBe("missing");
    }
    expect(p.days[0].clips.map((c) => c.person)).toEqual(["Jamie Dimon", "Alex Bouaziz"]);
    expect(p.days[10].date).toBe("2026-08-03");
    expect(p.days[10].clips.map((c) => c.person)).toEqual(["David Ulevitch", "Lucy Yueting Liu"]);
  });

  it("re-dates the one-a-day documents instead of orphaning them: no surplus, nothing created", () => {
    const p = plan();
    // Every one of the 26 positions has a document already, just on the wrong
    // day, so a correct sync is 26 updates and zero creations.
    expect(planTotals(p).create).toBe(0);
    expect(p.surplus).toEqual([]);
  });

  it("creates the missing partner when a day only has one document", () => {
    const half = existingClipAssets(QUEUE_DAYS.filter((d) => d.order % 2 === 1));
    const p = plan({ assets: [...half, ...existingCarouselAssets(IG.days)] });
    const t = planTotals(p);
    expect(t.create).toBe(13);
    expect(t.update).toBe(13);
    for (const day of p.days) {
      expect(day.clips.map((c) => c.kind), day.date).toEqual(["update", "create"]);
    }
  });

  it("marks days before today posted and today onward scheduled", () => {
    const p = plan();
    const rows = Object.fromEntries(p.days.map((d) => [d.date, d.past]));
    expect(rows["2026-08-02"]).toBe(true);
    expect(rows["2026-08-03"]).toBe(false); // today is scheduled, never back-posted
    expect(rows["2026-08-04"]).toBe(false);

    const created = plan({ assets: existingCarouselAssets(IG.days) });
    const aug2 = created.days.find((d) => d.date === "2026-08-02")!;
    const aug4 = created.days.find((d) => d.date === "2026-08-04")!;
    expect(aug2.clips[0].payload.status).toBe("published");
    expect(aug2.clips[0].payload.publishedAt).toBe(slotForDate("2026-08-02"));
    expect(aug4.clips[0].payload.status).toBe("scheduled");
    expect(aug4.clips[0].payload.publishedAt).toBeUndefined();
    expect(aug4.clips[0].payload.publishMode).toBe("manual");
  });

  it("keeps a document's own hour when it is already on the right day", () => {
    const target = QUEUE_DAYS[0];
    const at = new Date(2026, 6, 24, 8, 15, 0).getTime();
    const odd: Asset = { ...existingClipAssets([target])[0], scheduledAt: at, publishedAt: at };
    const p = plan({ assets: [odd, ...existingCarouselAssets(IG.days)] });
    const action = p.days[0].clips[0];
    expect(action.changes).not.toContain("scheduledAt");
  });

  it("never overwrites a body a human already wrote", () => {
    const target = QUEUE_DAYS[0];
    const edited: Asset = { ...existingClipAssets([target])[0], content: "Hand-written portal copy." };
    const p = plan({ assets: [edited, ...existingCarouselAssets(IG.days)] });
    expect(p.days[0].clips[0].changes).not.toContain("content");
    // ...but an empty one is filled from caption.txt.
    const p2 = plan({ assets: [...existingClipAssets([target]), ...existingCarouselAssets(IG.days)] });
    expect(p2.days[0].clips[0].changes).toContain("content");
    expect(p2.days[0].clips[0].payload.content).toBe("Caption for Jamie Dimon.");
  });

  it("queues an upload only for the clips the bucket is missing", () => {
    const p = plan({
      bucketState: bucketFor(QUEUE_DAYS, { missing: ["judges/alex-bouaziz-01", "judges/ryan-hoover-01"] }),
    });
    expect(p.uploads.map((u) => u.item).sort()).toEqual(["judges/alex-bouaziz-01", "judges/ryan-hoover-01"]);
    expect(p.uploads[0].objectPath).toContain("lab-imports/jzgdl738dq7DclAdqky1/tiktok-agent/");
    expect(planTotals(p).uploadBytes).toBe(24_000_000);
  });

  it("blocks rather than half-writes a clip with no mp4 anywhere", () => {
    const local = localClipsFor(QUEUE_DAYS);
    local.delete("judges/alex-bouaziz-01");
    const p = plan({
      localClips: local,
      bucketState: bucketFor(QUEUE_DAYS, { missing: ["judges/alex-bouaziz-01"] }),
    });
    const blocked = p.days[0].clips[1];
    expect(blocked.kind).toBe("blocked");
    expect(blocked.payload).toEqual({});
    expect(blocked.blockedReason).toContain("clips/judges/alex-bouaziz-01");
  });

  it("copies the client's own asset shape instead of deriving one", () => {
    expect(plan().shape).toMatchObject({
      source: "live-assets",
      type: "social_post",
      templateKey: "podcast-clips",
    });
    // guessAssetType("tiktok-agent") answers "instagram_post"; the documents say
    // otherwise and the documents win.
    expect(deriveClipShape([]).type).toBe("social_post");
    expect(deriveClipShape([]).source).toBe("fallback");
  });
});

describe("the video attachment", () => {
  it("is a durable Firebase URL in meta.files, and assetVideos finds it", () => {
    const p = plan({ assets: existingCarouselAssets(IG.days) });
    const doc = p.days[0].clips[0].payload as unknown as Asset;
    const asset: Asset = { ...doc, id: "new" };
    const videos = assetVideos(asset);
    expect(videos).toHaveLength(1);
    expect(videos[0].url).toContain("firebasestorage.googleapis.com");
    expect(videos[0].url).toContain("alt=media&token=");
    expect(asset.mimeType).toBe("video/mp4");
  });

  it("NEVER writes meta.gcsPath (that would re-sign against the wrong bucket)", () => {
    const p = plan({ assets: existingCarouselAssets(IG.days) });
    for (const day of p.days) {
      for (const clip of day.clips) {
        const meta = (clip.payload.meta ?? {}) as Record<string, unknown>;
        expect(meta.gcsPath, clip.item).toBeUndefined();
      }
    }
  });

  it("books the clip lane, so a 2-clip day needs dailyPace.clipsPerDay 2", () => {
    const p = plan({ assets: existingCarouselAssets(IG.days) });
    const doc = { ...(p.days[0].clips[0].payload as unknown as Asset), id: "new" };
    expect(paceLaneFor(doc)).toBe("clip");
  });

  it("keeps other files in meta.files and replaces only clip.mp4", () => {
    const merged = mergeClipFile(
      [{ name: "caption.txt", url: "u1", bytes: 10 }, { name: "clip.mp4", url: "old", bytes: 1 }],
      { name: "clip.mp4", relPath: "clip.mp4", url: "new", bytes: 99 },
    );
    expect(merged).toEqual([
      { name: "caption.txt", url: "u1", bytes: 10 },
      { name: "clip.mp4", relPath: "clip.mp4", url: "new", bytes: 99 },
    ]);
  });

  it("stitches a just-uploaded URL into a payload written before the object existed", () => {
    const payload = { meta: { files: [{ name: "clip.mp4", relPath: "clip.mp4", url: "", bytes: 5 }] } };
    const out = withClipUrl(payload, "https://firebasestorage.example/x") as {
      meta: { files: Array<{ url: string }> };
    };
    expect(out.meta.files[0].url).toBe("https://firebasestorage.example/x");
    // An already-filled URL is never clobbered.
    expect((withClipUrl(out, "https://other") as typeof out).meta.files[0].url).toBe(
      "https://firebasestorage.example/x",
    );
  });
});

describe("the calendar projection sees both clips", () => {
  const dayEntries = (assets: Asset[], date: string, isClient: boolean) => {
    const from = dayStartForDate(date);
    const to = dayStartForDate(date) + 24 * 60 * 60 * 1000;
    return clientCalendarEntries(assets, { isClient, now: NOW }).filter((e) => e.at >= from && e.at < to);
  };

  it("draws two clips and one carousel on a past day, for a client and for staff", () => {
    const assets = [...existingClipAssets(QUEUE_DAYS), ...existingCarouselAssets(IG.days)];
    const after = applyPlan(assets, plan({ assets }));
    for (const isClient of [true, false]) {
      const entries = dayEntries(after, "2026-08-02", isClient);
      expect(entries, String(isClient)).toHaveLength(3);
      expect(entries.every((e) => e.kind === "published")).toBe(true);
    }
  });

  it("draws two clips and one carousel on a future day, redaction included", () => {
    const assets = [...existingClipAssets(QUEUE_DAYS), ...existingCarouselAssets(IG.days)];
    const after = applyPlan(assets, plan({ assets }));
    const entries = dayEntries(after, "2026-08-04", true);
    expect(entries).toHaveLength(3);
    expect(entries.every((e) => e.kind === "scheduled")).toBe(true);
    // Redacted, but still two separate squares: dedupeCalendarAssets only ever
    // collapses on a shared meta.gcsPath, which this script never writes.
    expect(entries.filter((e) => e.asset.locked)).toHaveLength(3);
  });

  it("draws a freshly created second clip too", () => {
    const half = existingClipAssets(QUEUE_DAYS.filter((d) => d.order % 2 === 1));
    const assets = [...half, ...existingCarouselAssets(IG.days)];
    const after = applyPlan(assets, plan({ assets }));
    expect(dayEntries(after, "2026-08-02", true)).toHaveLength(3);
    expect(dayEntries(after, "2026-08-04", true)).toHaveLength(3);
  });
});

describe("the carousel queue running out is not a fault", () => {
  it("separates 'past the end of the carousel queue' from a real gap", () => {
    // In production this is 71 of 114 days: the clip queue runs to 2026-11-14
    // and the carousel queue to 2026-09-04.
    const short: IgQueue = { ...IG, days: IG.days.slice(0, 3) };
    const p = plan({ ig: short });
    const t = planTotals(p);
    expect(t.carouselOk).toBe(3);
    expect(t.carouselExhausted).toBe(10);
    expect(t.carouselProblem).toBe(0);

    // A hole INSIDE the queue's range is a gap, and reads as one.
    const holed: IgQueue = { ...IG, days: IG.days.filter((d) => d.date !== "2026-07-28") };
    const holedPlan = plan({ ig: holed });
    expect(planTotals(holedPlan).carouselProblem).toBe(1);
    expect(holedPlan.days.find((d) => d.date === "2026-07-28")?.carousel.status).toBe("no-queue-entry");
  });
});

describe("the client guard", () => {
  it("defaults to Pitch by Deel and takes an explicit --client to go anywhere else", () => {
    const src = readFileSync(join(process.cwd(), "scripts/sync-pitch-portal-feed.ts"), "utf8");
    expect(PBD_CLIENT_ID).toBe("jzgdl738dq7DclAdqky1");
    expect(src).toContain('const clientId = clientArg ?? PBD_CLIENT_ID;');
    // The only other way a client id could enter is an env var or a bare
    // positional. Neither exists.
    expect(src).not.toMatch(/process\.env\.[A-Z_]*CLIENT_ID/);
  });

  it("never writes publishMode auto, which is what keeps the publish cron off a synced day", () => {
    const src = readFileSync(join(process.cwd(), "scripts/sync-pitch-portal-feed.ts"), "utf8");
    expect(src).not.toMatch(/publishMode:\s*"auto"/);
    const p = plan({ assets: existingCarouselAssets(IG.days) });
    for (const day of p.days) {
      for (const clip of day.clips) expect(clip.payload.publishMode ?? "manual").toBe("manual");
    }
  });
});

describe("surplus is reported, never resolved", () => {
  it("lists a clip document matching no planned queue entry", () => {
    const stray: Asset = {
      ...existingClipAssets([QUEUE_DAYS[0]])[0],
      id: "stray",
      meta: { source: "lab-import", labRun: "tiktok-agent/2026-07-23-podcast-clips-02#relevant/nobody-99" },
      orderKey: "2026-07-23-podcast-clips-02#999",
    };
    const assets = [...existingClipAssets(QUEUE_DAYS), stray, ...existingCarouselAssets(IG.days)];
    const p = plan({ assets });
    expect(p.surplus.map((s) => s.id)).toEqual(["stray"]);
    // Reported and nothing else: no patch anywhere in the plan touches it.
    const touched = p.days.flatMap((d) => d.clips.map((c) => c.assetId));
    expect(touched).not.toContain("stray");
  });

  it("lists the clip documents left over when the plan is cut short", () => {
    const p = plan({ limitDays: 2 });
    expect(p.days).toHaveLength(2);
    expect(p.surplus).toHaveLength(26 - 4 + (13 - 2)); // 22 clips + 11 carousels
  });
});
