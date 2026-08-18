/**
 * Task Map dedup + capacity rules — pure and client-safe (no Firestore, no
 * server-only imports) so the board maths are unit-testable. The data layer
 * (getTaskBoardCapacity) fetches; everything here just computes.
 *
 * Duplicate policy (checked in order):
 *   1. Exact normalized-title match against ANY existing task (all statuses,
 *      completed included) — never recreate tracked or recently-finished work.
 *   2. Near-identical title (token Jaccard ≥ 0.85) against ACTIVE tasks —
 *      catches the same intent with slightly varied wording.
 *   3. Same productType + same platform scope against ACTIVE tasks created in
 *      the same ISO week — one "social_post for instagram" dispatch per week
 *      scope; a second is a duplicate intent even with a different title.
 *
 * Capacity policy: MAX_ACTIVE_TASKS bounds ACTIVE (pending / in_progress /
 * review_pending) KAROS-MANAGED tasks only. client_managed tasks never count
 * and are never blocked. `queueCapacitySkipNote` below is this same rule said
 * to the client, so widening either one without the other makes the portal lie.
 */

import { MAX_ACTIVE_TASKS } from "@/lib/constants";
import type { ClientTask, TaskStatus } from "@/lib/types";
import { inferTaskOwner } from "@/lib/task-owner";

/** Statuses that count against the per-client active-task cap. */
export const ACTIVE_TASK_STATUSES: TaskStatus[] = [
  "pending",
  "in_progress",
  "review_pending",
];

const ACTIVE = new Set<TaskStatus>(ACTIVE_TASK_STATUSES);

/** Owner inference — shared with the engine via task-owner.ts, not a copy. */
export { inferTaskOwner };

/** Normalize a task title to a canonical form for dedup comparison. */
export function normalizeTitleForDedup(title: string): string {
  return title
    .toLowerCase()
    .replace(/[^\w\s]/g, "")
    .replace(/\s+/g, " ")
    .trim();
}

/** Token-set Jaccard similarity of two normalized titles (0..1). */
export function titleSimilarity(a: string, b: string): number {
  const ta = new Set(normalizeTitleForDedup(a).split(" ").filter(Boolean));
  const tb = new Set(normalizeTitleForDedup(b).split(" ").filter(Boolean));
  if (ta.size === 0 || tb.size === 0) return 0;
  let shared = 0;
  for (const t of ta) if (tb.has(t)) shared++;
  return shared / (ta.size + tb.size - shared);
}

/** Similarity at or above this ⇒ same intent, different wording. */
export const TITLE_SIMILARITY_THRESHOLD = 0.85;

/** ISO-week scope key (UTC) — mirrors creditWeekKey's ISO-8601 semantics. */
export function taskWeekKey(ts: number): string {
  const d = new Date(ts);
  const day = d.getUTCDay() || 7;
  const thursday = Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate() + (4 - day));
  const isoYear = new Date(thursday).getUTCFullYear();
  const yearStart = Date.UTC(isoYear, 0, 1);
  const week = Math.ceil(((thursday - yearStart) / 86_400_000 + 1) / 7);
  return `${isoYear}-W${String(week).padStart(2, "0")}`;
}

export interface TaskCandidate {
  title: string;
  /** Managed product executor (ManagedTaskType), when the task runs one. */
  productType?: string;
  /** Custom-agent executor id, when the task runs one instead of a product. */
  customAgentId?: string;
  platform?: string;
}

/** The executor a candidate/task binds to, for the same-scope dedup tier. */
function executorKey(c: { productType?: string; customAgentId?: string }): string | null {
  return c.customAgentId ?? c.productType ?? null;
}
function taskExecutorKey(t: ClientTask): string | null {
  const custom = t.metadata?.customAgentId;
  const product = t.metadata?.productType;
  if (typeof custom === "string" && custom) return custom;
  if (typeof product === "string" && product) return product;
  return null;
}

/**
 * Duplicate check for one proposed task against the client's existing tasks.
 * Returns a human-readable reason (surfaced back to the copilot so it can
 * explain the skip) or null when the candidate is genuinely new.
 */
export function findDuplicateReason(
  candidate: TaskCandidate,
  existing: ClientTask[],
  now: number = Date.now(),
): string | null {
  const normalized = normalizeTitleForDedup(candidate.title);

  // 1. Exact normalized-title match — any status.
  if (existing.some((t) => normalizeTitleForDedup(t.title) === normalized)) {
    return "identical title already on the board";
  }

  const active = existing.filter((t) => ACTIVE.has(t.status));

  // 2. Near-identical wording against active tasks.
  const similar = active.find(
    (t) => titleSimilarity(candidate.title, t.title) >= TITLE_SIMILARITY_THRESHOLD,
  );
  if (similar) {
    return `near-identical to active task "${similar.title}"`;
  }

  // 3. Same executor (managed product OR custom agent) + platform scope in the
  //    same week window.
  const candidateExecutor = executorKey(candidate);
  if (candidateExecutor) {
    const week = taskWeekKey(now);
    const clash = active.find(
      (t) =>
        taskExecutorKey(t) === candidateExecutor &&
        (t.metadata?.platform ?? null) === (candidate.platform ?? null) &&
        taskWeekKey(t.createdAt) === week,
    );
    if (clash) {
      return `an active task for the same agent and ${candidate.platform ?? "channel"} scope already exists this week ("${clash.title}")`;
    }
  }

  return null;
}

/**
 * The ONE wording for "the cap stopped N of these from being created".
 *
 * WHICH QUEUE: the work KAROS runs — the cap counts active `karos_managed`
 * tasks and nothing else (see the capacity policy at the top of this file and
 * `computeBoardCapacity` below, which is where it is actually applied). Tasks
 * the client adds by hand are `client_managed`: they never count toward the cap
 * and are never blocked by it. So the sentence has to name whose queue is full,
 * and "your task queue is at its 15-task limit" — which is what consolidating
 * three spellings first produced — is FALSE for a client staring at a board of
 * twenty of their own tasks that the cap has no opinion about. The system
 * prompt tells the model the same scoped rule; this is that rule said to a
 * person, and the two must not disagree.
 *
 * Three surfaces composed this note themselves and wrote it three different
 * ways, all reaching a client: the copilot's `fetch_gmail_context` said
 * "N deferred - Karos-managed queue capacity reached", its `create_tasks` said
 * "N karos_managed dropped - AI queue capacity (15 active) reached", and the
 * swarm's persisted note — rendered verbatim in the war-room console inside the
 * CLIENT copilot dock — said "N deferred - queue at capacity". So one client
 * could be told three things about one rule, one of them naming a Firestore
 * enum, and all three with a spaced hyphen the client copy rules ban. Giving
 * them one home was right; the surviving sentence still has to be true at all
 * three sites, and one home makes a scope error worse, not better — it now
 * misstates the policy everywhere at once.
 *
 * It lives beside the cap's policy docstring above rather than in a copy module
 * because it is a sentence ABOUT that policy: whoever changes what the cap
 * counts is the person who has to restate it. Pure, so a test can read it.
 *
 * WHICH VERB, and the scope fix above did not settle this one. The sentence read
 * "Karos is already RUNNING its limit of 15 ACTIVE tasks for you", and two of the
 * three statuses the cap counts are not being run: `ACTIVE_TASK_STATUSES` is
 * pending / in_progress / review_pending, so a pending task is queued and nobody
 * has started it, and a review_pending one is finished work waiting on a human.
 * "Active" is the CODE's word for that set (the constant is named for it) and it
 * is not the client's — being told fifteen things are running while their board
 * shows one in progress is the same kind of false as naming the wrong queue.
 * "Open" is the property all three share and the only one this note can claim:
 * taken on, not yet closed. Completed and archived tasks are not counted, and
 * "open" excludes both.
 *
 * A FRAGMENT, not a sentence: all three callers drop it into a parenthesised
 * `(…; …)` list next to "N duplicates skipped", so it stays lowercase and
 * unpunctuated at the end.
 */
export function queueCapacitySkipNote(skipped: number): string {
  return `${skipped} not added — Karos already has its limit of ${MAX_ACTIVE_TASKS} open tasks for you`;
}

/**
 * Board capacity from a task snapshot: how many KAROS-MANAGED tasks are
 * active (client_managed is exempt — never counted, never blocked) plus the
 * normalized-title set for the exact-match dedup tier.
 */
export function computeBoardCapacity(tasks: ClientTask[]): {
  activeCount: number;
  existingTitles: Set<string>;
} {
  return {
    activeCount: tasks.filter(
      (t) => ACTIVE.has(t.status) && inferTaskOwner(t) === "karos_managed",
    ).length,
    existingTitles: new Set(tasks.map((t) => normalizeTitleForDedup(t.title))),
  };
}
