/**
 * The Agent Swarm — multi-agent Task Map generation.
 *
 * Replaces single-shot task generation with a structured backend debate between
 * three specialist personas that revise a shared task array across several rounds
 * until a consensus set of karos_managed tasks is locked, then persisted through
 * the same dedup + capacity pipeline the copilot uses.
 *
 * `runSwarm` is an async generator that yields typed `SwarmEvent`s as the debate
 * unfolds — the SSE route streams them to the War Room UI, and tests drive the
 * generator directly to assert the multi-round state machine. Server-only: it
 * calls the model, the usage logger, and the data layer.
 */

import "server-only";
import { generateObject } from "ai";
import { anthropic } from "@ai-sdk/anthropic";
import { z } from "zod";
import { after } from "next/server";
import { MODELS, MAX_ACTIVE_TASKS } from "@/lib/constants";
import { logger } from "@/services/logger";
import {
  getClient,
  listAssets,
  listClientIntegrations,
  getClientPerformanceBenchmarks,
  getTaskBoardCapacity,
  createClientTask,
} from "@/lib/data";
import { findDuplicateReason, normalizeTitleForDedup } from "@/lib/task-dedup";
import { getClientCustomAgents, type ClientCustomAgentSummary } from "@/lib/agent-roster";
import { generateCampaignBundle, type CampaignTrend } from "@/lib/campaign-engine";
import { integrationIsUsable } from "@/lib/integration-status";
import type { TaskPriority, TaskSource, TaskOwner } from "@/lib/types";

/* ── Constants ───────────────────────────────────────────────────────── */

const PLATFORMS = ["linkedin", "facebook", "instagram", "twitter", "youtube", "tiktok"] as const;
const PRODUCT_TYPES = ["social_post", "newsletter_issue", "blog_article", "landing_page"] as const;

/** Structural debate rounds (each round = one turn per persona). */
export const DEFAULT_ROUNDS = 2;
/** The consensus target — aligned with the karos_managed active-task cap. */
export const MAX_CONSENSUS_TASKS = MAX_ACTIVE_TASKS;

/**
 * Trend weight at/above which the engine SHIFTS from isolated tasks to a cohesive
 * omnichannel campaign bundle for that theme (blog anchor + newsletter + socials).
 */
export const CAMPAIGN_TREND_MIN_WEIGHT = 80;

/* ── Output schema (strict) ──────────────────────────────────────────── */

export const swarmTaskSchema = z.object({
  title: z.string().min(1).max(200),
  description: z.string().min(1).max(800),
  priority: z.enum(["high", "medium", "low"]),
  productType: z.enum(PRODUCT_TYPES).optional(),
  /** Assign a CUSTOM agent by its id (from the roster) INSTEAD of a managed productType. */
  customAgentId: z.string().optional(),
  platform: z.enum(PLATFORMS).optional(),
  weight: z.number().int().min(0).max(100),
});
export type SwarmTaskDraft = z.infer<typeof swarmTaskSchema>;

const swarmTurnSchema = z.object({
  /** First-person, console-style line describing this agent's move (streamed to the War Room). */
  message: z.string().min(1).max(600),
  /** The FULL revised task array — the running consensus after this agent's turn. */
  tasks: z.array(swarmTaskSchema).max(20),
});

/* ── Personas ────────────────────────────────────────────────────────── */

export type SwarmAgentId = "seo" | "creative" | "data";

export interface SwarmPersona {
  id: SwarmAgentId;
  name: string;
  emoji: string;
  role: string;
  systemPrompt: string;
}

const TURN_DISCIPLINE = `
You are one voice in a three-agent strategy debate producing a marketing Task Map. On your turn you receive the current DRAFT task array and must return the FULL revised array plus a short, punchy console-style MESSAGE (first person) describing what you changed and why — as if speaking in a war-room terminal.
Rules:
- Every task is karos_managed content the Karos AI agents execute. A content task normally carries a productType from: social_post, newsletter_issue, blog_article, landing_page.
- When an AVAILABLE CUSTOM AGENTS list is provided and one fits the task better, assign it by setting customAgentId to that agent's exact id INSTEAD of a productType — never set both on the same task. Only use ids from that list; never invent one.
- Set platform to the target channel when relevant. Set weight (0-100) by how critical the underlying gap is (90+ = urgent, 75-89 = high, 50-74 = standard, <50 = optional); priority must agree (>=75 high, 40-74 medium, <40 low).
- Keep tasks hyper-specific to THIS client. No generic filler. Never exceed 20 tasks in the array; the panel will trim to the best ${MAX_CONSENSUS_TASKS}.
- Return the COMPLETE array every turn (keep what works, revise what doesn't) — do not return only your deltas.
- MESSAGE must be under 60 words, specific, and reference concrete tasks/trends. This is the debate line the client watches live.`;

export const SWARM_PERSONAS: SwarmPersona[] = [
  {
    id: "seo",
    name: "SEO / GEO Expert",
    emoji: "🔍",
    role: "Proposes tasks that close search + generative-engine visibility and content-cadence gaps.",
    systemPrompt: `You are a world-class SEO & GEO (generative-engine optimization) strategist. You open the debate by proposing a task map that closes the client's visibility and content-cadence gaps: underserved platforms, empty calendar windows, topic-authority holes, and buyer-intent coverage. You reward search intent and discoverability.${TURN_DISCIPLINE}`,
  },
  {
    id: "creative",
    name: "Creative Director",
    emoji: "🎨",
    role: "Critiques branding alignment and structural freshness; swaps stale formats for fresh variants.",
    systemPrompt: `You are an award-winning Creative Director. You critique the draft for brand alignment and structural freshness: kill repetitive formats, reject anything off-brand or generic, and push variety (e.g. swap a tired static post for a vertical video variant, a carousel, or a bolder angle). You defend the brand voice fiercely.${TURN_DISCIPLINE}`,
  },
  {
    id: "data",
    name: "Data Analyst",
    emoji: "📊",
    role: "Evaluates the draft against historical analytics; prioritizes proven winners, cuts likely losers.",
    systemPrompt: `You are a rigorous marketing Data Analyst. You evaluate the draft against the client's HISTORICAL PERFORMANCE benchmarks: raise the weight of formats/platforms/angles that have measurably won, cut or rework those that have measurably underperformed, and rebalance the mix toward proven engagement. You are the final reality check before consensus.${TURN_DISCIPLINE}`,
  },
];

const PERSONA_BY_ID: Record<SwarmAgentId, SwarmPersona> = {
  seo: SWARM_PERSONAS[0],
  creative: SWARM_PERSONAS[1],
  data: SWARM_PERSONAS[2],
};

/** Fixed debate order within each round. */
const TURN_ORDER: SwarmAgentId[] = ["seo", "creative", "data"];

/* ── Context ─────────────────────────────────────────────────────────── */

export interface SwarmContext {
  clientName: string;
  industry?: string | null;
  /** Connected platforms vs the 14-day calendar — where the gaps are. */
  gapSummary: string;
  /** Brand voice / tone / visual style guidance for the Creative Director. */
  brandingSummary: string;
  /** Top/bottom historical performers for the Data Analyst. */
  benchmarkSummary: string;
  /** Custom agents assigned to this client — assignable via a task's customAgentId. */
  customAgents: ClientCustomAgentSummary[];
  /**
   * A high-weight trend/event detected for this client, if any. When its weight
   * clears CAMPAIGN_TREND_MIN_WEIGHT the run also generates a cohesive campaign
   * bundle for it (in addition to the standalone consensus tasks). null ⇒ none.
   */
  campaignTrend?: CampaignTrend | null;
}

export interface SwarmInput {
  clientId: string;
  createdBy: string;
  context: SwarmContext;
  /** Override the number of debate rounds (default DEFAULT_ROUNDS). */
  rounds?: number;
  /** Aborts in-flight model calls and stops the debate early (client disconnected). */
  signal?: AbortSignal;
}

/* ── Events (tight discriminated union) ──────────────────────────────── */

export type SwarmEvent =
  | { type: "round_start"; round: number; totalRounds: number }
  | {
      type: "agent_message";
      round: number;
      agent: SwarmAgentId;
      agentName: string;
      emoji: string;
      message: string;
      taskCount: number;
    }
  | { type: "consensus"; taskCount: number }
  | { type: "persisted"; created: number; duplicatesSkipped: number; capSkipped: number; note: string }
  | { type: "campaign"; campaignId: string; title: string; themeScope: string; taskCount: number }
  | { type: "done"; created: number }
  | { type: "error"; message: string };

/* ── Pure consensus finalization ─────────────────────────────────────── */

/**
 * Lock the final consensus from the last-revised array: drop exact-title
 * duplicates (normalized), rank by weight (desc), and cap to `limit`. Pure and
 * deterministic — unit-tested in isolation.
 */
export function finalizeConsensus(
  drafts: SwarmTaskDraft[],
  limit: number = MAX_CONSENSUS_TASKS,
): SwarmTaskDraft[] {
  const seen = new Set<string>();
  const unique: SwarmTaskDraft[] = [];
  for (const d of drafts) {
    const key = normalizeTitleForDedup(d.title);
    if (!key || seen.has(key)) continue;
    seen.add(key);
    unique.push(d);
  }
  return unique.sort((a, b) => b.weight - a.weight).slice(0, limit);
}

/* ── One agent turn ──────────────────────────────────────────────────── */

function buildTurnPrompt(
  persona: SwarmPersona,
  tasks: SwarmTaskDraft[],
  ctx: SwarmContext,
  round: number,
  totalRounds: number,
): string {
  const draft =
    tasks.length === 0
      ? "(empty — no tasks proposed yet; you are opening the debate)"
      : JSON.stringify(tasks, null, 2);
  const customAgentsBlock =
    ctx.customAgents.length > 0
      ? ctx.customAgents.map((a) => `- ${a.id}: ${a.name} — ${a.description}`).join("\n")
      : "(none assigned to this client — use managed productTypes only)";

  return `CLIENT: ${ctx.clientName}${ctx.industry ? ` — ${ctx.industry}` : ""}
DEBATE ROUND: ${round} of ${totalRounds}

CONTENT & INTEGRATION GAPS:
${ctx.gapSummary}

BRAND GUIDANCE:
${ctx.brandingSummary}

HISTORICAL PERFORMANCE BENCHMARKS:
${ctx.benchmarkSummary}

AVAILABLE CUSTOM AGENTS (assign a task to one via customAgentId):
${customAgentsBlock}

CURRENT DRAFT TASK ARRAY:
${draft}

It is your turn as the ${persona.name}. ${persona.role} Revise the array and return the full result plus your debate message.`;
}

async function runTurn(
  persona: SwarmPersona,
  tasks: SwarmTaskDraft[],
  input: SwarmInput,
  round: number,
  totalRounds: number,
): Promise<z.infer<typeof swarmTurnSchema>> {
  const { object, usage } = await generateObject({
    model: anthropic(MODELS.HAIKU),
    schema: swarmTurnSchema,
    system: persona.systemPrompt,
    prompt: buildTurnPrompt(persona, tasks, input.context, round, totalRounds),
    abortSignal: input.signal,
  });

  after(() =>
    logger.logUsage({
      clientId: input.clientId,
      agentId: null,
      agentName: `Swarm: ${persona.name}`,
      modelName: MODELS.HAIKU,
      operation: "task_swarm",
      inputTokens: usage.inputTokens ?? 0,
      outputTokens: usage.outputTokens ?? 0,
    }),
  );

  return object;
}

/* ── Orchestration generator ─────────────────────────────────────────── */

/**
 * Run the multi-round debate and persist the consensus, yielding events as it
 * goes. Resilient: a single agent turn that fails is reported as a soft debate
 * message and the debate continues from the last good draft, so one flaky call
 * never sinks the whole run. A failure to persist emits an `error` event.
 */
export async function* runSwarm(input: SwarmInput): AsyncGenerator<SwarmEvent, void, unknown> {
  const totalRounds = Math.max(1, input.rounds ?? DEFAULT_ROUNDS);
  let tasks: SwarmTaskDraft[] = [];

  for (let round = 1; round <= totalRounds; round++) {
    if (input.signal?.aborted) return;
    yield { type: "round_start", round, totalRounds };
    for (const agentId of TURN_ORDER) {
      if (input.signal?.aborted) return;
      const persona = PERSONA_BY_ID[agentId];
      try {
        const turn = await runTurn(persona, tasks, input, round, totalRounds);
        // Keep the prior draft if an agent returns an empty array.
        if (turn.tasks.length > 0) tasks = turn.tasks;
        yield {
          type: "agent_message",
          round,
          agent: agentId,
          agentName: persona.name,
          emoji: persona.emoji,
          message: turn.message,
          taskCount: tasks.length,
        };
      } catch (e) {
        logger.logGenerationFailure(
          { clientId: input.clientId, agentId: null, agentName: `Swarm: ${persona.name}`, modelName: MODELS.HAIKU, operation: "task_swarm" },
          e,
        );
        yield {
          type: "agent_message",
          round,
          agent: agentId,
          agentName: persona.name,
          emoji: persona.emoji,
          message: `Encountered an error and deferred to the current draft (${e instanceof Error ? e.message : "unknown"}).`,
          taskCount: tasks.length,
        };
      }
    }
  }
  if (input.signal?.aborted) return;

  const consensus = finalizeConsensus(tasks);
  yield { type: "consensus", taskCount: consensus.length };

  try {
    const persisted = await persistSwarmTasks(
      input.clientId,
      input.createdBy,
      consensus,
      input.context.customAgents,
    );
    yield { type: "persisted", ...persisted };

    // The closing count used to report the debate's total only, so a run that
    // also built a campaign told the client seven tasks when eleven cards
    // landed on the board (QA F92).
    let createdTotal = persisted.created;

    // High-weight trend ⇒ shift up to a cohesive omnichannel campaign bundle
    // (anchor blog + newsletter + socials) alongside the standalone tasks.
    const trend = input.context.campaignTrend;
    if (trend && trend.weight >= CAMPAIGN_TREND_MIN_WEIGHT) {
      try {
        const campaign = await generateCampaignBundle({
          clientId: input.clientId,
          createdBy: input.createdBy,
          trend,
        });
        if (campaign) {
          createdTotal += campaign.taskIds.length;
          yield {
            type: "campaign",
            campaignId: campaign.campaignId,
            title: campaign.title,
            themeScope: campaign.themeScope,
            taskCount: campaign.taskIds.length,
          };
        } else {
          // Nothing was written — the board is full or the anchor already
          // exists. Say so in the console rather than silently skipping.
          yield {
            type: "agent_message",
            round: totalRounds,
            agent: "creative",
            agentName: "Campaign Director",
            emoji: "🎬",
            message: `Skipped the "${trend.theme}" campaign — your board is already at capacity or already covers its anchor article.`,
            taskCount: consensus.length,
          };
        }
      } catch (e) {
        // A campaign failure must not sink the whole run — the task map still landed.
        yield {
          type: "agent_message",
          round: totalRounds,
          agent: "creative",
          agentName: "Campaign Director",
          emoji: "🎬",
          message: `Campaign bundle for "${trend.theme}" couldn't be assembled (${e instanceof Error ? e.message : "unknown"}); the standalone task map still shipped.`,
          taskCount: consensus.length,
        };
      }
    }

    yield { type: "done", created: createdTotal };
  } catch (e) {
    yield { type: "error", message: e instanceof Error ? e.message : "Failed to save the task map" };
  }
}

/**
 * Drain `runSwarm` with no SSE consumer — for background triggers (e.g. the
 * post-onboarding generation cycle) that need the debate to finish and its
 * tasks persisted, but have no UI to stream turns to. Throws on the swarm's
 * own `error` event instead of swallowing it.
 */
export async function runSwarmToCompletion(input: SwarmInput): Promise<{ created: number }> {
  for await (const event of runSwarm(input)) {
    if (event.type === "error") throw new Error(event.message);
    if (event.type === "done") return { created: event.created };
  }
  return { created: 0 };
}

/* ── Persistence ─────────────────────────────────────────────────────── */

export interface PersistResult {
  created: number;
  duplicatesSkipped: number;
  capSkipped: number;
  note: string;
}

/**
 * Persist the consensus tasks through the same dedup + capacity rules the
 * copilot's create_tasks tool uses: three-tier dedup against the live board
 * (accepted proposals join the pool so a batch can't duplicate itself) and the
 * MAX_ACTIVE_TASKS cap on active karos_managed tasks. All swarm tasks are
 * karos_managed / source "copilot".
 */
export async function persistSwarmTasks(
  clientId: string,
  createdBy: string,
  drafts: SwarmTaskDraft[],
  customAgents: ClientCustomAgentSummary[] = [],
): Promise<PersistResult> {
  if (drafts.length === 0) {
    return { created: 0, duplicatesSkipped: 0, capSkipped: 0, note: "No tasks to create." };
  }

  // Only ids the client actually has can be assigned — drops any hallucinated id.
  const customById = new Map(customAgents.map((a) => [a.id, a]));

  const { activeCount, tasks: boardTasks } = await getTaskBoardCapacity(clientId);
  const pool = [...boardTasks];
  const fresh: SwarmTaskDraft[] = [];
  let slotsFree = Math.max(0, MAX_ACTIVE_TASKS - activeCount);
  let duplicatesSkipped = 0;
  let capSkipped = 0;

  for (const t of drafts) {
    const reason = findDuplicateReason(
      { title: t.title, productType: t.productType, platform: t.platform },
      pool,
    );
    if (reason) {
      duplicatesSkipped++;
      continue;
    }
    if (slotsFree <= 0) {
      capSkipped++;
      continue;
    }
    slotsFree--;
    fresh.push(t);
    pool.push({
      id: `pending-${fresh.length}`,
      clientId,
      title: t.title,
      status: "pending",
      priority: t.priority as TaskPriority,
      source: "copilot" as TaskSource,
      owner: "karos_managed" as TaskOwner,
      metadata: { productType: t.productType, platform: t.platform },
      createdBy,
      createdAt: Date.now(),
      updatedAt: Date.now(),
    });
  }

  const now = Date.now();
  await Promise.all(
    fresh.map((t) => {
      const metadata: Record<string, unknown> = {};
      const customAgent = t.customAgentId ? customById.get(t.customAgentId) : undefined;
      if (customAgent) {
        // Custom agents run through the agent-service custom flow, not the four
        // in-process productTypes — record the intended executor for display and
        // for staff to run it; no product_run trigger (that flow is separate).
        metadata.customAgentId = customAgent.id;
        metadata.customAgentName = customAgent.name;
      } else if (t.productType) {
        metadata.productType = t.productType;
        metadata.completionTrigger = `product_run:${t.productType}`;
      }
      if (t.platform) metadata.platform = t.platform;
      return createClientTask({
        clientId,
        title: t.title,
        description: t.description,
        status: "pending",
        priority: t.priority as TaskPriority,
        source: "copilot" as TaskSource,
        owner: "karos_managed" as TaskOwner,
        weight: t.weight,
        ...(Object.keys(metadata).length > 0 ? { metadata } : {}),
        createdBy,
        createdAt: now,
        updatedAt: now,
      });
    }),
  );

  const notes = [
    duplicatesSkipped > 0 ? `${duplicatesSkipped} duplicate${duplicatesSkipped !== 1 ? "s" : ""} skipped` : "",
    capSkipped > 0 ? `${capSkipped} deferred - queue at capacity` : "",
  ].filter(Boolean);
  return {
    created: fresh.length,
    duplicatesSkipped,
    capSkipped,
    note: `Locked ${fresh.length} task${fresh.length !== 1 ? "s" : ""}${notes.length ? ` (${notes.join("; ")})` : ""}.`,
  };
}

/* ── Context assembly ────────────────────────────────────────────────── */

/**
 * Assemble the shared debate context for a client: content/integration gaps,
 * brand guidance, and historical performance benchmarks — the same signals the
 * copilot's proactive appendix uses, distilled into prose the personas read.
 */
export async function buildSwarmContext(
  clientId: string,
  trendOverride?: string | null,
): Promise<{ clientName: string } & SwarmContext> {
  const [client, assets, integrations, benchmarks, customAgents] = await Promise.all([
    getClient(clientId),
    listAssets({ clientId }),
    listClientIntegrations(clientId),
    getClientPerformanceBenchmarks(clientId),
    getClientCustomAgents(clientId),
  ]);
  if (!client) throw new Error("Client not found");

  // Content-gap detection: connected platforms vs the next-14-day calendar.
  const nowMs = Date.now();
  const horizonMs = nowMs + 14 * 24 * 60 * 60 * 1000;
  const scheduledByPlatform: Record<string, number> = {};
  for (const a of assets) {
    if (a.scheduledAt == null || a.scheduledAt < nowMs || a.scheduledAt > horizonMs) continue;
    if (a.status !== "scheduled" && a.status !== "approved") continue;
    const key = a.scheduledPlatform ?? "unassigned";
    scheduledByPlatform[key] = (scheduledByPlatform[key] ?? 0) + 1;
  }
  const active = integrations.filter((i) => i.platform !== "google" && integrationIsUsable(i));
  const gapLines = active.map((i) => {
    const count = scheduledByPlatform[i.platform] ?? 0;
    return `- ${i.platform}: ${count === 0 ? "NO content scheduled in the next 14 days — GAP" : `${count} scheduled`}`;
  });
  const gapSummary = gapLines.length > 0 ? gapLines.join("\n") : "No social platforms connected yet.";

  // Brand guidance for the Creative Director.
  const bg = client.brandingGuidelines;
  const brandingSummary = bg
    ? [
        bg.toneKeywords?.length ? `Tone: ${bg.toneKeywords.join(", ")}` : "",
        bg.visualStyle ? `Visual style: ${bg.visualStyle}` : "",
        bg.guidelines ? `Guidelines: ${bg.guidelines.slice(0, 400)}` : "",
      ]
        .filter(Boolean)
        .join("\n") || "No brand guidelines documented yet."
    : "No brand guidelines documented yet.";

  // Historical benchmarks for the Data Analyst.
  const fmt = (r: (typeof benchmarks.top)[number]) =>
    `- [${r.engagementScore.toFixed(1)}] ${r.platform} · ${r.assetType ?? "?"} — "${r.assetLabel ?? r.assetId}"`;
  const benchmarkSummary =
    benchmarks.sampleSize > 0
      ? `TOP PERFORMERS:\n${benchmarks.top.map(fmt).join("\n") || "- none"}\n\nLOWEST PERFORMERS:\n${benchmarks.bottom.map(fmt).join("\n") || "- none"}`
      : "No performance analytics captured yet — weight by strategic judgment.";

  // Campaign trend detection: an explicit override wins; otherwise a
  // measurably dominant top performer (score ≥ threshold) is treated as the
  // high-weight trend worth building a full campaign around.
  let campaignTrend: CampaignTrend | null = null;
  if (trendOverride && trendOverride.trim()) {
    campaignTrend = { theme: trendOverride.trim(), weight: 90, rationale: "Operator-specified trend/event." };
  } else {
    const top = benchmarks.top[0];
    if (top && top.engagementScore >= CAMPAIGN_TREND_MIN_WEIGHT) {
      campaignTrend = {
        theme: top.assetLabel ?? top.assetType ?? "top-performing theme",
        weight: Math.round(top.engagementScore),
        rationale: `Highest-engaging recent content (score ${top.engagementScore.toFixed(1)}) — worth amplifying into a full campaign.`,
      };
    }
  }

  return {
    clientName: client.name,
    industry: client.industry,
    gapSummary,
    brandingSummary,
    benchmarkSummary,
    customAgents,
    campaignTrend,
  };
}
