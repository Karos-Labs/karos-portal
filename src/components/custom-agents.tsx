"use client";

import { useEffect, useMemo, useState, useTransition } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { Badge, Button, Input, Label, Select, Textarea } from "@/components/ui";
import { Icon } from "@/components/icon";
import { AgentIdentity, AgentPlatformBadges } from "@/components/agent-identity";
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
import { CREDIT_COSTS } from "@/lib/credits";
import type { ContextItem, CustomAgent, JobStatus } from "@/lib/types";
import { cn, relativeTime } from "@/lib/utils";

/* ═══════════════════════ shared bits ═══════════════════════ */

/**
 * The slice of a CustomAgent that may be serialized to client-user browsers.
 * Deliberately excludes instructions (the system prompt), skill paths, and
 * repo provenance — pages map full docs down to this before passing them.
 */
export type RunnableAgentSummary = Pick<CustomAgent, "id" | "key" | "name" | "description" | "icon" | "color"> & {
  creditCost?: number | null;
};

type AgentLaunchConfig = {
  label: string;
  helper: string;
  placeholder: string;
  quickStarts: string[];
  attachmentLabel?: string;
  attachmentHint?: string;
};

/**
 * The agent service accepts one natural-language brief, but that does not mean
 * every agent should make the user invent its own workflow. Known agents get
 * prompts that describe their actual job; custom/imported agents retain a
 * useful outcome-focused fallback based on their own name.
 */
function launchConfigFor(agent: Pick<RunnableAgentSummary, "key" | "name">): AgentLaunchConfig {
  const identity = `${agent.key} ${agent.name}`.toLowerCase();

  if (identity.includes("branded-short") || identity.includes("branded shorts")) {
    return {
      label: "What should this short communicate?",
      helper: "Tell the editor the intended message, audience, and any moment that must make the cut.",
      placeholder: "Turn the attached interview into a 30-second short about the new product launch.",
      quickStarts: [
        "Turn the attached talking-head video into a concise product-launch short.",
        "Create a founder-led short that explains our strongest customer outcome.",
        "Cut a social teaser from the attached video and keep the speaker's key point intact.",
      ],
      attachmentLabel: "Source video",
      attachmentHint: "Attach the talking-head or source video the editor should use.",
    };
  }

  if (identity.includes("instagram")) {
    return {
      label: "What should we create for Instagram?",
      helper: "Pick the goal and topic. The agent applies the brand voice and prepares the post for review.",
      placeholder: "Create a carousel that explains how our new offer solves [customer problem].",
      quickStarts: [
        "Create a carousel that introduces our new offer.",
        "Create a founder story post that builds trust with our target audience.",
        "Create a post around a customer pain point we solve.",
      ],
    };
  }

  if (identity.includes("linkedin")) {
    return {
      label: "What should we publish on LinkedIn?",
      helper: "Choose the angle and audience. The agent will turn it into a credible, on-brand LinkedIn draft.",
      placeholder: "Write a thought-leadership post about what we learned while solving [problem].",
      quickStarts: [
        "Write a thought-leadership post based on a lesson from our work.",
        "Turn a recent company milestone into a LinkedIn update.",
        "Draft a founder post that explains our point of view on [topic].",
      ],
    };
  }

  if (identity === "x" || /(^|[\s_-])x([\s_-]|$)|twitter/.test(identity)) {
    return {
      label: "What should the X agent draft?",
      helper:
        "Draft-only: everything lands in review, nothing posts. It reads the client's X page (company form, seats, drops) automatically — fill that in first for on-voice output.",
      placeholder: "Run a full draft batch across the avenues for the company page and every seat.",
      quickStarts: [
        "Run a full draft batch across the avenues for the company page and every seat.",
        "Draft this week's posts for the company page.",
        "Draft this week's posts for [person]'s seat.",
      ],
    };
  }

  return {
    label: `What should ${agent.name} create?`,
    helper: "Describe the outcome, audience, and any key details. The agent already knows its playbook and your brand.",
    placeholder: "Describe the outcome you want, who it is for, and any must-have details.",
    quickStarts: [
      `Create a first draft for our current priority.`,
      `Develop an idea for our target audience around [topic].`,
      `Improve an existing asset using the attached context.`,
    ],
  };
}

/** One run-history row, pre-filtered and stripped server-side. */
export interface CustomAgentRunRow {
  id: string;
  agentName: string;
  status: JobStatus;
  createdAt: number;
  prompt?: string;
  /** Link target (staff viewers get /jobs/<id>); absent for client viewers. */
  href?: string;
}

function agentRunCost(agent: Pick<RunnableAgentSummary, "creditCost">): number {
  return agent.creditCost ?? CREDIT_COSTS.customAgentRun;
}

function AgentChip({ agent, className }: { agent: Pick<RunnableAgentSummary, "key" | "name" | "icon" | "color">; className?: string }) {
  return (
    <AgentIdentity
      identity={`${agent.key} ${agent.name}`}
      icon={agent.icon}
      color={agent.color}
      className={className}
    />
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
              <span className="absolute inset-x-0 top-0 h-0.5 opacity-45 transition-opacity group-hover:opacity-80" style={{ background: agent.color }} aria-hidden="true" />
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
  contextItems,
  viewerIsClient,
  availableCredits,
}: {
  clientId: string;
  agents: RunnableAgentSummary[];
  runs: CustomAgentRunRow[];
  contextItems: ContextItem[];
  viewerIsClient: boolean;
  /** Spendable credits right now (balance clipped by caps) — client viewers only. */
  availableCredits?: number;
}) {
  const [runAgent, setRunAgent] = useState<RunnableAgentSummary | null>(null);

  const agentByName = useMemo(() => new Map(agents.map((a) => [a.name, a])), [agents]);

  if (agents.length === 0 && runs.length === 0) return null;

  return (
    <section className="mt-10">
      <div className="mb-4 flex flex-wrap items-center justify-between gap-2">
        <div>
          <h2 className="text-xl text-foreground">{viewerIsClient ? "Your AI agents" : "Custom agents"}</h2>
          <p className="mt-0.5 text-sm text-muted">
            {viewerIsClient
              ? "Fire an agent with a plain-language request. Deliverables land in your Library after review."
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
            return (
              <div
                key={agent.id}
                className="card-grad group relative flex min-h-52 flex-col overflow-hidden rounded-[var(--radius)] border border-border p-5 transition-all duration-200 hover:-translate-y-0.5 hover:border-border-strong hover:shadow-lg"
              >
                <span className="absolute inset-x-0 top-0 h-0.5 opacity-45 transition-opacity group-hover:opacity-80" style={{ background: agent.color }} aria-hidden="true" />
                <div className="flex items-start gap-3">
                  <AgentChip agent={agent} />
                  <div className="min-w-0 flex-1">
                    <p className="mb-1 font-mono text-[9px] uppercase tracking-[0.16em] text-muted-2">AI agent</p>
                    <p className="truncate text-base font-medium">{agent.name}</p>
                    <p className="mt-0.5 line-clamp-2 text-xs text-muted">{agent.description}</p>
                  </div>
                </div>
                <div className="mt-3">
                  <AgentPlatformBadges identity={`${agent.key} ${agent.name}`} />
                </div>
                <div className="mt-auto flex items-center justify-between gap-2 pt-4">
                  <p className="text-xs text-muted-2">
                    {viewerIsClient ? `${cost} credits per run` : `${cost} credits when client-run`}
                  </p>
                  <Button
                    size="sm"
                    variant="subtle"
                    disabled={short}
                    title={short ? "Not enough credits. Ask your Karos team for a top-up." : undefined}
                    onClick={() => setRunAgent(agent)}
                  >
                    <Icon name="Play" className="h-3.5 w-3.5" /> Run
                  </Button>
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
                      color={agent.color}
                      size="sm"
                    />
                  ) : (
                    <AgentIdentity identity={run.agentName} icon="Bot" color="#88888f" size="sm" />
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
          onClose={() => setRunAgent(null)}
        />
      )}
    </section>
  );
}

/* ═══════════════════════ run dialog ═══════════════════════ */

function RunCustomAgentModal({
  agent,
  clientId,
  clients,
  contextItems,
  viewerIsClient,
  onClose,
}: {
  agent: RunnableAgentSummary;
  /** Fixed client (client-page flow) … */
  clientId?: string;
  /** … or a picker (staff hub flow). */
  clients?: Array<{ id: string; name: string }>;
  contextItems: ContextItem[];
  viewerIsClient: boolean;
  onClose: () => void;
}) {
  const router = useRouter();
  const [pending, startTransition] = useTransition();
  const [selectedClientId, setSelectedClientId] = useState(clientId ?? clients?.[0]?.id ?? "");
  const [prompt, setPrompt] = useState("");
  const [selectedFiles, setSelectedFiles] = useState<string[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [started, setStarted] = useState(false);
  const launcher = launchConfigFor(agent);

  function submit() {
    setError(null);
    if (!selectedClientId) {
      setError("Pick a client. Agents always run against a client's context.");
      return;
    }
    if (!prompt.trim()) {
      setError("Describe what you want the agent to produce.");
      return;
    }
    startTransition(async () => {
      const result = await runCustomAgentAction({
        agentId: agent.id,
        clientId: selectedClientId,
        prompt: prompt.trim(),
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
            The agent is working. This usually takes 10–35 minutes. Deliverables appear in your
            Library once your Karos team approves them.
          </p>
          <Button variant="subtle" onClick={onClose}>
            Done
          </Button>
        </div>
      </Modal>
    );
  }

  return (
    <Modal open onClose={onClose} title={agent.name} description={agent.description}>
      <div className="mt-4 space-y-4">
        {!clientId && clients && (
          <div>
            <Label htmlFor="ca-client">Client</Label>
            <Select
              id="ca-client"
              value={selectedClientId}
              onChange={(e) => setSelectedClientId(e.target.value)}
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
          <Label htmlFor="ca-prompt">{launcher.label}</Label>
          <div className="mt-2 flex flex-wrap gap-1.5">
            {launcher.quickStarts.map((quickStart) => (
              <button
                key={quickStart}
                type="button"
                onClick={() => setPrompt(quickStart)}
                className={cn(
                  "rounded-full border px-2.5 py-1 text-left text-[11px] transition-colors",
                  prompt === quickStart
                    ? "border-neon/60 bg-neon/10 text-neon"
                    : "border-border bg-surface-2 text-muted hover:border-border-strong hover:text-foreground",
                )}
              >
                {quickStart}
              </button>
            ))}
          </div>
          <Textarea
            id="ca-prompt"
            rows={3}
            maxLength={4000}
            placeholder={launcher.placeholder}
            value={prompt}
            onChange={(e) => setPrompt(e.target.value)}
          />
          <p className="mt-1 text-xs text-muted-2">
            {launcher.helper}
          </p>
        </div>

        {contextItems.length > 0 && (
          <div>
            <Label>{launcher.attachmentLabel ?? "Attach reference files"}</Label>
            {launcher.attachmentHint && <p className="mb-1.5 text-xs text-muted-2">{launcher.attachmentHint}</p>}
            <div className="max-h-36 space-y-1 overflow-y-auto rounded-md border border-border p-2">
              {contextItems.map((item) => (
                <label
                  key={item.id}
                  className="flex cursor-pointer items-center gap-2 rounded px-1 py-0.5 text-xs hover:bg-surface-2"
                >
                  <input
                    type="checkbox"
                    checked={selectedFiles.includes(item.id)}
                    onChange={() =>
                      setSelectedFiles((ids) =>
                        ids.includes(item.id) ? ids.filter((x) => x !== item.id) : [...ids, item.id],
                      )
                    }
                    className="accent-neon"
                  />
                  <Icon name={item.kind === "image" ? "Image" : "FileText"} className="h-3.5 w-3.5 text-muted-2" />
                  <span className="truncate">{item.name}</span>
                  {item.note && <span className="truncate text-muted-2">· {item.note}</span>}
                </label>
              ))}
            </div>
          </div>
        )}

        {error && <p className="text-xs text-danger">{error}</p>}

        <div className="flex items-center justify-between gap-3 pt-1">
          <p className="text-xs text-muted-2">
            <Icon name="Clock" className="mr-1 inline h-3 w-3" />
            ~10–35 min. You can leave this page; the run continues.
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
            <span
              className="flex h-6 w-6 shrink-0 items-center justify-center rounded"
              style={{ background: agent.color + "1f", color: agent.color }}
            >
              <Icon name={agent.icon} className="h-3.5 w-3.5" />
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
