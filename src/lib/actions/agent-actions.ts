"use server";

import { revalidatePath } from "next/cache";
import {
  createAgent,
  updateAgent,
  deleteAgent,
  getAgent,
  listAgents,
  getClient,
} from "@/lib/data";
import { startAgentRun, testRunAgent, type TestRunResult } from "@/lib/agents/run";
import {
  type DraftFields,
  createDraftAgent,
  saveAgentDraft,
  publishAgent,
  unpublishAgent,
  buildTestAgent,
} from "@/lib/agents/authoring";
import type { Agent } from "@/lib/types";
import { requireStaff, requireAdmin } from "./_shared";

/** Create an in-development draft. Used for lazy creation on the builder's first edit. */
export async function createDraftAgentAction(initial: Partial<DraftFields>) {
  const user = await requireStaff();
  const id = await createDraftAgent(user.uid, initial);
  revalidatePath("/agents");
  return { id };
}

/** Autosave a draft's working state. Intentionally does not revalidate (avoids typing churn). */
export async function saveAgentDraftAction(id: string, patch: Partial<DraftFields>) {
  await requireStaff();
  await saveAgentDraft(id, patch);
}

/** Publish a draft into a live, runnable agent (validates required fields). */
export async function publishAgentAction(id: string, fields: DraftFields) {
  await requireStaff();
  await publishAgent(id, fields);
  revalidatePath(`/agents/${id}`);
  revalidatePath("/agents");
  return { id };
}

/** Send a live agent back to in-development. */
export async function unpublishAgentAction(id: string) {
  await requireStaff();
  await unpublishAgent(id);
  revalidatePath(`/agents/${id}`);
  revalidatePath("/agents");
}

/** Sandboxed test run from the builder's live config — no email, no assets, no job. */
export async function testRunAgentAction(input: {
  config: DraftFields;
  clientId: string;
  values: Record<string, string>;
  withImages: boolean;
}): Promise<TestRunResult> {
  const user = await requireStaff();
  const client = await getClient(input.clientId);
  if (!client) throw new Error("Pick a client to test against.");
  const agent = buildTestAgent(user.uid, input.config);
  return testRunAgent({ agent, client, input: input.values, withImages: input.withImages });
}

export async function deleteAgentAction(id: string) {
  await requireStaff();
  await deleteAgent(id);
  revalidatePath("/agents");
}

export async function toggleAgentAction(id: string) {
  await requireStaff();
  const agent = await getAgent(id);
  if (!agent) throw new Error("Agent not found");
  await updateAgent(id, { isActive: !agent.isActive, updatedAt: Date.now() });
  revalidatePath("/agents");
}

export async function runAgentAction(input: {
  agentId: string;
  clientId: string;
  input: Record<string, string>;
}) {
  const user = await requireStaff();
  const result = await startAgentRun({
    agentId: input.agentId,
    clientId: input.clientId,
    input: input.input,
    actor: user,
  });
  revalidatePath("/jobs");
  revalidatePath(`/clients/${input.clientId}`);
  revalidatePath("/assets");
  return result;
}

const STARTER_AGENTS: Omit<Agent, "id" | "createdAt" | "updatedAt" | "createdBy" | "runCount">[] = [
  {
    name: "Instagram + Email Agent",
    description:
      "Generates on-brand Instagram posts (caption, hashtags & visual brief) and emails the drafts straight to the client for review.",
    icon: "Camera",
    color: "#2dff9e",
    model: "claude-sonnet-4-6",
    systemPrompt:
      "You are a senior social media strategist at a marketing agency. You write scroll-stopping, on-brand Instagram captions that drive engagement. Match the client's brand voice exactly. Each post must have a strong hook in the first line, a clear value or story in the body, a natural call-to-action, a tight set of relevant hashtags (mix of broad and niche, no banned/spammy tags), and a concrete art-direction brief for the accompanying visual. Never use clichés or generic filler.",
    outputKind: "instagram_posts",
    fields: [
      { key: "topic", label: "Topic / campaign", type: "text", placeholder: "Summer launch, product highlight…", required: true },
      { key: "count", label: "How many posts", type: "select", options: ["1", "2", "3", "4", "5"], defaultValue: "3" },
      { key: "goal", label: "Goal (optional)", type: "text", placeholder: "Drive sign-ups, build awareness…" },
      { key: "notes", label: "Extra notes (optional)", type: "textarea", placeholder: "Anything specific to include or avoid" },
    ],
    capabilities: ["generate", "generate_images", "create_assets", "email_client", "use_brand_voice", "use_transcripts"],
    status: "published",
    isActive: true,
    shared: true,
  },
  {
    name: "Writer Agent",
    description: "Drafts long-form articles, blog posts and copy tailored to the client's brand voice.",
    icon: "PenLine",
    color: "#a78bfa",
    model: "claude-sonnet-4-6",
    systemPrompt:
      "You are an expert long-form content writer for a marketing agency. Write clear, engaging, well-structured articles in the client's brand voice. Use compelling headlines, scannable subheads, and a strong intro and conclusion. Avoid fluff and AI clichés.",
    outputKind: "article",
    fields: [
      { key: "topic", label: "Topic", type: "text", placeholder: "Article subject", required: true },
      { key: "wordCount", label: "Target length", type: "select", options: ["500", "800", "1200", "2000"], defaultValue: "800" },
      { key: "keywords", label: "Keywords (optional)", type: "text", placeholder: "comma separated" },
    ],
    capabilities: ["generate", "create_assets", "use_brand_voice"],
    status: "published",
    isActive: true,
    shared: true,
  },
  {
    name: "Email Campaign Agent",
    description: "Writes a complete marketing email (subject + body) and delivers it to the client to review.",
    icon: "Mail",
    color: "#5db4ff",
    model: "claude-sonnet-4-6",
    systemPrompt:
      "You are an email marketing specialist. Write a high-converting marketing email in the client's brand voice. Start with the subject line on its own first line prefixed with 'Subject:'. Then write a compelling, concise body with one clear call-to-action.",
    outputKind: "email",
    fields: [
      { key: "topic", label: "Campaign / offer", type: "text", placeholder: "What is this email about?", required: true },
      { key: "audience", label: "Audience (optional)", type: "text", placeholder: "New leads, existing customers…" },
    ],
    capabilities: ["generate", "create_assets", "email_client", "use_brand_voice"],
    status: "published",
    isActive: true,
    shared: true,
  },
  {
    name: "Social Posts Agent",
    description: "Generates a batch of short posts for X/LinkedIn from a single idea, on brand.",
    icon: "Share2",
    color: "#ffcf5d",
    model: "claude-sonnet-4-6",
    systemPrompt:
      "You are a social media copywriter. Produce a numbered batch of short, punchy social posts (suitable for X and LinkedIn) from the brief, in the client's brand voice. Vary the angle of each post.",
    outputKind: "social_posts",
    fields: [
      { key: "topic", label: "Idea / theme", type: "text", placeholder: "What should the posts be about?", required: true },
      { key: "count", label: "How many", type: "select", options: ["3", "5", "8"], defaultValue: "5" },
    ],
    capabilities: ["generate", "create_assets", "use_brand_voice"],
    status: "published",
    isActive: true,
    shared: true,
  },
];

export async function seedAgentsAction() {
  const user = await requireStaff();
  const now = Date.now();
  const ids: string[] = [];
  for (const a of STARTER_AGENTS) {
    ids.push(await createAgent({ ...a, createdBy: user.uid, createdAt: now, updatedAt: now, runCount: 0 }));
  }
  revalidatePath("/agents");
  return { count: ids.length };
}

/**
 * Import the karos-labs skill library as runnable agents.
 * Idempotent: keyed by `labsSkillId`, re-runs UPDATE rather than create duplicates.
 * Admin only: bulk-creates dozens of live agents.
 */
export async function importLabsSkillsAction() {
  const user = await requireAdmin();
  const { buildLabsAgentSpecs } = await import("@/lib/agents/labs-import");
  const specs = buildLabsAgentSpecs();

  const existing = await listAgents();
  const byLabsId = new Map(
    existing.filter((a) => a.labsSkillId).map((a) => [a.labsSkillId as string, a] as const),
  );

  const now = Date.now();
  const result = { created: 0, updated: 0, failed: 0, total: specs.length };
  const CHUNK = 12;

  for (let i = 0; i < specs.length; i += CHUNK) {
    const settled = await Promise.allSettled(
      specs.slice(i, i + CHUNK).map(async (s) => {
        const config = {
          name: s.name,
          description: s.description,
          icon: s.icon,
          color: s.color,
          model: s.model,
          systemPrompt: s.systemPrompt,
          outputKind: s.outputKind,
          fields: s.fields,
          capabilities: s.capabilities,
          shared: s.shared,
        };
        const prior = byLabsId.get(s.labsSkillId);
        if (prior) {
          await updateAgent(prior.id, { ...config, updatedAt: now });
          return "updated" as const;
        }
        await createAgent({
          ...config,
          status: "published",
          isActive: true,
          labsSkillId: s.labsSkillId,
          createdBy: user.uid,
          createdAt: now,
          updatedAt: now,
          runCount: 0,
        });
        return "created" as const;
      }),
    );
    for (const r of settled) {
      if (r.status === "fulfilled") result[r.value]++;
      else result.failed++;
    }
  }

  revalidatePath("/agents");
  return result;
}
