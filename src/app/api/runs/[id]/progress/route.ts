import { NextResponse } from "next/server";

import { requireClientAccess } from "@/lib/actions/_shared";
import { readAgentEngineRunRecord } from "@/lib/agent-engine/read-run";
import { isJobInProgress, reconciledJobStatus } from "@/lib/agent-engine/reconcile";
import { getJob } from "@/lib/data";
import { runOutcome, type RunProgressView } from "@/lib/run-progress";
import { stepHeadline } from "@/lib/run-step-headline";

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
 * instead), not the engine run id, not the deliverable ids, and not engine step
 * ids: the current step is turned into client words here.
 *
 * It reads the run doc only (`readAgentEngineRunRecord`), not the full view:
 * the predicates below need `run`, the headline needs `run.currentStepId`, and
 * this is hit every four seconds per watched run.
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

  const run = job.agentEngineRunId ? await readAgentEngineRunRecord(job.agentEngineRunId) : undefined;
  const view = run ? { run } : undefined;
  // The WORD and the BOOLEAN come from the same mapping, so a run whose
  // `jobs` document has not caught up yet cannot be reported as still working
  // under a stopped spinner. See reconciledJobStatus.
  const status = reconciledJobStatus(job, view);
  const agentDone = run?.status === "awaiting_gate";
  const body: RunProgressView = {
    status,
    inProgress: isJobInProgress(job, view),
    ...(agentDone ? { agentDone: true } : {}),
    // While working: the engine's current step in client words; a run with no
    // engine behind it has no step to report, so it says it is working once it
    // is (rather than "Starting the run" for the whole run).
    ...(!agentDone && runOutcome(status) === "working"
      ? {
          headline: run
            ? stepHeadline(run.currentStepId)
            : status === "running"
              ? "Working on it"
              : stepHeadline(null),
        }
      : {}),
  };
  return NextResponse.json(body);
}
