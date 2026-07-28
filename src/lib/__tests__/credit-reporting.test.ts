import { describe, expect, it } from "vitest";
import {
  CALIBRATION_MIN_SAMPLES,
  calibrateLaunchPrice,
  summarizeAgentEconomics,
  summarizeClientSpend,
} from "@/lib/credit-reporting";
import type { CreditLedgerEntry, Job } from "@/lib/types";

/**
 * §6.2 / §6.3. The rule these lock down: nothing here is invented. Where the
 * measurement does not exist the summary says so, because the whole point of
 * the launch calibration is replacing a guessed multiplier with a measured one.
 */

function entry(patch: Partial<CreditLedgerEntry> = {}): CreditLedgerEntry {
  return {
    id: "l1",
    clientId: "c1",
    delta: -25,
    balanceAfter: 100,
    kind: "charge",
    operation: "custom_agent_run",
    reason: "Agent run · Instagram Agent",
    agentId: "ag1",
    jobId: "j1",
    actorUid: "u1",
    createdAt: 1_000,
    ...patch,
  } as CreditLedgerEntry;
}

function job(patch: Partial<Job> = {}): Job {
  return {
    id: "j1",
    clientId: "c1",
    agentId: "agent-service",
    agentName: "Instagram Agent",
    status: "review",
    assetIds: [],
    input: {},
    createdAt: 0,
    external: { serviceJobId: "s1", taskType: "custom", totalCostUsd: 1 },
    ...patch,
  } as Job;
}

describe("summarizeClientSpend", () => {
  const agentNameById = { ag1: "Instagram Agent", ag2: "X Agent" };

  it("splits one agent's charges into setup, scheduled and manual", () => {
    const rows = summarizeClientSpend({
      ledger: [
        entry({ id: "a", operation: "agent_launch", delta: -300, jobId: "jl" }),
        entry({ id: "b", jobId: "js", delta: -25 }),
        entry({ id: "c", jobId: "jm", delta: -25 }),
        entry({ id: "d", jobId: "jm2", delta: -25 }),
      ],
      runTypeByJobId: { jl: "launch", js: "scheduled", jm: "manual_template", jm2: "manual" },
      agentNameById,
    });

    expect(rows).toHaveLength(1);
    expect(rows[0].agentName).toBe("Instagram Agent");
    expect(rows[0].credits).toBe(375);
    expect(rows[0].buckets).toEqual([
      { bucket: "setup", credits: 300, entries: 1 },
      { bucket: "scheduled", credits: 25, entries: 1 },
      { bucket: "manual", credits: 50, entries: 2 },
    ]);
  });

  it("counts charges only — a refund is not negative usage, a grant is not usage", () => {
    const rows = summarizeClientSpend({
      ledger: [
        entry({ id: "a", delta: -25 }),
        entry({ id: "b", kind: "refund", delta: 25 }),
        entry({ id: "c", kind: "grant", delta: 500 }),
        entry({ id: "d", kind: "adjustment", delta: -10 }),
      ],
      runTypeByJobId: { j1: "scheduled" },
      agentNameById,
    });

    expect(rows).toHaveLength(1);
    expect(rows[0].credits).toBe(25);
  });

  it("buckets a charge whose job is gone as undifferentiated, not as a guess", () => {
    const rows = summarizeClientSpend({
      ledger: [entry({ jobId: "vanished" })],
      runTypeByJobId: {},
      agentNameById,
    });

    expect(rows[0].buckets).toEqual([{ bucket: "other", credits: 25, entries: 1 }]);
  });

  it("keeps unattributed spend in its own row, always last", () => {
    const rows = summarizeClientSpend({
      ledger: [
        entry({ id: "a", agentId: null, operation: "chat_message", delta: -1, jobId: undefined }),
        entry({ id: "b", agentId: "ag2", delta: -5 }),
      ],
      runTypeByJobId: {},
      agentNameById,
    });

    expect(rows.map((r) => r.agentName)).toEqual(["X Agent", "Other usage"]);
    expect(rows[1].agentId).toBeNull();
  });

  it("names a deleted agent honestly rather than dropping its spend", () => {
    const rows = summarizeClientSpend({
      ledger: [entry({ agentId: "gone" })],
      runTypeByJobId: {},
      agentNameById,
    });
    expect(rows[0].agentName).toBe("Removed agent");
    expect(rows[0].credits).toBe(25);
  });
});

describe("summarizeAgentEconomics", () => {
  it("splits USD by run type and keeps legacy jobs in their own bucket", () => {
    const result = summarizeAgentEconomics([
      job({ id: "1", runType: "launch", external: { serviceJobId: "s", taskType: "custom", totalCostUsd: 8 } }),
      job({ id: "2", runType: "scheduled", external: { serviceJobId: "s", taskType: "custom", totalCostUsd: 1 } }),
      job({ id: "3", runType: "manual_template", external: { serviceJobId: "s", taskType: "custom", totalCostUsd: 2 } }),
      job({ id: "4", external: { serviceJobId: "s", taskType: "custom", totalCostUsd: 5 } }),
    ]);

    expect(result.launch).toEqual({ runs: 1, usd: 8 });
    expect(result.scheduled).toEqual({ runs: 1, usd: 1 });
    expect(result.manual).toEqual({ runs: 1, usd: 2 });
    expect(result.untyped).toEqual({ runs: 1, usd: 5 });
    expect(result.totalUsd).toBe(16);
  });

  it("excludes failed and cancelled runs — a dead run is partial, not cheap", () => {
    const result = summarizeAgentEconomics([
      job({ id: "1", runType: "launch", external: { serviceJobId: "s", taskType: "custom", totalCostUsd: 8 } }),
      job({
        id: "2",
        runType: "launch",
        status: "failed",
        external: { serviceJobId: "s", taskType: "custom", totalCostUsd: 0.4 },
      }),
      job({
        id: "3",
        runType: "launch",
        status: "cancelled",
        external: { serviceJobId: "s", taskType: "custom", totalCostUsd: 0.2 },
      }),
    ]);

    // Averaging the two dead runs in would report $2.87 and under-price setup.
    expect(result.launch).toEqual({ runs: 1, usd: 8 });
  });

  it("ignores jobs with no reported cost rather than averaging them in as zero", () => {
    const result = summarizeAgentEconomics([
      job({ id: "1", runType: "launch", external: { serviceJobId: "s", taskType: "custom", totalCostUsd: 8 } }),
      // Cost reported as absent (service predates it, or the run died first).
      job({ id: "2", runType: "launch", external: { serviceJobId: "s", taskType: "custom" } }),
      // No external block at all.
      job({ id: "3", runType: "launch", external: undefined }),
    ]);

    expect(result.launch).toEqual({ runs: 1, usd: 8 });
  });
});

describe("calibrateLaunchPrice", () => {
  const cost = (usd: number, runType: Job["runType"], id: string): Job =>
    job({ id, runType, external: { serviceJobId: "s", taskType: "custom", totalCostUsd: usd } });

  it("measures the real ratio and suggests a price from it", () => {
    const result = calibrateLaunchPrice({
      jobs: [
        cost(8, "launch", "l1"),
        cost(8, "launch", "l2"),
        cost(8, "launch", "l3"),
        cost(1, "scheduled", "r1"),
        cost(1, "scheduled", "r2"),
        cost(1, "manual_template", "r3"),
      ],
      creditCost: 25,
    });

    expect(result.launchAvgUsd).toBe(8);
    expect(result.runAvgUsd).toBe(1);
    expect(result.ratio).toBe(8);
    expect(result.suggestedLaunchCredits).toBe(200);
    expect(result.provisional).toBe(false);
  });

  it("returns nulls — never a fallback multiplier — before any launch is measured", () => {
    const result = calibrateLaunchPrice({
      jobs: [cost(1, "scheduled", "r1")],
      creditCost: 25,
    });

    expect(result.launchAvgUsd).toBeNull();
    expect(result.ratio).toBeNull();
    expect(result.suggestedLaunchCredits).toBeNull();
    expect(result.provisional).toBe(false);
  });

  it("returns nulls when there is no run baseline to measure against", () => {
    const result = calibrateLaunchPrice({ jobs: [cost(8, "launch", "l1")], creditCost: 25 });
    expect(result.ratio).toBeNull();
    expect(result.suggestedLaunchCredits).toBeNull();
  });

  it("flags a thin sample as provisional instead of hiding it", () => {
    const result = calibrateLaunchPrice({
      jobs: [cost(8, "launch", "l1"), cost(1, "scheduled", "r1")],
      creditCost: 25,
    });

    expect(result.ratio).toBe(8);
    expect(result.launchRuns).toBeLessThan(CALIBRATION_MIN_SAMPLES);
    expect(result.provisional).toBe(true);
  });

  it("excludes untyped legacy jobs from the run baseline", () => {
    // A $100 legacy job would wreck the average if it counted as a run.
    const result = calibrateLaunchPrice({
      jobs: [
        cost(8, "launch", "l1"),
        cost(1, "scheduled", "r1"),
        job({ id: "legacy", external: { serviceJobId: "s", taskType: "custom", totalCostUsd: 100 } }),
      ],
      creditCost: 25,
    });

    expect(result.runRuns).toBe(1);
    expect(result.runAvgUsd).toBe(1);
    expect(result.ratio).toBe(8);
  });
});
