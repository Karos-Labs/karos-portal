import { NextResponse } from "next/server";

import { requireClientAccess } from "@/lib/actions/_shared";
import { readAgentEngineRunProgress } from "@/lib/agent-engine/read-run";
import { isJobInProgress, reconciledJobStatus } from "@/lib/agent-engine/reconcile";
import { phaseProgress } from "@/lib/agent-run-phases";
import { getJob } from "@/lib/data";
import { runOutcome, type RunProgressView } from "@/lib/run-progress";

/**
 * The narrow "how is my run doing" endpoint, for the reader who started it.
 *
 * WHY IT IS NOT `/api/jobs/[id]/status`. That route exists and answers the same
 * "is it done yet" question, but it is `requireUser(["KAROS_ADMIN",
 * "KAROS_EMPLOYEE"])` - the same fence as the staff Job page it was built for.
 * A CLIENT_USER polling it gets redirected, which is why the run dialog could
 * only ever offer staff a way to look. Widening that route would have widened
 * the staff Job page's own contract; this is a second, narrower one.
 *
 * THE FENCE IS DERIVED FROM THE RESOURCE, not from the request. The client id
 * is read off the job and handed to `requireClientAccess`, so there is no
 * parameter a caller could supply to name a client they are not. That helper is
 * the same one every intake write goes through: staff pass the assignment
 * fence, a CLIENT_USER passes only for their own client.
 *
 * ONE ANSWER for "no such job" and "not your job", deliberately - the idiom
 * `requireClientAccess` states in its own file. A distinct 403 would turn this
 * route into an oracle for which job ids exist, and job ids are guessable
 * enough to matter.
 *
 * READ-ONLY, like the staff route: a poll every few seconds must not also be a
 * write path, so this does NOT call `scheduleAgentEngineJobStatusSync`. The
 * periodic reconcile sweep and the staff Job page already own persisting the
 * transition. What that costs is stated rather than hidden: for an
 * agent-engine job this reads the live run and reports the real state, so the
 * reader is never told a stale one - the `jobs` document catching up is a
 * separate, already-owned concern.
 *
 * WHAT CROSSES is `RunProgressView` and nothing else. Not `job.error` (an
 * internal string, and the client copy for a stopped run says what to do
 * instead), not the engine run id, not the deliverable ids — and not the
 * engine's step ids either: the phase is resolved HERE into the six client
 * words, so `07d-dedupe-check-attempt-1` never reaches a browser.
 *
 * THE LEAN READ (2026-09-10). This polled `readAgentEngineRun`, which reads
 * every step's `output` — the step's actual product, sometimes large — and the
 * gate payload, to answer a question that only ever needed the run doc: both
 * reconcile predicates read `view.run` and nothing else. An Instagram run
 * records 29 steps, and this route is hit every four seconds per watched run.
 * `readAgentEngineRunProgress` selects the three step fields the phase needs
 * and returns the run doc for the predicates.
 */
export async function GET(_req: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const job = await getJob(id);
  if (!job) return NextResponse.json({ error: "not found" }, { status: 404 });

  try {
    await requireClientAccess(job.clientId);
  } catch {
    return NextResponse.json({ error: "not found" }, { status: 404 });
  }

  const progress = job.agentEngineRunId
    ? await readAgentEngineRunProgress(job.agentEngineRunId)
    : undefined;
  const view = progress ? { run: progress.run } : undefined;
  // The WORD and the BOOLEAN come from the same mapping, so a run whose
  // `jobs` document has not caught up yet cannot be reported as still working
  // under a stopped spinner. See reconciledJobStatus.
  const status = reconciledJobStatus(job, view);
  const outcome = runOutcome(status);
  const body: RunProgressView = {
    status,
    inProgress: isJobInProgress(job, view),
    // The phase rides with the SAME answer, so "Writing the copy" can never sit
    // beside a ladder that says the run is in review. A stopped run gets none:
    // there is no honest phase for work that did not happen.
    ...(progress && outcome !== "stopped"
      ? {
          phase: phaseProgress({
            currentStepId: progress.currentStepId,
            currentStepKind: progress.currentStepKind,
            recordedStepIds: progress.recordedStepIds,
            finished: progress.run.status === "completed",
          }),
        }
      : {}),
  };
  return NextResponse.json(body);
}
