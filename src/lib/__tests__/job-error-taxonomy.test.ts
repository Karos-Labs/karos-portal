import { describe, expect, it } from "vitest";
import { classifyJobError } from "@/lib/job-error-taxonomy";

describe("classifyJobError", () => {
  it("returns null for no error", () => {
    expect(classifyJobError(null)).toBeNull();
    expect(classifyJobError(undefined)).toBeNull();
    expect(classifyJobError("")).toBeNull();
  });

  it("classifies rate limiting", () => {
    expect(classifyJobError("Error 429: rate limit exceeded")?.label).toBe("Rate limited by provider");
  });

  it("classifies credit/quota exhaustion", () => {
    expect(classifyJobError("insufficient credit balance for this account")?.label).toBe(
      "Provider credits exhausted",
    );
  });

  it("classifies the Claude Code SDK's actual credit-exhaustion wording (2026-07-30 incident)", () => {
    // The real string has no "insufficient" substring — pinned so this
    // specific regression (every one of these fell through to "Unexpected
    // error") can't come back silently.
    expect(
      classifyJobError("Claude Code returned an error result: Credit balance is too low")?.label,
    ).toBe("Provider credits exhausted");
  });

  it("classifies auth failures", () => {
    expect(classifyJobError("401 Unauthorized: invalid api key")?.label).toBe(
      "Provider authentication expired",
    );
  });

  it("classifies timeouts", () => {
    expect(classifyJobError("upstream request timed out after 30s")?.label).toBe("Request timed out");
  });

  it("classifies parsing errors", () => {
    expect(classifyJobError("failed to parse model response: unexpected token")?.label).toBe(
      "Response parsing error",
    );
  });

  it("falls back to 'Unexpected error' for an unrecognized message, without discarding the raw text", () => {
    const result = classifyJobError("something completely novel went wrong");
    expect(result?.label).toBe("Unexpected error");
    expect(result?.raw).toBe("something completely novel went wrong");
  });

  it("always preserves the raw string alongside a matched label", () => {
    const raw = "429 Too Many Requests from provider X";
    expect(classifyJobError(raw)?.raw).toBe(raw);
  });
});
