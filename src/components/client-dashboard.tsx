"use client";

import { useState } from "react";
import { Icon } from "@/components/icon";
import { cn } from "@/lib/utils";
import { IntelligenceTab } from "@/components/intelligence-tab";
import { AgentsHubTab } from "@/components/agents-hub-tab";
import { ActivityTimeline } from "@/components/activity-timeline";
import { IntegrationsTab } from "@/components/integrations-tab";
import type { ActivityLog, Agent, Asset, Client, ClientCompetitor, ClientContextDoc, ClientIntegration, ClientReport, ContextItem, Job, Role } from "@/lib/types";

const TABS = [
  { id: "overview", label: "Overview & Intelligence", icon: "BarChart2" },
  { id: "agents", label: "AI Agents Hub", icon: "Bot" },
  { id: "integrations", label: "Integrations", icon: "Plug" },
  { id: "activity", label: "Activity", icon: "History" },
] as const;

type TabId = (typeof TABS)[number]["id"];

/* ── Component ───────────────────────────────────────────────────── */

interface Props {
  client: Client;
  report: ClientReport | null;
  competitors: ClientCompetitor[];
  agents: Agent[];
  jobs: Job[];
  assets: Asset[];
  contextItems: ContextItem[];
  contextDocs: ClientContextDoc[];
  integrations: ClientIntegration[];
  oauthEnabledPlatforms: string[];
  activityLogs: ActivityLog[];
  currentUserRole: Role;
}

export function ClientDashboard({
  client,
  report,
  competitors,
  agents,
  jobs,
  assets,
  contextItems,
  contextDocs,
  integrations,
  oauthEnabledPlatforms,
  activityLogs,
  currentUserRole,
}: Props) {
  const [activeTab, setActiveTab] = useState<TabId>("overview");

  return (
    <div className="min-w-0 w-full">
      {/* Tab bar — full width, no floating actions */}
      <div className="mb-6 border-b border-border">
        <div className="flex overflow-x-auto">
          {TABS.map((tab) => (
            <button
              key={tab.id}
              onClick={() => setActiveTab(tab.id)}
              className={cn(
                "-mb-px flex shrink-0 items-center gap-2 rounded-t-[8px] border-b-2 px-4 py-2.5 text-sm font-medium whitespace-nowrap transition-all duration-200",
                activeTab === tab.id
                  ? "border-neon bg-neon/[0.06] text-neon"
                  : "border-transparent text-muted hover:bg-surface-2/50 hover:text-foreground",
              )}
            >
              <Icon
                name={tab.icon}
                className={cn("h-4 w-4 shrink-0", activeTab === tab.id ? "text-neon" : "text-muted-2")}
              />
              {tab.label}
            </button>
          ))}
        </div>
      </div>

      {/* Tab content */}
      {activeTab === "overview" && (
        <IntelligenceTab
          client={client}
          report={report}
          competitors={competitors}
          contextDocs={contextDocs}
          currentUserRole={currentUserRole}
        />
      )}

      {activeTab === "agents" && (
        <AgentsHubTab
          client={client}
          agents={agents}
          jobs={jobs}
          assets={assets}
          contextItems={contextItems}
          integrations={integrations}
        />
      )}

      {activeTab === "integrations" && (
        <IntegrationsTab
          clientId={client.id}
          integrations={integrations}
          oauthEnabledPlatforms={oauthEnabledPlatforms}
          currentUserRole={currentUserRole}
        />
      )}

      {activeTab === "activity" && (
        <ActivityTimeline
          activityLogs={activityLogs}
          jobs={jobs}
          report={report}
          clientId={client.id}
          currentUserRole={currentUserRole}
        />
      )}

    </div>
  );
}
