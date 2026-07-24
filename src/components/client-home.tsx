import Link from "next/link";
import { Badge, Button, EmptyState, StatCard } from "@/components/ui";
import { Icon } from "@/components/icon";
import { AgentMark } from "@/components/agent-identity";
import { JobStatusBadge } from "@/components/job-status";
import {
  ClientCustomAgents,
  type CustomAgentRunRow,
  type RunnableAgentSummary,
} from "@/components/custom-agents";
import { relativeTime } from "@/lib/utils";
import { assetImages } from "@/lib/asset-images";
import { AGENT_SERVICE_AGENT_ID } from "@/lib/agent-service/products";
import type { Asset, ClientIntegration, ContextItem, Job } from "@/lib/types";

/* Jobs that are still doing work — surfaced in the "In progress" strip. */
const ACTIVE_STATUSES = new Set(["queued", "running", "review"]);

/* Deliverable status → badge tone (mirrors the judgment scale: amber in-flight,
   green live/done, slate in-between). */
function assetTone(status: Asset["status"]): "warning" | "info" | "neon" {
  if (status === "draft") return "warning";
  if (status === "scheduled") return "info";
  return "neon";
}

/**
 * A client's home dashboard — action-first. The hero is the run block (the
 * agents this viewer can fire), followed by a live "In progress" strip and a
 * compact deliverables + at-a-glance summary. Staff and client users share the
 * layout; the props decide which agents are runnable and whether run history
 * links through to the job detail.
 */
export function ClientHome({
  clientId,
  greetingTitle,
  greetingSubtitle,
  viewerIsClient,
  isStaff,
  agentServiceConfigured,
  hasGrantedAgents,
  customAgents,
  customRuns,
  contextItems,
  availableCredits,
  jobs,
  assets,
  integrations,
  xSetup,
}: {
  clientId: string;
  greetingTitle: string;
  greetingSubtitle: string;
  viewerIsClient: boolean;
  isStaff: boolean;
  agentServiceConfigured: boolean;
  /** Client viewers only — did an admin grant this client any custom agents? */
  hasGrantedAgents: boolean;
  customAgents: RunnableAgentSummary[];
  customRuns: CustomAgentRunRow[];
  contextItems: ContextItem[];
  /** Spendable credits (client billable actors only) — drives the run-block badge. */
  availableCredits?: number;
  jobs: Job[];
  assets: Asset[];
  integrations: ClientIntegration[];
  /** X agent intake state - gates the X run behind the "X agent data" page. */
  xSetup?: { ready: boolean; href: string };
}) {
  // Resolve a job's icon/color from the runnable-agent summaries (all agents are
  // repo-imported custom agents now — no hardcoded product catalog).
  const agentByName = new Map(customAgents.map((a) => [a.name, a]));

  const activeJobs = [...jobs]
    .filter((j) => ACTIVE_STATUSES.has(j.status))
    .sort((a, b) => b.createdAt - a.createdAt)
    .slice(0, 4);

  const recentAssets = [...assets].sort((a, b) => b.createdAt - a.createdAt).slice(0, 5);
  // Clients: the Workspace archive (Library merged there 2026-07). Staff: the review library.
  const libraryHref = viewerIsClient ? "/tasks" : `/clients/${clientId}/assets`;
  const libraryLabel = viewerIsClient ? "Archive" : "Library";

  const published = assets.filter((a) => a.status === "published").length;
  const scheduled = assets.filter((a) => a.status === "scheduled").length;
  const channels = integrations.filter((i) => i.status === "active").length;

  const runBlock = agentServiceConfigured ? (
    <ClientCustomAgents
      clientId={clientId}
      agents={customAgents}
      runs={customRuns}
      {...(xSetup ? { xSetup } : {})}
      contextItems={contextItems}
      viewerIsClient={viewerIsClient}
      {...(availableCredits !== undefined ? { availableCredits } : {})}
    />
  ) : (
    <EmptyState
      icon={<Icon name="Bot" className="h-7 w-7" />}
      title="Agent service not configured"
      description="Set the agent-service environment variables to run agents from here."
    />
  );

  return (
    <>
      {/* ── Header ── */}
      <div className="mb-8 flex flex-wrap items-end justify-between gap-3">
        <div>
          <h1 className="text-3xl text-foreground">{greetingTitle}</h1>
          <p className="mt-1.5 text-sm text-muted">{greetingSubtitle}</p>
        </div>
        {isStaff && (
          <Link href={`/clients/${clientId}/agents`}>
            <Button variant="outline" size="sm">
              <Icon name="Bot" className="h-3.5 w-3.5" />
              Full agents page
            </Button>
          </Link>
        )}
      </div>

      {/* ── Run block (hero) ── */}
      {isStaff || hasGrantedAgents ? (
        runBlock
      ) : (
        <EmptyState
          icon={<Icon name="Bot" className="h-7 w-7" />}
          title="Your team is on it"
          description="Karos runs managed AI agents for your account. Deliverables land in your Workspace archive once they're approved."
          action={
            <Link href={libraryHref}>
              <Button>Open {viewerIsClient ? "Workspace" : "Library"}</Button>
            </Link>
          }
        />
      )}

      {/* ── In-progress strip ── */}
      {activeJobs.length > 0 && (
        <section className="mt-10">
          <p className="mb-2 font-mono text-[10px] uppercase tracking-[0.08em] text-muted">
            In progress
          </p>
          <div className="overflow-hidden rounded-[var(--radius)] border border-border">
            {activeJobs.map((job, i) => {
              const agent =
                job.agentId === AGENT_SERVICE_AGENT_ID ? agentByName.get(job.agentName) : undefined;
              const title = job.title || job.agentName;
              const rowClass =
                "flex items-center gap-3 px-4 py-2.5" + (i > 0 ? " border-t border-border" : "");
              const body = (
                <>
                  <div className="flex h-7 w-7 shrink-0 items-center justify-center rounded-md border border-foreground/10 bg-foreground/[0.04] text-foreground/80">
                    <AgentMark identity={job.agentName} icon={agent?.icon ?? "Bot"} className="h-3.5 w-3.5" />
                  </div>
                  <div className="min-w-0 flex-1">
                    <p className="truncate text-sm">{title}</p>
                    <p className="text-xs text-muted-2">{relativeTime(job.createdAt)}</p>
                  </div>
                  <JobStatusBadge status={job.status} />
                </>
              );
              // Clients never link to a run's transcript — status only (matches
              // the review-notification model). Staff get the job detail link.
              return isStaff ? (
                <Link
                  key={job.id}
                  href={`/jobs/${job.id}`}
                  className={rowClass + " transition-colors hover:bg-surface-2"}
                >
                  {body}
                  <Icon name="ChevronRight" className="h-4 w-4 shrink-0 text-muted-2" />
                </Link>
              ) : (
                <div key={job.id} className={rowClass}>
                  {body}
                </div>
              );
            })}
          </div>
        </section>
      )}

      {/* ── Deliverables + at-a-glance ── */}
      <div className="mt-10 grid gap-6 lg:grid-cols-3">
        <section className="lg:col-span-2">
          <div className="mb-3 flex items-center justify-between">
            <p className="font-mono text-[10px] uppercase tracking-[0.08em] text-muted">
              Latest deliverables
            </p>
            <Link href={libraryHref} className="text-xs text-neon hover:underline">
              {libraryLabel} →
            </Link>
          </div>
          {recentAssets.length === 0 ? (
            <EmptyState
              icon={<Icon name="FolderOpen" className="h-6 w-6" />}
              title="Nothing here yet"
              description="Deliverables your agents produce will appear here."
            />
          ) : (
            <div className="overflow-hidden rounded-[var(--radius)] border border-border">
              {recentAssets.map((asset, i) => {
                const thumb = assetImages(asset)[0]?.url;
                return (
                  <Link
                    key={asset.id}
                    href={libraryHref}
                    className={
                      "flex items-center gap-3 px-4 py-2.5 transition-colors hover:bg-surface-2" +
                      (i > 0 ? " border-t border-border" : "")
                    }
                  >
                    {thumb ? (
                      // eslint-disable-next-line @next/next/no-img-element
                      <img
                        src={thumb}
                        alt=""
                        className="h-9 w-9 shrink-0 rounded-md border border-border object-cover"
                      />
                    ) : (
                      <div className="flex h-9 w-9 shrink-0 items-center justify-center rounded-md bg-surface-2 text-muted-2">
                        <Icon name="FileText" className="h-4 w-4" />
                      </div>
                    )}
                    <div className="min-w-0 flex-1">
                      <p className="truncate text-sm font-medium">{asset.title}</p>
                      <p className="text-xs text-muted-2">{relativeTime(asset.createdAt)}</p>
                    </div>
                    <Badge tone={assetTone(asset.status)}>{asset.status}</Badge>
                  </Link>
                );
              })}
            </div>
          )}
        </section>

        <section>
          <p className="mb-3 font-mono text-[10px] uppercase tracking-[0.08em] text-muted">
            At a glance
          </p>
          <div className="grid grid-cols-2 gap-3">
            <StatCard label="Published" value={published} />
            <StatCard label="Scheduled" value={scheduled} />
            <StatCard label="Channels" value={channels} />
            <StatCard label="Deliverables" value={assets.length} />
          </div>
        </section>
      </div>
    </>
  );
}
