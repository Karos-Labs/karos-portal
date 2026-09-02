import { describe, expect, it } from "vitest";

import {
  contentThroughput,
  THROUGHPUT_BUCKETS,
  THROUGHPUT_BUCKET_DAYS,
  THROUGHPUT_WINDOW_DAYS,
} from "@/lib/content-throughput";
import { clientDeliveryStamp } from "@/lib/asset-visibility";
import type { Asset } from "@/lib/types";

/**
 * The KPI card's published-content cell, which is what replaced the per-channel
 * list that duplicated "Connected channels".
 *
 * Two of these are disclosure rules rather than arithmetic, and they are the
 * reason this file exists at all:
 *
 *  • IT BUCKETS BY DELIVERY, NEVER BY GENERATION. A week of "daily" posts is
 *    minted in one second, so a chart bucketed by `createdAt` would draw our
 *    batch schedule on the client's own dashboard — the A3/A4 churn rule, which
 *    this repo has had to re-fix on four separate surfaces. Asserted with a
 *    fixture whose two stamps disagree, so the test can tell which one was read.
 *  • IT DOES NOT INVENT A DELTA OUT OF AN EMPTY BASELINE. "0 → 4" is a first
 *    month, not "+400%".
 */

const DAY = 24 * 60 * 60 * 1000;
const NOW = 1_760_000_000_000;

function live(overrides: Partial<Asset> = {}): Asset {
  return {
    id: "a1",
    clientId: "c1",
    title: "Post",
    content: "Body",
    createdBy: "staff-1",
    createdAt: NOW - 200 * DAY,
    updatedAt: NOW - 200 * DAY,
    publishedAt: NOW - 1 * DAY,
    status: "published",
    type: "social_post",
    ...overrides,
  };
}

const at = (daysAgo: number, overrides: Partial<Asset> = {}): Asset =>
  live({ id: `d${daysAgo}`, publishedAt: NOW - daysAgo * DAY, ...overrides });

describe("what content throughput counts", () => {
  it("counts only work that reached an audience", () => {
    const assets: Asset[] = [
      at(1),
      at(2, { status: "delivered" }),
      at(3, { status: "draft" }),
      at(4, { status: "approved" }),
      at(5, { status: "scheduled" }),
    ];
    // Two live, three inventory. The three are the numbers the retired tile row
    // was made of, and counting them here would rebuild it inside a KPI.
    expect(contentThroughput(assets, NOW).count).toBe(2);
  });

  it("splits the two windows at the boundary, and ignores anything older", () => {
    const assets: Asset[] = [
      at(1),
      at(THROUGHPUT_WINDOW_DAYS - 1),
      at(THROUGHPUT_WINDOW_DAYS + 1),
      at(2 * THROUGHPUT_WINDOW_DAYS + 1),
    ];
    const t = contentThroughput(assets, NOW);
    expect(t.count).toBe(2);
    expect(t.previousCount).toBe(1);
  });

  it("drops a stamp in the future rather than counting it as throughput", () => {
    // A scheduling artifact, not a post that went out.
    expect(contentThroughput([at(-3)], NOW).count).toBe(0);
  });
});

describe("the delta", () => {
  it("is a real percentage against the previous window", () => {
    const assets = [at(1), at(2), at(3), at(40), at(41)];
    const t = contentThroughput(assets, NOW);
    expect(t.count).toBe(3);
    expect(t.previousCount).toBe(2);
    expect(t.deltaPct).toBe(50);
  });

  it("is negative when output fell", () => {
    expect(contentThroughput([at(1), at(40), at(41), at(42), at(43)], NOW).deltaPct).toBe(-75);
  });

  it("is null with no baseline, rather than an invented +400%", () => {
    const t = contentThroughput([at(1), at(2), at(3), at(4)], NOW);
    expect(t.previousCount).toBe(0);
    expect(t.deltaPct).toBeNull();
  });

  it("is null on an account with nothing at all, not 0%", () => {
    expect(contentThroughput([], NOW).deltaPct).toBeNull();
  });
});

describe("the weekly bars", () => {
  it("always has the same number of buckets, zeros included", () => {
    // A chart that drops its empty weeks redraws its own x-axis every render,
    // and a quiet fortnight then reads as a busy one.
    const t = contentThroughput([at(1)], NOW);
    expect(t.weekly).toHaveLength(THROUGHPUT_BUCKETS);
    expect(t.weekly.filter((n) => n === 0)).toHaveLength(THROUGHPUT_BUCKETS - 1);
  });

  it("runs oldest first, so the newest week is the rightmost bar", () => {
    const oldest = THROUGHPUT_BUCKETS * THROUGHPUT_BUCKET_DAYS - 1;
    const t = contentThroughput([at(oldest), at(0)], NOW);
    expect(t.weekly[0]).toBe(1);
    expect(t.weekly[THROUGHPUT_BUCKETS - 1]).toBe(1);
  });

  it("keeps a post stamped this instant in the newest bucket", () => {
    // Exact division lands `at === now` one PAST the last bucket; the clamp is
    // what stops today's post falling off today's bar.
    const t = contentThroughput([live({ publishedAt: NOW })], NOW);
    expect(t.weekly[THROUGHPUT_BUCKETS - 1]).toBe(1);
    expect(t.weekly.reduce((a, b) => a + b, 0)).toBe(1);
  });
});

describe("which instant it reads (the churn rule)", () => {
  it("buckets by delivery, not by the generation instant", () => {
    // The batch tell: five posts generated in one second, delivered across
    // five different weeks. Bucketed by `createdAt` this is one tall bar that
    // announces the batch; bucketed by delivery it is the client's cadence.
    const generatedAt = NOW - 1 * DAY;
    const assets = [0, 8, 16, 24].map((daysAgo, i) =>
      live({
        id: `batch-${i}`,
        createdAt: generatedAt,
        updatedAt: generatedAt,
        publishedAt: NOW - daysAgo * DAY,
      }),
    );
    const t = contentThroughput(assets, NOW);
    // Non-vacuity: the fixture's two stamps really do disagree, so a pass here
    // is a statement about WHICH one was read.
    expect(assets.every((a) => a.createdAt !== clientDeliveryStamp(a))).toBe(true);
    expect(t.weekly, "the generation instant was read, not the delivery one").toEqual([
      1, 1, 1, 1,
    ]);
  });

  it("falls back down the same ladder the archive sorts by", () => {
    // No publishedAt: `clientDeliveryStamp` takes updatedAt, then createdAt.
    // Same helper, so a row here and the same row in the archive cannot
    // disagree about when it arrived.
    const noPublishStamp = live({ publishedAt: undefined, updatedAt: NOW - 2 * DAY });
    expect(contentThroughput([noPublishStamp], NOW).count).toBe(1);
    const ancient = live({ publishedAt: undefined, updatedAt: NOW - 200 * DAY });
    expect(contentThroughput([ancient], NOW).count).toBe(0);
  });
});
