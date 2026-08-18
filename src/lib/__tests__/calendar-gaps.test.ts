import { describe, expect, it } from "vitest";
import {
  computePlatformGaps,
  gapPlatformNames,
  isCalendarSparse,
  CONTENT_GAP_HORIZON_DAYS,
} from "@/lib/calendar-gaps";
import type { Asset } from "@/lib/types";

const DAY_MS = 24 * 60 * 60 * 1000;
const NOW = 1_700_000_000_000;

function asset(overrides: Partial<Asset>): Pick<Asset, "scheduledAt" | "status" | "scheduledPlatform"> {
  return {
    scheduledAt: NOW + DAY_MS,
    status: "scheduled",
    scheduledPlatform: "linkedin",
    ...overrides,
  } as Pick<Asset, "scheduledAt" | "status" | "scheduledPlatform">;
}

describe("computePlatformGaps", () => {
  it("counts scheduled/approved assets within the horizon, one entry per requested platform", () => {
    const assets = [
      asset({ scheduledPlatform: "linkedin" }),
      asset({ scheduledPlatform: "linkedin" }),
      asset({ scheduledPlatform: "instagram" }),
    ];
    const gaps = computePlatformGaps(assets, ["linkedin", "instagram", "twitter"], NOW);
    expect(gaps).toEqual([
      { platform: "linkedin", scheduledCount: 2 },
      { platform: "instagram", scheduledCount: 1 },
      { platform: "twitter", scheduledCount: 0 },
    ]);
  });

  it("excludes assets outside the [now, horizon) window", () => {
    const past = asset({ scheduledAt: NOW - DAY_MS });
    const farFuture = asset({ scheduledAt: NOW + (CONTENT_GAP_HORIZON_DAYS + 1) * DAY_MS });
    const rightAtNow = asset({ scheduledAt: NOW });
    const gaps = computePlatformGaps([past, farFuture, rightAtNow], ["linkedin"], NOW);
    // Only `rightAtNow` (scheduledAt === now) survives; the boundary is inclusive at `now`.
    expect(gaps).toEqual([{ platform: "linkedin", scheduledCount: 1 }]);
  });

  it("only counts scheduled/approved statuses, never drafts or already-published work", () => {
    const draft = asset({ status: "draft" });
    const published = asset({ status: "published" });
    const approved = asset({ status: "approved" });
    const gaps = computePlatformGaps([draft, published, approved], ["linkedin"], NOW);
    expect(gaps).toEqual([{ platform: "linkedin", scheduledCount: 1 }]);
  });

  it("groups an asset with no scheduledPlatform under 'unassigned', not a requested platform", () => {
    const unassigned = asset({ scheduledPlatform: undefined });
    const gaps = computePlatformGaps([unassigned], ["linkedin"], NOW);
    expect(gaps).toEqual([{ platform: "linkedin", scheduledCount: 0 }]);
  });

  it("respects a custom horizon", () => {
    const inTenDays = asset({ scheduledAt: NOW + 10 * DAY_MS });
    const gaps7 = computePlatformGaps([inTenDays], ["linkedin"], NOW, 7);
    const gaps14 = computePlatformGaps([inTenDays], ["linkedin"], NOW, 14);
    expect(gaps7).toEqual([{ platform: "linkedin", scheduledCount: 0 }]);
    expect(gaps14).toEqual([{ platform: "linkedin", scheduledCount: 1 }]);
  });
});

describe("isCalendarSparse", () => {
  it("is false when there are no platforms to be sparse on", () => {
    expect(isCalendarSparse([])).toBe(false);
  });

  it("is false when every platform has at least one scheduled item", () => {
    expect(
      isCalendarSparse([
        { platform: "linkedin", scheduledCount: 3 },
        { platform: "instagram", scheduledCount: 1 },
      ]),
    ).toBe(false);
  });

  it("is true when any platform has zero", () => {
    expect(
      isCalendarSparse([
        { platform: "linkedin", scheduledCount: 3 },
        { platform: "instagram", scheduledCount: 0 },
      ]),
    ).toBe(true);
  });
});

describe("gapPlatformNames", () => {
  it("returns only the zero-count platforms, in input order", () => {
    const gaps = [
      { platform: "linkedin", scheduledCount: 0 },
      { platform: "instagram", scheduledCount: 2 },
      { platform: "twitter", scheduledCount: 0 },
    ];
    expect(gapPlatformNames(gaps)).toEqual(["linkedin", "twitter"]);
  });

  it("returns an empty array when nothing is sparse", () => {
    expect(gapPlatformNames([{ platform: "linkedin", scheduledCount: 5 }])).toEqual([]);
  });
});
