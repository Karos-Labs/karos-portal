/**
 * Pure charge/refund pairing logic for the credit reconciler — no Firestore,
 * no server-only imports, so vitest can cover it (same split as
 * lab-outputs-shared.ts). The transactional sweep lives in credit-reconcile.ts.
 */

import type { CreditLedgerEntry } from "@/lib/types";

/** Deterministic ledger doc id pairing a refund to exactly one charge entry. */
export function refundEntryIdFor(chargeEntryId: string): string {
  return `refund_${chargeEntryId}`;
}

/**
 * The charge entry a stuck run's refund should pair with, given every ledger
 * entry for one jobId: the NEWEST charge with no paired refund. The running
 * attempt is always the last thing that charged this jobId (claims block
 * concurrent attempts), so newest-unpaired is exact for the stuck-release
 * path. Two guards:
 *   - pairing by deterministic id (`refund_<chargeEntryId>`);
 *   - a count guard — never more refunds than charges for a jobId — which
 *     also keeps refunds written under random ids (e.g. a future inline
 *     refund path) from being refunded a second time here.
 *
 * A SETTLED CHARGE IS NOT REFUNDABLE EITHER (credits rework, 2026-09). This is
 * the second half of "a charge is either refunded or settled, never both", and
 * it has to live here rather than only in `credit-settle.ts`, because the two
 * orders are both reachable: a delivered run settles to its real cost, and a
 * late failure sweep then arrives at the same charge. Refunding it would hand
 * the client back an estimate they were never finally charged, on top of the
 * settlement that already corrected it.
 */
export function newestUnrefundedCharge(entries: CreditLedgerEntry[]): CreditLedgerEntry | null {
  const charges = entries.filter((e) => e.kind === "charge" && -e.delta > 0);
  const refunds = entries.filter((e) => e.kind === "refund");
  if (refunds.length >= charges.length) return null; // every charge already handed back
  const refundedIds = new Set(refunds.map((e) => e.id.replace(/^refund_/, "")));
  const settledIds = new Set(
    entries
      .filter((e) => e.kind === "settlement")
      .map((e) => e.settlesEntryId ?? e.id.replace(/^settle_/, "")),
  );
  return (
    charges
      .filter((c) => !refundedIds.has(c.id) && !settledIds.has(c.id))
      .sort((a, b) => b.createdAt - a.createdAt)[0] ?? null
  );
}

/** Deterministic ledger doc id pairing a settlement to exactly one charge entry. */
export function settlementEntryIdFor(chargeEntryId: string): string {
  return `settle_${chargeEntryId}`;
}

/**
 * The charge a completed run's settlement should pair with (credits rework,
 * 2026-09): the newest charge that has been NEITHER refunded NOR already
 * settled.
 *
 * ── A CHARGE IS EITHER REFUNDED OR SETTLED, NEVER BOTH ───────────────────────
 * This is the hardest invariant in two-phase charging, and it is the reason
 * this is a separate function rather than a flag on the one above. A failed run
 * refunds its whole hold; if a late settlement then also fired against the same
 * charge, a client would be credited the refund AND the settlement difference
 * for a run that produced nothing. It is enforced twice, in two places, on
 * purpose:
 *
 *   - here, by excluding any charge with a paired refund — deterministic
 *     (`refund_<id>`) or, via the count guard, written under a random id by one
 *     of the ~15 inline "produced nothing" refund sites, which have no
 *     idempotency key at all;
 *   - and in `credit-settle.ts`, by a `tx.get` on the refund doc INSIDE the
 *     settling transaction, so a refund racing a settlement cannot be missed by
 *     a read taken before it landed.
 *
 * ALREADY-SETTLED CHARGES are excluded the same way, by their own deterministic
 * id — which is what makes the reconcile sweep safe to run forever. Note the
 * settlement rows are `kind: "settlement"`, so they do not enter the refund
 * count guard above and a settled run stays refundable-in-principle right up
 * until this function refuses it; the exclusion is by pairing, not by counting.
 */
/**
 * The pairing state of one ledger group, computed once so the two questions
 * asked of it cannot answer differently.
 *
 * `unpaired` is newest-first — charges that have neither a refund nor a
 * settlement against them. `charges` is every charge in the group, which is
 * what tells "nothing was ever charged under this key" (a lookup under the
 * wrong key) apart from "everything charged here is already resolved" (a
 * verdict). The sweep's bookmark turns on exactly that distinction.
 */
export function chargePairingState(entries: CreditLedgerEntry[]): {
  charges: CreditLedgerEntry[];
  unpaired: CreditLedgerEntry[];
} {
  const charges = entries.filter((e) => e.kind === "charge" && -e.delta > 0);
  const refunds = entries.filter((e) => e.kind === "refund");
  const settlements = entries.filter((e) => e.kind === "settlement");
  const refundedIds = new Set(refunds.map((e) => e.id.replace(/^refund_/, "")));
  const settledIds = new Set(
    settlements.map((e) => e.settlesEntryId ?? e.id.replace(/^settle_/, "")),
  );
  // The same count guard the refund side uses, for the same reason: an inline
  // refund writes an auto-id doc, so "how many charges are still outstanding"
  // is the only thing that can see it. Exhausted ⇒ nothing is unpaired.
  const outstanding = charges.length - refunds.length;
  const unpaired =
    outstanding <= 0
      ? []
      : charges
          .filter((c) => !refundedIds.has(c.id) && !settledIds.has(c.id))
          .sort((a, b) => b.createdAt - a.createdAt);
  return { charges, unpaired };
}

export function newestSettleableCharge(
  entries: CreditLedgerEntry[],
  opts?: {
    /**
     * The `jobs` doc id of the run that is settling. When given, a hold STAMPED
     * with a different run's id is never returned — see
     * `CreditLedgerEntry.settlesJobId`. Omit only where the caller genuinely
     * does not know which run it is settling.
     */
    settlingJobId?: string;
  },
): CreditLedgerEntry | null {
  const { unpaired } = chargePairingState(entries);
  if (unpaired.length === 0) return null;

  // ── WHOSE HOLD IS THIS? ─────────────────────────────────────────────────
  // "The newest unpaired charge" identifies a run only while one run per key is
  // in flight. A board task charged under the TASK id and re-run while the
  // first attempt is still going has two live holds under one key, and the
  // first run to deliver would settle the SECOND run's hold against its own
  // cost — charging one run's price to the other, twice over once both land.
  //
  // Three cases, in this order:
  //   1. a hold stamped for exactly this run — the unambiguous answer;
  //   2. no stamped match, so fall back to the newest UNSTAMPED hold. Every row
  //      written before `settlesJobId` existed is unstamped, and so is every
  //      direct-fire charge (already filed under the job id, where the key
  //      itself disambiguates);
  //   3. never a hold stamped for a DIFFERENT run — that one belongs to a
  //      dispatch still in flight, and taking it is the bug above.
  if (opts?.settlingJobId) {
    const mine = unpaired.filter((c) => c.settlesJobId === opts.settlingJobId);
    if (mine.length > 0) return mine[0]!;
    return unpaired.find((c) => c.settlesJobId == null) ?? null;
  }
  return unpaired[0]!;
}
