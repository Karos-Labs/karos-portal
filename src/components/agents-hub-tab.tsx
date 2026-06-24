"use client";

import { useState } from "react";
import Link from "next/link";
import { Card, CardTitle, Button, EmptyState } from "@/components/ui";
import { Icon } from "@/components/icon";
import { JobStatusBadge } from "@/components/job-status";
import { AssetCard } from "@/components/asset-card";
import { ClientContext } from "@/components/client-context";
import { RunModal } from "@/components/agent-card";
import { relativeTime, cn } from "@/lib/utils";
import type { Agent, Job, Asset, ContextItem, Client } from "@/lib/types";

interface Props {
  client: Client;
  agents: Agent[];
  jobs: Job[];
  assets: Asset[];
  contextItems: ContextItem[];
}

function AgentAccordion({
  agent,
  client,
  jobs,
  assets,
  contextItems,
}: {
  agent: Agent;
  client: Client;
  jobs: Job[];
  assets: Asset[];
  contextItems: ContextItem[];
}) {
  const [open, setOpen] = useState(false);
  const [runOpen, setRunOpen] = useState(false);

  const agentJobs = jobs
    .filter((j) => j.agentId === agent.id)
    .sort((a, b) => b.createdAt - a.createdAt);

  const lastRun = agentJobs[0];

  return (
    <>
      <Card className="overflow-hidden p-0">
        {/* Collapsed header */}
        <div
          role="button"
          tabIndex={0}
          className="flex w-full items-center gap-4 p-4 text-left transition-colors hover:bg-surface-2 cursor-pointer"
          onClick={() => setOpen((o) => !o)}
          onKeyDown={(e) => (e.key === "Enter" || e.key === " ") && setOpen((o) => !o)}
          aria-expanded={open}
        >
          <div
            className="flex h-10 w-10 shrink-0 items-center justify-center rounded-[12px]"
            style={{ background: (agent.color ?? "#2dff9e") + "1f", color: agent.color ?? "#2dff9e" }}
          >
            <Icon name={agent.icon} className="h-5 w-5" />
          </div>

          <div className="flex-1 min-w-0">
            <p className="font-medium">{agent.name}</p>
            <p className="text-xs text-muted-2">
              {agentJobs.length} run{agentJobs.length !== 1 ? "s" : ""}
              {lastRun && (
                <span className="ml-1.5">· last {relativeTime(lastRun.createdAt)}</span>
              )}
            </p>
          </div>

          <div className="flex shrink-0 items-center gap-2">
            <Button
              size="sm"
              variant="outline"
              onClick={(e) => {
                e.stopPropagation();
                setRunOpen(true);
              }}
              disabled={!agent.isActive}
            >
              <Icon name="Play" className="h-3.5 w-3.5" />
              Run
            </Button>
            <Icon
              name={open ? "ChevronUp" : "ChevronDown"}
              className="h-4 w-4 shrink-0 text-muted-2"
            />
          </div>
        </div>

        {/* Expanded content */}
        {open && (
          <div className="space-y-6 border-t border-border p-5">
            {/* Context library — shared across all agents for this client */}
            <ClientContext clientId={client.id} items={contextItems} />

            {/* Job history */}
            <div>
              <p className="mb-3 text-[10px] font-semibold uppercase tracking-wider text-muted-2">
                Run History
              </p>
              {agentJobs.length === 0 ? (
                <p className="text-sm text-muted-2">No runs yet for this agent.</p>
              ) : (
                <div className="space-y-3">
                  {agentJobs.map((job) => {
                    const jobAssets = assets.filter((a) => a.jobId === job.id);
                    return (
                      <div
                        key={job.id}
                        className="rounded-[12px] border border-border bg-surface-2 p-3"
                      >
                        <div className="flex items-start justify-between gap-3">
                          <div className="min-w-0">
                            <p className="truncate text-sm font-medium">{job.title}</p>
                            <p className="mt-0.5 text-xs text-muted-2">
                              {relativeTime(job.createdAt)}
                            </p>
                          </div>
                          <div className="flex shrink-0 items-center gap-2">
                            <JobStatusBadge status={job.status} />
                            <Link href={`/jobs/${job.id}`}>
                              <Button size="sm" variant="ghost">
                                View
                              </Button>
                            </Link>
                          </div>
                        </div>

                        {jobAssets.length > 0 && (
                          <div className="mt-3 space-y-2 border-t border-border pt-3">
                            {jobAssets.map((a) => (
                              <AssetCard key={a.id} asset={a} canApprove />
                            ))}
                          </div>
                        )}
                      </div>
                    );
                  })}
                </div>
              )}
            </div>
          </div>
        )}
      </Card>

      <RunModal
        agent={{ ...agent, fields: agent.fields ?? [], icon: agent.icon ?? "Bot" }}
        clients={[client]}
        open={runOpen}
        onClose={() => setRunOpen(false)}
      />
    </>
  );
}

export function AgentsHubTab({ client, agents, jobs, assets, contextItems }: Props) {
  const activeAgents = agents.filter((a) => a.isActive);

  if (activeAgents.length === 0) {
    return (
      <EmptyState
        icon={<Icon name="Bot" className="h-7 w-7" />}
        title="No active agents"
        description="Activate or create agents to start generating content for this client."
        action={
          <Link href="/agents">
            <Button>Manage agents</Button>
          </Link>
        }
      />
    );
  }

  return (
    <div className="space-y-3">
      {activeAgents.map((agent) => (
        <AgentAccordion
          key={agent.id}
          agent={agent}
          client={client}
          jobs={jobs}
          assets={assets}
          contextItems={contextItems}
        />
      ))}
    </div>
  );
}
