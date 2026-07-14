import { describe, expect, it } from "vitest";
import { groupIntoCampaignCapsules, assetScheduleTime } from "../campaign-capsules";
import type { Asset } from "../types";

let seq = 0;
function asset(patch: Partial<Asset> = {}): Asset {
  seq += 1;
  return {
    id: `a${seq}`,
    clientId: "c1",
    type: "social_post",
    title: `Asset ${seq}`,
    content: "body",
    status: "scheduled",
    createdBy: "u1",
    createdAt: seq,
    updatedAt: seq,
    ...patch,
  } as Asset;
}

describe("assetScheduleTime", () => {
  it("prefers scheduledAt, then recommendedAt, then publishedAt, else null", () => {
    expect(assetScheduleTime(asset({ scheduledAt: 100, recommendedAt: 200 }))).toBe(100);
    expect(assetScheduleTime(asset({ recommendedAt: 200, publishedAt: 300 }))).toBe(200);
    expect(assetScheduleTime(asset({ publishedAt: 300 }))).toBe(300);
    expect(assetScheduleTime(asset({}))).toBeNull();
  });
});

describe("groupIntoCampaignCapsules", () => {
  it("separates campaign assets from standalone ones", () => {
    const { capsules, ungrouped } = groupIntoCampaignCapsules([
      asset({ campaignId: "camp1", campaignTitle: "Launch", scheduledAt: 10 }),
      asset({}), // standalone
    ]);
    expect(capsules).toHaveLength(1);
    expect(capsules[0].campaignId).toBe("camp1");
    expect(capsules[0].title).toBe("Launch");
    expect(ungrouped).toHaveLength(1);
  });

  it("orders pieces within a capsule by scheduled slot, unscheduled last", () => {
    const { capsules } = groupIntoCampaignCapsules([
      asset({ id: "late", campaignId: "c", scheduledAt: 300 }),
      asset({ id: "none", campaignId: "c" }),
      asset({ id: "early", campaignId: "c", scheduledAt: 100 }),
    ]);
    expect(capsules[0].assets.map((a) => a.id)).toEqual(["early", "late", "none"]);
  });

  it("computes the schedule window and distinct platforms", () => {
    const { capsules } = groupIntoCampaignCapsules([
      asset({ campaignId: "c", scheduledAt: 100, scheduledPlatform: "linkedin" }),
      asset({ campaignId: "c", scheduledAt: 500, scheduledPlatform: "tiktok" }),
      asset({ campaignId: "c", scheduledAt: 300, scheduledPlatform: "linkedin" }),
    ]);
    expect(capsules[0].firstAt).toBe(100);
    expect(capsules[0].lastAt).toBe(500);
    expect(capsules[0].platforms).toEqual(["linkedin", "tiktok"]);
  });

  it("orders capsules by their earliest slot, unscheduled capsules last", () => {
    const { capsules } = groupIntoCampaignCapsules([
      asset({ campaignId: "later", campaignTitle: "L", scheduledAt: 900 }),
      asset({ campaignId: "unsched", campaignTitle: "U" }),
      asset({ campaignId: "earlier", campaignTitle: "E", scheduledAt: 100 }),
    ]);
    expect(capsules.map((c) => c.campaignId)).toEqual(["earlier", "later", "unsched"]);
  });

  it("falls back to a default title when no piece carries a campaignTitle", () => {
    const { capsules } = groupIntoCampaignCapsules([asset({ campaignId: "c", scheduledAt: 1 })]);
    expect(capsules[0].title).toBe("Campaign");
  });

  it("returns nothing to group for an all-standalone list", () => {
    const { capsules, ungrouped } = groupIntoCampaignCapsules([asset({}), asset({})]);
    expect(capsules).toEqual([]);
    expect(ungrouped).toHaveLength(2);
  });
});
