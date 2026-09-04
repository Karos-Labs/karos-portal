/* eslint-disable @typescript-eslint/no-explicit-any */
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import {
  newestSettleableCharge,
  refundEntryIdFor,
  settlementEntryIdFor,
} from "../credit-reconcile-shared";
import { CREDIT_PLAN_VERSION, creditMonthKey, creditWeekKey } from "../credits";
import type { CreditLedgerEntry } from "../types";

/**
 * MONEY CODE, ASKED OF THE TRANSACTION — not of the caller's intentions.
 *
 * Two-phase charging (credits rework, 2026-09) reconciles the estimate a client
 * was charged at dispatch against what the run actually cost Karos. Getting the
 * arithmetic right is `credits.test.ts`'s job (`settlementFor`, `applySettlement`,
 * both pure). What is left, and what this file is about, is the part no pure
 * function can hold:
 *
 *   1. a hold settles AT MOST ONCE, however many webhooks, sweeps and reconcilers
 *      race it;
 *   2. a charge is EITHER refunded OR settled, NEVER BOTH — in either order.
 *
 * (2) is the hardest invariant in the design and the one with a real client
 * consequence: a failed run refunds its whole hold, so a settlement that also
 * landed would credit the client twice for a run that produced nothing. It is
 * exercised here in BOTH orders, against a Firestore fake that buffers writes the
 * way a real transaction does — so a `create` on an id another write in the same
 * transaction just made still collides, and a read never sees its own writes.
 * Same fake, same shape, as credit-reconcile.test.ts's.
 */

function entry(
  patch: Partial<CreditLedgerEntry> & Pick<CreditLedgerEntry, "id" | "kind" | "delta">,
): CreditLedgerEntry {
  return {
    clientId: "c1",
    balanceAfter: 100,
    operation: "custom_agent_run",
    reason: "test",
    jobId: "job-1",
    actorUid: "u1",
    createdAt: 1_000,
    ...patch,
  };
}

const hold = (id: string, createdAt: number, amount = 25) =>
  entry({ id, kind: "charge", delta: -amount, createdAt, phase: "hold" });

describe("newestSettleableCharge", () => {
  it("picks the newest unpaired hold", () => {
    expect(newestSettleableCharge([hold("a", 1), hold("b", 2)])?.id).toBe("b");
  });

  it("refuses a charge that was already REFUNDED — a refunded run never settles", () => {
    const rows = [hold("a", 1), entry({ id: refundEntryIdFor("a"), kind: "refund", delta: 25, createdAt: 2 })];
    expect(newestSettleableCharge(rows)).toBeNull();
  });

  it("refuses a charge that was already SETTLED", () => {
    const rows = [
      hold("a", 1),
      entry({
        id: settlementEntryIdFor("a"),
        kind: "settlement",
        delta: 7,
        createdAt: 2,
        settlesEntryId: "a",
      }),
    ];
    expect(newestSettleableCharge(rows)).toBeNull();
  });

  it("count guard: an INLINE refund written under a random id still blocks settlement", () => {
    // The ~15 in-request "produced nothing" refunds write auto-id ledger docs
    // with no idempotency key at all, so the deterministic pairing cannot see
    // them and only the count can.
    const rows = [hold("a", 1), entry({ id: "random-doc-id", kind: "refund", delta: 25, createdAt: 2 })];
    expect(newestSettleableCharge(rows)).toBeNull();
  });

  it("does NOT let a settlement enter the refund count guard", () => {
    // Two holds, one settled: the second is still settleable. If settlements
    // were counted as refunds, `outstanding` would read 1 and the wrong charge
    // could be picked.
    const rows = [
      hold("a", 1),
      hold("b", 2),
      entry({ id: settlementEntryIdFor("a"), kind: "settlement", delta: 7, createdAt: 3, settlesEntryId: "a" }),
    ];
    expect(newestSettleableCharge(rows)?.id).toBe("b");
  });

  it("returns null for a run nobody was charged for", () => {
    expect(newestSettleableCharge([])).toBeNull();
  });
});

/* ── the real transaction, against a Firestore fake ───────────────── */

const ledgerDocs = new Map<string, Record<string, any>>();
const creditDocs = new Map<string, Record<string, any>>();
const jobDocs = new Map<string, Record<string, any>>();
/** The fake db handle, so one case below can watch what it is asked for. */
let adminDbFake: any;

vi.mock("server-only", () => ({}));
vi.mock("@/lib/firebase/admin", () => {
  const colOf = (name: string) =>
    name === "creditLedger" ? ledgerDocs : name === "jobs" ? jobDocs : creditDocs;
  const db = {
    collection: (name: string) => ({
      doc: (id: string) => ({
        __col: name,
        id,
        // The sweep's marker write is a plain set, outside any transaction.
        async set(data: any, opts?: { merge?: boolean }) {
          const col = colOf(name);
          col.set(id, opts?.merge ? { ...(col.get(id) ?? {}), ...data } : data);
        },
      }),
      where: (field: string, _op: string, value: string) => {
        // `limit` returns the same handle: the fake's collections are tiny, so
        // the cap can never bind, and modelling it would only let a test pass
        // for a reason the real query would not.
        const q: any = {
          __col: name,
          __field: field,
          __value: value,
          // …and so is the sweep's listing.
          async get() {
            return {
              docs: [...colOf(name).entries()]
                .filter(([, d]) => d[field] === value)
                .map(([id, d]) => ({ id, data: () => d })),
            };
          },
        };
        q.limit = () => q;
        return q;
      },
    }),
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
  adminDbFake = db;
  return { adminDb: () => db };
});

const { settleJobCharge, settleChargeEntry, listUnsettledHolds, UNSETTLED_AFTER_MS } =
  await import("../credit-settle");
const { refundJobCharge } = await import("../credit-reconcile");

vi.mock("@/lib/data", () => ({
  IN_FLIGHT_JOB_STATUSES: ["queued", "running"],
  isJobInFlight: (s: string) => s === "queued" || s === "running",
}));

/**
 * When the seeded holds were charged. IN THE CURRENT WINDOW deliberately:
 * `applySettlement` corrects window spend only in the windows the hold actually
 * accrued in, so a hold dated to the epoch would settle the balance and leave
 * `monthSpent` alone — correct behaviour, and not what these cases are about.
 * The cross-window case has its own test in credits.test.ts.
 */
const CHARGED_AT = Date.now();

/** Write a hold filed under `ledgerKey` (the entry's `jobId` field). */
function seedHold(
  id: string,
  ledgerKey: string,
  amount = 25,
  operation: CreditLedgerEntry["operation"] = "custom_agent_run",
) {
  ledgerDocs.set(id, {
    id,
    clientId: "c1",
    delta: -amount,
    balanceAfter: 500,
    kind: "charge",
    operation,
    reason: "Agent run · Instagram agent",
    jobId: ledgerKey,
    actorUid: "u1",
    createdAt: CHARGED_AT,
    phase: "hold",
  });
}

const settlementRows = () => [...ledgerDocs.values()].filter((d) => d.kind === "settlement");
const refundRows = () => [...ledgerDocs.values()].filter((d) => d.kind === "refund");
const balance = () => creditDocs.get("c1")!.balance;

/**
 * The whole file runs with the rework ON. Settlement is gated on
 * `CREDITS_PLAN_V2_ENABLED` and refuses to write a thing without it — which is
 * the correct production default and is asserted in its own block at the
 * bottom, but would make every case above it pass vacuously.
 */
let priorFlag: string | undefined;
beforeAll(() => {
  priorFlag = process.env.CREDITS_PLAN_V2_ENABLED;
  process.env.CREDITS_PLAN_V2_ENABLED = "1";
});
afterAll(() => {
  if (priorFlag === undefined) delete process.env.CREDITS_PLAN_V2_ENABLED;
  else process.env.CREDITS_PLAN_V2_ENABLED = priorFlag;
});

beforeEach(() => {
  ledgerDocs.clear();
  creditDocs.clear();
  jobDocs.clear();
  // Windows already current and plan already stamped, so neither the window
  // roll nor the lazy migration moves a number this file is asserting on.
  creditDocs.set("c1", {
    clientId: "c1",
    balance: 500,
    weeklyLimit: null,
    monthlyLimit: 2600,
    weekKey: creditWeekKey(Date.now()),
    weekSpent: 100,
    monthKey: creditMonthKey(Date.now()),
    monthSpent: 100,
    planVersion: CREDIT_PLAN_VERSION,
    updatedAt: 0,
  });
});

describe("settleJobCharge", () => {
  it("hands back the difference when the run came in under its estimate", async () => {
    seedHold("charge-1", "job-1", 25);

    const res = await settleJobCharge("job-1", 0.9, "Instagram agent");

    expect(res).toMatchObject({ settled: true, estimate: 25, actual: 18, delta: 7 });
    expect(balance()).toBe(507);
    // Window spend moves the OTHER way, so the monthly cap tracks the real bill.
    expect(creditDocs.get("c1")!.monthSpent).toBe(93);
    expect(settlementRows()).toHaveLength(1);
  });

  it("takes the extra when the run came in over", async () => {
    seedHold("charge-1", "job-1", 25);

    const res = await settleJobCharge("job-1", 2, "Instagram agent");

    expect(res).toMatchObject({ settled: true, actual: 40, delta: -15, capped: false });
    expect(balance()).toBe(485);
    expect(creditDocs.get("c1")!.monthSpent).toBe(115);
  });

  it("clips a runaway run at 2× and flags the row for staff", async () => {
    seedHold("charge-1", "job-1", 25);

    const res = await settleJobCharge("job-1", 4, "Instagram agent");

    expect(res).toMatchObject({ settled: true, actual: 50, capped: true });
    const row = settlementRows()[0]!;
    expect(row.settlementCapped).toBe(true);
    // The UNCAPPED cost is still recorded — it is the only way staff can see
    // how far the estimate has drifted.
    expect(row.actualUsd).toBe(4);
  });

  it("writes a row even when the estimate was exactly right", async () => {
    seedHold("charge-1", "job-1", 20);

    const res = await settleJobCharge("job-1", 1, "Instagram agent");

    expect(res).toMatchObject({ settled: true, delta: 0 });
    expect(balance()).toBe(500);
    // Without the row, the sweep would re-attempt this hold forever.
    expect(settlementRows()).toHaveLength(1);
  });

  it("finds a TASK-dispatched hold that is not filed under the job id at all", async () => {
    // The ordinary way a client spends agent credits: charged under the task id
    // before the job existed. Pairing on the job alone would leave most real
    // runs holding an estimate forever.
    seedHold("charge-task", "task-9", 25);

    const res = await settleJobCharge(["job-1", "task-9"], 0.9, "Instagram agent");

    expect(res).toMatchObject({ settled: true, chargeEntryId: "charge-task" });
  });

  it("settles ONE hold per call even when both keys carry one", async () => {
    seedHold("charge-job", "job-1", 25);
    seedHold("charge-task", "task-9", 5);

    await settleJobCharge(["job-1", "task-9"], 0.9, "Instagram agent");

    expect(settlementRows()).toHaveLength(1);
  });

  it("leaves the estimate standing when the run reported no cost", async () => {
    // "Cost unknown" is never "cost nothing": settling an unpriced run to the
    // 1-credit floor would turn a telemetry gap into a 96% discount.
    seedHold("charge-1", "job-1", 25);

    for (const noCost of [undefined, null, 0, NaN]) {
      const res = await settleJobCharge("job-1", noCost, "Instagram agent");
      expect(res.settled).toBe(false);
    }
    expect(settlementRows()).toHaveLength(0);
    expect(balance()).toBe(500);
  });

  it("never settles a seat purchase or an agent setup", async () => {
    // Priced decisions, not measurements. A seat calls no model at all, so
    // settling it would refund ~100 credits against $0 of tokens.
    seedHold("charge-seat", "job-seat", 100, "seat_purchase");
    seedHold("charge-setup", "job-setup", 500, "agent_launch");

    expect((await settleJobCharge("job-seat", 0.1, "Seat")).settled).toBe(false);
    expect((await settleJobCharge("job-setup", 1, "Setup")).settled).toBe(false);
    expect(settlementRows()).toHaveLength(0);
    expect(balance()).toBe(500);
  });

  it("does nothing for a staff-fired run — there was never a hold", async () => {
    expect((await settleJobCharge("job-1", 0.9, "Instagram agent")).settled).toBe(false);
    expect(settlementRows()).toHaveLength(0);
  });

  it("ignores empty and absent keys rather than querying for them", async () => {
    seedHold("charge-1", "job-1", 25);
    expect((await settleJobCharge(["job-1", undefined], 0.9, "A")).settled).toBe(true);
    expect((await settleJobCharge([undefined, ""], 0.9, "A")).settled).toBe(false);
  });
});

describe("invariant 1 — a hold settles at most once", () => {
  it("a webhook redelivery and a sweep cannot both settle the same hold", async () => {
    seedHold("charge-1", "job-1", 25);

    const first = await settleJobCharge("job-1", 0.9, "Instagram agent");
    const second = await settleJobCharge("job-1", 0.9, "Instagram agent");

    expect(first.settled).toBe(true);
    expect(second.settled).toBe(false);
    expect(settlementRows()).toHaveLength(1);
    expect(balance()).toBe(507);
  });

  it("pairs on the CHARGE, so the job key and the task key cannot each pay", async () => {
    seedHold("charge-task", "task-9", 25);

    await settleJobCharge(["job-1", "task-9"], 0.9, "Instagram agent");
    const second = await settleJobCharge("task-9", 0.9, "Instagram agent");

    expect(second.settled).toBe(false);
    expect(settlementRows()).toHaveLength(1);
  });

  it("settles a RETRY's second hold separately — two attempts, two charges", async () => {
    // Idempotency is keyed to the charge entry, not to the job: the same job
    // can legitimately be charged again, and each attempt settles on its own.
    seedHold("charge-1", "job-1", 25);
    await settleJobCharge("job-1", 0.9, "Instagram agent");
    seedHold("charge-2", "job-1", 25);
    ledgerDocs.get("charge-2")!.createdAt = CHARGED_AT + 1_000;

    const res = await settleJobCharge("job-1", 2, "Instagram agent");

    expect(res).toMatchObject({ settled: true, chargeEntryId: "charge-2" });
    expect(settlementRows()).toHaveLength(2);
  });
});

describe("invariant 2 — a charge is either refunded or settled, never both", () => {
  it("refuses to settle a hold that was already refunded", async () => {
    // The live shape: a "done" run that produced no deliverables is refunded in
    // full by the webhook and then, if settlement were not guarded, settled to
    // 18 as well — crediting the client 43 for a run that produced nothing.
    seedHold("charge-1", "job-1", 25);
    await refundJobCharge("job-1", "Auto-refund · run produced no deliverables");
    const afterRefund = balance();

    const res = await settleJobCharge("job-1", 0.9, "Instagram agent");

    expect(res.settled).toBe(false);
    // The pairing refuses it before the transaction's own belt-and-braces read;
    // either way nothing is written and the balance does not move again.
    expect(res.detail).toBeTruthy();
    expect(settlementRows()).toHaveLength(0);
    expect(balance()).toBe(afterRefund);
  });

  it("refuses to refund a hold that was already settled", async () => {
    // The other order, which is just as reachable: a delivered run settles, and
    // a late failure sweep then tries to refund the same charge.
    seedHold("charge-1", "job-1", 25);
    await settleJobCharge("job-1", 0.9, "Instagram agent");
    const afterSettlement = balance();

    const res = await refundJobCharge("job-1", "Auto-refund · run failed");

    expect(res.refunded).toBe(false);
    expect(refundRows()).toHaveLength(0);
    expect(balance()).toBe(afterSettlement);
  });

  it("sees a refund written under a RANDOM id too, not just the deterministic one", async () => {
    // The in-request refund sites have no idempotency key. The count guard is
    // the only thing that can see them, and it has to hold here as well.
    seedHold("charge-1", "job-1", 25);
    ledgerDocs.set("inline-refund", {
      id: "inline-refund",
      clientId: "c1",
      delta: 25,
      balanceAfter: 525,
      kind: "refund",
      operation: "custom_agent_run",
      reason: "Refund · produced nothing",
      jobId: "job-1",
      actorUid: "u1",
      createdAt: CHARGED_AT + 1_000,
    });

    expect((await settleJobCharge("job-1", 0.9, "Instagram agent")).settled).toBe(false);
  });
});

describe("settleChargeEntry (the in-request path)", () => {
  it("settles the exact hold it is given, without any lookup", async () => {
    // In-request charges mostly carry no jobId at all — a copilot turn finishes
    // inside one request — so the charge row's own id is the only safe key.
    ledgerDocs.set("charge-x", {
      id: "charge-x",
      clientId: "c1",
      delta: -5,
      balanceAfter: 495,
      kind: "charge",
      operation: "ai_tool",
      reason: "Audience simulation · Spring launch",
      jobId: null,
      actorUid: "u1",
      createdAt: CHARGED_AT,
      phase: "hold",
    });

    const res = await settleChargeEntry("charge-x", 0.06, "Audience simulation");

    expect(res).toMatchObject({ settled: true, estimate: 5, actual: 2, delta: 3 });
    expect(balance()).toBe(503);
  });

  it("settles a sub-cent action to the one-credit floor, not to zero", async () => {
    ledgerDocs.set("charge-chat", {
      id: "charge-chat",
      clientId: "c1",
      delta: -1,
      balanceAfter: 499,
      kind: "charge",
      operation: "chat_message",
      reason: "Copilot message",
      jobId: null,
      actorUid: "u1",
      createdAt: CHARGED_AT,
      phase: "hold",
    });

    const res = await settleChargeEntry("charge-chat", 0.002, "Copilot message");

    expect(res).toMatchObject({ settled: true, actual: 1, delta: 0 });
  });

  it("is idempotent, and reports a charge row that is not there", async () => {
    ledgerDocs.set("charge-x", {
      id: "charge-x",
      clientId: "c1",
      delta: -5,
      balanceAfter: 495,
      kind: "charge",
      operation: "ai_tool",
      reason: "Audience simulation",
      jobId: null,
      actorUid: "u1",
      createdAt: CHARGED_AT,
      phase: "hold",
    });

    expect((await settleChargeEntry("charge-x", 0.06, "Sim")).settled).toBe(true);
    expect((await settleChargeEntry("charge-x", 0.06, "Sim")).settled).toBe(false);
    expect((await settleChargeEntry("nope", 0.06, "Sim")).settled).toBe(false);
    expect(settlementRows()).toHaveLength(1);
  });
});

describe("the ledger line a client reads on a settled run", () => {
  it("names both figures and stays inside the 120-char reason limit", async () => {
    seedHold("charge-1", "job-1", 25);
    await settleJobCharge("job-1", 0.9, "A".repeat(200));

    const reason: string = settlementRows()[0]!.reason;
    expect(reason.length).toBeLessThanOrEqual(120);
    expect(reason).toContain("18 credits");
    expect(reason).toContain("estimated 25");
  });

  it("uses no em dash and never says token", async () => {
    seedHold("charge-1", "job-1", 25);
    await settleJobCharge("job-1", 2, "Instagram agent");

    const reason: string = settlementRows()[0]!.reason;
    expect(reason).not.toMatch(/[—–]/);
    expect(reason.toLowerCase()).not.toContain("token");
  });

  it("carries the hold's own agent and job, so the breakdown nets it correctly", async () => {
    ledgerDocs.set("charge-1", {
      id: "charge-1",
      clientId: "c1",
      delta: -25,
      balanceAfter: 475,
      kind: "charge",
      operation: "custom_agent_run",
      reason: "Agent run · Instagram agent",
      jobId: "job-1",
      agentId: "ca-instagram",
      actorUid: "u1",
      createdAt: CHARGED_AT,
      phase: "hold",
    });

    await settleJobCharge("job-1", 0.9, "Instagram agent");

    expect(settlementRows()[0]).toMatchObject({
      agentId: "ca-instagram",
      jobId: "job-1",
      operation: "custom_agent_run",
      phase: "settlement",
      settlesEntryId: "charge-1",
      estimateCredits: 25,
    });
  });
});

describe("with CREDITS_PLAN_V2_ENABLED off", () => {
  let prior: string | undefined;
  beforeEach(() => {
    prior = process.env.CREDITS_PLAN_V2_ENABLED;
    delete process.env.CREDITS_PLAN_V2_ENABLED;
  });
  afterEach(() => {
    if (prior === undefined) delete process.env.CREDITS_PLAN_V2_ENABLED;
    else process.env.CREDITS_PLAN_V2_ENABLED = prior;
  });

  it("writes nothing, from either entry point", async () => {
    // The refusal lives at the WRITE, not at the seven call sites that reach
    // it, so no caller can bring a settlement row into existence while the
    // rework is dark.
    seedHold("charge-1", "job-1", 25);

    expect((await settleJobCharge("job-1", 0.9, "Instagram agent")).settled).toBe(false);
    expect((await settleChargeEntry("charge-1", 0.9, "Instagram agent")).settled).toBe(false);
    expect(settlementRows()).toHaveLength(0);
    expect(balance()).toBe(500);
  });

  it("says why, so a log line is not a mystery", async () => {
    seedHold("charge-1", "job-1", 25);
    expect((await settleJobCharge("job-1", 0.9, "A")).detail).toMatch(/CREDITS_PLAN_V2_ENABLED/);
  });
});

/**
 * D2 — THE SWEEP MUST NOT STARVE THE HOLD IT EXISTS FOR.
 *
 * The unsettled-hold sweep is the ONLY retry for a settlement lost between the
 * webhook's single-use claim and its write (a redelivery short-circuits at
 * "Already processed"). So a listing that can never reach the stranded job is
 * not a slow sweep, it is no sweep at all — and the first cut had exactly that
 * shape: newest-first, capped at 25, with settled jobs left in the candidate
 * set. Past 25 delivered jobs it re-examined the same 25 newest ones forever
 * while the genuinely stranded hold sat at the back.
 */
describe("listUnsettledHolds", () => {
  const NOW = Date.now();
  const STALE = NOW - UNSETTLED_AFTER_MS - 60_000;

  function seedJob(id: string, patch: Record<string, any> = {}) {
    jobDocs.set(id, {
      id,
      clientId: "c1",
      agentName: "Instagram agent",
      status: "review",
      updatedAt: STALE,
      external: { totalCostUsd: 0.9 },
      ...patch,
    });
  }

  it("hands back the OLDEST candidates first", async () => {
    seedJob("new", { updatedAt: STALE + 5_000 });
    seedJob("old", { updatedAt: STALE - 100_000 });
    seedJob("middle", { updatedAt: STALE - 1_000 });

    const ids = (await listUnsettledHolds(NOW - UNSETTLED_AFTER_MS)).map((j) => j.id);
    expect(ids).toEqual(["old", "middle", "new"]);
  });

  it("drops a job the sweep has already dealt with", async () => {
    seedJob("done", { holdSettledAt: NOW });
    seedJob("waiting");
    expect((await listUnsettledHolds(NOW - UNSETTLED_AFTER_MS)).map((j) => j.id)).toEqual([
      "waiting",
    ]);
  });

  it("reaches a stranded hold sitting behind a full page of finished ones", async () => {
    // The starvation case, made concrete. Thirty jobs newer than the stranded
    // one, all already swept: an unfiltered newest-first list of 25 would never
    // include `stranded`, on this tick or any other.
    for (let i = 0; i < 30; i++) {
      seedJob(`swept-${i}`, { updatedAt: STALE + i, holdSettledAt: NOW });
    }
    seedJob("stranded", { updatedAt: STALE - 500_000 });

    const ids = (await listUnsettledHolds(NOW - UNSETTLED_AFTER_MS)).map((j) => j.id);
    expect(ids[0]).toBe("stranded");
  });

  it("ignores a job with no reported cost and one that only just finished", async () => {
    seedJob("no-cost", { external: {} });
    seedJob("too-fresh", { updatedAt: NOW });
    seedJob("real");
    expect((await listUnsettledHolds(NOW - UNSETTLED_AFTER_MS)).map((j) => j.id)).toEqual(["real"]);
  });

  it("caps the page, but takes the cap off the OLDEST end", async () => {
    for (let i = 0; i < 40; i++) seedJob(`j-${i}`, { updatedAt: STALE - i });
    const page = await listUnsettledHolds(NOW - UNSETTLED_AFTER_MS, 5);
    expect(page).toHaveLength(5);
    expect(page[0]!.id).toBe("j-39"); // the oldest of the forty
  });
});

/**
 * D5 — `settleChargeEntry` must see an INLINE refund written under an auto-id.
 *
 * The in-request refund sites had no idempotency key at all, so no
 * `refund_<chargeEntryId>` doc exists for them and only the count guard can see
 * them — and the first cut handed `[charge]` alone to the pairing, a one-element
 * list with nothing to count against. A run refunded inline and then settled
 * would have paid the client twice.
 */
describe("settleChargeEntry against an inline auto-id refund", () => {
  it("refuses when the charge's own pairing group already holds a refund", async () => {
    seedHold("charge-1", "job-1", 25);
    ledgerDocs.set("auto-id-refund", {
      id: "auto-id-refund",
      clientId: "c1",
      delta: 25,
      balanceAfter: 525,
      kind: "refund",
      operation: "custom_agent_run",
      reason: "Refund · run produced nothing",
      jobId: "job-1",
      actorUid: "u1",
      createdAt: CHARGED_AT + 500,
    });

    const res = await settleChargeEntry("charge-1", 0.9, "Instagram agent");

    expect(res.settled).toBe(false);
    expect(settlementRows()).toHaveLength(0);
    expect(balance()).toBe(500);
  });

  it("refuses when a deterministic refund exists on a charge with no jobId", async () => {
    // Most of this path: a copilot turn carries no jobId, so the count guard has
    // nothing to group on and `refund_<chargeEntryId>` is the whole guarantee.
    // `refundClientModelCall` writes exactly that doc when it is given the id.
    ledgerDocs.set("charge-chat", {
      id: "charge-chat",
      clientId: "c1",
      delta: -5,
      balanceAfter: 495,
      kind: "charge",
      operation: "ai_tool",
      reason: "Audience simulation",
      jobId: null,
      actorUid: "u1",
      createdAt: CHARGED_AT,
      phase: "hold",
    });
    ledgerDocs.set(refundEntryIdFor("charge-chat"), {
      id: refundEntryIdFor("charge-chat"),
      clientId: "c1",
      delta: 5,
      balanceAfter: 500,
      kind: "refund",
      operation: "ai_tool",
      reason: "Refund · simulation returned no verdicts",
      jobId: null,
      actorUid: "u1",
      createdAt: CHARGED_AT + 500,
    });

    expect((await settleChargeEntry("charge-chat", 0.06, "Sim")).settled).toBe(false);
    expect(settlementRows()).toHaveLength(0);
  });

  it("settles the hold it was GIVEN, never a newer one under the same key", async () => {
    // The group lookup finds every charge filed under the jobId; only the one
    // the caller named is theirs to settle.
    seedHold("charge-1", "job-1", 25);
    seedHold("charge-2", "job-1", 25);
    ledgerDocs.get("charge-2")!.createdAt = CHARGED_AT + 1_000;

    const res = await settleChargeEntry("charge-1", 0.9, "Instagram agent");

    expect(res.settled).toBe(false);
    expect(res.detail).toMatch(/newer hold/);
  });
});

/**
 * D5 — TWO RUNS OF ONE TASK, TWO HOLDS UNDER ONE KEY.
 *
 * A board-task dispatch is charged under the TASK id before any job exists, so
 * re-running the same task files a second charge under the same key. "The
 * newest unpaired charge" then stops naming a particular run: whichever run
 * delivers first would settle the OTHER run's hold against its own cost, and
 * once both landed each would have paid the other's price.
 *
 * `settlesJobId` is stamped by the dispatch at the instant it learns its job id
 * (`stampChargeSettlesJob`, called beside the `externalJobId` write), which is
 * the earliest moment the mapping exists at all.
 */
describe("two in-flight runs of the same task", () => {
  function seedStampedHold(id: string, taskKey: string, jobId: string, amount: number, at: number) {
    seedHold(id, taskKey, amount);
    ledgerDocs.get(id)!.settlesJobId = jobId;
    ledgerDocs.get(id)!.createdAt = at;
  }

  it("settles each run against ITS OWN hold, whichever delivers first", async () => {
    // Run A charged 25 first; run B charged 25 a minute later. B delivers first.
    seedStampedHold("charge-A", "task-9", "job-A", 25, CHARGED_AT);
    seedStampedHold("charge-B", "task-9", "job-B", 25, CHARGED_AT + 60_000);

    const b = await settleJobCharge(["job-B", "task-9"], 0.9, "Instagram agent", "job-B");
    expect(b).toMatchObject({ settled: true, chargeEntryId: "charge-B", actual: 18 });

    // …and A, arriving later and cheaper, settles its own — not B's, which is
    // already gone, and not by falling through to "the newest unpaired".
    const a = await settleJobCharge(["job-A", "task-9"], 0.5, "Instagram agent", "job-A");
    expect(a).toMatchObject({ settled: true, chargeEntryId: "charge-A", actual: 10 });

    expect(settlementRows()).toHaveLength(2);
  });

  it("never takes a hold stamped for a DIFFERENT run", async () => {
    // Only B's hold exists so far (A's dispatch has not stamped yet). A must
    // settle nothing rather than reach for B's.
    seedStampedHold("charge-B", "task-9", "job-B", 25, CHARGED_AT);

    const a = await settleJobCharge(["job-A", "task-9"], 0.9, "Instagram agent", "job-A");

    expect(a.settled).toBe(false);
    expect(settlementRows()).toHaveLength(0);
  });

  it("falls back to newest-unpaired for a legacy, unstamped hold", async () => {
    // Every row written before `settlesJobId` existed is unstamped, and so is
    // every direct-fire charge. The pre-existing rule has to keep working.
    seedHold("charge-legacy", "task-9", 25);

    const res = await settleJobCharge(["job-A", "task-9"], 0.9, "Instagram agent", "job-A");

    expect(res).toMatchObject({ settled: true, chargeEntryId: "charge-legacy" });
  });

  it("prefers the stamped hold over a newer unstamped one", async () => {
    // Mixed data during rollout: an older stamped hold and a newer unstamped
    // one under the same key. The stamp is the stronger claim.
    seedStampedHold("charge-mine", "task-9", "job-A", 25, CHARGED_AT);
    seedHold("charge-other", "task-9", 25);
    ledgerDocs.get("charge-other")!.createdAt = CHARGED_AT + 60_000;

    const res = await settleJobCharge(["job-A", "task-9"], 0.9, "Instagram agent", "job-A");

    expect(res).toMatchObject({ settled: true, chargeEntryId: "charge-mine" });
  });
});

/**
 * WHAT THE SWEEP IS ALLOWED TO BOOKMARK.
 *
 * `markHoldSwept` disqualifies a job from the sweep permanently, and the sweep
 * is the only retry for a settlement lost after the webhook's single-use claim.
 * So "no unpaired hold found" — which is also exactly what a lookup under the
 * WRONG pairing key returns — must not count as a verdict. It did, and it
 * disqualified every task-dispatched run in the product.
 */
describe("which outcomes are definitive", () => {
  it("a settlement is", async () => {
    seedHold("charge-1", "job-1", 25);
    expect((await settleJobCharge("job-1", 0.9, "A")).definitive).toBe(true);
  });

  it("an already-settled hold is", async () => {
    seedHold("charge-1", "job-1", 25);
    await settleJobCharge("job-1", 0.9, "A");
    expect((await settleJobCharge("job-1", 0.9, "A")).definitive).toBe(true);
  });

  it("a refunded hold is", async () => {
    seedHold("charge-1", "job-1", 25);
    await refundJobCharge("job-1", "Auto-refund · produced nothing");
    expect((await settleJobCharge("job-1", 0.9, "A")).definitive).toBe(true);
  });

  it("an exempt operation is", async () => {
    seedHold("charge-seat", "job-seat", 100, "seat_purchase");
    expect((await settleJobCharge("job-seat", 0.1, "Seat")).definitive).toBe(true);
  });

  it("NOT FINDING A HOLD IS NOT — this is the blocker", async () => {
    // The task-dispatched shape: nothing is filed under the job id, because the
    // charge went under the task id. Bookmarking on this answer is what made
    // the stranded hold unreachable forever.
    seedHold("charge-task", "task-9", 25);
    const res = await settleJobCharge("job-1", 0.9, "A");
    expect(res.settled).toBe(false);
    expect(res.definitive).toBe(false);
  });

  it("missing cost telemetry is not", async () => {
    seedHold("charge-1", "job-1", 25);
    expect((await settleJobCharge("job-1", undefined, "A")).definitive).toBeFalsy();
  });

  it("the feature being off is not", async () => {
    delete process.env.CREDITS_PLAN_V2_ENABLED;
    seedHold("charge-1", "job-1", 25);
    const res = await settleJobCharge("job-1", 0.9, "A");
    process.env.CREDITS_PLAN_V2_ENABLED = "1";
    expect(res.definitive).toBeFalsy();
  });
});

/**
 * D3 — THE SWEEP'S OWN READ MUST BE BOUNDED.
 *
 * `where("status","==","review").get()` had no `limit`: a full scan of a
 * collection that grows with every delivered run and never shrinks, on a cron
 * tick, to find at most 25 candidates. The 25 was an in-memory slice and bought
 * nothing at the database.
 */
describe("listUnsettledHolds bounds its read", () => {
  it("asks Firestore for a bounded page, not the whole status", async () => {
    const limits: number[] = [];
    const originalCollection = (adminDbFake as any).collection;
    (adminDbFake as any).collection = (name: string) => {
      const handle = originalCollection(name);
      const where = handle.where;
      handle.where = (...args: unknown[]) => {
        const q = (where as any)(...args);
        const limit = q.limit;
        q.limit = (n: number) => {
          limits.push(n);
          return limit(n);
        };
        return q;
      };
      return handle;
    };
    try {
      await listUnsettledHolds(Date.now());
    } finally {
      (adminDbFake as any).collection = originalCollection;
    }
    expect(limits.length).toBeGreaterThan(0);
    for (const n of limits) expect(n).toBeGreaterThan(0);
  });
});
