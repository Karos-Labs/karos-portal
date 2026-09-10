import { describe, expect, it } from "vitest";
import {
  buildProactiveSystemAppendix,
  type BenchmarkEntry,
  type HistoricalBenchmarks,
  type ProactiveSystemContext,
} from "@/lib/ai/prompts/proactive-assistant";

/** Minimal valid context; tests override only `historicalBenchmarks`. */
function ctx(historicalBenchmarks?: HistoricalBenchmarks): ProactiveSystemContext {
  return {
    agents: [],
    linkedSocialPlatforms: ["linkedin"],
    integrations: [{ platform: "linkedin", status: "active" }],
    scheduledNext14ByPlatform: {},
    hasGmailIntegration: false,
    hasScheduledContent: false,
    activeTaskCount: 0,
    maxActiveTasks: 15,
    historicalBenchmarks,
  };
}

const win: BenchmarkEntry = {
  label: "How we cut onboarding time 40%",
  platform: "linkedin",
  assetType: "social_post",
  engagementScore: 92.1,
  impressions: 12_400,
  engagementRate: 0.062,
};
const loss: BenchmarkEntry = {
  label: "Generic company update",
  platform: "tiktok",
  assetType: "social_post",
  engagementScore: 4.3,
  impressions: 800,
  engagementRate: 0.004,
};

describe("buildProactiveSystemAppendix — benchmark injection", () => {
  it("omits the benchmarks block entirely when no analytics exist", () => {
    const out = buildProactiveSystemAppendix(ctx());
    expect(out).not.toContain("HISTORICAL PERFORMANCE BENCHMARKS");
  });

  it("omits the block when sampleSize is 0 even if arrays are present", () => {
    const out = buildProactiveSystemAppendix(ctx({ top: [], bottom: [], sampleSize: 0 }));
    expect(out).not.toContain("HISTORICAL PERFORMANCE BENCHMARKS");
  });

  it("injects a structured benchmarks block when data is present", () => {
    const out = buildProactiveSystemAppendix(
      ctx({ top: [win], bottom: [loss], sampleSize: 2 }),
    );
    expect(out).toContain("HISTORICAL PERFORMANCE BENCHMARKS");
    expect(out).toContain("TOP PERFORMERS");
    expect(out).toContain("LOWEST PERFORMERS");
    // The sample size is disclosed.
    expect(out).toContain("2 tracked assets");
  });

  it("renders each entry's score, label, impressions, and engagement %", () => {
    const out = buildProactiveSystemAppendix(
      ctx({ top: [win], bottom: [loss], sampleSize: 2 }),
    );
    expect(out).toContain("[92.1]");
    expect(out).toContain("How we cut onboarding time 40%");
    expect(out).toContain("12,400 impressions");
    expect(out).toContain("6.2% engagement");
    expect(out).toContain("[4.3]");
  });

  it("instructs the model to double down on winners and phase out losers", () => {
    const out = buildProactiveSystemAppendix(
      ctx({ top: [win], bottom: [loss], sampleSize: 2 }),
    );
    expect(out).toMatch(/double down/i);
    expect(out).toMatch(/phase out/i);
    // Guardrail against fabricated metrics.
    expect(out).toMatch(/never invent metrics/i);
  });

  it("handles a winners-only history (no losers yet) without breaking", () => {
    const out = buildProactiveSystemAppendix(
      ctx({ top: [win], bottom: [], sampleSize: 1 }),
    );
    expect(out).toContain("HISTORICAL PERFORMANCE BENCHMARKS");
    expect(out).toContain("1 tracked asset");
    expect(out).toContain("(none yet)"); // empty losers list
  });

  it("still produces the rest of the appendix around the block", () => {
    const out = buildProactiveSystemAppendix(
      ctx({ top: [win], bottom: [loss], sampleSize: 2 }),
    );
    expect(out).toContain("PROACTIVE OPERATING MODE");
    expect(out).toContain("CONTENT GAP DETECTION");
  });
});
