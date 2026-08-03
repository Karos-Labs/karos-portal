import { describe, expect, it } from "vitest";
import { isTransientError, isTransientResultError } from "../runner/src/error-classification.js";

describe("isTransientError", () => {
  it("flags network blips", () => {
    expect(isTransientError(new Error("connect ECONNRESET"))).toBe(true);
    expect(isTransientError(new Error("fetch failed"))).toBe(true);
    expect(isTransientError(new Error("upstream returned 503"))).toBe(true);
    expect(isTransientError(new Error("overloaded_error"))).toBe(true);
    expect(isTransientError(new Error("rate limit exceeded"))).toBe(true);
  });

  it("does not flag permanent account/billing failures", () => {
    expect(isTransientError(new Error("Claude Code returned an error result: Credit balance is too low"))).toBe(
      false,
    );
    expect(isTransientError(new Error("invalid x-api-key"))).toBe(false);
  });
});

describe("isTransientResultError", () => {
  it("never retries a structured-output validation loop", () => {
    expect(isTransientResultError("error_max_structured_output_retries", ["schema mismatch"])).toBe(false);
    expect(
      isTransientResultError("error_max_structured_output_retries", ["ECONNRESET mid-validation"]),
    ).toBe(false);
  });

  it("classifies error_during_execution by its actual error text", () => {
    expect(isTransientResultError("error_during_execution", ["upstream 529 overloaded_error"])).toBe(true);
    expect(isTransientResultError("error_during_execution", ["Credit balance is too low"])).toBe(false);
    expect(isTransientResultError("error_during_execution", undefined)).toBe(false);
    expect(isTransientResultError("error_during_execution", [])).toBe(false);
  });
});
