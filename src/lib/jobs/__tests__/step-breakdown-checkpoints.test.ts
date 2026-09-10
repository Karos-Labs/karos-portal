import { describe, expect, it } from "vitest";
import { buildStepBreakdownFromCheckpoints } from "@/lib/jobs/step-breakdown";

describe("buildStepBreakdownFromCheckpoints", () => {
  it("returns [] when there are no checkpoints — the caller must not set Job.stepBreakdown at all in that case", () => {
    expect(buildStepBreakdownFromCheckpoints([], 10_000, { inputTokens: 100, outputTokens: 50 }, false)).toEqual([]);
  });

  it("groups by the leading numbered path segment, ignoring later writes to the same step (e.g. multiple posts in one run)", () => {
    const checkpoints = [
      { path: "clients/acme/outputs/linkedin-agent-v2/run/internal/01-run.json", atMs: 0 },
      { path: "clients/acme/outputs/linkedin-agent-v2/run/internal/06-angles.json", atMs: 1000 },
      { path: "clients/acme/outputs/linkedin-agent-v2/run/internal/07-drafts/p01/attempt-1.md", atMs: 2000 },
      { path: "clients/acme/outputs/linkedin-agent-v2/run/internal/07-drafts/p02/attempt-1.md", atMs: 2500 },
      { path: "clients/acme/outputs/linkedin-agent-v2/run/internal/12-commit.json", atMs: 4000 },
    ];
    const result = buildStepBreakdownFromCheckpoints(checkpoints, 5000, { inputTokens: 1000, outputTokens: 500 }, false);
    expect(result.map((s) => s.stepId)).toEqual(["01-run", "06-angles", "07-drafts", "12-commit"]);
  });

  it("humanizes step names from the numbered convention", () => {
    const checkpoints = [
      { path: "clients/acme/outputs/x/06-angles.json", atMs: 0 },
      { path: "clients/acme/outputs/x/12-commit.json", atMs: 1000 },
    ];
    const result = buildStepBreakdownFromCheckpoints(checkpoints, 2000, { inputTokens: 0, outputTokens: 0 }, false);
    expect(result[0]?.stepName).toBe("Angles");
    expect(result[1]?.stepName).toBe("Commit");
  });

  it("falls back to the basename for a skill with no numbered convention", () => {
    const checkpoints = [
      { path: "clients/acme/outputs/x/content-ledger.jsonl", atMs: 0 },
      { path: "clients/acme/outputs/x/deliverables.jsonl", atMs: 500 },
    ];
    const result = buildStepBreakdownFromCheckpoints(checkpoints, 1000, { inputTokens: 0, outputTokens: 0 }, false);
    expect(result.map((s) => s.stepName)).toEqual(["Content Ledger", "Deliverables"]);
  });

  it("prorates cost/tokens by each step's share of total wall-clock duration", () => {
    // Step A: 0-2000ms (50% of 4000ms), Step B: 2000-4000ms (50%).
    const checkpoints = [
      { path: "outputs/01-a.json", atMs: 0 },
      { path: "outputs/02-b.json", atMs: 2000 },
    ];
    const result = buildStepBreakdownFromCheckpoints(
      checkpoints,
      4000,
      { costUsd: 1.0, inputTokens: 1000, outputTokens: 200 },
      false,
    );
    expect(result[0]).toMatchObject({ durationMs: 2000, costUsd: 0.5, inputTokens: 500, outputTokens: 100 });
    expect(result[1]).toMatchObject({ durationMs: 2000, costUsd: 0.5, inputTokens: 500, outputTokens: 100 });
  });

  it("marks every step completed on a successful run", () => {
    const checkpoints = [
      { path: "outputs/01-a.json", atMs: 0 },
      { path: "outputs/02-b.json", atMs: 1000 },
    ];
    const result = buildStepBreakdownFromCheckpoints(checkpoints, 2000, { inputTokens: 0, outputTokens: 0 }, false);
    expect(result.every((s) => s.status === "completed")).toBe(true);
  });

  it("marks only the LAST observed step as failed on a failed run — earlier ones genuinely completed", () => {
    const checkpoints = [
      { path: "outputs/01-a.json", atMs: 0 },
      { path: "outputs/02-b.json", atMs: 1000 },
    ];
    const result = buildStepBreakdownFromCheckpoints(checkpoints, 2000, { inputTokens: 0, outputTokens: 0 }, true);
    expect(result[0]?.status).toBe("completed");
    expect(result[1]?.status).toBe("failed");
  });

  it("marks every row as estimated — never mistaken for Dynamic Agent Studio's exact rows", () => {
    const checkpoints = [{ path: "outputs/01-a.json", atMs: 0 }];
    const result = buildStepBreakdownFromCheckpoints(checkpoints, 1000, { inputTokens: 0, outputTokens: 0 }, false);
    expect(result.every((s) => s.estimated === true)).toBe(true);
  });

  it("omits costUsd when the run's total cost is unknown, rather than reporting a fabricated $0", () => {
    const checkpoints = [{ path: "outputs/01-a.json", atMs: 0 }];
    const result = buildStepBreakdownFromCheckpoints(checkpoints, 1000, { inputTokens: 10, outputTokens: 5 }, false);
    expect(result[0]?.costUsd).toBeUndefined();
  });

  it("does not divide by zero when runDurationMs is 0 or negative", () => {
    const checkpoints = [{ path: "outputs/01-a.json", atMs: 0 }];
    const result = buildStepBreakdownFromCheckpoints(checkpoints, 0, { inputTokens: 100, outputTokens: 50 }, false);
    expect(Number.isFinite(result[0]?.inputTokens)).toBe(true);
    expect(Number.isFinite(result[0]?.outputTokens)).toBe(true);
  });
});
