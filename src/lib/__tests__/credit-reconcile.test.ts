import { describe, expect, it } from "vitest";
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
