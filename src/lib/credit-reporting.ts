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

import { creditBucketFor, type CreditBucket } from "@/lib/credits";
import type { CreditLedgerEntry, Job, JobRunType } from "@/lib/types";

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

const BUCKET_ORDER: CreditBucket[] = ["setup", "scheduled", "manual", "other"];

/**
 * Group a client's charges by agent, then by kind.
 *
 * CHARGES ONLY. Grants, refunds and adjustments are balance movements, not
 * usage — folding a refund in as negative usage would show an agent that failed
 * and refunded as having cost less than it did, and folding a grant in would
 * show it as having earned credits. `kind === "charge"` is the filter, and the
 * ledger's own `delta` is negative on a charge so it is normalized to a
 * positive "spend" here.
 */
export function summarizeClientSpend(input: {
  ledger: CreditLedgerEntry[];
  /** jobId → run type, for splitting agent runs into scheduled vs manual. */
  runTypeByJobId: Record<string, JobRunType | undefined>;
  /** agentId → display name. Missing ⇒ the agent was deleted. */
  agentNameById: Record<string, string>;
}): AgentSpendRow[] {
  const rows = new Map<string, AgentSpendRow>();

  for (const entry of input.ledger) {
    if (entry.kind !== "charge") continue;
    const credits = Math.abs(entry.delta);
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
          ? (input.agentNameById[agentId] ?? "Removed agent")
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
   * Jobs that predate run-type stamping. Reported as its own bucket and
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
