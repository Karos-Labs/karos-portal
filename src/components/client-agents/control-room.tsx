"use client";

import { useState } from "react";
import { Badge, TabButton } from "@/components/ui";
import { Icon } from "@/components/icon";
import {
  AgentRunHistory,
  StaffAgentControls,
  TestRunButton,
  type CustomAgentRunRow,
  type ClientAgentScheduleRow,
  type RunnableAgentSummary,
  type AgentSetupState,
} from "@/components/custom-agents";
import { AgentEconomicsCard } from "@/components/client-agents/agent-economics";
import { OutputsHub } from "@/components/client-agents/outputs-hub";
import { AGENT_HEALTH_LABEL, type AgentHealth } from "@/lib/agent-health";
import type { AgentEconomics } from "@/lib/credit-reporting";
import type { Asset, ContextItem } from "@/lib/types";

type ControlRoomTab = "overview" | "telemetry" | "outputs";

const HEALTH_TONE: Record<AgentHealth, "success" | "warning" | "danger" | "neutral"> = {
  healthy: "success",
  retrying: "warning",
  errored: "danger",
  paused: "neutral",
};

/**
 * Staff-only Control Room - consolidates what used to be three scattered
 * sections on the agent detail page (StaffAgentControls, AgentRunHistory,
 * AgentEconomicsCard) into one tabbed panel, adding the capability item 1/2/3
 * actually asked for: a real (not fabricated) health read, an explicit next-
 * scheduled-execution line, a Test Run trigger, and per-run error
 * classification. Nothing here is shown to a CLIENT_USER - this component is
 * only ever mounted from the page's existing `isStaff` gate, same as the
 * three sections it replaces.
 */
export function ControlRoom({
  health,
  nextRunLabel,
  clientId,
  agent,
  schedule,
  setup,
  contextItems,
  reviewCount,
  reviewHref,
  lastRunAt,
  viewer,
  runs,
  agents,
  economics,
  economicsAgentName,
  launchCreditCost,
  outputs,
  initialOpenAssetId,
}: {
  health: AgentHealth;
  /** e.g. "Next run in 2h 15m" - null when there's no active schedule to project. */
  nextRunLabel: string | null;
  clientId: string;
  agent: RunnableAgentSummary;
  schedule?: ClientAgentScheduleRow;
  setup?: AgentSetupState;
  contextItems: ContextItem[];
  reviewCount: number;
  reviewHref: string;
  lastRunAt?: number;
  viewer: { name: string; email: string };
  runs: CustomAgentRunRow[];
  agents: RunnableAgentSummary[];
  economics: AgentEconomics | null;
  /** Umbrella display name when one exists, else the raw agent name - matches what the economics card showed before this consolidation. */
  economicsAgentName: string;
  launchCreditCost: number | null;
  /** This agent's full output set (uncapped) - see OutputsHub's doc comment. */
  outputs: Asset[];
  /** Copilot chat's deep link - lands on the Outputs tab with this asset already open. */
  initialOpenAssetId?: string;
}) {
  const [tab, setTab] = useState<ControlRoomTab>(initialOpenAssetId ? "outputs" : "overview");

  return (
    <section className="overflow-hidden rounded-[var(--radius)] border border-border bg-surface-2/30">
      <div className="flex flex-wrap items-center justify-between gap-3 border-b border-border px-4 py-3">
        <div className="flex items-center gap-2">
          <Icon name="Gauge" className="h-4 w-4 text-muted-2" />
          <h2 className="font-mono text-[10px] uppercase tracking-[0.08em] text-muted">
            Control Room
          </h2>
        </div>
        <div className="flex items-center gap-2 text-xs text-muted-2">
          <Badge tone={HEALTH_TONE[health]}>{AGENT_HEALTH_LABEL[health]}</Badge>
          {nextRunLabel && <span>{nextRunLabel}</span>}
        </div>
      </div>

      <div className="flex gap-1 border-b border-border px-4">
        <TabButton active={tab === "overview"} onClick={() => setTab("overview")} icon="LayoutDashboard">
          Overview
        </TabButton>
        <TabButton active={tab === "telemetry"} onClick={() => setTab("telemetry")} icon="Activity">
          Runs &amp; Telemetry
        </TabButton>
        <TabButton active={tab === "outputs"} onClick={() => setTab("outputs")} icon="FolderOpen">
          Outputs &amp; Artifacts ({outputs.length})
        </TabButton>
      </div>

      <div className="p-4">
        {tab === "overview" && (
          <div className="space-y-4">
            <div className="flex flex-wrap items-center gap-2">
              <TestRunButton agentId={agent.id} clientId={clientId} />
            </div>
            <StaffAgentControls
              clientId={clientId}
              agent={agent}
              {...(schedule ? { schedule } : {})}
              {...(setup ? { setup } : {})}
              contextItems={contextItems}
              reviewCount={reviewCount}
              reviewHref={reviewHref}
              {...(lastRunAt ? { lastRunAt } : {})}
              viewer={viewer}
            />
            {economics && (
              <AgentEconomicsCard
                customAgentId={agent.id}
                agentName={economicsAgentName}
                economics={economics}
                launchCreditCost={launchCreditCost}
                viewerIsStaff
              />
            )}
          </div>
        )}
        {tab === "telemetry" &&
          (runs.length > 0 ? (
            <AgentRunHistory runs={runs} agents={agents} heading="Runs" />
          ) : (
            <p className="text-xs text-muted-2">No runs yet.</p>
          ))}
        {tab === "outputs" && (
          <OutputsHub assets={outputs} {...(initialOpenAssetId ? { initialOpenAssetId } : {})} />
        )}
      </div>
    </section>
  );
}
