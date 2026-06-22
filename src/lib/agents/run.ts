import "server-only";

import { after } from "next/server";
import { anthropic } from "@ai-sdk/anthropic";
import { generateText, generateObject } from "ai";
import { z } from "zod";

import {
  getAgent,
  getClient,
  listTranscripts,
  createJob,
  updateJob,
  createAsset,
  bumpAgentRun,
} from "@/lib/data";
import { sendEmail, emailShell } from "@/lib/email";
import { generatePostImage, imageGenConfigured } from "@/lib/images";
import type { Agent, AppUser, Client, Job, JobRunEvent } from "@/lib/types";

export const DEFAULT_MODEL = "claude-sonnet-4-6";

const igSchema = z.object({
  posts: z
    .array(
      z.object({
        caption: z.string().describe("The full Instagram caption, ready to publish."),
        hashtags: z.array(z.string()).describe("Relevant hashtags without the # symbol."),
        imageConcept: z
          .string()
          .describe(
            "A vivid, self-contained text-to-image prompt for the post's visual — this is fed directly to an image generator. " +
              "Describe subject, setting, composition, lighting, color palette, and mood in concrete visual terms. " +
              "On-brand and photographic unless the brief says otherwise. No text overlays, logos, or watermarks.",
          ),
        callToAction: z.string().describe("A short CTA line."),
      }),
    )
    .describe("The generated Instagram posts."),
});

function buildContext(client: Client, agent: Agent, transcriptText: string, input: Record<string, string>) {
  const parts: string[] = [];
  parts.push(`# Client\nName: ${client.name}`);
  if (client.industry) parts.push(`Industry: ${client.industry}`);
  if (client.website) parts.push(`Website: ${client.website}`);
  if (client.description) parts.push(`About: ${client.description}`);
  if (agent.capabilities.includes("use_brand_voice") && client.brandVoice) {
    parts.push(`\n# Brand Voice (follow this precisely)\n${client.brandVoice}`);
  }
  if (agent.capabilities.includes("use_transcripts") && transcriptText) {
    parts.push(`\n# Recent meeting context\n${transcriptText}`);
  }
  const inputLines = Object.entries(input)
    .filter(([, v]) => v?.toString().trim())
    .map(([k, v]) => `- ${k}: ${v}`)
    .join("\n");
  if (inputLines) parts.push(`\n# Request details\n${inputLines}`);
  return parts.join("\n");
}

export interface RunResult {
  jobId: string;
  status: Job["status"];
}

type IGPost = z.infer<typeof igSchema>["posts"][number];

interface GeneratedContent {
  rawOutput: string;
  posts?: IGPost[];
  /** Aligned to `posts`; entries are null when an image failed or images were off. */
  images: (string | null)[];
  text?: string;
}

/**
 * The reusable generation core: loads context, runs the model, optionally
 * generates images. Performs NO persistence (no job/asset/email) — the only
 * side effect is uploading generated images to Storage so they get a URL.
 * Both the real run path (`executeRun`) and the sandboxed test path
 * (`testRunAgent`) call this, so they stay in lockstep.
 */
async function generateContent(args: {
  agent: Agent;
  client: Client;
  input: Record<string, string>;
  withImages: boolean;
  imageKeyPrefix: string;
  events: JobRunEvent[];
}): Promise<GeneratedContent> {
  const { agent, client, input, withImages, imageKeyPrefix, events } = args;

  let transcriptText = "";
  if (agent.capabilities.includes("use_transcripts")) {
    const transcripts = await listTranscripts({ clientId: client.id });
    transcriptText = transcripts
      .slice(0, 3)
      .map((t) => `## ${t.title}\nSummary: ${t.summary ?? "(none)"}\nAction items: ${(t.actionItems ?? []).join("; ")}`)
      .join("\n\n");
  }

  const context = buildContext(client, agent, transcriptText, input);
  const model = anthropic(agent.model || DEFAULT_MODEL);

  if (agent.outputKind === "instagram_posts") {
    const { object } = await generateObject({
      model,
      schema: igSchema,
      system: agent.systemPrompt,
      prompt: `${context}\n\nProduce ${input.count || "3"} on-brand Instagram posts.`,
    });
    events.push({ at: Date.now(), level: "success", message: `Generated ${object.posts.length} Instagram posts` });

    const images: (string | null)[] = new Array(object.posts.length).fill(null);
    if (withImages) {
      for (let i = 0; i < object.posts.length; i++) {
        try {
          images[i] = await generatePostImage({
            concept: object.posts[i].imageConcept,
            key: `${imageKeyPrefix}-${i}`,
          });
        } catch (e) {
          const msg = e instanceof Error ? e.message : "Unknown error";
          events.push({ at: Date.now(), level: "error", message: `Image generation failed for post ${i + 1}: ${msg}` });
        }
      }
      const made = images.filter(Boolean).length;
      if (made > 0) events.push({ at: Date.now(), level: "success", message: `Generated ${made} image${made === 1 ? "" : "s"}` });
    }

    return { rawOutput: JSON.stringify(object, null, 2), posts: object.posts, images };
  }

  // Freeform / text outputs (articles, emails, social posts)
  const { text } = await generateText({
    model,
    system: agent.systemPrompt,
    prompt: `${context}\n\nProduce the requested content now.`,
  });
  events.push({ at: Date.now(), level: "success", message: "Generated content" });
  return { rawOutput: text, text, images: [] };
}

export interface TestRunResult {
  status: "ok" | "failed";
  outputKind: Agent["outputKind"];
  rawOutput: string;
  posts?: IGPost[];
  images?: (string | null)[];
  text?: string;
  events: JobRunEvent[];
  error?: string;
}

/**
 * Sandboxed test run: generates real content (and optionally real images) from
 * an ad-hoc agent config, but NEVER emails, saves assets, creates a Job, or
 * bumps run counts. Returns the output synchronously for inline preview.
 */
export async function testRunAgent(args: {
  agent: Agent;
  client: Client;
  input: Record<string, string>;
  withImages: boolean;
}): Promise<TestRunResult> {
  const { agent, client, input } = args;
  const events: JobRunEvent[] = [
    { at: Date.now(), level: "info", message: `Test run · “${agent.name || "Untitled"}” for ${client.name}` },
  ];
  const withImages =
    args.withImages && agent.capabilities.includes("generate_images") && imageGenConfigured();
  if (args.withImages && !withImages) {
    events.push({ at: Date.now(), level: "info", message: "Images skipped — enable “Generate images” and set SEGMIND_API_KEY" });
  }

  try {
    const result = await generateContent({
      agent,
      client,
      input,
      withImages,
      imageKeyPrefix: `test-${Date.now()}`,
      events,
    });
    return {
      status: "ok",
      outputKind: agent.outputKind,
      rawOutput: result.rawOutput,
      posts: result.posts,
      images: result.images,
      text: result.text,
      events,
    };
  } catch (e) {
    const error = e instanceof Error ? e.message : "Unknown error";
    events.push({ at: Date.now(), level: "error", message: `Test run failed: ${error}` });
    return { status: "failed", outputKind: agent.outputKind, rawOutput: "", events, error };
  }
}

type RunParams = {
  agentId: string;
  clientId: string;
  input: Record<string, string>;
  actor: AppUser;
  title?: string;
};

type PreparedJob =
  | { status: "failed"; jobId: string }
  | { status: "running"; jobId: string; agent: Agent; client: Client; events: JobRunEvent[] };

/** Resolve agent + client and persist the Job row synchronously. */
async function createPendingJob(params: RunParams): Promise<PreparedJob> {
  const { agentId, clientId, input, actor } = params;
  const now = Date.now();
  const events: JobRunEvent[] = [{ at: now, level: "info", message: "Job queued" }];

  const agent = await getAgent(agentId);
  const client = await getClient(clientId);
  if (!agent || !client) {
    const jobId = await createJob(baseJob({ agentId, clientId, agent, client, input, actor, now, events, status: "failed", error: "Agent or client not found" }));
    return { status: "failed", jobId };
  }

  events.push({ at: Date.now(), level: "info", message: `Running “${agent.name}” for ${client.name}` });
  const jobId = await createJob(
    baseJob({ agentId, clientId, agent, client, input, actor, now, events, status: "running" }),
  );
  return { status: "running", jobId, agent, client, events };
}

/**
 * Kick off an agent run WITHOUT blocking the request: create the job, return its
 * id immediately, then finish generation in the background via `after()` (the
 * platform keeps the function alive after the response is sent). The user can
 * navigate away; the job page reflects progress as events are written.
 */
export async function startAgentRun(params: RunParams): Promise<RunResult> {
  const prepared = await createPendingJob(params);
  if (prepared.status === "failed") return { jobId: prepared.jobId, status: "failed" };

  const { jobId, agent, client, events } = prepared;
  after(() => executeRun({ jobId, agent, client, input: params.input, actor: params.actor, events }));
  return { jobId, status: "running" };
}

/**
 * Execute an agent for a client synchronously. Persists a Job, generates
 * content, optionally creates assets and emails the client. Designed to never
 * throw — failures are recorded on the job.
 */
export async function runAgent(params: RunParams): Promise<RunResult> {
  const prepared = await createPendingJob(params);
  if (prepared.status === "failed") return { jobId: prepared.jobId, status: "failed" };
  const { jobId, agent, client, events } = prepared;
  return executeRun({ jobId, agent, client, input: params.input, actor: params.actor, events });
}

/** The heavy lifting: generation, assets, email. Updates the existing job. */
async function executeRun(args: {
  jobId: string;
  agent: Agent;
  client: Client;
  input: Record<string, string>;
  actor: AppUser;
  events: JobRunEvent[];
}): Promise<RunResult> {
  const { jobId, agent, client, input, actor, events } = args;
  const agentId = agent.id;
  const clientId = client.id;

  try {
    const wantsImages = agent.capabilities.includes("generate_images");
    if (wantsImages && !imageGenConfigured()) {
      events.push({ at: Date.now(), level: "error", message: "Image generation is on for this agent but SEGMIND_API_KEY is not set — skipped" });
    }

    const generated = await generateContent({
      agent,
      client,
      input,
      withImages: wantsImages && imageGenConfigured(),
      imageKeyPrefix: jobId,
      events,
    });

    const rawOutput = generated.rawOutput;
    const assetIds: string[] = [];

    if (agent.outputKind === "instagram_posts") {
      const object = { posts: generated.posts ?? [] };
      const images = generated.images;

      if (agent.capabilities.includes("create_assets")) {
        for (let i = 0; i < object.posts.length; i++) {
          const p = object.posts[i];
          const id = await createAsset({
            clientId,
            jobId,
            agentId,
            type: "instagram_post",
            title: `${agent.name} — Post ${i + 1}`,
            content: p.caption,
            meta: { hashtags: p.hashtags, imageConcept: p.imageConcept, callToAction: p.callToAction },
            imageUrl: images[i],
            status: "draft",
            createdBy: actor.uid,
            createdAt: Date.now(),
            updatedAt: Date.now(),
          });
          assetIds.push(id);
        }
        events.push({ at: Date.now(), level: "info", message: `Saved ${assetIds.length} assets to the library` });
      }

      // Email delivery
      let emailedTo: string | null = null;
      let status: Job["status"] = "review";
      if (agent.capabilities.includes("email_client")) {
        const to = client.contactEmail;
        if (to) {
          const body = object.posts
            .map(
              (p, i) => `
              <div style="margin-bottom:18px;padding-bottom:18px;border-bottom:1px solid #20303a;">
                <div style="color:#2dff9e;font-weight:600;margin-bottom:6px;">Post ${i + 1}</div>
                ${images[i] ? `<img src="${images[i]}" alt="Post ${i + 1} visual" style="width:100%;max-width:480px;border-radius:8px;margin-bottom:10px;display:block;" />` : ""}
                <div style="white-space:pre-wrap;margin-bottom:8px;">${escapeHtml(p.caption)}</div>
                <div style="color:#8aa2a8;font-size:13px;">${p.hashtags.map((h) => "#" + h).join(" ")}</div>
                <div style="color:#5f7177;font-size:12px;margin-top:6px;"><b>Visual:</b> ${escapeHtml(p.imageConcept)}</div>
              </div>`,
            )
            .join("");
          const res = await sendEmail({
            to,
            subject: `${object.posts.length} new Instagram posts for ${client.name}`,
            html: emailShell({
              clientName: client.name,
              heading: "Your new Instagram posts are ready",
              intro: "Here are fresh, on-brand posts drafted by your Karos team. Reply to approve or request edits.",
              body,
            }),
          });
          if (res.ok) {
            emailedTo = to;
            status = "delivered";
            events.push({ at: Date.now(), level: "success", message: `Emailed posts to ${to}` });
          } else {
            events.push({ at: Date.now(), level: "error", message: `Email failed: ${res.error}` });
          }
        } else {
          events.push({ at: Date.now(), level: "error", message: "No client contact email on file — skipped delivery" });
        }
      }

      await updateJob(jobId, { status, rawOutput, assetIds, emailedTo, events, updatedAt: Date.now() });
      await bumpAgentRun(agentId);
      return { jobId, status };
    }

    // Freeform / text outputs (articles, emails, social posts)
    const text = generated.text ?? "";

    if (agent.capabilities.includes("create_assets")) {
      const id = await createAsset({
        clientId,
        jobId,
        agentId,
        type: agent.outputKind === "article" ? "article" : agent.outputKind === "email" ? "email" : "social_post",
        title: input.topic || input.title || `${agent.name} output`,
        content: text,
        status: "draft",
        createdBy: actor.uid,
        createdAt: Date.now(),
        updatedAt: Date.now(),
      });
      assetIds.push(id);
    }

    let emailedTo: string | null = null;
    let status: Job["status"] = "review";
    if (agent.capabilities.includes("email_client") && client.contactEmail) {
      const res = await sendEmail({
        to: client.contactEmail,
        subject: `New ${agent.name} draft for ${client.name}`,
        html: emailShell({
          clientName: client.name,
          heading: `New ${agent.name} draft`,
          intro: "Your Karos team prepared this for you. Reply to approve or request edits.",
          body: `<div style="white-space:pre-wrap;">${escapeHtml(text)}</div>`,
        }),
      });
      if (res.ok) {
        emailedTo = client.contactEmail;
        status = "delivered";
        events.push({ at: Date.now(), level: "success", message: `Emailed draft to ${client.contactEmail}` });
      } else {
        events.push({ at: Date.now(), level: "error", message: `Email failed: ${res.error}` });
      }
    }

    await updateJob(jobId, { status, rawOutput, assetIds, emailedTo, events, updatedAt: Date.now() });
    await bumpAgentRun(agentId);
    return { jobId, status };
  } catch (e) {
    const message = e instanceof Error ? e.message : "Unknown error";
    events.push({ at: Date.now(), level: "error", message: `Run failed: ${message}` });
    await updateJob(jobId, { status: "failed", error: message, events, updatedAt: Date.now() });
    return { jobId, status: "failed" };
  }
}

function baseJob(args: {
  agentId: string;
  clientId: string;
  agent: Agent | null;
  client: Client | null;
  input: Record<string, string>;
  actor: AppUser;
  now: number;
  events: JobRunEvent[];
  status: Job["status"];
  error?: string;
}): Omit<Job, "id"> {
  return {
    clientId: args.clientId,
    agentId: args.agentId,
    agentName: args.agent?.name ?? "Unknown agent",
    title: `${args.agent?.name ?? "Agent"} · ${args.client?.name ?? "client"}`,
    status: args.status,
    input: args.input,
    assetIds: [],
    emailedTo: null,
    events: args.events,
    error: args.error ?? null,
    createdBy: args.actor.uid,
    assignedTo: args.actor.uid,
    createdAt: args.now,
    updatedAt: Date.now(),
  };
}

function escapeHtml(s: string) {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;");
}
