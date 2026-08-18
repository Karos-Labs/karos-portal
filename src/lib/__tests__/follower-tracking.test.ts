import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import {
  combinedFollowerSeries,
  followerGrowthPct,
  historyForPlatform,
  resolveFollowerHistory,
  totalFollowers,
} from "../follower-tracking";
import type { ClientFollowerSnapshot } from "../types";

/**
 * THE MOCK IS GONE, AND THAT IS WHAT THIS FILE NOW GUARDS (2026-08).
 *
 * These cases used to assert that `mockFollowerHistory` was deterministic,
 * varied by client and platform, and never went negative — a thorough test of a
 * function whose entire output was invented. It seeded a PRNG with
 * `clientId + platform` and produced a 400–10,000 follower baseline drifting
 * upward 0.1–0.5% a day, and because nothing has ever written to
 * `clientFollowerSnapshots`, that was the number on every client's dashboard.
 *
 * The suite is inverted: the fabrication must stay deleted, and the fallback
 * must stay an empty series rather than quietly growing a second branch.
 */
describe("the fabricated follower history stays deleted", () => {
  const source = readFileSync(path.join(__dirname, "..", "follower-tracking.ts"), "utf8");

  it("exports no mock generator", async () => {
    const mod = await import("../follower-tracking");
    for (const name of ["mockFollowerHistory", "FOLLOWER_MOCK_HISTORY_DAYS"]) {
      expect(Object.keys(mod), `${name} is back`).not.toContain(name);
    }
  });

  it("reaches for no seeded randomness at all", () => {
    // The two helpers every mock generator in this repo is built on, plus the
    // real thing. None of them belongs in a module that reports measurements.
    for (const forbidden of ["mulberry32", "hashSeed", "Math.random"]) {
      expect(source, `follower-tracking.ts references ${forbidden}`).not.toContain(forbidden);
    }
  });
});

describe("historyForPlatform / resolveFollowerHistory", () => {
  const snapshots: ClientFollowerSnapshot[] = [
    { id: "1", clientId: "c1", platform: "instagram", count: 200, capturedAt: 2000 },
    { id: "2", clientId: "c1", platform: "instagram", count: 100, capturedAt: 1000 },
    { id: "3", clientId: "c1", platform: "linkedin", count: 50, capturedAt: 1500 },
  ];

  it("filters to one platform and sorts oldest first", () => {
    expect(historyForPlatform(snapshots, "instagram")).toEqual([
      { capturedAt: 1000, count: 100 },
      { capturedAt: 2000, count: 200 },
    ]);
  });

  it("returns real stored history when there is some", () => {
    expect(resolveFollowerHistory(snapshots, "instagram")).toEqual([
      { capturedAt: 1000, count: 100 },
      { capturedAt: 2000, count: 200 },
    ]);
  });

  it("returns an EMPTY series for a platform with no stored rows", () => {
    // The whole fix, in one assertion: nothing was captured for tiktok, so
    // nothing is reported for tiktok. The widget hides the cell on this.
    expect(resolveFollowerHistory(snapshots, "tiktok")).toEqual([]);
  });

  it("returns an empty series when nothing was ever captured", () => {
    expect(resolveFollowerHistory([], "instagram")).toEqual([]);
  });
});

describe("totalFollowers", () => {
  it("sums each platform's latest (last) point", () => {
    const total = totalFollowers({
      instagram: [{ capturedAt: 1, count: 100 }, { capturedAt: 2, count: 150 }],
      linkedin: [{ capturedAt: 1, count: 40 }],
    });
    expect(total).toBe(190);
  });

  it("is 0 for no platforms", () => {
    expect(totalFollowers({})).toBe(0);
  });

  it("skips a platform with an empty history rather than throwing", () => {
    expect(totalFollowers({ instagram: [] })).toBe(0);
  });
});

describe("combinedFollowerSeries", () => {
  it("sums same-day points across platforms into one series", () => {
    const combined = combinedFollowerSeries({
      instagram: [{ capturedAt: 1000, count: 100 }, { capturedAt: 2000, count: 120 }],
      linkedin: [{ capturedAt: 1000, count: 40 }, { capturedAt: 2000, count: 45 }],
    });
    expect(combined).toEqual([
      { capturedAt: 1000, count: 140 },
      { capturedAt: 2000, count: 165 },
    ]);
  });

  it("sorts by day even when inputs arrive out of order", () => {
    const combined = combinedFollowerSeries({
      instagram: [{ capturedAt: 2000, count: 1 }, { capturedAt: 1000, count: 1 }],
    });
    expect(combined.map((p) => p.capturedAt)).toEqual([1000, 2000]);
  });
});

describe("followerGrowthPct", () => {
  it("is the percent change from the first point to the last", () => {
    expect(
      followerGrowthPct([
        { capturedAt: 1, count: 100 },
        { capturedAt: 2, count: 150 },
      ]),
    ).toBe(50);
  });

  it("is negative when followers dropped", () => {
    expect(
      followerGrowthPct([
        { capturedAt: 1, count: 200 },
        { capturedAt: 2, count: 100 },
      ]),
    ).toBe(-50);
  });

  it("is null with fewer than two points", () => {
    expect(followerGrowthPct([])).toBeNull();
    expect(followerGrowthPct([{ capturedAt: 1, count: 100 }])).toBeNull();
  });

  it("is null when the series starts at zero (division by zero)", () => {
    expect(
      followerGrowthPct([
        { capturedAt: 1, count: 0 },
        { capturedAt: 2, count: 10 },
      ]),
    ).toBeNull();
  });
});
