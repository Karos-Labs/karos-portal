"use server";

/**
 * Carousel agent (v2) intake actions: the client's own configuration and the one
 * press that fires setup.
 *
 * ── ASK vs BUILD ──────────────────────────────────────────────────────────
 *
 * The visual system, the brand tokens, the slide templates and the topic
 * catalogue are all BUILT by setup from the client's own brand material. None of
 * it is asked here and none of it may be — a colour picker on this form would
 * put a second author on a file whose whole job is that every slide matches
 * every other slide.
 *
 * What is left is three things setup cannot derive: which account the slides are
 * for, how long the client wants a post to run, and what never to build one
 * about.
 *
 * NO SEATS AND NO ZOD. A carousel is posted from the company account, so every
 * write here is the `seatId: null` document. Validation is hand-written for the
 * same reason its five siblings' is: the parse and the CLEAR pass have to agree
 * on what "the client emptied this" means, and a schema that coerced a blank to
 * a default would silently keep a rule the client deleted.
 */

import { revalidatePath } from "next/cache";
import {
  clearAgentIntakeFields,
  getAgentIntake,
  getClient,
  getCustomAgentByKey,
  upsertAgentIntake,
} from "@/lib/data";
import { CAROUSEL_SETUP_KEY, clientSafeRunError } from "@/lib/custom-agent-launch";
import { submitCustomAgentJob } from "@/lib/jobs/submit-custom";
import { isBillableClientActor } from "@/lib/credits";
import { requireClientAccess } from "./_shared";

const MAX_TEXT = 2_000;
const MAX_BANNED_TOPICS = 40;
/** The band the manifest's renderer produces (8-10). Bounded either side of it. */
const MIN_SLIDES = 3;
const MAX_SLIDES = 20;

/** Banned subjects, one per line or comma-separated. Case preserved. */
function parseBannedTopics(raw: string): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const part of raw.split(/[\n,]/)) {
    const topic = part.trim();
    if (!topic) continue;
    const key = topic.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(topic);
    if (out.length >= MAX_BANNED_TOPICS) break;
  }
  return out;
}

/**
 * The handle, normalised to a bare `@name`.
 *
 * A client types `@acme`, `acme`, or the full profile URL meaning one thing, and
 * the caption signs off with whatever is stored. Returning `null` for something
 * unreadable rather than storing it keeps a URL fragment out of a public caption.
 */
function parseHandle(raw: string): string | null {
  const trimmed = raw.trim();
  if (!trimmed) return null;
  const name = trimmed
    .replace(/^https?:\/\/(www\.)?instagram\.com\//i, "")
    .replace(/^@/, "")
    .split(/[/?#\s]/)[0]
    .trim();
  // Instagram handles are letters, digits, dots and underscores.
  return /^[A-Za-z0-9._]{1,30}$/.test(name) ? `@${name}` : null;
}

/**
 * The slide count, or null for "let the agent decide".
 *
 * NULL IS THE BETTER ANSWER and the default. The context builder prints it as
 * "NOT SET, which is the default and the better one" rather than as a missing
 * value, so a run never reads silence as zero.
 */
function parseSlideCount(raw: string): number | null {
  const n = Number.parseInt(raw.trim(), 10);
  return Number.isInteger(n) && n >= MIN_SLIDES && n <= MAX_SLIDES ? n : null;
}

/* ─────────────────────────── the form ─────────────────────────── */

/**
 * Every answer is OPTIONAL, and saving the form satisfies the first rung of the
 * run gate. Same portal policy as the other five families: the run dialog renders
 * this form inline, so pressing Run the first time IS the form. The SECOND rung
 * (has setup produced a style config) decides whether a post can be built.
 */
export async function saveCarouselCompanyIntakeAction(input: {
  clientId: string;
  /** The Instagram account the slides are for. Label only, never a credential. */
  carouselHandle: string;
  /** "" = let the agent decide, which is the default and the better answer. */
  slideCount: string;
  /** Subjects never to build a carousel about. */
  bannedTopics: string;
}): Promise<{ error?: string }> {
  const user = await requireClientAccess(input.clientId);
  if (!(await getClient(input.clientId))) return { error: "Client not found." };
  for (const value of [input.carouselHandle, input.slideCount, input.bannedTopics]) {
    if (value.length > MAX_TEXT) {
      return { error: "Please keep each answer under 2,000 characters." };
    }
  }

  const handleRaw = input.carouselHandle.trim();
  const carouselHandle = parseHandle(input.carouselHandle);
  const countRaw = input.slideCount.trim();
  const slideCountPreference = parseSlideCount(input.slideCount);
  const bannedRaw = input.bannedTopics.trim();
  const bannedTopics = parseBannedTopics(input.bannedTopics);

  // An answer we cannot read is a misunderstanding, not a blank. Say so rather
  // than storing nothing: a dropped banned-subject list means building a
  // carousel about the thing the client told us not to, and publishing it to a
  // grid where it stays.
  if (handleRaw && !carouselHandle) {
    return {
      error: "We could not read that account name. Write it as @yourhandle.",
    };
  }
  if (countRaw && slideCountPreference === null) {
    return {
      error: `Pick a number of slides between ${MIN_SLIDES} and ${MAX_SLIDES}, or leave it empty and we choose per topic.`,
    };
  }
  if (bannedRaw && bannedTopics.length === 0) {
    return {
      error:
        "We could not read a subject in that list. Write one per line, or separate them with commas.",
    };
  }

  // The upsert MERGES, so an answer the client CLEARED would otherwise keep
  // steering every future post. Each condition keys on the RAW input being
  // blank, never on a parse result: keying the list on its parsed length would
  // turn an answer we failed to read into a delete, and the guards above only
  // hold while they and this drop agree on what "cleared" means.
  const existing = await getAgentIntake(input.clientId, "carousel", null);
  if (existing) {
    const drop: Array<"carouselHandle" | "slideCountPreference" | "bannedTopics"> = [];
    if (!handleRaw && existing.carouselHandle) drop.push("carouselHandle");
    // Cleared means "go back to letting the agent decide", which is a real
    // answer and the product default — so the field is DELETED rather than
    // written as null. Absent and null both read as "not set" downstream, and
    // deleting keeps the document from carrying a field nothing set.
    if (!countRaw && existing.slideCountPreference != null) drop.push("slideCountPreference");
    if (!bannedRaw && existing.bannedTopics?.length) drop.push("bannedTopics");
    await clearAgentIntakeFields(existing.id, drop);
  }

  await upsertAgentIntake({
    clientId: input.clientId,
    agent: "carousel",
    seatId: null,
    // No platform account on the shared identity field and no engagement roster.
    // `carouselHandle` is its own field precisely because it is a LABEL, not the
    // platform identity `handle` means for X, LinkedIn and Reddit — nothing
    // reads it, nothing posts with it.
    handle: null,
    roster: [],
    ...(carouselHandle ? { carouselHandle } : {}),
    ...(slideCountPreference !== null ? { slideCountPreference } : {}),
    ...(bannedTopics.length > 0 ? { bannedTopics } : {}),
    createdBy: user.uid,
  });
  revalidatePath(`/clients/${input.clientId}/carousel-agent`);
  // The agents page renders this form inline in the run dialog and derives the
  // run gate from the same document, so it goes stale on every write here.
  revalidatePath(`/clients/${input.clientId}/agents`);
  return {};
}

/* ─────────────────────────── the setup run ─────────────────────────── */

function setupPrompt(clientName: string): string {
  return [
    `Set up carousels for ${clientName}.`,
    "",
    "Run the setup skill end to end. Derive the visual system from their own brand",
    "material, build the slide templates, write the brand tokens every template",
    "reads, and seed the topic catalogue every future post draws from.",
    "",
    "DATA ONLY: no skill files, no per-client code, never a .mjs or .py.",
    "",
    "Render one sample template as the check that the system actually works. If",
    "the renderer is unavailable, record the sample check as NOT RUN rather than",
    "as passed — a style nobody rendered is a style nobody has seen.",
    "",
    "IF A TOPIC CATALOGUE ALREADY EXISTS, VERIFY IT, never re-seed it. Its rows",
    "record what has already been posted, and re-seeding would offer those topics",
    "again to a public grid.",
    "",
    "Do not build a carousel in this run. This is the setup.",
  ].join("\n");
}

/**
 * Fire setup for a client.
 *
 * Its own action rather than the client-agent launch flow, for the reason its
 * four siblings state: setup is a DIFFERENT SKILL in a different directory from
 * the runner, and that flow fires one agent doc and refuses a second launch with
 * "already live". Re-running setup is a normal act here — a rebrand changes every
 * token at once.
 */
export async function runCarouselSetupAction(input: {
  clientId: string;
}): Promise<{ jobId?: string; error?: string }> {
  const user = await requireClientAccess(input.clientId);
  const client = await getClient(input.clientId);
  if (!client) return { error: "Client not found." };

  const agent = await getCustomAgentByKey(CAROUSEL_SETUP_KEY);
  if (!agent || !agent.enabled) {
    return { error: "The carousel setup agent is not available. Your Karos team can enable it." };
  }
  // The submit core's own gate would also catch this, but its sentence explains
  // a gate rather than naming the one thing the reader has to do, and the form
  // is on the same page as the button they just pressed.
  if (!(await getAgentIntake(input.clientId, "carousel", null))) {
    return { error: "Save your carousel details below first, so setup knows your rules." };
  }

  const result = await submitCustomAgentJob(user, {
    agentId: agent.id,
    clientId: input.clientId,
    prompt: setupPrompt(client.name),
    runType: "launch",
  });

  if (result.jobId && !result.error) {
    revalidatePath(`/clients/${input.clientId}/carousel-agent`);
    revalidatePath(`/clients/${input.clientId}/agents`);
    revalidatePath("/jobs");
    return result;
  }
  // A billable client actor never reads the submit core's internal strings.
  if (result.error && isBillableClientActor(user)) {
    return { error: clientSafeRunError(result.error) };
  }
  return result;
}
