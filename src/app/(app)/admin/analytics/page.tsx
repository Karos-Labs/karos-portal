import { redirect } from "next/navigation";
import Link from "next/link";
import { requireUser } from "@/lib/auth";
import { listClients, listLoginLogs, listFeedbacks, getClientCredits } from "@/lib/data";
import { listAllClientAgentFeedback, listClientAgents } from "@/lib/data-client-agents";
import { availableCredits } from "@/lib/credits";
import { LOW_CREDIT_THRESHOLD } from "@/lib/constants";
import {
  getGlobalSnapshot,
  getClientSnapshot,
  getRangeStats,
  getAllTimeAgentStats,
  getAgentDrilldown,
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
import { AgentFeedbackHistoryTable, AnalyticsFilters, FeedbackTable } from "@/components/analytics-dashboard";
import { relativeTime, cn } from "@/lib/utils";
import type { ClientAgentFeedback } from "@/lib/types";

interface LowCreditClient {
  id: string;
  name: string;
  spendable: number;
}

/**
 * Clients at or below LOW_CREDIT_THRESHOLD, lowest first. The client-facing
 * wall says "ask your Karos team for a top-up" and the copilot repeats it under
 * 20 — but the Karos team had no queue, notification or dashboard telling them
 * who was asking (QA F117). SPENDABLE credits, so a client blocked by a weekly
 * cap shows up too, not just an empty balance.
 */
async function lowCreditClients(
  clients: Awaited<ReturnType<typeof listClients>>,
): Promise<LowCreditClient[]> {
  const rows = await Promise.all(
    clients.map(async (c) => ({
      id: c.id,
      name: c.name,
      spendable: availableCredits(await getClientCredits(c.id)),
    })),
  );
  return rows
    .filter((r) => r.spendable <= LOW_CREDIT_THRESHOLD)
    .sort((a, b) => a.spendable - b.spendable);
}

export default async function AnalyticsPage({
  searchParams,
}: {
  searchParams: Promise<{ clientId?: string; range?: string; agentKey?: string }>;
}) {
  const user = await requireUser();
  if (user.role !== "KAROS_ADMIN") redirect("/dashboard");

  const { clientId, range: rawRange, agentKey } = await searchParams;
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
  let agentDisplayName: string | undefined;

  if (range) {
    const [rs, errs, clients, loginLogs, feedbacks, drilldown, agentFeedbackRows, umbrellas] = await Promise.all([
      getRangeStats({ since, clientId }),
      listRecentErrors({ clientId, since, limit: 20 }),
      listClients(),
      clientId ? Promise.resolve([]) : listLoginLogs({ since, limit: 500 }),
      listFeedbacks(),
      agentKey ? getAgentDrilldown({ agentKey, since, clientId }) : Promise.resolve(null),
      listAllClientAgentFeedback(),
      listClientAgents(),
    ]);

    totalCostUsd      = rs.totalCostUsd;
    totalInputTokens  = rs.totalInputTokens;
    totalOutputTokens = rs.totalOutputTokens;
    totalRuns         = rs.totalRuns;
    totalErrors       = rs.totalErrors;
    modelStats        = rs.modelStats;
    agentStats        = rs.agentStats;

    // Filter-on-click: the selected agent's own totals + model breakdown
    // replace the headline KPIs/model table, while the leaderboard itself
    // keeps showing every agent so the user can compare or switch.
    if (agentKey && drilldown) {
      totalCostUsd      = drilldown.totalCostUsd;
      totalInputTokens  = drilldown.totalInputTokens;
      totalOutputTokens = drilldown.totalOutputTokens;
      totalRuns         = drilldown.totalRuns;
      modelStats        = drilldown.modelStats;
      agentDisplayName  = drilldown.agentDisplayName;
    } else if (agentKey) {
      totalCostUsd = totalInputTokens = totalOutputTokens = totalRuns = 0;
      modelStats = [];
      agentDisplayName = agentStats.find((a) => a.agentKey === agentKey)?.agentDisplayName ?? "Selected agent";
    }

    return renderPage({
      rangeLabel, range, clientId, clients, agentKey, agentDisplayName,
      totalCostUsd, totalInputTokens, totalOutputTokens, totalRuns, totalErrors,
      modelStats, agentStats,
      errors: errs,
      loginCount: loginLogs.length,
      feedbacks,
      agentFeedbackRows,
      agentNames: Object.fromEntries(umbrellas.map((u) => [u.id, u.displayName])),
      lowCredits: await lowCreditClients(clients),
    });
  }

  // All-time: use O(1) snapshot for global KPIs + a bounded raw-log scan for
  // the agent leaderboard (the snapshot has no per-agent breakdown).
  const [snapshot, errors, clients, loginLogs, feedbacks, allTimeAgentStats, drilldown, agentFeedbackRows, umbrellas] =
    await Promise.all([
      clientId ? getClientSnapshot(clientId) : getGlobalSnapshot(),
      listRecentErrors({ clientId, limit: 20 }),
      listClients(),
      clientId ? Promise.resolve([]) : listLoginLogs({ limit: 500 }),
      listFeedbacks(),
      getAllTimeAgentStats({ clientId }),
      agentKey ? getAgentDrilldown({ agentKey, since: 0, clientId }) : Promise.resolve(null),
      listAllClientAgentFeedback(),
      listClientAgents(),
    ]);

  totalCostUsd      = snapshot.totalCostUsd;
  totalInputTokens  = snapshot.totalInputTokens;
  totalOutputTokens = snapshot.totalOutputTokens;
  totalRuns         = snapshot.totalRuns;
  totalErrors       = snapshot.totalErrors;
  modelStats        = extractModelStats(snapshot);
  agentStats        = allTimeAgentStats;

  if (agentKey && drilldown) {
    totalCostUsd      = drilldown.totalCostUsd;
    totalInputTokens  = drilldown.totalInputTokens;
    totalOutputTokens = drilldown.totalOutputTokens;
    totalRuns         = drilldown.totalRuns;
    modelStats        = drilldown.modelStats;
    agentDisplayName  = drilldown.agentDisplayName;
  } else if (agentKey) {
    totalCostUsd = totalInputTokens = totalOutputTokens = totalRuns = 0;
    modelStats = [];
    agentDisplayName = agentStats.find((a) => a.agentKey === agentKey)?.agentDisplayName ?? "Selected agent";
  }

  return renderPage({
    rangeLabel, range, clientId, clients, agentKey, agentDisplayName,
    totalCostUsd, totalInputTokens, totalOutputTokens, totalRuns, totalErrors,
    modelStats, agentStats,
    errors,
    loginCount: loginLogs.length,
    feedbacks,
    agentFeedbackRows,
    agentNames: Object.fromEntries(umbrellas.map((u) => [u.id, u.displayName])),
    lowCredits: await lowCreditClients(clients),
  });
}

/* ── Pure render ─────────────────────────────────────────────────── */

function renderPage(p: {
  rangeLabel: string;
  range?: string;
  clientId?: string;
  clients: Awaited<ReturnType<typeof listClients>>;
  agentKey?: string;
  agentDisplayName?: string;
  totalCostUsd: number;
  totalInputTokens: number;
  totalOutputTokens: number;
  totalRuns: number;
  totalErrors: number;
  modelStats: ModelStat[];
  agentStats: AgentStat[];
  errors: Awaited<ReturnType<typeof listRecentErrors>>;
  loginCount: number;
  feedbacks: Awaited<ReturnType<typeof listFeedbacks>>;
  agentFeedbackRows: ClientAgentFeedback[];
  /** clientAgentId → the umbrella's display name. */
  agentNames: Record<string, string>;
  lowCredits: LowCreditClient[];
}) {
  const {
    rangeLabel, range, clientId, clients, agentKey, agentDisplayName,
    totalCostUsd, totalInputTokens, totalOutputTokens, totalRuns, totalErrors,
    modelStats, agentStats, errors, loginCount, feedbacks, agentFeedbackRows, agentNames, lowCredits,
  } = p;

  /** Build an /admin/analytics href preserving clientId/range, overriding agentKey. */
  function analyticsHref(nextAgentKey?: string): string {
    const params = new URLSearchParams();
    if (clientId) params.set("clientId", clientId);
    if (range) params.set("range", range);
    if (nextAgentKey) params.set("agentKey", nextAgentKey);
    const qs = params.toString();
    return `/admin/analytics${qs ? `?${qs}` : ""}`;
  }

  const displayFeedbacks = clientId
    ? feedbacks.filter((f) => f.clientId === clientId)
    : feedbacks;
  const displayAgentFeedbackRows = clientId
    ? agentFeedbackRows.filter((r) => r.clientId === clientId)
    : agentFeedbackRows;

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
    ...(clientId
      ? []
      : [
          {
            label: "User Logins",
            value: loginCount.toLocaleString(),
            sub: rangeLabel.toLowerCase(),
          },
        ]),
  ];

  const maxAgentCost = Math.max(agentStats[0]?.costUsd ?? 0, 0.000001);

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
          currentAgentKey={agentKey}
        />
      </div>

      {/* Active agent filter chip */}
      {agentKey && (
        <div className="flex items-center gap-1.5 rounded-full border border-neon/30 bg-neon-soft px-3 py-1 text-xs font-medium text-neon w-fit">
          <Icon name="Bot" className="h-3.5 w-3.5" />
          <span>Filtering by: {agentDisplayName ?? agentKey}</span>
          <Link
            href={analyticsHref(undefined)}
            aria-label="Clear agent filter"
            className="ml-1 rounded-full p-0.5 transition-colors hover:bg-neon/20"
          >
            <Icon name="X" className="h-3.5 w-3.5" />
          </Link>
        </div>
      )}

      {/* KPI cards */}
      <div className={`grid gap-4 sm:grid-cols-2 ${kpis.length === 5 ? "lg:grid-cols-5" : "lg:grid-cols-4"}`}>
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

      {/* Clients low on credits — the agency's queue for the top-up the
          client-facing wall tells them to ask for (QA F117). */}
      {lowCredits.length > 0 && (
        <Card>
          <CardTitle className="mb-1">Clients low on credits</CardTitle>
          <p className="mb-4 text-xs text-muted">
            At or below {LOW_CREDIT_THRESHOLD} spendable credits — the point where the portal
            starts telling them to ask you for a top-up.
          </p>
          <ul className="divide-y divide-border">
            {lowCredits.map((c) => (
              <li key={c.id} className="flex items-center justify-between gap-3 py-2">
                <Link
                  href={`/clients/${c.id}/settings`}
                  className="min-w-0 flex-1 truncate text-sm text-foreground transition-colors hover:text-neon"
                >
                  {c.name}
                </Link>
                <Badge tone={c.spendable === 0 ? "danger" : "warning"}>
                  {c.spendable === 0 ? "Out of credits" : `${c.spendable} left`}
                </Badge>
              </li>
            ))}
          </ul>
        </Card>
      )}

      {/* Two-column: model breakdown + agent leaderboard */}
      <div className="grid gap-6 lg:grid-cols-2">
        {/* Model breakdown */}
        <Card>
          <CardTitle className="mb-4">
            {agentKey ? `Model breakdown — ${agentDisplayName ?? "selected agent"}` : "Model breakdown"}
          </CardTitle>
          {modelStats.length === 0 ? (
            <EmptyState
              icon={<Icon name="ChartNoAxesColumn" className="h-5 w-5" />}
              title="No model usage"
              description={
                agentKey
                  ? "No runs recorded for this agent in this period."
                  : "No runs recorded in this period."
              }
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
            <ul className="space-y-1.5">
              {agentStats.slice(0, 10).map((a, i) => {
                const isSelected = a.agentKey === agentKey;
                return (
                  <li key={a.agentKey}>
                    <Link
                      href={analyticsHref(isSelected ? undefined : a.agentKey)}
                      className={cn(
                        "block rounded-lg border px-2 py-1.5 transition-colors",
                        isSelected
                          ? "border-neon/40 bg-neon-soft"
                          : "border-transparent hover:border-border hover:bg-surface-2/40",
                      )}
                    >
                      <div className="mb-1 flex items-center justify-between text-xs">
                        <span className="flex min-w-0 items-center gap-2">
                          <span className="w-4 shrink-0 text-right text-muted-2">{i + 1}.</span>
                          <span className={cn("truncate font-medium", isSelected && "text-neon")}>
                            {a.agentDisplayName}
                          </span>
                        </span>
                        <span className="shrink-0 font-mono tabular-nums text-muted-2">
                          {a.runs} run{a.runs === 1 ? "" : "s"} · {fmtTokens(a.inputTokens + a.outputTokens)} · {fmtCost(a.costUsd)}
                          {a.failedRuns > 0 && (
                            <span className="ml-1.5 text-danger">
                              · {a.failedRuns} failed{a.failedCostUsd > 0 ? ` · ${fmtCost(a.failedCostUsd)}` : ""}
                            </span>
                          )}
                        </span>
                      </div>
                      <div className="h-1.5 w-full overflow-hidden rounded-full bg-surface-2">
                        <div
                          className="h-full rounded-full bg-neon"
                          style={{ width: `${(a.costUsd / maxAgentCost) * 100}%` }}
                        />
                      </div>
                    </Link>
                  </li>
                );
              })}
            </ul>
          )}
        </Card>
      </div>

      {/* Agent feedback (doc-correction log) */}
      <Card>
        <FeedbackTable feedbacks={displayFeedbacks} clients={clients} />
      </Card>

      {/* Agent feedback history (Phase 3 two-level client-agent feedback) —
          distinct collection from the doc-correction table above. */}
      <Card>
        <AgentFeedbackHistoryTable rows={displayAgentFeedbackRows} clients={clients} agentNames={agentNames} />
      </Card>

      {/* Error log feed */}
      <Card>
        <CardTitle className="mb-4">Recent errors</CardTitle>
        {errors.length === 0 ? (
          <EmptyState
            icon={<Icon name="ShieldCheck" className="h-5 w-5" />}
            title="No errors recorded"
            description="Clean run, no errors in this period."
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
