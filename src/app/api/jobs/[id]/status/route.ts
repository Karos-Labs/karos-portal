import { NextResponse } from "next/server";
import { requireUser } from "@/lib/auth";
import { getJob } from "@/lib/data";
import { readAgentEngineRun } from "@/lib/agent-engine/read-run";
import { isJobInProgress } from "@/lib/agent-engine/reconcile";

/**
 * SCRUM-265 item 1 — the "narrow status route" `AutoRefresh` polls from the
 * Job detail page instead of calling `router.refresh()` (a full re-render of
 * the whole route: `getClient`, every `getAsset` in the deliverables list,
 * the transcript fetch, the agent-engine run read) on every tick.
 *
 * Same staff-only scope as the page itself (`requireUser(["KAROS_ADMIN",
 * "KAROS_EMPLOYEE"])` in `src/app/(app)/jobs/[id]/page.tsx`) — this route
 * answers with the same "is it done yet" fact that page already computes and
 * gates its own `AutoRefresh` mount on, just without the rest of the page
 * around it.
 *
 * Deliberately read-only: unlike the page, this does NOT call
 * `scheduleAgentEngineJobStatusSync` — a poll every few seconds must not also
 * be a write path, and the page itself (plus the periodic reconcile sweep)
 * already owns persisting the transition once it happens.
 */
export async function GET(_req: Request, { params }: { params: Promise<{ id: string }> }) {
  await requireUser(["KAROS_ADMIN", "KAROS_EMPLOYEE"]);
  const { id } = await params;
  const job = await getJob(id);
  if (!job) return NextResponse.json({ error: "not found" }, { status: 404 });

  const view = job.agentEngineRunId ? await readAgentEngineRun(job.agentEngineRunId) : undefined;
  return NextResponse.json({ inProgress: isJobInProgress(job, view) });
}
