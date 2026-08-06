/**
 * Omnichannel Campaign engine.
 *
 * When a high-weight trend or event warrants more than a single post, this turns
 * it into a cohesive, dependent bundle: a core authority anchor (a blog
 * article, a managed product), a distribution vehicle (a newsletter summarizing
 * it, now the v2 CUSTOM agent rather than a managed product), and matching
 * social pieces — with explicit relational dependencies (the
 * newsletter and socials depend on the anchor). It runs the Creative Entropy
 * Guard first so a repetitive theme is pushed toward a fresh angle before any
 * tasks are written.
 *
 * The dependency assembly is pure (`buildCampaignTaskDrafts`) and unit-tested;
 * persistence + the model call live in `generateCampaignBundle`. Server-only.
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
  createCampaign,
  createClientTask,
  listCustomAgents,
  updateCampaign,
  getTaskBoardCapacity,
} from "@/lib/data";
import { NEWSLETTER_WRITER_V2_KEY } from "@/lib/custom-agent-launch";
import { taskWeekKey, findDuplicateReason } from "@/lib/task-dedup";
import { freshnessGuard } from "@/lib/entropy-guard";
import type { ClientTask, TaskPriority, TaskSource, TaskOwner } from "@/lib/types";
import { clientCategoryValue } from "@/lib/utils";

const SOCIAL_PLATFORMS = ["linkedin", "facebook", "instagram", "twitter", "youtube", "tiktok"] as const;

/** How far back the entropy guard looks at the client's own text output. */
const FRESHNESS_WINDOW_MS = 30 * 24 * 60 * 60 * 1000;

/* ── Blueprint schema (the model's structured proposal) ──────────────── */

const pieceSchema = z.object({
  title: z.string().min(1).max(200),
  description: z.string().min(1).max(800),
  weight: z.number().int().min(0).max(100),
});

export const campaignBlueprintSchema = z.object({
  title: z.string().min(1).max(120),
  themeScope: z.string().min(1).max(160),
  /** Authority anchor — a blog article. */
  anchor: pieceSchema,
  /** Distribution vehicle — a newsletter summarizing the anchor. */
  newsletter: pieceSchema,
  /** Matching social snippets across channels (1–4). */
  socials: z
    .array(pieceSchema.extend({ platform: z.enum(SOCIAL_PLATFORMS) }))
    .min(1)
    .max(4),
});
export type CampaignBlueprint = z.infer<typeof campaignBlueprintSchema>;

/* ── Pure dependency assembly ────────────────────────────────────────── */

export type CampaignRole = "anchor" | "distribution" | "social";

/**
 * One piece of the bundle, and the executor it is destined for.
 *
 * TWO EXECUTOR SHAPES SINCE THE NEWSLETTER MOVED, because the two paths differ
 * at the point of persistence rather than just in name. A managed product is a
 * fixed string every client shares. A custom agent is a Firestore DOCUMENT whose
 * id differs per environment (prep and production hold different ids) and which
 * a client may not even be granted — so the KEY is carried here and resolved to
 * an id when the task is written, exactly as the swarm planner already does for
 * the custom agents it assigns. A draft holding an id could not be built without
 * a Firestore read, and this half of the module is pure on purpose.
 */
export interface CampaignTaskDraft {
  role: CampaignRole;
  title: string;
  description: string;
  /**
   * The managed product for this piece, or `"custom"` when a custom agent runs
   * it — in which case `customAgentKey` names which one.
   */
  productType: "blog_article" | "social_post" | "custom";
  /**
   * The lab skill key of the custom agent that executes this piece. Set only
   * when `productType` is `"custom"`; resolved to that client's granted agent
   * document at persist time.
   */
  customAgentKey?: string;
  platform?: string;
  weight: number;
  /** Roles this piece depends on — resolved to real task ids at persist time. */
  dependsOnRoles: CampaignRole[];
}

function weightToPriority(weight: number): TaskPriority {
  if (weight >= 75) return "high";
  if (weight >= 40) return "medium";
  return "low";
}

/**
 * Assemble the ordered, dependency-wired task drafts for a campaign:
 * anchor (blog, no deps) → newsletter (depends on anchor) → socials (each
 * depends on anchor). Anchor is always first so id resolution is trivial.
 */
export function buildCampaignTaskDrafts(blueprint: CampaignBlueprint): CampaignTaskDraft[] {
  const anchor: CampaignTaskDraft = {
    role: "anchor",
    title: blueprint.anchor.title,
    description: blueprint.anchor.description,
    productType: "blog_article",
    weight: blueprint.anchor.weight,
    dependsOnRoles: [],
  };
  // The distribution vehicle is still a newsletter; it is no longer a managed
  // product. It routes to the v2 writer by KEY — the id is per-environment and
  // per-grant, so it is resolved when the task is written, not here.
  const newsletter: CampaignTaskDraft = {
    role: "distribution",
    title: blueprint.newsletter.title,
    description: blueprint.newsletter.description,
    productType: "custom",
    customAgentKey: NEWSLETTER_WRITER_V2_KEY,
    weight: blueprint.newsletter.weight,
    dependsOnRoles: ["anchor"],
  };
  const socials: CampaignTaskDraft[] = blueprint.socials.map((s) => ({
    role: "social",
    title: s.title,
    description: s.description,
    productType: "social_post",
    platform: s.platform,
    weight: s.weight,
    dependsOnRoles: ["anchor"],
  }));
  return [anchor, newsletter, ...socials];
}

/**
 * A dependency's content is usable by the piece that depends on it once it has
 * actually produced a deliverable — review_pending (drafted, awaiting
 * approval) or completed. Still pending/in_progress means there is nothing yet
 * for a dependent piece (e.g. the newsletter) to build on.
 */
function dependencyContentExists(status: ClientTask["status"]): boolean {
  return status === "review_pending" || status === "completed";
}

/**
 * The titles of this task's campaign dependencies that haven't produced a
 * deliverable yet — empty when the task is clear to execute. Pure so the
 * resume/start action paths and the Run View UI can share one readiness rule.
 * A dependency id that no longer resolves to a task (deleted) is NOT treated
 * as blocking — it can never become satisfied, and would strand the campaign.
 */
export function unmetCampaignDependencyTitles(
  task: Pick<ClientTask, "dependsOnTaskIds">,
  tasksById: Map<string, Pick<ClientTask, "title" | "status">>,
): string[] {
  return (task.dependsOnTaskIds ?? [])
    .map((id) => tasksById.get(id))
    .filter((dep): dep is { title: string; status: ClientTask["status"] } => !!dep)
    .filter((dep) => !dependencyContentExists(dep.status))
    .map((dep) => dep.title);
}

/* ── Generation + persistence ────────────────────────────────────────── */

export interface CampaignTrend {
  theme: string;
  weight: number;
  rationale?: string;
}

export interface GenerateCampaignInput {
  clientId: string;
  createdBy: string;
  trend: CampaignTrend;
  /** ISO week key the campaign targets; defaults to the current week. */
  targetWeek?: string;
  now?: number;
}

export interface GeneratedCampaign {
  campaignId: string;
  title: string;
  themeScope: string;
  targetWeek: string;
  taskIds: string[];
  /** Pieces dropped because the board already covers them. */
  duplicatesSkipped: number;
  /** Pieces dropped because the active karos_managed ceiling was reached. */
  capSkipped: number;
}

function buildCampaignPrompt(
  clientName: string,
  category: string | null | undefined,
  trend: CampaignTrend,
): string {
  return `CLIENT: ${clientName}${category ? ` — ${category}` : ""}
TREND / EVENT TO BUILD AROUND: ${trend.theme}${trend.rationale ? `\nWhy it matters: ${trend.rationale}` : ""}

Design ONE cohesive omnichannel campaign around this trend. Produce:
- anchor: a substantial authority blog article (the campaign's cornerstone)
- newsletter: an issue that summarizes and drives traffic to the anchor
- socials: 1–4 platform-native snippets that tease the anchor (pick the best-fit platforms)

Every piece must ladder up to the same theme and reference the anchor's angle. Set weight (0-100) by strategic importance. Be hyper-specific to this client — no generic filler.`;
}

/**
 * Generate and persist a full campaign bundle for a detected trend. Runs the
 * entropy guard against the client's last-30-days text first (appending
 * freshness constraints when the theme is repetitive), asks the model for a
 * blueprint, then writes the Campaign doc and its dependency-wired tasks.
 *
 * Returns null when nothing could be written — the board is at capacity or the
 * anchor already exists. Nothing is persisted in that case, not even the
 * campaign shell.
 */
export async function generateCampaignBundle(
  input: GenerateCampaignInput,
): Promise<GeneratedCampaign | null> {
  const now = input.now ?? Date.now();
  const client = await getClient(input.clientId);
  if (!client) throw new Error("Client not found");

  // Entropy guard: compare the trend theme to the client's recent text output.
  const assets = await listAssets({ clientId: input.clientId });
  const recentTexts = assets
    .filter((a) => a.createdAt >= now - FRESHNESS_WINDOW_MS && !!a.content)
    .map((a) => `${a.title} ${a.content}`);
  const { constraints } = freshnessGuard(input.trend.theme, recentTexts);

  const system =
    "You are the Karos AI Campaign Director. You design tight, cohesive omnichannel campaigns where every channel reinforces one theme and one anchor. Return only the structured blueprint." +
    (constraints ? `\n\n${constraints}` : "");

  const campaignUsageMeta = {
    clientId: input.clientId,
    agentId: null,
    agentName: "Campaign Director",
    modelName: MODELS.SONNET,
    operation: "campaign_generation",
  };
  let blueprint: CampaignBlueprint;
  let usage: { inputTokens?: number; outputTokens?: number };
  try {
    ({ object: blueprint, usage } = await generateObject({
      model: anthropic(MODELS.SONNET),
      schema: campaignBlueprintSchema,
      system,
      prompt: buildCampaignPrompt(client.name, clientCategoryValue(client), input.trend),
    }));
  } catch (err) {
    logger.logGenerationFailure(campaignUsageMeta, err);
    throw err;
  }

  after(() =>
    logger.logUsage({
      ...campaignUsageMeta,
      inputTokens: usage.inputTokens ?? 0,
      outputTokens: usage.outputTokens ?? 0,
    }),
  );

  const drafts = buildCampaignTaskDrafts(blueprint);
  const targetWeek = input.targetWeek ?? taskWeekKey(now);

  // Capacity + dedup, mirroring persistSwarmTasks. This path used to call
  // createClientTask straight down the draft list, so the MAX_ACTIVE_TASKS
  // ceiling the copilot tells clients is enforced server-side was bypassed and
  // a board already at the limit quietly went over (QA F92).
  const { activeCount, tasks: boardTasks } = await getTaskBoardCapacity(input.clientId);
  const pool = [...boardTasks];
  let slotsFree = Math.max(0, MAX_ACTIVE_TASKS - activeCount);
  const admitted: CampaignTaskDraft[] = [];
  let duplicatesSkipped = 0;
  let capSkipped = 0;

  for (const draft of drafts) {
    const reason = findDuplicateReason(
      { title: draft.title, productType: draft.productType, platform: draft.platform },
      pool,
      now,
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
    admitted.push(draft);
    // Accepted pieces join the pool so the bundle cannot duplicate itself.
    pool.push({
      id: `pending-campaign-${admitted.length}`,
      clientId: input.clientId,
      title: draft.title,
      status: "pending",
      priority: weightToPriority(draft.weight),
      source: "content_dispatch" as TaskSource,
      owner: "karos_managed" as TaskOwner,
      metadata: { productType: draft.productType, platform: draft.platform },
      createdBy: input.createdBy,
      createdAt: now,
      updatedAt: now,
    });
  }

  // Every other piece teases the anchor and depends on it, so a bundle without
  // its anchor is not a campaign — write nothing rather than a headless one.
  if (!admitted.some((d) => d.role === "anchor")) return null;

  // Create the campaign shell first so tasks can carry campaignId on write.
  const campaignId = await createCampaign({
    clientId: input.clientId,
    title: blueprint.title,
    themeScope: blueprint.themeScope,
    targetWeek,
    taskIds: [],
    assetIds: [],
    status: "planned",
    createdBy: input.createdBy,
    createdAt: now,
    updatedAt: now,
  });

  // Custom-agent executors, resolved once for the whole bundle. Read here rather
  // than in `buildCampaignTaskDrafts` so that function stays pure and testable
  // without a Firestore double.
  const customByKey = new Map(
    (await listCustomAgents()).filter((a) => a.enabled).map((a) => [a.key, a]),
  );

  // Persist the anchor first so dependents can reference its real id.
  const roleToId: Partial<Record<CampaignRole, string>> = {};
  const orderedTaskIds: string[] = [];
  for (const draft of admitted) {
    const dependsOnTaskIds = draft.dependsOnRoles
      .map((r) => roleToId[r])
      .filter((id): id is string => !!id);
    const metadata: Record<string, unknown> = {
      campaignRole: draft.role,
      // Denormalized so the producing asset can carry the capsule label without a join.
      campaignTitle: blueprint.title,
    };
    // The two executor shapes, and the reason they are written differently.
    //
    // A managed product gets a `product_run:` completion trigger because the
    // webhook mints exactly that string from the delivered `task_type`. A CUSTOM
    // run delivers `task_type: "custom"`, so a trigger built from a custom
    // agent's key could never match and the task would sit pending for ever —
    // which is precisely how the v1 newsletter tasks this migration cleans up
    // became stranded. So a custom piece gets NO trigger, exactly as the swarm
    // planner already does ("no product_run trigger — that flow is separate").
    if (draft.productType === "custom") {
      const agent = draft.customAgentKey ? customByKey.get(draft.customAgentKey) : undefined;
      // A campaign whose distribution agent is not registered or not enabled
      // still gets its task: the piece is real editorial work and dropping it
      // silently would leave a bundle with a hole nobody can see. It lands
      // unassigned, which is a state the board already renders — a staff member
      // picks an executor — rather than one pointing at an agent that is not there.
      if (agent) {
        metadata.customAgentId = agent.id;
        metadata.customAgentName = agent.name;
      }
    } else {
      metadata.productType = draft.productType;
      metadata.completionTrigger = `product_run:${draft.productType}`;
    }
    if (draft.platform) metadata.platform = draft.platform;

    const taskId = await createClientTask({
      clientId: input.clientId,
      title: draft.title,
      description: draft.description,
      status: "pending",
      priority: weightToPriority(draft.weight),
      source: "content_dispatch" as TaskSource,
      owner: "karos_managed" as TaskOwner,
      weight: draft.weight,
      campaignId,
      dependsOnTaskIds,
      metadata,
      createdBy: input.createdBy,
      createdAt: now,
      updatedAt: now,
    });
    // Anchor is first, so its id is available for the dependents that follow.
    if (draft.role === "anchor") roleToId.anchor = taskId;
    orderedTaskIds.push(taskId);
  }

  await updateCampaign(campaignId, { taskIds: orderedTaskIds, updatedAt: Date.now() });

  return {
    campaignId,
    title: blueprint.title,
    themeScope: blueprint.themeScope,
    targetWeek,
    taskIds: orderedTaskIds,
    duplicatesSkipped,
    capSkipped,
  };
}
