"use server";

import { revalidatePath } from "next/cache";
import {
  createCustomAgent,
  deleteCustomAgent,
  getClient,
  getCustomAgent,
  getCustomAgentByKey,
  listCustomAgents,
  listPlannedScheduledRuns,
  removeCustomAgentFromClients,
  updateClient,
  updateCustomAgent,
  updatePlannedScheduledRun,
} from "@/lib/data";
import { listClientAgents, updateClientAgent } from "@/lib/data-client-agents";
import type { PlannedScheduledRun } from "@/lib/types";
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
  /** Per-step model override — see CustomAgent.stepModels. Null/empty ⇒ no override. */
  stepModels?: Record<string, string> | null;
}

const MAX_STEP_MODELS = 20;
const MAX_STEP_KEY_CHARS = 100;
const MAX_STEP_MODEL_CHARS = 100;

function validateStepModels(stepModels: Record<string, string> | null | undefined): string | null {
  if (!stepModels) return null;
  const entries = Object.entries(stepModels);
  if (entries.length > MAX_STEP_MODELS) return `At most ${MAX_STEP_MODELS} per-step model overrides.`;
  for (const [key, model] of entries) {
    if (!key.trim() || key.length > MAX_STEP_KEY_CHARS) return `Invalid step name: "${key}".`;
    if (!model.trim() || model.length > MAX_STEP_MODEL_CHARS) return `Invalid model for step "${key}".`;
  }
  return null;
}

/** Drops blank keys/values and empty-string trims; empty object becomes null (no override). */
function normalizeStepModels(
  stepModels: Record<string, string> | null | undefined,
): Record<string, string> | null {
  if (!stepModels) return null;
  const cleaned = Object.fromEntries(
    Object.entries(stepModels)
      .map(([k, v]) => [k.trim(), v.trim()] as const)
      .filter(([k, v]) => k && v),
  );
  return Object.keys(cleaned).length > 0 ? cleaned : null;
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
  const stepModelsError = validateStepModels(input.stepModels);
  if (stepModelsError) return stepModelsError;
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
    stepModels: normalizeStepModels(input.stepModels),
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
    stepModels: normalizeStepModels(input.stepModels),
    enabled: input.enabled !== false,
    updatedAt: Date.now(),
  });
  revalidatePath("/agents");
  return {};
}

/**
 * Pauses every still-`active` row in `runs` — called right after an agent is
 * disabled or unassigned, neither of which ever touched
 * `plannedScheduledRuns` before this. Left `active`, a stale row just keeps
 * failing at the cron (submitCustomAgentJob already refuses a disabled/
 * ungranted agent) while still printing as an upcoming run on the calendar.
 * Paused rather than retired: re-enabling or re-granting the agent should
 * leave a schedule staff can consciously resume, not one silently reactivated
 * or one whose pace configuration was thrown away.
 */
async function pauseActiveSchedules(runs: PlannedScheduledRun[]): Promise<void> {
  await Promise.all(
    runs
      .filter((r) => r.status === "active")
      .map((r) => updatePlannedScheduledRun(r.id, { status: "paused", updatedAt: Date.now() })),
  );
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
  if (!enabled) {
    // Cross-client — this agent's schedules aren't scoped to one client, so
    // there's no clientId filter to narrow the read by.
    const runs = await listPlannedScheduledRuns();
    await pauseActiveSchedules(runs.filter((r) => r.customAgentId === id));
  }
  revalidatePath("/agents");
  revalidatePath("/clients");
  return {};
}

export async function deleteCustomAgentAction(id: string): Promise<{ error?: string }> {
  await requireAdmin();
  // Snapshot before the delete: every umbrella/schedule lookup below keys off
  // this agent's stable `key` or this doc's id, both gone once it's deleted.
  const agent = await getCustomAgent(id);
  if (agent) {
    // Cross-client, like setCustomAgentEnabledAction's schedule pause below —
    // neither umbrellas nor schedules are scoped to one client.
    const [umbrellas, runs] = await Promise.all([listClientAgents(), listPlannedScheduledRuns()]);
    // A deleted agent can never resolve again (resolveUmbrellaForAgent reads
    // the customAgents doc first), so a bound umbrella left `live` becomes a
    // phantom owner of its chainFamily — the calendar stays claimed while
    // nothing can ever fill it. launch_failed is the state machine's existing
    // "not live, error retained for staff" bucket; reusing it beats inventing
    // a new terminal state for one cause.
    await Promise.all(
      umbrellas
        .filter((u) => u.agentKey === agent.key && u.launchState !== "launch_failed")
        .map((u) =>
          updateClientAgent(u.id, {
            launchState: "launch_failed",
            launchError: "Bound custom agent was deleted.",
          }),
        ),
    );
    await pauseActiveSchedules(runs.filter((r) => r.customAgentId === id));
  }
  await deleteCustomAgent(id);
  // Best-effort allowlist scrub; save flows also tolerate stale ids.
  try {
    await removeCustomAgentFromClients(id);
  } catch {
    // non-fatal — setClientCustomAgentsAction drops unknown ids on next save
  }
  revalidatePath("/agents");
  revalidatePath("/clients");
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
        // The candidate carries it camelCased (the scan maps the manifest's
        // `blocked_reason` in custom-agent-import.ts); the stored field keeps the
        // manifest's own spelling. Without this the UI can only say "blocked",
        // which reads as a broken build when it usually means an egress
        // constraint or an unrun pilot.
        ...(candidate.blockedReason ? { blocked_reason: candidate.blockedReason } : {}),
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
  const nextIds = agentIds.filter((id) => known.has(id));
  await updateClient(clientId, { customAgentIds: nextIds });
  // Ids this save just revoked — their schedules for THIS client stop being
  // grantable the moment the allowlist no longer names them, same as a
  // global disable.
  const nextIdSet = new Set(nextIds);
  const removedIds = new Set((client.customAgentIds ?? []).filter((id) => !nextIdSet.has(id)));
  if (removedIds.size > 0) {
    const runs = await listPlannedScheduledRuns({ clientId });
    await pauseActiveSchedules(runs.filter((r) => removedIds.has(r.customAgentId)));
  }
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
  /** "How many drafts?"-style batch-size controls (e.g. the X agent's 5/10/21). Clamped same as a scheduled fire. */
  chargeMultiplier?: number;
  /**
   * The brief's field values, for the few fields the server needs as data and
   * not as prose — today the LinkedIn writer's "Post as". Untrusted: every
   * reader validates against the client's own records. See
   * SubmitCustomAgentInput.briefValues.
   */
  briefValues?: Record<string, string>;
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
