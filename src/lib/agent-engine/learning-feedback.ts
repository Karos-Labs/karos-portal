import "server-only";

import { middlewareBaseUrl, middlewareFetch, MiddlewareRequestError } from "./middleware-http";
import type { Asset, Client } from "@/lib/types";

/**
 * The other half of the loop: what the CLIENT did with the draft (C7 §2.3 /
 * SCRUM-462).
 *
 * Collection (see `learning-collect.ts`) teaches the next run what this run
 * drafted. This teaches it what happened to it — posted as written, posted
 * after edits, skipped and why. The edit pair is the single most useful signal
 * the loop has, because "what the client changed" is a direct statement about
 * voice that no amount of drafting can infer; the projection puts the last N
 * of these in front of the next draft (`feedbackForPrompt`).
 *
 * WITHOUT THIS, review is a dead end. Approving, editing and posting all landed
 * in Firestore fields the engine cannot see, so a client could correct the same
 * habit every week for a year and the agent would open with it again the next
 * morning.
 *
 * Best-effort throughout, exactly like collection: feedback is bookkeeping
 * about something that has already happened in the portal, and a control plane
 * that is down must never fail an approve, an edit or a "mark as posted".
 */

/** The platforms the loop keeps state for — the middleware's own `Platform`. */
const PLATFORM_BY_PRODUCT: Readonly<Record<string, LearningPlatform>> = {
  "x-agent": "x",
  "linkedin-agent": "linkedin",
  "reddit-agent": "reddit",
  "instagram-agent": "instagram",
  "tiktok-agent": "tiktok",
  "tiktok-clipping-agent": "tiktok",
  "tiktok-editing-agent": "tiktok",
  "tiktok-content-design-agent": "tiktok",
  // The editing agent under its old name. It mapped to no platform for its
  // whole life, on both sides of the wire, which is why every branded-shorts
  // run ever dispatched learned nothing and looked fine doing it.
  "branded-shorts-agent": "tiktok",
};

export type LearningFeedbackAction = "posted" | "posted_with_edits" | "skipped" | "change_requested" | "note";

/** The middleware's `Platform` — the five the learning store keeps state for. */
export type LearningPlatform = "x" | "linkedin" | "reddit" | "instagram" | "tiktok";

export function learningPlatformForProduct(productId: string | undefined): LearningPlatform | undefined {
  if (typeof productId !== "string") return undefined;
  return PLATFORM_BY_PRODUCT[productId];
}

export interface LearningFeedbackInput {
  action: LearningFeedbackAction;
  reason?: string;
  /** Required as a pair for `posted_with_edits`; the middleware refuses half an edit. */
  originalText?: string;
  finalText?: string;
  /** The seat or page this was for — free text, shown beside the row. */
  account?: string;
  actor?: string;
  at?: number;
}

/**
 * The run and platform behind an asset, or undefined when it did not come from
 * an agent-engine run on the loop.
 *
 * `meta.agentEngineRunId` is stamped by `materialize.ts` at asset creation and
 * is the engine's own run id — the same one collection sends, and the one the
 * subject row is keyed on. Attaching feedback to anything else would file it
 * against a run that does not exist.
 */
export function learningTargetForAsset(
  asset: Pick<Asset, "meta">,
): { runId: string; platform: LearningPlatform } | undefined {
  const meta = asset.meta ?? {};
  const runId = meta.agentEngineRunId;
  const productId = meta.agentEngineProductId;
  if (typeof runId !== "string" || typeof productId !== "string") return undefined;
  const platform = PLATFORM_BY_PRODUCT[productId];
  return platform ? { runId, platform } : undefined;
}

/**
 * `POST /clients/{slug}/learning/feedback`. Returns true when the control
 * plane accepted the event. Never throws.
 *
 * `sourceId` is what makes a double click, a retried server action or a
 * re-running sweep append one row rather than three — the middleware dedupes on
 * it and answers `duplicate: true`. Pass the most specific stable thing the
 * caller has; an asset id plus the action is ideal, and a run id plus the
 * action is the fallback.
 *
 * `runId` is optional by design. A client writing "this one didn't run, here's
 * why" from a batch view may not have an asset in hand, and a reason with no
 * run attached is still a voice lesson the next draft should carry. What it
 * cannot do without a run is move a subject row, which is why the callers that
 * HAVE a run should always pass it.
 */
export async function postLearningFeedback(
  client: Pick<Client, "agentsRepoSlug">,
  platform: LearningPlatform,
  input: LearningFeedbackInput & { runId?: string; sourceId?: string },
): Promise<boolean> {
  const slug = client.agentsRepoSlug;
  if (!slug) return false; // not an engine client; there is no learning store to write to
  if (!middlewareBaseUrl()) return false;

  // The middleware refuses half an edit with a 422. Downgrading here rather
  // than sending it means a missing original never costs us the fact that the
  // client posted at all — "posted" is still true and still worth recording.
  const action: LearningFeedbackAction =
    input.action === "posted_with_edits" && (!input.originalText || !input.finalText) ? "posted" : input.action;

  try {
    await middlewareFetch(`/clients/${encodeURIComponent(slug)}/learning/feedback`, {
      method: "POST",
      body: {
        platform,
        action,
        ...(input.runId ? { runId: input.runId } : {}),
        ...(input.account ? { account: input.account.slice(0, 200) } : {}),
        ...(input.reason ? { reason: input.reason.slice(0, 4000) } : {}),
        ...(action === "posted_with_edits"
          ? { originalText: input.originalText?.slice(0, 20000), finalText: input.finalText?.slice(0, 20000) }
          : {}),
        ...(input.actor ? { actor: input.actor.slice(0, 255) } : {}),
        at: new Date(input.at ?? Date.now()).toISOString(),
        ...(input.sourceId ? { sourceId: input.sourceId.slice(0, 200) } : {}),
      },
    });
    return true;
  } catch (e) {
    const detail = e instanceof MiddlewareRequestError ? `${e.status ?? "no response"}: ${e.detail}` : String(e);
    console.error(`[agent-engine] learning feedback (${action}) failed for ${slug}/${platform}: ${detail}`);
    return false;
  }
}

/** The asset-shaped call: resolves the platform and run from the asset's own provenance. */
export async function recordLearningFeedback(
  client: Pick<Client, "agentsRepoSlug">,
  asset: Pick<Asset, "id" | "meta">,
  input: LearningFeedbackInput,
): Promise<boolean> {
  const target = learningTargetForAsset(asset);
  if (!target) return false;
  return postLearningFeedback(client, target.platform, {
    ...input,
    runId: target.runId,
    sourceId: `${asset.id}:${input.action}`,
  });
}

/**
 * `PUT /clients/{slug}/learning/preferences` — the never-topics list and the
 * standing instructions a person maintains.
 *
 * A FULL REPLACEMENT, not an append, because that is what the endpoint is: the
 * caller reads the current list, adds to it and writes the whole thing back.
 * Sending only the new entry would silently delete the rest.
 *
 * Unlike feedback, this one reports its failure to the caller. A person who
 * types "never write about this again" and is told it was saved, when it was
 * not, will believe the agent ignored them the next time it does — so the UI
 * needs to be able to say the write did not land.
 */
export async function writeLearningPreferences(
  client: Pick<Client, "agentsRepoSlug">,
  preferences: { neverTopics?: string[]; standingInstructions?: string[]; updatedBy?: string },
): Promise<{ ok: true } | { ok: false; error: string }> {
  const slug = client.agentsRepoSlug;
  if (!slug) return { ok: false, error: "This client is not set up for agent runs." };
  if (!middlewareBaseUrl()) return { ok: false, error: "The control plane is not configured in this environment." };

  try {
    await middlewareFetch(`/clients/${encodeURIComponent(slug)}/learning/preferences`, {
      method: "PUT",
      body: {
        ...(preferences.neverTopics ? { neverTopics: preferences.neverTopics.slice(0, 200) } : {}),
        ...(preferences.standingInstructions
          ? { standingInstructions: preferences.standingInstructions.slice(0, 200) }
          : {}),
        ...(preferences.updatedBy ? { updatedBy: preferences.updatedBy } : {}),
      },
    });
    return { ok: true };
  } catch (e) {
    const detail = e instanceof MiddlewareRequestError ? e.detail || `HTTP ${e.status}` : String(e);
    return { ok: false, error: `Could not save preferences: ${detail}` };
  }
}

/**
 * `GET /clients/{slug}/learning/preferences`, for the read-modify-write above.
 * An empty object for a client who has never had any — the endpoint answers
 * that itself, so an error here means something is actually wrong.
 */
export async function readLearningPreferences(
  client: Pick<Client, "agentsRepoSlug">,
): Promise<{ neverTopics: string[]; standingInstructions: string[] } | undefined> {
  const slug = client.agentsRepoSlug;
  if (!slug || !middlewareBaseUrl()) return undefined;
  try {
    const body = (await middlewareFetch(`/clients/${encodeURIComponent(slug)}/learning/preferences`)) as {
      neverTopics?: unknown;
      standingInstructions?: unknown;
    };
    const list = (v: unknown): string[] => (Array.isArray(v) ? v.filter((x): x is string => typeof x === "string") : []);
    return { neverTopics: list(body?.neverTopics), standingInstructions: list(body?.standingInstructions) };
  } catch (e) {
    const detail = e instanceof MiddlewareRequestError ? `${e.status ?? "no response"}: ${e.detail}` : String(e);
    console.error(`[agent-engine] reading learning preferences failed for ${slug}: ${detail}`);
    return undefined;
  }
}

/**
 * The bridge from the three per-agent draft-review surfaces (X, LinkedIn,
 * Reddit) to the learning loop.
 *
 * Those surfaces are where a client actually says what happened to a draft, and
 * every one of them wrote to Firestore and stopped. That store is read by the
 * portal's own review pages and by nothing else: the engine cannot see it, so
 * "not posted — too salesy" was a sentence the agent never heard. This puts the
 * same event where the next run will read it.
 *
 * NOT A MOVE, A SECOND WRITE. The Firestore rows stay exactly as they are —
 * they back the portal's own history views, the client action list and the
 * X/LinkedIn/Reddit batch renderers, none of which read the control plane.
 *
 * `not_posted` maps to `skipped`: the loop's own vocabulary for "drafted and
 * not used", which is what moves the subject row out of `drafted` without
 * marking it posted.
 *
 * Best-effort and never throwing, like every other call in this file. The
 * client's feedback is already saved by the time this runs; failing their
 * submission because a control plane is down would lose the feedback entirely.
 */
export async function bridgeDraftFeedbackToLearning(input: {
  clientId: string;
  platform: LearningPlatform;
  action: "posted" | "posted_with_edits" | "not_posted" | "note" | "edit_request";
  assetId?: string;
  account?: string;
  originalText?: string;
  finalText?: string;
  reason?: string;
  actor?: string;
  at?: number;
}): Promise<void> {
  try {
    const { getAsset, getClient } = await import("@/lib/data");
    const client = await getClient(input.clientId);
    if (!client?.agentsRepoSlug) return;

    const asset = input.assetId ? await getAsset(input.assetId) : null;
    const target = asset ? learningTargetForAsset(asset) : undefined;
    // The loop's own vocabulary. `edit_request` is `change_requested`: the
    // client wants this draft reworked, which is a different lesson from
    // "posted it after fixing it myself" and must not be folded into the edit
    // pair — there is no final text yet.
    const action: LearningFeedbackAction =
      input.action === "not_posted" ? "skipped" : input.action === "edit_request" ? "change_requested" : input.action;

    await postLearningFeedback(client, target?.platform ?? input.platform, {
      action,
      ...(target?.runId ? { runId: target.runId } : {}),
      ...(input.account ? { account: input.account } : {}),
      ...(input.reason ? { reason: input.reason } : {}),
      ...(input.originalText ? { originalText: input.originalText } : {}),
      ...(input.finalText ? { finalText: input.finalText } : {}),
      ...(input.actor ? { actor: input.actor } : {}),
      ...(input.at ? { at: input.at } : {}),
      // Stable across a double submit: the same client saying the same thing
      // about the same draft is one row. Falls back to the run or the client
      // plus the minute when there is no asset — enough to stop a double click,
      // not so much that two genuinely different notes collapse into one.
      sourceId: input.assetId
        ? `${input.assetId}:${action}`
        : `${input.clientId}:${action}:${Math.floor((input.at ?? Date.now()) / 60_000)}`,
    });
  } catch (e) {
    console.error(`[agent-engine] bridging draft feedback to the learning loop failed:`, e);
  }
}
