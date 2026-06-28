import "server-only";

import { after } from "next/server";
import { anthropic } from "@ai-sdk/anthropic";
import { generateText, generateObject } from "ai";
import { z } from "zod";

import {
  getAgent,
  getAgentByLabsSkillId,
  getClient,
  listTranscripts,
  listContextItems,
  createJob,
  updateJob,
  createAsset,
  bumpAgentRun,
} from "@/lib/data";
import { sendEmail, emailShell } from "@/lib/email";
import { generatePostImage, imageGenConfigured } from "@/lib/images";
import { CONTEXT_CAPS } from "@/lib/context";
import { logger } from "@/services/logger";
import type { Agent, AppUser, Client, ContextItem, Job, JobRunEvent } from "@/lib/types";
import type { ImagePart, FilePart, TextPart, ModelMessage } from "@ai-sdk/provider-utils";

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
        useContextImage: z
          .number()
          .nullable()
          .describe(
            "1-based index of a provided client context image to use as THIS post's final visual " +
              "instead of generating one — set it when an existing client image fits the post better. " +
              "Use null to generate a fresh image from imageConcept.",
          ),
        referenceImages: z
          .array(z.number())
          .nullable()
          .describe(
            "1-based indices of provided client context images to use as VISUAL REFERENCES when " +
              "GENERATING this post's image (imageConcept) — the generator keeps those products, logos, " +
              "or styles consistent in the new visual. Use this to ground a fresh image in real brand " +
              "assets (e.g. put the client's actual product into a new scene). Up to 8. " +
              "Leave null/empty for a purely text-driven image. Ignored when useContextImage is set, " +
              "since that reuses an image as-is rather than generating.",
          ),
      }),
    )
    .describe("The generated Instagram posts."),
});

/**
 * Stable, cache-friendly context for a client + agent: client facts, brand
 * voice, and meeting transcripts. Deliberately excludes the per-request `input`
 * (see `buildRequestDetails`) so this prefix stays byte-identical across runs
 * and can be served from Anthropic's prompt cache.
 */
function buildContext(client: Client, agent: Agent, transcriptText: string) {
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
  return parts.join("\n");
}

/** The volatile per-request inputs — kept out of the cached prefix. */
function buildRequestDetails(input: Record<string, string>) {
  const inputLines = Object.entries(input)
    .filter(([, v]) => v?.toString().trim())
    .map(([k, v]) => `- ${k}: ${v}`)
    .join("\n");
  return inputLines ? `\n# Request details\n${inputLines}` : "";
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
  usage: { inputTokens: number; outputTokens: number };
}

type UserPart = TextPart | ImagePart | FilePart;

/**
 * Load a client's context library (always-on) and turn it into model input:
 * a text description (enumerated images + inlined text files) plus image/PDF
 * parts Claude reads natively. Returns the capped image list so the IG branch
 * can map a post's `useContextImage` index back to a URL.
 */
export async function loadClientContext(
  clientId: string,
  events: JobRunEvent[],
): Promise<{ text: string; mediaParts: UserPart[]; images: ContextItem[] }> {
  const all = await listContextItems({ clientId });
  if (all.length === 0) return { text: "", mediaParts: [], images: [] };

  const images = all.filter((i) => i.kind === "image").slice(0, CONTEXT_CAPS.images);
  const docs = all.filter((i) => i.kind === "document").slice(0, CONTEXT_CAPS.documents);
  const texts = all.filter((i) => i.kind === "text");

  const lines: string[] = ["\n# Client context (provided reference material)"];
  if (images.length) {
    lines.push("Reference images — cite indices in `referenceImages` to visually guide a GENERATED image (keeps the client's products/logos/style), or in `useContextImage` to use one as the final visual as-is:");
    images.forEach((it, i) => lines.push(`  ${i + 1}. ${it.name}${it.note ? ` — ${it.note}` : ""}`));
  }
  if (docs.length) {
    lines.push("Attached documents:");
    docs.forEach((it) => lines.push(`  - ${it.name} (PDF)${it.note ? ` — ${it.note}` : ""}`));
  }

  // Inline text files within a shared character budget.
  let budget = CONTEXT_CAPS.textChars;
  for (const it of texts) {
    if (budget <= 0) break;
    try {
      const res = await fetch(it.url);
      if (!res.ok) continue;
      const body = (await res.text()).slice(0, budget);
      budget -= body.length;
      lines.push(`\n--- ${it.name}${it.note ? ` (${it.note})` : ""} ---\n${body}`);
    } catch {
      // Skip unreadable text file.
    }
  }

  const mediaParts: UserPart[] = [
    ...images.map<ImagePart>((it) => ({ type: "image", image: new URL(it.url), mediaType: it.mimeType })),
    ...docs.map<FilePart>((it) => ({ type: "file", data: new URL(it.url), mediaType: "application/pdf", filename: it.name })),
  ];

  events.push({
    at: Date.now(),
    level: "info",
    message: `Included ${all.length} context item${all.length === 1 ? "" : "s"} (${images.length} image${images.length === 1 ? "" : "s"}, ${docs.length} PDF${docs.length === 1 ? "" : "s"}, ${texts.length} text)`,
  });

  return { text: lines.join("\n"), mediaParts, images };
}

/** Anthropic prompt-cache breakpoint marker (default 5-minute ephemeral cache). */
export const CACHE_CONTROL = { anthropic: { cacheControl: { type: "ephemeral" } } };

/**
 * Assemble a cache-friendly message set. Caching is a prefix match, so order
 * matters: stable content goes first (system prompt, then the client context
 * text and its images/PDFs) with a cache breakpoint on the last stable block,
 * and the volatile per-request instruction goes last where it can't invalidate
 * the cached prefix. Repeat runs for the same agent + client then reuse the
 * (often large) brand-voice / transcript / context-library tokens at ~10% of
 * input cost.
 */
export function buildCachedMessages(args: {
  systemPrompt: string;
  stableContext: string;
  mediaParts: UserPart[];
  instruction: string;
}): ModelMessage[] {
  const stableParts: UserPart[] = [
    { type: "text", text: args.stableContext },
    ...args.mediaParts,
  ];
  // Breakpoint on the last stable part caches the system prompt + everything
  // above it; the instruction that follows stays uncached.
  stableParts[stableParts.length - 1].providerOptions = CACHE_CONTROL;
  return [
    { role: "system", content: args.systemPrompt, providerOptions: CACHE_CONTROL },
    { role: "user", content: [...stableParts, { type: "text", text: args.instruction }] },
  ];
}

/** Surface prompt-cache reuse/writes on the job timeline for observability. */
export function logCacheUsage(events: JobRunEvent[], meta: Record<string, unknown> | undefined) {
  const a = meta?.anthropic as
    | { cacheReadInputTokens?: number; cacheCreationInputTokens?: number }
    | undefined;
  const read = a?.cacheReadInputTokens ?? 0;
  const written = a?.cacheCreationInputTokens ?? 0;
  if (read || written) {
    events.push({
      at: Date.now(),
      level: "info",
      message: `Prompt cache: ${read} tokens reused, ${written} written`,
    });
  }
}

/**
 * The reusable generation core: loads context (brand voice, transcripts, and the
 * client's uploaded files/images), runs the model, optionally generates images.
 * Performs NO persistence (no job/asset/email) — the only side effect is
 * uploading generated images to Storage so they get a URL. Both the real run
 * path (`executeRun`) and the sandboxed test path (`testRunAgent`) call this.
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

  const needsTranscripts = agent.capabilities.includes("use_transcripts");
  const [rawTranscripts, ctx] = await Promise.all([
    needsTranscripts ? listTranscripts({ clientId: client.id }) : Promise.resolve([]),
    loadClientContext(client.id, events),
  ]);
  const transcriptText = needsTranscripts
    ? rawTranscripts
        .slice(0, 3)
        .map((t) => `## ${t.title}\nSummary: ${t.summary ?? "(none)"}\nAction items: ${(t.actionItems ?? []).join("; ")}`)
        .join("\n\n")
    : "";
  const stableContext = `${buildContext(client, agent, transcriptText)}${ctx.text}`;
  const requestDetails = buildRequestDetails(input);
  const model = anthropic(agent.model || DEFAULT_MODEL);

  if (agent.outputKind === "instagram_posts") {
    const { object, usage: igUsage, providerMetadata } = await generateObject({
      model,
      schema: igSchema,
      messages: buildCachedMessages({
        systemPrompt: agent.systemPrompt,
        stableContext,
        mediaParts: ctx.mediaParts,
        instruction: `${requestDetails}\n\nProduce ${input.count || "3"} on-brand Instagram posts.`,
      }),
    });
    logCacheUsage(events, providerMetadata);
    events.push({ at: Date.now(), level: "success", message: `Generated ${object.posts.length} Instagram posts` });

    const images: (string | null)[] = new Array(object.posts.length).fill(null);
    for (let i = 0; i < object.posts.length; i++) {
      const idx = object.posts[i].useContextImage;
      // The model chose an existing client image — use it directly (no generation).
      if (idx != null && idx >= 1 && idx <= ctx.images.length) {
        images[i] = ctx.images[idx - 1].url;
        events.push({ at: Date.now(), level: "info", message: `Post ${i + 1}: used client image “${ctx.images[idx - 1].name}”` });
        continue;
      }
      if (withImages) {
        // Resolve the model-chosen reference indices → client image URLs (deduped, in range).
        const refUrls = [...new Set(object.posts[i].referenceImages ?? [])]
          .filter((n) => Number.isInteger(n) && n >= 1 && n <= ctx.images.length)
          .map((n) => ctx.images[n - 1].url);
        try {
          images[i] = await generatePostImage({
            concept: object.posts[i].imageConcept,
            key: `${imageKeyPrefix}-${i}`,
            referenceUrls: refUrls,
          });
          if (refUrls.length) {
            events.push({ at: Date.now(), level: "info", message: `Post ${i + 1}: generated from ${refUrls.length} client reference image${refUrls.length === 1 ? "" : "s"}` });
          }
        } catch (e) {
          const msg = e instanceof Error ? e.message : "Unknown error";
          events.push({ at: Date.now(), level: "error", message: `Image generation failed for post ${i + 1}: ${msg}` });
        }
      }
    }
    const generatedCount = images.filter(Boolean).length;
    if (generatedCount > 0) events.push({ at: Date.now(), level: "success", message: `${generatedCount} post${generatedCount === 1 ? "" : "s"} have a visual` });

    return { rawOutput: JSON.stringify(object, null, 2), posts: object.posts, images, usage: { inputTokens: igUsage.inputTokens ?? 0, outputTokens: igUsage.outputTokens ?? 0 } };
  }

  // Freeform / text outputs (articles, emails, social posts)
  const { text, usage: textUsage, providerMetadata } = await generateText({
    model,
    messages: buildCachedMessages({
      systemPrompt: agent.systemPrompt,
      stableContext,
      mediaParts: ctx.mediaParts,
      instruction: `${requestDetails}\n\nProduce the requested content now.`,
    }),
  });
  logCacheUsage(events, providerMetadata);
  events.push({ at: Date.now(), level: "success", message: "Generated content" });
  return { rawOutput: text, text, images: [], usage: { inputTokens: textUsage.inputTokens ?? 0, outputTokens: textUsage.outputTokens ?? 0 } };
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

/** Provenance key of the imported "full digital intelligence & competitive report" agent. */
export const INTEL_LABS_SKILL_ID = "karos-intel";

/**
 * Kick off the onboarding intelligence report for a freshly-created client. Best-effort and
 * never throws: resolves the imported `karos-intel` agent and starts a background run grounded
 * on the client's website. Returns null (a no-op) when the intel agent hasn't been imported yet
 * or the client can't be read — so it can't break the approval/creation flow that calls it.
 */
export async function startIntelReport(clientId: string, actor: AppUser): Promise<RunResult | null> {
  try {
    const [agent, client] = await Promise.all([
      getAgentByLabsSkillId(INTEL_LABS_SKILL_ID),
      getClient(clientId),
    ]);
    if (!agent || !client) return null;
    const focus = client.website ? `${client.name} — ${client.website}` : client.name;
    return await startAgentRun({
      agentId: agent.id,
      clientId: client.id,
      input: {
        topic: focus,
        notes:
          "Automated onboarding run. Produce the full digital intelligence and competitive report: " +
          "audit the company's website and digital footprint, map competitors and positioning, and surface opportunities.",
      },
      actor,
      title: `Onboarding intel · ${client.name}`,
    });
  } catch {
    return null;
  }
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
  const runStart = Date.now();

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

    logger.logUsage({
      clientId,
      agentId,
      agentName: agent.name,
      modelName: agent.model || DEFAULT_MODEL,
      operation: "agent_run",
      inputTokens: generated.usage.inputTokens,
      outputTokens: generated.usage.outputTokens,
      jobId,
      durationMs: Date.now() - runStart,
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
        type:
          agent.outputKind === "article"
            ? "article"
            : agent.outputKind === "email"
              ? "email"
              : agent.outputKind === "social_posts"
                ? "social_post"
                : "note",
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
    logger.logError({
      clientId,
      agentId,
      operation: "agent_run",
      errorMessage: message,
      stackTrace: e instanceof Error ? e.stack : undefined,
      severity: "ERROR",
    });
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
