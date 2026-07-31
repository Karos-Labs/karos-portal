"use server";

import { revalidatePath } from "next/cache";
import {
  createCustomAgent,
  deleteCustomAgent,
  getClient,
  getCustomAgent,
  getCustomAgentByKey,
  listCustomAgents,
  removeCustomAgentFromClients,
  updateClient,
  updateCustomAgent,
} from "@/lib/data";
import {
  containsLabJargon,
  defaultInstructionsFor,
  fetchSkillFrontmatter,
  isCustomAgentImportConfigured,
  listCustomAgentImportCandidates,
  type CustomAgentImportCandidate,
} from "@/lib/agent-service/custom-agent-import";
import { submitCustomAgentJob } from "@/lib/jobs/submit-custom";
import { clientAgentRunRefusal } from "@/lib/client-agent-gate";
import { clientSafeRunError } from "@/lib/custom-agent-launch";
import { CREDIT_COSTS, isBillableClientActor } from "@/lib/credits";
import { requireAdmin, requireClientAccess, requireStaff } from "./_shared";

/* ── limits (mirror agent-service/src/schemas/task-types/custom.json) ── */
const MAX_INSTRUCTIONS_CHARS = 12_000;
const MAX_KEY_CHARS = 120; // brief agent_key
const MAX_NAME_CHARS = 200; // brief label
const MAX_SKILL_DIR_CHARS = 300;
const MAX_CLIENT_BLURB_CHARS = 300; // 1–2 sentences — it is a card line, not a spec
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
  /** Internal lab blurb — staff surfaces only. */
  description: string;
  /** Client-facing 1–2 sentences. Empty/null clears it. */
  clientBlurb?: string | null;
  icon: string;
  color: string;
  entrySkillDir: string;
  skillRoots?: string[];
  includeClientSkills?: boolean;
  instructions: string;
  creditCost?: number | null;
  /**
   * One-time price of this agent's SETUP run (§6.3). Null ⇒ the client's
   * self-serve Launch button stays disabled with a visible "pricing is being
   * finalized" reason — deliberately gated rather than provisional, because
   * billing an invented number that later changes is the F130 placeholder-
   * pricing failure re-created at the most expensive SKU.
   */
  launchCreditCost?: number | null;
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
  if (input.launchCreditCost != null) {
    if (!Number.isInteger(input.launchCreditCost) || input.launchCreditCost <= 0) {
      return "Launch price must be a whole number greater than 0 (empty = not priced yet).";
    }
    // Priced ABOVE a run, per the Q1 ruling: a setup run researches the brand
    // and designs the whole template set, so a launch that costs the same as
    // (or less than) one post is a mis-set price, not a discount. Compared
    // against the effective run price so leaving creditCost empty still guards.
    const runCost = input.creditCost ?? CREDIT_COSTS.customAgentRun;
    if (input.launchCreditCost <= runCost) {
      return `Launch price must be higher than the ${runCost}-credit run price — setup does much more than one post.`;
    }
  }
  const blurb = (input.clientBlurb ?? "").trim();
  if (blurb.length > MAX_CLIENT_BLURB_CHARS) {
    return `Client blurb is too long (max ${MAX_CLIENT_BLURB_CHARS} characters — 1 to 2 sentences).`;
  }
  if (blurb && containsLabJargon(blurb)) {
    return "Client blurb reads as lab notes (product code, sub-skill, tonemap, FORGE, or Path X). Rewrite it in the client's language.";
  }
  return null;
}

/** Normalizes the editable blurb to what the document should store. */
function normalizeClientBlurb(raw: string | null | undefined): string | null {
  const blurb = (raw ?? "").trim();
  return blurb ? blurb.slice(0, MAX_CLIENT_BLURB_CHARS) : null;
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
    clientBlurb: normalizeClientBlurb(input.clientBlurb),
    icon: input.icon || "Sparkles",
    color: input.color || "#A3E635",
    entrySkillDir: normalizeSkillDir(input.entrySkillDir),
    skillRoots: (input.skillRoots ?? []).map(normalizeSkillDir).filter(Boolean),
    includeClientSkills: input.includeClientSkills !== false,
    instructions: input.instructions.trim(),
    creditCost: input.creditCost ?? null,
    launchCreditCost: input.launchCreditCost ?? null,
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
    clientBlurb: normalizeClientBlurb(input.clientBlurb),
    icon: input.icon || agent.icon,
    color: input.color || agent.color,
    entrySkillDir: normalizeSkillDir(input.entrySkillDir),
    skillRoots: (input.skillRoots ?? []).map(normalizeSkillDir).filter(Boolean),
    includeClientSkills: input.includeClientSkills !== false,
    instructions: input.instructions.trim(),
    creditCost: input.creditCost ?? null,
    launchCreditCost: input.launchCreditCost ?? null,
    enabled: input.enabled !== false,
    updatedAt: Date.now(),
  });
  revalidatePath("/agents");
  return {};
}

/**
 * Admin-only Live/Paused toggle for the Agents page — a fast one-click flip
 * that doesn't require opening the full editor. Pausing an agent blocks new
 * client runs immediately (submitCustomAgentJob already refuses a disabled
 * agent) and turns its card into "Coming Soon" on every client roster that
 * had it granted.
 */
export async function setCustomAgentEnabledAction(
  id: string,
  enabled: boolean,
): Promise<{ error?: string }> {
  await requireAdmin();
  const agent = await getCustomAgent(id);
  if (!agent) return { error: "Agent not found." };
  await updateCustomAgent(id, { enabled, updatedAt: Date.now() });
  revalidatePath("/agents");
  revalidatePath("/clients");
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
): Promise<{ imported?: number; skipped?: number; flagged?: number; error?: string }> {
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
  let flagged = 0;
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
    const description = (frontmatter.description || candidate.description).slice(0, 600);
    // A manifest blurb is NEVER promoted to the client-facing one, however clean
    // it looks. LAB_JARGON_RE is allow-by-default — five patterns cannot decide
    // whether prose was written for a client, and the strings this finding was
    // raised over ("parameterized clone of the proven reference engine",
    // "pixel-verifiable and gated") sail through it. Promoting on a clean scan
    // would also clear the "No client blurb" badge, so nobody would ever be
    // prompted to rewrite them. Every import lands flagged; an admin writes the
    // blurb in the editor, where the jargon guard does apply to what they type.
    flagged++;
    await createCustomAgent({
      key: candidate.key,
      name: candidate.name.slice(0, MAX_NAME_CHARS),
      description,
      clientBlurb: null,
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
  return { imported, skipped, flagged };
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
 * Fires a custom agent for a client. Auth (session + allowlist for CLIENT_USER)
 * is enforced here; the submit/charge/refund flow lives in the shared
 * `submitCustomAgentJob` core so the scheduled-run cron runs the identical path.
 */
export async function runCustomAgentAction(input: {
  agentId: string;
  clientId: string;
  prompt: string;
  contextItemIds?: string[];
}): Promise<{ jobId?: string; error?: string }> {
  const user = await requireClientAccess(input.clientId);
  // §2 guard rail: an agent owned by a client-agent umbrella is not the
  // client's to run until that umbrella is live. Their surface for it is the
  // launch card, and a run fired here would charge for an agent that has no
  // confirmed template set to produce from. Staff are unaffected — they are
  // the ones who get it live.
  const blocked = await clientAgentRunRefusal({
    user,
    clientId: input.clientId,
    customAgentId: input.agentId,
  });
  if (blocked) return { error: blocked };
  // B4 / §6.2a. This is the OTHER client-reachable, billable run — the generic
  // run dialog — and it stamped no run type, so every charge it made landed in
  // the undifferentiated "Other usage" bucket that the per-agent breakdown
  // exists to eliminate. It is a run the client started by hand, which is
  // exactly what "manual" means; both the Job type and creditBucketFor already
  // understand it.
  const result = await submitCustomAgentJob(user, { ...input, runType: "manual" });
  if (result.jobId && !result.error) {
    revalidatePath("/jobs");
    revalidatePath(`/clients/${input.clientId}`);
    revalidatePath(`/clients/${input.clientId}/agents`);
    return result;
  }
  // A real client's run dialog must not receive the submit core's internal
  // strings (service URLs, env var names). Sanitize only for billable client
  // actors — staff, and admins in "View as Client", keep the raw message.
  if (result.error && isBillableClientActor(user)) {
    return { error: clientSafeRunError(result.error) };
  }
  return result;
}

/**
 * Staff-only "Test Run" — the Control Room's dry-run equivalent. The
 * agent-service has no dry-run parameter, so this fires for real: same cost,
 * same generation. What changes is the OUTPUT's fate afterward — stamping
 * `runType: "test"` tells the webhook to flag the resulting draft `testRun`
 * (mirroring the existing `launchDeliverable` exclusion), which keeps it off
 * the calendar/chain-reflow and every client-facing surface, and gives it its
 * own economics bucket instead of biasing "manual"/"untyped" (credit-reporting.ts).
 */
export async function runCustomAgentTestAction(input: {
  agentId: string;
  clientId: string;
  prompt: string;
}): Promise<{ jobId?: string; error?: string }> {
  const user = await requireStaff();
  const result = await submitCustomAgentJob(user, { ...input, runType: "test" });
  if (result.jobId && !result.error) {
    revalidatePath(`/clients/${input.clientId}/agents`);
    revalidatePath("/jobs");
  }
  return result;
}
