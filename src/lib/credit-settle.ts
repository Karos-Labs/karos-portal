import "server-only";

import { adminDb } from "@/lib/firebase/admin";
import {
  UNSETTLED_OPERATIONS,
  applySettlement,
  creditsLabel,
  defaultClientCredits,
  isCreditsPlanV2Enabled,
  settlementFor,
} from "@/lib/credits";
import {
  chargePairingState,
  newestSettleableCharge,
  refundEntryIdFor,
  settlementEntryIdFor,
} from "@/lib/credit-reconcile-shared";
import type { ClientCredits, CreditLedgerEntry } from "@/lib/types";

/**
 * Phase two of the two-phase charge (credits rework, 2026-09).
 *
 * A client is charged an ESTIMATE when a run is dispatched — the hold, taken by
 * the existing `chargeClientCredits` call sites, unchanged. When the run
 * finishes and reports what it actually cost Karos, this module reconciles the
 * hold to `ceil(actualUsd × 20)`: it hands back the difference, or takes the
 * extra, in ONE ledger row of kind `"settlement"`.
 *
 * That is the whole of the product ruling ("each run costs what it costs us in
 * tokens; the price shown before a run is an estimate") and the whole of the
 * $130 guarantee: 2600 credits × $0.05 holds by construction for every credit a
 * client is charged, because every charged credit is five cents of measured
 * cost. (Two kinds of spend bypass the ledger entirely and therefore bypass
 * this guarantee — staff-fired runs and refunded failures. Both are counted by
 * the staff cost line on the credits panel, so the gap is visible rather than
 * assumed. See `summarizeClientMonthlyCost`.)
 *
 * ── FIVE INVARIANTS, AND WHERE EACH IS ENFORCED ─────────────────────────────
 *  1. A hold settles AT MOST ONCE. Deterministic ledger doc id
 *     `settle_<chargeEntryId>` written with `tx.create()`, so a concurrent
 *     duplicate aborts the whole transaction rather than paying twice. Exactly
 *     the guarantee `refund_<chargeEntryId>` already gives on the refund side.
 *  2. A charge is EITHER refunded OR settled, never both. `tx.get` on the
 *     refund doc INSIDE this transaction (not a read taken before it), plus
 *     `newestSettleableCharge`'s pairing and count guards.
 *  3. Priced-not-measured operations never settle. `UNSETTLED_OPERATIONS`,
 *     checked against the CHARGE ROW's own operation — the caller's opinion of
 *     what it dispatched is not consulted.
 *  4. "Cost unknown" is never "cost nothing". A missing, non-finite or
 *     non-positive `actualUsd` returns without writing anything and leaves the
 *     estimate standing. Settling an unpriced run to the 1-credit floor would
 *     turn a telemetry gap into a 96% discount.
 *  5. A deduction is bounded at `SETTLEMENT_CAP_FACTOR ×` the hold. Past that
 *     we settle at the cap, record the uncapped USD, and flag the row.
 *
 * Lives beside `credit-reconcile.ts` and mirrors its read-then-write shape for
 * the same stated reason: out-of-band credit transactions are that file's
 * business, and the two must not answer the same pairing question differently.
 */

const db = () => adminDb();
const ledgerCol = () => db().collection("creditLedger");
const creditsCol = () => db().collection("clientCredits");

/** Actor stamped on settlement rows. Never a person: no one presses "settle". */
export const SETTLEMENT_ACTOR = { actorUid: "system", actorName: "Credit settlement" } as const;

/**
 * How many ledger rows one pairing group may be read as, INSIDE the settling
 * transaction.
 *
 * A transaction's reads are held for its lifetime and contend with every other
 * writer of those documents, so an unbounded `where("jobId", "==", …)` is a
 * lock whose size is decided by the data. In practice a group is a charge, at
 * most a refund and at most a settlement — single digits. Fifty is far past any
 * real run's history and still a bound.
 *
 * If a group ever genuinely exceeded this, the pairing would read a partial
 * group and could miss a refund. That is why the cap is nowhere near the real
 * numbers: it is a runaway guard, not a paging window.
 */
const LEDGER_GROUP_LIMIT = 50;

export interface SettleResult {
  settled: boolean;
  /** Why nothing happened, when `settled` is false. */
  detail?: string;
  /**
   * Whether this hold's fate is now DECIDED — settled, refunded, or exempt by
   * operation — as opposed to merely not settled this time round.
   *
   * The sweep's bookmark hangs off this. "No unpaired hold under these keys" is
   * NOT definitive: it is exactly what a lookup under the wrong key returns,
   * and marking a job swept on it would disqualify a real stranded hold
   * permanently. "Cost telemetry missing" and "the feature is off" are not
   * definitive either — both can become settleable later.
   */
  definitive?: boolean;
  /** Credits the hold took. */
  estimate?: number;
  /** Credits the run should have cost — what the client ends up charged. */
  actual?: number;
  /** estimate − actual. Positive handed credits back, negative took more. */
  delta?: number;
  /** True when the deduction was clipped to the 2× cap. */
  capped?: boolean;
  chargeEntryId?: string;
}

/**
 * The ledger line a client reads on a settled run. Both figures, always: a row
 * showing only what they paid looks like a reprice nobody announced, and a row
 * showing only the estimate is the number that turned out to be wrong.
 *
 * No em dash, sentence case, and the same 120-char cap every other ledger
 * reason honours so a long agent name cannot render as a wall of text.
 */
export function settlementReason(label: string, estimate: number, actual: number): string {
  const verb = actual === estimate ? "matched the estimate" : actual < estimate ? "cost less" : "cost more";
  return `Settled · ${verb} · charged ${creditsLabel(actual)}, estimated ${estimate} · ${label}`.slice(
    0,
    120,
  );
}

type StagedSettlement = {
  charge: CreditLedgerEntry;
  settlement: ReturnType<typeof settlementFor>;
  settlementRef: FirebaseFirestore.DocumentReference;
  creditsRef: FirebaseFirestore.DocumentReference;
  current: ClientCredits;
};

/**
 * READ phase. Everything the write below needs, or null with the reason it is
 * not settling. Runs entirely inside the transaction, before any write, which
 * is what Firestore requires and also what makes invariant 2 airtight — the
 * refund doc is read at the same serialization point the settlement is written
 * at, so a refund that lands between the sweep's listing and this transaction
 * still wins.
 */
async function readSettleableCharge(
  tx: FirebaseFirestore.Transaction,
  entries: CreditLedgerEntry[],
  actualUsd: number,
  now: number,
  settlingJobId?: string,
): Promise<{ staged: StagedSettlement } | { skip: string; definitive: boolean }> {
  const charge = newestSettleableCharge(entries, settlingJobId ? { settlingJobId } : undefined);
  if (!charge) {
    // THREE WAYS TO FIND NOTHING, and only one of them is a verdict.
    //
    //  - nothing was ever charged under this key: a lookup under the WRONG
    //    pairing key looks exactly like this (a task-dispatched run has no
    //    charge under its job id at all), and so does a staff-fired run. Not
    //    definitive — the sweep must be free to try the other key, and must not
    //    bookmark the job on it;
    //  - every charge here is already refunded or settled: a verdict, and the
    //    ordinary steady state for a job the webhook already handled;
    //  - an unpaired charge exists but belongs to a DIFFERENT run: another
    //    dispatch is in flight and our own hold may still be stamped, so this
    //    is not settled business either.
    const { charges, unpaired } = chargePairingState(entries);
    const allResolved = charges.length > 0 && unpaired.length === 0;
    return {
      skip: allResolved
        ? "every charge under this key is already refunded or settled"
        : "no unpaired hold to settle",
      definitive: allResolved,
    };
  }
  if (UNSETTLED_OPERATIONS.has(charge.operation)) {
    // Definitive: a seat purchase or an agent setup is never going to become
    // settleable, so the sweep should stop looking at it.
    return { skip: `operation ${charge.operation} is priced, not measured`, definitive: true };
  }

  // Invariant 2, read side. `newestSettleableCharge` already filtered on the
  // entries handed in; this re-asks Firestore for the one document that would
  // make the answer wrong, inside the transaction.
  const refundRef = ledgerCol().doc(refundEntryIdFor(charge.id));
  const refundSnap = await tx.get(refundRef);
  if (refundSnap.exists) {
    return { skip: "charge was refunded — a refunded run never settles", definitive: true };
  }

  const settlementRef = ledgerCol().doc(settlementEntryIdFor(charge.id));
  const settlementSnap = await tx.get(settlementRef);
  if (settlementSnap.exists) return { skip: "already settled", definitive: true };

  const creditsRef = creditsCol().doc(charge.clientId);
  const creditsSnap = await tx.get(creditsRef);
  const current = creditsSnap.exists
    ? (creditsSnap.data() as ClientCredits)
    : defaultClientCredits(charge.clientId, now);

  return {
    staged: {
      charge,
      settlement: settlementFor(-charge.delta, actualUsd),
      settlementRef,
      creditsRef,
      current,
    },
  };
}

/**
 * WRITE phase: move the balance and the hold's window spend, then append the
 * settlement row at its deterministic id.
 *
 * A ZERO-DELTA SETTLEMENT STILL WRITES ITS ROW. The estimate happening to be
 * exactly right is not a reason to leave the hold looking unsettled — the sweep
 * would re-attempt it forever, and the client's ledger would not show that the
 * price was confirmed.
 */
function stageSettlementWrites(
  tx: FirebaseFirestore.Transaction,
  staged: StagedSettlement,
  label: string,
  actualUsd: number,
  now: number,
): void {
  const hold = -staged.charge.delta;
  const { credits, delta, capped, uncappedCredits } = staged.settlement;
  const next = applySettlement(staged.current, delta, now, staged.charge.createdAt);
  tx.set(staged.creditsRef, next);
  tx.create(staged.settlementRef, {
    id: staged.settlementRef.id,
    clientId: staged.charge.clientId,
    delta,
    balanceAfter: next.balance,
    kind: "settlement",
    // The hold's own operation, so the client's spend breakdown nets the
    // correction into the same bucket as the run it corrects.
    operation: staged.charge.operation,
    reason: settlementReason(label, hold, credits),
    agentId: staged.charge.agentId ?? null,
    jobId: staged.charge.jobId ?? null,
    phase: "settlement",
    settlesEntryId: staged.charge.id,
    estimateCredits: hold,
    // UNCAPPED, deliberately: the credits taken were clipped, our cost was not,
    // and staff can only see a drifting estimate if the row keeps the real one.
    actualUsd,
    ...(capped ? { settlementCapped: true } : {}),
    ...SETTLEMENT_ACTOR,
    createdAt: now,
  } satisfies CreditLedgerEntry);
  if (capped) {
    console.warn(
      `[credit-settle] capped settlement for charge ${staged.charge.id}: ` +
        `$${actualUsd} would be ${uncappedCredits} credits against a ${hold}-credit estimate; ` +
        `charged ${credits}. The estimate for this product is stale.`,
    );
  }
}

/** Guard shared by both entry points: never treat "cost unknown" as "$0". */
function usableCost(actualUsd: number | null | undefined): actualUsd is number {
  return typeof actualUsd === "number" && Number.isFinite(actualUsd) && actualUsd > 0;
}

/**
 * THE KILL SWITCH, checked at the top of both entry points rather than at the
 * seven call sites that reach them. A settlement is the one irreversible thing
 * this rework does — it writes a ledger row and moves a real balance — so the
 * refusal belongs where the write is, not where the intent is. With the flag
 * off no `"settlement"` row can come into existence, whatever any caller does.
 */
const PLAN_V2_OFF: SettleResult = {
  settled: false,
  detail: "CREDITS_PLAN_V2_ENABLED is off — the estimate is the charge",
};

function outcomeOf(staged: StagedSettlement): SettleResult {
  return {
    settled: true,
    definitive: true,
    estimate: -staged.charge.delta,
    actual: staged.settlement.credits,
    delta: staged.settlement.delta,
    capped: staged.settlement.capped,
    chargeEntryId: staged.charge.id,
  };
}

/**
 * Settle the newest unpaired hold filed under any of `ledgerKeys` against what
 * the run actually cost us.
 *
 * Takes a LIST for the same reason `refundJobCharge` does, and the list should
 * be the same one: the ledger's `jobId` is a pairing key, and a run dispatched
 * by a board task was charged under the TASK id before the job existed. Passing
 * only the job id would leave most real client runs unsettled — silently, since
 * an unsettled hold looks exactly like a run nobody was charged for.
 *
 * `label` is the client-readable subject of the ledger line (an agent name, a
 * tool name). Never throws for a run that simply has nothing to settle; a
 * Firestore failure still throws, and callers treat that as retryable.
 *
 * `settlingJobId` names the run doing the settling, so a task key carrying two
 * live holds hands back the right one — see `CreditLedgerEntry.settlesJobId`.
 * Callers that have a job in hand should always pass it; it defaults to the
 * first key, which is what every caller passes as the job id anyway.
 */
export async function settleJobCharge(
  ledgerKeys: string | readonly (string | null | undefined)[],
  actualUsd: number | null | undefined,
  label: string,
  settlingJobId?: string,
): Promise<SettleResult> {
  if (!isCreditsPlanV2Enabled()) return PLAN_V2_OFF;
  if (!usableCost(actualUsd)) {
    // Invariant 4. The estimate stands, and the reconcile sweep will retry once
    // the cost telemetry arrives (or never, which is the correct outcome for a
    // product that reports none).
    return { settled: false, detail: "no usable cost telemetry — estimate stands" };
  }
  const keys = (typeof ledgerKeys === "string" ? [ledgerKeys] : ledgerKeys).filter(
    (k): k is string => typeof k === "string" && k.length > 0,
  );
  if (keys.length === 0) return { settled: false, detail: "no ledger keys" };

  // The first key IS the job id at every call site (the webhook, the sweep, the
  // engine reconcile all pass `[job.id, task?.id]`), so this default is the
  // caller's own intent rather than a guess.
  const settlingJob = settlingJobId ?? keys[0];

  return db().runTransaction(async (tx) => {
    const now = Date.now();
    let lastSkip = "no unpaired hold to settle";
    let definitive = false;
    for (const key of new Set(keys)) {
      const snap = await tx.get(ledgerCol().where("jobId", "==", key).limit(LEDGER_GROUP_LIMIT));
      const entries = snap.docs.map((d) => ({ ...(d.data() as CreditLedgerEntry), id: d.id }));
      const read = await readSettleableCharge(tx, entries, actualUsd, now, settlingJob);
      if ("skip" in read) {
        lastSkip = read.skip;
        // A definitive verdict under ANY key settles the question for the whole
        // call: "already refunded" does not become "still open" because a
        // second key has nothing filed under it.
        definitive = definitive || read.definitive;
        continue;
      }
      stageSettlementWrites(tx, read.staged, label, actualUsd, now);
      return outcomeOf(read.staged);
    }
    return { settled: false, detail: lastSkip, definitive };
  });
}

/**
 * Settle ONE known charge row by its own ledger id.
 *
 * The in-request path (`client-model-charge.ts`) uses this rather than the
 * key-based lookup above, because most of its charges carry no `jobId` at all —
 * a copilot turn or a Task Map refresh finishes inside one request and has
 * nothing durable to pair on. `chargeClientCredits` hands back the entry id it
 * wrote, which is a stronger key than any lookup: it names the exact hold this
 * call took, so two concurrent presses by the same client cannot settle each
 * other's.
 */
export async function settleChargeEntry(
  chargeEntryId: string,
  actualUsd: number | null | undefined,
  label: string,
): Promise<SettleResult> {
  if (!isCreditsPlanV2Enabled()) return PLAN_V2_OFF;
  if (!usableCost(actualUsd)) {
    return { settled: false, detail: "no usable cost telemetry — estimate stands" };
  }
  return db().runTransaction(async (tx) => {
    const now = Date.now();
    const chargeSnap = await tx.get(ledgerCol().doc(chargeEntryId));
    if (!chargeSnap.exists) return { settled: false, detail: "charge row not found" };
    const charge = { ...(chargeSnap.data() as CreditLedgerEntry), id: chargeSnap.id };

    // THE SIBLINGS, NOT JUST THE CHARGE. Handing `[charge]` alone to the pairing
    // made the count guard blind: an inline "produced nothing" refund writes an
    // auto-id ledger doc, which no deterministic lookup can find, and a
    // one-element list has nothing to count it against. So a run that was
    // refunded inline and then settled would have paid the client twice.
    //
    // Two ways the refund becomes visible, and both are used:
    //   - a charge with a `jobId` re-reads its whole pairing group, exactly as
    //     `settleJobCharge` does, so the count guard works identically;
    //   - a charge WITHOUT one (a copilot turn, a Task Map refresh — most of
    //     this path) relies on `refund_<chargeEntryId>`, which
    //     `refundClientModelCall` now writes whenever it was given the charge id.
    // `readSettleableCharge` checks that doc inside this transaction either way,
    // so the second is a real guard and not a hope.
    const siblings = charge.jobId
      ? (
          await tx.get(ledgerCol().where("jobId", "==", charge.jobId).limit(LEDGER_GROUP_LIMIT))
        ).docs.map((d) => ({
          ...(d.data() as CreditLedgerEntry),
          id: d.id,
        }))
      : [charge];

    const read = await readSettleableCharge(tx, siblings, actualUsd, now, charge.settlesJobId);
    if ("skip" in read) return { settled: false, detail: read.skip, definitive: read.definitive };
    // The pairing picks the newest settleable charge in the group, which for a
    // jobId group need not be the one asked for. Settle the one that was asked
    // for, or nothing: this entry point exists precisely because the caller
    // knows which hold is theirs.
    if (read.staged.charge.id !== chargeEntryId) {
      return { settled: false, detail: "a newer hold under the same key is unsettled" };
    }
    stageSettlementWrites(tx, read.staged, label, actualUsd, now);
    return outcomeOf(read.staged);
  });
}

/* ─────────────────────── the unsettled-hold sweep ───────────────── */

/**
 * How long after a run finishes an unsettled hold is considered LOST rather
 * than in flight. The webhook settles inline, so anything still holding an
 * estimate this long after delivery lost its settlement to a crash between the
 * single-use claim and the write.
 */
export const UNSETTLED_AFTER_MS = 15 * 60 * 1000;

/**
 * How many `review` jobs one sweep may READ before filtering.
 *
 * The query was unbounded: `where("status","==","review").get()` over a
 * collection that grows with every delivered run and never shrinks, on a cron
 * tick, to find at most 25 candidates. The 25 was an in-memory slice and bought
 * nothing at the database.
 */
const SWEEP_SCAN_LIMIT = 500;

/**
 * Terminal, delivered jobs carrying a reported cost whose hold may still be
 * unsettled — the retry path for a settlement lost after the webhook's
 * single-use claim (webhook redelivery cannot retry it, because a redelivery
 * short-circuits at "Already processed").
 *
 * `review` only — the delivered outcome. `failed`/`cancelled` refunded, and a
 * charge is either refunded or settled, never both; `held` may still resume and
 * must settle against its full cost when it does.
 *
 * ── WHY THE FILTERING IS IN MEMORY, AND WHAT THAT COSTS ──────────────────────
 * The natural query is `status == "review"` AND `holdSettledAt == null`, ordered
 * oldest-first. Neither half is available for free:
 *
 *   - `holdSettledAt == null` matches only fields explicitly set to null, never
 *     ABSENT ones, so it would exclude every job written before this field
 *     existed — i.e. all of them — and quietly return nothing;
 *   - `orderBy("updatedAt")` alongside an equality filter needs a COMPOSITE
 *     INDEX (`jobs: status ASC, updatedAt ASC`). This repo has no
 *     `firestore.indexes.json` and a documented convention of sorting in memory
 *     to avoid them; a cron whose query throws FAILED_PRECONDITION until
 *     somebody clicks a link in an error message is a silent outage.
 *
 * So: one equality filter, a hard `limit`, and the rest in memory. THE RESIDUAL,
 * stated rather than buried — an unordered `limit` returns the first N by
 * document id, which is stable but not chronological, so with more than
 * `SWEEP_SCAN_LIMIT` un-swept `review` jobs at once a stranded hold outside that
 * window is not reached. The `holdSettledAt` bookmark is what keeps the real
 * population far below the cap in steady state: every candidate the sweep
 * DECIDES leaves the set permanently. If the cap is ever genuinely hit, the fix
 * is the composite index named above, not a bigger number.
 */
export async function listUnsettledHolds(settleBefore: number, limit = 25) {
  const snap = await db()
    .collection("jobs")
    .where("status", "==", "review")
    .limit(SWEEP_SCAN_LIMIT)
    .get();
  return (
    snap.docs
      .map((d) => ({ ...(d.data() as import("@/lib/types").Job), id: d.id }))
      .filter((j) => typeof j.external?.totalCostUsd === "number")
      // A job whose hold the sweep has DECIDED leaves the candidate set for
      // good — see markHoldSwept for what counts as decided. Without it the
      // list was every delivered job the product has ever produced, and the
      // genuinely stranded hold at the back was never reached.
      .filter((j) => j.holdSettledAt == null)
      // OLDEST FIRST, for the same reason: the stranded hold is by definition
      // the one that has been waiting longest, and it must be at the front of
      // the queue rather than behind everything that has completed since.
      .sort((a, b) => (a.updatedAt ?? 0) - (b.updatedAt ?? 0))
      .filter((j) => (j.updatedAt ?? j.createdAt ?? 0) < settleBefore)
      .slice(0, limit)
  );
}

/**
 * Record that this job's hold has been DECIDED, so the sweep stops considering
 * it.
 *
 * ONLY ON A DEFINITIVE OUTCOME — settled, already settled, refunded, or exempt
 * by operation. NOT on "no unpaired hold found", which is the whole point:
 * that answer is also what a lookup under the wrong pairing key returns, and
 * writing the bookmark on it would disqualify a genuinely stranded hold
 * permanently, on the one sweep that exists to rescue it. An earlier version
 * marked unconditionally and did exactly that to every task-dispatched run.
 *
 * The cost of the narrower rule is that a job that really was never charged
 * (staff-fired, or `billClientCredits: false`) is re-examined on every tick. It
 * is one ledger read per tick per such job, it is bounded by the same
 * `SWEEP_SCAN_LIMIT`, and it is the safe direction to be wrong in.
 *
 * A HINT, NOT THE GUARANTEE. Idempotency is still `settle_<chargeEntryId>` in
 * the ledger; this marker only bounds the work. A job that loses the marker
 * write is re-swept and correctly declined.
 */
export async function markHoldSwept(jobId: string): Promise<void> {
  try {
    await db().collection("jobs").doc(jobId).set({ holdSettledAt: Date.now() }, { merge: true });
  } catch (e) {
    console.error(`[credit-settle] could not mark job ${jobId} swept:`, e);
  }
}
