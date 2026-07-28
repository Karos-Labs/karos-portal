import { describe, expect, it } from "vitest";
import { chainAllowsDay, recommendPublishTime, recommendedScheduleFields } from "@/lib/scheduling";

/** Local-time constructor keeps assertions timezone-independent. */
function local(y: number, m: number, d: number, h = 0, min = 0): number {
  return new Date(y, m, d, h, min, 0, 0).getTime();
}

// 2026-07-06 is a Monday.
const MONDAY_8AM = local(2026, 6, 6, 8);
const FRIDAY_9AM = local(2026, 6, 10, 9);

describe("chainAllowsDay — smart weekend policy", () => {
  // weekday numbers: 0=Sun … 6=Sat
  it("allows every weekday for any platform", () => {
    for (let d = 1; d <= 5; d++) {
      expect(chainAllowsDay("instagram_post", "instagram", d)).toBe(true);
      expect(chainAllowsDay("email", undefined, d)).toBe(true);
    }
  });

  it("blocks weekends for weekday-only platforms and email", () => {
    expect(chainAllowsDay("instagram_post", "instagram", 6)).toBe(false); // Sat
    expect(chainAllowsDay("instagram_post", "instagram", 0)).toBe(false); // Sun
    expect(chainAllowsDay("social_post", "linkedin", 6)).toBe(false);
    expect(chainAllowsDay("email", undefined, 6)).toBe(false);
  });

  it("allows Saturday for YouTube (its engagement window includes it) but not Sunday", () => {
    expect(chainAllowsDay("social_post", "youtube", 6)).toBe(true); // Sat
    expect(chainAllowsDay("social_post", "youtube", 0)).toBe(false); // Sun
  });

  it("fails open for an unclassified type/platform", () => {
    expect(chainAllowsDay("note", undefined, 6)).toBe(true);
  });
});

describe("recommendPublishTime", () => {
  it("returns null for types with no scheduling dimension", () => {
    expect(recommendPublishTime({ assetType: "note", from: MONDAY_8AM })).toBeNull();
  });

  it("picks the next optimal Instagram slot with at least 3h lead", () => {
    const rec = recommendPublishTime({ assetType: "instagram_post", from: MONDAY_8AM });
    expect(rec).not.toBeNull();
    // Monday 08:00 + 3h lead ⇒ first eligible window is Monday 11:00.
    expect(rec!.at).toBe(local(2026, 6, 6, 11));
    expect(rec!.reason).toMatch(/Instagram/);
  });

  it("staggers a batch across successive windows by index", () => {
    const slots = [0, 1, 2].map(
      (i) => recommendPublishTime({ assetType: "instagram_post", index: i, from: MONDAY_8AM })!.at,
    );
    expect(slots[0]).toBe(local(2026, 6, 6, 11)); // Mon 11:00
    expect(slots[1]).toBe(local(2026, 6, 6, 14)); // Mon 14:00
    expect(slots[2]).toBe(local(2026, 6, 7, 11)); // Tue 11:00
    expect(new Set(slots).size).toBe(3);
  });

  it("skips to the platform's active days (LinkedIn is Tue–Thu)", () => {
    const rec = recommendPublishTime({ assetType: "article", from: FRIDAY_9AM });
    // Friday morning ⇒ next LinkedIn window is Tuesday 09:00.
    expect(rec!.at).toBe(local(2026, 6, 14, 9));
    const day = new Date(rec!.at).getDay();
    expect([2, 3, 4]).toContain(day);
  });

  it("honors an explicit platform over the type default", () => {
    const rec = recommendPublishTime({
      assetType: "social_post",
      platform: "twitter",
      from: MONDAY_8AM,
    });
    expect(rec!.reason).toMatch(/Twitter/);
  });

  it("recommends a mid-morning Tue/Wed send for email", () => {
    const rec = recommendPublishTime({ assetType: "email", from: MONDAY_8AM });
    expect(rec!.at).toBe(local(2026, 6, 7, 10)); // Tue 10:00
  });

  it("never recommends a slot in the past or inside the lead window", () => {
    const now = Date.now();
    const rec = recommendPublishTime({ assetType: "instagram_post" });
    expect(rec!.at).toBeGreaterThanOrEqual(now + 3 * 60 * 60 * 1000 - 1000);
  });
});

describe("recommendedScheduleFields", () => {
  it("spreads recommendation fields for schedulable types", () => {
    const fields = recommendedScheduleFields("instagram_post");
    expect(fields).toHaveProperty("recommendedAt");
    expect(fields).toHaveProperty("recommendedReason");
  });

  it("spreads nothing for notes", () => {
    expect(recommendedScheduleFields("note")).toEqual({});
  });
});
