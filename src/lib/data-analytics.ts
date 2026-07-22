import "server-only";

import { adminDb } from "@/lib/firebase/admin";
import {
  resolveModelName,
  MODEL_PRICING,
  type UsageLog,
  type ErrorLog,
  type AnalyticsSnapshot,
} from "@/lib/models/usage-log";
import { resolveAgentAttribution } from "@/lib/models/agent-attribution";
export { RANGE_OPTIONS, isValidRange, rangeToSince } from "@/lib/analytics-constants";
export type { RangeKey } from "@/lib/analytics-constants";

/* ── Helpers ─────────────────────────────────────────────────────── */

function withId<T>(doc: FirebaseFirestore.DocumentSnapshot): T {
  return { id: doc.id, ...(doc.data() as object) } as T;
}

const EMPTY_SNAPSHOT: AnalyticsSnapshot = {
  totalCostUsd: 0,
  totalInputTokens: 0,
  totalOutputTokens: 0,
  totalRuns: 0,
  totalErrors: 0,
  lastUpdated: 0,
};

/* ── Snapshot reads (O(1)) ───────────────────────────────────────── */

export async function getGlobalSnapshot(): Promise<AnalyticsSnapshot> {
  const doc = await adminDb().collection("analyticsSnapshot").doc("global").get();
  return doc.exists ? (doc.data() as AnalyticsSnapshot) : { ...EMPTY_SNAPSHOT };
}

export async function getClientSnapshot(clientId: string): Promise<AnalyticsSnapshot> {
  const doc = await adminDb()
    .collection("analyticsSnapshot")
    .doc(`client_${clientId}`)
    .get();
  return doc.exists ? (doc.data() as AnalyticsSnapshot) : { ...EMPTY_SNAPSHOT };
}

/* ── Log reads ───────────────────────────────────────────────────── */

/**
 * Recent error logs. When clientId is supplied, we overfetch and filter in
 * memory to avoid a composite Firestore index. Optional `since` adds a
 * timestamp lower-bound using the auto-indexed single-field index.
 */
export async function listRecentErrors(opts?: {
  clientId?: string;
  since?: number;
  limit?: number;
}): Promise<ErrorLog[]> {
  const limit = opts?.limit ?? 50;
  const fetchLimit = opts?.clientId ? Math.max(limit * 10, 500) : limit;

  let q = adminDb().collection("errorLogs").orderBy("timestamp", "desc");
  if (opts?.since) q = (q as FirebaseFirestore.Query).where("timestamp", ">=", opts.since) as typeof q;
  const snap = await q.limit(fetchLimit).get();

  let logs = snap.docs.map((d) => withId<ErrorLog>(d));
  if (opts?.clientId) logs = logs.filter((l) => l.clientId === opts.clientId);
  return logs.slice(0, limit);
}

/** Recent usage logs. Same strategy. */
export async function listRecentUsageLogs(opts?: {
  clientId?: string;
  since?: number;
  limit?: number;
}): Promise<UsageLog[]> {
  const limit = opts?.limit ?? 100;
  const fetchLimit = opts?.clientId ? Math.max(limit * 10, 500) : limit;

  let q = adminDb().collection("usageLogs").orderBy("timestamp", "desc");
  if (opts?.since) q = (q as FirebaseFirestore.Query).where("timestamp", ">=", opts.since) as typeof q;
  const snap = await q.limit(fetchLimit).get();

  let logs = snap.docs.map((d) => withId<UsageLog>(d));
  if (opts?.clientId) logs = logs.filter((l) => l.clientId === opts.clientId);
  return logs.slice(0, limit);
}

/**
 * Usage logs since `since` (0 = no lower bound), capped at `limit` docs and
 * filtered by clientId in memory — the same "avoid a composite index" shape
 * as every other read in this module. Shared by the agent leaderboard and
 * per-agent drilldown so both bound their scan the same way.
 */
async function fetchUsageLogsCapped(opts: {
  since: number;
  clientId?: string;
  limit: number;
}): Promise<UsageLog[]> {
  const query = opts.since > 0
    ? adminDb().collection("usageLogs").where("timestamp", ">=", opts.since).orderBy("timestamp", "desc")
    : adminDb().collection("usageLogs").orderBy("timestamp", "desc");
  const snap = await query.limit(opts.limit).get();

  let logs = snap.docs.map((d) => withId<UsageLog>(d));
  if (opts.clientId) logs = logs.filter((l) => l.clientId === opts.clientId);
  return logs;
}

/* ── Derived analytics ───────────────────────────────────────────── */

export interface ModelStat {
  modelName: string;
  inputPer1M: number;
  outputPer1M: number;
  inputTokens: number;
  outputTokens: number;
  costUsd: number;
  runs: number;
  pctOfTotalCost: number;
}

/** Extract per-model statistics from a snapshot's flattened model_* fields. */
export function extractModelStats(snapshot: AnalyticsSnapshot): ModelStat[] {
  const seen = new Set<string>();
  const stats: ModelStat[] = [];

  for (const key of Object.keys(snapshot)) {
    const m = key.match(/^model_(.+)_runs$/);
    if (!m) continue;
    const sanitized = m[1];
    if (seen.has(sanitized)) continue;
    seen.add(sanitized);

    const modelName = resolveModelName(sanitized);
    const pricing = MODEL_PRICING[modelName] ?? { inputPer1M: 3.0, outputPer1M: 15.0 };
    stats.push({
      modelName,
      inputPer1M: pricing.inputPer1M,
      outputPer1M: pricing.outputPer1M,
      inputTokens: (snapshot[`model_${sanitized}_inputTokens`] as number) ?? 0,
      outputTokens: (snapshot[`model_${sanitized}_outputTokens`] as number) ?? 0,
      costUsd: (snapshot[`model_${sanitized}_costUsd`] as number) ?? 0,
      runs: (snapshot[`model_${sanitized}_runs`] as number) ?? 0,
      pctOfTotalCost: 0, // filled in below
    });
  }

  stats.sort((a, b) => b.costUsd - a.costUsd);
  const total = stats.reduce((s, m) => s + m.costUsd, 0);
  if (total > 0) {
    for (const s of stats) s.pctOfTotalCost = (s.costUsd / total) * 100;
  }
  return stats;
}

export interface AgentStat {
  /** Stable grouping key from resolveAgentAttribution() — use as the filter-on-click value. */
  agentKey: string;
  agentDisplayName: string;
  runs: number;
  inputTokens: number;
  outputTokens: number;
  costUsd: number;
}

export interface RangeStats {
  totalCostUsd: number;
  totalInputTokens: number;
  totalOutputTokens: number;
  totalRuns: number;
  totalErrors: number;
  modelStats: ModelStat[];
  agentStats: AgentStat[];
}

/** Group already-fetched usage logs into per-agent cost/token stats, cost-desc. */
function aggregateAgentStats(logs: UsageLog[]): AgentStat[] {
  const agentMap = new Map<string, AgentStat>();
  for (const log of logs) {
    const { agentKey, agentDisplayName } = resolveAgentAttribution(log);
    const s = agentMap.get(agentKey) ?? {
      agentKey,
      agentDisplayName,
      runs: 0,
      inputTokens: 0,
      outputTokens: 0,
      costUsd: 0,
    };
    s.runs          += 1;
    s.inputTokens   += log.inputTokens;
    s.outputTokens  += log.outputTokens;
    s.costUsd       += log.estimatedCostUsd;
    agentMap.set(agentKey, s);
  }
  return [...agentMap.values()].sort((a, b) => b.costUsd - a.costUsd);
}

/**
 * Compute KPI + breakdowns from raw logs since `since`.
 * Fetches up to 2000 usage logs and 500 error logs, filters by clientId in
 * memory. Avoids composite indexes by querying on a single indexed field.
 */
export async function getRangeStats(opts: {
  since: number;
  clientId?: string;
}): Promise<RangeStats> {
  const [usageLogs, errorSnap] = await Promise.all([
    fetchUsageLogsCapped({ since: opts.since, clientId: opts.clientId, limit: 2000 }),
    adminDb()
      .collection("errorLogs")
      .where("timestamp", ">=", opts.since)
      .orderBy("timestamp", "desc")
      .limit(500)
      .get(),
  ]);

  let errorLogs = errorSnap.docs.map((d) => withId<ErrorLog>(d));
  if (opts.clientId) {
    errorLogs = errorLogs.filter((l) => l.clientId === opts.clientId);
  }

  // Aggregate KPIs
  let totalCostUsd = 0, totalInputTokens = 0, totalOutputTokens = 0;
  const modelMap = new Map<string, { inputTokens: number; outputTokens: number; costUsd: number; runs: number }>();

  for (const log of usageLogs) {
    totalCostUsd     += log.estimatedCostUsd;
    totalInputTokens += log.inputTokens;
    totalOutputTokens += log.outputTokens;

    // Per-model
    const mk = log.modelName;
    const ms = modelMap.get(mk) ?? { inputTokens: 0, outputTokens: 0, costUsd: 0, runs: 0 };
    ms.inputTokens  += log.inputTokens;
    ms.outputTokens += log.outputTokens;
    ms.costUsd      += log.estimatedCostUsd;
    ms.runs         += 1;
    modelMap.set(mk, ms);
  }

  // Build model stats
  const modelStats: ModelStat[] = [...modelMap.entries()].map(([modelName, m]) => {
    const pricing = MODEL_PRICING[modelName] ?? { inputPer1M: 3.0, outputPer1M: 15.0 };
    return { modelName, inputPer1M: pricing.inputPer1M, outputPer1M: pricing.outputPer1M, ...m, pctOfTotalCost: 0 };
  });
  modelStats.sort((a, b) => b.costUsd - a.costUsd);
  if (totalCostUsd > 0) {
    for (const s of modelStats) s.pctOfTotalCost = (s.costUsd / totalCostUsd) * 100;
  }

  const agentStats = aggregateAgentStats(usageLogs);

  return {
    totalCostUsd,
    totalInputTokens,
    totalOutputTokens,
    totalRuns: usageLogs.length,
    totalErrors: errorLogs.length,
    modelStats,
    agentStats,
  };
}

/**
 * Agent leaderboard for "all time" — the analyticsSnapshot doc gives O(1)
 * global/model KPIs but has no per-agent breakdown, so this scans a bounded
 * window of the most recent usage logs instead (same tradeoff as the
 * pre-refactor leaderboard, just grouped by resolveAgentAttribution and with
 * a wider window since dashboard reads are allowed to cost more than writes).
 */
export async function getAllTimeAgentStats(opts?: {
  clientId?: string;
  limit?: number;
}): Promise<AgentStat[]> {
  const logs = await fetchUsageLogsCapped({ since: 0, clientId: opts?.clientId, limit: opts?.limit ?? 3000 });
  return aggregateAgentStats(logs);
}

export interface AgentDrilldown {
  agentKey: string;
  agentDisplayName: string;
  totalCostUsd: number;
  totalInputTokens: number;
  totalOutputTokens: number;
  totalRuns: number;
  modelStats: ModelStat[];
}

/**
 * Model/token breakdown for one agent (the Agent Leaderboard's filter-on-click
 * drilldown), scoped to the same since/clientId window as the rest of the
 * dashboard. Returns null when the agent has no logs in that window.
 */
export async function getAgentDrilldown(opts: {
  agentKey: string;
  since: number;
  clientId?: string;
  limit?: number;
}): Promise<AgentDrilldown | null> {
  const logs = await fetchUsageLogsCapped({
    since: opts.since,
    clientId: opts.clientId,
    limit: opts.limit ?? (opts.since > 0 ? 2000 : 3000),
  });
  const scoped = logs.filter((l) => resolveAgentAttribution(l).agentKey === opts.agentKey);
  if (scoped.length === 0) return null;

  const { agentDisplayName } = resolveAgentAttribution(scoped[0]!);
  const modelMap = new Map<string, { inputTokens: number; outputTokens: number; costUsd: number; runs: number }>();
  let totalCostUsd = 0, totalInputTokens = 0, totalOutputTokens = 0;

  for (const log of scoped) {
    totalCostUsd      += log.estimatedCostUsd;
    totalInputTokens  += log.inputTokens;
    totalOutputTokens += log.outputTokens;

    const m = modelMap.get(log.modelName) ?? { inputTokens: 0, outputTokens: 0, costUsd: 0, runs: 0 };
    m.inputTokens  += log.inputTokens;
    m.outputTokens += log.outputTokens;
    m.costUsd      += log.estimatedCostUsd;
    m.runs         += 1;
    modelMap.set(log.modelName, m);
  }

  const modelStats: ModelStat[] = [...modelMap.entries()]
    .map(([modelName, m]) => {
      const pricing = MODEL_PRICING[modelName] ?? { inputPer1M: 3.0, outputPer1M: 15.0 };
      return {
        modelName,
        inputPer1M: pricing.inputPer1M,
        outputPer1M: pricing.outputPer1M,
        ...m,
        pctOfTotalCost: totalCostUsd > 0 ? (m.costUsd / totalCostUsd) * 100 : 0,
      };
    })
    .sort((a, b) => b.costUsd - a.costUsd);

  return {
    agentKey: opts.agentKey,
    agentDisplayName,
    totalCostUsd,
    totalInputTokens,
    totalOutputTokens,
    totalRuns: scoped.length,
    modelStats,
  };
}

/* ── Formatting helpers (used by both server and client components) ── */

export function fmtCost(usd: number): string {
  if (usd === 0) return "$0.00";
  if (usd < 0.01) return `$${usd.toFixed(6)}`;
  if (usd < 1) return `$${usd.toFixed(4)}`;
  return "$" + usd.toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 });
}

export function fmtTokens(n: number): string {
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`;
  if (n >= 1_000) return `${(n / 1_000).toFixed(1)}K`;
  return String(n);
}
