/* eslint-disable @typescript-eslint/no-explicit-any */
import { describe, expect, it } from "vitest";
import { campaignProgress, campaignRows, campaignTone, describeCampaignProgress } from "@/lib/campaign-progress";

/**
 * The list exists to answer one question the detail page cannot: which of
 * these campaigns needs somebody. So the rules under test are about what the
 * strip puts FIRST, and about the one thing it must not do — read
 * `campaign.status`, whose three values cannot separate "four steps waiting
 * for review" from "first step still running".
 */

function task(over: Record<string, any> = {}) {
  return { id: over.id ?? "t1", clientId: "c1", title: "Step", status: "pending", ...over } as any;
}

describe("what the steps say about the campaign", () => {
  it("counts each state the reader can act on", () => {
    const progress = campaignProgress([
      task({ id: "a", status: "completed" }),
      task({ id: "b", status: "review_pending" }),
      task({ id: "c", status: "in_progress" }),
      task({ id: "d", status: "pending", metadata: { executionError: "the model timed out" } }),
    ]);
    expect(progress).toMatchObject({ total: 4, done: 1, awaitingReview: 1, running: 1, failed: 1, notStarted: false });
  });

  it("reads a task the execution engine marked executing as running, not as pending", () => {
    // `metadata.executing` is how the engine says so; a row that only checks
    // `status === "in_progress"` reports a live campaign as untouched.
    expect(campaignProgress([task({ metadata: { executing: true } })]).running).toBe(1);
  });

  it("says a campaign has not started when none of its steps has", () => {
    expect(campaignProgress([task({ id: "a" }), task({ id: "b" })]).notStarted).toBe(true);
  });

  it("is not 'not started' when there are no steps at all", () => {
    // A campaign whose tasks were deleted is a different thing from one that
    // has not begun, and the sentence below says so.
    expect(campaignProgress([]).notStarted).toBe(false);
    expect(describeCampaignProgress(campaignProgress([]))).toMatch(/no steps/);
  });
});

describe("what the line leads with", () => {
  it("puts a failure before everything else", () => {
    const line = describeCampaignProgress(
      campaignProgress([
        task({ id: "a", status: "completed" }),
        task({ id: "b", status: "review_pending" }),
        task({ id: "c", status: "pending", metadata: { executionError: "boom" } }),
      ]),
    );
    expect(line.startsWith("1 failed")).toBe(true);
  });

  it("puts work waiting for a person before work in flight", () => {
    const line = describeCampaignProgress(
      campaignProgress([task({ id: "a", status: "review_pending" }), task({ id: "b", status: "in_progress" })]),
    );
    expect(line.indexOf("waiting for review")).toBeLessThan(line.indexOf("running"));
  });

  it("always ends with the count, so a quiet campaign still says where it is", () => {
    expect(describeCampaignProgress(campaignProgress([task({ status: "completed" })]))).toBe("1 of 1 done");
  });

  it("tones the badge by the same urgency the sentence uses", () => {
    expect(campaignTone(campaignProgress([task({ status: "pending", metadata: { executionError: "x" } })]))).toBe("warning");
    expect(campaignTone(campaignProgress([task({ status: "review_pending" })]))).toBe("info");
    expect(campaignTone(campaignProgress([task({ status: "in_progress" })]))).toBe("neon");
    expect(campaignTone(campaignProgress([task({ status: "completed" })]))).toBe("success");
  });
});

describe("assembling the list", () => {
  const campaign = (over: Record<string, any> = {}) =>
    ({ id: "camp1", clientId: "c1", title: "Q4 push", themeScope: "AI-first ops", targetWeek: "2026-W40", taskIds: ["a"], assetIds: [], createdBy: "u1", createdAt: 1, updatedAt: 1, ...over }) as any;

  it("puts the newest campaign first", () => {
    const rows = campaignRows(
      [campaign({ id: "old", createdAt: 1 }), campaign({ id: "new", createdAt: 9 })],
      new Map([["a", task({ id: "a", status: "completed" })]]),
    );
    expect(rows.map((r) => r.campaign.id)).toEqual(["new", "old"]);
  });

  it("drops a step whose task is gone rather than counting it as outstanding", () => {
    // The detail page does the same. A deleted task is not work waiting for
    // anybody, and counting it would make every old campaign look stuck.
    const rows = campaignRows([campaign({ taskIds: ["a", "vanished"] })], new Map([["a", task({ id: "a", status: "completed" })]]));
    expect(rows[0]!.progress).toMatchObject({ total: 1, done: 1 });
  });
});
