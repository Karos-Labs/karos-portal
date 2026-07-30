import { describe, expect, it } from "vitest";
import { deriveAgentHealth } from "@/lib/agent-health";

describe("deriveAgentHealth", () => {
  it("is healthy with no runs and no schedule problems", () => {
    expect(deriveAgentHealth({ runs: [] })).toBe("healthy");
  });

  it("is healthy when the most recent run succeeded", () => {
    expect(
      deriveAgentHealth({
        runs: [
          { status: "delivered", createdAt: 200 },
          { status: "failed", createdAt: 100 },
        ],
      }),
    ).toBe("healthy");
  });

  it("is errored when the most recent run failed", () => {
    expect(
      deriveAgentHealth({
        runs: [
          { status: "failed", createdAt: 200 },
          { status: "delivered", createdAt: 100 },
        ],
      }),
    ).toBe("errored");
  });

  it("is errored when the schedule itself couldn't fire, even if the last run succeeded", () => {
    expect(
      deriveAgentHealth({
        runs: [{ status: "delivered", createdAt: 100 }],
        scheduleLastError: "Client is out of credits",
      }),
    ).toBe("errored");
  });

  it("is retrying when a run is in flight and the one before it failed", () => {
    expect(
      deriveAgentHealth({
        runs: [
          { status: "running", createdAt: 200 },
          { status: "failed", createdAt: 100 },
        ],
      }),
    ).toBe("retrying");
  });

  it("is NOT retrying when a run is in flight but the one before it succeeded", () => {
    expect(
      deriveAgentHealth({
        runs: [
          { status: "queued", createdAt: 200 },
          { status: "delivered", createdAt: 100 },
        ],
      }),
    ).toBe("healthy");
  });

  it("sorts runs by createdAt internally, regardless of input order", () => {
    expect(
      deriveAgentHealth({
        runs: [
          { status: "delivered", createdAt: 100 },
          { status: "running", createdAt: 200 },
          { status: "failed", createdAt: 150 },
        ],
      }),
    ).toBe("retrying");
  });

  it("paused overrides errored — a deliberately stopped schedule isn't alarming", () => {
    expect(
      deriveAgentHealth({
        runs: [{ status: "failed", createdAt: 100 }],
        scheduleStatus: "paused",
        scheduleLastError: "Client is out of credits",
      }),
    ).toBe("paused");
  });

  it("a completed (not paused) schedule with a healthy last run is healthy", () => {
    expect(
      deriveAgentHealth({
        runs: [{ status: "delivered", createdAt: 100 }],
        scheduleStatus: "completed",
      }),
    ).toBe("healthy");
  });
});
