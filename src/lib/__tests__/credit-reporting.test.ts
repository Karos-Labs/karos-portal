import { describe, expect, it } from "vitest";
import {
  CALIBRATION_MIN_SAMPLES,
  ESTIMATE_WINDOW,
  RUN_SAMPLE_LIMIT,
  estimateRunCreditsFromJobs,
  MONTHLY_COST_ALERT_FRACTION,
  UNNAMED_AGENT_LABEL,
  calibrateLaunchPrice,
  estimateRunCredits,
  recentRunCostsUsd,
  spendAgentNames,
  summarizeAgentEconomics,
  summarizeClientMonthlyCost,
  summarizeClientSpend,
} from "@/lib/credit-reporting";
import { CREDIT_BUCKET_LABEL, creditMonthKey } from "@/lib/credits";
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

/* ── Self-calibrating estimates (credits rework, 2026-09) ─────────── */

describe("estimateRunCredits", () => {
  it("quotes the MEDIAN of recent runs, not the mean", () => {
    // The whole design of this function. One runaway run ($9) moves the mean to
    // $2.10 and would reprice the product for every client; the median stays on
    // what a typical run costs. The client who sees the new quote is never the
    // client who caused the outlier.
    const usd = [0.9, 1.0, 1.1, 0.95, 9];
    const est = estimateRunCredits({ recentUsd: usd, fallbackCredits: 25 });
    expect(est).toMatchObject({ credits: 20, fallback: false, samples: 5 });
    const mean = usd.reduce((a, b) => a + b, 0) / usd.length;
    expect(Math.ceil(mean * 20)).toBeGreaterThan(est.credits);
  });

  it("falls back below the minimum sample, and says that it did", () => {
    const est = estimateRunCredits({ recentUsd: [0.9, 1.0], fallbackCredits: 25 });
    expect(est).toEqual({ credits: 25, fallback: true, samples: 0 });
  });

  it("never invents a number from an empty sample", () => {
    // The same refusal calibrateLaunchPrice makes: a quote conjured from no
    // measurement is worse than the constant that has been roughly right.
    expect(estimateRunCredits({ recentUsd: [], fallbackCredits: 10 }).credits).toBe(10);
  });

  it("measures only the last ESTIMATE_WINDOW runs", () => {
    // Newest-first: twelve cheap runs after a fortnight of expensive ones must
    // quote the cheap price, not an average of the agent's whole history.
    const recent = [
      ...Array<number>(ESTIMATE_WINDOW).fill(0.5),
      ...Array<number>(20).fill(5),
    ];
    expect(estimateRunCredits({ recentUsd: recent, fallbackCredits: 25 }).credits).toBe(10);
  });

  it("ignores rows with no usable cost rather than averaging them in as zero", () => {
    const est = estimateRunCredits({
      recentUsd: [0.9, 0, 1.0, NaN, 1.1, -1],
      fallbackCredits: 25,
    });
    expect(est).toMatchObject({ credits: 20, samples: 3 });
  });

  it("floors a very cheap product at one credit like every other price", () => {
    expect(
      estimateRunCredits({ recentUsd: [0.001, 0.002, 0.001], fallbackCredits: 5 }).credits,
    ).toBe(1);
  });

  it("cannot be suppressed by the settlement cap — it reads USD, never credits", () => {
    // The feedback loop worth pinning: if the estimate were computed from what
    // clients were CHARGED, an agent that persistently under-estimates would
    // settle at the 2× cap, feed the capped figure back in, and never learn its
    // real price. Measuring actual USD breaks the loop by construction — a run
    // costing far more than its estimate still reports its real cost here.
    const est = estimateRunCredits({ recentUsd: [4, 4.2, 3.9, 4.1], fallbackCredits: 25 });
    // Lower middle of the sorted four is $4.00 — ceil(4 × 20) = 80, well past
    // the 50 a 25-credit estimate would ever have settled at.
    expect(est.credits).toBe(80);
  });
});

describe("recentRunCostsUsd", () => {
  const runs = [
    job({ id: "a", customAgentId: "ag1", updatedAt: 3, runType: "manual", external: { totalCostUsd: 1 } }),
    job({ id: "b", customAgentId: "ag1", updatedAt: 1, runType: "scheduled", external: { totalCostUsd: 2 } }),
    job({ id: "c", customAgentId: "ag2", updatedAt: 2, runType: "manual", external: { totalCostUsd: 9 } }),
  ];

  it("takes this agent's runs, newest first", () => {
    expect(recentRunCostsUsd(runs, { customAgentId: "ag1" })).toEqual([1, 2]);
  });

  it("narrows to one client when asked — their content may be heavier than average", () => {
    const mine = [...runs, job({ id: "d", clientId: "c2", customAgentId: "ag1", updatedAt: 9, external: { totalCostUsd: 7 } })];
    expect(recentRunCostsUsd(mine, { customAgentId: "ag1", clientId: "c1" })).toEqual([1, 2]);
    // …and the cross-client rung sees both, which is what quotes a brand-new
    // client from the product rather than from nothing.
    expect(recentRunCostsUsd(mine, { customAgentId: "ag1" })).toEqual([7, 1, 2]);
  });

  it("excludes dead runs, setup runs and staff test runs", () => {
    // A failed run is a partial one, not a cheap one; a setup is different work
    // with its own price; a staff Test Run is not production.
    const noisy = [
      ...runs,
      job({ id: "f", customAgentId: "ag1", status: "failed", updatedAt: 5, external: { totalCostUsd: 0.1 } }),
      job({ id: "l", customAgentId: "ag1", runType: "launch", updatedAt: 6, external: { totalCostUsd: 8 } }),
      job({ id: "t", customAgentId: "ag1", runType: "test", updatedAt: 7, external: { totalCostUsd: 8 } }),
    ];
    expect(recentRunCostsUsd(noisy, { customAgentId: "ag1" })).toEqual([1, 2]);
  });

  it("skips runs with no reported cost", () => {
    const partial = [...runs, job({ id: "n", customAgentId: "ag1", updatedAt: 4, external: {} })];
    expect(recentRunCostsUsd(partial, { customAgentId: "ag1" })).toEqual([1, 2]);
  });
});

/* ── What a client actually costs us (staff only) ─────────────────── */

describe("summarizeClientMonthlyCost", () => {
  const MONTH = "2026-09";
  const IN = Date.UTC(2026, 8, 12);
  const OUT = Date.UTC(2026, 7, 12);

  it("counts every run in the month, delivered or not", () => {
    // The two leaks the $130 line cannot see through the credit ledger: a
    // failed run refunded the client but not us, and a staff-fired run wrote no
    // ledger row at all. Both are real dollars, so both are counted here.
    const out = summarizeClientMonthlyCost({
      jobs: [
        job({ id: "a", updatedAt: IN, external: { totalCostUsd: 1.5 } }),
        job({ id: "b", updatedAt: IN, status: "failed", external: { totalCostUsd: 0.4 } }),
        job({ id: "c", updatedAt: OUT, external: { totalCostUsd: 99 } }),
      ],
      monthKey: MONTH,
      monthlyAllowance: 2600,
    });
    expect(out.usd).toBeCloseTo(1.9);
    expect(out.runs).toBe(2);
  });

  it("measures against the $130 line and reports the fraction", () => {
    const out = summarizeClientMonthlyCost({
      jobs: [job({ updatedAt: IN, external: { totalCostUsd: 104 } })],
      monthKey: MONTH,
      monthlyAllowance: 2600,
    });
    expect(out.budgetUsd).toBe(130);
    expect(out.fraction).toBeCloseTo(0.8);
    expect(out.fraction).toBeGreaterThanOrEqual(MONTHLY_COST_ALERT_FRACTION);
  });

  it("can legitimately exceed the line — that overshoot IS the leak", () => {
    const out = summarizeClientMonthlyCost({
      jobs: [job({ updatedAt: IN, external: { totalCostUsd: 200 } })],
      monthKey: MONTH,
      monthlyAllowance: 2600,
    });
    expect(out.fraction).toBeGreaterThan(1);
  });

  it("never counts an unpriced usage row as $0 — it reports how many it skipped", () => {
    // "We do not know" and "it was free" are two answers, and only one of them
    // is safe to print beside a budget.
    const out = summarizeClientMonthlyCost({
      jobs: [],
      usageRows: [
        { estimatedCostUsd: 0, timestamp: IN, pricingUnresolved: true, jobId: null },
        { estimatedCostUsd: 0.25, timestamp: IN, jobId: null },
      ],
      monthKey: MONTH,
      monthlyAllowance: 2600,
    });
    expect(out.usd).toBeCloseTo(0.25);
    expect(out.unpricedRows).toBe(1);
  });

  it("does not double-count a usage row that belongs to a job already counted", () => {
    // The webhook writes BOTH per-model usage rows and the run total, so naive
    // addition bills the same dollars twice.
    const out = summarizeClientMonthlyCost({
      jobs: [job({ id: "j1", updatedAt: IN, external: { totalCostUsd: 1 } })],
      usageRows: [{ estimatedCostUsd: 1, timestamp: IN, jobId: "j1" }],
      monthKey: MONTH,
      monthlyAllowance: 2600,
    });
    expect(out.usd).toBeCloseTo(1);
  });

  it("uses the same month key the credits doc counts in", () => {
    // The two lines on the staff card are only comparable if they cover the
    // same window; a private month-of() that drifted from creditMonthKey would
    // make the comparison quietly meaningless.
    expect(
      summarizeClientMonthlyCost({
        jobs: [job({ updatedAt: IN, external: { totalCostUsd: 3 } })],
        monthKey: creditMonthKey(IN),
        monthlyAllowance: 2600,
      }).usd,
    ).toBe(3);
  });
});

describe("summarizeClientSpend nets settlements into the run they correct", () => {
  it("shows what the run finally cost, not what it was quoted", () => {
    // Charge 25, settled back 7. A breakdown reading 25 would contradict the
    // balance the client can see, which is the same defect as counting a refund
    // pointed the other way.
    const rows = summarizeClientSpend({
      ledger: [
        entry({ id: "h", delta: -25 }),
        entry({ id: "settle_h", kind: "settlement", delta: 7, settlesEntryId: "h" }),
      ],
      runTypeByJobId: { j1: "manual" },
      agentNameById: { ag1: "Instagram Agent" },
    });
    expect(rows[0]!.credits).toBe(18);
  });

  it("adds a settlement that took MORE", () => {
    const rows = summarizeClientSpend({
      ledger: [
        entry({ id: "h", delta: -25 }),
        entry({ id: "settle_h", kind: "settlement", delta: -15, settlesEntryId: "h" }),
      ],
      runTypeByJobId: { j1: "manual" },
      agentNameById: { ag1: "Instagram Agent" },
    });
    expect(rows[0]!.credits).toBe(40);
  });

  it("still ignores grants and refunds — those are balance movements, not usage", () => {
    const rows = summarizeClientSpend({
      ledger: [
        entry({ id: "h", delta: -25 }),
        entry({ id: "r", kind: "refund", delta: 25 }),
        entry({ id: "g", kind: "grant", delta: 500 }),
      ],
      runTypeByJobId: { j1: "manual" },
      agentNameById: { ag1: "Instagram Agent" },
    });
    expect(rows[0]!.credits).toBe(25);
  });

  it("never renders negative usage when a settlement outlives its hold", () => {
    // A hold pruned from the window this list was built over would otherwise
    // leave the row negative, which is not a thing a client can be shown.
    const rows = summarizeClientSpend({
      ledger: [entry({ id: "settle_h", kind: "settlement", delta: 7, settlesEntryId: "h" })],
      runTypeByJobId: {},
      agentNameById: { ag1: "Instagram Agent" },
    });
    expect(rows[0]!.credits).toBe(0);
    for (const b of rows[0]!.buckets) expect(b.credits).toBeGreaterThanOrEqual(0);
  });
});

/**
 * D4 — THE SAMPLE CAP MUST NOT BE APPLIED BEFORE THE AGENT FILTER.
 *
 * The submit path pre-capped the client's job list to the 50 newest across ALL
 * agents and then filtered by `customAgentId`, while the quoting surfaces
 * filtered the full list. A client running several agents can have every one of
 * those 50 belong to a different agent — so the server saw no sample and held
 * the constant while the card, looking at the same history, quoted a measured
 * median. Same defect as D1, arriving through the back door.
 */
describe("the run sample is capped after the agent filter, not before", () => {
  /** `count` runs of `agentId`, newest first by `updatedAt`. */
  function runs(agentId: string, count: number, usd: number, fromTs: number) {
    return Array.from({ length: count }, (_, i) =>
      job({
        id: `${agentId}-${i}`,
        customAgentId: agentId,
        runType: "manual",
        updatedAt: fromTs - i,
        external: { totalCostUsd: usd },
      }),
    );
  }

  it("still measures an agent buried under a flood of another agent's runs", () => {
    // 200 newer runs of a busy agent, then 5 of the one being priced. A cap
    // applied before the filter takes 50 of the busy agent's and leaves nothing.
    const jobs = [...runs("busy", 200, 5, 10_000), ...runs("quiet", 5, 1, 1_000)];

    const sample = recentRunCostsUsd(jobs, { customAgentId: "quiet", clientId: "c1" });
    expect(sample).toHaveLength(5);
    expect(estimateRunCreditsFromJobs(jobs, {
      clientId: "c1",
      customAgentId: "quiet",
      fallbackCredits: 25,
    })).toMatchObject({ credits: 20, fallback: false });
  });

  it("caps at RUN_SAMPLE_LIMIT once the agent's own runs exceed it", () => {
    const jobs = runs("busy", RUN_SAMPLE_LIMIT + 40, 1, 10_000);
    expect(recentRunCostsUsd(jobs, { customAgentId: "busy" })).toHaveLength(RUN_SAMPLE_LIMIT);
  });

  it("takes the NEWEST of an over-cap history, not an arbitrary slice", () => {
    // Ordering before slicing is what makes "recent" mean recent: `listJobs`
    // carries no `orderBy`, so the rows arrive in document-id order.
    const old = runs("busy", RUN_SAMPLE_LIMIT, 5, 1_000);
    const recent = runs("busy", RUN_SAMPLE_LIMIT, 1, 10_000);
    // Handed in oldest-first, which is the order that would betray a pre-sort
    // slice.
    const sample = recentRunCostsUsd([...old, ...recent], { customAgentId: "busy" });
    expect(sample).toHaveLength(RUN_SAMPLE_LIMIT);
    expect(new Set(sample)).toEqual(new Set([1]));
  });
});
