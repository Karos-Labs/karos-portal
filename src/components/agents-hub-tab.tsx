"use client";

import { useState } from "react";
import Link from "next/link";
import { Button, Badge, EmptyState } from "@/components/ui";
import { Modal } from "@/components/modal";
import { Icon } from "@/components/icon";
import { JobStatusBadge } from "@/components/job-status";
import { AssetCard } from "@/components/asset-card";
import { ClientContext } from "@/components/client-context";
import { RunModal } from "@/components/agent-card";
import { ContentCalendar } from "@/components/content-calendar";
import { relativeTime, cn } from "@/lib/utils";
import type { Agent, Job, Asset, ContextItem, Client, ClientIntegration } from "@/lib/types";

interface Props {
  client: Client;
  agents: Agent[];
  jobs: Job[];
  assets: Asset[];
  contextItems: ContextItem[];
  integrations?: ClientIntegration[];
}

const DONE_STATUSES = new Set<Asset["status"]>(["approved", "delivered", "published"]);

// System agents that run on lifecycle events only — hidden from the hub grid
const HIDDEN_AGENT_IDS = new Set(["intel-report-agent"]);

/* ── Publication history modal ───────────────────────────────────────── */

function PublicationHistoryModal({
  open,
  onClose,
  agentName,
  jobs,
  assets,
}: {
  open: boolean;
  onClose: () => void;
  agentName: string;
  jobs: Job[];
  assets: Asset[];
}) {
  const grouped = jobs
    .filter((j) => assets.some((a) => a.jobId === j.id && DONE_STATUSES.has(a.status)))
    .sort((a, b) => b.createdAt - a.createdAt)
    .map((j) => ({
      job: j,
      assets: assets.filter((a) => a.jobId === j.id && DONE_STATUSES.has(a.status)),
    }));

  return (
    <Modal
      open={open}
      onClose={onClose}
      title={`Publication History — ${agentName}`}
      description="All approved and published outputs from this agent."
      className="max-w-2xl"
    >
      {grouped.length === 0 ? (
        <div className="flex flex-col items-center gap-3 py-12 text-center">
          <div className="flex h-12 w-12 items-center justify-center rounded-full bg-surface-2">
            <Icon name="Clock" className="h-5 w-5 text-muted-2" />
          </div>
          <p className="text-sm text-muted">No published outputs yet.</p>
        </div>
      ) : (
        <div className="space-y-8">
          {grouped.map(({ job, assets: jobAssets }) => (
            <div key={job.id}>
              {/* Timeline label */}
              <div className="mb-3 flex items-center gap-3">
                <div className="h-px flex-1 bg-border" />
                <div className="flex items-center gap-1.5 text-[11px] text-muted-2">
                  <Icon name="Clock" className="h-3 w-3" />
                  <span>{relativeTime(job.createdAt)}</span>
                  <span className="opacity-40">·</span>
                  <Link
                    href={`/jobs/${job.id}`}
                    className="hover:text-neon hover:underline underline-offset-2"
                    onClick={onClose}
                  >
                    {job.title ?? job.agentName}
                  </Link>
                  <JobStatusBadge status={job.status} />
                </div>
                <div className="h-px flex-1 bg-border" />
              </div>

              {/* Assets for this run */}
              <div className="space-y-2">
                {jobAssets.map((a) => (
                  <AssetCard key={a.id} asset={a} canApprove={false} />
                ))}
              </div>
            </div>
          ))}
        </div>
      )}
    </Modal>
  );
}

/* ── Agent accordion ─────────────────────────────────────────────────── */

function AgentAccordion({
  agent,
  client,
  jobs,
  assets,
  contextItems,
  connectedPlatforms,
}: {
  agent: Agent;
  client: Client;
  jobs: Job[];
  assets: Asset[];
  contextItems: ContextItem[];
  connectedPlatforms: string[];
}) {
  const [open, setOpen] = useState(false);
  const [runOpen, setRunOpen] = useState(false);
  const [historyOpen, setHistoryOpen] = useState(false);

  const agentJobs = jobs
    .filter((j) => j.agentId === agent.id)
    .sort((a, b) => b.createdAt - a.createdAt);

  const agentAssets = assets.filter((a) => agentJobs.some((j) => j.id === a.jobId));
  const draftAssets = agentAssets.filter((a) => a.status === "draft");
  const doneAssets = agentAssets.filter((a) => DONE_STATUSES.has(a.status));

  const lastRun = agentJobs[0];

  return (
    <>
      <div
        className={cn(
          "overflow-hidden rounded-[var(--radius)] border transition-colors",
          open ? "border-border-strong" : "border-border",
        )}
        style={{ background: "var(--surface)" }}
      >
        {/* ── Header row ── */}
        <div
          role="button"
          tabIndex={0}
          className="flex w-full cursor-pointer items-center gap-4 p-4 text-left transition-colors hover:bg-surface-2"
          onClick={() => setOpen((o) => !o)}
          onKeyDown={(e) => (e.key === "Enter" || e.key === " ") && setOpen((o) => !o)}
          aria-expanded={open}
        >
          {/* Agent icon */}
          <div
            className="flex h-10 w-10 shrink-0 items-center justify-center rounded-md"
            style={{
              background: (agent.color ?? "#FF6B2C") + "1f",
              color: agent.color ?? "#FF6B2C",
            }}
          >
            <Icon name={agent.icon} className="h-5 w-5" />
          </div>

          {/* Name + meta */}
          <div className="min-w-0 flex-1">
            <div className="flex flex-wrap items-center gap-2">
              <p className="truncate font-medium">{agent.name}</p>
              {!agent.isActive && <Badge tone="neutral">Paused</Badge>}
              {draftAssets.length > 0 && (
                <Badge tone="warning">
                  <Icon name="AlertCircle" className="h-3 w-3" />
                  {draftAssets.length} pending
                </Badge>
              )}
            </div>
            <p className="mt-0.5 text-xs text-muted-2">
              {agentJobs.length} run{agentJobs.length !== 1 ? "s" : ""}
              {lastRun && (
                <span className="ml-1.5">· last {relativeTime(lastRun.createdAt)}</span>
              )}
            </p>
          </div>

          {/* Run button + chevron */}
          <div className="flex shrink-0 items-center gap-2">
            <Button
              size="sm"
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
              name="ChevronDown"
              className={cn(
                "h-4 w-4 shrink-0 text-muted-2 transition-transform duration-300",
                open && "rotate-180",
              )}
            />
          </div>
        </div>

        {/* ── Collapsible workspace — grid-rows animation ── */}
        <div
          className={cn(
            "grid transition-[grid-template-rows] duration-300 ease-in-out",
            open ? "grid-rows-[1fr]" : "grid-rows-[0fr]",
          )}
        >
          <div className="overflow-hidden">
            <div className="space-y-5 border-t border-border px-4 pb-5 pt-5">

              {/* ① Input / Dropzone Workspace */}
              <ClientContext clientId={client.id} items={contextItems} />

              {/* ② Drafts — Awaiting Review */}
              <div>
                <div className="mb-3 flex items-center gap-2">
                  <p className="text-[10px] font-mono font-medium uppercase tracking-[0.14em] text-muted-2">
                    Awaiting Review
                  </p>
                  {draftAssets.length > 0 && (
                    <Badge tone="warning">{draftAssets.length}</Badge>
                  )}
                </div>

                {draftAssets.length === 0 ? (
                  <div className="flex items-center gap-3 rounded-md border border-dashed border-border bg-surface-2/40 p-4">
                    <div className="flex h-8 w-8 shrink-0 items-center justify-center rounded-md border border-foreground/10 bg-foreground/[0.04]">
                      <Icon name="CheckCircle2" className="h-4 w-4 text-foreground/70" />
                    </div>
                    <p className="text-sm text-muted-2">
                      All clear. No drafts pending review.
                    </p>
                  </div>
                ) : (
                  <div className="space-y-2">
                    {draftAssets.map((a) => (
                      <AssetCard
                        key={a.id}
                        asset={a}
                        canApprove
                        connectedPlatforms={connectedPlatforms}
                      />
                    ))}
                  </div>
                )}
              </div>

              {/* ③ Footer: history link + latest run shortcut */}
              <div className="flex items-center justify-between border-t border-border pt-4">
                <button
                  onClick={() => setHistoryOpen(true)}
                  className="inline-flex items-center gap-1.5 text-xs text-muted-2 transition-colors hover:text-neon"
                >
                  <Icon name="Clock" className="h-3.5 w-3.5" />
                  View Publication History
                  {doneAssets.length > 0 && (
                    <span className="ml-0.5 rounded-full bg-surface-2 px-1.5 py-0.5 text-[10px] text-muted">
                      {doneAssets.length}
                    </span>
                  )}
                </button>

                {lastRun && (
                  <Link href={`/jobs/${lastRun.id}`}>
                    <Button size="sm" variant="ghost">
                      <Icon name="ExternalLink" className="h-3.5 w-3.5" />
                      Latest run
                    </Button>
                  </Link>
                )}
              </div>
            </div>
          </div>
        </div>
      </div>

      <RunModal
        agent={{ ...agent, fields: agent.fields ?? [], icon: agent.icon ?? "Bot" }}
        clients={[client]}
        open={runOpen}
        onClose={() => setRunOpen(false)}
      />

      <PublicationHistoryModal
        open={historyOpen}
        onClose={() => setHistoryOpen(false)}
        agentName={agent.name}
        jobs={agentJobs}
        assets={agentAssets}
      />
    </>
  );
}

/* ── Tab root ────────────────────────────────────────────────────────── */

export function AgentsHubTab({ client, agents, jobs, assets, contextItems, integrations }: Props) {
  const activeAgents = agents.filter(
    (a) => a.isActive && !HIDDEN_AGENT_IDS.has(a.id),
  );
  const connectedPlatforms = (integrations ?? []).map((i) => i.platform);

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
    <div className="space-y-4">
      {/* Content Calendar — always visible once there are agents */}
      <ContentCalendar assets={assets} jobs={jobs} agents={agents} />

      {/* Agent accordions */}
      <div className="space-y-3">
        {activeAgents.map((agent) => (
          <AgentAccordion
            key={agent.id}
            agent={agent}
            client={client}
            jobs={jobs}
            assets={assets}
            contextItems={contextItems}
            connectedPlatforms={connectedPlatforms}
          />
        ))}
      </div>
    </div>
  );
}
