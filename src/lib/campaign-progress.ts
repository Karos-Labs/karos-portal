import { taskIsExecuting } from "@/lib/task-status-copy";
import type { Campaign, ClientTask } from "@/lib/types";

/**
 * A CAMPAIGN'S STATE, READ OFF ITS OWN STEPS.
 *
 * §09 asks for a cross-channel campaign view: *"the function that fetches
 * campaigns is already written and unused, and there is a detail route with no
 * list page. One brief that spawns LinkedIn, X, Instagram and a newsletter
 * under one status strip."*
 *
 * The status strip is the part that needs a decision, and the decision is to
 * derive it rather than read `campaign.status`. That field is written when the
 * bundle is created and updated by the campaign engine, and its three values
 * (`planned` / `active` / `done`) cannot say the thing a reader of a LIST
 * actually needs: which of these is waiting for a person. A campaign whose
 * four tasks are all in review is `active`, and so is one whose first task is
 * still running.
 *
 * So the strip counts the steps. `campaign.status` stays what it is and is
 * still shown on the detail page; this is the derived summary the list needs.
 */

export interface CampaignProgress {
  total: number;
  done: number;
  /** Steps finished but waiting on a person — the reason a reader opens the list at all. */
  awaitingReview: number;
  running: number;
  /** A step that reported an execution error and is sitting in `pending`. */
  failed: number;
  /** Nothing has started yet. */
  notStarted: boolean;
}

export function campaignProgress(tasks: readonly ClientTask[]): CampaignProgress {
  let done = 0;
  let awaitingReview = 0;
  let running = 0;
  let failed = 0;
  for (const task of tasks) {
    if (task.status === "completed") done += 1;
    else if (task.status === "review_pending") awaitingReview += 1;
    else if (taskIsExecuting(task) || task.status === "in_progress") running += 1;
    // `Boolean(...)`, not a bare read inside the `&&`: `executionError` is a
    // DIAGNOSTIC, never client copy, and the boundary guard reads the AST to
    // keep it that way. Saying "truthiness" out loud is also what this line
    // means — the campaign list counts a failed step, it never prints why.
    else if (task.status === "pending" && Boolean(task.metadata?.executionError)) failed += 1;
  }
  return {
    total: tasks.length,
    done,
    awaitingReview,
    running,
    failed,
    notStarted: tasks.length > 0 && done + awaitingReview + running + failed === 0,
  };
}

/**
 * The one line under a campaign's title.
 *
 * Ordered by what a reader has to ACT on: a failure first, then work waiting
 * on them, then work in flight. "3 of 5 done" alone is a progress bar that
 * never asks for anything.
 */
export function describeCampaignProgress(progress: CampaignProgress): string {
  if (progress.total === 0) return "no steps — its tasks may have been removed";
  const parts: string[] = [];
  if (progress.failed > 0) parts.push(`${progress.failed} failed`);
  if (progress.awaitingReview > 0) parts.push(`${progress.awaitingReview} waiting for review`);
  if (progress.running > 0) parts.push(`${progress.running} running`);
  parts.push(`${progress.done} of ${progress.total} done`);
  return parts.join(" · ");
}

/** Which tone the row's badge takes. Same order of urgency as the sentence. */
export function campaignTone(progress: CampaignProgress): "warning" | "info" | "neon" | "success" | "neutral" {
  if (progress.failed > 0) return "warning";
  if (progress.awaitingReview > 0) return "info";
  if (progress.running > 0) return "neon";
  if (progress.total > 0 && progress.done === progress.total) return "success";
  return "neutral";
}

/** The campaigns a staff member can see, newest first, with their steps attached. */
export function campaignRows(
  campaigns: readonly Campaign[],
  tasksById: ReadonlyMap<string, ClientTask>,
): Array<{ campaign: Campaign; tasks: ClientTask[]; progress: CampaignProgress }> {
  return campaigns
    .map((campaign) => {
      // A task id on the campaign whose task is gone is dropped rather than
      // counted as missing work: the detail page does the same, and a deleted
      // task is not a step waiting for anybody.
      const tasks = campaign.taskIds.map((id) => tasksById.get(id)).filter((t): t is ClientTask => t !== undefined);
      return { campaign, tasks, progress: campaignProgress(tasks) };
    })
    .sort((a, b) => (b.campaign.createdAt ?? 0) - (a.campaign.createdAt ?? 0));
}
