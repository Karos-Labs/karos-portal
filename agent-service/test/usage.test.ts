import { describe, expect, it } from "vitest";
import { mergeJobUsage } from "../src/state/usage.js";

describe("mergeJobUsage", () => {
  it("returns the other side when one is missing", () => {
    const usage = { models: { opus: { inputTokens: 1, outputTokens: 2, cacheReadInputTokens: 0, cacheCreationInputTokens: 0 } } };
    expect(mergeJobUsage(undefined, usage)).toEqual(usage);
    expect(mergeJobUsage(usage, undefined)).toEqual(usage);
    expect(mergeJobUsage(undefined, undefined)).toBeUndefined();
  });

  it("sums token counts and cost per model across attempts", () => {
    const attempt1 = {
      totalCostUsd: 20,
      numTurns: 150,
      models: {
        "claude-opus-4-8": {
          inputTokens: 10_000,
          outputTokens: 2_000,
          cacheReadInputTokens: 500,
          cacheCreationInputTokens: 100,
          costUsd: 20,
        },
      },
    };
    const attempt2 = {
      totalCostUsd: 12,
      numTurns: 90,
      models: {
        "claude-opus-4-8": {
          inputTokens: 6_000,
          outputTokens: 1_000,
          cacheReadInputTokens: 300,
          cacheCreationInputTokens: 50,
          costUsd: 12,
        },
      },
    };

    const merged = mergeJobUsage(attempt1, attempt2);

    expect(merged).toEqual({
      totalCostUsd: 32,
      numTurns: 240,
      models: {
        "claude-opus-4-8": {
          inputTokens: 16_000,
          outputTokens: 3_000,
          cacheReadInputTokens: 800,
          cacheCreationInputTokens: 150,
          costUsd: 32,
        },
      },
    });
  });

  it("keeps distinct models separate and merges a model appearing on only one side", () => {
    const attempt1 = {
      models: {
        "claude-haiku-4-5": { inputTokens: 100, outputTokens: 10, cacheReadInputTokens: 0, cacheCreationInputTokens: 0 },
      },
    };
    const attempt2 = {
      models: {
        "claude-opus-4-8": { inputTokens: 5_000, outputTokens: 500, cacheReadInputTokens: 0, cacheCreationInputTokens: 0 },
      },
    };

    const merged = mergeJobUsage(attempt1, attempt2);

    expect(merged?.models["claude-haiku-4-5"]).toEqual(attempt1.models["claude-haiku-4-5"]);
    expect(merged?.models["claude-opus-4-8"]).toEqual(attempt2.models["claude-opus-4-8"]);
  });

  it("omits totalCostUsd/numTurns when neither side has them, without writing undefined", () => {
    const merged = mergeJobUsage({ models: {} }, { models: {} });
    expect(merged).toEqual({ models: {} });
    expect(Object.prototype.hasOwnProperty.call(merged, "totalCostUsd")).toBe(false);
  });
});
