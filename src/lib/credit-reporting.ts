/**
 * What the credit ledger and the job cost record ADD UP TO (§6.2, §6.3).
 *
 * Two audiences, two currencies, one rule: neither number is invented here.
 * The client's side is credits, aggregated from `creditLedger` rows they were
 * actually charged. The staff side is USD, aggregated from
 * `jobs.external.totalCostUsd` the agent service actually reported. Nothing in
 * this module estimates, extrapolates or fills a gap — where the data is
 * missing it says so, because the whole point of the launch-price calibration
 * is to replace a guessed multiplier with a measured one, and a summary that
 * quietly guesses would defeat it.
 *
 * Pure and client-safe: no Firestore, no server-only imports, unit-tested. The
 * callers pass in the rows.
 */

import { USD_PER_CREDIT, creditBucketFor, creditsForUsd, type CreditBucket } from "@/lib/credits";
import type { ClientAgent, CreditLedgerEntry, CustomAgent, Job, JobRunType } from "@/lib/types";

/* ── §6.2(a) the client's per-agent credit breakdown ──────────────── */

export interface AgentSpendBucket {
  bucket: CreditBucket;
  credits: number;
  entries: number;
}

export interface AgentSpendRow {
  /** Null for spend not attributable to any agent (copilot, tasks, manual). */
  agentId: string | null;
  agentName: string;
  credits: number;
  buckets: AgentSpendBucket[];
}

const BUCKET_ORDER: CreditBucket[] = ["setup", "scheduled", "manual", "runs", "other"];

/**
 * What a spend row is called when its `agentId` resolves to no name at all.
 *
 * NOT "Removed agent". That is a claim about the client's library, and the map
 * this function is handed decides whether it is true: built from jobs alone —
 * which is what the settings page used to do — an agent with charges but no job
 * carrying its `customAgentId` was headed "Removed" while sitting in the
 * library, enabled.
 *
 * THE SCHEDULER CORE IS NOT THE CAUSE, though an earlier version of this note
 * said so. That core passes `charge: null` on its only caller, so its runs never
 * reach the ledger and cannot mis-name a row in it. The real sources are a job
 * pruned by retention, a charge from a path that writes no job, and an agent
 * removed from the library for real — which is exactly why the word has to go:
 * one of those three IS a removal and the other two are not, and this function
 * cannot tell them apart.
 *
 * This says only what is known at this point: there is spend, it belongs to one
 * agent, and we cannot name it. `spendAgentNames` below is how a caller makes
 * that case vanishingly rare; it is not how this line becomes safe to overstate.
 */
export const UNNAMED_AGENT_LABEL = "Unnamed agent";

/**
 * ledger `agentId` (a customAgents doc id) → the ONE name to print for it.
 *
 * THREE SOURCES, WEAKEST FIRST, because they answer the same question with
 * different authority and the strongest must win:
 *
 *   1. the lab agent's own document — the name exists for every agent still in
 *      the library, including ones this client has never had a job for. This is
 *      the rung that stops a live agent being called removed.
 *   2. WEAKEST: a job this client actually ran — the name as RECORDED THEN, which
 *      after a rename is not the name any other surface uses. Only consulted for
 *      an id the library no longer knows.
 *   3. the client's umbrella (`ClientAgent.displayName`) — the §7.3 identity.
 *      A client reads that name on their agents page, their calendar and their
 *      run rows; their billing page printing a different one for the same agent
 *      is the F147 double identity on the surface where it costs money.
 *
 * Pure, so the caller owns the reads. Every source is optional: a caller that
 * can only supply one still gets a better map than none, and the label above
 * covers what none of them names.
 */
export function spendAgentNames(input: {
  /** Every lab agent, for the id → name rung. */
  customAgents?: Array<Pick<CustomAgent, "id" | "name">>;
  /** This client's jobs. Only those carrying `customAgentId` can contribute. */
  jobs?: Array<Pick<Job, "customAgentId" | "agentName">>;
  /** This client's umbrellas — the §7.3 identity, and the strongest rung. */
  umbrellas?: Array<Pick<ClientAgent, "customAgentId" | "displayName">>;
}): Record<string, string> {
  const names: Record<string, string> = {};
  // WEAKEST FIRST, so a later rung overwrites an earlier one — and the job rung
  // is the WEAKEST, not the middle one.
  //
  // It sat above the library and below the umbrella, which put a HISTORICAL name
  // over the current one: `listJobs` sorts newest-first and this loop is
  // last-wins, so after any rename the billing page headed the row with the
  // OLDEST name the agent ever ran under, while the calendar resolves the same
  // question library-first and printed the new one. That is the double identity
  // this helper exists to prevent, on the surface where it costs money.
  //
  // First-wins within the jobs, for the same reason: over a newest-first list
  // the first entry is the most recent name, which is the only job-recorded
  // answer worth having.
  for (const job of input.jobs ?? []) {
    if (job.customAgentId && job.agentName && !names[job.customAgentId]) {
      names[job.customAgentId] = job.agentName;
    }
  }
  // The library's current name beats any name a past run recorded.
  for (const agent of input.customAgents ?? []) {
    if (agent.name) names[agent.id] = agent.name;
  }
  // The §7.3 identity wins outright: it is the name the client already reads on
  // their agents page, their calendar and their run rows.
  for (const umbrella of input.umbrellas ?? []) {
    if (umbrella.customAgentId && umbrella.displayName) {
      names[umbrella.customAgentId] = umbrella.displayName;
    }
  }
  return names;
}

/**
 * Group a client's charges by agent, then by kind.
 *
 * CHARGES AND THEIR SETTLEMENTS. Grants, refunds and adjustments are balance
 * movements, not usage — folding a refund in as negative usage would show an
 * agent that failed and refunded as having cost less than it did, and folding a
 * grant in would show it as having earned credits.
 *
 * A SETTLEMENT IS THE EXCEPTION, and the reason it is one is the whole point of
 * two-phase charging (credits rework, 2026-09): the charge row is an ESTIMATE,
 * and the settlement row is the correction that makes it true. A breakdown that
 * counted the 25-credit hold and ignored the 7 handed back would tell a client
 * they spent 25 on a run their balance says cost 18 — the same defect as
 * counting a refund, pointed the other way. So settlements are added SIGNED into
 * the bucket their hold landed in, which they can be because they carry the
 * hold's own `operation`, `agentId` and `jobId`.
 *
 * The ledger's `delta` is negative on a charge, so it is normalized to a
 * positive "spend" here; a settlement's delta is positive when credits came
 * back, so it is subtracted. A bucket is floored at zero rather than allowed to
 * go negative: a settlement whose hold predates the rows this list was built
 * from would otherwise render as negative usage, which is not a thing.
 */
export function summarizeClientSpend(input: {
  ledger: CreditLedgerEntry[];
  /** jobId → run type, for splitting agent runs into scheduled vs manual. */
  runTypeByJobId: Record<string, JobRunType | undefined>;
  /** agentId → the one name to print. Build it with `spendAgentNames`. */
  agentNameById: Record<string, string>;
}): AgentSpendRow[] {
  const rows = new Map<string, AgentSpendRow>();

  for (const entry of input.ledger) {
    if (entry.kind !== "charge" && entry.kind !== "settlement") continue;
    // A charge's delta is negative and a settlement's is signed the other way
    // (positive = credits handed back), so one negation puts both on the same
    // "spend" axis.
    const credits = -entry.delta;
    if (credits === 0) continue;

    const agentId = entry.agentId ?? null;
    const key = agentId ?? "__none__";
    const runType = entry.jobId ? input.runTypeByJobId[entry.jobId] : undefined;
    const bucket = creditBucketFor(entry.operation, runType ?? null);

    let row = rows.get(key);
    if (!row) {
      row = {
        agentId,
        agentName: agentId
          ? (input.agentNameById[agentId] ?? UNNAMED_AGENT_LABEL)
          : "Other usage",
        credits: 0,
        buckets: [],
      };
      rows.set(key, row);
    }
    row.credits += credits;
    const existing = row.buckets.find((b) => b.bucket === bucket);
    if (existing) {
      existing.credits += credits;
      existing.entries += 1;
    } else {
      row.buckets.push({ bucket, credits, entries: 1 });
    }
  }

  for (const row of rows.values()) {
    // A settlement whose hold is not in this list (pruned, or filed under an
    // agent whose charges are elsewhere) could otherwise leave a bucket, and a
    // row, negative. Negative usage is not a thing a client can be shown.
    for (const bucket of row.buckets) bucket.credits = Math.max(0, bucket.credits);
    row.credits = Math.max(0, row.credits);
    row.buckets.sort((a, b) => BUCKET_ORDER.indexOf(a.bucket) - BUCKET_ORDER.indexOf(b.bucket));
  }
  // Biggest spend first; the unattributed bucket always sinks to the bottom so
  // it never leads a list of the client's agents.
  return [...rows.values()].sort((a, b) => {
    if (a.agentId === null) return 1;
    if (b.agentId === null) return -1;
    return b.credits - a.credits || a.agentName.localeCompare(b.agentName);
  });
}

/* ── §6.2(b) staff economics, in USD ──────────────────────────────── */

export interface UsdBucket {
  runs: number;
  usd: number;
}

export interface AgentEconomics {
  launch: UsdBucket;
  scheduled: UsdBucket;
  manual: UsdBucket;
  /**
   * Control Room staff "Test Run" jobs (runType: "test"). Real dollars, same
   * as any other run — but a staff member verifying the pipeline is not a
   * normal production run, and folding it into "manual" would understate what
   * a client's own hand-fired runs actually cost while also (via §6.3's
   * denominator) skewing the launch-price ratio measured against it.
   */
  test: UsdBucket;
  /**
   * Jobs carrying no run type: ones that predate the field, and ones fired
   * through a path that does not state it — the legacy `/api/scheduler` cron
   * being the live example, since its core stamps only the run type it is
   * handed and that route hands it none. Reported as its own bucket and
   * labelled as such rather than folded into "runs": these are real dollars
   * that genuinely cannot be attributed, and burying them in a run average
   * would silently bias the very ratio §6.3 exists to measure.
   */
  untyped: UsdBucket;
  totalUsd: number;
}

const EMPTY_BUCKET = (): UsdBucket => ({ runs: 0, usd: 0 });

/** Terminal states where the reported cost is a partial run, not a price. */
const FAILED_STATUSES = new Set<Job["status"]>(["failed", "cancelled"]);

function bucketForRunType(runType?: JobRunType | null): keyof Omit<AgentEconomics, "totalUsd"> {
  if (runType === "launch") return "launch";
  if (runType === "scheduled") return "scheduled";
  if (runType === "manual_template" || runType === "manual") return "manual";
  if (runType === "test") return "test";
  return "untyped";
}

/**
 * USD actually spent running one agent, split by run type.
 *
 * Only jobs the service reported a cost for count. A job with no
 * `totalCostUsd` is not a zero-cost run — it is a run whose cost we do not
 * know (it failed before billing, or the service predates cost reporting), and
 * averaging it in as 0 would drag every average toward zero.
 */
export function summarizeAgentEconomics(jobs: Job[]): AgentEconomics {
  const out: AgentEconomics = {
    launch: EMPTY_BUCKET(),
    scheduled: EMPTY_BUCKET(),
    manual: EMPTY_BUCKET(),
    test: EMPTY_BUCKET(),
    untyped: EMPTY_BUCKET(),
    totalUsd: 0,
  };
  for (const job of jobs) {
    const usd = job.external?.totalCostUsd;
    if (typeof usd !== "number" || !Number.isFinite(usd)) continue;
    // A run that DIED is not a cheap run — it is a partial one, and its cost is
    // whatever it burned before stopping. Averaging failed and cancelled launches
    // in drags the launch mean down and understates the very ratio §6.3 exists
    // to measure, which would then under-price the setup a client is charged for.
    if (FAILED_STATUSES.has(job.status)) continue;
    const bucket = out[bucketForRunType(job.runType)];
    bucket.runs += 1;
    bucket.usd += usd;
    out.totalUsd += usd;
  }
  return out;
}

/* ── §6.3 launch-price calibration ────────────────────────────────── */

export interface LaunchCalibration {
  launchRuns: number;
  launchAvgUsd: number | null;
  runRuns: number;
  runAvgUsd: number | null;
  /** launchAvgUsd / runAvgUsd — null until BOTH sides have a sample. */
  ratio: number | null;
  /** round(ratio × creditCost) — the price to type into the agent editor. */
  suggestedLaunchCredits: number | null;
  /** True when either side is too thin to trust the number yet. */
  provisional: boolean;
}

/** Below this many samples on either side, the ratio is shown but flagged. */
export const CALIBRATION_MIN_SAMPLES = 3;

/**
 * What a setup run actually costs relative to a normal run, measured.
 *
 * Albert's intent (Q1): the launch price must reflect the REAL ratio of what a
 * setup costs versus a template run — not a guessed multiplier. So this returns
 * nulls rather than a fallback whenever the measurement does not exist yet: an
 * agent nobody has launched has no ratio, and inventing one is precisely the
 * behaviour the ruling rejects. `provisional` marks a ratio computed from a
 * handful of runs so the surface can show it without implying confidence.
 *
 * The denominator is scheduled + manual runs — normal production work. Untyped
 * legacy jobs are deliberately excluded: mixing runs of unknown kind into the
 * baseline is how a measured number quietly becomes a guessed one.
 */
export function calibrateLaunchPrice(input: {
  jobs: Job[];
  /** The agent's per-run credit price, for converting the ratio to credits. */
  creditCost: number;
}): LaunchCalibration {
  const economics = summarizeAgentEconomics(input.jobs);
  const launchAvgUsd =
    economics.launch.runs > 0 ? economics.launch.usd / economics.launch.runs : null;

  const runRuns = economics.scheduled.runs + economics.manual.runs;
  const runUsd = economics.scheduled.usd + economics.manual.usd;
  const runAvgUsd = runRuns > 0 ? runUsd / runRuns : null;

  const ratio =
    launchAvgUsd != null && runAvgUsd != null && runAvgUsd > 0 ? launchAvgUsd / runAvgUsd : null;

  return {
    launchRuns: economics.launch.runs,
    launchAvgUsd,
    runRuns,
    runAvgUsd,
    ratio,
    suggestedLaunchCredits: ratio != null ? Math.round(ratio * input.creditCost) : null,
    provisional:
      ratio != null &&
      (economics.launch.runs < CALIBRATION_MIN_SAMPLES || runRuns < CALIBRATION_MIN_SAMPLES),
  };
}

/* ── Self-calibrating run estimates (credits rework, 2026-09) ─────── */

/** How many recent runs an estimate is measured over. */
export const ESTIMATE_WINDOW = 10;

/**
 * Below this many measured runs, a median is one client's luck rather than a
 * price. Same threshold and same posture as `CALIBRATION_MIN_SAMPLES`: report
 * the fallback and SAY it is a fallback, never dress a thin sample as a
 * measurement.
 */
export const ESTIMATE_MIN_SAMPLES = 3;

export interface RunEstimate {
  /** Credits to quote before the run. */
  credits: number;
  /** True when this came from the family default, not from measurement. */
  fallback: boolean;
  /** How many settled runs the median was taken over. 0 on a fallback. */
  samples: number;
}

/** Middle value of a sorted copy; the lower middle on an even count. */
function median(values: readonly number[]): number {
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.floor((sorted.length - 1) / 2)]!;
}

/**
 * What one run of this agent should be QUOTED at, measured from what recent
 * runs of it actually cost us.
 *
 * MEDIAN, NOT MEAN, and that is the whole design of this function. One runaway
 * run — a retry storm, a research loop that would not converge — moves a mean
 * enough to reprice the product for everyone, and the client who sees the new
 * quote is not the client who caused it. The median moves only when the typical
 * run moves, which is the thing a price is supposed to track.
 *
 * NEVER INVENTS A NUMBER. Under `ESTIMATE_MIN_SAMPLES` it returns
 * `fallbackCredits` with `fallback: true` — the same refusal
 * `calibrateLaunchPrice` makes, for the same reason: a quote conjured from one
 * run is worse than the constant that has been roughly right all year.
 *
 * MEASURED FROM ACTUAL USD, NEVER FROM SETTLED CREDITS, which is what keeps the
 * 2× settlement cap from suppressing its own input. If the estimate were
 * computed from what clients were charged, an agent that persistently
 * under-estimates would settle at the cap, feed the capped figure back in, and
 * never learn its real price. Reading `job.external.totalCostUsd` breaks that
 * loop by construction.
 *
 * Pure: the caller supplies the sample. `recentRunCostsUsd` below builds it
 * from jobs the agent page already loads, so this costs no new read.
 */
export function estimateRunCredits(input: {
  /** Newest-first actual USD of recent successful runs. */
  recentUsd: readonly number[];
  /** agent.creditCost ?? the family default ?? CREDIT_COSTS.customAgentRun. */
  fallbackCredits: number;
}): RunEstimate {
  const sample = input.recentUsd
    .filter((usd) => Number.isFinite(usd) && usd > 0)
    .slice(0, ESTIMATE_WINDOW);
  if (sample.length < ESTIMATE_MIN_SAMPLES) {
    return { credits: input.fallbackCredits, fallback: true, samples: 0 };
  }
  return { credits: creditsForUsd(median(sample)), fallback: false, samples: sample.length };
}

/**
 * How many of ONE agent's runs the sample is drawn from, after filtering and
 * sorting.
 *
 * THE CAP BELONGS HERE, NOT AT A CALLER, and that is the whole note. The submit
 * path used to pre-cap the client's whole job list to the 50 newest across ALL
 * agents and then filter by agent, while the quoting surfaces filtered the full
 * list — so a client running six agents could have every one of the newest 50
 * jobs belong to a different agent, leaving the submit path with no sample and
 * the card with ten. The two would then quote and hold different numbers, which
 * is the exact defect D1 exists to prevent. One function, one input, one cap,
 * applied after the filter it is a cap ON.
 */
export const RUN_SAMPLE_LIMIT = 50;

/**
 * The USD sample `estimateRunCredits` measures over, newest first.
 *
 * ONE RUNG, not three. `clientId` narrows to this client's own history and is
 * what every caller passes; the parameter stays optional because
 * `summarizeAgentEconomics`-style cross-client questions are a legitimate use of
 * the same filter, not because a cross-client PRICING rung exists. It does not:
 * it would need a read the surfaces that QUOTE the price cannot afford, and a
 * ladder only one side can climb is how the quote and the hold came apart.
 * Below the minimum sample the answer is the constant.
 *
 * Failed and cancelled runs are excluded for the reason
 * `summarizeAgentEconomics` excludes them: a run that died is a partial one,
 * and its cost is not the price of a delivered run. Launch runs are excluded
 * too — a setup is a different piece of work and has its own price.
 */
export function recentRunCostsUsd(
  jobs: readonly Job[],
  filter: { customAgentId: string; clientId?: string },
): number[] {
  return jobs
    .filter((job) => job.customAgentId === filter.customAgentId)
    .filter((job) => !filter.clientId || job.clientId === filter.clientId)
    .filter((job) => !FAILED_STATUSES.has(job.status))
    .filter((job) => job.runType !== "launch" && job.runType !== "test")
    .filter((job) => typeof job.external?.totalCostUsd === "number")
    // SORTED HERE, IN MEMORY, and that is load-bearing rather than incidental:
    // `listJobs` has no `orderBy`, so Firestore returns rows in document-id
    // order — which for auto-ids is effectively arbitrary, not chronological.
    // Taking "the last 10" off an unsorted read would sample ten random runs
    // and call the result recent. Every caller hands the whole set in and the
    // ordering is imposed at this one point.
    .sort((a, b) => (b.updatedAt ?? b.createdAt ?? 0) - (a.updatedAt ?? a.createdAt ?? 0))
    // Filter, then sort, THEN cap — see RUN_SAMPLE_LIMIT. Capping earlier
    // samples the wrong runs; capping in a caller means two callers can cap
    // differently, which is how the quote and the hold diverge.
    .slice(0, RUN_SAMPLE_LIMIT)
    .map((job) => job.external!.totalCostUsd!);
}

/**
 * ONE ESTIMATE, computed the same way wherever it is needed — the price a
 * client is QUOTED on the agent page and the price actually HELD at dispatch
 * must be the same number, and the only way to guarantee that is one function
 * over one input.
 *
 * They diverged in the first cut: the page quoted the constant while
 * `submitCustomAgentJob` held the median, so a client read "25 credits" and
 * watched 18 leave their balance. A quote that does not match the charge is
 * worse than a quote that is merely stale.
 *
 * PURE, AND OVER THIS CLIENT'S JOBS ONLY. Both call sites already hold that
 * list, so the shared number costs no read at all — which is also what let the
 * cross-client rung go. That rung read the entire `jobs` collection to price a
 * brand-new client's first run, and it could not be reproduced on the page
 * without the same unbounded read; a ladder one caller can climb and the other
 * cannot is exactly how the two numbers came apart. Two rungs now: this
 * client's own measured median, then the constant.
 */
export function estimateRunCreditsFromJobs(
  jobs: readonly Job[],
  input: { clientId: string; customAgentId: string; fallbackCredits: number },
): RunEstimate {
  return estimateRunCredits({
    recentUsd: recentRunCostsUsd(jobs, {
      customAgentId: input.customAgentId,
      clientId: input.clientId,
    }),
    fallbackCredits: input.fallbackCredits,
  });
}

/**
 * The same estimate for a WHOLE ROSTER, walking the job list once.
 *
 * `estimateRunCreditsFromJobs` filters the full list per agent, which is
 * correct and, on a page rendering a dozen agent cards, a dozen passes over
 * every job the client has ever run. Grouping first makes it one pass plus a
 * map lookup, and — this is the part that matters — it is the SAME
 * `estimateRunCredits` over the SAME rows, so a roster card and the dialog it
 * opens cannot end up quoting different numbers because one of them took a
 * shortcut.
 */
export function estimateRunCreditsByAgent(
  jobs: readonly Job[],
  input: { clientId: string; fallbackCreditsFor: (customAgentId: string) => number },
): (customAgentId: string) => RunEstimate {
  const byAgent = new Map<string, Job[]>();
  for (const job of jobs) {
    if (!job.customAgentId) continue;
    if (job.clientId !== input.clientId) continue;
    const bucket = byAgent.get(job.customAgentId);
    if (bucket) bucket.push(job);
    else byAgent.set(job.customAgentId, [job]);
  }
  const cache = new Map<string, RunEstimate>();
  return (customAgentId: string) => {
    const hit = cache.get(customAgentId);
    if (hit) return hit;
    const estimate = estimateRunCreditsFromJobs(byAgent.get(customAgentId) ?? [], {
      clientId: input.clientId,
      customAgentId,
      fallbackCredits: input.fallbackCreditsFor(customAgentId),
    });
    cache.set(customAgentId, estimate);
    return estimate;
  };
}

/* ── What a client actually costs us this month (staff only) ──────── */

export interface ClientMonthlyCost {
  /** Our own measured spend on this client, month to date, in USD. */
  usd: number;
  /** The $130 line: MONTHLY_ALLOWANCE × USD_PER_CREDIT. */
  budgetUsd: number;
  /** usd / budgetUsd. Can exceed 1 — see the leaks below. */
  fraction: number;
  /** Runs counted, including failed and staff-fired ones. */
  runs: number;
  /**
   * Rows we KNOW we could not price (`pricingUnresolved`). Reported rather than
   * folded in as $0, because "we do not know" and "it was free" are two answers
   * and only one of them is safe to show beside a budget.
   */
  unpricedRows: number;
}

/**
 * Month-to-date cost to Karos of one client, beside the credits they were
 * charged (credits rework, 2026-09, §staff).
 *
 * WHY THIS IS NOT `monthSpent × $0.05`. Settle-to-actual guarantees the $130
 * line for every credit a client is CHARGED, and two kinds of real spend never
 * reach the ledger at all:
 *
 *   1. runs nobody billed — staff-fired runs, admin "View as Client", and any
 *      `ScheduledRun` with `billClientCredits !== true`. They burn real dollars
 *      and write no credit row, so the credit cap cannot see them;
 *   2. refunded failures — the client got their credits back, we did not get
 *      our tokens back.
 *
 * So this counts BOTH, deliberately including the failed and cancelled jobs
 * `summarizeAgentEconomics` excludes. That exclusion is right for calibration
 * (a dead run is not the price of a live one) and wrong for a budget watch (a
 * dead run still cost us). The gap between this figure and `monthSpent × $0.05`
 * IS the leak, and showing the two side by side is what makes it visible rather
 * than assumed.
 *
 * `usageRows` is optional: agent runs are the dominant cost and come from the
 * jobs, so a caller with no cheap way to query `usageLogs` still gets a figure
 * that is right about the money that matters. What it then misses is in-app
 * model spend (copilot turns, corrections) — pennies per action, and for
 * BILLABLE clients already reflected in the credits line beside it.
 */
export function summarizeClientMonthlyCost(input: {
  /** This client's jobs. Filtered to the month here, not by the caller. */
  jobs: readonly Job[];
  /** Optional `usageLogs` rows for this client, any window. */
  usageRows?: ReadonlyArray<
    Pick<import("@/lib/models/usage-log").UsageLog, "estimatedCostUsd" | "timestamp" | "pricingUnresolved" | "jobId">
  >;
  /** `creditMonthKey(now)` — the window the credits doc is counting in. */
  monthKey: string;
  /** MONTHLY_ALLOWANCE, passed in so this stays a pure function of its inputs. */
  monthlyAllowance: number;
}): ClientMonthlyCost {
  const inMonth = (ts?: number) =>
    typeof ts === "number" && monthKeyOf(ts) === input.monthKey;

  let usd = 0;
  let runs = 0;
  const countedJobIds = new Set<string>();
  for (const job of input.jobs) {
    const cost = job.external?.totalCostUsd;
    if (typeof cost !== "number" || !Number.isFinite(cost)) continue;
    if (!inMonth(job.updatedAt ?? job.createdAt)) continue;
    usd += cost;
    runs += 1;
    countedJobIds.add(job.id);
  }

  let unpricedRows = 0;
  for (const row of input.usageRows ?? []) {
    if (!inMonth(row.timestamp)) continue;
    if (row.pricingUnresolved) {
      unpricedRows += 1;
      continue;
    }
    // A usage row that belongs to a job already counted above would be the same
    // dollars twice: the webhook logs per-model rows AND stores the run total.
    if (row.jobId && countedJobIds.has(row.jobId)) continue;
    usd += row.estimatedCostUsd;
  }

  const budgetUsd = input.monthlyAllowance * USD_PER_CREDIT;
  return { usd, budgetUsd, fraction: budgetUsd > 0 ? usd / budgetUsd : 0, runs, unpricedRows };
}

/**
 * Month key of a timestamp, spelled here rather than imported from `credits.ts`
 * so this module keeps taking its window as a plain string argument. It is the
 * same UTC calendar month `creditMonthKey` computes; `credit-reporting.test.ts`
 * pins the two equal so they cannot drift.
 */
function monthKeyOf(ts: number): string {
  const d = new Date(ts);
  return `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, "0")}`;
}

/** Fraction of the monthly budget at which staff are warned. */
export const MONTHLY_COST_ALERT_FRACTION = 0.8;

/* ── What a CLIENT may be handed from the ledger ──────────────────── */

/**
 * Ledger fields a client viewer must never receive, named once.
 *
 * TWO KINDS OF SECRET, ONE LIST. `actorUid`/`actorName` are staff identity —
 * the admin who typed a grant. `actualUsd`/`settlementCapped` are staff
 * ECONOMICS: what a run cost Karos in dollars, and whether it cost us more than
 * double what we quoted. The second pair arrived with two-phase charging
 * (credits rework, 2026-09) on the very rows a client's own ledger renders, and
 * they are precisely the number the two-audience split exists to keep apart —
 * `agent-economics.tsx` is hard-gated on `viewerIsStaff` for this one figure.
 *
 * A LIST RATHER THAN A SPREAD AT THE CALL SITE, because the failure mode is
 * addition: the next staff-only field added to `CreditLedgerEntry` has to be
 * refused somewhere, and a hand-written object literal on a page is not a place
 * anyone thinks to look. `credit-attribution.test.ts` checks this list against
 * the type.
 */
export const STAFF_ONLY_LEDGER_FIELDS = [
  "actorUid",
  "actorName",
  "actualUsd",
  "settlementCapped",
] as const satisfies ReadonlyArray<keyof CreditLedgerEntry>;

/**
 * A ledger row as a CLIENT may receive it.
 *
 * STRIPPED, NOT WITHHELD AT RENDER. `CreditsPanel` is a `"use client"`
 * component, so every field that crosses into it sits in the RSC payload and is
 * readable from view-source whether or not the panel paints it. Deciding this on
 * the server is the only place the decision is real.
 *
 * `actorUid` is emptied rather than deleted because the type requires it; the
 * rest are set to `undefined`, which Next drops from the payload entirely.
 */
export function redactLedgerForClient(rows: readonly CreditLedgerEntry[]): CreditLedgerEntry[] {
  return rows.map((row) => ({
    ...row,
    actorUid: "",
    actorName: undefined,
    actualUsd: undefined,
    settlementCapped: undefined,
  }));
}
