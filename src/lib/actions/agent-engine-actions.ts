"use server";

import { revalidatePath } from "next/cache";
import { getJob } from "@/lib/data";
import { resolveAgentEngineGate } from "@/lib/agent-engine/client";
import type { AgentEngineTemplateFeedback } from "@/lib/agent-engine/types";
import { requireStaff } from "./_shared";

const NOT_FOUND = "This run could not be found.";

/**
 * Approves or rejects an agent-engine run's currently-pending gate — the
 * Task 3 counterpart to the legacy agent-service flow's `ApprovePanel`
 * (which operates on already-completed `Asset`s, not a mid-run pause; a
 * mid-run human gate is a genuinely new concept this repo didn't have
 * before agent-engine). Calls agent-engine's own
 * `POST /api/v1/runs/:runId/resume` directly — this is a synchronous RPC,
 * not something that goes through Pub/Sub (dispatch is fire-and-forget; a
 * gate decision needs a real response to know whether it landed).
 */
export async function resolveAgentEngineGateAction(
  jobId: string,
  gateId: string,
  decision: "approve" | "revise" | "reject",
  notes?: string,
  /**
   * Per-slide design notes on the templates that rendered this output. Routed
   * by the engine to its template registry, where they move that template's
   * quality score and therefore which layouts later runs get.
   */
  templateFeedback?: AgentEngineTemplateFeedback[],
): Promise<{ error?: string }> {
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
    });
  } catch (e) {
    return { error: e instanceof Error ? e.message : "Failed to resolve the gate." };
  }

  revalidatePath(`/jobs/${jobId}`);
  return {};
}
