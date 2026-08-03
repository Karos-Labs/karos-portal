"use server";

import { revalidatePath } from "next/cache";
import { requireClientAccess } from "./_shared";
import { getCampaign, getClientTask } from "@/lib/data";
import { unmetCampaignDependencyTitles } from "@/lib/campaign-engine";
import { startTaskExecutionAction } from "./execution-actions";
import type { ClientTask } from "@/lib/types";

export type CampaignStepOutcome =
  | "dispatched"
  | "already_done"
  | "in_flight"
  | "waiting"
  | "error";

export interface CampaignStepResult {
  taskId: string;
  title: string;
  outcome: CampaignStepOutcome;
  error?: string;
}

/**
 * Resume a campaign run: dispatches every step that is eligible to execute
 * right now and leaves everything else untouched. A step already completed
 * or awaiting review is skipped outright — no re-execution, no re-charge.
 * A step still waiting on a dependency (e.g. the newsletter before the
 * anchor blog has a draft) is reported as "waiting", not attempted. Only
 * genuinely runnable steps (pending, deps satisfied) go through the normal
 * single-task start path, so charging/claim invariants are identical to a
 * manual per-task run — resuming a campaign is not a special, less-audited
 * door into execution.
 */
export async function resumeCampaignAction(
  campaignId: string,
  clientId: string,
): Promise<{ ok: boolean; error?: string; steps?: CampaignStepResult[] }> {
  try {
    await requireClientAccess(clientId);
  } catch {
    return { ok: false, error: "Forbidden" };
  }

  const campaign = await getCampaign(campaignId);
  if (!campaign || campaign.clientId !== clientId) {
    return { ok: false, error: "Campaign not found" };
  }

  const tasks = (
    await Promise.all(campaign.taskIds.map((id) => getClientTask(id)))
  ).filter((t): t is ClientTask => !!t);
  const tasksById = new Map(tasks.map((t) => [t.id, t]));

  const results: CampaignStepResult[] = [];
  for (const task of tasks) {
    if (task.status === "completed" || task.status === "review_pending") {
      results.push({ taskId: task.id, title: task.title, outcome: "already_done" });
      continue;
    }
    if (task.metadata?.executing === true || task.status === "in_progress") {
      results.push({ taskId: task.id, title: task.title, outcome: "in_flight" });
      continue;
    }
    const blockers = unmetCampaignDependencyTitles(task, tasksById);
    if (blockers.length > 0) {
      results.push({ taskId: task.id, title: task.title, outcome: "waiting" });
      continue;
    }
    const res = await startTaskExecutionAction(task.id, clientId);
    results.push(
      res.ok
        ? { taskId: task.id, title: task.title, outcome: "dispatched" }
        : { taskId: task.id, title: task.title, outcome: "error", error: res.error },
    );
  }

  revalidatePath(`/campaigns/${campaignId}`);
  revalidatePath("/calendar");
  return { ok: true, steps: results };
}
