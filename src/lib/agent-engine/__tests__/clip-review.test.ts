import { describe, expect, it } from "vitest";
import { CLIP_REVIEW_KEYS, describeBudgetPlan, describeDiscovery, describeLicenseConfidence, formatClipDuration, formatUsd, readClipReview, summarisePlateSources } from "../clip-review";

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
  repick: { beats: [2], note: "beat 2 re-sourced after the visual QA scored the footage under 5; the re-render still names beat 2" },
  sourceNotes: ["user-asset: no media attached to this run", "web-harvest: content_fail (no allowed source yielded a usable video)", 7],
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
    expect(review.repick).toEqual({ beats: [2], note: "beat 2 re-sourced after the visual QA scored the footage under 5; the re-render still names beat 2" });
    expect(review.sourceNotes).toEqual(["user-asset: no media attached to this run", "web-harvest: content_fail (no allowed source yielded a usable video)"]);
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
    for (const key of ["videoUrl", "gcsUri", "clipPath", "durationSeconds", "costSoFarUsd", "estimatedCostUsd", "maxCostUsd", "budgetPlan", "replans", "plateSources", "music", "repick", "sourceNotes", "visualQa", "flagged", "script", "format", "sourceTier", "voiceover"]) {
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

/**
 * RFC-25 provenance, and the repair ledger that was already on the wire.
 *
 * The gate payload has carried `contentRepairs` since 2026-09 and `sourceFit`
 * / `discovery` / `licenseConfidence` since 2026-09-20. None of it was read
 * here, so it reached the reviewer through the generic fallback renderer: an
 * unlabelled fact row and a collapsed JSON blob, beside a badge that said
 * "Flagged by visual QA" whether or not the visual QA had anything to do with
 * it.
 */
const HARVESTED = {
  format: "commentary-clip",
  videoUrl: "https://signed/clip.mp4",
  sourceTier: "web-harvest",
  licenseConfidence: "unknown",
  discovery: "open",
  harvestQuery: "AI marketing budgets podcast",
  sourceUrl: "https://www.youtube.com/watch?v=abc123",
  sourceChannel: "Some Business Podcast",
  sourceTitle: "Ep. 212 — why CFOs stopped believing the efficiency story",
  sourceFit: { score: 3, reason: "A conference keynote where the format wants a conversation.", concerns: ["this is a direct competitor's own show", ""] },
  contentRepairs: [
    { check: "source-fit", action: "unresolved", detail: "the source-fit judge scored this recording 3/10 for this client" },
    { check: "source-credit", action: "appended", detail: "the caption did not credit the source; a credit line was appended" },
    { check: "nothing-actionable" },
  ],
  momentFallback: "the picker returned a window that is not clippable; the first coherent 30s was used",
  momentNotes: ["no figure in the chosen window"],
  targetLanguage: { tag: "en", source: "default", reason: "nothing configured a language", assumed: true },
};

describe("readClipReview — RFC-25 provenance", () => {
  it("reads provenance, the fit verdict and the repair ledger off a harvested clip", () => {
    const review = readClipReview(HARVESTED)!;
    expect(review.licenseConfidence).toBe("unknown");
    expect(review.discovery).toBe("open");
    expect(review.harvestQuery).toBe("AI marketing budgets podcast");
    expect(review.sourceUrl).toBe("https://www.youtube.com/watch?v=abc123");
    expect(review.sourceChannel).toBe("Some Business Podcast");
    expect(review.sourceTitle).toContain("Ep. 212");
    expect(review.sourceFit?.score).toBe(3);
    // The empty-string concern is dropped: a bullet with nothing in it is a
    // row a reviewer reads and learns nothing from.
    expect(review.sourceFit?.concerns).toEqual(["this is a direct competitor's own show"]);
    expect(review.momentFallback).toContain("not clippable");
    expect(review.momentNotes).toEqual(["no figure in the chosen window"]);
    expect(review.targetLanguage).toEqual({ tag: "en", source: "default", reason: "nothing configured a language", assumed: true });
  });

  it("drops a repair with no detail — the detail is the only part a reviewer can act on", () => {
    const review = readClipReview(HARVESTED)!;
    expect(review.contentRepairs).toHaveLength(2);
    expect(review.contentRepairs?.map((r) => r.check)).toEqual(["source-fit", "source-credit"]);
  });

  it("says WHICH condition raised the flag, because the engine ORs two of them", () => {
    // Repairs only, QA clean: the old badge claimed the visual QA had failed.
    const repaired = readClipReview({ ...HARVESTED, visualQa: { passed: true, evidence: [] }, flagged: true })!;
    expect(repaired.flagged).toBe(true);
    expect(repaired.flagReason).toBe("repairs");

    // QA failed, nothing repaired.
    const qaOnly = readClipReview({ format: "original-short", videoUrl: "https://s/c.mp4", visualQa: { passed: false, evidence: [] } })!;
    expect(qaOnly.flagReason).toBe("visual-qa");

    // Both.
    const both = readClipReview({ ...HARVESTED, visualQa: { passed: false, evidence: [] } })!;
    expect(both.flagReason).toBe("both");

    // Neither — and `flagReason` is then ABSENT rather than a string saying
    // "none", so a badge cannot be rendered off a truthy value that means the
    // opposite.
    const clean = readClipReview({ format: "original-short", videoUrl: "https://s/c.mp4", visualQa: { passed: true, evidence: [] } })!;
    expect(clean.flagged).toBe(false);
    expect(clean).not.toHaveProperty("flagReason");
  });

  it("ignores a licenseConfidence or discovery it does not recognise, rather than rendering it raw", () => {
    const odd = readClipReview({ format: "original-short", videoUrl: "https://s/c.mp4", licenseConfidence: "probably fine", discovery: "vibes" })!;
    expect(odd.licenseConfidence).toBeUndefined();
    expect(odd.discovery).toBeUndefined();
  });

  it("keeps the new keys out of the generic fact grid", () => {
    for (const key of ["licenseConfidence", "discovery", "harvestQuery", "sourceUrl", "sourceChannel", "sourceTitle", "sourceFit", "contentRepairs", "momentFallback", "momentNotes", "targetLanguage"]) {
      expect(CLIP_REVIEW_KEYS.has(key), key).toBe(true);
    }
  });
});

describe("provenance wording", () => {
  it("colours only the case where Approve is a real decision", () => {
    expect(describeLicenseConfidence("unknown").tone).toBe("warning");
    for (const v of ["client-provided", "client-cleared", "stock-licensed"] as const) {
      expect(describeLicenseConfidence(v).tone, v).toBe("neutral");
    }
  });

  it("names each discovery posture in a phrase that fits a sentence", () => {
    expect(describeDiscovery("allowlist")).toContain("source list");
    expect(describeDiscovery("open")).toContain("open web");
    expect(describeDiscovery("pasted")).toContain("pasted");
  });
});
