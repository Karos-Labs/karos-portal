"use server";

/**
 * Blog agent (v2) intake actions: the client's own configuration and the one
 * press that fires setup.
 *
 * ── ASK vs BUILD ──────────────────────────────────────────────────────────
 *
 * Everything editorial — the content pillars, the cluster map, the voice card,
 * the compliance patterns, the keyword targets — is BUILT by setup from the
 * client's own onboarding documents and existing posts. None of it is asked here
 * and none of it may be. The subjects themselves are not asked either, and that
 * is this agent's particular rule: the writer takes its subject from the
 * NEWSLETTER'S published handoff, never from a list anyone types.
 *
 * What is left is what research genuinely cannot reach: which domains count as
 * theirs for internal linking, where our reading of their voice is wrong,
 * who they think they are writing for, the subjects they will not touch, and
 * where they publish.
 *
 * THE BLOG HAS NO SEATS. Its one scope choice — company blog, an executive's
 * byline, or both — is a setup config field derived from the client's own
 * profile, not a per-person seat row. Every write here is the `seatId: null`
 * document, which is also the document the run gate reads.
 */

import { revalidatePath } from "next/cache";
import {
  clearAgentIntakeFields,
  getAgentIntake,
  getClient,
  getCustomAgentByKey,
  upsertAgentIntake,
} from "@/lib/data";
import { BLOG_SETUP_V2_KEY, clientSafeRunError } from "@/lib/custom-agent-launch";
import { submitCustomAgentJob } from "@/lib/jobs/submit-custom";
import { isBillableClientActor } from "@/lib/credits";
import { requireClientAccess } from "./_shared";

const MAX_TEXT = 2_000;
const MAX_DOMAINS = 20;
const MAX_BANNED_TOPICS = 40;

/**
 * A domain list, one per line or comma-separated.
 *
 * NORMALISED TO A BARE HOST, because the reader is a model deciding "is this
 * link the client's own site". A client types `https://acme.com/blog/` and
 * `acme.com` meaning one thing; leaving both forms in the list makes the agent
 * compare strings that do not match the URLs it is looking at. The scheme, the
 * `www.`, any path and any trailing slash come off; the host does not.
 */
function parseDomains(raw: string): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const part of raw.split(/[\n,\s]+/)) {
    const trimmed = part.trim();
    if (!trimmed) continue;
    const host = trimmed
      .replace(/^[a-z][a-z0-9+.-]*:\/\//i, "")
      .replace(/^www\./i, "")
      .split("/")[0]
      .toLowerCase()
      .replace(/\.$/, "");
    // A host needs a dot and no spaces. Anything else is prose the client typed
    // into the wrong box, and storing it would have the agent looking for a site
    // called "our main site".
    if (!host.includes(".") || /\s/.test(host)) continue;
    if (seen.has(host)) continue;
    seen.add(host);
    out.push(host);
    if (out.length >= MAX_DOMAINS) break;
  }
  return out;
}

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

/* ─────────────────────────── the form ─────────────────────────── */

/**
 * Every answer is OPTIONAL, and saving the form — even empty — satisfies the
 * first rung of the run gate. Same portal policy as the other four families: the
 * run dialog renders this form inline, so pressing Run the first time IS the
 * form. The SECOND rung (has setup produced a post index) is what actually
 * decides whether a writer run can start.
 */
export async function saveBlogCompanyIntakeAction(input: {
  clientId: string;
  /** Domains that count as the client's own, for internal linking. */
  internalDomains: string;
  /** A correction to the voice setup derived. */
  toneNote: string;
  /** Who the articles are for. */
  audienceNote: string;
  /** Subjects never to write about. */
  bannedTopics: string;
  /** Where they publish. */
  cmsName: string;
}): Promise<{ error?: string }> {
  const user = await requireClientAccess(input.clientId);
  if (!(await getClient(input.clientId))) return { error: "Client not found." };
  for (const value of [
    input.internalDomains,
    input.toneNote,
    input.audienceNote,
    input.bannedTopics,
    input.cmsName,
  ]) {
    if (value.length > MAX_TEXT) {
      return { error: "Please keep each answer under 2,000 characters." };
    }
  }

  const domainsRaw = input.internalDomains.trim();
  const internalDomains = parseDomains(input.internalDomains);
  const bannedRaw = input.bannedTopics.trim();
  const bannedTopics = parseBannedTopics(input.bannedTopics);

  // An answer we cannot read is a misunderstanding, not a blank. Say so rather
  // than storing nothing: a dropped domain list means the agent treats the
  // client's own site as a stranger's and stops linking to it, and a dropped
  // banned-subject list means writing about the thing they told us not to.
  if (domainsRaw && internalDomains.length === 0) {
    return {
      error:
        "We could not read a website in that list. Write them as addresses, like acme.com or blog.acme.com.",
    };
  }
  if (bannedRaw && bannedTopics.length === 0) {
    return {
      error: "We could not read a subject in that list. Write one per line, or separate them with commas.",
    };
  }

  // The upsert MERGES, so an answer the client CLEARED would otherwise keep
  // steering every future article. Each condition keys on the RAW input being
  // blank, never on a parse result: keying a list on its parsed length would turn
  // an answer we failed to read into a delete, and the guards above only hold
  // while they and this drop agree on what "cleared" means.
  const existing = await getAgentIntake(input.clientId, "blog", null);
  if (existing) {
    const drop: Array<"internalDomains" | "toneNote" | "audienceNote" | "bannedTopics" | "cmsName"> =
      [];
    if (!domainsRaw && existing.internalDomains?.length) drop.push("internalDomains");
    if (!input.toneNote.trim() && existing.toneNote) drop.push("toneNote");
    if (!input.audienceNote.trim() && existing.audienceNote) drop.push("audienceNote");
    if (!bannedRaw && existing.bannedTopics?.length) drop.push("bannedTopics");
    if (!input.cmsName.trim() && existing.cmsName) drop.push("cmsName");
    await clearAgentIntakeFields(existing.id, drop);
  }

  await upsertAgentIntake({
    clientId: input.clientId,
    agent: "blog",
    seatId: null,
    // No platform account and no engagement roster. Spelled rather than omitted
    // so the shared document never carries another family's leftovers on a client
    // who runs more than one agent.
    handle: null,
    roster: [],
    ...(internalDomains.length > 0 ? { internalDomains } : {}),
    ...(input.toneNote.trim() ? { toneNote: input.toneNote.trim() } : {}),
    ...(input.audienceNote.trim() ? { audienceNote: input.audienceNote.trim() } : {}),
    ...(bannedTopics.length > 0 ? { bannedTopics } : {}),
    ...(input.cmsName.trim() ? { cmsName: input.cmsName.trim() } : {}),
    createdBy: user.uid,
  });
  revalidatePath(`/clients/${input.clientId}/blog-agent`);
  // The agents page renders this form inline in the run dialog and derives the
  // run gate from the same document, so it goes stale on every write here.
  revalidatePath(`/clients/${input.clientId}/agents`);
  return {};
}

/* ─────────────────────────── the setup run ─────────────────────────── */

function setupPrompt(clientName: string): string {
  return [
    `Set up the blog agent for ${clientName}.`,
    "",
    "Run the setup skill end to end. Read their onboarding profile documents FIRST",
    "— they are the authority on what the business IS — then complete the blog's",
    "own tokens in the brand file ADDITIVELY, derive this client's compliance",
    "patterns into the field the gate already reads, build the cluster map, seed",
    "the post index, distil the voice card from their own existing posts, and",
    "write the one-time list of their pre-v2 posts so the site rebuild keeps them.",
    "",
    "NEVER rename or remove a field in the brand file. The still-live v1 engine,",
    "the newsletter v2 and the compliance lock all read that same file.",
    "",
    "If a post index already exists and holds rows, VERIFY it — never re-seed it.",
    "Those rows are articles that have already published, and re-seeding would",
    "hand the next run a number that is already used.",
    "",
    "Do not write or deliver an article in this run. This is the setup.",
  ].join("\n");
}

/**
 * Fire v2 setup for a client.
 *
 * Its own action rather than the client-agent launch flow, for the reason
 * `runLinkedInSetupAction` and `runNewsletterSetupAction` are: setup is a
 * DIFFERENT SKILL in a different directory from the writer, and that flow fires
 * one agent doc and refuses a second launch with "already live". Re-running setup
 * is a normal act here — the framework is written around a re-run that verifies
 * rather than re-seeds.
 */
export async function runBlogSetupAction(input: {
  clientId: string;
}): Promise<{ jobId?: string; error?: string }> {
  const user = await requireClientAccess(input.clientId);
  const client = await getClient(input.clientId);
  if (!client) return { error: "Client not found." };

  const agent = await getCustomAgentByKey(BLOG_SETUP_V2_KEY);
  if (!agent || !agent.enabled) {
    return { error: "The blog setup agent is not available. Your Karos team can enable it." };
  }
  // The submit core's own gate would also catch this, but its sentence explains a
  // gate rather than naming the one thing the reader has to do, and the form is
  // on the same page as the button they just pressed.
  if (!(await getAgentIntake(input.clientId, "blog", null))) {
    return { error: "Save your blog details below first, so setup knows your rules." };
  }

  const result = await submitCustomAgentJob(user, {
    agentId: agent.id,
    clientId: input.clientId,
    prompt: setupPrompt(client.name),
    runType: "launch",
  });

  if (result.jobId && !result.error) {
    revalidatePath(`/clients/${input.clientId}/blog-agent`);
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
