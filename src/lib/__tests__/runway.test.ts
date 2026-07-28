import { describe, expect, it } from "vitest";
import { computeRunway, FAMILY_PRODUCT, RUNWAY_HORIZON_DAYS } from "@/lib/runway";
import { startOfDayMs } from "@/lib/post-chain";
import type { Asset } from "@/lib/types";

/** Server-local timestamp helper (month 1-based) — keeps the suite TZ-independent. */
function at(y: number, m: number, d: number, h = 0): number {
  return new Date(y, m - 1, d, h, 0, 0, 0).getTime();
}

let seq = 0;
function makeAsset(overrides: Partial<Asset> = {}): Asset {
  seq++;
  return {
    id: `a-${seq}`,
    clientId: "c1",
    title: "Post",
    content: "Body",
    createdBy: "staff",
    createdAt: at(2026, 7, 1),
    updatedAt: at(2026, 7, 1),
    status: "draft",
    type: "instagram_post",
    meta: { source: "lab-import" },
    ...overrides,
  };
}

// NOW = Tue 2026-07-14. The 14-day window [07-14, 07-28) holds weekends on
// 07-18/19 and 07-25/26, so a weekday-only social target = 10 postable days.
const NOW = at(2026, 7, 14, 9);
const SOCIAL_TARGET = 10;

describe("computeRunway — active families", () => {
  it("marks social active from a connected platform even with no assets yet", () => {
    const r = computeRunway([], ["instagram"], NOW);
    expect(r.activeFamilies).toEqual(["social"]);
    expect(r.targetByFamily.social).toBe(SOCIAL_TARGET);
    expect(r.deficitByFamily.social).toBe(SOCIAL_TARGET);
    expect(r.shortFamilies).toEqual(["social"]);
    expect(r.coveredThroughMs).toBeNull();
  });

  it("is empty for a client with no platforms and no assets", () => {
    const r = computeRunway([], [], NOW);
    expect(r.activeFamilies).toEqual([]);
    expect(r.shortFamilies).toEqual([]);
  });

  it("activates email/article only when the client already produces them", () => {
    const r = computeRunway([makeAsset({ type: "email" })], [], NOW);
    expect(r.activeFamilies).toEqual(["email"]);
    expect(r.targetByFamily.email).toBe(2);
  });
});

describe("computeRunway — deficit & coverage", () => {
  it("counts undated backlog drafts as available future candidates", () => {
    const drafts = Array.from({ length: SOCIAL_TARGET }, () => makeAsset({ scheduledAt: undefined }));
    const r = computeRunway(drafts, ["instagram"], NOW);
    expect(r.availableByFamily.social).toBe(SOCIAL_TARGET);
    expect(r.deficitByFamily.social).toBe(0);
    expect(r.shortFamilies).toEqual([]);
  });

  it("reports coveredThroughMs as the furthest upcoming dated post", () => {
    const assets = [
      makeAsset({ status: "scheduled", scheduledAt: at(2026, 7, 16, 11) }),
      makeAsset({ status: "scheduled", scheduledAt: at(2026, 7, 22, 11) }),
      makeAsset({ status: "scheduled", scheduledAt: at(2026, 7, 10, 11) }), // past — ignored
    ];
    const r = computeRunway(assets, ["instagram"], NOW);
    expect(r.coveredThroughMs).toBe(startOfDayMs(at(2026, 7, 22)));
  });

  it("ignores placeholders, reference docs and published posts as future candidates", () => {
    const assets = [
      makeAsset({ publishMode: "placeholder", scheduledAt: at(2026, 7, 20, 11), status: "scheduled" }),
      makeAsset({ templateKey: "template-ideas", scheduledAt: at(2026, 7, 21, 11), status: "scheduled" }),
      makeAsset({ status: "published", publishedAt: at(2026, 7, 20, 11), scheduledAt: at(2026, 7, 20, 11) }),
    ];
    const r = computeRunway(assets, ["instagram"], NOW);
    expect(r.availableByFamily.social).toBe(0);
    expect(r.deficitByFamily.social).toBe(SOCIAL_TARGET);
  });

  it("keeps email short until it has its low-cadence target of upcoming issues", () => {
    const r = computeRunway([makeAsset({ type: "email", scheduledAt: at(2026, 7, 20, 10), status: "scheduled" })], [], NOW);
    expect(r.availableByFamily.email).toBe(1);
    expect(r.deficitByFamily.email).toBe(1); // target 2 − 1
    expect(r.shortFamilies).toEqual(["email"]);
  });
});

describe("runway constants", () => {
  it("exposes a 14-day horizon and the family→product map the cron dispatches", () => {
    expect(RUNWAY_HORIZON_DAYS).toBe(14);
    expect(FAMILY_PRODUCT).toEqual({
      social: "social_post",
      email: "newsletter_issue",
      article: "blog_article",
    });
  });
});
