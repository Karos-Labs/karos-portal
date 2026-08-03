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

  /**
   * The portal's OWN submit-time refusals — the two literal strings
   * agent-service/client.ts throws, stored verbatim as job.error by
   * submit-custom / submit-managed / run-custom-agent. The generic rules below
   * misread their HTTP status codes as the model provider's.
   */
  it("names the right system for a rejected agent-service call, not the provider", () => {
    // This is the misclassification: `\b401\b` used to make a rotated
    // AGENT_SERVICE_TOKEN read as "Provider authentication expired", sending
    // staff to check the model provider's key.
    expect(classifyJobError("Agent service request failed (401). Please try again or contact support.")?.label).toBe(
      "Agent service credentials rejected",
    );
    expect(classifyJobError("Agent service request failed (403). Please try again or contact support.")?.label).toBe(
      "Agent service credentials rejected",
    );
  });

  it("separates the agent service's own rate limit and outages from the provider's", () => {
    expect(classifyJobError("Agent service request failed (429). Please try again or contact support.")?.label).toBe(
      "Rate limited by agent service",
    );
    for (const status of [500, 502, 503]) {
      expect(classifyJobError(`Agent service request failed (${status}). Please try again or contact support.`)?.label).toBe(
        "Agent service unavailable",
      );
    }
  });

  it("classifies the unconfigured-service refusal instead of dropping it in the generic bucket", () => {
    expect(
      classifyJobError("Agent service is not configured (AGENT_SERVICE_URL / AGENT_SERVICE_TOKEN).")?.label,
    ).toBe("Agent service not configured");
  });

  it("still reads a provider 401 in free text as a provider auth failure", () => {
    // The new rules are anchored to the portal's own string shape, so they must
    // not swallow what the agent service reports about its upstream.
    expect(classifyJobError("Anthropic API error: 401 Unauthorized")?.label).toBe(
      "Provider authentication expired",
    );
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
