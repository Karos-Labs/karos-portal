"use server";

import { revalidatePath } from "next/cache";
import { creditClientCredits, getJob } from "@/lib/data";
import { AgentEngineCredentialError, resolveAgentEngineGate } from "@/lib/agent-engine/client";
import type { AgentEngineReviewEdits, AgentEngineTemplateFeedback } from "@/lib/agent-engine/types";
import { requireStaff } from "./_shared";

const NOT_FOUND = "This run could not be found.";

/**
 * What rating a finished job pays.
 *
 * One, from the owner: *"it can give them one credit if they filled it in"*.
 * The number is small on purpose. It is not compensation for the reviewer's
 * time, it is an acknowledgement that the label has value to us — enough to
 * make rating feel worth the two seconds, not enough to make a client rate
 * posts they have not looked at.
 */
const RATING_REWARD_CREDITS = 1;

export interface ResolveAgentEngineGateOptions {
  decision: "approve" | "revise" | "reject";
  notes?: string;
  /**
   * Per-slide design notes on the templates that rendered this output. Routed
   * by the engine to its template registry, where they move that template's
   * quality score and therefore which layouts later runs get.
   */
  templateFeedback?: AgentEngineTemplateFeedback[];
  /**
   * In-place edits the reviewer made before deciding — applied verbatim by
   * the engine (re-rendered, delivered, and learned from).
   *
   * `caption`/`slides` are only sent with an `approve`: a redraft supersedes
   * hand edits, so this action drops them on `revise`/`reject` regardless of
   * what the UI included. `style` (IGSTYLE-6) is the exception — see
   * `AgentEngineStyleEdit`'s own doc comment for why a colour pick is
   * meaningful on `revise` too — so this action forwards it on BOTH
   * `approve` and `revise`, still never on `reject`.
   */
  edits?: AgentEngineReviewEdits;
  /**
   * The reviewer's 1-to-5 stars (RFC-22 §3.2). Optional on every decision.
   *
   * Forwarded to the engine, which stores it on the shipped post's record as
   * the label the visual judge is calibrated against. Filling it in earns the
   * client one credit — see `RATING_REWARD_CREDITS`.
   */
  rating?: number;
}

/**
 * Approves or rejects an agent-engine run's currently-pending gate — the
 * Task 3 counterpart to the legacy agent-service flow's `ApprovePanel`
 * (which operates on already-completed `Asset`s, not a mid-run pause; a
 * mid-run human gate is a genuinely new concept this repo didn't have
 * before agent-engine). Calls agent-engine's own
 * `POST /api/v1/runs/:runId/resume` directly — this is a synchronous RPC,
 * not something that goes through Pub/Sub (dispatch is fire-and-forget; a
 * gate decision needs a real response to know whether it landed).
 *
 * An options object rather than the previous five positional arguments —
 * `edits` made a sixth, and positional optionals past four are how a
 * `templateFeedback` ends up passed as a `notes`.
 */
export async function resolveAgentEngineGateAction(
  jobId: string,
  gateId: string,
  options: ResolveAgentEngineGateOptions,
): Promise<{ error?: string }> {
  const { decision, notes, templateFeedback, edits, rating } = options;
  const user = await requireStaff();
  const job = await getJob(jobId);
  if (!job || !job.agentEngineRunId) return { error: NOT_FOUND };

  // Enforced here as well as in the engine's schema, so a reviewer gets a
  // useful message in the UI instead of a 400 from a fetch they cannot see.
  // A revision request with nothing to act on is just a slower rejection.
  if (decision === "revise" && !notes?.trim()) {
    return { error: "Tell the agent what to change before requesting a revision." };
  }
  if (decision === "reject" && !notes?.trim()) {
    return { error: "A rejection needs a reason." };
  }
  // Checked here as well as in the engine's schema and the route's, for the
  // same reason the two above are: a reviewer gets a sentence instead of a 400
  // from a fetch they cannot see. A rating outside 1-5 is a bug in a caller,
  // never something a person clicked.
  if (rating !== undefined && (!Number.isInteger(rating) || rating < 1 || rating > 5)) {
    return { error: "A rating must be a whole number of stars from 1 to 5." };
  }
  const hasTextEdits = edits !== undefined && (edits.caption !== undefined || (edits.slides?.length ?? 0) > 0);
  // IGSTYLE-6, §2.5 point 3 — the split this whole ticket exists to fix: a
  // style pick is meaningful on `revise` as much as `approve` (it is the
  // instruction a redraft must not discard), while `caption`/`slides` stay
  // approve-only (a redraft supersedes hand-edited prose). Widened in
  // lockstep with the UI change that lets the Design block submit on
  // `revise` at all — one without the other and the pick is silently
  // dropped here, which is exactly the bug this ticket is closing.
  const hasStyleEdits = edits?.style !== undefined && Object.keys(edits.style).length > 0;

  try {
    await resolveAgentEngineGate(job.agentEngineRunId, gateId, {
      decision,
      actor: user.name,
      ...(notes ? { notes } : {}),
      // Sent as `feedback` too, which is the field the engine requires on a
      // `revise` and reads back into the next draft. `notes` alone would
      // arrive as a rejection `reason` and steer nothing.
      ...(notes ? { feedback: notes } : {}),
      ...(templateFeedback && templateFeedback.length > 0 ? { templateFeedback } : {}),
      // RFC-22 §3.2 — sent on EVERY decision, not just `approve`. A 1-star
      // `revise` is the most informative label the calibration set can hold.
      ...(rating !== undefined ? { rating } : {}),
      ...((hasTextEdits || hasStyleEdits) && decision === "approve" ? { edits } : {}),
      // On `revise`, only the style pick ships — never caption/slides, even
      // if the caller (a stale client, or a bug elsewhere) included them.
      ...(hasStyleEdits && decision === "revise" ? { edits: { style: edits!.style } } : {}),
    });
  } catch (e) {
    // SCRUM-330: the gate resolution never left this process — the portal could
    // not authenticate to agent-engine at all. Told apart from an engine-side
    // rejection deliberately: the reviewer's decision is intact and re-clicking
    // will not help, so say so rather than offering the usual "try again".
    if (e instanceof AgentEngineCredentialError) {
      console.error(`[agent-engine] gate "${gateId}" on job "${jobId}" was not sent: no ID token could be minted`, e);
      return { error: "Cannot reach the agent engine: this portal is not authenticated to it. Your decision was not sent — contact an administrator rather than retrying." };
    }
    return { error: e instanceof Error ? e.message : "Failed to resolve the gate." };
  }

  // ── THE CREDIT, PAID ONLY AFTER THE DECISION ACTUALLY LANDED. ──
  //
  // Deliberately after the `try`, so a rating that never reached the engine is
  // never paid for: the label is the thing being bought, and a credit granted
  // for a label that does not exist is just a giveaway with a confusing
  // reason line.
  //
  // `entryId` makes it idempotent on the JOB, which is what "one credit if
  // they filled it in" means. `creditClientCredits` reads the entry inside its
  // own transaction, so a double-clicked button, a retried server action and a
  // re-approved gate all settle to exactly one credit.
  if (rating !== undefined && job.clientId) {
    try {
      await creditClientCredits({
        clientId: job.clientId,
        amount: RATING_REWARD_CREDITS,
        kind: "grant",
        operation: "quality_rating",
        reason: `Thanks for rating this post ${rating}/5`,
        jobId,
        actorUid: user.uid,
        actorName: user.name,
        entryId: `rating-${jobId}`,
      });
    } catch (e) {
      // A failed reward must never look like a failed approval. The decision
      // is already through to the engine and the post is shipping; losing one
      // credit is a bookkeeping problem, and telling the reviewer their
      // approval failed would be a lie that makes them click it again.
      console.error(`[agent-engine] gate "${gateId}" on job "${jobId}": the rating landed but its credit did not`, e);
    }
  }

  revalidatePath(`/jobs/${jobId}`);
  return {};
}
