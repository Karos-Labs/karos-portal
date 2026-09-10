import { describe, expect, it } from "vitest";
import { CLIP_REVIEW_KEYS, describeBudgetPlan, formatClipDuration, formatUsd, readClipReview, summarisePlateSources } from "../clip-review";

/** The gate payload agent-engine's tiktok-agent writes since 2026-09-09 (`11-clip-review`), verbatim shape. */
const PAYLOAD = {
  runId: "pubsub-1",
  topic: "The most valuable prize from a pitch competition is not the money",
  topicSource: "discovered",
  lane: "commentary-clip",
  format: "original-short",
  preview: "The money is not the prize. #Founders",
  clipPath: "/tmp/tiktok-agent/pubsub-1/clip-framed.mp4",
  durationSeconds: 31.2,
  sourceTier: "stock",
  voiceover: true,
  revision: 0,
  videoUrl: "https://storage.googleapis.com/bucket/tiktok/acme/pubsub-1/clip.mp4?X-Goog-Signature=abc",
  gcsUri: "gs://bucket/tiktok/acme/pubsub-1/clip.mp4",
  visualQa: {
    passed: false,
    reason: "overall score 4 is below the minimum 7",
    evidence: ["overallScore: 4", "captions.present: true"],
    weakBeats: [{ index: 2, relevance: 3, note: "a concert under a line about a boardroom" }, { index: "x" }],
  },
  flagged: true,
  plateSources: ["stock", "stock", "still", "stock", "stock"],
  costSoFarUsd: 0.163075,
  estimatedCostUsd: 0.21,
  maxCostUsd: 2,
  budgetPlan: "replan",
  replans: 1,
  music: { applied: false, note: "no musicTrackUri in the client's tiktokClips config" },
  script: {
    hook: "We give our winner $1,000,000. But that's the least important part of the prize.",
    format: "text-led",
    beats: [
      { narration: "We give our winner one million dollars.", onScreenText: "The money is not the prize.", visualBrief: "…", seconds: 6 },
      { narration: "What opens the next door is a signal.", onScreenText: "Belief is rationed right now.", visualBrief: "…", seconds: 8 },
    ],
  },
};

describe("readClipReview", () => {
  it("reads the whole 2026-09-09 clip gate payload: playable URL, cost, budget plan, plates, music, QA flag, script beats", () => {
    const review = readClipReview(PAYLOAD)!;
    expect(review).toBeDefined();
    expect(review.videoUrl).toBe(PAYLOAD.videoUrl);
    expect(review.format).toBe("original-short");
    expect(review.sourceTier).toBe("stock");
    expect(review.durationSeconds).toBe(31.2);
    expect(review.voiceover).toBe(true);
    expect(review.costSoFarUsd).toBe(0.163075);
    expect(review.estimatedCostUsd).toBe(0.21);
    expect(review.maxCostUsd).toBe(2);
    expect(review.budgetPlan).toBe("replan");
    expect(review.replans).toBe(1);
    expect(review.plateSources).toEqual(["stock", "stock", "still", "stock", "stock"]);
    expect(review.music).toEqual({ applied: false, note: "no musicTrackUri in the client's tiktokClips config" });
    expect(review.visualQa).toEqual({
      passed: false,
      reason: "overall score 4 is below the minimum 7",
      evidence: ["overallScore: 4", "captions.present: true"],
      weakBeats: [{ index: 2, relevance: 3, note: "a concert under a line about a boardroom" }],
    });
    expect(review.script?.format).toBe("text-led");
    expect(review.flagged).toBe(true);
    expect(review.script?.beats).toHaveLength(2);
    expect(review.script?.beats[0]).toEqual({ narration: "We give our winner one million dollars.", onScreenText: "The money is not the prize.", seconds: 6 });
  });

  it("is not a clip gate without a clip format or a playable URL, and an http:// or gs:// URL is not playable", () => {
    expect(readClipReview({ topic: "x", preview: "a post" })).toBeUndefined();
    expect(readClipReview("nope")).toBeUndefined();
    const gsOnly = readClipReview({ format: "commentary-clip", videoUrl: "gs://bucket/clip.mp4" })!;
    expect(gsOnly.videoUrl).toBeUndefined();
    expect(gsOnly.format).toBe("commentary-clip");
    expect(readClipReview({ format: "original-short", videoUrl: "http://insecure/clip.mp4" })!.videoUrl).toBeUndefined();
  });

  it("an older engine build's payload (no cost fields, no visualQa) renders fewer facts, never an error, and is not flagged", () => {
    const review = readClipReview({ format: "original-short", videoUrl: "https://signed/clip.mp4", durationSeconds: 28 })!;
    expect(review.flagged).toBe(false);
    expect(review.costSoFarUsd).toBeUndefined();
    expect(review.budgetPlan).toBeUndefined();
    expect(review.script).toBeUndefined();
  });

  it("flags on the visual QA verdict even when the engine forgot the flagged key, and ignores an unknown budgetPlan", () => {
    const review = readClipReview({ format: "original-short", visualQa: { passed: false, evidence: [] }, budgetPlan: "mystery" })!;
    expect(review.flagged).toBe(true);
    expect(review.budgetPlan).toBeUndefined();
  });

  it("names every key the block renders itself, so the generic fact grid does not repeat them", () => {
    for (const key of ["videoUrl", "gcsUri", "clipPath", "durationSeconds", "costSoFarUsd", "estimatedCostUsd", "maxCostUsd", "budgetPlan", "replans", "plateSources", "music", "visualQa", "flagged", "script", "format", "sourceTier", "voiceover"]) {
      expect(CLIP_REVIEW_KEYS.has(key), key).toBe(true);
    }
    // The topic stays a generic fact: it is the run's subject, shown for every gate.
    expect(CLIP_REVIEW_KEYS.has("topic")).toBe(false);
    expect(CLIP_REVIEW_KEYS.has("preview")).toBe(false);
  });
});

describe("formatting helpers", () => {
  it("formats a duration the way a play button expects", () => {
    expect(formatClipDuration(31.2)).toBe("0:31");
    expect(formatClipDuration(75)).toBe("1:15");
    expect(formatClipDuration(0)).toBe("0:00");
  });

  it("describes the budget plan in one line", () => {
    expect(describeBudgetPlan({ budgetPlan: "original" })).toBe("Plan fit the ceiling as written.");
    expect(describeBudgetPlan({ budgetPlan: "replan", replans: 2 })).toBe("Re-planned 2 times to fit the ceiling.");
    expect(describeBudgetPlan({ budgetPlan: "stock-only" })).toContain("free stock footage only");
    expect(describeBudgetPlan({ budgetPlan: "stock-only-silent" })).toContain("without a voice");
    expect(describeBudgetPlan({})).toBeUndefined();
  });

  it("formats dollars at the precision the figure needs", () => {
    expect(formatUsd(0)).toBe("$0.00");
    expect(formatUsd(0.003447)).toBe("$0.003447");
    expect(formatUsd(0.163075)).toBe("$0.1631");
    expect(formatUsd(2)).toBe("$2.00");
    expect(formatUsd(14.581522)).toBe("$14.58");
  });

  it("summarises plate sources as counts", () => {
    expect(summarisePlateSources(["stock", "stock", "still", "stock"])).toBe("3 stock, 1 still");
  });
});
