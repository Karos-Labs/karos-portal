import { describe, expect, it } from "vitest";
import {
  CALIBRATION_MIN_SAMPLES,
  UNNAMED_AGENT_LABEL,
  calibrateLaunchPrice,
  spendAgentNames,
  summarizeAgentEconomics,
  summarizeClientSpend,
} from "@/lib/credit-reporting";
import { CREDIT_BUCKET_LABEL } from "@/lib/credits";
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

  it("buckets a charge whose job is gone as an undifferentiated RUN, not as a guess", () => {
    const rows = summarizeClientSpend({
      ledger: [entry({ jobId: "vanished" })],
      runTypeByJobId: {},
      agentNameById,
    });

    // "runs", not "other". We do not know WHICH kind of run it was, but we know
    // it was one — the operation says so — and telling a client that the agent
    // runs they paid for were "other usage" is the less true of the two.
    expect(rows[0].buckets).toEqual([{ bucket: "runs", credits: 25, entries: 1 }]);
    expect(CREDIT_BUCKET_LABEL.runs).toBe("Runs (kind not recorded)");
  });

  it("keeps a run bucket and a non-run bucket apart on the same agent", () => {
    const rows = summarizeClientSpend({
      ledger: [
        entry({ id: "a", jobId: "vanished", delta: -25 }),
        entry({ id: "b", operation: "ai_tool", jobId: undefined, delta: -5 }),
      ],
      runTypeByJobId: {},
      agentNameById,
    });

    // The whole point of splitting `runs` out of `other`: if both still landed
    // in one bucket this row would read "Other usage 30" and the client would
    // have no idea that 25 of it was the agent running.
    expect(rows[0].buckets).toEqual([
      { bucket: "runs", credits: 25, entries: 1 },
      { bucket: "other", credits: 5, entries: 1 },
    ]);
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

  it("keeps an unresolvable agent's spend, and claims nothing about why it is unresolvable", () => {
    const rows = summarizeClientSpend({
      ledger: [entry({ agentId: "gone" })],
      runTypeByJobId: {},
      agentNameById,
    });
    expect(rows[0].agentName).toBe(UNNAMED_AGENT_LABEL);
    expect(rows[0].credits).toBe(25);
    // The label used to be "Removed agent", which is a statement about the
    // client's library that this function cannot check — and was false for
    // every agent whose runs carried no customAgentId. Whatever the wording
    // becomes, it must not assert a removal.
    expect(UNNAMED_AGENT_LABEL.toLowerCase()).not.toContain("remov");
    expect(UNNAMED_AGENT_LABEL.toLowerCase()).not.toContain("delet");
  });
});

describe("spendAgentNames", () => {
  it("names an agent that is still in the library but has no job carrying its id", () => {
    // Exactly the shape the scheduler core wrote until 2026-08-01: real jobs,
    // real charges, no customAgentId on any of them.
    const names = spendAgentNames({
      customAgents: [{ id: "ag1", name: "Instagram Agent" }],
      jobs: [{ customAgentId: undefined, agentName: "Instagram Agent" }],
      umbrellas: [],
    });
    expect(names).toEqual({ ag1: "Instagram Agent" });

    const rows = summarizeClientSpend({
      ledger: [entry({ agentId: "ag1" })],
      runTypeByJobId: {},
      agentNameById: names,
    });
    expect(rows[0].agentName).toBe("Instagram Agent");
  });

  it("lets the umbrella's §7.3 display name outrank the job's and the library's", () => {
    const names = spendAgentNames({
      customAgents: [{ id: "ag1", name: "karos-instagram-content-agent" }],
      jobs: [{ customAgentId: "ag1", agentName: "Instagram Agent" }],
      umbrellas: [{ customAgentId: "ag1", displayName: "Your Instagram agent" }],
    });
    // One agent, one name, wherever the client reads it — the billing page must
    // not introduce a second one.
    expect(names.ag1).toBe("Your Instagram agent");
  });

  it("prefers the library's CURRENT name over the name a past run recorded", () => {
    // THIS TEST ASSERTED THE OPPOSITE, and its name said so as intent. A run's
    // recorded name is the name AT THE TIME; after a rename it is the one name
    // no other surface uses. calendar-body resolves the same question
    // library-first (`agentById.get(...)?.name ?? r.agentName`), so the old
    // order had the credits panel and the calendar printing two different names
    // for one agent — the double identity this helper exists to prevent, on the
    // surface where it costs money.
    const names = spendAgentNames({
      customAgents: [{ id: "ag1", name: "Renamed in the library" }],
      jobs: [{ customAgentId: "ag1", agentName: "Name on the run" }],
    });
    expect(names.ag1).toBe("Renamed in the library");
  });

  it("falls back to a run's name only for an id the library no longer knows", () => {
    // The job rung still earns its place: an agent deleted from the library, or
    // one whose charges predate it, has no other source of a name at all.
    const names = spendAgentNames({
      customAgents: [{ id: "ag-other", name: "Still here" }],
      jobs: [{ customAgentId: "ag-gone", agentName: "What it was called" }],
    });
    expect(names["ag-gone"]).toBe("What it was called");
  });

  it("takes the MOST RECENT recorded name when only runs know it", () => {
    // `listJobs` sorts newest-first, and the loop was last-wins — so the winner
    // was the OLDEST name the agent ever ran under. First-wins over that order
    // is the most recent answer, which is the only job-recorded one worth having.
    const names = spendAgentNames({
      jobs: [
        { customAgentId: "ag1", agentName: "Newest name" },
        { customAgentId: "ag1", agentName: "Older name" },
        { customAgentId: "ag1", agentName: "Oldest name" },
      ],
    });
    expect(names.ag1).toBe("Newest name");
  });

  it("takes each source as optional and never invents an entry", () => {
    expect(spendAgentNames({})).toEqual({});
    expect(spendAgentNames({ jobs: [{ customAgentId: undefined, agentName: "x" }] })).toEqual({});
    expect(spendAgentNames({ umbrellas: [{ customAgentId: "ag9", displayName: "" }] })).toEqual({});
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
