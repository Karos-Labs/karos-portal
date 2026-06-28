import "server-only";

import { after } from "next/server";
import { anthropic } from "@ai-sdk/anthropic";
import { generateObject } from "ai";
import { z } from "zod";

import {
  getClient,
  getContentCatalog,
  getContentEngineConfig,
  listLedger,
  appendLedger,
  listJobs,
  createJob,
  updateJob,
  createAsset,
} from "@/lib/data";
import {
  DEFAULT_MODEL,
  loadClientContext,
  buildCachedMessages,
  logCacheUsage,
} from "@/lib/agents/run";
import type { AppUser, Client, Job, JobRunEvent } from "@/lib/types";
import { pickNext } from "./picker";
import { runQa } from "./qa";
import { sourceSlideImage, imageSourcingConfigured } from "./sourcing";
import type { CarouselSlide, ContentEngineConfig, PickResult, VoiceConfig } from "./types";

export interface ContentEngineRunResult {
  jobId: string;
  status: Job["status"];
}

const CE_AGENT_ID = "content-engine";
const CE_AGENT_NAME = "Content Engine";

/* -------------------------- prompt building -------------------------- */

/** The lintable voice rules, rendered for the model so it self-lints its draft. */
function voiceRulesText(v: VoiceConfig): string {
  const lines: string[] = ["# Hard voice rules (these are AUTO-REJECTED — never break them)"];
  if (v.tone) lines.push(`Tone: ${v.tone}`);
  const chars = v.bannedChars ?? {};
  const banned: string[] = [];
  if (chars.emoji ?? true) banned.push("no emoji");
  if (chars.exclamation ?? true) banned.push('no exclamation marks ("!")');
  if (chars.emDash ?? true) banned.push("no em-dash (— or ---)");
  if (chars.semicolon ?? false) banned.push("no semicolons");
  if (banned.length) lines.push(`Characters: ${banned.join("; ")}.`);
  lines.push(`Hashtags: exactly ${v.hashtags?.count ?? 2}, ${v.hashtags?.case ?? "lowercase"}, no "#" inside the headline copy.`);
  if (v.oneNumberPerPost) lines.push("Use at most ONE number across the whole post (the disclaimer's numbers do not count).");
  if (v.requiredDisclaimer) lines.push(`The caption MUST end with this EXACT disclaimer, verbatim: "${v.requiredDisclaimer}"`);
  if (v.bannedWords?.length) lines.push(`Banned words/phrases (never use, any inflection): ${v.bannedWords.join(", ")}.`);
  return lines.join("\n");
}

function buildSystemPrompt(config: ContentEngineConfig): string {
  return [
    "You are a senior content strategist producing an on-brand Instagram/TikTok carousel for a brand's content engine.",
    "Every slide must read as written by a human expert — concrete, specific, never generic or AI-sounding. Write for a stranger; lead with the value, never tease.",
    "Match the brand voice precisely. Produce the caption and slide copy in the brand's language.",
    "",
    voiceRulesText(config.voice),
  ].join("\n");
}

/** Allowed slide-role palette (hook ∪ payoff ∪ closer ∪ body, minus banned). */
function allowedRoles(config: ContentEngineConfig): string[] {
  const s = config.slides;
  const set = new Set<string>([...s.hookTypes, ...s.payoffTypes, ...s.closerTypes, "body"]);
  for (const b of s.bannedTypes) set.delete(b);
  return [...set];
}

function buildInstruction(pick: PickResult, config: ContentEngineConfig, extra?: string): string {
  const s = config.slides;
  const roles = allowedRoles(config);
  const anchors = JSON.stringify(pick.entry);
  return [
    `# This post`,
    `Topic: ${pick.displayName}`,
    `Format: ${pick.format}`,
    `Catalog entry (use any brand-specific fields present here): ${anchors}`,
    "",
    `Produce a single carousel of ${s.countMin}-${s.countMax} slides — let the story decide the count, never pad.`,
    `Allowed slide roles: ${roles.join(", ")}.`,
    `Slide 1 role must be one of: ${s.hookTypes.join(", ")}.`,
    s.payoffTypes.length ? `At least one slide must use a payoff role: ${s.payoffTypes.join(", ")}.` : "",
    s.closerTypes.length ? `The last slide must close with substance, role one of: ${s.closerTypes.join(", ")}.` : "",
    `Each slide's imageConcept is an art-direction brief (photographic, on-brand, no text overlays / logos / watermarks) — it is NOT shown as copy.`,
    extra ? `\n# Fix these QA failures from the previous draft\n${extra}` : "",
  ]
    .filter(Boolean)
    .join("\n");
}

function carouselSchema(config: ContentEngineConfig) {
  const roles = allowedRoles(config);
  return z.object({
    slides: z
      .array(
        z.object({
          role: z.string().describe(`Slide role — MUST be one of: ${roles.join(", ")}.`),
          headline: z.string().describe("Short, on-brand headline / hook for this slide (published copy)."),
          body: z.string().nullable().optional().describe("Supporting body copy, or null for a headline-only slide."),
          imageQuery: z
            .string()
            .describe(
              "Concise English search keywords (2-6 words) for a REAL stock photo that fits this slide — concrete subject + setting, photographic and on-brand (e.g. 'brazilian real banknotes close up', 'analyst reviewing financial charts'). No brand names, no on-image text. English yields the best stock results even for a non-English brand.",
            ),
        }),
      )
      // No .min()/.max(): @ai-sdk/anthropic downgrades array bounds to
      // description-only, so a strict client-side bound would just throw
      // NoObjectGeneratedError on an out-of-range count. The QA count gate
      // (with its one regen pass) enforces the bounds gracefully instead.
      .describe(`The carousel slides, in order (${config.slides.countMin}-${config.slides.countMax} slides).`),
    caption: z.string().describe("The full post caption in the brand's language."),
    hashtags: z.array(z.string()).describe("Hashtags WITHOUT the # symbol."),
  });
}

type Carousel = z.infer<ReturnType<typeof carouselSchema>>;

/* ----------------------------- generation ---------------------------- */

async function generateCarousel(args: {
  client: Client;
  config: ContentEngineConfig;
  pick: PickResult;
  events: JobRunEvent[];
  retryFailures?: string[];
}): Promise<Carousel> {
  const { client, config, pick, events, retryFailures } = args;
  const ctx = await loadClientContext(client.id, events);

  const stableParts = [`# Client\nName: ${client.name}`];
  if (client.industry) stableParts.push(`Industry: ${client.industry}`);
  if (client.website) stableParts.push(`Website: ${client.website}`);
  if (client.brandVoice) stableParts.push(`\n# Brand Voice (follow precisely)\n${client.brandVoice}`);
  const stableContext = stableParts.join("\n") + ctx.text;

  const { object, providerMetadata } = await generateObject({
    model: anthropic(DEFAULT_MODEL),
    schema: carouselSchema(config),
    messages: buildCachedMessages({
      systemPrompt: buildSystemPrompt(config),
      stableContext,
      mediaParts: ctx.mediaParts,
      instruction: buildInstruction(pick, config, retryFailures?.length ? retryFailures.join("\n") : undefined),
    }),
  });
  logCacheUsage(events, providerMetadata);
  return object;
}

/** Strip leading '#' and whitespace from model-supplied hashtags. */
function normalizeHashtags(tags: string[]): string[] {
  return tags.map((t) => t.replace(/^#+/, "").trim()).filter(Boolean);
}

/**
 * Ensure the caption ends with the verbatim required disclaimer (safety net for
 * the QA gate). With requireDisclaimerOnNumber (XO), a number-free post is exempt
 * — matching qa.py's qa.require_disclaimer_on_number behavior.
 */
function withDisclaimer(caption: string, voice: VoiceConfig, postHasNumber: boolean): string {
  const disc = voice.requiredDisclaimer;
  if (!disc) return caption;
  if (voice.requireDisclaimerOnNumber && !postHasNumber) return caption;
  return caption.includes(disc) ? caption : `${caption.trim()}\n\n${disc}`;
}

/** Whether posted copy (caption + slide text + hashtags) states a number, excluding the disclaimer's own digits. */
function postStatesNumber(carousel: Carousel, hashtags: string[], voice: VoiceConfig): boolean {
  const parts = [carousel.caption, ...carousel.slides.flatMap((s) => [s.headline, s.body ?? ""]), ...hashtags];
  let joined = parts.join("\n");
  if (voice.requiredDisclaimer) joined = joined.split(voice.requiredDisclaimer).join(" ");
  return /\d/.test(joined);
}

/** Normalize a freshly generated carousel: null-safe slides, clean hashtags, conditional disclaimer. */
function normalizeCarousel(carousel: Carousel, config: ContentEngineConfig): { slides: CarouselSlide[]; caption: string; hashtags: string[] } {
  const slides: CarouselSlide[] = carousel.slides.map((s) => ({ ...s, body: s.body ?? null, imageUrl: null, attribution: null }));
  const hashtags = normalizeHashtags(carousel.hashtags);
  const caption = withDisclaimer(carousel.caption, config.voice, postStatesNumber(carousel, hashtags, config.voice));
  return { slides, caption, hashtags };
}

/* ------------------------------- driver ------------------------------ */

/**
 * Kick off a content-engine run WITHOUT blocking the request: resolve the
 * client/config/catalog, pick the next topic, persist a Job, and finish
 * generation in the background via after() — mirrors startAgentRun.
 */
export async function startContentEngineRun(params: {
  clientId: string;
  format?: string | null;
  actor: AppUser;
}): Promise<ContentEngineRunResult> {
  const now = Date.now();
  const events: JobRunEvent[] = [{ at: now, level: "info", message: "Content-engine run queued" }];

  const [client, config, catalog] = await Promise.all([
    getClient(params.clientId),
    getContentEngineConfig(params.clientId),
    getContentCatalog(params.clientId),
  ]);

  const fail = async (error: string): Promise<ContentEngineRunResult> => {
    events.push({ at: Date.now(), level: "error", message: error });
    const jobId = await createJob(baseJob({ clientId: params.clientId, client, actor: params.actor, now, events, status: "failed", input: {}, error }));
    return { jobId, status: "failed" };
  };

  if (!client) return fail("Client not found");
  if (!config || !catalog) {
    return fail(`Content engine is not configured for ${client.name}. Run the seed script (scripts/seed-content-engine.ts) first.`);
  }

  // Lightweight concurrency guard: the ledger read-then-append isn't atomic, so
  // two in-flight runs for one client could pick the same subject. Reject a new
  // run while one is queued/running. (Not fully atomic, but covers double-trigger.)
  const inFlight = (await listJobs({ clientId: params.clientId })).find(
    (j) => j.agentId === CE_AGENT_ID && (j.status === "running" || j.status === "queued"),
  );
  if (inFlight) return fail(`A content-engine run is already in progress for ${client.name} (job ${inFlight.id}).`);

  const ledger = await listLedger({ clientId: params.clientId });
  const pick = pickNext(catalog.entries, ledger, config.selection, { format: params.format ?? null });
  if (!pick) {
    return fail(params.format ? `No eligible topics left for format "${params.format}".` : "No eligible topics left (catalog exhausted for the cooldown window).");
  }

  events.push({ at: Date.now(), level: "info", message: `Picked “${pick.displayName}” (${pick.format}, viability ${pick.viability})` });
  const input: Record<string, string> = { subjectKey: pick.subjectKey, format: pick.format, topic: pick.displayName };
  const jobId = await createJob(
    baseJob({
      clientId: params.clientId,
      client,
      actor: params.actor,
      now,
      events,
      status: "running",
      input,
      title: `${CE_AGENT_NAME} · ${client.name} — ${pick.displayName}`,
    }),
  );

  after(() => executeContentEngineRun({ jobId, client, config, pick, actor: params.actor, events }));
  return { jobId, status: "running" };
}

/** The heavy lifting: generate, image, QA, save asset, advance the ledger. Never throws. */
async function executeContentEngineRun(args: {
  jobId: string;
  client: Client;
  config: ContentEngineConfig;
  pick: PickResult;
  actor: AppUser;
  events: JobRunEvent[];
}): Promise<ContentEngineRunResult> {
  const { jobId, client, config, pick, actor, events } = args;
  try {
    // 1) generate
    let carousel = await generateCarousel({ client, config, pick, events });
    events.push({ at: Date.now(), level: "success", message: `Generated ${carousel.slides.length} slides` });

    let { slides, caption, hashtags } = normalizeCarousel(carousel, config);

    // 2) QA (text-only) — one regeneration pass on failure, then surface residuals
    let qa = runQa({ slides, caption, hashtags, config });
    if (!qa.pass) {
      events.push({ at: Date.now(), level: "info", message: `QA found ${qa.failures.length} issue(s); regenerating once: ${qa.failures.join(" | ")}` });
      carousel = await generateCarousel({ client, config, pick, events, retryFailures: qa.failures });
      ({ slides, caption, hashtags } = normalizeCarousel(carousel, config));
      qa = runQa({ slides, caption, hashtags, config });
    }
    if (qa.pass) {
      events.push({ at: Date.now(), level: "success", message: "QA passed (text-only preflight)" });
    } else {
      events.push({ at: Date.now(), level: "error", message: `QA still failing — saved for review, NOT added to the ledger: ${qa.failures.join(" | ")}` });
    }

    // 3) images: pull REAL photos from the web (Pexels) per slide — never AI-generated.
    const imagesOn = imageSourcingConfigured();
    let imagesMade = 0;
    if (imagesOn) {
      for (let i = 0; i < slides.length; i++) {
        try {
          const sourced = await sourceSlideImage({ query: slides[i].imageQuery, key: `${jobId}-slide-${i}`, config });
          if (sourced) {
            slides[i].imageUrl = sourced.url;
            slides[i].attribution = sourced.attribution;
          } else {
            events.push({ at: Date.now(), level: "info", message: `Slide ${i + 1}: no real photo matched "${slides[i].imageQuery}"` });
          }
        } catch (e) {
          events.push({ at: Date.now(), level: "error", message: `Slide ${i + 1} image search failed: ${e instanceof Error ? e.message : "unknown"}` });
        }
      }
      imagesMade = slides.filter((s) => s.imageUrl).length;
      if (imagesMade === 0) {
        events.push({ at: Date.now(), level: "error", message: "No real photos matched any slide — not advancing the ledger so the topic can be retried" });
      } else {
        events.push({ at: Date.now(), level: "success", message: `${imagesMade}/${slides.length} slides matched a real photo (Pexels)` });
      }
    } else {
      events.push({ at: Date.now(), level: config.realImageryOnly ? "error" : "info", message: "PEXELS_API_KEY not set — cannot source real imagery; saved with copy + image queries but no photos" });
    }

    // 4) save one carousel Asset (reuses the instagram_post type/UI)
    const cover = slides.find((s) => s.imageUrl)?.imageUrl ?? null;
    const assetId = await createAsset({
      clientId: client.id,
      jobId,
      agentId: CE_AGENT_ID,
      type: "instagram_post",
      title: `${pick.displayName} (${pick.format})`,
      content: caption,
      meta: {
        source: "content-engine",
        format: pick.format,
        subjectKey: pick.subjectKey,
        viability: pick.viability,
        hashtags,
        disclaimer: config.voice.requiredDisclaimer ?? null,
        slides: slides.map((s) => ({
          role: s.role,
          headline: s.headline,
          body: s.body,
          imageUrl: s.imageUrl ?? null,
          imageQuery: s.imageQuery,
          attribution: s.attribution ?? null,
        })),
        imageCredits: slides.map((s) => s.attribution).filter(Boolean),
        qa: { pass: qa.pass, failures: qa.failures },
      },
      imageUrl: cover,
      status: "draft",
      createdBy: actor.uid,
      createdAt: Date.now(),
      updatedAt: Date.now(),
    });
    events.push({ at: Date.now(), level: "info", message: "Saved carousel asset to the library" });

    // 5) advance the ledger ONLY on a clean pass AND adequate imagery — a
    // failed/imageless draft stays retriable (topic not consumed). Imagery is
    // adequate when at least one real photo was sourced, OR when no source is
    // configured and the brand doesn't require real imagery.
    const imagesAdequate = imagesMade > 0 || (!imagesOn && !config.realImageryOnly);
    if (qa.pass && imagesAdequate) {
      await appendLedger({
        clientId: client.id,
        subjectKey: pick.subjectKey,
        displayName: pick.displayName,
        format: pick.format,
        vol: pick.nextVol,
        jobId,
        assetId,
        createdAt: Date.now(),
      });
      events.push({ at: Date.now(), level: "info", message: `Ledger advanced to vol ${pick.nextVol} — next run will pick a different subject` });
    }

    await updateJob(jobId, {
      status: "review",
      rawOutput: JSON.stringify({ ...carousel, caption, hashtags }, null, 2),
      assetIds: [assetId],
      events,
      updatedAt: Date.now(),
    });
    return { jobId, status: "review" };
  } catch (e) {
    const message = e instanceof Error ? e.message : "Unknown error";
    events.push({ at: Date.now(), level: "error", message: `Run failed: ${message}` });
    await updateJob(jobId, { status: "failed", error: message, events, updatedAt: Date.now() });
    return { jobId, status: "failed" };
  }
}

function baseJob(args: {
  clientId: string;
  client: Client | null;
  actor: AppUser;
  now: number;
  events: JobRunEvent[];
  status: Job["status"];
  input: Record<string, string>;
  title?: string;
  error?: string;
}): Omit<Job, "id"> {
  return {
    clientId: args.clientId,
    agentId: CE_AGENT_ID,
    agentName: CE_AGENT_NAME,
    title: args.title ?? `${CE_AGENT_NAME} · ${args.client?.name ?? "client"}`,
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
