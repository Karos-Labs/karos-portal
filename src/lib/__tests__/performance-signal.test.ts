import { describe, expect, it } from "vitest";
import {
  MIN_POSTS_PER_ACCOUNT,
  MIN_POSTS_PER_TRAIT,
  projectWhatWorks,
  type MeasuredPost,
} from "@/lib/agent-engine/performance-signal";

/**
 * The arithmetic that will steer what a client publishes.
 *
 * The engine's `preferredByPerformance` already picks the format an account's
 * numbers favour, and says in its own comment that it never sees raw metrics —
 * it reads outliers with a `lift` from `context/learning/<platform>/what-works`.
 * Nothing has ever written that file. This is the projection that does, so
 * every rule below is a rule about what an agent will come to believe.
 *
 * Which is why the refusals are tested as carefully as the answers. An empty
 * projection leaves the engine on its default, which is the correct outcome for
 * thin data; a confident wrong one changes a client's content.
 */

const NOW = new Date("2026-09-24T00:00:00.000Z");

function post(over: Partial<MeasuredPost> & { engagementScore: number }): MeasuredPost {
  return {
    assetId: `a${Math.random().toString(36).slice(2, 8)}`,
    platform: "instagram",
    source: "live",
    trait: "carousel-edu",
    ...over,
  };
}

/** `n` posts of one trait at one score — the shape most of these cases need. */
function group(trait: string, score: number, n: number): MeasuredPost[] {
  return Array.from({ length: n }, () => post({ trait, engagementScore: score }));
}

describe("what it refuses to conclude", () => {
  it("says nothing from mock rows, however many there are", () => {
    // The failure that would look exactly like evidence. Mock rows exist in
    // quantity, and an agent taught that a format works because a placeholder
    // said so is confident and invented.
    const mock = Array.from({ length: 40 }, () => post({ engagementScore: 90, source: "mock" }));
    const result = projectWhatWorks(mock, "instagram", NOW);
    expect(result.outliers).toEqual([]);
    // The COUNT, not just the word: "no trait has 3 live posts" also contains
    // "live post", so a laxer assertion here passed with the filter removed.
    expect(result.refusal).toMatch(/^0 live post\(s\) measured/);
  });

  it("waits for the account to have a history at all", () => {
    const thin = group("carousel-edu", 80, MIN_POSTS_PER_ACCOUNT - 1);
    expect(projectWhatWorks(thin, "instagram", NOW).refusal).toMatch(/needed before this account/);
  });

  it("will not let a trait vote on two posts", () => {
    // Lift over two posts is noise with a decimal point.
    const posts = [
      ...group("carousel-edu", 50, 8),
      ...group("reel-hook", 95, MIN_POSTS_PER_TRAIT - 1),
    ];
    const traits = projectWhatWorks(posts, "instagram", NOW).outliers.map((o) => o.trait);
    expect(traits).not.toContain("reel-hook");
  });

  it("drops a difference too small to act on", () => {
    const posts = [...group("carousel-edu", 50, 8), ...group("reel-hook", 52, 4)];
    expect(projectWhatWorks(posts, "instagram", NOW).outliers).toEqual([]);
  });

  it("refuses an account with no measured engagement rather than dividing by zero", () => {
    const posts = group("carousel-edu", 0, 12);
    const result = projectWhatWorks(posts, "instagram", NOW);
    expect(result.outliers).toEqual([]);
    expect(result.refusal).toMatch(/every post scores zero/);
  });

  it("ignores posts from another platform", () => {
    const posts = [
      ...group("carousel-edu", 50, 8),
      ...Array.from({ length: 10 }, () => post({ platform: "linkedin", trait: "doc-post", engagementScore: 99 })),
    ];
    const traits = projectWhatWorks(posts, "instagram", NOW).outliers.map((o) => o.trait);
    expect(traits).not.toContain("doc-post");
  });

  it("ignores an older metric generation rather than averaging two meanings", () => {
    // Meta has already redefined `impressions` → `views` mid-series. The old
    // rows are not wrong, they answer a different question.
    const posts = [
      ...group("carousel-edu", 50, 8).map((p) => ({ ...p, metricsVersion: 2 })),
      ...group("reel-hook", 99, 6).map((p) => ({ ...p, metricsVersion: 1 })),
    ];
    const traits = projectWhatWorks(posts, "instagram", NOW).outliers.map((o) => o.trait);
    expect(traits).not.toContain("reel-hook");
  });

  it("lets a post with no recorded trait sit out rather than voting", () => {
    const posts = [...group("carousel-edu", 50, 8), ...Array.from({ length: 5 }, () => post({ trait: null, engagementScore: 99 }))];
    const result = projectWhatWorks(posts, "instagram", NOW);
    // It still counts toward the account's own baseline — it was published and
    // it was measured — but it cannot be evidence FOR anything.
    expect(result.outliers.every((o) => o.trait === "carousel-edu")).toBe(true);
  });
});

describe("what it does conclude", () => {
  it("scores a trait against the account's own median", () => {
    const posts = [...group("carousel-edu", 40, 8), ...group("reel-hook", 80, 4)];
    const result = projectWhatWorks(posts, "instagram", NOW);
    const reel = result.outliers.find((o) => o.trait === "reel-hook")!;
    // Account median across 12 posts is 40; the trait's own median is 80.
    expect(reel.lift).toBe(2);
    expect(result.refusal).toBeUndefined();
  });

  it("reports a trait that does WORSE, which is the more useful half", () => {
    const posts = [...group("carousel-edu", 80, 8), ...group("quote-card", 20, 4)];
    const quote = projectWhatWorks(posts, "instagram", NOW).outliers.find((o) => o.trait === "quote-card")!;
    expect(quote.lift).toBeLessThan(1);
  });

  it("uses the median, so one runaway post cannot define the account", () => {
    // A second trait is what makes this test able to fail: with a MEAN the one
    // post at 1000 drags the account baseline to ~100, and `steady-format` —
    // which is doing perfectly well — reads as 0.6x and is reported as
    // UNDERPERFORMING. With the median the baseline stays 40 and it reads as
    // the 1.5x it is. An assertion that only checked for an empty list passed
    // either way, which is how the first version of this test lied.
    const posts = [
      ...group("carousel-edu", 40, 11),
      post({ trait: "carousel-edu", engagementScore: 1000 }),
      ...group("steady-format", 60, 4),
    ];
    const steady = projectWhatWorks(posts, "instagram", NOW).outliers.find((o) => o.trait === "steady-format")!;
    expect(steady.lift).toBeGreaterThan(1);
  });

  it("names a real post per trait, so 'why does it think this' has an answer", () => {
    const best = post({ trait: "reel-hook", engagementScore: 95, assetId: "the-best-one" });
    const posts = [...group("carousel-edu", 40, 8), ...group("reel-hook", 80, 3), best];
    const reel = projectWhatWorks(posts, "instagram", NOW).outliers.find((o) => o.trait === "reel-hook")!;
    expect(reel.postRef).toBe("the-best-one");
  });

  it("puts the strongest first", () => {
    const posts = [
      ...group("carousel-edu", 40, 8),
      ...group("reel-hook", 80, 4),
      ...group("quote-card", 60, 4),
    ];
    const lifts = projectWhatWorks(posts, "instagram", NOW).outliers.map((o) => o.lift);
    expect(lifts).toEqual([...lifts].sort((a, b) => b - a));
  });

  it("stamps when it was regenerated, because a stale signal is worse than none", () => {
    const result = projectWhatWorks(group("carousel-edu", 50, 12), "instagram", NOW);
    expect(result.regeneratedAt).toBe("2026-09-24T00:00:00.000Z");
  });
});
