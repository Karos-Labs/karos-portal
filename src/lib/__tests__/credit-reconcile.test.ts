/* eslint-disable @typescript-eslint/no-explicit-any */
import { beforeEach, describe, expect, it, vi } from "vitest";
import { newestUnrefundedCharge, refundEntryIdFor } from "../credit-reconcile-shared";
import type { CreditLedgerEntry } from "../types";

function entry(patch: Partial<CreditLedgerEntry> & Pick<CreditLedgerEntry, "id" | "kind" | "delta">): CreditLedgerEntry {
  return {
    clientId: "c1",
    balanceAfter: 100,
    operation: "task_execution",
    reason: "test",
    jobId: "task1",
    actorUid: "u1",
    createdAt: 1_000,
    ...patch,
  };
}

const charge = (id: string, createdAt: number, amount = 5) =>
  entry({ id, kind: "charge", delta: -amount, createdAt });
const refund = (id: string, createdAt: number, amount = 5) =>
  entry({ id, kind: "refund", delta: amount, createdAt });

describe("newestUnrefundedCharge", () => {
  it("picks the only charge when nothing is refunded", () => {
    expect(newestUnrefundedCharge([charge("a", 1)])?.id).toBe("a");
  });

  it("picks the newest of several unpaired charges (the stuck attempt is the last charge)", () => {
    expect(newestUnrefundedCharge([charge("a", 1), charge("b", 2)])?.id).toBe("b");
  });

  it("skips a charge paired by deterministic refund id and falls back to the older one", () => {
    const entries = [charge("a", 1), charge("b", 2), refund(refundEntryIdFor("b"), 3)];
    expect(newestUnrefundedCharge(entries)?.id).toBe("a");
  });

  it("returns null when every charge is paired — re-running the sweep refunds nothing", () => {
    const entries = [charge("a", 1), refund(refundEntryIdFor("a"), 2)];
    expect(newestUnrefundedCharge(entries)).toBeNull();
  });

  it("count guard: a refund under a random id (inline refund path) still blocks a second refund", () => {
    const entries = [charge("a", 1), refund("random-doc-id", 2)];
    expect(newestUnrefundedCharge(entries)).toBeNull();
  });

  it("count guard with retries: one random-id refund + two charges still allows exactly one refund", () => {
    const entries = [charge("a", 1), refund("random-doc-id", 2), charge("b", 3)];
    expect(newestUnrefundedCharge(entries)?.id).toBe("b");
  });

  it("ignores grants/adjustments that happen to reference the jobId", () => {
    const entries = [
      charge("a", 1),
      entry({ id: "g", kind: "grant", delta: 50, createdAt: 2 }),
      entry({ id: "adj", kind: "adjustment", delta: -10, createdAt: 3 }),
    ];
    expect(newestUnrefundedCharge(entries)?.id).toBe("a");
  });

  it("ignores zero/negative-amount charge entries", () => {
    expect(newestUnrefundedCharge([entry({ id: "z", kind: "charge", delta: 0, createdAt: 1 })])).toBeNull();
  });

  it("returns null for an empty ledger (never charged — staff or batch-charged work)", () => {
    expect(newestUnrefundedCharge([])).toBeNull();
  });
});

/* ── refundJobCharge: WHICH KEY the charge is filed under ─────────────── */

/**
 * #33's second half. The ledger's `jobId` field is a pairing key, and the app
 * writes charges under two different kinds of key:
 *
 *   - a run fired straight at an agent is charged under the JOB id
 *     (submitCustomAgentJob);
 *   - a run dispatched by a BOARD TASK is charged under the TASK id
 *     (execution-actions' `jobId: task.id`), before any job exists — and the job
 *     it then creates is submitted by the non-billable task engine, so nothing
 *     is ever written under the job id for it.
 *
 * Task dispatch is the ordinary way a client spends agent credits, so a refund
 * that only looked up the job id was a no-op for most real runs. These exercise
 * the real transaction (against a Firestore fake), not the caller's argument
 * shape — the point is that the widened lookup still refunds exactly once.
 */

const ledgerDocs = new Map<string, Record<string, any>>();
const creditDocs = new Map<string, Record<string, any>>();

vi.mock("server-only", () => ({}));
// credit-reconcile pulls only these two from data.ts, and neither is on the
// refund path — stubbed so importing it doesn't drag in the Admin SDK.
vi.mock("@/lib/data", () => ({
  IN_FLIGHT_JOB_STATUSES: ["queued", "running"],
  isJobInFlight: (s: string) => s === "queued" || s === "running",
}));
vi.mock("@/lib/firebase/admin", () => {
  const colOf = (name: string) => (name === "creditLedger" ? ledgerDocs : creditDocs);
  const db = {
    collection: (name: string) => ({
      doc: (id: string) => ({ __col: name, id }),
      where: (field: string, _op: string, value: string) => ({ __col: name, __field: field, __value: value }),
    }),
    // Buffers writes until the callback returns, the way a real transaction
    // does — so a `create` on an id another write in the same transaction just
    // made still collides, and a read never sees this transaction's own writes.
    runTransaction: async (fn: (tx: any) => any) => {
      const pending: Array<() => void> = [];
      const out = await fn({
        async get(target: any) {
          const col = colOf(target.__col);
          if (target.__field) {
            return {
              docs: [...col.entries()]
                .filter(([, d]) => d[target.__field] === target.__value)
                .map(([id, d]) => ({ id, data: () => d })),
            };
          }
          const d = col.get(target.id);
          return { exists: d !== undefined, id: target.id, data: () => d };
        },
        set(ref: any, data: any) {
          pending.push(() => void colOf(ref.__col).set(ref.id, data));
        },
        create(ref: any, data: any) {
          pending.push(() => {
            if (colOf(ref.__col).has(ref.id)) throw new Error("ALREADY_EXISTS");
            colOf(ref.__col).set(ref.id, data);
          });
        },
      });
      for (const w of pending) w();
      return out;
    },
  };
  return { adminDb: () => db };
});

const { refundJobCharge } = await import("../credit-reconcile");

/** Write a charge row filed under `ledgerKey` (the entry's `jobId` field). */
function seedCharge(id: string, ledgerKey: string, amount = 5) {
  ledgerDocs.set(id, {
    id,
    clientId: "c1",
    delta: -amount,
    balanceAfter: 100,
    kind: "charge",
    operation: "task_execution",
    reason: "Task execution · Weekly drafts",
    jobId: ledgerKey,
    actorUid: "u1",
    createdAt: 1_000,
  });
}

const refundRows = () => [...ledgerDocs.values()].filter((d) => d.kind === "refund");

beforeEach(() => {
  ledgerDocs.clear();
  creditDocs.clear();
  creditDocs.set("c1", {
    clientId: "c1",
    balance: 100,
    weekSpent: 20,
    monthSpent: 20,
    weekStart: 0,
    monthStart: 0,
    updatedAt: 0,
  });
});

describe("refundJobCharge across the two ledger keys", () => {
  it("finds a TASK-dispatched charge that is not filed under the job id at all", async () => {
    seedCharge("charge-task", "task-9");

    const res = await refundJobCharge(["job-1", "task-9"], "Auto-refund · run produced no deliverables");

    expect(res).toMatchObject({ refunded: true, amount: 5, chargeEntryId: "charge-task" });
    expect(refundRows()).toHaveLength(1);
    expect(ledgerDocs.get(refundEntryIdFor("charge-task"))).toBeDefined();
    expect(creditDocs.get("c1")!.balance).toBe(105);
  });

  it("still finds a directly-fired run's charge under the job id", async () => {
    seedCharge("charge-job", "job-1", 25);

    const res = await refundJobCharge(["job-1", "task-9"], "Auto-refund · run produced no deliverables");

    expect(res).toMatchObject({ refunded: true, amount: 25, chargeEntryId: "charge-job" });
    expect(refundRows()).toHaveLength(1);
  });

  it("refunds ONE charge per call even when both keys carry one", async () => {
    // Not a shape the app writes today (the task engine is not billable), but
    // the widened lookup must not become a way to pay twice in one call.
    seedCharge("charge-job", "job-1", 25);
    seedCharge("charge-task", "task-9", 5);

    await refundJobCharge(["job-1", "task-9"], "Auto-refund · run produced no deliverables");

    expect(refundRows()).toHaveLength(1);
  });

  it("is idempotent across the two keys — the webhook and task-sync cannot both pay", async () => {
    seedCharge("charge-task", "task-9");

    // The webhook refunds with both keys…
    await refundJobCharge(["job-1", "task-9"], "Auto-refund · run produced no deliverables");
    // …and the task sync, later in the same delivery, refunds with the task key.
    const second = await refundJobCharge("task-9", "Auto-refund · agent run failed");

    expect(second.refunded).toBe(false);
    expect(refundRows()).toHaveLength(1);
    expect(creditDocs.get("c1")!.balance).toBe(105);
  });

  it("refunds nothing for a staff-fired run — no charge under either key", async () => {
    const res = await refundJobCharge(["job-1", "task-9"], "Auto-refund · run produced no deliverables");
    expect(res).toEqual({ refunded: false });
    expect(refundRows()).toEqual([]);
  });

  it("ignores empty/absent keys rather than querying for them", async () => {
    // The webhook passes `[job.id, task?.id]`, so the second slot is routinely
    // undefined. An undefined key must not become a `where("jobId","==",undefined)`.
    seedCharge("charge-job", "job-1");
    const res = await refundJobCharge(["job-1", undefined], "Auto-refund · run produced no deliverables");
    expect(res.refunded).toBe(true);
    expect(await refundJobCharge([undefined, ""], "no keys at all")).toEqual({ refunded: false });
  });
});
