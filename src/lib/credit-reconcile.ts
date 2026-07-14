import "server-only";

import { adminDb } from "@/lib/firebase/admin";
import { applyCredit, defaultClientCredits } from "@/lib/credits";
import { newestUnrefundedCharge, refundEntryIdFor } from "@/lib/credit-reconcile-shared";
import type { ClientCredits, ClientTask, CreditLedgerEntry, Job } from "@/lib/types";

/**
 * Crash reconciliation for client-charged background work.
 *
 * Client users are charged credits UPFRONT, then the work runs deferred via
 * next/server `after()`. Two loss windows follow:
 *   1. the deferred run dies mid-flight (instance recycle, timeout) — the work
 *      is stuck "executing"/"running" forever and the charge is never refunded;
 *   2. an inline refund write fails — logged, but nothing retries it.
 *
 * The cron route /api/credits/reconcile sweeps both with the helpers here.
 * Each reconciliation is ONE Firestore transaction that releases the stuck
 * work AND refunds its charge together, so a crash between the two can't
 * strand a half-reconciled state, and re-running is always safe:
 *
 *   - The refund ledger doc id is deterministic — `refund_<chargeEntryId>` —
 *     and written with tx.create(), so a charge can be refunded at most once
 *     no matter how many sweeps, retries, or concurrent reconcilers run.
 *     (Keyed by charge entry, not jobId: the same task can be legitimately
 *     charged again on retry/adjustment, and each attempt pairs separately.)
 *   - The stuck check is re-verified inside the transaction, so work that
 *     completed between the sweep listing and the transaction is untouched.
 *
 * Lives outside data.ts deliberately: the credits section of data.ts is owned
 * by an in-flight change, and these helpers are cron-only (same precedent as
 * /api/cleanup-logs). Fold into data.ts's credits section when that settles.
 */

const db = () => adminDb();
const ledgerCol = () => db().collection("creditLedger");
const creditsCol = () => db().collection("clientCredits");
const tasksCol = () => db().collection("clientTasks");
const jobsCol = () => db().collection("jobs");

/** Actor stamped on reconciler-issued refund ledger entries. */
export const RECONCILER_ACTOR = { actorUid: "system", actorName: "Credit reconciler" } as const;

export type ReconcileResult = {
  action: "released" | "skipped";
  /** Why a skip happened, or what the release did. */
  detail: string;
  refunded: boolean;
  /** Credits handed back (present when refunded). */
  amount?: number;
  /** The charge ledger entry the refund paired with. */
  chargeEntryId?: string;
  clientId?: string;
};

/* ─────────────────────────── sweep listings ─────────────────────── */

/**
 * Client tasks claimed for a charged execution (`metadata.executing`) whose
 * last update predates `staleBefore`. Equality-only query + in-memory recency
 * filter — no composite index needed (same idiom as listStuckManagedJobs).
 *
 * Tasks dispatched to the agent service (metadata.externalJobId) are excluded:
 * their runs legitimately outlive the in-process staleness window, and the
 * webhook / agent-service reconciler own their resolution (including the task
 * release + refund via syncTaskForJobOutcome) — same split as jobs below.
 */
export async function listStuckTaskExecutions(staleBefore: number, limit = 25): Promise<ClientTask[]> {
  const snap = await tasksCol().where("metadata.executing", "==", true).get();
  return snap.docs
    .map((d) => ({ ...(d.data() as ClientTask), id: d.id }))
    .filter((t) => !t.metadata?.externalJobId)
    .filter((t) => (t.updatedAt ?? t.createdAt ?? 0) < staleBefore)
    .sort((a, b) => (a.updatedAt ?? 0) - (b.updatedAt ?? 0))
    .slice(0, limit);
}

/**
 * Extra staleness demanded before sweeping an agent-service job that never
 * recorded a serviceJobId. Almost always that means the submit crashed and the
 * service never saw the job — but a crash in the instant between a successful
 * submit and persisting its id leaves the run alive with a webhook coming
 * (matched via the metadata platform_job_id fallback). Waiting out the longest
 * run (35 min) plus webhook slack before failing it keeps that race
 * theoretical.
 */
export const UNSUBMITTED_AGENT_JOB_EXTRA_MS = 90 * 60 * 1000;

/**
 * Platform-local jobs stuck queued/running past `staleBefore`. Agent-service
 * jobs WITH a serviceJobId are excluded — /api/agent-service/reconcile owns
 * those (it polls the service, and custom-agent runs are refunded there).
 * Agent-service jobs WITHOUT one are included after a longer staleness: the
 * submit crashed before the service accepted the job, so no webhook will ever
 * terminalize it — and for a client-fired custom agent the upfront charge
 * would otherwise be stranded (charge happens between createJob and submit).
 */
export async function listStuckLocalJobs(staleBefore: number, limit = 25): Promise<Job[]> {
  const snap = await jobsCol().where("status", "in", ["queued", "running"]).get();
  return snap.docs
    .map((d) => ({ ...(d.data() as Job), id: d.id }))
    .filter((j) => {
      if (j.external?.serviceJobId) return false;
      const cutoff =
        j.agentId === "agent-service" ? staleBefore - UNSUBMITTED_AGENT_JOB_EXTRA_MS : staleBefore;
      return (j.updatedAt ?? j.createdAt ?? 0) < cutoff;
    })
    .sort((a, b) => (a.updatedAt ?? 0) - (b.updatedAt ?? 0))
    .slice(0, limit);
}

/* ─────────────────────── transactional refund ───────────────────── */

type StagedRefund = {
  charge: CreditLedgerEntry;
  amount: number;
  refundRef: FirebaseFirestore.DocumentReference;
  creditsRef: FirebaseFirestore.DocumentReference;
  current: ClientCredits;
};

/**
 * READ phase: locate the newest unpaired charge for `jobId` plus everything
 * the refund write needs. Returns null when there is nothing to refund
 * (never charged — e.g. staff-triggered or an autopilot batch charge without
 * a per-task jobId — or already refunded by a previous pass/inline refund).
 * Must run before any tx write (Firestore transactions read-then-write).
 */
async function readRefundableCharge(
  tx: FirebaseFirestore.Transaction,
  jobId: string,
  now: number,
): Promise<StagedRefund | null> {
  const chargesSnap = await tx.get(ledgerCol().where("jobId", "==", jobId));
  const entries = chargesSnap.docs.map((d) => ({ ...(d.data() as CreditLedgerEntry), id: d.id }));
  const charge = newestUnrefundedCharge(entries);
  if (!charge) return null;

  const refundRef = ledgerCol().doc(refundEntryIdFor(charge.id));
  const refundSnap = await tx.get(refundRef);
  if (refundSnap.exists) return null; // paired already (belt for the braces below)

  const creditsRef = creditsCol().doc(charge.clientId);
  const creditsSnap = await tx.get(creditsRef);
  const current = creditsSnap.exists
    ? (creditsSnap.data() as ClientCredits)
    : defaultClientCredits(charge.clientId, now);
  return { charge, amount: -charge.delta, refundRef, creditsRef, current };
}

/**
 * WRITE phase: hand the balance (and charge-window spend) back and append the
 * refund ledger entry. tx.create() on the deterministic id makes a concurrent
 * duplicate abort the whole transaction instead of double-refunding.
 */
function stageRefundWrites(
  tx: FirebaseFirestore.Transaction,
  staged: StagedRefund,
  reason: string,
  now: number,
): void {
  const next = applyCredit(staged.current, staged.amount, "refund", now, staged.charge.createdAt);
  tx.set(staged.creditsRef, next);
  tx.create(staged.refundRef, {
    id: staged.refundRef.id,
    clientId: staged.charge.clientId,
    delta: staged.amount,
    balanceAfter: next.balance,
    kind: "refund",
    operation: staged.charge.operation,
    reason,
    agentId: staged.charge.agentId ?? null,
    jobId: staged.charge.jobId ?? null,
    ...RECONCILER_ACTOR,
    createdAt: now,
  } satisfies CreditLedgerEntry);
}

/**
 * Refund the newest unpaired charge for `jobId`, if any — used when a
 * client-charged agent-service job terminates without deliverables (failed /
 * cancelled / dead-lettered webhook, or the agent-service reconciler flips a
 * stuck job). No-op for staff-fired runs (never charged). Same idempotency
 * contract as the sweeps: deterministic refund_<chargeEntryId> id via
 * tx.create(), so webhook redelivery or a concurrent sweep can't double-pay.
 */
export async function refundJobCharge(
  jobId: string,
  reason: string,
): Promise<{ refunded: boolean; amount?: number; chargeEntryId?: string }> {
  return db().runTransaction(async (tx) => {
    const now = Date.now();
    const staged = await readRefundableCharge(tx, jobId, now);
    if (!staged) return { refunded: false };
    stageRefundWrites(tx, staged, reason, now);
    return { refunded: true, amount: staged.amount, chargeEntryId: staged.charge.id };
  });
}

/* ─────────────────────────── reconcilers ────────────────────────── */

/**
 * Release one stuck task execution and refund its charge, atomically.
 * Skips (without touching anything) when the task finished in the meantime
 * or isn't actually stale — both re-checked inside the transaction.
 */
export async function reconcileStuckTaskExecution(
  taskId: string,
  staleBefore: number,
): Promise<ReconcileResult> {
  return db().runTransaction(async (tx) => {
    const now = Date.now();
    const taskRef = tasksCol().doc(taskId);
    const taskSnap = await tx.get(taskRef);
    if (!taskSnap.exists) return { action: "skipped", detail: "task deleted", refunded: false };
    const task = taskSnap.data() as ClientTask;
    if (task.metadata?.executing !== true) {
      return { action: "skipped", detail: "no longer executing", refunded: false };
    }
    if (task.metadata?.externalJobId) {
      return {
        action: "skipped",
        detail: "dispatched to the agent service — webhook/agent-service reconciler owns it",
        refunded: false,
      };
    }
    if ((task.updatedAt ?? task.createdAt ?? 0) >= staleBefore) {
      return { action: "skipped", detail: "updated since sweep — not stale", refunded: false };
    }

    const staged = await readRefundableCharge(tx, taskId, now);

    if (staged) {
      stageRefundWrites(
        tx,
        staged,
        `Auto-refund · execution stuck, task released · ${(task.title ?? taskId).slice(0, 80)}`,
        now,
      );
    }
    // Mirror runTaskExecution's failure idiom: back to pending, error surfaced
    // on the card, retryable (a retry charges again — a fresh ledger entry).
    tx.update(taskRef, {
      status: "pending",
      metadata: {
        ...(task.metadata ?? {}),
        executing: false,
        executionError:
          "Execution was interrupted (server restart or timeout)." +
          (staged ? " Credits were refunded — run it again." : " Run it again."),
      },
      updatedAt: now,
    });
    return {
      action: "released",
      detail: staged ? "released + refunded" : "released (no unpaired charge — not client-charged)",
      refunded: !!staged,
      ...(staged ? { amount: staged.amount, chargeEntryId: staged.charge.id } : {}),
      clientId: task.clientId,
    };
  });
}

/**
 * Fail one stuck platform-local job and refund its charge, atomically.
 * Covers legacy local agent runs and agent-service jobs whose submit crashed
 * before the service accepted them (no serviceJobId — the client-charged
 * custom-agent case). Jobs the service actually accepted never reach here
 * (filtered by the sweep + re-checked in-transaction): the agent-service
 * reconciler owns those.
 */
export async function reconcileStuckJob(jobId: string, staleBefore: number): Promise<ReconcileResult> {
  return db().runTransaction(async (tx) => {
    const now = Date.now();
    const jobRef = jobsCol().doc(jobId);
    const jobSnap = await tx.get(jobRef);
    if (!jobSnap.exists) return { action: "skipped", detail: "job deleted", refunded: false };
    const job = jobSnap.data() as Job;
    if (job.status !== "queued" && job.status !== "running") {
      return { action: "skipped", detail: `already ${job.status}`, refunded: false };
    }
    if (job.external?.serviceJobId) {
      return { action: "skipped", detail: "submitted to the service — agent-service reconciler owns it", refunded: false };
    }
    const cutoff =
      job.agentId === "agent-service" ? staleBefore - UNSUBMITTED_AGENT_JOB_EXTRA_MS : staleBefore;
    if ((job.updatedAt ?? job.createdAt ?? 0) >= cutoff) {
      return { action: "skipped", detail: "updated since sweep — not stale", refunded: false };
    }

    const staged = await readRefundableCharge(tx, jobId, now);

    if (staged) {
      stageRefundWrites(
        tx,
        staged,
        `Auto-refund · run stuck, job failed · ${(job.title ?? jobId).slice(0, 80)}`,
        now,
      );
    }
    tx.update(jobRef, {
      status: "failed",
      error: "Run was interrupted (server restart or timeout)." + (staged ? " Credits were refunded." : ""),
      events: [
        ...(job.events ?? []),
        {
          at: now,
          level: "error" as const,
          message: `Reconciled by credit sweep: stuck in ${job.status}${staged ? `, refunded ${staged.amount} credits` : ""}`,
        },
      ],
      updatedAt: now,
    });
    return {
      action: "released",
      detail: staged ? "failed + refunded" : "failed (no unpaired charge — not client-charged)",
      refunded: !!staged,
      ...(staged ? { amount: staged.amount, chargeEntryId: staged.charge.id } : {}),
      clientId: job.clientId,
    };
  });
}
