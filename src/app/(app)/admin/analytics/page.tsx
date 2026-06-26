import { redirect } from "next/navigation";
import { requireUser } from "@/lib/auth";
import { listClients } from "@/lib/data";
import {
  getGlobalSnapshot,
  getClientSnapshot,
  getRangeStats,
  listRecentErrors,
  extractModelStats,
  fmtCost,
  fmtTokens,
  isValidRange,
  rangeToSince,
  RANGE_OPTIONS,
  type ModelStat,
  type AgentStat,
} from "@/lib/data-analytics";
import { Card, CardTitle, Badge, EmptyState } from "@/components/ui";
import { Icon } from "@/components/icon";
import { AnalyticsFilters } from "@/components/analytics-dashboard";
import { relativeTime } from "@/lib/utils";

export default async function AnalyticsPage({
  searchParams,
}: {
  searchParams: Promise<{ clientId?: string; range?: string }>;
}) {
  const user = await requireUser();
  if (user.role !== "KAROS_ADMIN") redirect("/dashboard");

  const { clientId, range: rawRange } = await searchParams;
  const range = isValidRange(rawRange) ? rawRange : undefined;
  const since = range ? rangeToSince(range) : 0;

  const rangeLabel = range
    ? RANGE_OPTIONS.find((o) => o.value === range)?.label ?? range
    : "All time";

  /* ── Fetch ─────────────────────────────────────────────────────── */

  let totalCostUsd = 0, totalInputTokens = 0, totalOutputTokens = 0;
  let totalRuns = 0, totalErrors = 0;
  let modelStats: ModelStat[] = [];
  let agentStats: AgentStat[] = [];

  if (range) {
    const [rs, errs, clients] = await Promise.all([
      getRangeStats({ since, clientId }),
      listRecentErrors({ clientId, since, limit: 20 }),
      listClients(),
    ]);

    totalCostUsd      = rs.totalCostUsd;
    totalInputTokens  = rs.totalInputTokens;
    totalOutputTokens = rs.totalOutputTokens;
    totalRuns         = rs.totalRuns;
    totalErrors       = rs.totalErrors;
    modelStats        = rs.modelStats;
    agentStats        = rs.agentStats;

    return renderPage({
      rangeLabel, range, clientId, clients,
      totalCostUsd, totalInputTokens, totalOutputTokens, totalRuns, totalErrors,
      modelStats, agentStats,
      errors: errs,
    });
  }

  // All-time: use O(1) snapshot + recent logs for leaderboard
  const [snapshot, errors, usageLogs, clients] = await Promise.all([
    clientId ? getClientSnapshot(clientId) : getGlobalSnapshot(),
    listRecentErrors({ clientId, limit: 20 }),
    // For leaderboard in all-time mode we still need recent usage logs
    import("@/lib/data-analytics").then((m) =>
      m.listRecentUsageLogs({ clientId, limit: 200 }),
    ),
    listClients(),
  ]);

  totalCostUsd      = snapshot.totalCostUsd;
  totalInputTokens  = snapshot.totalInputTokens;
  totalOutputTokens = snapshot.totalOutputTokens;
  totalRuns         = snapshot.totalRuns;
  totalErrors       = snapshot.totalErrors;
  modelStats        = extractModelStats(snapshot);

  // Build agent leaderboard from recent usage logs
  const agentRunMap = new Map<string, AgentStat>();
  for (const log of usageLogs) {
    if (!log.agentId) continue;
    const e = agentRunMap.get(log.agentId);
    if (e) { e.runs++; e.costUsd += log.estimatedCostUsd; }
    else agentRunMap.set(log.agentId, { agentId: log.agentId, agentName: log.agentName, runs: 1, costUsd: log.estimatedCostUsd });
  }
  agentStats = [...agentRunMap.values()].sort((a, b) => b.runs - a.runs);

  return renderPage({
    rangeLabel, range, clientId, clients,
    totalCostUsd, totalInputTokens, totalOutputTokens, totalRuns, totalErrors,
    modelStats, agentStats,
    errors,
  });
}

/* ── Pure render ─────────────────────────────────────────────────── */

function renderPage(p: {
  rangeLabel: string;
  range?: string;
  clientId?: string;
  clients: Awaited<ReturnType<typeof listClients>>;
  totalCostUsd: number;
  totalInputTokens: number;
  totalOutputTokens: number;
  totalRuns: number;
  totalErrors: number;
  modelStats: ModelStat[];
  agentStats: AgentStat[];
  errors: Awaited<ReturnType<typeof listRecentErrors>>;
}) {
  const {
    rangeLabel, range, clientId, clients,
    totalCostUsd, totalInputTokens, totalOutputTokens, totalRuns, totalErrors,
    modelStats, agentStats, errors,
  } = p;

  const errorRate =
    totalRuns > 0
      ? ((totalErrors / (totalRuns + totalErrors)) * 100).toFixed(1)
      : "0.0";

  const selectedClient = clientId ? clients.find((c) => c.id === clientId) : null;

  const kpis = [
    {
      label: "Total Cost",
      value: fmtCost(totalCostUsd),
      sub: "estimated USD",
    },
    {
      label: "Total Tokens",
      value: fmtTokens(totalInputTokens + totalOutputTokens),
      sub: `${fmtTokens(totalInputTokens)} in / ${fmtTokens(totalOutputTokens)} out`,
    },
    {
      label: "Total Runs",
      value: totalRuns.toLocaleString(),
      sub: "agent executions",
    },
    {
      label: "Error Rate",
      value: `${errorRate}%`,
      sub: `${totalErrors} error${totalErrors === 1 ? "" : "s"}`,
    },
  ];

  const maxAgentRuns = agentStats[0]?.runs ?? 1;

  return (
    <div className="space-y-8">
      {/* Header */}
      <div className="flex flex-wrap items-start justify-between gap-4">
        <div>
          <h1 className="text-2xl font-semibold tracking-tight">Analytics</h1>
          <p className="text-sm text-muted">
            {rangeLabel}
            {selectedClient ? ` · ${selectedClient.name}` : " · all clients"}
          </p>
        </div>
        <AnalyticsFilters
          clients={clients}
          currentClientId={clientId}
          currentRange={range}
        />
      </div>

      {/* KPI cards */}
      <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
        {kpis.map((k) => (
          <Card key={k.label} className="space-y-1">
            <p className="text-xs font-medium uppercase tracking-widest text-muted">
              {k.label}
            </p>
            <p className="font-mono text-3xl font-semibold tabular-nums">{k.value}</p>
            <p className="text-xs text-muted-2">{k.sub}</p>
          </Card>
        ))}
      </div>

      {/* Two-column: model breakdown + agent leaderboard */}
      <div className="grid gap-6 lg:grid-cols-2">
        {/* Model breakdown */}
        <Card>
          <CardTitle className="mb-4">Model breakdown</CardTitle>
          {modelStats.length === 0 ? (
            <EmptyState
              icon={<Icon name="BarChart2" className="h-5 w-5" />}
              title="No model usage"
              description="No runs recorded in this period."
            />
          ) : (
            <div className="overflow-x-auto">
              <table className="w-full text-sm">
                <thead>
                  <tr className="border-b border-border text-left text-xs text-muted">
                    <th className="pb-2 pr-4 font-medium">Model</th>
                    <th className="pb-2 pr-4 text-right font-medium">Runs</th>
                    <th className="pb-2 pr-4 text-right font-medium">Tokens</th>
                    <th className="pb-2 text-right font-medium">Cost</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-border">
                  {modelStats.map((m) => (
                    <tr key={m.modelName} className="text-xs transition-colors hover:bg-surface-2/40">
                      <td className="py-2 pr-4">
                        <div className="font-medium">{m.modelName}</div>
                        <div className="font-mono text-muted-2">
                          ${m.inputPer1M}/1M in · ${m.outputPer1M}/1M out
                        </div>
                      </td>
                      <td className="py-2 pr-4 text-right font-mono tabular-nums">
                        {m.runs.toLocaleString()}
                      </td>
                      <td className="py-2 pr-4 text-right font-mono tabular-nums">
                        {fmtTokens(m.inputTokens + m.outputTokens)}
                      </td>
                      <td className="py-2 text-right font-mono tabular-nums">
                        <div>{fmtCost(m.costUsd)}</div>
                        <div className="text-muted-2">
                          {m.pctOfTotalCost.toFixed(1)}%
                        </div>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </Card>

        {/* Agent leaderboard */}
        <Card>
          <CardTitle className="mb-4">Agent leaderboard</CardTitle>
          {agentStats.length === 0 ? (
            <EmptyState
              icon={<Icon name="Bot" className="h-5 w-5" />}
              title="No agent runs"
              description="No agent executions recorded in this period."
            />
          ) : (
            <ul className="space-y-3">
              {agentStats.slice(0, 10).map((a, i) => (
                <li key={a.agentId}>
                  <div className="mb-1 flex items-center justify-between text-xs">
                    <span className="flex items-center gap-2">
                      <span className="w-4 text-right text-muted-2">{i + 1}.</span>
                      <span className="font-medium">{a.agentName}</span>
                    </span>
                    <span className="font-mono tabular-nums text-muted-2">
                      {a.runs} run{a.runs === 1 ? "" : "s"} · {fmtCost(a.costUsd)}
                    </span>
                  </div>
                  <div className="h-1.5 w-full overflow-hidden rounded-full bg-surface-2">
                    <div
                      className="h-full rounded-full bg-neon"
                      style={{ width: `${(a.runs / maxAgentRuns) * 100}%` }}
                    />
                  </div>
                </li>
              ))}
            </ul>
          )}
        </Card>
      </div>

      {/* Error log feed */}
      <Card>
        <CardTitle className="mb-4">Recent errors</CardTitle>
        {errors.length === 0 ? (
          <EmptyState
            icon={<Icon name="ShieldCheck" className="h-5 w-5" />}
            title="No errors recorded"
            description="Clean run — no errors in this period."
          />
        ) : (
          <ul className="divide-y divide-border">
            {errors.map((e) => (
              <li key={e.id} className="py-3">
                <div className="flex flex-wrap items-start justify-between gap-2">
                  <div className="min-w-0 flex-1">
                    <div className="flex items-center gap-2">
                      <Badge
                        tone={
                          e.severity === "WARN" ? "warning" : "danger"
                        }
                      >
                        {e.severity}
                      </Badge>
                      <span className="text-xs text-muted">{e.operation}</span>
                      {e.agentId && (
                        <span className="text-xs text-muted-2">· {e.agentId}</span>
                      )}
                    </div>
                    <p className="mt-1 text-sm">{e.errorMessage}</p>
                    {e.stackTrace && (
                      <pre className="mt-1 overflow-x-auto rounded bg-surface-2 p-2 text-xs text-muted-2">
                        {e.stackTrace.split("\n").slice(0, 4).join("\n")}
                      </pre>
                    )}
                  </div>
                  <span className="shrink-0 text-xs text-muted-2">
                    {relativeTime(e.timestamp)}
                  </span>
                </div>
              </li>
            ))}
          </ul>
        )}
      </Card>
    </div>
  );
}
