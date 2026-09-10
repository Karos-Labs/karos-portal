import { describe, expect, it } from "vitest";

import {
  DEFAULT_PER_DAY,
  LEGACY_PACE,
  MAX_PER_DAY,
  clampPerDay,
  createDayLedger,
  paceLaneFor,
  resolveDailyPace,
  toStoredPace,
} from "@/lib/daily-pace";
import { planBulkSchedule, type OccupiedDay } from "@/lib/bulk-schedule";
import { CHAIN_SLOT_HOUR, planClientChain, startOfDayMs } from "@/lib/post-chain";
import { computeRunway } from "@/lib/runway";
import type { Asset, ClientDailyPace } from "@/lib/types";

/**
 * AF-19, first half: "two podcast clips per day (instead of one) plus one post
 * per day… Pace is per-client configuration, staff-editable, not a hardcode."
 *
 * TWO PROPERTIES, and the second is the one that protects everyone who is not
 * Pitch by Deel:
 *
 *   1. A CONFIGURED client's day holds `clipsPerDay` clips AND `postsPerDay`
 *      posts, in both planners — the chain (lab-imported and webhook content)
 *      and the bulk clip uploader.
 *   2. An UNCONFIGURED client's calendar is byte-for-byte what it was: one item
 *      a day, whatever kind, which is the single day cursor both planners had.
 *
 * Property 2 is why `configured` exists at all rather than two numbers that
 * default to 1: "one clip and one post a day" is a real pace somebody may want,
 * and it is NOT what every client should silently be moved to on the day this
 * shipped. The pair of tests marked THE DEFAULT below is that guarantee.
 */

const MON = new Date(2026, 7, 3, 9, 0, 0).getTime(); // Monday 3 August 2026, local
const DAY = 24 * 60 * 60 * 1000;

/** The chain's slot for the Nth local day from Monday. */
function slot(dayOffset: number): number {
  const d = new Date(startOfDayMs(MON));
  d.setDate(d.getDate() + dayOffset);
  d.setHours(CHAIN_SLOT_HOUR, 0, 0, 0);
  return d.getTime();
}

/** Which local day offset from Monday an instant falls on. */
function dayOffsetOf(at: number): number {
  return Math.round((startOfDayMs(at) - startOfDayMs(MON)) / DAY);
}

function asset(over: Partial<Asset> & { id: string }): Asset {
  return {
    clientId: "c1",
    type: "social_post",
    title: "Post",
    content: "body",
    status: "draft",
    createdBy: "u1",
    createdAt: 1_000,
    updatedAt: 1_000,
    ...over,
  } as Asset;
}

/** A chain-provenance clip: an orderKey (so it is a candidate) and a video. */
const clip = (id: string, orderKey: string): Asset =>
  asset({ id, orderKey, videoUrl: `https://cdn.test/${id}.mp4`, title: `Clip ${id}` });

/** A chain-provenance written post. */
const post = (id: string, orderKey: string): Asset => asset({ id, orderKey, title: `Post ${id}` });

/* ── the primitives ──────────────────────────────────────────────────── */

describe("a per-day number that reaches a day cursor", () => {
  it("refuses zero, and that is not fussiness", () => {
    // Both planners advance WHILE the lane is full. A ceiling of 0 is a loop
    // with no exit, in a server action and in a cron.
    expect(clampPerDay(0)).toBeNull();
    expect(clampPerDay(-3)).toBeNull();
  });

  it("refuses anything that is not a usable number", () => {
    expect(clampPerDay(Number.NaN)).toBeNull();
    expect(clampPerDay(Number.POSITIVE_INFINITY)).toBeNull();
    expect(clampPerDay("2")).toBeNull();
    expect(clampPerDay(undefined)).toBeNull();
    expect(clampPerDay(null)).toBeNull();
  });

  it("floors a fraction and clamps above the ceiling", () => {
    expect(clampPerDay(2.9)).toBe(2);
    expect(clampPerDay(1000)).toBe(MAX_PER_DAY);
  });
});

describe("resolving a client's stored pace", () => {
  it("THE DEFAULT: nothing stored is the shared day, not one of each", () => {
    for (const stored of [undefined, null, {}, { clipsPerDay: 0 }, { postsPerDay: Number.NaN }]) {
      const resolved = resolveDailyPace(stored as ClientDailyPace | null | undefined);
      expect(resolved).toEqual(LEGACY_PACE);
      expect(resolved.configured).toBe(false);
      expect(resolved.clipsPerDay).toBe(DEFAULT_PER_DAY);
    }
  });

  it("takes one number and defaults the other, which is AF-19's whole edit", () => {
    expect(resolveDailyPace({ clipsPerDay: 2 })).toEqual({
      configured: true,
      clipsPerDay: 2,
      postsPerDay: 1,
    });
  });

  it("stores nothing when both boxes are blank, so clearing them really clears", () => {
    expect(toStoredPace({ clipsPerDay: Number(""), postsPerDay: Number("") })).toBeUndefined();
    expect(toStoredPace({ clipsPerDay: Number("2"), postsPerDay: Number("") })).toEqual({
      clipsPerDay: 2,
    });
  });
});

describe("which lane an asset books", () => {
  it("reads the codebase's one video discriminator, in all its shapes", () => {
    expect(paceLaneFor(asset({ id: "a", videoUrl: "https://cdn.test/a.mp4" }))).toBe("clip");
    expect(paceLaneFor(asset({ id: "b", meta: { videos: ["https://cdn.test/b.mp4"] } }))).toBe("clip");
    expect(
      paceLaneFor(
        asset({ id: "c", meta: { artifacts: [{ url: "https://cdn.test/c.mov", name: "c.mov" }] } }),
      ),
    ).toBe("clip");
    expect(paceLaneFor(asset({ id: "d" }))).toBe("post");
    // An image-only deliverable is a post, not a clip.
    expect(paceLaneFor(asset({ id: "e", imageUrl: "https://cdn.test/e.jpg" }))).toBe("post");
  });
});

describe("the day ledger", () => {
  it("shares one slot a day when nothing is configured", () => {
    const ledger = createDayLedger(LEGACY_PACE);
    ledger.book("post", 0);
    expect(ledger.isFull("post", 0)).toBe(true);
    expect(ledger.isFull("clip", 0), "an unpaced day is full for both lanes").toBe(true);
  });

  it("counts the lanes apart once a pace is stored", () => {
    const ledger = createDayLedger(resolveDailyPace({ clipsPerDay: 2 }));
    ledger.book("post", 0);
    expect(ledger.isFull("post", 0)).toBe(true);
    expect(ledger.isFull("clip", 0)).toBe(false);
    ledger.book("clip", 0);
    expect(ledger.isFull("clip", 0)).toBe(false);
    ledger.book("clip", 0);
    expect(ledger.isFull("clip", 0)).toBe(true);
    expect(ledger.count("clip", 0)).toBe(2);
  });
});

/* ── the chain planner ───────────────────────────────────────────────── */

describe("planClientChain honours the client's pace", () => {
  it("THE DEFAULT: with no pace, a clip and a post never share a day", () => {
    // The exact calendar this planner produced before pace existed. Order key
    // sorts c1, c2, p1 — three items, three consecutive weekdays.
    const assignments = planClientChain(
      [clip("c1", "2026-08-01#01"), clip("c2", "2026-08-01#02"), post("p1", "2026-08-01#03")],
      { now: MON },
    );
    expect(assignments.map((a) => a.scheduledAt)).toEqual([slot(0), slot(1), slot(2)]);
  });

  it("puts two clips and a post on the same day at clipsPerDay 2", () => {
    const assignments = planClientChain(
      [clip("c1", "2026-08-01#01"), clip("c2", "2026-08-01#02"), post("p1", "2026-08-01#03")],
      { now: MON, pace: { clipsPerDay: 2 } },
    );
    // Both clips on Monday, the post on Monday too: three items, one day.
    expect(assignments.map((a) => a.scheduledAt)).toEqual([slot(0), slot(0), slot(0)]);
  });

  it("rolls to the next day once a lane fills, per lane", () => {
    const assignments = planClientChain(
      [
        clip("c1", "2026-08-01#01"),
        clip("c2", "2026-08-01#02"),
        clip("c3", "2026-08-01#03"),
        post("p1", "2026-08-01#04"),
        post("p2", "2026-08-01#05"),
      ],
      { now: MON, pace: { clipsPerDay: 2, postsPerDay: 1 } },
    );
    const byId = new Map(assignments.map((a) => [a.id, dayOffsetOf(a.scheduledAt)]));
    expect(byId.get("c1")).toBe(0);
    expect(byId.get("c2")).toBe(0);
    expect(byId.get("c3"), "the third clip takes the next day").toBe(1);
    expect(byId.get("p1"), "the post lane is untouched by a full clip lane").toBe(0);
    expect(byId.get("p2")).toBe(1);
  });

  it("books an already-dated item in ITS OWN lane, not the whole day", () => {
    // A staff-booked clip on Monday. Unpaced, it fills Monday for everything;
    // paced, it fills only Monday's clip lane.
    const booked = asset({
      id: "booked",
      status: "scheduled",
      scheduledAt: slot(0),
      videoUrl: "https://cdn.test/booked.mp4",
    });

    const unpaced = planClientChain([booked, post("p1", "2026-08-01#01")], { now: MON });
    expect(dayOffsetOf(unpaced[0].scheduledAt)).toBe(1);

    const paced = planClientChain([booked, post("p1", "2026-08-01#01")], {
      now: MON,
      pace: { clipsPerDay: 2 },
    });
    expect(dayOffsetOf(paced[0].scheduledAt)).toBe(0);
  });

  it("stays deterministic: planning its own output emits nothing", () => {
    const input = [clip("c1", "2026-08-01#01"), clip("c2", "2026-08-01#02")];
    const first = planClientChain(input, { now: MON, pace: { clipsPerDay: 2 } });
    const replanned = input.map((a) => {
      const found = first.find((x) => x.id === a.id)!;
      return { ...a, scheduledAt: found.scheduledAt, orderKey: found.orderKey };
    });
    expect(planClientChain(replanned, { now: MON, pace: { clipsPerDay: 2 } })).toEqual([]);
  });
});

/* ── the bulk clip planner ───────────────────────────────────────────── */

describe("planBulkSchedule honours the client's clip pace", () => {
  it("THE DEFAULT: one clip a day, and a dated post still fills the day", () => {
    const occupied: OccupiedDay[] = [{ lane: "post", dayStartMs: startOfDayMs(MON) }];
    const assignments = planBulkSchedule(["a", "b"], {
      startDayMs: MON,
      platform: "tiktok",
      occupied,
    });
    expect(assignments.map((a) => dayOffsetOf(a.scheduledAt))).toEqual([1, 2]);
  });

  it("places clipsPerDay clips a day, and a post no longer blocks them", () => {
    const occupied: OccupiedDay[] = [{ lane: "post", dayStartMs: startOfDayMs(MON) }];
    const assignments = planBulkSchedule(["a", "b", "c"], {
      startDayMs: MON,
      platform: "tiktok",
      pace: resolveDailyPace({ clipsPerDay: 2 }),
      occupied,
    });
    expect(assignments.map((a) => dayOffsetOf(a.scheduledAt))).toEqual([0, 0, 1]);
  });

  it("still refuses a weekend TikTok never posts on", () => {
    // Friday 7 August 2026, three clips at two a day: two on Friday, then Monday.
    const friday = new Date(2026, 7, 7, 9, 0, 0).getTime();
    const assignments = planBulkSchedule(["a", "b", "c"], {
      startDayMs: friday,
      platform: "tiktok",
      pace: resolveDailyPace({ clipsPerDay: 2 }),
    });
    const days = assignments.map((a) => new Date(a.scheduledAt).getDay());
    expect(days).toEqual([5, 5, 1]);
  });
});

/* ── the runway target follows the post lane ─────────────────────────── */

describe("the runway measures against the pace it will be filled at", () => {
  const dated = (id: string, dayOffset: number): Asset =>
    asset({ id, status: "scheduled", scheduledAt: slot(dayOffset) });

  it("THE DEFAULT: an unpaced client's target is one a postable day", () => {
    const base = computeRunway([dated("a", 0)], ["instagram"], MON);
    const paced = computeRunway([dated("a", 0)], ["instagram"], MON, undefined, null);
    expect(paced.targetByFamily.social).toBe(base.targetByFamily.social);
  });

  it("doubles the social target at two posts a day", () => {
    const base = computeRunway([dated("a", 0)], ["instagram"], MON);
    const paced = computeRunway([dated("a", 0)], ["instagram"], MON, undefined, {
      postsPerDay: 2,
    });
    expect(paced.targetByFamily.social).toBe(base.targetByFamily.social * 2);
  });

  it("does NOT scale on clips, since the top-up cron cannot produce one", () => {
    const base = computeRunway([dated("a", 0)], ["instagram"], MON);
    const paced = computeRunway([dated("a", 0)], ["instagram"], MON, undefined, {
      clipsPerDay: 3,
    });
    expect(paced.targetByFamily.social).toBe(base.targetByFamily.social);
  });
});
