"use client";

import { type ComponentProps, useEffect, useMemo, useRef, useState, useTransition } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { Badge, Button, Input, Label, Select, Textarea } from "@/components/ui";
import { Icon, LinkedInLogo, XLogo } from "@/components/icon";
import {
  AgentIdentity,
  AgentMark,
  AgentPlatformBadges,
  SocialPlatformMark,
} from "@/components/agent-identity";
import { AgentInputFiles } from "@/components/agent-input-files";
import { LinkedInAgentIntake } from "@/components/linkedin-agent-intake";
import { RedditAgentIntake } from "@/components/reddit-agent-intake";
import { XAgentIntake } from "@/components/x-agent-intake";
import { Modal } from "@/components/modal";
import { ContactUsButton } from "@/components/contact-us-modal";
import { JobStatusBadge } from "@/components/job-status";
import { ManagedJobProgress } from "@/components/managed-job-progress";
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
import { cancelClientAgentJobAction } from "@/lib/actions/external-job-actions";
import { CREDIT_COSTS, scheduledAgentWeeklyCost } from "@/lib/credits";
import { clientAgentBlurb } from "@/lib/agent-blurbs";
import { scheduleLimitsFor } from "@/lib/scheduled-runs";
import {
  agentKeyMatchesClientSlug,
  buildCustomAgentPrompt,
  initialAgentBrief,
  isLinkedInAgentIdentity,
  isXAgentIdentity,
  launchProfileFor,
  perClientAgentSlug,
  LINKEDIN_SETUP_REQUIRED_PREFIX,
  REDDIT_SETUP_REQUIRED_PREFIX,
  X_SETUP_REQUIRED_PREFIX,
} from "@/lib/custom-agent-launch";
import type { ContextItem, CustomAgent, JobStatus } from "@/lib/types";
import { cn, formatDate, relativeTime } from "@/lib/utils";

/* ═══════════════════════ shared bits ═══════════════════════ */

/**
 * The slice of a CustomAgent that may be serialized to client-user browsers.
 * Deliberately excludes instructions (the system prompt), skill paths, and
 * repo provenance — pages map full docs down to this before passing them.
 *
 * `description` is NOT on it (F127). It is the lab repo's own skill manifest,
 * no surface that receives this summary reads it, and this module's whole
 * doctrine is that a field which crosses the boundary is readable from
 * view-source whether or not anything paints it. The staff agent LIBRARY still
 * shows it — that surface takes the full CustomAgent, which is the honest place
 * for manifest text to live.
 */
export type RunnableAgentSummary = Pick<
  CustomAgent,
  "id" | "key" | "name" | "clientBlurb" | "icon" | "color"
> & {
  creditCost?: number | null;
};

/**
 * What a client is allowed to read about an agent: the curated `clientBlurb`,
 * then the keyed fallback.
 *
 * Agents imported before that field existed used to fall back to the manifest
 * `description`. That is the defect Albert screenshotted (CD-G2): cards on his
 * own client pages reading "Master content-social skill. Given a brand's
 * guidelines + any past competitor research…". The fallback is now the keyed
 * blurb map, which always has a sentence written for a buyer — so the manifest
 * is no longer in the chain at all, nor in the payload, and the staff library
 * still flags agents with no curated blurb for a rewrite.
 */
function agentBlurb(agent: Pick<RunnableAgentSummary, "key" | "name" | "clientBlurb">): string {
  return clientAgentBlurb({
    key: agent.key,
    name: agent.name,
    clientBlurb: agent.clientBlurb ?? null,
  });
}

/** One run-history row, pre-filtered and stripped server-side. */
export interface CustomAgentRunRow {
  id: string;
  /** The run's STORED agent name. A join key — the card matches its own runs on it. */
  agentName: string;
  /**
   * The ONE name this row prints, resolved server-side through the §7.3
   * identity helper (F147). Equal to `agentName` for an agent with no
   * umbrella; the umbrella's own display name when one owns this stream.
   */
  label: string;
  status: JobStatus;
  createdAt: number;
  assetCount: number;
  /**
   * The operator's raw request. STAFF VIEWERS ONLY — a client's permanent run
   * history must not be somebody's typing, misspellings and all, so the page
   * omits it from the client payload rather than hiding it at render.
   */
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
  /**
   * The ongoing direction handed to the agent on every fire — STAFF-AUTHORED,
   * and absent for client viewers (toScheduleRows omits it). It used to ship
   * unconditionally and be painted in an editable textarea inside the client's
   * pace dialog, which both showed a client internal operator copy and let them
   * rewrite the instruction every future run receives.
   */
  prompt?: string;
  hour: number;
  minute: number;
  /**
   * The scheduler's refusal from the last fire that produced nothing. When set,
   * the card drops the "Live" badge — an always-on agent that is refused on
   * every fire must never read as healthy.
   */
  lastError?: string | null;
  /** Epoch millis of that refusal. */
  lastErrorAt?: number | null;
}

/**
 * The intake page an agent refuses to run without, by agent key — or null for
 * agents with no such gate. Used on the STAFF hub, where the client is chosen
 * inside the run dialog and per-agent readiness therefore cannot be resolved
 * before the card is drawn (the client page passes a resolved `agentSetup` map
 * instead). Names the gate; does not claim to know whether it is satisfied.
 */
function intakeDrivenLabel(key: string): string | null {
  if (isXAgentIdentity(key)) return "X agent data";
  if (isLinkedInAgentIdentity(key)) return "LinkedIn agent data";
  return null;
}

/** The dialog's dropdowns, built from the same bounds the server clamps to. */
/**
 * The dropdown ranges, read from the SAME per-agent limits the server clamps
 * with (scheduleLimitsFor). The Reddit agent's ceiling is lower than the
 * generic one (F27), and a dialog offering more than the server will accept
 * either silently rewrites the client's choice on save or bills for a pace the
 * product does not sell.
 */
function countOptions(max: number): number[] {
  return Array.from({ length: max }, (_, i) => i + 1);
}

function agentRunCost(agent: Pick<RunnableAgentSummary, "creditCost">): number {
  return agent.creditCost ?? CREDIT_COSTS.customAgentRun;
}

/**
 * An agent's blurb wherever a client reads it. Clamped to three lines so the
 * cut always lands on a line boundary — never mid-word — with a "More" control
 * that expands it in place. Whether the text overflows is MEASURED rather than
 * guessed from a character count: a length threshold is the same class of bug,
 * and the same prose wraps to a different number of lines per card width.
 */
function AgentBlurb({ text, className }: { text: string; className?: string }) {
  const [expanded, setExpanded] = useState(false);
  const [overflows, setOverflows] = useState(false);
  const ref = useRef<HTMLParagraphElement>(null);

  useEffect(() => {
    const el = ref.current;
    // While expanded there is nothing to measure (the clamp is off) — keep the
    // last answer so the control that opened it does not vanish under the cursor.
    if (!el || expanded) return;
    const measure = () => setOverflows(el.scrollHeight - el.clientHeight > 1);
    measure();
    window.addEventListener("resize", measure);
    return () => window.removeEventListener("resize", measure);
  }, [text, expanded]);

  return (
    <div className={className}>
      <p ref={ref} className={cn("text-xs leading-relaxed text-muted", !expanded && "line-clamp-3")}>
        {text}
      </p>
      {overflows && (
        <button
          type="button"
          aria-expanded={expanded}
          onClick={() => setExpanded((open) => !open)}
          className="mt-0.5 text-[11px] text-muted-2 underline-offset-2 transition-colors hover:text-foreground hover:underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-foreground/25"
        >
          {expanded ? "Less" : "More"}
        </button>
      )}
    </div>
  );
}

/**
 * The intake page an agent drafts from, when it has one (X e13, LinkedIn e10).
 *
 * Readiness is resolved PER AGENT on the server and handed down keyed by agent
 * id. It cannot be recomputed here from one shared flag: `hasLinkedInAgentIntake`
 * answers differently depending on the agent key it is given (the multi-seat
 * agent accepts any stored intake; the company-page agents require the company
 * form), and the submit core passes that key. A single shared answer would block
 * an agent the server would happily run.
 */
/**
 * One agent's intake state, resolved server-side.
 *
 * It carries BOTH routes to the same form, because the two surfaces that need
 * it can reach it differently. `href` is the agent's own data page and always
 * exists — that is what the client's detail route offers (CD-E1/CD-G1), and it
 * is the only option when the page did not prefetch the form. `kind`/`data`
 * appear when it DID: the run dialog then collects the intake in place, so a
 * staff member setting up a run does not lose the brief they were writing to a
 * navigation.
 *
 * kind and data move together — a kind with no payload would render an empty
 * pane, and a payload with no kind has no form to render it in.
 */
export type AgentSetupState = {
  ready: boolean;
  href: string;
  /** e.g. "X agent data" — names the intake page in copy and link labels. */
  label: string;
} & (
  | { kind?: undefined; data?: undefined }
  | { kind: "x"; data: ComponentProps<typeof XAgentIntake> }
  | { kind: "linkedin"; data: ComponentProps<typeof LinkedInAgentIntake> }
  | { kind: "reddit"; data: ComponentProps<typeof RedditAgentIntake> }
);

function AgentChip({ agent, className }: { agent: Pick<RunnableAgentSummary, "key" | "name" | "icon">; className?: string }) {
  return (
    <AgentIdentity
      identity={`${agent.key} ${agent.name}`}
      icon={agent.icon}
      className={className}
    />
  );
}

/* ═══════ intake-driven agents (X e13, LinkedIn e10, Reddit e15) ═══════ */

/**
 * The X, LinkedIn and Reddit agents draft from stored intake, so their data
 * forms live inside the run dialog: inline on a first run, behind the
 * "<platform> agent data" button once the data exists. `ready` is the server run
 * gate; `data` is the payload rendered inline.
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

/** The e15 twin of XAgentSetup. */
export interface RedditAgentSetup {
  ready: boolean;
  data: ComponentProps<typeof RedditAgentIntake>;
}

type IntakeKind = "x" | "linkedin" | "reddit";

type AgentIntakeContext =
  | { kind: "x"; setup: XAgentSetup }
  | { kind: "linkedin"; setup: LinkedInAgentSetup }
  | { kind: "reddit"; setup: RedditAgentSetup };

const INTAKE_LABEL: Record<IntakeKind, string> = { x: "X", linkedin: "LinkedIn", reddit: "Reddit" };

/** Route segment of the full agent data page, for callers with no inline payload. */
const INTAKE_ROUTE: Record<IntakeKind, string> = {
  x: "x-agent",
  linkedin: "linkedin-agent",
  reddit: "reddit-agent",
};

/**
 * What the agent drafts from, in the client's words — the run dialog says this
 * when the data is still missing. Per kind, because the three agents hold
 * genuinely different data: X and LinkedIn have a company page and seats,
 * Reddit has one account plus the subreddits it may answer in.
 */
const INTAKE_ASKS: Record<IntakeKind, string> = {
  x: "the company page, a seat for each person, and your ongoing drops",
  linkedin: "the company page, a seat for each person, and your ongoing drops",
  reddit: "the account we draft as, and how you want mentions handled",
};

/** The first thing to do in the data pane, per kind. */
const INTAKE_FIRST_STEP: Record<IntakeKind, string> = {
  x: "Save the company page below to continue.",
  linkedin: "Save the company page below to continue.",
  reddit: "Save your Reddit account below to continue.",
};

/**
 * Which intake surface governs this agent — read off the agent's own setup
 * state rather than re-derived from its key.
 *
 * Resolving it from the key meant every caller had to be handed all three
 * payloads and asked the identity question again, which is a second place for
 * "is this the LinkedIn agent" to drift from the server's answer. Now the page
 * says it once, per agent, and a state with no prefetched form yields null —
 * the href card serves that case.
 */
function intakeFor(setup: AgentSetupState | null | undefined): AgentIntakeContext | null {
  if (!setup?.kind) return null;
  if (setup.kind === "x") return { kind: "x", setup: { ready: setup.ready, data: setup.data } };
  if (setup.kind === "linkedin") {
    return { kind: "linkedin", setup: { ready: setup.ready, data: setup.data } };
  }
  return { kind: "reddit", setup: { ready: setup.ready, data: setup.data } };
}

function IntakeGlyph({ kind, className }: { kind: IntakeKind; className?: string }) {
  if (kind === "x") return <XLogo className={className} />;
  if (kind === "linkedin") return <LinkedInLogo className={className} />;
  return <SocialPlatformMark platform="reddit" className={className} />;
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
  // One explicit branch per kind on purpose: a trailing fallback would silently
  // render another platform's form for a kind added later.
  if (intake.kind === "x") return <XAgentIntake {...intake.setup.data} />;
  if (intake.kind === "linkedin") return <LinkedInAgentIntake {...intake.setup.data} />;
  return <RedditAgentIntake {...intake.setup.data} />;
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
  /**
   * The lab-repo slug rides along because the hub is the one surface that pairs
   * an ARBITRARY agent with an arbitrary client: a per-client instance runs an
   * entry skill baked under the folder its key names, and both submit cores
   * refuse the wrong pair. Without the slug the hub can only offer every client
   * and let the server refuse — after the whole brief has been written (F38).
   */
  clients: Array<{ id: string; name: string; agentsRepoSlug?: string | null }>;
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
          {agents.map((agent) => {
            // F38. The clients this agent can actually run for. An unbound agent
            // keeps the whole list; a per-client instance keeps its own client,
            // and keeps NONE when that client is absent from this staff member's
            // visible set or has no lab slug on file.
            const eligible = clients.filter((c) =>
              agentKeyMatchesClientSlug(agent.key, c.agentsRepoSlug),
            );
            // F35. What the card must say out loud: which workspace an instance
            // belongs to. Until now the only way to learn it was to write a
            // brief and read the refusal.
            const boundTo = perClientAgentSlug(agent.key);
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
                  <p className="truncate text-base font-medium">{agent.name}</p>
                  <p className="mt-0.5 truncate font-mono text-[10px] text-muted-2">
                    {agent.entrySkillDir}
                  </p>
                </div>
                <div className="flex shrink-0 flex-col items-end gap-1">
                  {/* Intake-driven agents refuse a run whose client has not filled
                      in their data page — and that gate could only be discovered
                      by writing the whole brief and reading the refusal. The
                      readiness itself depends on the client picked inside the
                      dialog, so the hub names the gate rather than pretending to
                      resolve it. */}
                  {intakeDrivenLabel(agent.key) && (
                    <Badge tone="neutral">
                      Needs {intakeDrivenLabel(agent.key)}
                    </Badge>
                  )}
                  {/* F35: the binding, stated. An instance's entry skill is
                      baked under one client's lab folder, so this is a property
                      of the agent, not of whoever is looking at it. */}
                  {boundTo && <Badge tone="neutral">{boundTo} only</Badge>}
                  {/* No client blurb ⇒ the client's card is still falling back to
                      the lab manifest below. Flagged here, fixed in the editor. */}
                  {!agent.clientBlurb?.trim() && <Badge tone="warning">No client blurb</Badge>}
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
                    // F38. No eligible client ⇒ every pair this dialog could
                    // build is one the server refuses, so the refusal is stated
                    // here instead of after the brief is written.
                    disabled={!agent.enabled || !serviceConfigured || eligible.length === 0}
                    title={
                      !serviceConfigured
                        ? "Agent service is not configured"
                        : !agent.enabled
                          ? "Enable this agent first"
                          : eligible.length === 0
                            ? boundTo
                              ? `This agent runs only for the "${boundTo}" workspace, and no client you can see has that lab repo slug.`
                              : "No client is available to run this agent for."
                            : undefined
                    }
                    onClick={() => setRunAgent(agent)}
                  >
                    <Icon name="Play" className="h-3.5 w-3.5" /> Run
                  </Button>
                </div>
              </div>
            </div>
            );
          })}
        </div>
      )}

      {runAgent && (
        <RunCustomAgentModal
          agent={runAgent}
          // Only the clients this agent can draft for reach the picker, so a
          // staff member cannot assemble a pair the submit core refuses.
          clients={clients.filter((c) =>
            agentKeyMatchesClientSlug(runAgent.key, c.agentsRepoSlug),
          )}
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
  creditBlockReasons,
  agentSetup,
  viewer,
}: {
  clientId: string;
  agents: RunnableAgentSummary[];
  runs: CustomAgentRunRow[];
  schedules?: ClientAgentScheduleRow[];
  contextItems: ContextItem[];
  viewerIsClient: boolean;
  /** Spendable credits right now (balance clipped by caps) — client viewers only. */
  availableCredits?: number;
  /**
   * Per agent id: which limit clips `availableCredits` at THAT agent's price,
   * phrased for the client and resolved server-side from the denial code (never
   * a keyword guess at a message). Present only for agents a charge would block
   * — the binding limit depends on the cost, so it cannot be one shared line.
   */
  creditBlockReasons?: Record<string, string>;
  /** Prefills the support form offered when a schedule is stuck on a refusal. */
  viewer?: { name: string; email: string };
  /**
   * Intake readiness per agent id, resolved server-side with the same call the
   * submit core makes. Agents without an intake gate are simply absent.
   */
  agentSetup?: Record<string, AgentSetupState>;
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
  const scheduleIntake = scheduleAgent ? intakeFor(agentSetup?.[scheduleAgent.id]) : null;
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
        {/* Clients already read this page's own header, which says the same
            thing in slightly different words. Only staff get a section heading
            here — their page header describes the whole page, not this section.
            The credits badge stays either way; it is the row's only unique
            content. */}
        {viewerIsClient ? (
          <span />
        ) : (
          <div>
            <h2 className="text-xl text-foreground">Custom agents</h2>
            <p className="mt-0.5 text-sm text-muted">
              Prompt-driven agents from the custom library, run against this client.
            </p>
          </div>
        )}
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
            const agentRuns = runs.filter((run) => run.agentName === agent.name);
            const reviewRuns = agentRuns.filter(
              (run) => run.status === "review" && run.assetCount > 0,
            );
            const readyAssetCount = reviewRuns.reduce((total, run) => total + run.assetCount, 0);
            // `runs` arrives newest-first (the page sorts by createdAt desc).
            const lastRun = agentRuns[0];
            const setup = agentSetup?.[agent.id] ?? null;
            // Readiness is computed once, next to the "Setup needed" chip, and
            // gates the run button with it: the submit core refuses these runs
            // server-side, so an enabled Run beside a blocked chip can only
            // spend credits on a run that cannot succeed or fail unhelpfully.
            const blockedSetup = setup && !setup.ready ? setup : null;
            // A refused schedule is never "Live" — the badge and the status line
            // both switch to the stored refusal until a fire succeeds. A paused
            // schedule reports paused: the person who paused it chose that, and
            // a stale refusal from before the pause is not the current state.
            // Already redacted for client viewers on the server (toScheduleRows).
            const refusal =
              schedule?.status === "active" ? schedule.lastError?.trim() || null : null;
            const refusalIsSetup =
              refusal !== null &&
              (refusal.startsWith(X_SETUP_REQUIRED_PREFIX) ||
                refusal.startsWith(LINKEDIN_SETUP_REQUIRED_PREFIX));
            const reviewHref = viewerIsClient
              ? "/tasks"
              : reviewRuns[0]?.href ?? `/clients/${clientId}/assets`;
            const intake = intakeFor(setup);
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
                      {refusal ? (
                        <Badge tone="warning">Needs attention</Badge>
                      ) : schedule?.status === "active" ? (
                        <Badge tone="success">
                          <span className="h-1.5 w-1.5 rounded-full bg-success animate-pulse-neon" aria-hidden="true" />
                          Live
                        </Badge>
                      ) : null}
                    </div>
                    <AgentBlurb text={agentBlurb(agent)} className="mt-0.5" />
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
                  {/* Two affordances, never both at once. Missing data is a
                      CALL TO ACTION and links to the agent's own data page
                      (CD-E1) — the one place that form lives. Data already on
                      file is an EDIT affordance and opens the dialog's inline
                      pane, so a staff member correcting one field does not lose
                      the run they were setting up. */}
                  {blockedSetup ? (
                    <a
                      href={blockedSetup.href}
                      className="rounded-full focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-warning/40"
                      title={`Open ${blockedSetup.label} to finish setup`}
                    >
                      <Badge tone="warning">Setup needed</Badge>
                    </a>
                  ) : intake && intakeComplete(intake) ? (
                    <AgentDataButton
                      kind={intake.kind}
                      ready
                      onOpen={() => openRun(agent, true)}
                    />
                  ) : null}
                </div>
                {/* The one slot on the card that carries live state. Precedence,
                    highest first: a stored refusal (the schedule fired and was
                    turned away) → setup still missing → the schedule's own next
                    fire → drafts waiting → last run → never run. The chip above
                    already links to setup, so no tier here adds a second one. */}
                <div className="mt-3 rounded-md border border-border bg-surface-2/70 px-3 py-2">
                  {schedule && (
                    <p className="text-xs text-foreground">
                      {schedule.postsPerWeek} run{schedule.postsPerWeek === 1 ? "" : "s"}/week
                      {" · "}
                      {schedule.outputsPerRun} output{schedule.outputsPerRun === 1 ? "" : "s"} each
                    </p>
                  )}
                  {refusal ? (
                    <>
                      <p className="mt-0.5 text-[11px] text-warning">{refusal}</p>
                      {refusalIsSetup && setup ? (
                        <a
                          href={setup.href}
                          className="mt-1 inline-flex items-center gap-1 text-[11px] text-neon hover:underline"
                        >
                          Open {setup.label}
                          <Icon name="ArrowRight" className="h-3 w-3" />
                        </a>
                      ) : viewer ? (
                        <div className="-mx-3 mt-0.5">
                          <ContactUsButton variant="row" userName={viewer.name} userEmail={viewer.email} />
                        </div>
                      ) : null}
                      {schedule?.lastErrorAt ? (
                        <p className="mt-0.5 text-[10px] text-muted-2">
                          Last tried {relativeTime(schedule.lastErrorAt)}
                        </p>
                      ) : null}
                    </>
                  ) : blockedSetup ? (
                    <p className={cn("text-[11px] text-warning", !schedule && "text-xs")}>
                      Not running yet — your {blockedSetup.label} is still empty.
                    </p>
                  ) : schedule ? (
                    <p className="mt-0.5 text-[11px] text-muted-2">
                      {schedule.status === "active"
                        ? `Working toward ${formatDate(schedule.nextRunAt)}`
                        : "Schedule paused"}
                    </p>
                  ) : readyAssetCount > 0 ? (
                    <Link href={reviewHref} className="text-xs text-warning hover:underline">
                      {readyAssetCount} draft{readyAssetCount === 1 ? "" : "s"} waiting for review
                    </Link>
                  ) : lastRun ? (
                    <p className="text-xs text-muted-2">Last run {relativeTime(lastRun.createdAt)}</p>
                  ) : (
                    <p className="text-xs text-muted-2">No runs yet.</p>
                  )}
                </div>
                <div className="mt-auto flex flex-wrap items-center justify-between gap-2 pt-4">
                  {/* Per RUN — that is what CustomAgent.creditCost prices and
                      what "Run now" charges once, whatever the brief asks for.
                      Only a scheduled fire multiplies it by outputs per run,
                      and the schedule dialog does that arithmetic itself. */}
                  <p className="text-xs text-muted-2">{cost} credits per run</p>
                  <div className="flex gap-1.5">
                    <Button
                      size="sm"
                      variant="ghost"
                      // F131: a control the server would refuse is never left
                      // enabled. Missing intake is exactly such a refusal, so
                      // the chip above is the way in, not this button.
                      disabled={short || Boolean(blockedSetup)}
                      title={
                        short
                          ? "Not enough credits. Ask your Karos team for a top-up."
                          : blockedSetup
                            ? `Add the ${blockedSetup.label} first — the agent drafts from it.`
                            : undefined
                      }
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
                {/* Why "Run now" is off, on the card itself. The Button primitive
                    sets disabled:pointer-events-none, so a `title` on a disabled
                    button can never be shown — the reason has to be painted.
                    Both reasons render: they block for different lengths of time
                    and are fixed by different people. */}
                {(blockedSetup || short) && (
                  <div className="mt-2 space-y-1 border-t border-border/60 pt-2">
                    {blockedSetup && (
                      <p className="text-[11px] text-warning">
                        Run now needs your {blockedSetup.label} — this agent drafts from it.
                      </p>
                    )}
                    {short && (
                      <p className="text-[11px] text-warning">
                        {creditBlockReasons?.[agent.id] ?? "Not enough credits."}
                      </p>
                    )}
                    {short && viewer && (
                      <div className="-mx-3">
                        <ContactUsButton variant="row" userName={viewer.name} userEmail={viewer.email} />
                      </div>
                    )}
                  </div>
                )}
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
                    <AgentIdentity identity={run.label} icon="Bot" size="sm" />
                  )}
                  <div className="min-w-0 flex-1">
                    {/* The resolved identity, never the stored name — see
                        CustomAgentRunRow.label (F147). */}
                    <p className="truncate text-sm">{run.label}</p>
                    {/* What the run produced — never what somebody typed to start
                        it. `prompt` is present only for staff viewers; the page
                        leaves it out of the client payload entirely. */}
                    <p className="truncate text-xs text-muted-2">
                      {relativeTime(run.createdAt)}
                      {run.assetCount > 0
                        ? ` · ${run.assetCount} draft${run.assetCount === 1 ? "" : "s"}`
                        : ""}
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
              // Client rows carry no link, so an in-flight run had nowhere to go
              // and watch: the three-step strip comes to the row instead. Ten to
              // twenty minutes on a frozen "Queued" reads as a stuck run.
              const inFlight = run.status === "queued" || run.status === "running";
              return (
                <div key={run.id}>
                  {run.href ? (
                    <Link href={run.href} className={cn(rowClass, "transition-colors hover:bg-surface-2")}>
                      {row}
                      <Icon name="ChevronRight" className="h-4 w-4 shrink-0 text-muted-2" />
                    </Link>
                  ) : (
                    <div className={rowClass}>{row}</div>
                  )}
                  {inFlight && (
                    <div className="border-t border-border bg-surface-2/50">
                      <ManagedJobProgress
                        status={run.status}
                        className="mb-0 rounded-none border-0 bg-transparent px-4 py-2"
                      />
                      <CancelRunControl runId={run.id} />
                    </div>
                  )}
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
          {...(agentSetup?.[runAgent.id] ? { setup: agentSetup[runAgent.id] } : {})}
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

/**
 * Stop an in-flight run. The only cancel control used to live on the staff
 * run-detail page, so a client who mis-fired a twenty-five-minute billable run
 * could not stop it and could not reach the page that could. The confirm step
 * is deliberate: cancelling costs the run, and on the staff hub the row sits
 * one pixel from rows that are merely history.
 *
 * EXPORTED because CD-G1 took the client's only mount away with it (F30
 * regression). Dropping ClientCustomAgents from the client branch left this
 * control mounted on the staff hub alone, so the client-authorized action
 * behind it — cancelClientAgentJobAction, which authorizes on the JOB's own
 * clientId — had no surface. The agent DETAIL page is where a client now meets
 * their in-flight run, so that is where the control goes: one implementation,
 * one action, one confirm step, on both panels.
 */
export function CancelRunControl({
  runId,
  refunds = true,
}: {
  runId: string;
  /**
   * Whether stopping this run actually returns credits — i.e. whether the
   * viewer was charged for it. Staff and impersonated sessions never spend
   * (isBillableClientActor), so promising them a refund describes a ledger
   * entry that does not exist. Default true: the client pressing their own
   * Run button is the common case and it IS billed.
   */
  refunds?: boolean;
}) {
  const router = useRouter();
  const [pending, startTransition] = useTransition();
  const [confirming, setConfirming] = useState(false);
  const [error, setError] = useState<string | null>(null);

  function cancel() {
    setError(null);
    startTransition(async () => {
      // The action does not only RETURN errors — requireClientAccess throws
      // ("Unauthorized" / "Forbidden"), and a network failure on the server
      // action itself rejects. Unhandled, that escaped the transition and took
      // the whole route to the error boundary: a client whose session had
      // expired mid-run lost the page instead of reading one line. The row
      // already has somewhere to say so.
      try {
        const result = await cancelClientAgentJobAction(runId);
        if (result.error) {
          setError(result.error);
          setConfirming(false);
          return;
        }
        router.refresh();
      } catch (e) {
        setError(e instanceof Error ? e.message : "Couldn't stop this run.");
        setConfirming(false);
      }
    });
  }

  return (
    <div className="flex flex-wrap items-center gap-2 px-4 pb-2">
      {confirming ? (
        <>
          <span className="text-[11px] text-muted">
            {refunds ? "Stop this run? Credits for it are returned." : "Stop this run?"}
          </span>
          <Button size="sm" variant="danger" onClick={cancel} loading={pending}>
            Stop run
          </Button>
          <Button size="sm" variant="ghost" onClick={() => setConfirming(false)} disabled={pending}>
            Keep going
          </Button>
        </>
      ) : (
        <Button size="sm" variant="ghost" onClick={() => setConfirming(true)}>
          <Icon name="CircleSlash" className="h-3.5 w-3.5" /> Cancel run
        </Button>
      )}
      {error && (
        <span className="text-[11px] text-danger" role="alert">
          {error}
        </span>
      )}
    </div>
  );
}

/**
 * Exported so the live client-agent card's "Adjust pace" reuses THIS dialog
 * rather than growing a second schedule UI over the same action. One dialog,
 * one `configureClientAgentScheduleAction`, one set of clamps.
 *
 * `paceOnly` is the CLIENT face of it, and it exists for the churn rule (D3,
 * A3/A4). The staff dialog has two dials because the schedule really has two
 * dimensions: how many days the agent fires, and how many items each fire
 * produces. Shown to a client, that second dial states the batch shape outright
 * — "3 runs × 5 outputs = 15 drafts a week" tells them their week is generated
 * in lumps ahead of time, which is exactly what the week strip is careful never
 * to reveal. A client may be told the PACE (how many posts a week, which days),
 * never the batching that produces it.
 *
 * So the client form offers one number — the days it actually changes — and
 * READS the stored outputs-per-run into the weekly cost and the save payload
 * rather than pinning it: a pinned 1 both under-quoted a 3×5 schedule's price
 * and silently rewrote it on save (delta-lens bounce). The label decomposes
 * nothing: "Posts per week" when one output per fire is stored, otherwise
 * "Posting days a week". The server independently preserves stored
 * outputsPerRun and prompt for client actors (planned-run-actions).
 */
export function AgentScheduleModal({
  agent,
  clientId,
  schedule,
  availableCredits,
  paceOnly = false,
  setupNeeded,
  onClose,
}: {
  agent: RunnableAgentSummary;
  clientId: string;
  schedule?: ClientAgentScheduleRow;
  availableCredits?: number;
  /** Client viewers: pace language only, no batch dial. */
  paceOnly?: boolean;
  /** Set when this agent drafts from intake and its company page is missing. */
  setupNeeded?: { kind: IntakeKind; onOpenData: () => void };
  onClose: () => void;
}) {
  const router = useRouter();
  const [pending, startTransition] = useTransition();
  // Per-agent ceilings (F27). Clamped on the way IN as well: a stored row
  // written before the cap existed would otherwise seed a value the dropdown
  // cannot show, which renders as an empty select.
  const limits = scheduleLimitsFor(agent.key);
  const [postsPerWeek, setPostsPerWeek] = useState(
    Math.min(schedule?.postsPerWeek ?? 3, limits.maxRunsPerWeek),
  );
  // ALWAYS the stored value, in both faces of the dialog. Pinning this to 1 for
  // paceOnly (as it briefly did) was two bugs in one: a schedule stored at 3×5
  // quoted its weekly cost from 3×1 — five times under — and pressing "Save
  // pace" then wrote that 1 back, silently cutting the client's output to a
  // fifth of what they were paying for. A client adjusting pace changes which
  // DAYS the agent fires, and nothing else; the server enforces the same rule
  // rather than trusting this value (configureClientAgentScheduleAction).
  const [outputsPerRun, setOutputsPerRun] = useState(
    Math.min(schedule?.outputsPerRun ?? 1, limits.maxOutputsPerRun),
  );
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
        // The time above is a wall clock the client typed in THEIR zone; without
        // this the schedule silently anchors to the server's.
        timeZone: Intl.DateTimeFormat().resolvedOptions().timeZone,
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
      title={paceOnly ? `${agent.name} pace` : `Keep ${agent.name} running`}
      description={
        paceOnly
          ? "How often this agent posts for you. Change it whenever you like — it takes effect from the next post."
          : "Choose the weekly production pace. New outputs are created as drafts and placed into your content workflow."
      }
      footer={
        <div className="flex items-center justify-between gap-2">
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
              // Setup missing ⇒ every fire this schedule writes would be
              // refused, so the control that writes it is not left enabled.
              disabled={insufficient || blockedBySetup}
            >
              {paceOnly
                ? schedule
                  ? "Save pace"
                  : "Start posting"
                : schedule
                  ? "Update schedule"
                  : "Start always-on agent"}
            </Button>
          </div>
        </div>
      }
    >
      <div className="space-y-4">
        <div className={cn("grid gap-3", paceOnly ? "grid-cols-1" : "grid-cols-2")}>
          <div>
            {/* Staff see RUNS (days the agent fires) beside outputs-per-fire.
                Clients see one dial. It is labelled "Posts per week" only when
                that is literally true (one output per fire); when a staff member
                has set more, the honest client-side name for the same dial is
                the number of DAYS — which the ruling allows ("the modal may name
                pace: posts per week, days") and which states no batch shape. */}
            <Label htmlFor={`schedule-posts-${agent.id}`}>
              {paceOnly
                ? outputsPerRun === 1
                  ? "Posts per week"
                  : "Posting days a week"
                : "Runs per week"}
            </Label>
            <Select
              id={`schedule-posts-${agent.id}`}
              value={postsPerWeek}
              onChange={(event) => setPostsPerWeek(Number(event.target.value))}
            >
              {countOptions(limits.maxRunsPerWeek).map((count) => (
                <option key={count} value={count}>{count}</option>
              ))}
            </Select>
          </div>
          {!paceOnly && (
            <div>
              <Label htmlFor={`schedule-outputs-${agent.id}`}>Outputs per run</Label>
              <Select
                id={`schedule-outputs-${agent.id}`}
                value={outputsPerRun}
                onChange={(event) => setOutputsPerRun(Number(event.target.value))}
              >
                {countOptions(limits.maxOutputsPerRun).map((count) => (
                  <option key={count} value={count}>{count}</option>
                ))}
              </Select>
            </div>
          )}
        </div>

        <div>
          <Label htmlFor={`schedule-time-${agent.id}`}>
            {paceOnly ? "Time of day" : "Production time"}
          </Label>
          <Input
            id={`schedule-time-${agent.id}`}
            type="time"
            value={time}
            onChange={(event) => setTime(event.target.value)}
          />
        </div>

        {/* STAFF ONLY. This is the operator's standing instruction to the agent
            — internal copy, written for the model — and it was rendering in the
            client's pace dialog as an editable textarea. That showed a client
            text never written for them AND let them rewrite the direction every
            future run receives. Clients steer their agent through feedback,
            which is written for that purpose and is capped, scoped and
            reviewable; this is not that. The server also refuses to take a
            prompt from a client actor, so hiding it is the second lock. */}
        {!paceOnly && (
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
        )}

        <div className="rounded-md border border-neon/20 bg-neon-soft/40 px-4 py-3">
          <div className="flex items-center justify-between gap-3">
            <span className="text-sm text-foreground">Estimated weekly cost</span>
            <span className="font-mono text-sm text-neon">{weeklyCost} credits</span>
          </div>
          {paceOnly ? (
            /* The weekly total above is computed from the STORED multiplier, so
               it is the real number. What it must not do is decompose: no
               "runs", no "outputs per run", no weekly draft total — each of
               those describes the batch rather than the pace. When one post per
               fire is stored there is no batch to hide and the friendlier
               sentence is also the true one. */
            <p className="mt-1 text-[11px] text-muted-2">
              {outputsPerRun === 1
                ? `${postsPerWeek} post${postsPerWeek === 1 ? "" : "s"} a week at ${costPerOutput} credits each. Credits are charged as each post is made.`
                : `${postsPerWeek} posting day${postsPerWeek === 1 ? "" : "s"} a week. Credits are charged as each post is made.`}
            </p>
          ) : (
            <>
              <p className="mt-1 text-[11px] text-muted-2">
                {postsPerWeek} run{postsPerWeek === 1 ? "" : "s"} × {outputsPerRun} output
                {outputsPerRun === 1 ? "" : "s"} × {costPerOutput} credits.
                Credits are charged when each scheduled run starts.
              </p>
              <p className="mt-1 text-[11px] text-foreground">
                {postsPerWeek * outputsPerRun} new draft
                {postsPerWeek * outputsPerRun === 1 ? "" : "s"} a week.
              </p>
            </>
          )}
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
      </div>
    </Modal>
  );
}

/* ═══════════════════════ run dialog ═══════════════════════ */

/** The brief, or the agent's own data form — the intake-driven agents own both. */
type RunPane = "run" | "data";

/**
 * Exported so the agent DETAIL page can offer the same run gesture for an
 * agent that has a live schedule but no umbrella (CD-H8). One dialog, one
 * launch profile, one charge path — a second run form for the legacy shape
 * would be a second place for the priced gesture to drift.
 */
export function RunCustomAgentModal({
  agent,
  clientId,
  clients,
  contextItems,
  viewerIsClient,
  setup,
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
  /**
   * This agent's intake readiness, resolved server-side for this exact agent.
   * Carries the data form when the page prefetched it (collected inline), and
   * always carries the href to the agent's own data page (the way out when it
   * did not).
   */
  setup?: AgentSetupState;
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
  const intake = intakeFor(setup);
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
        : error.startsWith(REDDIT_SETUP_REQUIRED_PREFIX)
          ? "reddit"
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
    // An agent whose only field is labelled "Optional" must be runnable with the
    // form left exactly as instructed — that is the run the intake-driven
    // agents are documented to support, and they draft from their stored data
    // either way. The brief joins non-empty fields only, so an untouched form
    // produced an empty prompt and a refusal naming a requirement that does not
    // exist. Fall back to the first starting point: the same text the chips
    // above insert, so the run is identical to clicking one.
    let prompt = buildCustomAgentPrompt(profile, fields);
    if (!prompt && !profile.fields.some((field) => field.required) && profile.quickStarts[0]) {
      prompt = buildCustomAgentPrompt(profile, {
        ...fields,
        [primaryField.key]: profile.quickStarts[0],
      });
    }
    if (!prompt) {
      setError("Add at least one line to the brief before starting the run.");
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
          <Icon name="CircleCheck" className="mx-auto h-8 w-8 text-success" />
          <p className="text-sm text-foreground">Run started</p>
          {/* Drafts no longer reach the client archive at all: F149 filters it
              to approved, non-future items. phase3-design §3's sentence is for
              run-FINISHED surfaces; this one fires the moment a run starts, so
              it takes the future-tense "reviews it when it lands" form —
              nobody is reviewing anything yet. */}
          <p className="text-xs text-muted">
            The agent is working. This usually takes {profile.estimate.replace("~", "")}. Your Karos team
            reviews it when it lands — finished posts appear in your Workspace once approved.
          </p>
          <Button variant="subtle" onClick={onClose}>
            Done
          </Button>
        </div>
      </Modal>
    );
  }

  // One gate for every intake-driven agent whose form this dialog does NOT
  // carry. `setup` is already this agent's own answer, so the modal never
  // re-derives readiness from the agent key. When the page DID prefetch the
  // form (`intake`), the pane below collects it in place instead — a link out
  // would throw away the run the reader was setting up (ruling 7).
  if (setup && !setup.ready && !intake) {
    return (
      <Modal open onClose={onClose} title={agent.name}>
        <div className="mt-4 space-y-3">
          <p className="text-sm text-foreground">Set up the {setup.label} first.</p>
          <p className="text-xs leading-relaxed text-muted">
            This agent drafts from the {setup.label} page: the company page, a seat per
            person, and the ongoing drops. It takes a few minutes to fill in once, and the agent
            will not run without it.
          </p>
          <div className="flex items-center gap-2 pt-1">
            <a
              href={setup.href}
              className="inline-flex h-9 items-center gap-1.5 rounded-md bg-primary px-4 text-sm font-semibold text-primary-foreground"
            >
              Set up {setup.label}
              <Icon name="ArrowRight" className="h-3.5 w-3.5" />
            </a>
            <Button variant="ghost" onClick={onClose}>
              Not now
            </Button>
          </div>
        </div>
      </Modal>
    );
  }

  const showData = Boolean(intake) && pane === "data";
  // Lead the eye on once the setup that held up a run is done; anyone who came
  // to read or edit data they already have gets the quiet version.
  const continueToRun = openedForSetup && companyOnFile(intake);

  return (
    // The blurb goes in the body, not Modal's `description`: that slot is an
    // unclamped <p>, so a long fallback manifest pushed the whole brief below
    // the fold. Same clamp + "More" as the card. It is also never
    // `agent.description` — that is the lab manifest, written for the people
    // who build agents, and this dialog is a client surface (CD-G2). The
    // estimate + Start run row is the pinned footer: on the long agent briefs
    // it used to scroll out of sight in the same box as the title.
    <Modal
      open
      onClose={onClose}
      title={showData && intake ? `${INTAKE_LABEL[intake.kind]} agent data` : agent.name}
      {...(showData
        ? {
            description: companyOnFile(intake)
              ? "This is what the agent drafts from. Change or add anything; it applies to the next run."
              : `We draft from this, so we ask for it before the first run: ${intake ? INTAKE_ASKS[intake.kind] : ""}.`,
          }
        : {})}
      className={showData ? "max-w-3xl" : "max-w-2xl"}
      // Both panes hold work a mis-click must not throw away: the intake form
      // in one, the brief in the other. Escape, the close button and the pane's
      // own dismiss stay the deliberate ways out.
      closeOnBackdrop={!intake && !briefTouched}
      scrollRef={scrollRef}
      // The data pane carries its own dismiss row; pinning "Start run" under it
      // would offer the run from the form that has to be saved first.
      {...(showData
        ? {}
        : {
            footer: (
              <div className="flex items-center justify-between gap-3">
                <p className="text-xs text-muted-2">
                  <Icon name="Clock" className="mr-1 inline h-3 w-3" />
                  {profile.estimate}. You can leave this page; the run continues.
                  {viewerIsClient && <span className="ml-1">Costs {agentRunCost(agent)} credits.</span>}
                </p>
                <Button variant="accent" onClick={submit} loading={pending}>
                  {pending ? "Starting…" : "Start run"}
                </Button>
              </div>
            ),
          })}
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
            {!intakeReady && intake && (
              <p className="text-xs text-muted">{INTAKE_FIRST_STEP[intake.kind]}</p>
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
        <AgentBlurb text={agentBlurb(agent)} />
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
            {clients.length === 1 ? (
              // F38. A per-client agent instance has exactly one client it can
              // draft for, and a dropdown of one is a question with a single
              // answer — worse, it reads as though there were a choice. The
              // fixed chip states the binding instead.
              <div
                id="ca-client"
                className="mt-1 inline-flex items-center gap-2 rounded-md border border-border bg-surface-2 px-3 py-1.5 text-xs text-foreground"
              >
                <Icon name="Building2" className="h-3.5 w-3.5 text-muted-2" />
                {clients[0].name}
                {perClientAgentSlug(agent.key) ? (
                  <span className="text-muted-2">· this agent&apos;s own client</span>
                ) : null}
              </div>
            ) : (
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
            )}
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
  const [clientBlurb, setClientBlurb] = useState(agent?.clientBlurb ?? "");
  const [icon, setIcon] = useState(agent?.icon ?? "Sparkles");
  const [color, setColor] = useState(agent?.color ?? "#A3E635");
  const [entrySkillDir, setEntrySkillDir] = useState(agent?.entrySkillDir ?? "");
  const [skillRoots, setSkillRoots] = useState((agent?.skillRoots ?? []).join("\n"));
  const [includeClientSkills, setIncludeClientSkills] = useState(agent?.includeClientSkills ?? true);
  const [instructions, setInstructions] = useState(agent?.instructions ?? "");
  const [creditCost, setCreditCost] = useState(agent?.creditCost != null ? String(agent.creditCost) : "");
  const [launchCreditCost, setLaunchCreditCost] = useState(
    agent?.launchCreditCost != null ? String(agent.launchCreditCost) : "",
  );
  const [enabled, setEnabled] = useState(agent?.enabled ?? true);

  function save() {
    setError(null);
    const input = {
      name,
      key: key || name.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, ""),
      description,
      clientBlurb,
      icon,
      color,
      entrySkillDir,
      skillRoots: skillRoots.split("\n").map((s) => s.trim()).filter(Boolean),
      includeClientSkills,
      instructions,
      creditCost: creditCost.trim() === "" ? null : Number(creditCost),
      launchCreditCost: launchCreditCost.trim() === "" ? null : Number(launchCreditCost),
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
      footer={
        <div className="flex items-center justify-between gap-3">
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
      }
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
          <Label htmlFor="ae-desc">Description (internal)</Label>
          <Textarea id="ae-desc" rows={2} value={description} onChange={(e) => setDescription(e.target.value)} />
          <p className="mt-1 text-xs text-muted-2">
            The lab manifest blurb. Staff surfaces only — clients never see this.
          </p>
        </div>
        <div>
          <Label htmlFor="ae-blurb">Client blurb</Label>
          <Textarea
            id="ae-blurb"
            rows={2}
            maxLength={300}
            value={clientBlurb}
            onChange={(e) => setClientBlurb(e.target.value)}
            placeholder="Drafts a week of on-brand posts for your team to review and publish."
          />
          <p className="mt-1 text-xs text-muted-2">
            What the client reads on the agent card and in the run dialog: 1–2 sentences, sentence
            case, no product codes. Leave empty and the card falls back to the internal description.
          </p>
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
            <p className="mt-1 text-xs text-muted-2">
              What this agent charges a client per run, on its card and in the run dialog. Left
              empty every agent prices the same, and a video edit costs what a single post does.
            </p>
          </div>
        </div>
        {/* §6.3. Until this is set the client's self-serve Launch button stays
            disabled with a visible "pricing is being finalized" reason — gated
            rather than provisional, because billing an invented number that
            later changes is the F130 placeholder-pricing failure at the most
            expensive SKU. Staff launches stay free and ARE the measurement runs;
            the economics card on the client's agents page surfaces the measured
            ratio and a suggested price to type in here. */}
        <div className="sm:max-w-xs">
          <Label htmlFor="ae-launch-cost">Credits for setup (one time)</Label>
          <Input
            id="ae-launch-cost"
            type="number"
            min={0}
            value={launchCreditCost}
            onChange={(e) => setLaunchCreditCost(e.target.value)}
            placeholder="not priced yet"
          />
          <p className="mt-1 text-xs text-muted-2">
            The one-off setup run that researches the brand and designs the template set. Must be
            higher than the per-run price. Left empty, clients cannot launch this agent themselves
            and staff run the setup for them.
          </p>
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
            <Icon name="TriangleAlert" className="mr-1 inline h-3.5 w-3.5 text-warning" />
            The repo catalog marks this skill blocked. Review before enabling.
          </p>
        )}
        {error && <p className="text-xs text-danger">{error}</p>}
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
            <Icon name="LoaderCircle" className="mr-2 inline h-4 w-4 animate-spin" />
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
