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
 * and are never blocked.
 */

import type { ClientTask, TaskOwner, TaskStatus } from "@/lib/types";

/** Statuses that count against the per-client active-task cap. */
export const ACTIVE_TASK_STATUSES: TaskStatus[] = [
  "pending",
  "in_progress",
  "review_pending",
];

const ACTIVE = new Set<TaskStatus>(ACTIVE_TASK_STATUSES);

/** Owner inference shared with the engine: manual source ⇒ client_managed. */
export function inferTaskOwner(task: Pick<ClientTask, "owner" | "source">): TaskOwner {
  return task.owner ?? (task.source === "manual" ? "client_managed" : "karos_managed");
}

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
