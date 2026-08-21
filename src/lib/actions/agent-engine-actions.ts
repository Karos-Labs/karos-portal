"use server";

import { revalidatePath } from "next/cache";
import { getJob } from "@/lib/data";
import { resolveAgentEngineGate } from "@/lib/agent-engine/client";
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
  decision: "approve" | "reject",
  notes?: string,
): Promise<{ error?: string }> {
  const user = await requireStaff();
  const job = await getJob(jobId);
  if (!job || !job.agentEngineRunId) return { error: NOT_FOUND };

  try {
    await resolveAgentEngineGate(job.agentEngineRunId, gateId, {
      decision,
      actor: user.name,
      ...(notes ? { notes } : {}),
    });
  } catch (e) {
    return { error: e instanceof Error ? e.message : "Failed to resolve the gate." };
  }

  revalidatePath(`/jobs/${jobId}`);
  return {};
}
