"use server";

import { revalidatePath } from "next/cache";
import {
  createCustomAgent,
  createJob,
  deleteCustomAgent,
  deleteJob,
  getClient,
  getContextItem,
  getCustomAgent,
  getCustomAgentByKey,
  listCustomAgents,
  removeCustomAgentFromClients,
  updateClient,
  updateCustomAgent,
  updateJob,
} from "@/lib/data";
import {
  cancelAgentServiceJob,
  isAgentServiceConfigured,
  submitAgentServiceJob,
} from "@/lib/agent-service/client";
import {
  defaultInstructionsFor,
  fetchSkillFrontmatter,
  isCustomAgentImportConfigured,
  listCustomAgentImportCandidates,
  type CustomAgentImportCandidate,
} from "@/lib/agent-service/custom-agent-import";
import type { AgentServiceContextFile } from "@/lib/agent-service/types";
import { buildXAgentContextFiles, isXAgent } from "@/lib/agent-service/x-agent-context";
import { chargeClientCredits } from "@/lib/data";
import { refundJobCharge } from "@/lib/credit-reconcile";
import { CREDIT_COSTS, CreditError, isBillableClientActor } from "@/lib/credits";
import { logActivity, requireAdmin, requireClientAccess } from "./_shared";

/* ── limits (mirror agent-service/src/schemas/task-types/custom.json) ── */
const MAX_INSTRUCTIONS_CHARS = 12_000;
const MAX_PROMPT_CHARS = 4_000;
const MAX_KEY_CHARS = 120; // brief agent_key
const MAX_NAME_CHARS = 200; // brief label
const MAX_SKILL_DIR_CHARS = 300;
const MAX_SKILL_ROOTS = 8;
const SKILL_DIR_RE = /^(?!.*\.\.)(?!.*\/\/)(products|skills|clients)\/[A-Za-z0-9._-]+(\/[A-Za-z0-9._-]+)*$/;

const GROUP_APPEARANCE: Record<string, { icon: string; color: string }> = {
  Live: { icon: "Zap", color: "#A3E635" },
  Building: { icon: "Bot", color: "#FBBF24" },
  Onboarding: { icon: "Search", color: "#38BDF8" },
  Internal: { icon: "TrendingUp", color: "#F87171" },
  Amazon: { icon: "Package", color: "#F97316" },
  Other: { icon: "Sparkles", color: "#E879F9" },
};

function normalizeSkillDir(dir: string): string {
  return dir.trim().replace(/\/SKILL\.md$/, "").replace(/\/+$/, "");
}

export interface CustomAgentInput {
  key: string;
  name: string;
  description: string;
  icon: string;
  color: string;
  entrySkillDir: string;
  skillRoots?: string[];
  includeClientSkills?: boolean;
  instructions: string;
  creditCost?: number | null;
  enabled?: boolean;
}

function validateAgentInput(input: CustomAgentInput): string | null {
  if (!input.name.trim()) return "Name is required.";
  if (input.name.trim().length > MAX_NAME_CHARS) return `Name is too long (max ${MAX_NAME_CHARS} characters).`;
  if (!input.key.trim()) return "Key is required.";
  if (input.key.trim().length > MAX_KEY_CHARS) return `Key is too long (max ${MAX_KEY_CHARS} characters).`;
  if (!input.instructions.trim()) return "Instructions are required.";
  if (input.instructions.length > MAX_INSTRUCTIONS_CHARS) {
    return `Instructions are too long (max ${MAX_INSTRUCTIONS_CHARS.toLocaleString()} characters).`;
  }
  const dir = normalizeSkillDir(input.entrySkillDir);
  if (!SKILL_DIR_RE.test(dir) || dir.length > MAX_SKILL_DIR_CHARS) {
    return "Entry skill dir must be a repo-relative path under products/, skills/, or clients/ (no traversal).";
  }
  const roots = input.skillRoots ?? [];
  if (roots.length > MAX_SKILL_ROOTS) return `At most ${MAX_SKILL_ROOTS} skill roots.`;
  for (const root of roots) {
    const normalized = normalizeSkillDir(root);
    if (!SKILL_DIR_RE.test(normalized) || normalized.length > MAX_SKILL_DIR_CHARS) {
      return `Invalid skill root: ${root}`;
    }
  }
  if (input.creditCost != null && (!Number.isInteger(input.creditCost) || input.creditCost < 0)) {
    return "Credit cost must be a whole number ≥ 0 (empty = default).";
  }
  return null;
}

/* ─────────────────────────── admin CRUD ─────────────────────────── */

export async function createCustomAgentAction(
  input: CustomAgentInput,
): Promise<{ id?: string; error?: string }> {
  const user = await requireAdmin();
  const invalid = validateAgentInput(input);
  if (invalid) return { error: invalid };
  if (await getCustomAgentByKey(input.key.trim())) {
    return { error: `An agent with key "${input.key.trim()}" already exists.` };
  }
  const now = Date.now();
  const id = await createCustomAgent({
    key: input.key.trim(),
    name: input.name.trim(),
    description: input.description.trim(),
    icon: input.icon || "Sparkles",
    color: input.color || "#A3E635",
    entrySkillDir: normalizeSkillDir(input.entrySkillDir),
    skillRoots: (input.skillRoots ?? []).map(normalizeSkillDir).filter(Boolean),
    includeClientSkills: input.includeClientSkills !== false,
    instructions: input.instructions.trim(),
    creditCost: input.creditCost ?? null,
    enabled: input.enabled !== false,
    source: null,
    createdBy: user.uid,
    createdAt: now,
    updatedAt: now,
  });
  revalidatePath("/agents");
  return { id };
}

export async function updateCustomAgentAction(
  id: string,
  input: CustomAgentInput,
): Promise<{ error?: string }> {
  await requireAdmin();
  const agent = await getCustomAgent(id);
  if (!agent) return { error: "Agent not found." };
  const invalid = validateAgentInput(input);
  if (invalid) return { error: invalid };
  if (input.key.trim() !== agent.key) {
    const existing = await getCustomAgentByKey(input.key.trim());
    if (existing && existing.id !== id) return { error: `An agent with key "${input.key.trim()}" already exists.` };
  }
  await updateCustomAgent(id, {
    key: input.key.trim(),
    name: input.name.trim(),
    description: input.description.trim(),
    icon: input.icon || agent.icon,
    color: input.color || agent.color,
    entrySkillDir: normalizeSkillDir(input.entrySkillDir),
    skillRoots: (input.skillRoots ?? []).map(normalizeSkillDir).filter(Boolean),
    includeClientSkills: input.includeClientSkills !== false,
    instructions: input.instructions.trim(),
    creditCost: input.creditCost ?? null,
    enabled: input.enabled !== false,
    updatedAt: Date.now(),
  });
  revalidatePath("/agents");
  return {};
}

export async function deleteCustomAgentAction(id: string): Promise<{ error?: string }> {
  await requireAdmin();
  await deleteCustomAgent(id);
  // Best-effort allowlist scrub; save flows also tolerate stale ids.
  try {
    await removeCustomAgentFromClients(id);
  } catch {
    // non-fatal — setClientCustomAgentsAction drops unknown ids on next save
  }
  revalidatePath("/agents");
  return {};
}

/* ─────────────────────────── import flow ────────────────────────── */

export async function listCustomAgentImportCandidatesAction(): Promise<{
  candidates?: Array<CustomAgentImportCandidate & { imported: boolean }>;
  repoSha?: string;
  error?: string;
}> {
  await requireAdmin();
  if (!isCustomAgentImportConfigured()) {
    return { error: "Set AGENTS_REPO_GITHUB_TOKEN to import agents from the karos-agents repo." };
  }
  try {
    const [{ candidates, repoSha }, existing] = await Promise.all([
      listCustomAgentImportCandidates(),
      listCustomAgents(),
    ]);
    const importedKeys = new Set(existing.map((a) => a.key));
    return {
      ...(repoSha ? { repoSha } : {}),
      candidates: candidates.map((c) => ({ ...c, imported: importedKeys.has(c.key) })),
    };
  } catch (e) {
    return { error: e instanceof Error ? e.message : "Could not scan the agents repo." };
  }
}

export async function importCustomAgentsAction(
  keys: string[],
): Promise<{ imported?: number; skipped?: number; error?: string }> {
  const user = await requireAdmin();
  if (!isCustomAgentImportConfigured()) {
    return { error: "Set AGENTS_REPO_GITHUB_TOKEN to import agents from the karos-agents repo." };
  }
  if (keys.length === 0) return { error: "Pick at least one agent to import." };

  let candidates: CustomAgentImportCandidate[];
  let repoSha: string | undefined;
  try {
    const scan = await listCustomAgentImportCandidates();
    candidates = scan.candidates;
    repoSha = scan.repoSha;
  } catch (e) {
    return { error: e instanceof Error ? e.message : "Could not scan the agents repo." };
  }
  const byKey = new Map(candidates.map((c) => [c.key, c]));

  let imported = 0;
  let skipped = 0;
  for (const key of keys) {
    const candidate = byKey.get(key);
    if (!candidate) {
      skipped++;
      continue;
    }
    // The catalog is hand-maintained — never trust a path from it further than
    // one we'd accept from the editor form.
    if (
      !SKILL_DIR_RE.test(candidate.entrySkillDir) ||
      candidate.entrySkillDir.length > MAX_SKILL_DIR_CHARS ||
      candidate.key.length > MAX_KEY_CHARS
    ) {
      skipped++;
      continue;
    }
    if (await getCustomAgentByKey(key)) {
      skipped++; // already imported — edit the existing agent instead of overwriting
      continue;
    }
    // SKILL.md frontmatter gives the richest description; the catalog is the fallback.
    const frontmatter = await fetchSkillFrontmatter(candidate.entrySkillDir);
    const appearance = GROUP_APPEARANCE[candidate.group] ?? GROUP_APPEARANCE.Other;
    const now = Date.now();
    await createCustomAgent({
      key: candidate.key,
      name: candidate.name.slice(0, MAX_NAME_CHARS),
      description: (frontmatter.description || candidate.description).slice(0, 600),
      icon: appearance.icon,
      color: appearance.color,
      entrySkillDir: candidate.entrySkillDir,
      skillRoots: [],
      includeClientSkills: true,
      instructions: defaultInstructionsFor(candidate, frontmatter.description),
      creditCost: null,
      // Blocked/unreviewed skills import disabled so nobody fires them by accident;
      // an admin flips the switch after reviewing the blocked_reason.
      enabled: candidate.status === "ready",
      source: {
        path: candidate.entrySkillDir,
        status: candidate.status,
        ...(repoSha ? { repoSha } : {}),
      },
      createdBy: user.uid,
      createdAt: now,
      updatedAt: now,
    });
    imported++;
  }
  revalidatePath("/agents");
  return { imported, skipped };
}

/* ───────────────────── per-client agent access ──────────────────── */

export async function setClientCustomAgentsAction(
  clientId: string,
  agentIds: string[],
): Promise<{ error?: string }> {
  await requireAdmin();
  const client = await getClient(clientId);
  if (!client) return { error: "Client not found." };
  // Silently drop ids that no longer exist (agent deleted since the form
  // loaded, or a stale allowlist re-saved) instead of bricking the save.
  const agents = await listCustomAgents();
  const known = new Set(agents.map((a) => a.id));
  await updateClient(clientId, { customAgentIds: agentIds.filter((id) => known.has(id)) });
  revalidatePath(`/clients/${clientId}/settings`);
  revalidatePath(`/clients/${clientId}/agents`);
  return {};
}

/* ─────────────────────────── run flow ───────────────────────────── */

/**
 * Fires a custom agent for a client: mirrors submitManagedJobAction's job-doc +
 * agent-service submit flow, with two additions — CLIENT_USER callers are
 * authorized against the client's agent allowlist, and billable client actors
 * are charged upfront (jobId-paired for the refund/reconcile contract).
 */
export async function runCustomAgentAction(input: {
  agentId: string;
  clientId: string;
  prompt: string;
  contextItemIds?: string[];
}): Promise<{ jobId?: string; error?: string }> {
  const user = await requireClientAccess(input.clientId);
  if (!isAgentServiceConfigured()) {
    return { error: "Agent service is not configured (AGENT_SERVICE_URL / AGENT_SERVICE_TOKEN)." };
  }

  const agent = await getCustomAgent(input.agentId);
  if (!agent || !agent.enabled) return { error: "Agent not found." };
  const client = await getClient(input.clientId);
  if (!client) return { error: "Client not found." };
  if (user.role === "CLIENT_USER" && !(client.customAgentIds ?? []).includes(agent.id)) {
    // Same message as missing — don't leak which agents exist beyond the allowlist.
    return { error: "Agent not found." };
  }

  const prompt = input.prompt.trim();
  if (!prompt) return { error: "Describe what you want the agent to produce." };
  if (prompt.length > MAX_PROMPT_CHARS) {
    return { error: `Prompt is too long (max ${MAX_PROMPT_CHARS.toLocaleString()} characters).` };
  }

  const appUrl = process.env.AGENT_SERVICE_CALLBACK_URL ?? process.env.NEXT_PUBLIC_APP_URL;
  if (!appUrl) {
    return { error: "AGENT_SERVICE_CALLBACK_URL (or NEXT_PUBLIC_APP_URL) must be set for webhook callbacks." };
  }

  const contextFiles: AgentServiceContextFile[] = [];
  for (const itemId of input.contextItemIds ?? []) {
    const item = await getContextItem(itemId);
    if (!item || item.clientId !== input.clientId) {
      return { error: "Context file not found for this client." };
    }
    contextFiles.push({
      name: item.name,
      url: item.url,
      content_type: item.mimeType,
      ...(item.note ? { description: item.note } : {}),
    });
  }

  // X agent (e13): attach the portal-collected intake, ongoing boxes, and
  // per-account learning logs as context files. Every other agent skips this;
  // an X run with nothing stored attaches nothing. Fail the submission rather
  // than run silently without the client's stored data.
  if (isXAgent(agent.key)) {
    try {
      contextFiles.push(...(await buildXAgentContextFiles(input.clientId)));
    } catch (e) {
      return {
        error: `Could not attach the client's X intake data: ${e instanceof Error ? e.message : "unknown error"}`,
      };
    }
  }

  const now = Date.now();
  const jobId = await createJob({
    clientId: input.clientId,
    agentId: "agent-service",
    agentName: agent.name,
    title: `${agent.name} — ${client.name}`,
    status: "queued",
    input: { agent: agent.name, prompt },
    assetIds: [],
    events: [{ at: now, level: "info", message: "Submitted to agent service" }],
    createdBy: user.uid,
    createdAt: now,
    updatedAt: now,
  });

  // Charge upfront (client actors only) with jobId pairing so the webhook's
  // failure refund and the reconcile sweeps can hand the credits back.
  const runCost = agent.creditCost ?? CREDIT_COSTS.customAgentRun;
  if (isBillableClientActor(user)) {
    try {
      await chargeClientCredits({
        clientId: input.clientId,
        amount: runCost,
        operation: "custom_agent_run",
        reason: `Agent run · ${agent.name}`.slice(0, 120),
        agentId: agent.id,
        jobId,
        actorUid: user.uid,
        actorName: user.name,
      });
    } catch (e) {
      await deleteJob(jobId); // nothing submitted yet — no orphan to keep
      if (e instanceof CreditError) return { error: e.message };
      throw e;
    }
  }

  let submittedServiceJobId: string | undefined;
  try {
    const submitted = await submitAgentServiceJob({
      task_type: "custom",
      client_id: input.clientId,
      ...(client.agentsRepoSlug ? { client_slug: client.agentsRepoSlug } : {}),
      brief: {
        agent_key: agent.key.slice(0, MAX_KEY_CHARS),
        label: agent.name.slice(0, MAX_NAME_CHARS),
        entry_skill_dir: agent.entrySkillDir,
        ...(agent.skillRoots.length > 0 ? { skill_roots: agent.skillRoots } : {}),
        include_client_skills: agent.includeClientSkills,
        instructions: agent.instructions.slice(0, MAX_INSTRUCTIONS_CHARS),
        prompt,
      },
      callback_url: `${appUrl.replace(/\/$/, "")}/api/agent-service/webhook`,
      ...(contextFiles.length > 0 ? { context_files: contextFiles } : {}),
      metadata: { platform_job_id: jobId },
    });
    submittedServiceJobId = submitted.job_id;
    await updateJob(jobId, {
      external: { serviceJobId: submitted.job_id, taskType: "custom" },
      updatedAt: Date.now(),
    });
  } catch (e) {
    // Same cleanup contract as submitManagedJobAction, plus the charge refund.
    if (submittedServiceJobId) {
      try {
        await cancelAgentServiceJob(submittedServiceJobId);
      } catch {
        // best effort — the webhook receiver's metadata fallback still matches
      }
    }
    const message = e instanceof Error ? e.message : "Agent service submission failed";
    // Refund BEFORE flipping the job to failed: the credits sweep
    // (/api/credits/reconcile) only revisits queued/running jobs, so a job
    // marked failed with a lost refund would strand the charge forever. If the
    // refund write fails, leave the job queued — the sweep fails AND refunds
    // it in one transaction (listStuckLocalJobs covers agent-service jobs
    // that never recorded a serviceJobId).
    try {
      await refundJobCharge(jobId, `Auto-refund · submission failed · ${agent.name}`.slice(0, 120));
    } catch {
      return { jobId, error: message };
    }
    await updateJob(jobId, {
      status: "failed",
      error: message,
      events: [
        { at: now, level: "info", message: "Submitted to agent service" },
        { at: Date.now(), level: "error", message },
      ],
      updatedAt: Date.now(),
    });
    return { jobId, error: message };
  }

  void logActivity({
    clientId: input.clientId,
    timestamp: Date.now(),
    type: "CAMPAIGN_CREATED",
    title: `Agent run started: ${agent.name}`,
    actor: user.name,
    actorRole: user.role === "CLIENT_USER" ? "client" : "staff",
    metadata: { jobId, taskType: "custom", agentKey: agent.key },
  });
  revalidatePath("/jobs");
  revalidatePath(`/clients/${input.clientId}`);
  revalidatePath(`/clients/${input.clientId}/agents`);
  return { jobId };
}
