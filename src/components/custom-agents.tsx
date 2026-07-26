"use client";

import { type ComponentProps, useEffect, useMemo, useRef, useState, useTransition } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { Badge, Button, Input, Label, Select, Textarea } from "@/components/ui";
import { Icon, LinkedInLogo, XLogo } from "@/components/icon";
import { AgentIdentity, AgentMark, AgentPlatformBadges } from "@/components/agent-identity";
import { AgentInputFiles } from "@/components/agent-input-files";
import { LinkedInAgentIntake } from "@/components/linkedin-agent-intake";
import { XAgentIntake } from "@/components/x-agent-intake";
import { Modal } from "@/components/modal";
import { JobStatusBadge } from "@/components/job-status";
import {
  createCustomAgentAction,
  deleteCustomAgentAction,
  importCustomAgentsAction,
  listCustomAgentImportCandidatesAction,
  runCustomAgentAction,
  setClientCustomAgentsAction,
  updateCustomAgentAction,
} from "@/lib/actions";
import {
  configureClientAgentScheduleAction,
  setPlannedRunStatusAction,
} from "@/lib/actions/planned-run-actions";
import { CREDIT_COSTS, scheduledAgentWeeklyCost } from "@/lib/credits";
import {
  buildCustomAgentPrompt,
  initialAgentBrief,
  isLinkedInAgentIdentity,
  isXAgentIdentity,
  launchProfileFor,
  LINKEDIN_SETUP_REQUIRED_PREFIX,
  X_SETUP_REQUIRED_PREFIX,
} from "@/lib/custom-agent-launch";
import type { ContextItem, CustomAgent, JobStatus } from "@/lib/types";
import { cn, formatDate, relativeTime } from "@/lib/utils";

/* ═══════════════════════ shared bits ═══════════════════════ */

/**
 * The slice of a CustomAgent that may be serialized to client-user browsers.
 * Deliberately excludes instructions (the system prompt), skill paths, and
 * repo provenance — pages map full docs down to this before passing them.
 */
export type RunnableAgentSummary = Pick<CustomAgent, "id" | "key" | "name" | "description" | "icon" | "color"> & {
  creditCost?: number | null;
};

/** One run-history row, pre-filtered and stripped server-side. */
export interface CustomAgentRunRow {
  id: string;
  agentName: string;
  status: JobStatus;
  createdAt: number;
  assetCount: number;
  prompt?: string;
  /** Link target (staff viewers get /jobs/<id>); absent for client viewers. */
  href?: string;
}

/** Client-safe recurring schedule fields shown on an activated agent card. */
export interface ClientAgentScheduleRow {
  id: string;
  agentId: string;
  status: "active" | "paused";
  postsPerWeek: number;
  outputsPerRun: number;
  nextRunAt: number;
  prompt: string;
  hour: number;
  minute: number;
}

function agentRunCost(agent: Pick<RunnableAgentSummary, "creditCost">): number {
  return agent.creditCost ?? CREDIT_COSTS.customAgentRun;
}

function AgentChip({ agent, className }: { agent: Pick<RunnableAgentSummary, "key" | "name" | "icon">; className?: string }) {
  return (
    <AgentIdentity
      identity={`${agent.key} ${agent.name}`}
      icon={agent.icon}
      className={className}
    />
  );
}

/* ═══════════ intake-driven agents (X e13, LinkedIn e10) ═══════════ */

/**
 * The X and LinkedIn agents draft from stored intake, so their data forms live
 * inside the run dialog: inline on a first run, behind the "<platform> agent
 * data" button once the data exists. `ready` is the server run gate; `data` is
 * the payload rendered inline.
 */
export interface XAgentSetup {
  ready: boolean;
  data: ComponentProps<typeof XAgentIntake>;
}

/** The e10 twin of XAgentSetup. */
export interface LinkedInAgentSetup {
  ready: boolean;
  data: ComponentProps<typeof LinkedInAgentIntake>;
}

type IntakeKind = "x" | "linkedin";

type AgentIntakeContext =
  | { kind: "x"; setup: XAgentSetup }
  | { kind: "linkedin"; setup: LinkedInAgentSetup };

const INTAKE_LABEL: Record<IntakeKind, string> = { x: "X", linkedin: "LinkedIn" };

/** Route segment of the full agent data page, for callers with no inline payload. */
const INTAKE_ROUTE: Record<IntakeKind, string> = { x: "x-agent", linkedin: "linkedin-agent" };

/** Which intake surface governs this agent, given what the page shipped. */
function intakeFor(
  agentKey: string,
  xSetup?: XAgentSetup,
  linkedinSetup?: LinkedInAgentSetup,
): AgentIntakeContext | null {
  if (xSetup && isXAgentIdentity(agentKey)) return { kind: "x", setup: xSetup };
  if (linkedinSetup && isLinkedInAgentIdentity(agentKey)) {
    return { kind: "linkedin", setup: linkedinSetup };
  }
  return null;
}

function IntakeGlyph({ kind, className }: { kind: IntakeKind; className?: string }) {
  return kind === "x" ? <XLogo className={className} /> : <LinkedInLogo className={className} />;
}

/**
 * Is the company page saved? `ready` is a looser server predicate — for X, any
 * seat satisfies it, and seats are shared across agents — so it cannot decide
 * on its own whether the setup a person came here to do is finished.
 */
function companyOnFile(intake: AgentIntakeContext | null): boolean {
  return Boolean(intake?.setup.data.company);
}

/**
 * Does this agent hold everything it drafts from? Both checks read the company
 * page today, from the server predicate and from the payload respectively;
 * requiring both keeps the affordance honest if a caller's flag ever drifts
 * from the rows it ships.
 */
function intakeComplete(intake: AgentIntakeContext): boolean {
  return intake.setup.ready && companyOnFile(intake);
}

function IntakeForm({ intake }: { intake: AgentIntakeContext }) {
  if (intake.kind === "x") return <XAgentIntake {...intake.setup.data} />;
  return <LinkedInAgentIntake {...intake.setup.data} />;
}

/**
 * The way into an agent's data: warning-toned while the data is still missing,
 * quiet once it is on file. Opens the run dialog's data pane rather than
 * navigating — the data belongs with the agent.
 */
function AgentDataButton({
  kind,
  ready,
  onOpen,
}: {
  kind: IntakeKind;
  ready: boolean;
  onOpen: () => void;
}) {
  const className = cn(
    "inline-flex cursor-pointer items-center gap-1.5 rounded-md border px-2 py-1 text-[11px] font-medium transition-colors",
    ready
      ? "border-border bg-surface-2 text-muted hover:border-border-strong hover:text-foreground"
      : "border-warning/30 bg-warning/10 text-warning hover:border-warning/50 hover:bg-warning/15",
  );
  const label = `${INTAKE_LABEL[kind]} agent data`;
  // The short visible text needs the platform back for anyone who cannot see
  // the glyph, and it stays inside the accessible name so voice control can
  // still say what it reads.
  const name = ready ? label : `${label}: setup needed`;
  return (
    <button type="button" onClick={onOpen} className={className} aria-label={name}>
      <IntakeGlyph kind={kind} className="h-3 w-3" />
      {ready ? label : "Setup needed"}
    </button>
  );
}

/* ═══════════════════ staff hub (/agents) ═══════════════════ */

/**
 * The "Custom agents" section of the staff Agents page: the stored-prompt
 * agent library. Admins import agents from the karos-agents repo catalog,
 * edit their instructions, and control which clients may fire them; anyone
 * on staff can run one for a client.
 */
export function CustomAgentsHub({
  agents,
  clients,
  isAdmin,
  importConfigured,
  serviceConfigured,
}: {
  agents: CustomAgent[];
  clients: Array<{ id: string; name: string }>;
  isAdmin: boolean;
  importConfigured: boolean;
  serviceConfigured: boolean;
}) {
  const [runAgent, setRunAgent] = useState<CustomAgent | null>(null);
  const [editAgent, setEditAgent] = useState<CustomAgent | null>(null);
  const [creating, setCreating] = useState(false);
  const [importing, setImporting] = useState(false);

  return (
    <section className="mt-10">
      <div className="mb-4 flex flex-wrap items-center justify-between gap-2">
        <div>
          <h2 className="text-xl text-foreground">Custom agents</h2>
          <p className="mt-0.5 text-sm text-muted">
            Stored system prompts that fire a Claude session inside the karos-agents repo. Run
            with a plain-language request.
          </p>
        </div>
        {isAdmin && (
          <div className="flex gap-2">
            <Button size="sm" variant="outline" onClick={() => setCreating(true)}>
              <Icon name="Plus" className="h-3.5 w-3.5" /> New agent
            </Button>
            <Button
              size="sm"
              variant="accent"
              onClick={() => setImporting(true)}
              disabled={!importConfigured}
              title={importConfigured ? undefined : "Set AGENTS_REPO_GITHUB_TOKEN to import"}
            >
              <Icon name="Download" className="h-3.5 w-3.5" /> Import from repo
            </Button>
          </div>
        )}
      </div>

      {agents.length === 0 ? (
        <div className="rounded-[var(--radius)] border border-dashed border-border px-6 py-10 text-center">
          <p className="text-sm text-foreground">No custom agents yet</p>
          <p className="mt-1 text-xs text-muted">
            {isAdmin
              ? "Import agents from the karos-agents repo or write one from scratch."
              : "An admin can import agents from the karos-agents repo."}
          </p>
        </div>
      ) : (
        <div className="grid gap-3 sm:grid-cols-2">
          {agents.map((agent) => (
            <div
              key={agent.id}
              className="card-grad group relative flex min-h-52 flex-col overflow-hidden rounded-[var(--radius)] border border-border p-5 transition-all duration-200 hover:-translate-y-0.5 hover:border-border-strong hover:shadow-lg"
            >
              <span className="absolute inset-x-0 top-0 h-0.5 bg-foreground/40 opacity-45 transition-opacity group-hover:opacity-80" aria-hidden="true" />
              <div className="flex items-start gap-3">
                <AgentChip agent={agent} />
                <div className="min-w-0 flex-1">
                  <p className="mb-1 font-mono text-[9px] uppercase tracking-[0.16em] text-muted-2">AI agent</p>
                  <p className="truncate text-base font-medium">{agent.name}</p>
                  <p className="mt-0.5 truncate font-mono text-[10px] text-muted-2">
                    {agent.entrySkillDir}
                  </p>
                </div>
                <div className="flex shrink-0 flex-col items-end gap-1">
                  {!agent.enabled && <Badge tone="warning">Disabled</Badge>}
                  {/* Repo-catalog flag — informational until an admin reviews and enables. */}
                  {!agent.enabled && agent.source?.status === "blocked" && (
                    <Badge tone="danger">Blocked in repo</Badge>
                  )}
                </div>
              </div>
              <p className="mt-3 line-clamp-2 text-xs leading-relaxed text-muted-2">
                {agent.description || "No description."}
              </p>
              <div className="mt-3">
                <AgentPlatformBadges identity={`${agent.key} ${agent.name}`} />
              </div>
              <div className="mt-auto flex items-center justify-between gap-2 pt-4">
                <p className="text-xs text-muted-2">
                  {agentRunCost(agent)} credits per client run
                </p>
                <div className="flex gap-1.5">
                  {isAdmin && (
                    <Button size="sm" variant="ghost" onClick={() => setEditAgent(agent)}>
                      <Icon name="Pencil" className="h-3.5 w-3.5" /> Edit
                    </Button>
                  )}
                  <Button
                    size="sm"
                    variant="subtle"
                    disabled={!agent.enabled || !serviceConfigured}
                    title={
                      !serviceConfigured
                        ? "Agent service is not configured"
                        : !agent.enabled
                          ? "Enable this agent first"
                          : undefined
                    }
                    onClick={() => setRunAgent(agent)}
                  >
                    <Icon name="Play" className="h-3.5 w-3.5" /> Run
                  </Button>
                </div>
              </div>
            </div>
          ))}
        </div>
      )}

      {runAgent && (
        <RunCustomAgentModal
          agent={runAgent}
          clients={clients}
          contextItems={[]}
          viewerIsClient={false}
          onClose={() => setRunAgent(null)}
        />
      )}
      {(editAgent || creating) && (
        <AgentEditorModal
          agent={editAgent}
          onClose={() => {
            setEditAgent(null);
            setCreating(false);
          }}
        />
      )}
      {importing && <ImportAgentsModal onClose={() => setImporting(false)} />}
    </section>
  );
}

/* ═══════════════ client-page section (staff + clients) ═══════════════ */

/**
 * Custom agents on a client's Agents page. Staff see every enabled agent;
 * client users see only their allowlist (the page passes the right list) and
 * are billed per run, so the run button gates on spendable credits. Both
 * `agents` and `runs` arrive pre-stripped to client-safe shapes.
 */
export function ClientCustomAgents({
  clientId,
  agents,
  runs,
  schedules = [],
  contextItems,
  viewerIsClient,
  availableCredits,
  xSetup,
  linkedinSetup,
}: {
  clientId: string;
  agents: RunnableAgentSummary[];
  runs: CustomAgentRunRow[];
  schedules?: ClientAgentScheduleRow[];
  contextItems: ContextItem[];
  viewerIsClient: boolean;
  /** Spendable credits right now (balance clipped by caps) — client viewers only. */
  availableCredits?: number;
  /** X agent intake state and, when the page could prefetch it, its data form. */
  xSetup?: XAgentSetup;
  /** LinkedIn agent intake state — same shape for the e10 agents. */
  linkedinSetup?: LinkedInAgentSetup;
}) {
  const [runAgent, setRunAgent] = useState<RunnableAgentSummary | null>(null);
  const [runIntakeFirst, setRunIntakeFirst] = useState(false);
  const [scheduleAgent, setScheduleAgent] = useState<RunnableAgentSummary | null>(null);

  const agentByName = useMemo(() => new Map(agents.map((a) => [a.name, a])), [agents]);
  const scheduleByAgent = useMemo(
    () => new Map(schedules.map((schedule) => [schedule.agentId, schedule])),
    [schedules],
  );

  function openRun(agent: RunnableAgentSummary, intakeFirst = false) {
    setRunIntakeFirst(intakeFirst);
    setRunAgent(agent);
  }

  if (agents.length === 0 && runs.length === 0) return null;

  // The open schedule dialog's own copy of the card's gate: props refresh
  // underneath it, so the agent data can go missing while it is open.
  const scheduleIntake = scheduleAgent ? intakeFor(scheduleAgent.key, xSetup, linkedinSetup) : null;
  const scheduleSetupNeeded =
    scheduleAgent && scheduleIntake && !companyOnFile(scheduleIntake)
      ? {
          kind: scheduleIntake.kind,
          onOpenData: () => {
            setScheduleAgent(null);
            openRun(scheduleAgent, true);
          },
        }
      : null;

  return (
    <section className="mt-10">
      <div className="mb-4 flex flex-wrap items-center justify-between gap-2">
        <div>
          <h2 className="text-xl text-foreground">{viewerIsClient ? "Your AI agents" : "Custom agents"}</h2>
          <p className="mt-0.5 text-sm text-muted">
            {viewerIsClient
              ? "Your always-on AI team. Run an agent now or choose its weekly production pace."
              : "Prompt-driven agents from the custom library, run against this client."}
          </p>
        </div>
        {viewerIsClient && availableCredits !== undefined && (
          <Badge tone={availableCredits > 0 ? "neon" : "warning"}>
            {availableCredits} credits available
          </Badge>
        )}
      </div>

      {agents.length > 0 && (
        <div className="grid gap-3 sm:grid-cols-2">
          {agents.map((agent) => {
            const cost = agentRunCost(agent);
            const short = viewerIsClient && availableCredits !== undefined && availableCredits < cost;
            const schedule = scheduleByAgent.get(agent.id);
            const reviewRuns = runs.filter(
              (run) => run.agentName === agent.name && run.status === "review" && run.assetCount > 0,
            );
            const readyAssetCount = reviewRuns.reduce((total, run) => total + run.assetCount, 0);
            const reviewHref = viewerIsClient
              ? "/tasks"
              : reviewRuns[0]?.href ?? `/clients/${clientId}/assets`;
            const intake = intakeFor(agent.key, xSetup, linkedinSetup);
            // A scheduled run fires unattended, so every fire would be refused
            // while the company page is missing. An existing schedule stays
            // open to manage — pausing it must never be blocked.
            const scheduleNeedsData = Boolean(intake) && !companyOnFile(intake) && !schedule;
            return (
              <div
                key={agent.id}
                className="card-grad group relative flex min-h-52 flex-col overflow-hidden rounded-[var(--radius)] border border-border p-5 transition-all duration-200 hover:-translate-y-0.5 hover:border-border-strong hover:shadow-lg"
              >
                <span className="absolute inset-x-0 top-0 h-0.5 bg-foreground/40 opacity-45 transition-opacity group-hover:opacity-80" aria-hidden="true" />
                <div className="flex items-start gap-3">
                  <AgentChip agent={agent} />
                  <div className="min-w-0 flex-1">
                    <p className="mb-1 font-mono text-[9px] uppercase tracking-[0.16em] text-muted-2">AI agent</p>
                    <div className="flex flex-wrap items-center gap-2">
                      <p className="truncate text-base font-medium">{agent.name}</p>
                      {schedule?.status === "active" && (
                        <Badge tone="success">
                          <span className="h-1.5 w-1.5 rounded-full bg-success animate-pulse-neon" aria-hidden="true" />
                          Live
                        </Badge>
                      )}
                    </div>
                    <p className="mt-0.5 line-clamp-2 text-xs text-muted">{agent.description}</p>
                  </div>
                  {readyAssetCount > 0 && (
                    <Link
                      href={reviewHref}
                      className="flex shrink-0 items-center gap-1.5 rounded-md border border-warning/30 bg-warning/10 px-2 py-1 text-[11px] font-medium text-warning transition-colors hover:border-warning/50 hover:bg-warning/15"
                      aria-label={`${readyAssetCount} new ${readyAssetCount === 1 ? "asset" : "assets"} ready to review from ${agent.name}`}
                    >
                      <Icon name="Bell" className="h-3.5 w-3.5" />
                      {readyAssetCount} ready
                    </Link>
                  )}
                </div>
                <div className="mt-3 flex flex-wrap items-center gap-2">
                  <AgentPlatformBadges identity={`${agent.key} ${agent.name}`} />
                  {intake && (
                    <AgentDataButton
                      kind={intake.kind}
                      ready={intakeComplete(intake)}
                      onOpen={() => openRun(agent, true)}
                    />
                  )}
                </div>
                <div className="mt-3 rounded-md border border-border bg-surface-2/70 px-3 py-2">
                  {schedule ? (
                    <>
                      <p className="text-xs text-foreground">
                        {schedule.postsPerWeek} post{schedule.postsPerWeek === 1 ? "" : "s"}/week
                        {" · "}
                        {schedule.outputsPerRun} output{schedule.outputsPerRun === 1 ? "" : "s"} each
                      </p>
                      <p className="mt-0.5 text-[11px] text-muted-2">
                        {schedule.status === "active"
                          ? `Working toward ${formatDate(schedule.nextRunAt)}`
                          : "Schedule paused"}
                      </p>
                    </>
                  ) : (
                    <p className="text-xs text-muted-2">Ready to build your weekly content queue.</p>
                  )}
                </div>
                <div className="mt-auto flex flex-wrap items-center justify-between gap-2 pt-4">
                  <p className="text-xs text-muted-2">{cost} credits per output</p>
                  <div className="flex gap-1.5">
                    <Button
                      size="sm"
                      variant="ghost"
                      disabled={short}
                      title={short ? "Not enough credits. Ask your Karos team for a top-up." : undefined}
                      onClick={() => openRun(agent)}
                    >
                      <Icon name="Play" className="h-3.5 w-3.5" /> Run now
                    </Button>
                    <Button
                      size="sm"
                      variant="subtle"
                      title={
                        scheduleNeedsData && intake
                          ? `Add the ${INTAKE_LABEL[intake.kind]} agent data first — every scheduled run drafts from it.`
                          : undefined
                      }
                      onClick={() =>
                        scheduleNeedsData ? openRun(agent, true) : setScheduleAgent(agent)
                      }
                    >
                      <Icon name="SlidersHorizontal" className="h-3.5 w-3.5" />
                      {schedule ? "Manage" : "Set schedule"}
                    </Button>
                  </div>
                </div>
              </div>
            );
          })}
        </div>
      )}

      {runs.length > 0 && (
        <div className="mt-6">
          <p className="mb-2 font-mono text-[10px] uppercase tracking-[0.08em] text-muted">
            Recent agent runs
          </p>
          <div className="overflow-hidden rounded-[var(--radius)] border border-border">
            {runs.map((run, i) => {
              const agent = agentByName.get(run.agentName);
              const row = (
                <>
                  {agent ? (
                    <AgentIdentity
                      identity={`${agent.key} ${agent.name}`}
                      icon={agent.icon}
                      size="sm"
                    />
                  ) : (
                    <AgentIdentity identity={run.agentName} icon="Bot" size="sm" />
                  )}
                  <div className="min-w-0 flex-1">
                    <p className="truncate text-sm">{run.agentName}</p>
                    <p className="truncate text-xs text-muted-2">
                      {relativeTime(run.createdAt)}
                      {run.prompt ? ` · "${run.prompt}"` : ""}
                    </p>
                  </div>
                  <JobStatusBadge status={run.status} />
                </>
              );
              const rowClass = cn(
                "flex items-center gap-3 px-4 py-2.5",
                i > 0 && "border-t border-border",
              );
              return run.href ? (
                <Link
                  key={run.id}
                  href={run.href}
                  className={cn(rowClass, "transition-colors hover:bg-surface-2")}
                >
                  {row}
                  <Icon name="ChevronRight" className="h-4 w-4 shrink-0 text-muted-2" />
                </Link>
              ) : (
                <div key={run.id} className={rowClass}>
                  {row}
                </div>
              );
            })}
          </div>
        </div>
      )}

      {runAgent && (
        <RunCustomAgentModal
          agent={runAgent}
          clientId={clientId}
          contextItems={contextItems}
          viewerIsClient={viewerIsClient}
          {...(xSetup ? { xSetup } : {})}
          {...(linkedinSetup ? { linkedinSetup } : {})}
          {...(runIntakeFirst ? { initialPane: "data" as const } : {})}
          onClose={() => setRunAgent(null)}
        />
      )}
      {scheduleAgent && (
        <AgentScheduleModal
          agent={scheduleAgent}
          clientId={clientId}
          schedule={scheduleByAgent.get(scheduleAgent.id)}
          availableCredits={availableCredits}
          {...(scheduleSetupNeeded ? { setupNeeded: scheduleSetupNeeded } : {})}
          onClose={() => setScheduleAgent(null)}
        />
      )}
    </section>
  );
}

function AgentScheduleModal({
  agent,
  clientId,
  schedule,
  availableCredits,
  setupNeeded,
  onClose,
}: {
  agent: RunnableAgentSummary;
  clientId: string;
  schedule?: ClientAgentScheduleRow;
  availableCredits?: number;
  /** Set when this agent drafts from intake and its company page is missing. */
  setupNeeded?: { kind: IntakeKind; onOpenData: () => void };
  onClose: () => void;
}) {
  const router = useRouter();
  const [pending, startTransition] = useTransition();
  const [postsPerWeek, setPostsPerWeek] = useState(schedule?.postsPerWeek ?? 3);
  const [outputsPerRun, setOutputsPerRun] = useState(schedule?.outputsPerRun ?? 1);
  const [prompt, setPrompt] = useState(schedule?.prompt ?? "Create the next on-brand post for our audience.");
  const [time, setTime] = useState(
    `${String(schedule?.hour ?? 9).padStart(2, "0")}:${String(schedule?.minute ?? 0).padStart(2, "0")}`,
  );
  const [error, setError] = useState<string | null>(null);
  const costPerOutput = agentRunCost(agent);
  const weeklyCost = scheduledAgentWeeklyCost(costPerOutput, postsPerWeek, outputsPerRun);
  const insufficient = availableCredits !== undefined && availableCredits < costPerOutput * outputsPerRun;
  // Nothing unattended can start before the agent has what it drafts from.
  // A schedule that already exists stays editable, so it can still be paused.
  const blockedBySetup = Boolean(setupNeeded) && !schedule;

  function save() {
    setError(null);
    const [hour, minute] = time.split(":").map(Number);
    startTransition(async () => {
      const result = await configureClientAgentScheduleAction({
        clientId,
        customAgentId: agent.id,
        postsPerWeek,
        outputsPerRun,
        prompt,
        hour,
        minute,
      });
      if (result.error) {
        setError(result.error);
        return;
      }
      router.refresh();
      onClose();
    });
  }

  function togglePause() {
    if (!schedule) return;
    startTransition(async () => {
      const result = await setPlannedRunStatusAction(
        schedule.id,
        schedule.status === "active" ? "paused" : "active",
      );
      if (result.error) {
        setError(result.error);
        return;
      }
      router.refresh();
      onClose();
    });
  }

  return (
    <Modal
      open
      onClose={onClose}
      title={`Keep ${agent.name} running`}
      description="Choose the weekly production pace. New outputs are created as drafts and placed into your content workflow."
    >
      <div className="space-y-4">
        <div className="grid grid-cols-2 gap-3">
          <div>
            <Label htmlFor={`schedule-posts-${agent.id}`}>Posts per week</Label>
            <Select
              id={`schedule-posts-${agent.id}`}
              value={postsPerWeek}
              onChange={(event) => setPostsPerWeek(Number(event.target.value))}
            >
              {[1, 2, 3, 4, 5, 6, 7].map((count) => (
                <option key={count} value={count}>{count}</option>
              ))}
            </Select>
          </div>
          <div>
            <Label htmlFor={`schedule-outputs-${agent.id}`}>Outputs per run</Label>
            <Select
              id={`schedule-outputs-${agent.id}`}
              value={outputsPerRun}
              onChange={(event) => setOutputsPerRun(Number(event.target.value))}
            >
              {[1, 2, 3, 4, 5].map((count) => (
                <option key={count} value={count}>{count}</option>
              ))}
            </Select>
          </div>
        </div>

        <div>
          <Label htmlFor={`schedule-time-${agent.id}`}>Production time</Label>
          <Input
            id={`schedule-time-${agent.id}`}
            type="time"
            value={time}
            onChange={(event) => setTime(event.target.value)}
          />
        </div>

        <div>
          <Label htmlFor={`schedule-prompt-${agent.id}`}>Ongoing direction</Label>
          <Textarea
            id={`schedule-prompt-${agent.id}`}
            rows={3}
            maxLength={4000}
            value={prompt}
            onChange={(event) => setPrompt(event.target.value)}
          />
        </div>

        <div className="rounded-md border border-neon/20 bg-neon-soft/40 px-4 py-3">
          <div className="flex items-center justify-between gap-3">
            <span className="text-sm text-foreground">Estimated weekly cost</span>
            <span className="font-mono text-sm text-neon">{weeklyCost} credits</span>
          </div>
          <p className="mt-1 text-[11px] text-muted-2">
            {postsPerWeek} runs × {outputsPerRun} outputs × {costPerOutput} credits.
            Credits are charged when each scheduled run starts.
          </p>
          {availableCredits !== undefined && (
            <p className={cn("mt-1 text-[11px]", insufficient ? "text-danger" : "text-muted-2")}>
              {availableCredits} credits currently available.
            </p>
          )}
        </div>

        {blockedBySetup && setupNeeded && (
          <p className="rounded-md border border-warning/30 bg-warning/10 px-3 py-2 text-xs text-warning">
            Add the {INTAKE_LABEL[setupNeeded.kind]} agent data first. Every scheduled run drafts
            from it, so none can start until it is saved.{" "}
            <button
              type="button"
              onClick={setupNeeded.onOpenData}
              className="cursor-pointer underline"
            >
              Open {INTAKE_LABEL[setupNeeded.kind]} agent data →
            </button>
          </p>
        )}

        {error && <p className="text-xs text-danger" role="alert">{error}</p>}

        <div className="flex items-center justify-between gap-2 border-t border-border pt-4">
          <div>
            {schedule && (
              <Button variant="ghost" onClick={togglePause} loading={pending}>
                {schedule.status === "active" ? "Pause agent" : "Resume agent"}
              </Button>
            )}
          </div>
          <div className="flex gap-2">
            <Button variant="ghost" onClick={onClose} disabled={pending}>Cancel</Button>
            <Button
              variant="accent"
              onClick={save}
              loading={pending}
              disabled={insufficient || blockedBySetup}
            >
              {schedule ? "Update schedule" : "Start always-on agent"}
            </Button>
          </div>
        </div>
      </div>
    </Modal>
  );
}

/* ═══════════════════════ run dialog ═══════════════════════ */

/** The brief, or the agent's own data form — the intake-driven agents own both. */
type RunPane = "run" | "data";

function RunCustomAgentModal({
  agent,
  clientId,
  clients,
  contextItems,
  viewerIsClient,
  xSetup,
  linkedinSetup,
  initialPane,
  onClose,
}: {
  agent: RunnableAgentSummary;
  /** Fixed client (client-page flow) … */
  clientId?: string;
  /** … or a picker (staff hub flow). */
  clients?: Array<{ id: string; name: string }>;
  contextItems: ContextItem[];
  viewerIsClient: boolean;
  /** X agent intake state and, when prefetched, the data form rendered inline. */
  xSetup?: XAgentSetup;
  /** LinkedIn agent intake state — same shape for the e10 agents. */
  linkedinSetup?: LinkedInAgentSetup;
  /** "data" opens straight on the agent's data; so does a missing company page. */
  initialPane?: RunPane;
  onClose: () => void;
}) {
  const router = useRouter();
  const [pending, startTransition] = useTransition();
  const [selectedClientId, setSelectedClientId] = useState(clientId ?? clients?.[0]?.id ?? "");
  const profile = launchProfileFor(agent);
  const [fields, setFields] = useState<Record<string, string>>(() => initialAgentBrief(profile));
  const [selectedFiles, setSelectedFiles] = useState<string[]>([]);
  // Has anyone put work into the brief that a stray click would throw away?
  const [briefTouched, setBriefTouched] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [started, setStarted] = useState(false);
  const intake = intakeFor(agent.key, xSetup, linkedinSetup);
  const intakeReady = intake?.setup.ready ?? true;
  // The data opens on the company page being missing, not on the server gate:
  // `ready` is satisfied by a shared seat, so an X run would otherwise skip
  // straight to the brief for a client who set LinkedIn up first. This only
  // chooses the pane — `ready` alone still decides what a run does.
  const openOnData = Boolean(intake) && (!companyOnFile(intake) || initialPane === "data");
  const [pane, setPane] = useState<RunPane>(openOnData ? "data" : "run");
  // Did the data open because the run wanted it, rather than because someone
  // asked for it from the card? Held in state so it survives the props refresh
  // that saving the company page triggers underneath this dialog.
  const [openedForSetup] = useState(() => openOnData && initialPane !== "data");
  // Only someone who has seen the brief can go "back" to it. A dialog that
  // opened on the data has not shown it yet, so its way out reads forward.
  const [seenRun, setSeenRun] = useState(!openOnData);
  const scrollRef = useRef<HTMLDivElement>(null);
  const dataPaneRef = useRef<HTMLDivElement>(null);
  const runPaneRef = useRef<HTMLDivElement>(null);
  const shownPane = useRef<RunPane>(pane);
  const primaryField =
    profile.fields.find((field) => field.key === "request") ??
    profile.fields.find((field) => field.required) ??
    profile.fields[0];
  // A server-side setup gate can still fire when this dialog's `ready` was
  // stale, so the message needs its own way back to the data.
  const setupErrorKind: IntakeKind | null = !error
    ? null
    : error.startsWith(X_SETUP_REQUIRED_PREFIX)
      ? "x"
      : error.startsWith(LINKEDIN_SETUP_REQUIRED_PREFIX)
        ? "linkedin"
        : null;

  // Both panes share the dialog's single scroll box, which also holds the title
  // and the sentence explaining the swap, so a switch has to go back to the top
  // of that box rather than to the top of the pane. The control that did the
  // switching lived in the pane it hid, so focus has to move too. Neither is
  // wanted on first mount — the dialog already opens at the top.
  useEffect(() => {
    if (shownPane.current === pane) return;
    shownPane.current = pane;
    (pane === "data" ? dataPaneRef : runPaneRef).current?.focus({ preventScroll: true });
    scrollRef.current?.scrollTo({ top: 0 });
  }, [pane]);

  function setField(key: string, value: string) {
    setBriefTouched(true);
    setFields((current) => ({ ...current, [key]: value }));
  }

  function showRun() {
    setSeenRun(true);
    setPane("run");
  }

  function submit() {
    setError(null);
    if (!selectedClientId) {
      setError("Pick a client. Agents always run against a client's context.");
      return;
    }
    const missing = profile.fields.find((field) => field.required && !fields[field.key]?.trim());
    if (missing) {
      setError(`${missing.label} is required.`);
      return;
    }
    const attachmentAlternative = profile.attachments.satisfyWithFieldKey;
    if (
      profile.attachments.required &&
      selectedFiles.length === 0 &&
      !(attachmentAlternative && fields[attachmentAlternative]?.trim())
    ) {
      setError(`Add ${profile.attachments.label.toLowerCase()} or provide the source link above.`);
      return;
    }
    const prompt = buildCustomAgentPrompt(profile, fields);
    if (!prompt) {
      setError("Complete the brief before starting the run.");
      return;
    }
    if (prompt.length > 4000) {
      setError(`This brief is ${prompt.length.toLocaleString()} characters. Shorten it to 4,000 characters.`);
      return;
    }
    startTransition(async () => {
      const result = await runCustomAgentAction({
        agentId: agent.id,
        clientId: selectedClientId,
        prompt,
        contextItemIds: selectedFiles,
      });
      if (result.error) {
        setError(result.error);
        return;
      }
      if (viewerIsClient) {
        setStarted(true);
        router.refresh();
      } else if (result.jobId) {
        router.push(`/jobs/${result.jobId}`);
      }
    });
  }

  if (started) {
    return (
      <Modal open onClose={onClose} title={agent.name}>
        <div className="mt-4 space-y-3 text-center">
          <Icon name="CheckCircle2" className="mx-auto h-8 w-8 text-success" />
          <p className="text-sm text-foreground">Run started</p>
          <p className="text-xs text-muted">
            The agent is working. This usually takes {profile.estimate.replace("~", "")}. Deliverables appear in your
            Workspace archive once your Karos team approves them.
          </p>
          <Button variant="subtle" onClick={onClose}>
            Done
          </Button>
        </div>
      </Modal>
    );
  }

  const showData = Boolean(intake) && pane === "data";
  // Lead the eye on once the setup that held up a run is done; anyone who came
  // to read or edit data they already have gets the quiet version.
  const continueToRun = openedForSetup && companyOnFile(intake);

  return (
    <Modal
      open
      onClose={onClose}
      title={showData && intake ? `${INTAKE_LABEL[intake.kind]} agent data` : agent.name}
      description={
        showData
          ? companyOnFile(intake)
            ? "This is what the agent drafts from. Change or add anything; it applies to the next run."
            : "We draft from this, so we ask for it before the first run: the company page, a seat for each person, and your ongoing drops."
          : agent.description
      }
      className={showData ? "max-w-3xl" : "max-w-2xl"}
      // Both panes hold work a mis-click must not throw away: the intake form
      // in one, the brief in the other. Escape, the ✕ and the pane's own
      // dismiss stay the deliberate ways out.
      closeOnBackdrop={!intake && !briefTouched}
      scrollRef={scrollRef}
    >
      {intake && (
        // Both panes stay mounted. Every field in the intake cards is local
        // state, so unmounting the form to show the brief would discard typed
        // text; `hidden` keeps the idle pane out of the tab order and the
        // accessibility tree too. Each pane takes focus when it is shown, so it
        // needs to be focusable without drawing a ring of its own.
        <div
          ref={dataPaneRef}
          tabIndex={-1}
          className="space-y-5 focus:outline-none"
          hidden={!showData}
        >
          <div className="flex flex-wrap items-center gap-2">
            {/* The way on stays in place while the setup is unfinished so that
                saving the company page changes only its tone, never the layout
                under the reader's hands. */}
            <Button
              size="sm"
              variant={continueToRun ? "accent" : "subtle"}
              disabled={!intakeReady}
              onClick={showRun}
            >
              {seenRun ? (
                <>
                  <Icon name="ArrowLeft" className="h-3.5 w-3.5" /> Back to the run
                </>
              ) : (
                <>
                  Continue to the run
                  <Icon name="ArrowRight" className="h-3.5 w-3.5" />
                </>
              )}
            </Button>
            {!intakeReady && (
              <p className="text-xs text-muted">Save the company page below to continue.</p>
            )}
          </div>
          <IntakeForm intake={intake} />
          <div className="flex items-center justify-end gap-2 border-t border-border pt-4">
            <Button variant="ghost" onClick={onClose}>
              {openedForSetup ? "Cancel run" : "Close"}
            </Button>
          </div>
        </div>
      )}

      <div
        ref={runPaneRef}
        tabIndex={-1}
        className="space-y-5 focus:outline-none"
        hidden={showData}
      >
        {intake && (
          <div className="flex flex-wrap items-center gap-2">
            {/* Reaching the brief at all means the company page is on file, so
                in practice this reads quiet. It still asks, because the flag it
                asks about belongs to the caller and the tone must not lie if
                that flag ever parts company with the rows shipped beside it. */}
            <AgentDataButton
              kind={intake.kind}
              ready={intakeComplete(intake)}
              onOpen={() => setPane("data")}
            />
          </div>
        )}

        <div className="rounded-md border border-border bg-surface-2 px-4 py-3">
          <div className="flex flex-wrap items-start justify-between gap-3">
            <div className="max-w-lg">
              <p className="font-mono text-[10px] uppercase tracking-[0.12em] text-muted-2">{profile.eyebrow}</p>
              <p className="mt-1 text-xs leading-relaxed text-muted">{profile.intro}</p>
            </div>
            <Badge tone="neutral">
              <Icon name="Clock" className="h-3 w-3" /> {profile.estimate}
            </Badge>
          </div>
          <div className="mt-3 flex flex-wrap gap-x-4 gap-y-1">
            {profile.deliverables.map((deliverable) => (
              <span key={deliverable} className="inline-flex items-center gap-1.5 text-[11px] text-foreground">
                <Icon name="Check" className="h-3 w-3 text-success" /> {deliverable}
              </span>
            ))}
          </div>
        </div>

        {!clientId && clients && (
          <div>
            <Label htmlFor="ca-client">Client</Label>
            <Select
              id="ca-client"
              value={selectedClientId}
              onChange={(event) => {
                setSelectedClientId(event.target.value);
                setSelectedFiles([]);
              }}
            >
              {clients.map((c) => (
                <option key={c.id} value={c.id}>
                  {c.name}
                </option>
              ))}
            </Select>
          </div>
        )}

        <div>
          <Label>Common starting points</Label>
          <div className="mt-2 flex flex-wrap gap-1.5">
            {profile.quickStarts.map((quickStart) => (
              <button
                key={quickStart}
                type="button"
                onClick={() => setField(primaryField.key, quickStart)}
                className={cn(
                  "rounded-full border px-2.5 py-1 text-left text-[11px] transition-colors",
                  fields[primaryField.key] === quickStart
                    ? "border-neon/60 bg-neon/10 text-neon"
                    : "border-border bg-surface-2 text-muted hover:border-border-strong hover:text-foreground",
                )}
              >
                {quickStart}
              </button>
            ))}
          </div>
        </div>

        <div className="grid gap-4 sm:grid-cols-2">
          {profile.fields.map((field) => {
            const id = `ca-${agent.id}-${field.key}`;
            const fullWidth = field.type === "textarea";
            return (
              <div key={field.key} className={fullWidth ? "sm:col-span-2" : undefined}>
                <Label htmlFor={id}>
                  {field.label}
                  {field.required ? <span className="ml-1 text-danger">*</span> : null}
                </Label>
                {field.type === "select" ? (
                  <Select
                    id={id}
                    value={fields[field.key] ?? ""}
                    onChange={(event) => setField(field.key, event.target.value)}
                  >
                    {field.options?.map((option) => (
                      <option key={option.value} value={option.value}>{option.label}</option>
                    ))}
                  </Select>
                ) : field.type === "textarea" ? (
                  <Textarea
                    id={id}
                    rows={3}
                    maxLength={1600}
                    placeholder={field.placeholder}
                    value={fields[field.key] ?? ""}
                    onChange={(event) => setField(field.key, event.target.value)}
                  />
                ) : (
                  <Input
                    id={id}
                    type={field.type === "number" ? "number" : "text"}
                    min={field.min}
                    max={field.max}
                    maxLength={field.type === "number" ? undefined : 500}
                    placeholder={field.placeholder}
                    value={fields[field.key] ?? ""}
                    onChange={(event) => setField(field.key, event.target.value)}
                  />
                )}
                {field.helper ? <p className="mt-1 text-xs text-muted-2">{field.helper}</p> : null}
              </div>
            );
          })}
        </div>

        <AgentInputFiles
          key={`${selectedClientId}-${agent.id}`}
          clientId={selectedClientId}
          agentName={agent.name}
          items={contextItems}
          selectedIds={selectedFiles}
          onChange={(ids) => {
            setBriefTouched(true);
            setSelectedFiles(ids);
          }}
          profile={profile.attachments}
          canUpload={!viewerIsClient}
        />

        {error && (
          <p className="text-xs text-danger" role="alert">
            {error}
            {setupErrorKind &&
              (intake ? (
                <button
                  type="button"
                  onClick={() => setPane("data")}
                  className="ml-1.5 cursor-pointer underline"
                >
                  Open {INTAKE_LABEL[setupErrorKind]} agent data →
                </button>
              ) : (
                selectedClientId && (
                  <a
                    href={`/clients/${selectedClientId}/${INTAKE_ROUTE[setupErrorKind]}`}
                    className="ml-1.5 underline"
                  >
                    Open {INTAKE_LABEL[setupErrorKind]} agent data →
                  </a>
                )
              ))}
          </p>
        )}

        <div className="flex items-center justify-between gap-3 pt-1">
          <p className="text-xs text-muted-2">
            <Icon name="Clock" className="mr-1 inline h-3 w-3" />
            {profile.estimate}. You can leave this page; the run continues.
            {viewerIsClient && <span className="ml-1">Costs {agentRunCost(agent)} credits.</span>}
          </p>
          <Button variant="accent" onClick={submit} loading={pending}>
            {pending ? "Starting…" : "Start run"}
          </Button>
        </div>
      </div>
    </Modal>
  );
}

/* ═══════════════════════ editor (admin) ═══════════════════════ */

function AgentEditorModal({ agent, onClose }: { agent: CustomAgent | null; onClose: () => void }) {
  const router = useRouter();
  const [pending, startTransition] = useTransition();
  const [error, setError] = useState<string | null>(null);
  const [confirmDelete, setConfirmDelete] = useState(false);

  const [name, setName] = useState(agent?.name ?? "");
  const [key, setKey] = useState(agent?.key ?? "");
  const [description, setDescription] = useState(agent?.description ?? "");
  const [icon, setIcon] = useState(agent?.icon ?? "Sparkles");
  const [color, setColor] = useState(agent?.color ?? "#A3E635");
  const [entrySkillDir, setEntrySkillDir] = useState(agent?.entrySkillDir ?? "");
  const [skillRoots, setSkillRoots] = useState((agent?.skillRoots ?? []).join("\n"));
  const [includeClientSkills, setIncludeClientSkills] = useState(agent?.includeClientSkills ?? true);
  const [instructions, setInstructions] = useState(agent?.instructions ?? "");
  const [creditCost, setCreditCost] = useState(agent?.creditCost != null ? String(agent.creditCost) : "");
  const [enabled, setEnabled] = useState(agent?.enabled ?? true);

  function save() {
    setError(null);
    const input = {
      name,
      key: key || name.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, ""),
      description,
      icon,
      color,
      entrySkillDir,
      skillRoots: skillRoots.split("\n").map((s) => s.trim()).filter(Boolean),
      includeClientSkills,
      instructions,
      creditCost: creditCost.trim() === "" ? null : Number(creditCost),
      enabled,
    };
    startTransition(async () => {
      const result = agent
        ? await updateCustomAgentAction(agent.id, input)
        : await createCustomAgentAction(input);
      if (result.error) {
        setError(result.error);
        return;
      }
      router.refresh();
      onClose();
    });
  }

  function remove() {
    startTransition(async () => {
      const result = await deleteCustomAgentAction(agent!.id);
      if (result.error) {
        setError(result.error);
        return;
      }
      router.refresh();
      onClose();
    });
  }

  return (
    <Modal
      open
      onClose={onClose}
      title={agent ? `Edit ${agent.name}` : "New custom agent"}
      description="The instructions are the agent's system prompt. The run adds the client context and the user's request around them."
      className="max-w-2xl"
    >
      <div className="mt-4 space-y-4">
        <div className="grid gap-4 sm:grid-cols-2">
          <div>
            <Label htmlFor="ae-name">Name</Label>
            <Input id="ae-name" value={name} onChange={(e) => setName(e.target.value)} placeholder="Instagram Agent" />
          </div>
          <div>
            <Label htmlFor="ae-key">Key</Label>
            <Input id="ae-key" value={key} onChange={(e) => setKey(e.target.value)} placeholder="karos-instagram-agent" />
          </div>
        </div>
        <div>
          <Label htmlFor="ae-desc">Description</Label>
          <Textarea id="ae-desc" rows={2} value={description} onChange={(e) => setDescription(e.target.value)} />
        </div>
        <div>
          <Label htmlFor="ae-entry">Entry skill dir (in karos-agents)</Label>
          <Input
            id="ae-entry"
            value={entrySkillDir}
            onChange={(e) => setEntrySkillDir(e.target.value)}
            placeholder="products/live/instagram-agent"
            className="font-mono text-xs"
          />
        </div>
        <div>
          <Label htmlFor="ae-roots">Extra skill roots (one per line, optional)</Label>
          <Textarea
            id="ae-roots"
            rows={2}
            value={skillRoots}
            onChange={(e) => setSkillRoots(e.target.value)}
            placeholder="skills/vendors/taste-skill"
            className="font-mono text-xs"
          />
        </div>
        <div>
          <Label htmlFor="ae-instructions">Instructions (system prompt)</Label>
          <Textarea
            id="ae-instructions"
            rows={8}
            maxLength={12000}
            value={instructions}
            onChange={(e) => setInstructions(e.target.value)}
            className="font-mono text-xs"
          />
          <p className="mt-1 text-right text-xs text-muted-2">{instructions.length.toLocaleString()} / 12,000</p>
        </div>
        <div className="grid gap-4 sm:grid-cols-3">
          <div>
            <Label htmlFor="ae-icon">Icon (lucide name)</Label>
            <Input id="ae-icon" value={icon} onChange={(e) => setIcon(e.target.value)} />
          </div>
          <div>
            <Label htmlFor="ae-color">Color</Label>
            <Input id="ae-color" value={color} onChange={(e) => setColor(e.target.value)} placeholder="#A3E635" />
          </div>
          <div>
            <Label htmlFor="ae-cost">Credits per run</Label>
            <Input
              id="ae-cost"
              type="number"
              min={0}
              value={creditCost}
              onChange={(e) => setCreditCost(e.target.value)}
              placeholder={`${CREDIT_COSTS.customAgentRun} (default)`}
            />
          </div>
        </div>
        <div className="flex items-center gap-4">
          <label className="flex cursor-pointer items-center gap-2 text-xs">
            <input type="checkbox" checked={enabled} onChange={(e) => setEnabled(e.target.checked)} className="accent-neon" />
            Enabled
          </label>
          <label className="flex cursor-pointer items-center gap-2 text-xs" title="Also load the client's emitted sub-skills (clients/<slug>/skills/)">
            <input
              type="checkbox"
              checked={includeClientSkills}
              onChange={(e) => setIncludeClientSkills(e.target.checked)}
              className="accent-neon"
            />
            Use client&apos;s emitted skills
          </label>
        </div>

        {agent?.source?.status === "blocked" && (
          <p className="rounded-md border border-border bg-surface-2 px-3 py-2 text-xs text-muted">
            <Icon name="AlertTriangle" className="mr-1 inline h-3.5 w-3.5 text-warning" />
            The repo catalog marks this skill blocked. Review before enabling.
          </p>
        )}
        {error && <p className="text-xs text-danger">{error}</p>}

        <div className="flex items-center justify-between gap-3 pt-1">
          {agent ? (
            confirmDelete ? (
              <span className="flex items-center gap-2 text-xs">
                Delete this agent?
                <Button size="sm" variant="danger" onClick={remove} loading={pending}>
                  Delete
                </Button>
                <Button size="sm" variant="ghost" onClick={() => setConfirmDelete(false)}>
                  Keep
                </Button>
              </span>
            ) : (
              <Button size="sm" variant="ghost" onClick={() => setConfirmDelete(true)}>
                <Icon name="Trash2" className="h-3.5 w-3.5" /> Delete
              </Button>
            )
          ) : (
            <span />
          )}
          <Button variant="accent" onClick={save} loading={pending}>
            {agent ? "Save changes" : "Create agent"}
          </Button>
        </div>
      </div>
    </Modal>
  );
}

/* ═══════════════════════ import (admin) ═══════════════════════ */

type Candidate = {
  key: string;
  name: string;
  description: string;
  entrySkillDir: string;
  group: string;
  status: string;
  blockedReason?: string;
  imported: boolean;
};

function ImportAgentsModal({ onClose }: { onClose: () => void }) {
  const router = useRouter();
  const [pending, startTransition] = useTransition();
  const [candidates, setCandidates] = useState<Candidate[] | null>(null);
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    void listCustomAgentImportCandidatesAction().then((result) => {
      if (cancelled) return;
      if (result.error) setError(result.error);
      else setCandidates(result.candidates ?? []);
    });
    return () => {
      cancelled = true;
    };
  }, []);

  const groups = useMemo(() => {
    const map = new Map<string, Candidate[]>();
    for (const c of candidates ?? []) {
      const list = map.get(c.group) ?? [];
      list.push(c);
      map.set(c.group, list);
    }
    return [...map.entries()];
  }, [candidates]);

  function toggle(key: string) {
    setSelected((prev) => {
      const next = new Set(prev);
      if (next.has(key)) next.delete(key);
      else next.add(key);
      return next;
    });
  }

  function selectAllReady() {
    setSelected(
      new Set((candidates ?? []).filter((c) => !c.imported && c.status === "ready").map((c) => c.key)),
    );
  }

  function runImport() {
    setError(null);
    startTransition(async () => {
      const result = await importCustomAgentsAction([...selected]);
      if (result.error) {
        setError(result.error);
        return;
      }
      router.refresh();
      onClose();
    });
  }

  const statusTone = (status: string) =>
    status === "ready" ? "success" : status === "blocked" ? "danger" : "warning";

  return (
    <Modal
      open
      onClose={onClose}
      title="Import agents from karos-agents"
      description="Scanned from the repo's runtime catalog. Blocked agents import disabled until you review them."
      className="max-w-2xl"
    >
      <div className="mt-4 space-y-4">
        {!candidates && !error && (
          <p className="py-8 text-center text-sm text-muted">
            <Icon name="Loader2" className="mr-2 inline h-4 w-4 animate-spin" />
            Scanning the repo catalog…
          </p>
        )}

        {candidates && (
          <>
            <div className="flex items-center justify-between gap-2">
              <p className="text-xs text-muted">
                {candidates.filter((c) => !c.imported).length} importable · {selected.size} selected
              </p>
              <Button size="sm" variant="ghost" onClick={selectAllReady}>
                Select all ready
              </Button>
            </div>
            <div className="max-h-[50vh] space-y-4 overflow-y-auto pr-1">
              {groups.map(([group, items]) => (
                <div key={group}>
                  <p className="mb-1.5 font-mono text-[10px] uppercase tracking-[0.08em] text-muted">
                    {group}
                  </p>
                  <div className="overflow-hidden rounded-md border border-border">
                    {items.map((c, i) => (
                      <label
                        key={c.key}
                        className={cn(
                          "flex cursor-pointer items-center gap-2.5 px-3 py-2 text-xs transition-colors hover:bg-surface-2",
                          i > 0 && "border-t border-border",
                          c.imported && "cursor-default opacity-50",
                        )}
                        title={c.blockedReason ?? c.description}
                      >
                        <input
                          type="checkbox"
                          disabled={c.imported}
                          checked={selected.has(c.key)}
                          onChange={() => toggle(c.key)}
                          className="accent-neon"
                        />
                        <div className="min-w-0 flex-1">
                          <p className="truncate text-foreground">{c.name}</p>
                          <p className="truncate font-mono text-[10px] text-muted-2">{c.entrySkillDir}</p>
                        </div>
                        {c.imported ? (
                          <Badge tone="neutral">Imported</Badge>
                        ) : (
                          <Badge tone={statusTone(c.status)}>{c.status}</Badge>
                        )}
                      </label>
                    ))}
                  </div>
                </div>
              ))}
            </div>
          </>
        )}

        {error && <p className="text-xs text-danger">{error}</p>}

        <div className="flex items-center justify-end gap-2 pt-1">
          <Button variant="ghost" onClick={onClose}>
            Cancel
          </Button>
          <Button variant="accent" onClick={runImport} loading={pending} disabled={selected.size === 0}>
            {pending ? "Importing…" : `Import ${selected.size || ""}`.trim()}
          </Button>
        </div>
      </div>
    </Modal>
  );
}

/* ═══════════════ client settings: agent access (admin) ═══════════════ */

export function ClientAgentAccessCard({
  clientId,
  agents,
  allowedIds,
}: {
  clientId: string;
  agents: CustomAgent[];
  allowedIds: string[];
}) {
  const router = useRouter();
  const [pending, startTransition] = useTransition();
  // Intersect with the current library: an allowlist can reference agents that
  // were deleted since it was saved, and those must not block re-saving.
  const [selected, setSelected] = useState<Set<string>>(
    () => new Set(allowedIds.filter((id) => agents.some((a) => a.id === id))),
  );
  const [error, setError] = useState<string | null>(null);
  const [saved, setSaved] = useState(false);

  const dirty = useMemo(() => {
    if (selected.size !== allowedIds.length) return true;
    return allowedIds.some((id) => !selected.has(id));
  }, [selected, allowedIds]);

  function toggle(id: string) {
    setSaved(false);
    setSelected((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  }

  function save() {
    setError(null);
    startTransition(async () => {
      const result = await setClientCustomAgentsAction(clientId, [...selected]);
      if (result.error) {
        setError(result.error);
        return;
      }
      setSaved(true);
      router.refresh();
    });
  }

  if (agents.length === 0) {
    return (
      <p className="text-xs text-muted">
        No custom agents in the library yet. Import them on the{" "}
        <Link href="/agents" className="text-neon hover:underline">
          Agents page
        </Link>
        .
      </p>
    );
  }

  return (
    <div className="space-y-3">
      <div className="space-y-1">
        {agents.map((agent) => (
          <label
            key={agent.id}
            className={cn(
              "flex cursor-pointer items-center gap-2.5 rounded-md px-2 py-1.5 text-xs transition-colors hover:bg-surface-2",
              !agent.enabled && "opacity-60",
            )}
          >
            <input
              type="checkbox"
              checked={selected.has(agent.id)}
              onChange={() => toggle(agent.id)}
              className="accent-neon"
            />
            <span className="flex h-6 w-6 shrink-0 items-center justify-center rounded-md border border-foreground/10 bg-foreground/[0.04] text-foreground/80">
              <AgentMark identity={`${agent.key} ${agent.name}`} icon={agent.icon} className="h-3.5 w-3.5" />
            </span>
            <span className="min-w-0 flex-1 truncate text-foreground">{agent.name}</span>
            <span className="shrink-0 text-muted-2">{agentRunCost(agent)} cr/run</span>
            {!agent.enabled && <Badge tone="warning">Disabled</Badge>}
          </label>
        ))}
      </div>
      {error && <p className="text-xs text-danger">{error}</p>}
      <div className="flex items-center justify-between gap-2">
        <p className="text-xs text-muted-2">
          {saved ? "Saved." : "Checked agents appear on the client's AI Agents page, billed per run."}
        </p>
        <Button size="sm" variant="accent" onClick={save} loading={pending} disabled={!dirty}>
          Save access
        </Button>
      </div>
    </div>
  );
}
